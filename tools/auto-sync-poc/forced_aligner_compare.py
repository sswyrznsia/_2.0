"""One-song Qwen3 ForcedAligner comparison PoC.

This file is deliberately isolated from the Electron app and the existing
Whisper/BS-RoFormer pipeline.  It reads existing assets and writes comparison
artifacts only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import time
import unicodedata
import wave
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


MODEL_ID = "Qwen/Qwen3-ForcedAligner-0.6B"
MIN_AI_CONFIDENCE = 0.75
MIN_MS_PER_NORMALIZED_CHARACTER = 50
MAX_MS_PER_NORMALIZED_CHARACTER = 1000


@dataclass(frozen=True)
class AlignedItem:
    text: str
    start_time: float
    end_time: float


def split_plain_lyrics(value: str) -> list[str]:
    return [line.strip() for line in value.replace("\r\n", "\n").split("\n") if line.strip()]


def fnv1a64(value: str) -> str:
    result = 0xCBF29CE484222325
    for byte in value.encode("utf-8"):
        result ^= byte
        result = (result * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"{result:016x}"


def mapping_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    return "".join(char for char in normalized if unicodedata.category(char)[0] in {"L", "N"})


def audio_duration_ms(path: Path) -> int:
    with wave.open(str(path), "rb") as audio:
        return round(audio.getnframes() * 1000 / audio.getframerate())


def read_plain_lyrics(app_store: Path, track_id: str) -> tuple[str, dict[str, str]]:
    with app_store.open("r", encoding="utf-8-sig") as handle:
        data = json.load(handle).get("data", {})
    lyrics = data.get("lyrics", {}).get(track_id)
    track = next((item for item in data.get("tracks", []) if item.get("id") == track_id), None)
    if not lyrics or not isinstance(lyrics.get("plainLyrics"), str):
        raise RuntimeError(f"plain lyrics missing for track {track_id}")
    return lyrics["plainLyrics"], {
        "title": (track or {}).get("title", ""),
        "artist": (track or {}).get("artist", ""),
    }


def _item_value(item: Any, key: str) -> Any:
    return item.get(key) if isinstance(item, dict) else getattr(item, key)


def coerce_aligned_items(raw: Any) -> list[AlignedItem]:
    # Qwen returns one list per input when a scalar audio/text pair is supplied.
    if isinstance(raw, list) and len(raw) == 1:
        raw = getattr(raw[0], "items", raw[0])
    if not isinstance(raw, (list, tuple)):
        raise RuntimeError(f"unexpected ForcedAligner output: {type(raw).__name__}")
    return [
        AlignedItem(
            text=str(_item_value(item, "text")),
            start_time=float(_item_value(item, "start_time")),
            end_time=float(_item_value(item, "end_time")),
        )
        for item in raw
    ]


def map_items_to_lines(
    lyrics_lines: list[str], aligned_items: list[AlignedItem], duration_ms: int
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Map Qwen's ordered Japanese tokens back to non-empty source lines.

    Mapping is accepted only when normalized token text exactly reconstructs
    each source line.  A token crossing a source-line boundary invalidates the
    affected line instead of guessing.
    """
    line_keys = [mapping_text(line) for line in lyrics_lines]
    token_keys = [mapping_text(item.text) for item in aligned_items]
    source_stream = "".join(line_keys)
    token_stream = "".join(token_keys)
    exact_stream_match = source_stream == token_stream

    boundaries: list[tuple[int, int]] = []
    cursor = 0
    for key in line_keys:
        boundaries.append((cursor, cursor + len(key)))
        cursor += len(key)

    token_spans: list[tuple[int, int, AlignedItem]] = []
    cursor = 0
    for key, item in zip(token_keys, aligned_items):
        if not key:
            continue
        token_spans.append((cursor, cursor + len(key), item))
        cursor += len(key)

    output: list[dict[str, Any]] = []
    previous_start = -1
    previous_end = -1
    for line_index, (line, key, boundary) in enumerate(zip(lyrics_lines, line_keys, boundaries)):
        start_char, end_char = boundary
        included = [item for begin, end, item in token_spans if begin >= start_char and end <= end_char]
        crosses_boundary = any(
            (begin < start_char < end) or (begin < end_char < end)
            for begin, end, _item in token_spans
        )
        reconstructed = "".join(mapping_text(item.text) for item in included)
        reasons: list[str] = []
        if not exact_stream_match:
            reasons.append("full-text-token-mismatch")
        if not key or reconstructed != key or crosses_boundary or not included:
            reasons.append("line-token-mismatch")

        start_ms = round(included[0].start_time * 1000) if included else None
        end_ms = round(included[-1].end_time * 1000) if included else None
        if start_ms is None or end_ms is None or not (0 <= start_ms < end_ms <= duration_ms):
            reasons.append("invalid-time-range")
        else:
            line_duration_ms = end_ms - start_ms
            minimum_duration_ms = len(key) * MIN_MS_PER_NORMALIZED_CHARACTER
            maximum_duration_ms = len(key) * MAX_MS_PER_NORMALIZED_CHARACTER
            if line_duration_ms < minimum_duration_ms:
                reasons.append("implausibly-short-line-duration")
            if line_duration_ms > maximum_duration_ms:
                reasons.append("implausibly-long-line-duration")
            if start_ms <= previous_start or end_ms <= previous_end:
                reasons.append("non-monotonic-time")

        valid = not reasons
        if valid:
            previous_start, previous_end = start_ms, end_ms
        expected_count = len(key)
        actual_count = len(reconstructed)
        quality = min(expected_count, actual_count) / max(expected_count, actual_count, 1)
        output.append(
            {
                "lineIndex": line_index,
                "text": line,
                "textHash": fnv1a64(line.strip()),
                "startTimeMs": start_ms,
                "endTimeMs": end_ms,
                "confidence": round(quality, 4) if valid else 0.0,
                "confidenceSource": "structural-token-coverage-not-model-probability",
                "quality": {
                    "normalizedCharacterCoverage": round(quality, 4),
                    "alignedItemCount": len(included),
                    "exactTextReconstruction": reconstructed == key,
                },
                "valid": valid,
                "invalidReasons": sorted(set(reasons)),
            }
        )

    collision_details = repeated_line_collisions(output)
    collided = {index for collision in collision_details for index in collision["lineIndexes"]}
    for line in output:
        if line["lineIndex"] in collided:
            line["valid"] = False
            line["confidence"] = 0.0
            line["invalidReasons"] = sorted(set(line["invalidReasons"] + ["repeated-line-collision"]))

    diagnostics = {
        "sourceNormalizedCharacters": len(source_stream),
        "alignedNormalizedCharacters": len(token_stream),
        "exactFullTextReconstruction": exact_stream_match,
        "durationPlausibilityRule": {
            "minimumMsPerNormalizedCharacter": MIN_MS_PER_NORMALIZED_CHARACTER,
            "maximumMsPerNormalizedCharacter": MAX_MS_PER_NORMALIZED_CHARACTER,
            "note": "Conservative structural guardrail, not human-ground-truth accuracy.",
        },
        "repeatedLineCollisions": collision_details,
    }
    return output, diagnostics


def repeated_line_collisions(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for line in lines:
        key = mapping_text(line["text"])
        if key:
            groups[key].append(line)
    collisions: list[dict[str, Any]] = []
    for repeated in groups.values():
        if len(repeated) < 2:
            continue
        for left, right in zip(repeated, repeated[1:]):
            left_start, left_end = left.get("startTimeMs"), left.get("endTimeMs")
            right_start = right.get("startTimeMs")
            if (
                left_start is None
                or left_end is None
                or right_start is None
                or right_start <= left_start
                or right_start < left_end
            ):
                collisions.append(
                    {
                        "text": left["text"],
                        "lineIndexes": [left["lineIndex"], right["lineIndex"]],
                        "spansMs": [
                            [left_start, left_end],
                            [right_start, right.get("endTimeMs")],
                        ],
                    }
                )
    return collisions


def count_reverse_order(
    lines: Iterable[dict[str, Any]], time_key: str, *, include_equal: bool = False
) -> int:
    prior = -1
    reversals = 0
    for line in lines:
        value = line.get(time_key)
        if not isinstance(value, (int, float)) or not math.isfinite(value):
            continue
        if value < prior or (include_equal and value == prior):
            reversals += 1
        prior = value
    return reversals


def make_timeline(track_id: str, lyrics: str, model: str, lines: list[dict[str, Any]]) -> dict[str, Any]:
    plain_lines = split_plain_lyrics(lyrics)
    valid_lines = [line for line in lines if line["valid"]]
    return {
        "trackId": track_id,
        "source": "ai",
        "lines": [
            {
                "lineIndex": line["lineIndex"],
                "textHash": line["textHash"],
                "audioTimeMs": line["startTimeMs"],
                # This is structural validity, not a probability emitted by Qwen.
                "confidence": line["confidence"],
            }
            for line in valid_lines
        ],
        "lineCount": len(plain_lines),
        "lyricsTextHash": fnv1a64("\n".join(plain_lines)),
        "model": model,
        "createdAt": round(time.time() * 1000),
    }


def validate_compatible_timeline(timeline: dict[str, Any], lyrics: str) -> dict[str, Any]:
    """Mirror the app's GeneratedLyricsTimeline invariants without writing app data."""
    source_lines = split_plain_lyrics(lyrics)
    errors: list[str] = []
    if timeline.get("lineCount") != len(source_lines):
        errors.append("line-count-mismatch")
    if timeline.get("lyricsTextHash") != fnv1a64("\n".join(source_lines)):
        errors.append("lyrics-text-hash-mismatch")
    previous_index = -1
    previous_time = -1
    for line in timeline.get("lines", []):
        index = line.get("lineIndex")
        timestamp = line.get("audioTimeMs")
        confidence = line.get("confidence")
        if not isinstance(index, int) or index <= previous_index or index >= len(source_lines):
            errors.append("invalid-line-index-order")
            break
        if not isinstance(timestamp, (int, float)) or not math.isfinite(timestamp) or timestamp <= previous_time:
            errors.append("invalid-time-order")
            break
        if line.get("textHash") != fnv1a64(source_lines[index].strip()):
            errors.append("line-text-hash-mismatch")
            break
        if timeline.get("source") == "ai" and (
            not isinstance(confidence, (int, float))
            or not math.isfinite(confidence)
            or confidence < MIN_AI_CONFIDENCE
            or confidence > 1
        ):
            errors.append("invalid-ai-confidence")
            break
        previous_index, previous_time = index, timestamp
    return {"valid": not errors, "errors": sorted(set(errors))}


def repeated_start_collisions(
    lyrics_lines: list[str], timed_lines: Iterable[dict[str, Any]], time_key: str
) -> list[dict[str, Any]]:
    by_index = {line.get("lineIndex"): line for line in timed_lines}
    groups: dict[str, list[int]] = defaultdict(list)
    for index, text in enumerate(lyrics_lines):
        groups[mapping_text(text)].append(index)
    collisions: list[dict[str, Any]] = []
    for indexes in groups.values():
        timed = [by_index[index] for index in indexes if index in by_index]
        for left, right in zip(timed, timed[1:]):
            left_time = left.get(time_key)
            right_time = right.get(time_key)
            if isinstance(left_time, (int, float)) and isinstance(right_time, (int, float)) and right_time <= left_time:
                collisions.append(
                    {
                        "text": lyrics_lines[left["lineIndex"]],
                        "lineIndexes": [left["lineIndex"], right["lineIndex"]],
                        "startTimesMs": [left_time, right_time],
                    }
                )
    return collisions


def summarize_whisper(
    cached: dict[str, Any], duration_ms: int, lyrics: str
) -> dict[str, Any]:
    lyrics_lines = split_plain_lyrics(lyrics)
    anchors = cached.get("anchors", [])
    valid = [
        anchor
        for anchor in anchors
        if isinstance(anchor.get("audioTimeMs"), (int, float))
        and 0 <= anchor["audioTimeMs"] <= duration_ms
        and anchor.get("confidence", 0) >= MIN_AI_CONFIDENCE
    ]
    metrics = cached.get("metrics", {})
    collisions = repeated_start_collisions(lyrics_lines, valid, "audioTimeMs")
    derived_timeline = {
        "trackId": cached.get("trackId", ""),
        "source": "ai",
        "lines": [
            {
                "lineIndex": anchor["lineIndex"],
                "textHash": fnv1a64(lyrics_lines[anchor["lineIndex"]]),
                "audioTimeMs": anchor["audioTimeMs"],
                "confidence": anchor["confidence"],
            }
            for anchor in valid
            if isinstance(anchor.get("lineIndex"), int)
            and 0 <= anchor["lineIndex"] < len(lyrics_lines)
        ],
        "lineCount": len(lyrics_lines),
        "lyricsTextHash": fnv1a64("\n".join(lyrics_lines)),
        "model": cached.get("model", {}).get("whisper", "large-v3"),
        "createdAt": 0,
    }
    timeline_validation = validate_compatible_timeline(derived_timeline, lyrics)
    timeline_validation["basis"] = "read-only conversion of cached anchors; not saved to app data"
    return {
        "model": cached.get("model", {}).get("whisper", "large-v3"),
        "matchedLines": cached.get("matchedLines", len(anchors)),
        "validTimestampLines": len(valid),
        "totalLines": cached.get("totalLines"),
        "coveragePercent": round(100 * len(valid) / max(cached.get("totalLines", 0), 1), 3),
        "invalidOrMissingLines": max(cached.get("totalLines", 0) - len(valid), 0),
        "reverseOrderCount": count_reverse_order(valid, "audioTimeMs"),
        "nonIncreasingOrderCount": count_reverse_order(valid, "audioTimeMs", include_equal=True),
        "repeatedLineCollisionCount": len(collisions),
        "repeatedLineCollisions": collisions,
        "generatedLyricsTimelineValidation": timeline_validation,
        "processingSeconds": metrics.get("totalSeconds"),
        "processingBreakdownSeconds": {
            "vocalSeparation": metrics.get("vocalSeparationSeconds"),
            "whisper": metrics.get("whisperSeconds"),
            "matching": metrics.get("matchingSeconds"),
        },
        "gpuMemoryMiB": metrics.get("gpuMemory"),
        "source": "existing-cached-result-no-rerun",
    }


def run_aligner(vocals: Path, lyrics: str, model_ref: str) -> tuple[list[AlignedItem], dict[str, Any]]:
    try:
        import torch
        from qwen_asr import Qwen3ForcedAligner
        from auto_sync_poc import GpuMonitor
    except ImportError as error:
        raise RuntimeError("qwen-asr is not installed in the isolated ForcedAligner environment") from error

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required for this comparison run")
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    torch_baseline = torch.cuda.memory_allocated()
    gpu_monitor = GpuMonitor()
    gpu_monitor.start()
    try:
        gpu_monitor.set_phase("modelLoad")
        load_started = time.perf_counter()
        model = Qwen3ForcedAligner.from_pretrained(
            model_ref, dtype=torch.bfloat16, device_map="cuda:0"
        )
        load_seconds = time.perf_counter() - load_started
        after_load = torch.cuda.memory_allocated()
        load_peak = torch.cuda.max_memory_allocated()
        torch.cuda.reset_peak_memory_stats()
        gpu_monitor.set_phase("alignment")
        inference_started = time.perf_counter()
        raw = model.align(audio=str(vocals), text=lyrics, language="Japanese")
        torch.cuda.synchronize()
        inference_seconds = time.perf_counter() - inference_started
        inference_peak = torch.cuda.max_memory_allocated()
    finally:
        gpu_memory = gpu_monitor.stop()
    items = coerce_aligned_items(raw)
    gpu_memory["measurement"] = "nvidia-smi total GPU memory, matching the existing Whisper PoC"
    gpu_memory["torchAllocatedMiB"] = {
        "baseline": round(torch_baseline / 1048576),
        "afterModelLoad": round(after_load / 1048576),
        "modelLoadPeak": round(load_peak / 1048576),
        "alignmentPeak": round(inference_peak / 1048576),
    }
    return items, {
        "modelLoadSeconds": round(load_seconds, 3),
        "alignmentSeconds": round(inference_seconds, 3),
        "totalSeconds": round(load_seconds + inference_seconds, 3),
        "gpuMemory": gpu_memory,
    }


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_report(path: Path, forced: dict[str, Any], comparison: dict[str, Any]) -> None:
    qwen = comparison["forcedAligner"]
    whisper = comparison["whisperLargeV3"]
    ground_truth = comparison["groundTruth"]
    conclusion = comparison["conclusion"]
    report = f"""# Qwen3 ForcedAligner one-song comparison

- Track: {comparison['track']['title']} — {comparison['track']['artist']}
- Input: cached separated vocals + current plain lyrics; existing Whisper result was not rerun.
- Human ground truth: {ground_truth['status']}. Accuracy/MAE improvement is therefore not claimed.
- Whisper large-v3: {whisper['validTimestampLines']}/{whisper['totalLines']} valid lines ({whisper['coveragePercent']}%), original full pipeline {whisper['processingSeconds']} s; from cached vocals {whisper['comparableFromCachedVocalsSeconds']} s; peak {whisper['gpuMemoryMiB'].get('peakMiB')} MiB.
- Qwen3 ForcedAligner: {qwen['validTimestampLines']}/{qwen['totalLines']} valid lines ({qwen['coveragePercent']}%), cached-model load + alignment {qwen['processingSeconds']} s; estimated full pipeline with the same separation cost {qwen['estimatedPipelineWithSeparationSeconds']} s; peak {qwen['gpuMemoryMiB'].get('peakMiB')} MiB.
- Reverse-order timestamps: Whisper {whisper['reverseOrderCount']}, Qwen {qwen['reverseOrderCount']}.
- Non-increasing (equal-or-earlier) line starts: Whisper {whisper['nonIncreasingOrderCount']}, Qwen {qwen['nonIncreasingOrderCount']}.
- Invalid or missing lines: Whisper {whisper['invalidOrMissingLines']}, Qwen {qwen['invalidOrMissingLines']}.
- Repeated-line collisions: Whisper {whisper['repeatedLineCollisionCount']}, Qwen {qwen['repeatedLineCollisionCount']}; ambiguous collisions are excluded from generated timelines.
- Conclusion: **{conclusion['decision']}** — {conclusion['reason']}

The `confidence` stored in the compatibility timeline is a structural token-coverage score, not a probability emitted by Qwen. Human listening validation is still required before production adoption.
"""
    path.write_text(report, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vocals", type=Path, required=True)
    parser.add_argument("--whisper-result", type=Path, required=True)
    parser.add_argument("--app-store", type=Path, required=True)
    parser.add_argument("--track-id", required=True)
    parser.add_argument("--model", default=MODEL_ID)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    lyrics, track = read_plain_lyrics(args.app_store, args.track_id)
    lines = split_plain_lyrics(lyrics)
    duration = audio_duration_ms(args.vocals)
    with args.whisper_result.open("r", encoding="utf-8") as handle:
        cached_whisper = json.load(handle)

    aligned_items, performance = run_aligner(args.vocals, lyrics, args.model)
    aligned_lines, diagnostics = map_items_to_lines(lines, aligned_items, duration)
    timeline = make_timeline(args.track_id, lyrics, MODEL_ID, aligned_lines)
    timeline_validation = validate_compatible_timeline(timeline, lyrics)
    valid = [line for line in aligned_lines if line["valid"]]
    forced = {
        "schemaVersion": 1,
        "track": {"trackId": args.track_id, **track, "durationMs": duration},
        "input": {
            "vocalsSha256": hashlib.sha256(args.vocals.read_bytes()).hexdigest(),
            "plainLyricsSha256": hashlib.sha256(lyrics.encode("utf-8")).hexdigest(),
            "lineCount": len(lines),
            "usedCachedSeparatedVocals": True,
        },
        "model": MODEL_ID,
        "language": "Japanese",
        "lines": aligned_lines,
        "generatedLyricsTimeline": timeline,
        "generatedLyricsTimelineValidation": timeline_validation,
        "diagnostics": diagnostics,
        "performance": performance,
    }
    whisper = summarize_whisper(cached_whisper, duration, lyrics)
    whisper["comparableFromCachedVocalsSeconds"] = round(
        sum(
            value or 0
            for value in (
                whisper["processingBreakdownSeconds"]["whisper"],
                whisper["processingBreakdownSeconds"]["matching"],
            )
        ),
        3,
    )
    separation_seconds = whisper["processingBreakdownSeconds"]["vocalSeparation"] or 0
    qwen_summary = {
        "model": MODEL_ID,
        "validTimestampLines": len(valid),
        "totalLines": len(lines),
        "coveragePercent": round(100 * len(valid) / max(len(lines), 1), 3),
        "invalidOrMissingLines": len(lines) - len(valid),
        "reverseOrderCount": count_reverse_order(aligned_lines, "startTimeMs"),
        "nonIncreasingOrderCount": count_reverse_order(
            aligned_lines, "startTimeMs", include_equal=True
        ),
        "repeatedLineCollisionCount": len(diagnostics["repeatedLineCollisions"]),
        "repeatedLineCollisions": diagnostics["repeatedLineCollisions"],
        "generatedLyricsTimelineValidation": timeline_validation,
        "processingSeconds": performance["totalSeconds"],
        "comparableFromCachedVocalsSeconds": performance["totalSeconds"],
        "estimatedPipelineWithSeparationSeconds": round(
            separation_seconds + performance["totalSeconds"], 3
        ),
        "processingBreakdownSeconds": {
            "modelLoad": performance["modelLoadSeconds"],
            "alignment": performance["alignmentSeconds"],
        },
        "gpuMemoryMiB": performance["gpuMemory"],
    }
    coverage_gain = qwen_summary["coveragePercent"] - whisper["coveragePercent"]
    if (
        coverage_gain >= 10
        and qwen_summary["nonIncreasingOrderCount"] == 0
        and not diagnostics["repeatedLineCollisions"]
    ):
        decision = "promising-for-further-validation"
        reason = "structural coverage improved without repeated-line collisions, but no human ground truth exists"
    else:
        decision = "not-recommended-from-this-run"
        reason = "the selected singing sample produced collapsed or implausibly stretched line spans, so safe coverage did not improve enough"
    comparison = {
        "schemaVersion": 1,
        "track": forced["track"],
        "comparisonBasis": "same cached vocals and plain lyrics; Whisper metrics reused from its cached run",
        "groundTruth": {
            "status": "unavailable",
            "accuracyMetrics": None,
            "note": "No human-corrected timeline exists; no accuracy improvement is claimed.",
        },
        "whisperLargeV3": whisper,
        "forcedAligner": qwen_summary,
        "delta": {
            "validTimestampLines": len(valid) - whisper["validTimestampLines"],
            "coveragePercentagePoints": round(qwen_summary["coveragePercent"] - whisper["coveragePercent"], 3),
            "fromCachedVocalsSeconds": round(
                qwen_summary["comparableFromCachedVocalsSeconds"]
                - whisper["comparableFromCachedVocalsSeconds"],
                3,
            ),
            "estimatedFullPipelineSeconds": round(
                qwen_summary["estimatedPipelineWithSeparationSeconds"]
                - whisper["processingSeconds"],
                3,
            ),
        },
        "conclusion": {"decision": decision, "reason": reason},
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }

    forced_path = args.output_dir / "forced-aligner-result.json"
    comparison_path = args.output_dir / "forced-aligner-comparison.json"
    report_path = args.output_dir / "forced-aligner-report.md"
    write_json(forced_path, forced)
    write_json(comparison_path, comparison)
    write_report(report_path, forced, comparison)
    print(json.dumps({"forced": str(forced_path), "comparison": str(comparison_path), "report": str(report_path)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
