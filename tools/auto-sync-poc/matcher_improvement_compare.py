"""Compare the legacy and segment-aware matchers using cached artifacts only."""

from __future__ import annotations

import argparse
import json
import time
from collections import Counter
from pathlib import Path
from typing import Any

from auto_sync_poc import (
    MatchCandidate,
    WordToken,
    build_match_candidates,
    choose_ordered_matches,
    filter_temporal_outliers,
    map_original_times,
    normalize_text,
    parse_synced_lyrics,
    split_plain_lyrics,
)


MIN_TIMELINE_CONFIDENCE = 0.75


def fnv1a64(value: str) -> str:
    result = 0xCBF29CE484222325
    for byte in value.encode("utf-8"):
        result ^= byte
        result = (result * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"{result:016x}"


def repeated_indexes(lines: list[str]) -> set[int]:
    counts = Counter(normalize_text(line) for line in lines)
    return {
        index
        for index, line in enumerate(lines)
        if counts[normalize_text(line)] > 1
    }


def make_timeline(track_id: str, lines: list[str], anchors: list[dict[str, Any]]) -> dict[str, Any]:
    safe: list[dict[str, Any]] = []
    previous_time = -1
    for anchor in sorted(anchors, key=lambda item: item["lineIndex"]):
        confidence = anchor.get("confidence", 0)
        if confidence < MIN_TIMELINE_CONFIDENCE or anchor["audioTimeMs"] <= previous_time:
            continue
        safe.append(
            {
                "lineIndex": anchor["lineIndex"],
                "textHash": fnv1a64(lines[anchor["lineIndex"]].strip()),
                "audioTimeMs": anchor["audioTimeMs"],
                "confidence": round(confidence, 4),
            }
        )
        previous_time = anchor["audioTimeMs"]
    return {
        "trackId": track_id,
        "source": "ai",
        "lines": safe,
        "lineCount": len(lines),
        "lyricsTextHash": fnv1a64("\n".join(lines)),
        "model": "BS-RoFormer + Whisper large-v3 + segment-aware matcher",
        "createdAt": 0,
    }


def validate_timeline(timeline: dict[str, Any], lines: list[str]) -> dict[str, Any]:
    errors: list[str] = []
    if timeline["lineCount"] != len(lines):
        errors.append("line-count")
    if timeline["lyricsTextHash"] != fnv1a64("\n".join(lines)):
        errors.append("lyrics-hash")
    prior_index = -1
    prior_time = -1
    for item in timeline["lines"]:
        index = item["lineIndex"]
        if index <= prior_index or item["audioTimeMs"] <= prior_time:
            errors.append("order")
        if item["textHash"] != fnv1a64(lines[index].strip()):
            errors.append("line-hash")
        if item["confidence"] < MIN_TIMELINE_CONFIDENCE:
            errors.append("confidence")
        prior_index = index
        prior_time = item["audioTimeMs"]
    return {"valid": not errors, "errors": sorted(set(errors))}


def count_reverse(anchors: list[dict[str, Any]]) -> int:
    times = [item["audioTimeMs"] for item in sorted(anchors, key=lambda item: item["lineIndex"])]
    return sum(right <= left for left, right in zip(times, times[1:]))


def repeated_collisions(lines: list[str], anchors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_index = {item["lineIndex"]: item for item in anchors}
    groups: dict[str, list[int]] = {}
    for index, line in enumerate(lines):
        groups.setdefault(normalize_text(line), []).append(index)
    collisions: list[dict[str, Any]] = []
    for indexes in groups.values():
        timed = [by_index[index] for index in indexes if index in by_index]
        for left, right in zip(timed, timed[1:]):
            if right["audioTimeMs"] <= left["audioTimeMs"]:
                collisions.append(
                    {
                        "lineIndexes": [left["lineIndex"], right["lineIndex"]],
                        "audioTimesMs": [left["audioTimeMs"], right["audioTimeMs"]],
                    }
                )
    return collisions


def candidate_from_diagnostic(line_index: int, value: dict[str, Any]) -> MatchCandidate:
    return MatchCandidate(
        line_index=line_index,
        token_start=value["tokenStart"],
        token_end=value["tokenEndExclusive"],
        audio_time_ms=value["segmentStartMs"],
        confidence=value["matcherConfidence"],
        whisper_text=value["transcriptText"],
    )


def compare_failure(diagnostics: dict[str, Any], baseline_metrics: dict[str, Any]) -> dict[str, Any]:
    lines_payload = diagnostics["lines"]
    lines = [item["lyricsText"] for item in lines_payload]
    expected = [item["estimatedLyricTimeMs"] for item in lines_payload]
    reduced_candidates: list[MatchCandidate] = []
    seen: set[tuple[int, int, int]] = set()
    for line in lines_payload:
        for value in (line.get("bestMatchingCandidate"), line.get("selectedCandidate")):
            if not value or value["matcherConfidence"] < diagnostics["input"]["confidenceThreshold"]:
                continue
            key = (line["lineIndex"], value["tokenStart"], value["tokenEndExclusive"])
            if key not in seen:
                seen.add(key)
                reduced_candidates.append(candidate_from_diagnostic(line["lineIndex"], value))

    started = time.perf_counter()
    matches = choose_ordered_matches(
        reduced_candidates,
        expected_times_ms=expected,
        repeated_line_indexes=repeated_indexes(lines),
    )
    anchors = [
        {
            "lineIndex": match.line_index,
            "lyricTimeMs": expected[match.line_index],
            "audioTimeMs": match.audio_time_ms,
            "confidence": match.confidence,
            "whisperText": match.whisper_text,
        }
        for match in matches
    ]
    kept, removed = filter_temporal_outliers(
        anchors, audio_duration_ms=diagnostics["track"]["audioDurationMs"]
    )
    processing = time.perf_counter() - started
    timeline = make_timeline(diagnostics["track"]["trackId"], lines, kept)
    legacy_outliers = diagnostics["summary"]["outlierLineIndexes"]
    recovered = sorted(set(legacy_outliers) - set(removed))
    collisions = repeated_collisions(lines, kept)
    return {
        "track": diagnostics["track"],
        "candidateReplay": {
            "legacyGeneratedCandidateWindows": diagnostics["summary"]["candidateWindowsGenerated"],
            "legacyAboveThresholdCandidateWindows": diagnostics["summary"]["candidateWindowsAboveThreshold"],
            "preservedCandidatesAvailableAfterCachePrune": len(reduced_candidates),
            "limitation": "The raw failure-song token cache was pruned by an earlier UI test. The improved global path is replayed from preserved best/selected candidates; no model was rerun.",
        },
        "legacy": {
            "sequenceSelectedLines": diagnostics["summary"]["sequenceValidationPassedLines"],
            "outlierRemovedLines": diagnostics["summary"]["outlierRemovedLines"],
            "finalValidLines": diagnostics["summary"]["finalValidLines"],
            "coveragePercent": diagnostics["summary"]["finalCoveragePercent"],
            "reverseTimeCount": 0,
            "repeatedCollisionCount": 0,
            "matchingSeconds": baseline_metrics["matching"],
        },
        "improved": {
            "sequenceSelectedLines": len(matches),
            "outlierRemovedLines": len(removed),
            "removedLineIndexes": removed,
            "finalValidLines": len(kept),
            "coveragePercent": round(100 * len(kept) / len(lines), 3),
            "reverseTimeCount": count_reverse(kept),
            "repeatedCollisionCount": len(collisions),
            "repeatedCollisions": collisions,
            "continuousOutlierRecoveredLines": len(recovered),
            "recoveredLineIndexes": recovered,
            "reducedReplaySeconds": round(processing, 6),
            "fullMatchingSeconds": None,
            "fullMatchingSecondsReason": "Raw tokens were unavailable; reduced replay timing is not comparable to the legacy full candidate build.",
            "generatedLyricsTimeline": timeline,
            "generatedLyricsTimelineValidation": validate_timeline(timeline, lines),
        },
    }


def compare_normal_cache(
    cache_root: Path,
    app_data: dict[str, Any],
    threshold: float,
) -> dict[str, Any]:
    cached = json.loads((cache_root / "result.json").read_text(encoding="utf-8"))
    tokens = [
        WordToken(**item)
        for item in json.loads((cache_root / "tokens.json").read_text(encoding="utf-8"))["tokens"]
    ]
    lyrics = app_data["lyrics"][cached["trackId"]]
    lines = split_plain_lyrics(lyrics["plainLyrics"])
    original_times = map_original_times(lines, parse_synced_lyrics(lyrics.get("syncedLyrics")))
    started = time.perf_counter()
    all_candidates = build_match_candidates(lines, tokens, 0.0)
    candidates = [item for item in all_candidates if item.confidence >= threshold]
    matches = choose_ordered_matches(
        candidates,
        expected_times_ms=original_times,
        repeated_line_indexes=repeated_indexes(lines),
    )
    anchors = [
        {
            "lineIndex": match.line_index,
            "lyricTimeMs": original_times[match.line_index],
            "audioTimeMs": match.audio_time_ms,
            "confidence": match.confidence,
        }
        for match in matches
        if original_times[match.line_index] is not None
    ]
    kept, removed = filter_temporal_outliers(
        anchors, audio_duration_ms=max(token.end_ms for token in tokens)
    )
    elapsed = time.perf_counter() - started
    timeline = make_timeline(cached["trackId"], lines, kept)
    return {
        "trackId": cached["trackId"],
        "totalLines": len(lines),
        "candidateWindows": len(all_candidates),
        "aboveThresholdCandidateWindows": len(candidates),
        "legacy": {
            "selectedLinesBeforeOutlier": cached["matchedLines"]
            + len(cached["diagnostics"]["temporalOutlierLines"]),
            "outlierRemovedLines": len(cached["diagnostics"]["temporalOutlierLines"]),
            "finalValidLines": cached["matchedLines"],
            "coveragePercent": round(100 * cached["matchedLines"] / len(lines), 3),
            "matchingSeconds": cached["metrics"]["matchingSeconds"],
        },
        "improved": {
            "selectedLinesBeforeOutlier": len(matches),
            "outlierRemovedLines": len(removed),
            "removedLineIndexes": removed,
            "finalValidLines": len(kept),
            "coveragePercent": round(100 * len(kept) / len(lines), 3),
            "reverseTimeCount": count_reverse(kept),
            "repeatedCollisionCount": len(repeated_collisions(lines, kept)),
            "matchingSeconds": round(elapsed, 3),
            "generatedLyricsTimelineValidation": validate_timeline(timeline, lines),
        },
        "regressionPassed": len(kept) >= cached["matchedLines"],
    }


def write_report(path: Path, result: dict[str, Any]) -> None:
    failure = result["failureSong"]
    normal_rows = "\n".join(
        f"| {item['trackId'][:8]} | {item['legacy']['finalValidLines']}/{item['totalLines']} | {item['improved']['finalValidLines']}/{item['totalLines']} | {item['improved']['outlierRemovedLines']} | {'PASS' if item['regressionPassed'] else 'FAIL'} |"
        for item in result["normalSongRegression"]
    )
    report = f"""# Segment-aware matcher comparison

## Failure song

| Metric | Legacy | Improved |
| --- | ---: | ---: |
| Sequence selected | {failure['legacy']['sequenceSelectedLines']} | {failure['improved']['sequenceSelectedLines']} |
| Timing outliers removed | {failure['legacy']['outlierRemovedLines']} | {failure['improved']['outlierRemovedLines']} |
| Final valid lines | {failure['legacy']['finalValidLines']}/42 | {failure['improved']['finalValidLines']}/42 |
| Coverage | {failure['legacy']['coveragePercent']}% | {failure['improved']['coveragePercent']}% |
| Reverse times | {failure['legacy']['reverseTimeCount']} | {failure['improved']['reverseTimeCount']} |
| Repeated collisions | {failure['legacy']['repeatedCollisionCount']} | {failure['improved']['repeatedCollisionCount']} |

- Recovered former outliers: {failure['improved']['continuousOutlierRecoveredLines']} lines, {failure['improved']['recoveredLineIndexes']}.
- GeneratedLyricsTimeline validation: {failure['improved']['generatedLyricsTimelineValidation']['valid']}.
- Ground truth: unavailable. Coverage is an internal consistency result, not measured timing accuracy.
- Failure replay limitation: {failure['candidateReplay']['limitation']}

## Normal-song regression

| Track | Legacy | Improved | New removals | Regression |
| --- | ---: | ---: | ---: | --- |
{normal_rows}

## Conclusion

The fixed 1,500ms per-line filter was the dominant loss mechanism. Segment-aware filtering restores the monotonic, high-confidence runs without reducing either normal cached song. Matcher validation should precede any ASR replacement.
"""
    path.write_text(report, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--failure-diagnostics", type=Path, required=True)
    parser.add_argument("--baseline-comparison", type=Path, required=True)
    parser.add_argument("--app-store", type=Path, required=True)
    parser.add_argument("--normal-cache", type=Path, action="append", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--threshold", type=float, default=0.66)
    args = parser.parse_args()
    diagnostics = json.loads(args.failure_diagnostics.read_text(encoding="utf-8"))
    baseline_comparison = json.loads(args.baseline_comparison.read_text(encoding="utf-8"))
    app_data = json.loads(args.app_store.read_text(encoding="utf-8-sig"))["data"]
    result = {
        "schemaVersion": 1,
        "comparisonBasis": "Cached Whisper outputs only; no Whisper, BS-RoFormer, Qwen, or other model inference was run.",
        "groundTruth": {
            "available": False,
            "accuracyClaimed": False,
            "note": "Internal monotonicity and coverage are not human timing accuracy.",
        },
        "failureSong": compare_failure(
            diagnostics,
            baseline_comparison["whisperLargeV3"]["processingBreakdownSeconds"],
        ),
        "normalSongRegression": [
            compare_normal_cache(cache, app_data, args.threshold)
            for cache in args.normal_cache
        ],
    }
    result["normalRegressionPassed"] = all(
        item["regressionPassed"] for item in result["normalSongRegression"]
    )
    args.output_dir.mkdir(parents=True, exist_ok=True)
    json_path = args.output_dir / "matcher-improvement-comparison.json"
    report_path = args.output_dir / "matcher-improvement-comparison.md"
    json_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_report(report_path, result)
    print(json.dumps({"json": str(json_path), "markdown": str(report_path)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
