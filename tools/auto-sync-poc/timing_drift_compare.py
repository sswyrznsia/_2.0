"""Replay cached matcher data with drift-safe segments and gap recovery."""

from __future__ import annotations

import argparse
import json
import time
from collections import Counter
from pathlib import Path
from typing import Any

from auto_sync_poc import (
    WordToken,
    build_match_candidates,
    build_timing_segments,
    choose_ordered_matches,
    filter_temporal_outliers,
    interpolate_short_gaps,
    map_original_times,
    normalize_text,
    parse_synced_lyrics,
    plan_local_retry_requests,
    split_plain_lyrics,
)
from matcher_improvement_compare import make_timeline, validate_timeline


def repeated_indexes(lines: list[str]) -> set[int]:
    counts = Counter(normalize_text(line) for line in lines)
    return {
        index
        for index, line in enumerate(lines)
        if counts[normalize_text(line)] > 1
    }


def replay(
    *,
    track_id: str,
    lines: list[str],
    original_times: list[int | None],
    tokens: list[WordToken],
    threshold: float,
    baseline_result: dict[str, Any],
) -> dict[str, Any]:
    started = time.perf_counter()
    all_candidates = build_match_candidates(lines, tokens, 0.0)
    candidates = [item for item in all_candidates if item.confidence >= threshold]
    repeated = repeated_indexes(lines)
    matches = choose_ordered_matches(
        candidates,
        expected_times_ms=original_times,
        repeated_line_indexes=repeated,
    )
    anchors = [
        {
            "lineIndex": match.line_index,
            "lyricTimeMs": original_times[match.line_index],
            "audioTimeMs": match.audio_time_ms,
            "confidence": round(match.confidence, 4),
            "whisperText": match.whisper_text,
            "source": "direct",
        }
        for match in matches
        if original_times[match.line_index] is not None
    ]
    anchors, removed = filter_temporal_outliers(
        anchors,
        audio_duration_ms=max(token.end_ms for token in tokens),
        repeated_line_indexes=repeated,
    )
    segments, line_to_segment = build_timing_segments(anchors, repeated)
    anchors, interpolated = interpolate_short_gaps(
        lines, anchors, line_to_segment, repeated
    )
    retry_requests = plan_local_retry_requests(lines, anchors)
    processing_seconds = time.perf_counter() - started
    safe_anchors = [anchor for anchor in anchors if anchor["confidence"] >= 0.75]
    timeline = make_timeline(track_id, lines, safe_anchors)
    sources = Counter(anchor.get("source", "direct") for anchor in anchors)
    baseline_indexes = {anchor["lineIndex"] for anchor in baseline_result["anchors"]}
    safe_indexes = {anchor["lineIndex"] for anchor in safe_anchors}
    preview_indexes = {anchor["lineIndex"] for anchor in anchors}
    return {
        "trackId": track_id,
        "totalLines": len(lines),
        "candidateWindows": len(all_candidates),
        "aboveThresholdCandidateWindows": len(candidates),
        "sequenceSelectedLines": len(matches),
        "isolatedOutlierRemovedLines": removed,
        "segments": segments,
        "sourceCounts": {
            "direct": sources["direct"],
            "segment_recovered": sources["segment_recovered"],
            "interpolated": sources["interpolated"],
            "local_retry": sources["local_retry"],
            "unmatched": len(lines) - len(anchors),
        },
        "previewLineCount": len(anchors),
        "autoApplicableLineCount": len(safe_anchors),
        "autoApplicableCoveragePercent": round(100 * len(safe_anchors) / len(lines), 3),
        "lowConfidenceLines": [
            {
                "lineIndex": anchor["lineIndex"],
                "source": anchor["source"],
                "confidence": anchor["confidence"],
            }
            for anchor in anchors
            if anchor["confidence"] < 0.75
        ],
        "interpolatedLineIndexes": interpolated,
        "localRetryRequests": retry_requests,
        "unmatchedLineIndexes": sorted(set(range(len(lines))) - preview_indexes),
        "baselineMaintainedLineIndexes": sorted(baseline_indexes & safe_indexes),
        "baselineExcludedLineIndexes": sorted(baseline_indexes - safe_indexes),
        "newSafeLineIndexes": sorted(safe_indexes - baseline_indexes),
        "reverseTimeCount": sum(
            right["audioTimeMs"] <= left["audioTimeMs"]
            for left, right in zip(safe_anchors, safe_anchors[1:])
        ),
        "generatedLyricsTimelineValidation": validate_timeline(timeline, lines),
        "processingSeconds": round(processing_seconds, 3),
        "lineTimings": [
            next(
                (
                    {
                        "lineIndex": index,
                        "source": anchor["source"],
                        "confidence": anchor["confidence"],
                        "audioTimeMs": anchor["audioTimeMs"],
                    }
                    for anchor in anchors
                    if anchor["lineIndex"] == index
                ),
                {
                    "lineIndex": index,
                    "source": "unmatched",
                    "confidence": 0.0,
                    "audioTimeMs": None,
                },
            )
            for index in range(len(lines))
        ],
    }


def write_report(path: Path, result: dict[str, Any]) -> None:
    failure = result["failureSong"]
    segment_rows = "\n".join(
        f"| {segment['segmentIndex']} | {segment['startLineIndex']}–{segment['endLineIndex']} | {segment['slope']} | {segment['interceptMs']} | {segment['boundaryDiscontinuityMs']} | {segment['directHighConfidenceUniqueAnchors']} | {segment['driftRisk']} |"
        for segment in failure["segments"]
    )
    normal_rows = "\n".join(
        f"| {item['trackId'][:8]} | {item['baselineMatchedLines']} | {item['previewLineCount']} | {item['regressionPassed']} |"
        for item in result["normalRegression"]
    )
    report = f"""# Timing drift and short-gap recovery

## Failure song result

- Previous matcher preview: {result['baseline']['matchedLines']}/42.
- Drift-safe preview: {failure['previewLineCount']}/42.
- Auto-applicable: {failure['autoApplicableLineCount']}/42 ({failure['autoApplicableCoveragePercent']}%).
- Sources: {failure['sourceCounts']}.
- Existing lines maintained/excluded: {len(failure['baselineMaintainedLineIndexes'])}/{failure['baselineExcludedLineIndexes']}.
- New safe interpolated lines: {failure['newSafeLineIndexes']}.
- Low-confidence preview lines: {failure['lowConfidenceLines']}.
- Remaining unmatched: {failure['unmatchedLineIndexes']}.

## Segment diagnostics

| Segment | Lines | Slope | Intercept ms | Boundary discontinuity ms | Unique direct support | Drift risk |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
{segment_rows}

The late drift risk is caused by large boundary discontinuities, not cumulative extrapolation. Interpolation is confined to two direct anchors inside one segment; no line is extrapolated beyond anchor coverage.

## Normal cache regression

| Track | Baseline synced anchors | Drift-safe synced anchors | Pass |
| --- | ---: | ---: | --- |
{normal_rows}

Human ground truth is unavailable. These are structural consistency and safety results, not measured timing accuracy. No model inference was run.
"""
    path.write_text(report, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--failure-cache", type=Path, required=True)
    parser.add_argument("--failure-diagnostics", type=Path, required=True)
    parser.add_argument("--normal-cache", type=Path, required=True)
    parser.add_argument("--app-store", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--threshold", type=float, default=0.66)
    args = parser.parse_args()
    app_data = json.loads(args.app_store.read_text(encoding="utf-8-sig"))["data"]
    diagnostic = json.loads(args.failure_diagnostics.read_text(encoding="utf-8"))
    failure_result = json.loads((args.failure_cache / "result.json").read_text(encoding="utf-8"))
    failure_tokens = [
        WordToken(**item)
        for item in json.loads((args.failure_cache / "tokens.json").read_text(encoding="utf-8"))["tokens"]
    ]
    failure_lines = [item["lyricsText"] for item in diagnostic["lines"]]
    failure_times = [item["estimatedLyricTimeMs"] for item in diagnostic["lines"]]
    failure = replay(
        track_id=failure_result["trackId"],
        lines=failure_lines,
        original_times=failure_times,
        tokens=failure_tokens,
        threshold=args.threshold,
        baseline_result=failure_result,
    )

    normal_result = json.loads((args.normal_cache / "result.json").read_text(encoding="utf-8"))
    normal_lyrics = app_data["lyrics"][normal_result["trackId"]]
    normal_lines = split_plain_lyrics(normal_lyrics["plainLyrics"])
    normal_times = map_original_times(
        normal_lines, parse_synced_lyrics(normal_lyrics.get("syncedLyrics"))
    )
    normal_tokens = [
        WordToken(**item)
        for item in json.loads((args.normal_cache / "tokens.json").read_text(encoding="utf-8"))["tokens"]
    ]
    normal = replay(
        track_id=normal_result["trackId"],
        lines=normal_lines,
        original_times=normal_times,
        tokens=normal_tokens,
        threshold=args.threshold,
        baseline_result=normal_result,
    )
    normal["baselineMatchedLines"] = normal_result["matchedLines"]
    # Existing synced-lyrics profiles keep every structurally valid anchor,
    # including anchors below the generated-timeline confidence threshold.
    normal["regressionPassed"] = (
        normal["previewLineCount"] >= normal_result["matchedLines"]
    )
    result = {
        "schemaVersion": 1,
        "basis": "Existing cached vocals/transcript only; no Whisper, BS-RoFormer, Qwen, or other model inference.",
        "groundTruthAvailable": False,
        "baseline": {
            "matchedLines": failure_result["matchedLines"],
            "totalLines": failure_result["totalLines"],
        },
        "failureSong": failure,
        "normalRegression": [normal],
        "normalRegressionPassed": normal["regressionPassed"],
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    json_path = args.output_dir / "timing-drift-comparison.json"
    report_path = args.output_dir / "timing-drift-comparison.md"
    json_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_report(report_path, result)
    print(json.dumps({"json": str(json_path), "markdown": str(report_path)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
