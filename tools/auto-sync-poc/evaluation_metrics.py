from __future__ import annotations

import math
import statistics
from collections import Counter, defaultdict
from typing import Any

from auto_sync_poc import normalize_text


ERROR_CATEGORIES = [
    "intro_difference",
    "tempo_difference",
    "instrumental_break",
    "repeated_chorus",
    "omitted_lyrics",
    "ad_lib",
    "duet_or_harmony",
    "long_syllable",
    "whisper_hallucination",
    "vocal_separation_artifact",
]


def percentile(values: list[int | float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(float(value) for value in values)
    position = (len(ordered) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def score_against_ground_truth(
    case: dict[str, Any],
    pipeline_result: dict[str, Any],
    fatal_error_ms: int,
) -> dict[str, Any]:
    ground_truth = {
        int(anchor["lineIndex"]): int(anchor["audioTimeMs"])
        for anchor in case["groundTruthAnchors"]
    }
    automatic = {
        int(anchor["lineIndex"]): int(anchor["audioTimeMs"])
        for anchor in pipeline_result["anchors"]
    }
    matched_indices = sorted(set(ground_truth) & set(automatic))
    timing_errors = [abs(automatic[index] - ground_truth[index]) for index in matched_indices]
    unmatched = sorted(set(ground_truth) - set(automatic))
    fatal_lines = [
        index
        for index in matched_indices
        if abs(automatic[index] - ground_truth[index]) > fatal_error_ms
    ]

    normalized_lines = [normalize_text(line) for line in case["plainLyrics"]]
    duplicate_counts = Counter(line for line in normalized_lines if line)
    repeated_lines = {
        index
        for index, line in enumerate(normalized_lines)
        if line and duplicate_counts[line] > 1
    }
    wrong_repeated = sorted(repeated_lines & set(fatal_lines))
    failed_lines = set(unmatched) | set(fatal_lines) | set(
        pipeline_result.get("diagnostics", {}).get("temporalOutlierLines", [])
    )
    annotations = case.get("errorAnnotations", [])
    error_analysis: dict[str, Any] = {}
    for category in ERROR_CATEGORIES:
        annotated = sorted(
            {
                int(line)
                for annotation in annotations
                if annotation.get("type") == category
                for line in annotation.get("lineIndices", [])
            }
        )
        error_analysis[category] = {
            "annotatedLines": annotated,
            "failedLines": sorted(set(annotated) & failed_lines),
        }

    total_ground_truth = len(ground_truth)
    matched_ground_truth = len(matched_indices)
    return {
        "matchedLines": pipeline_result["matchedLines"],
        "matchedGroundTruthLines": matched_ground_truth,
        "groundTruthLines": total_ground_truth,
        "matchRate": round(matched_ground_truth / total_ground_truth, 6)
        if total_ground_truth
        else None,
        "medianAbsoluteTimingErrorMs": round(statistics.median(timing_errors))
        if timing_errors
        else None,
        "meanAbsoluteTimingErrorMs": round(statistics.fmean(timing_errors), 3)
        if timing_errors
        else None,
        "p90TimingErrorMs": round(percentile(timing_errors, 0.9))
        if timing_errors
        else None,
        "maximumTimingErrorMs": max(timing_errors) if timing_errors else None,
        "timingErrorsMs": timing_errors,
        "unmatchedGroundTruthLines": unmatched,
        "unscoredAutomaticLines": sorted(set(automatic) - set(ground_truth)),
        "fatalWrongSectionLines": fatal_lines,
        "fatalWrongSectionRate": round(len(fatal_lines) / matched_ground_truth, 6)
        if matched_ground_truth
        else None,
        "wrongRepeatedSectionMatchCount": len(wrong_repeated),
        "wrongRepeatedSectionLines": wrong_repeated,
        "leaveOneOut": pipeline_result.get("comparison", {}),
        "errorAnalysis": error_analysis,
    }


def aggregate_results(
    case_results: list[dict[str, Any]], config: dict[str, Any]
) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for case in case_results:
        for variant in case["variants"]:
            grouped[variant["variantId"]].append(variant)

    aggregates: dict[str, Any] = {}
    criteria = config["integrationBenchmarks"]
    for variant_id, variants in sorted(grouped.items()):
        scores = [variant["groundTruth"] for variant in variants]
        total_gt = sum(score["groundTruthLines"] for score in scores)
        total_matched = sum(score["matchedGroundTruthLines"] for score in scores)
        all_errors = [error for score in scores for error in score["timingErrorsMs"]]
        fatal_count = sum(len(score["fatalWrongSectionLines"]) for score in scores)
        match_rates = [score["matchRate"] for score in scores if score["matchRate"] is not None]
        processing = [variant["processingSeconds"] for variant in variants]
        vram = [variant["peakGpuMemoryMiB"] for variant in variants]
        loo_before = [
            score["leaveOneOut"].get("beforeMedianAbsErrorMs")
            for score in scores
            if score["leaveOneOut"].get("beforeMedianAbsErrorMs") is not None
        ]
        loo_after = [
            score["leaveOneOut"].get("afterLeaveOneOutMedianAbsErrorMs")
            for score in scores
            if score["leaveOneOut"].get("afterLeaveOneOutMedianAbsErrorMs") is not None
        ]
        aggregate = {
            "caseCount": len(variants),
            "matchedGroundTruthLines": total_matched,
            "groundTruthLines": total_gt,
            "matchRate": round(total_matched / total_gt, 6) if total_gt else None,
            "meanCaseMatchRate": round(statistics.fmean(match_rates), 6) if match_rates else None,
            "medianCaseMatchRate": round(statistics.median(match_rates), 6) if match_rates else None,
            "medianTimingErrorMs": round(statistics.median(all_errors)) if all_errors else None,
            "meanTimingErrorMs": round(statistics.fmean(all_errors), 3) if all_errors else None,
            "p90TimingErrorMs": round(percentile(all_errors, 0.9)) if all_errors else None,
            "maximumTimingErrorMs": max(all_errors) if all_errors else None,
            "fatalWrongSectionRate": round(fatal_count / total_matched, 6)
            if total_matched
            else None,
            "wrongRepeatedSectionMatchCount": sum(
                score["wrongRepeatedSectionMatchCount"] for score in scores
            ),
            "averageProcessingSeconds": round(statistics.fmean(processing), 3),
            "maximumPeakGpuMemoryMiB": max(vram),
            "leaveOneOutConsistency": {
                "medianOriginalDifferenceMs": round(statistics.median(loo_before))
                if loo_before
                else None,
                "medianHeldOutPredictionErrorMs": round(statistics.median(loo_after))
                if loo_after
                else None,
                "note": "Diagnostic consistency only; not human-ground-truth accuracy.",
            },
        }
        aggregate["benchmarkComparison"] = {
            "matchRate": aggregate["matchRate"] is not None
            and aggregate["matchRate"] >= criteria["minimumMatchRate"],
            "medianTimingError": aggregate["medianTimingErrorMs"] is not None
            and aggregate["medianTimingErrorMs"] <= criteria["maximumMedianTimingErrorMs"],
            "p90TimingError": aggregate["p90TimingErrorMs"] is not None
            and aggregate["p90TimingErrorMs"] <= criteria["maximumP90TimingErrorMs"],
            "fatalWrongSectionRate": aggregate["fatalWrongSectionRate"] is not None
            and aggregate["fatalWrongSectionRate"]
            <= criteria["maximumFatalWrongSectionRate"],
        }
        aggregate["meetsAllBenchmarks"] = all(aggregate["benchmarkComparison"].values())
        aggregates[variant_id] = aggregate

    def delta(left: str, right: str, field: str) -> float | None:
        a = aggregates.get(left, {}).get(field)
        b = aggregates.get(right, {}).get(field)
        return round(b - a, 6) if a is not None and b is not None else None

    separation_effect: dict[str, Any] = {}
    for mode in ("none", "full", "keywords"):
        original = f"original:{mode}"
        vocals = f"vocals:{mode}"
        separation_effect[mode] = {
            "matchRateDelta": delta(original, vocals, "matchRate"),
            "medianTimingErrorDeltaMs": delta(original, vocals, "medianTimingErrorMs"),
            "p90TimingErrorDeltaMs": delta(original, vocals, "p90TimingErrorMs"),
            "processingSecondsDelta": delta(original, vocals, "averageProcessingSeconds"),
        }

    hotword_effect: dict[str, Any] = {}
    for source in ("original", "vocals"):
        baseline = f"{source}:none"
        hotword_effect[source] = {
            mode: {
                "matchRateDelta": delta(baseline, f"{source}:{mode}", "matchRate"),
                "medianTimingErrorDeltaMs": delta(
                    baseline, f"{source}:{mode}", "medianTimingErrorMs"
                ),
                "p90TimingErrorDeltaMs": delta(
                    baseline, f"{source}:{mode}", "p90TimingErrorMs"
                ),
            }
            for mode in ("full", "keywords")
        }

    eligible = [
        (variant_id, aggregate)
        for variant_id, aggregate in aggregates.items()
        if aggregate["caseCount"] >= config["minimumCasesForRecommendation"]
    ]
    eligible.sort(
        key=lambda item: (
            not item[1]["meetsAllBenchmarks"],
            item[1]["p90TimingErrorMs"] if item[1]["p90TimingErrorMs"] is not None else math.inf,
            -(item[1]["matchRate"] or 0),
        )
    )
    best = eligible[0] if eligible else None
    recommendation = (
        "consider-pilot-integration"
        if best and best[1]["meetsAllBenchmarks"]
        else "do-not-integrate"
        if best
        else "insufficient-human-ground-truth"
    )
    return {
        "caseCount": len(case_results),
        "benchmarks": criteria,
        "variants": aggregates,
        "vocalSeparationEffect": separation_effect,
        "hotwordEffect": hotword_effect,
        "recommendation": {
            "status": recommendation,
            "bestVariant": best[0] if best else None,
            "reason": "Benchmarks are comparison criteria loaded from config.json, not product gates.",
        },
    }


def render_markdown(summary: dict[str, Any], case_results: list[dict[str, Any]]) -> str:
    def percent(value: float | None) -> str:
        return f"{value:.1%}" if value is not None else "n/a"

    def milliseconds(value: float | int | None) -> str:
        return f"{value} ms" if value is not None else "n/a"

    lines = [
        "# Automatic sync evaluation report",
        "",
        f"Human-ground-truth cases: {summary['caseCount']}",
        f"Recommendation: **{summary['recommendation']['status']}**",
        f"Best variant: `{summary['recommendation']['bestVariant'] or 'none'}`",
        "",
        "Leave-one-out consistency and human-ground-truth timing errors are reported separately. Only the latter is used for the integration comparison.",
        "",
        "## Aggregate variants",
        "",
        "| Variant | Match rate | Median error | P90 error | Fatal rate | Avg time | Peak VRAM | Benchmarks |",
        "|---|---:|---:|---:|---:|---:|---:|:---:|",
    ]
    for variant_id, result in summary["variants"].items():
        lines.append(
            f"| {variant_id} | {percent(result['matchRate'])} | {milliseconds(result['medianTimingErrorMs'])} | "
            f"{milliseconds(result['p90TimingErrorMs'])} | {percent(result['fatalWrongSectionRate'])} | "
            f"{result['averageProcessingSeconds']:.1f} s | {result['maximumPeakGpuMemoryMiB']} MiB | "
            f"{'yes' if result['meetsAllBenchmarks'] else 'no'} |"
        )
    lines.extend(["", "## BS-RoFormer effect", ""])
    for mode, effect in summary["vocalSeparationEffect"].items():
        lines.append(
            f"- `{mode}`: match-rate Δ {effect['matchRateDelta']}, median-error Δ "
            f"{milliseconds(effect['medianTimingErrorDeltaMs'])}, p90 Δ "
            f"{milliseconds(effect['p90TimingErrorDeltaMs'])}, time Δ "
            f"{effect['processingSecondsDelta']} s"
        )
    lines.extend(["", "## Hotword effect", ""])
    for source, modes in summary["hotwordEffect"].items():
        for mode, effect in modes.items():
            lines.append(
                f"- `{source}:{mode}` versus `{source}:none`: match-rate Δ "
                f"{effect['matchRateDelta']}, median-error Δ "
                f"{milliseconds(effect['medianTimingErrorDeltaMs'])}, p90 Δ "
                f"{milliseconds(effect['p90TimingErrorDeltaMs'])}"
            )
    lines.extend(["", "## Per case", ""])
    for case in case_results:
        lines.extend([f"### {case['id']}", ""])
        for variant in case["variants"]:
            score = variant["groundTruth"]
            leave_one_out = score["leaveOneOut"]
            failures = [
                category
                for category, details in score["errorAnalysis"].items()
                if details["failedLines"]
            ]
            lines.append(
                f"- `{variant['variantId']}`: {score['matchedGroundTruthLines']}/{score['groundTruthLines']} "
                f"({percent(score['matchRate'])}), human median {milliseconds(score['medianAbsoluteTimingErrorMs'])}, "
                f"human p90 {milliseconds(score['p90TimingErrorMs'])}, LOO "
                f"{milliseconds(leave_one_out.get('afterLeaveOneOutMedianAbsErrorMs'))}, "
                f"{variant['processingSeconds']:.1f} s, {variant['peakGpuMemoryMiB']} MiB; "
                f"wrong repeats: {score['wrongRepeatedSectionMatchCount']}; "
                f"failures: {', '.join(failures) or 'none'}"
            )
        lines.append("")
    lines.extend(
        [
            "## Interpretation",
            "",
            "The report does not treat hotword-biased Whisper confidence as ground truth. Human anchor errors determine accuracy. Review fatal and repeated-section errors before considering app integration.",
            "",
        ]
    )
    return "\n".join(lines)
