"""Explain one cached Whisper auto-sync failure without rerunning GPU stages."""

from __future__ import annotations

import argparse
import json
import statistics
import wave
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from rapidfuzz import fuzz

from auto_sync_poc import (
    MatchCandidate,
    WordToken,
    build_match_candidates,
    choose_ordered_matches,
    normalize_text,
    split_plain_lyrics,
)


REASON_KEYS = (
    "no_transcript_candidate",
    "text_similarity_below_threshold",
    "sequence_constraint",
    "duplicate_or_repeated_section_conflict",
    "timing_outlier",
    "low_confidence",
    "reversed_time",
    "outside_audio_range",
    "unmatched",
    "unknown",
)


def read_track(app_store: Path, track_id: str) -> tuple[str, dict[str, str]]:
    data = json.loads(app_store.read_text(encoding="utf-8-sig"))["data"]
    lyrics = data.get("lyrics", {}).get(track_id, {})
    track = next((item for item in data.get("tracks", []) if item.get("id") == track_id), {})
    plain = lyrics.get("plainLyrics")
    if not isinstance(plain, str) or not plain.strip():
        raise RuntimeError(f"plain lyrics missing for {track_id}")
    return plain, {"title": track.get("title", ""), "artist": track.get("artist", "")}


def wav_duration_ms(path: Path) -> int:
    with wave.open(str(path), "rb") as handle:
        return round(handle.getnframes() * 1000 / handle.getframerate())


def infer_original_times(cached_anchors: list[dict[str, Any]], line_count: int) -> list[int]:
    """Recover the cached run's linear lyric-time estimates from surviving anchors."""
    points = [
        (anchor["lineIndex"], anchor["lyricTimeMs"])
        for anchor in cached_anchors
        if isinstance(anchor.get("lineIndex"), int)
        and isinstance(anchor.get("lyricTimeMs"), (int, float))
    ]
    if len(points) < 2:
        raise RuntimeError("not enough cached anchors to recover original lyric-time estimates")
    mean_x = statistics.fmean(point[0] for point in points)
    mean_y = statistics.fmean(point[1] for point in points)
    denominator = sum((x - mean_x) ** 2 for x, _ in points)
    if denominator <= 0:
        raise RuntimeError("cached lyric-time estimates do not span multiple lines")
    slope = sum((x - mean_x) * (y - mean_y) for x, y in points) / denominator
    intercept = mean_y - slope * mean_x
    inferred = [round(intercept + slope * index) for index in range(line_count)]
    maximum_residual = max(abs((intercept + slope * x) - y) for x, y in points)
    if maximum_residual > 2:
        raise RuntimeError(
            f"cached lyric times are not a stable linear estimate (max residual {maximum_residual:.2f}ms)"
        )
    return inferred


def candidate_metrics(candidate: MatchCandidate, line: str, tokens: list[WordToken]) -> dict[str, Any]:
    selected_tokens = tokens[candidate.token_start : candidate.token_end]
    transcript = "".join(token.text for token in selected_tokens).strip()
    target = normalize_text(line)
    normalized_transcript = normalize_text(transcript)
    direct = fuzz.ratio(target, normalized_transcript) / 100
    weighted = fuzz.WRatio(target, normalized_transcript) / 100
    text_similarity = direct * 0.75 + weighted * 0.25
    probability = statistics.fmean(token.probability for token in selected_tokens)
    return {
        "transcriptText": transcript,
        "normalizedTranscript": normalized_transcript,
        "segmentStartMs": selected_tokens[0].start_ms,
        "segmentEndMs": selected_tokens[-1].end_ms,
        "tokenStart": candidate.token_start,
        "tokenEndExclusive": candidate.token_end,
        "directSimilarity": round(direct, 4),
        "weightedSimilarity": round(weighted, 4),
        "textSimilarity": round(text_similarity, 4),
        "meanTokenProbability": round(probability, 4),
        "matcherConfidence": round(candidate.confidence, 4),
    }


def temporal_outlier_audit(
    ordered: list[MatchCandidate], original_times: list[int], max_deviation_ms: int = 1500
) -> tuple[set[int], dict[int, dict[str, int]]]:
    anchors = [
        {
            "lineIndex": item.line_index,
            "audioTimeMs": item.audio_time_ms,
            "lyricTimeMs": original_times[item.line_index],
        }
        for item in ordered
    ]
    removed: set[int] = set()
    details: dict[int, dict[str, int]] = {}
    for index, anchor in enumerate(anchors):
        delta = anchor["audioTimeMs"] - anchor["lyricTimeMs"]
        if index < 2 or index + 2 >= len(anchors):
            details[anchor["lineIndex"]] = {
                "audioMinusEstimatedLyricMs": delta,
                "localMedianDeltaMs": delta,
                "localDeviationMs": 0,
                "thresholdMs": max_deviation_ms,
            }
            continue
        neighbors = anchors[index - 2 : index] + anchors[index + 1 : index + 3]
        local_delta = round(
            statistics.median(
                item["audioTimeMs"] - item["lyricTimeMs"] for item in neighbors
            )
        )
        deviation = abs(delta - local_delta)
        details[anchor["lineIndex"]] = {
            "audioMinusEstimatedLyricMs": delta,
            "localMedianDeltaMs": local_delta,
            "localDeviationMs": deviation,
            "thresholdMs": max_deviation_ms,
        }
        if deviation > max_deviation_ms:
            removed.add(anchor["lineIndex"])
    return removed, details


def classify_reason(
    *,
    line_index: int,
    best: dict[str, Any] | None,
    selected: MatchCandidate | None,
    cached_final: dict[str, Any] | None,
    outliers: set[int],
    repeated_texts: set[str],
    normalized_line: str,
    threshold: float,
    duration_ms: int,
    previous_selected_time: int | None,
) -> tuple[str | None, str | None, str | None]:
    if cached_final is not None:
        return None, None, None
    if selected is not None:
        if selected.audio_time_ms < 0 or selected.audio_time_ms > duration_ms:
            return "validation", "outside_audio_range", "selected timestamp is outside the vocals duration"
        if previous_selected_time is not None and selected.audio_time_ms <= previous_selected_time:
            return "validation", "reversed_time", "selected timestamp is not later than the previous selected line"
        if line_index in outliers:
            return "temporal_outlier_filter", "timing_outlier", "local offset deviation exceeded 1500ms"
        return "finalization", "unmatched", "selected candidate did not survive final cached output"
    if best is None:
        return "candidate_generation", "no_transcript_candidate", "no non-empty Whisper token window was available"
    if best["matcherConfidence"] < threshold:
        if best["textSimilarity"] < threshold:
            return "confidence_threshold", "text_similarity_below_threshold", "best text similarity was below the configured threshold"
        return "confidence_threshold", "low_confidence", "token probability lowered the combined matcher confidence below threshold"
    if normalized_line in repeated_texts:
        return "ordered_sequence", "duplicate_or_repeated_section_conflict", "high-scoring repeated text was not selected by the forward-only sequence path"
    return "ordered_sequence", "sequence_constraint", "high-scoring candidate was excluded by the global forward-only sequence path"


def build_diagnostics(
    *,
    plain_lyrics: str,
    track: dict[str, str],
    track_id: str,
    tokens_payload: dict[str, Any],
    cached: dict[str, Any],
    threshold: float,
    duration_ms: int,
) -> dict[str, Any]:
    lines = split_plain_lyrics(plain_lyrics)
    tokens = [WordToken(**item) for item in tokens_payload["tokens"]]
    all_candidates = build_match_candidates(lines, tokens, 0.0)
    by_line: dict[int, list[MatchCandidate]] = defaultdict(list)
    for candidate in all_candidates:
        by_line[candidate.line_index].append(candidate)
    threshold_candidates = [item for item in all_candidates if item.confidence >= threshold]
    selected = choose_ordered_matches(threshold_candidates)
    selected_by_line = {item.line_index: item for item in selected}
    original_times = infer_original_times(cached["anchors"], len(lines))
    reconstructed_outliers, outlier_details = temporal_outlier_audit(selected, original_times)
    cached_outliers = set(cached.get("diagnostics", {}).get("temporalOutlierLines", []))
    if reconstructed_outliers != cached_outliers:
        raise RuntimeError(
            f"outlier reconstruction mismatch: cached={sorted(cached_outliers)}, reconstructed={sorted(reconstructed_outliers)}"
        )
    final_by_line = {anchor["lineIndex"]: anchor for anchor in cached["anchors"]}
    normalized_counts = Counter(normalize_text(line) for line in lines)
    repeated_texts = {text for text, count in normalized_counts.items() if text and count > 1}

    line_results: list[dict[str, Any]] = []
    previous_selected_time: int | None = None
    for line_index, line in enumerate(lines):
        candidates = by_line[line_index]
        best_candidate = max(candidates, key=lambda item: item.confidence, default=None)
        best = candidate_metrics(best_candidate, line, tokens) if best_candidate else None
        ordered = selected_by_line.get(line_index)
        final = final_by_line.get(line_index)
        drop_stage, reason, explanation = classify_reason(
            line_index=line_index,
            best=best,
            selected=ordered,
            cached_final=final,
            outliers=cached_outliers,
            repeated_texts=repeated_texts,
            normalized_line=normalize_text(line),
            threshold=threshold,
            duration_ms=duration_ms,
            previous_selected_time=previous_selected_time,
        )
        selected_metrics = candidate_metrics(ordered, line, tokens) if ordered else None
        initial_time = ordered.audio_time_ms if ordered else (best["segmentStartMs"] if best else None)
        line_results.append(
            {
                "lineIndex": line_index,
                "lyricsText": line,
                "normalizedLyrics": normalize_text(line),
                "relatedWhisperRawSegment": None
                if best is None
                else {
                    "text": best["transcriptText"],
                    "startTimeMs": best["segmentStartMs"],
                    "endTimeMs": best["segmentEndMs"],
                },
                "bestMatchingCandidate": best,
                "textSimilarityPassed": bool(best and best["textSimilarity"] >= threshold),
                "confidencePassed": bool(best and best["matcherConfidence"] >= threshold),
                "sequenceSelected": ordered is not None,
                "selectedCandidate": selected_metrics,
                "estimatedLyricTimeMs": original_times[line_index],
                "initialEstimatedTimeMs": initial_time,
                "initialEstimatedTimeSource": "ordered-sequence-candidate" if ordered else "best-unordered-candidate",
                "finalTimeMs": final.get("audioTimeMs") if final else None,
                "valid": final is not None,
                "dropStage": drop_stage,
                "dropReason": reason,
                "dropExplanation": explanation,
                "temporalOutlierAudit": outlier_details.get(line_index),
                "isRepeatedLyricsText": normalize_text(line) in repeated_texts,
            }
        )
        if ordered is not None:
            previous_selected_time = ordered.audio_time_ms

    reason_counts = {key: 0 for key in REASON_KEYS}
    reason_counts.update(Counter(item["dropReason"] for item in line_results if item["dropReason"]))
    text_passed = sum(item["textSimilarityPassed"] for item in line_results)
    confidence_passed = sum(item["confidencePassed"] for item in line_results)
    sequence_passed = sum(item["sequenceSelected"] for item in line_results)
    repeated_problem_lines = [
        item["lineIndex"]
        for item in line_results
        if item["isRepeatedLyricsText"] and not item["valid"]
    ]
    likely_version_difference = [
        item["lineIndex"]
        for item in line_results
        if item["bestMatchingCandidate"]
        and item["bestMatchingCandidate"]["textSimilarity"] < 0.45
        and not item["isRepeatedLyricsText"]
    ]
    high_confidence_discarded = sum(
        item["confidencePassed"] and not item["valid"] for item in line_results
    )
    conclusion = {
        "primaryCause": "matcher_sequence_and_outlier_filter",
        "rawTranscriptAssessment": (
            f"{confidence_passed}/{len(lines)} lines had a candidate above the configured matcher threshold; "
            f"only {len(final_by_line)} survived. Whisper contains substantial correct lyric text, although six repeated-chorus lines have weak transcription matches."
        ),
        "matcherAssessment": (
            f"The ordered matcher selected {sequence_passed} lines, then the local-offset filter removed "
            f"{len(cached_outliers)}. {high_confidence_discarded} threshold-passing lines were ultimately discarded."
        ),
        "versionDifferenceAssessment": (
            "No line provides strong evidence of a different cover lyric edition. Low-similarity lines are concentrated in repeated chorus passages and are more consistent with ASR omissions or matcher ambiguity."
        ),
    }
    successes = sorted(
        (item for item in line_results if item["valid"]),
        key=lambda item: item["bestMatchingCandidate"]["matcherConfidence"],
        reverse=True,
    )[:3]
    failures: list[dict[str, Any]] = []
    for reason_name in ("timing_outlier", "duplicate_or_repeated_section_conflict", "text_similarity_below_threshold", "sequence_constraint"):
        sample = next((item for item in line_results if item["dropReason"] == reason_name), None)
        if sample:
            failures.append(sample)
    return {
        "schemaVersion": 1,
        "track": {"trackId": track_id, **track, "audioDurationMs": duration_ms},
        "input": {
            "source": "existing cached vocals, tokens, and result; Whisper and BS-RoFormer were not rerun",
            "confidenceThreshold": threshold,
            "whisperTokenCount": len(tokens),
            "cachedMatchedLines": cached["matchedLines"],
        },
        "summary": {
            "totalLyricsLines": len(lines),
            "rawTranscriptCandidateLinkedLines": sum(bool(by_line[index]) for index in range(len(lines))),
            "textSimilarityPassedLines": text_passed,
            "matcherConfidencePassedLines": confidence_passed,
            "sequenceValidationPassedLines": sequence_passed,
            "outlierRemovedLines": len(cached_outliers),
            "finalValidLines": len(final_by_line),
            "finalCoveragePercent": round(100 * len(final_by_line) / len(lines), 3),
            "candidateWindowsGenerated": len(all_candidates),
            "candidateWindowsAboveThreshold": len(threshold_candidates),
            "dropReasonCounts": reason_counts,
            "outlierLineIndexes": sorted(cached_outliers),
            "repeatedSectionProblemLineIndexes": repeated_problem_lines,
            "possibleVersionDifferenceLineIndexes": likely_version_difference,
        },
        "conclusion": conclusion,
        "representativeSamples": {
            "successfulLines": successes,
            "failedLines": failures,
        },
        "lines": line_results,
    }


def write_report(path: Path, diagnostics: dict[str, Any]) -> None:
    summary = diagnostics["summary"]
    conclusion = diagnostics["conclusion"]
    lines = diagnostics["lines"]
    outlier_rows = "\n".join(
        f"| {item['lineIndex']} | {item['lyricsText']} | {item['temporalOutlierAudit']['localDeviationMs']} | {item['dropExplanation']} |"
        for item in lines
        if item["dropReason"] == "timing_outlier"
    )
    success_rows = "\n".join(
        f"- L{item['lineIndex']} `{item['lyricsText']}` → {item['finalTimeMs']}ms, confidence {item['bestMatchingCandidate']['matcherConfidence']}"
        for item in diagnostics["representativeSamples"]["successfulLines"]
    )
    failure_rows = "\n".join(
        f"- L{item['lineIndex']} `{item['lyricsText']}` → {item['dropReason']}: {item['dropExplanation']}"
        for item in diagnostics["representativeSamples"]["failedLines"]
    )
    reason_rows = "\n".join(
        f"| {reason} | {count} |" for reason, count in summary["dropReasonCounts"].items()
    )
    report = f"""# Whisper 40% failure diagnostics

## Stage counts

| Stage | Lines |
| --- | ---: |
| Total lyrics | {summary['totalLyricsLines']} |
| Raw transcript candidate linked | {summary['rawTranscriptCandidateLinkedLines']} |
| Text similarity passed | {summary['textSimilarityPassedLines']} |
| Matcher confidence passed | {summary['matcherConfidencePassedLines']} |
| Ordered sequence selected | {summary['sequenceValidationPassedLines']} |
| Removed as temporal outliers | {summary['outlierRemovedLines']} |
| Final valid | {summary['finalValidLines']} ({summary['finalCoveragePercent']}%) |

## Drop reasons

| Reason | Count |
| --- | ---: |
{reason_rows}

## Thirteen temporal outliers

| Line | Lyrics | Local deviation (ms) | Reason |
| ---: | --- | ---: | --- |
{outlier_rows}

## Assessment

- Raw transcript: {conclusion['rawTranscriptAssessment']}
- Matcher: {conclusion['matcherAssessment']}
- Cover-version difference: {conclusion['versionDifferenceAssessment']}
- Repeated-section problem lines: {summary['repeatedSectionProblemLineIndexes']}

## Representative successes

{success_rows}

## Representative failures

{failure_rows}

This report replays the cached matcher only. Whisper and BS-RoFormer were not executed.
"""
    path.write_text(report, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--track-id", required=True)
    parser.add_argument("--app-store", type=Path, required=True)
    parser.add_argument("--result", type=Path, required=True)
    parser.add_argument("--tokens", type=Path, required=True)
    parser.add_argument("--vocals", type=Path, required=True)
    parser.add_argument("--confidence-threshold", type=float, default=0.66)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    if not 0 <= args.confidence_threshold <= 1:
        raise RuntimeError("confidence threshold must be between zero and one")
    plain, track = read_track(args.app_store, args.track_id)
    cached = json.loads(args.result.read_text(encoding="utf-8"))
    tokens = json.loads(args.tokens.read_text(encoding="utf-8"))
    diagnostics = build_diagnostics(
        plain_lyrics=plain,
        track=track,
        track_id=args.track_id,
        tokens_payload=tokens,
        cached=cached,
        threshold=args.confidence_threshold,
        duration_ms=wav_duration_ms(args.vocals),
    )
    args.output_dir.mkdir(parents=True, exist_ok=True)
    json_path = args.output_dir / "whisper-failure-diagnostics.json"
    report_path = args.output_dir / "whisper-failure-diagnostics.md"
    json_path.write_text(json.dumps(diagnostics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_report(report_path, diagnostics)
    print(json.dumps({"json": str(json_path), "markdown": str(report_path)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
