from __future__ import annotations

import argparse
import gc
import json
import statistics
import tempfile
import time
from pathlib import Path
from typing import Any

from auto_sync_poc import (
    GpuMonitor,
    build_match_candidates,
    choose_ordered_matches,
    comparison_metrics,
    filter_temporal_outliers,
    load_whisper_model,
    map_original_times,
    parse_synced_lyrics,
    separate_vocals,
    split_plain_lyrics,
    transcribe_with_model,
)
from evaluation_metrics import aggregate_results, render_markdown, score_against_ground_truth


def load_cases(case_directory: Path, evaluation_root: Path) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    for path in sorted(case_directory.glob("*.json")):
        if ".example." in path.name:
            continue
        case = json.loads(path.read_text(encoding="utf-8"))
        if "groundTruthAnchors" not in case:
            ground_truth_path = case.get("groundTruthPath")
            if not ground_truth_path:
                raise ValueError(f"{path}: groundTruthAnchors or groundTruthPath is required")
            truth = json.loads((evaluation_root / ground_truth_path).read_text(encoding="utf-8"))
            case["groundTruthAnchors"] = truth["groundTruthAnchors"]
            case["errorAnnotations"] = truth.get("errorAnnotations", [])
        validate_case(case, path)
        cases.append(case)
    return cases


def validate_case(case: dict[str, Any], path: Path) -> None:
    required = ["id", "audioPath", "plainLyrics", "originalSyncedLyrics", "groundTruthAnchors"]
    missing = [field for field in required if not case.get(field)]
    if missing:
        raise ValueError(f"{path}: missing non-empty fields: {', '.join(missing)}")
    if not Path(case["audioPath"]).is_file():
        raise FileNotFoundError(f"{path}: audio does not exist: {case['audioPath']}")
    indices = [int(anchor["lineIndex"]) for anchor in case["groundTruthAnchors"]]
    if len(indices) != len(set(indices)):
        raise ValueError(f"{path}: duplicate human ground-truth lineIndex")
    line_count = len(case["plainLyrics"])
    if any(index < 0 or index >= line_count for index in indices):
        raise ValueError(f"{path}: ground-truth lineIndex outside plainLyrics")
    annotations = case.get("errorAnnotations", [])
    allowed = {
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
    }
    unknown = sorted({item.get("type") for item in annotations} - allowed)
    if unknown:
        raise ValueError(f"{path}: unknown error annotation types: {unknown}")


def hotword_text(case: dict[str, Any], mode: str) -> str | None:
    if mode == "none":
        return None
    if mode == "full":
        return " ".join(case["plainLyrics"])
    keywords = case.get("keywordHotwords", [])
    if not keywords:
        raise ValueError(
            f"{case['id']}: keywordHotwords must be human-curated for keywords mode"
        )
    return " ".join(keywords)


def result_from_tokens(
    case: dict[str, Any], tokens: list[Any], confidence_threshold: float
) -> dict[str, Any]:
    lines = split_plain_lyrics(case["plainLyrics"])
    original_times = map_original_times(
        lines, parse_synced_lyrics(case["originalSyncedLyrics"])
    )
    all_candidates = build_match_candidates(lines, tokens, 0.0)
    matches = choose_ordered_matches(
        [candidate for candidate in all_candidates if candidate.confidence >= confidence_threshold]
    )
    anchors: list[dict[str, Any]] = []
    for match in matches:
        lyric_time = original_times[match.line_index]
        if lyric_time is None:
            continue
        anchors.append(
            {
                "lineIndex": match.line_index,
                "lyricTimeMs": lyric_time,
                "audioTimeMs": match.audio_time_ms,
                "confidence": round(match.confidence, 4),
                "whisperText": match.whisper_text,
            }
        )
    anchors, temporal_outliers = filter_temporal_outliers(anchors)
    matched = {anchor["lineIndex"] for anchor in anchors}
    return {
        "matchedLines": len(anchors),
        "totalLines": len(lines),
        "confidence": round(
            statistics.fmean(anchor["confidence"] for anchor in anchors), 4
        )
        if anchors
        else 0.0,
        "anchors": anchors,
        "unmatchedLines": [index for index in range(len(lines)) if index not in matched],
        "lyricsSyncProfile": {
            "trackId": case["id"],
            "offsetMs": 0,
            "anchors": [
                {
                    "lyricTimeMs": anchor["lyricTimeMs"],
                    "audioTimeMs": anchor["audioTimeMs"],
                }
                for anchor in anchors
            ],
            "updatedAt": 0,
        },
        "comparison": comparison_metrics(anchors),
        "diagnostics": {
            "temporalOutlierLines": temporal_outliers,
            "whisperTokenCount": len(tokens),
            "whisperTranscript": "".join(token.text for token in tokens),
        },
    }


def run_variant(
    case: dict[str, Any],
    source: str,
    hotword_mode: str,
    audio_path: Path,
    model: Any,
    confidence_threshold: float,
    separation: dict[str, Any] | None,
    fatal_error_ms: int,
) -> dict[str, Any]:
    monitor = GpuMonitor()
    monitor.set_phase("whisper")
    monitor.start()
    started = time.perf_counter()
    try:
        tokens = transcribe_with_model(model, audio_path, hotword_text(case, hotword_mode))
        whisper_seconds = time.perf_counter() - started
        matching_started = time.perf_counter()
        pipeline = result_from_tokens(case, tokens, confidence_threshold)
        matching_seconds = time.perf_counter() - matching_started
    finally:
        gpu = monitor.stop()
    separation_seconds = separation["seconds"] if source == "vocals" and separation else 0.0
    separation_peak = (
        separation["gpuMemory"]["peakMiB"] if source == "vocals" and separation else 0
    )
    processing_seconds = separation_seconds + whisper_seconds + matching_seconds
    score = score_against_ground_truth(case, pipeline, fatal_error_ms)
    return {
        "variantId": f"{source}:{hotword_mode}",
        "source": source,
        "hotwordMode": hotword_mode,
        "pipeline": pipeline,
        "groundTruth": score,
        "processingSeconds": round(processing_seconds, 3),
        "stageSeconds": {
            "vocalSeparation": round(separation_seconds, 3),
            "whisper": round(whisper_seconds, 3),
            "matching": round(matching_seconds, 3),
        },
        "peakGpuMemoryMiB": max(gpu["peakMiB"], separation_peak),
        "gpuMemory": {"whisper": gpu, "vocalSeparation": separation},
        "suspectedWhisperHallucination": bool(
            tokens and score["matchRate"] is not None and score["matchRate"] < 0.25
        ),
    }


def run_case(
    case: dict[str, Any],
    workspace: Path,
    config: dict[str, Any],
    sources: list[str],
    hotword_modes: list[str],
) -> dict[str, Any]:
    cache_root = workspace / ".poc-cache"
    temp_root = workspace / ".poc-tmp"
    temp_root.mkdir(parents=True, exist_ok=True)
    variants: list[dict[str, Any]] = []
    try:
        with tempfile.TemporaryDirectory(prefix=f"evaluation-{case['id']}-", dir=temp_root) as directory:
            temp_dir = Path(directory)
            separation: dict[str, Any] | None = None
            vocal_path: Path | None = None
            if "vocals" in sources:
                monitor = GpuMonitor()
                monitor.set_phase("vocalSeparation")
                monitor.start()
                started = time.perf_counter()
                try:
                    vocal_path = separate_vocals(
                        Path(case["audioPath"]), temp_dir, cache_root / "models"
                    )
                finally:
                    separation = {
                        "seconds": round(time.perf_counter() - started, 3),
                        "gpuMemory": monitor.stop(),
                    }
            model = load_whisper_model(config["whisperModel"], cache_root / "whisper")
            try:
                for source in sources:
                    audio_path = Path(case["audioPath"]) if source == "original" else vocal_path
                    if audio_path is None:
                        raise RuntimeError("Vocal source requested without a separated stem")
                    for mode in hotword_modes:
                        variants.append(
                            run_variant(
                                case,
                                source,
                                mode,
                                audio_path,
                                model,
                                config["confidenceThreshold"],
                                separation,
                                config["fatalWrongSectionErrorMs"],
                            )
                        )
            finally:
                del model
                gc.collect()
    finally:
        if temp_root.exists() and not any(temp_root.iterdir()):
            temp_root.rmdir()
    return {"id": case["id"], "variants": variants}


def main() -> None:
    workspace = Path(__file__).resolve().parents[2]
    evaluation_root = Path(__file__).resolve().parent / "evaluation"
    parser = argparse.ArgumentParser(
        description="Run human-ground-truth evaluation for automatic lyric sync"
    )
    parser.add_argument("--cases", type=Path, default=evaluation_root / "cases")
    parser.add_argument("--config", type=Path, default=evaluation_root / "config.json")
    parser.add_argument("--sources", default="original,vocals")
    parser.add_argument("--hotword-modes", default="none,full,keywords")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    config = json.loads(args.config.read_text(encoding="utf-8"))
    cases = load_cases(args.cases, evaluation_root)
    minimum_cases = int(config["minimumCasesForRecommendation"])
    if len(cases) < minimum_cases:
        raise ValueError(
            f"At least {minimum_cases} human-annotated cases are required; found {len(cases)}"
        )
    sources = [value.strip() for value in args.sources.split(",") if value.strip()]
    modes = [value.strip() for value in args.hotword_modes.split(",") if value.strip()]
    if not set(sources) <= {"original", "vocals"}:
        raise ValueError("sources must contain only original,vocals")
    if not set(modes) <= {"none", "full", "keywords"}:
        raise ValueError("hotword modes must contain only none,full,keywords")
    if "keywords" in modes:
        missing = [case["id"] for case in cases if not case.get("keywordHotwords")]
        if missing:
            raise ValueError(f"Human-curated keywordHotwords are missing: {missing}")
    if args.dry_run:
        print(json.dumps({"valid": True, "caseCount": len(cases)}, ensure_ascii=True))
        return

    result_directory = evaluation_root / "results"
    result_directory.mkdir(parents=True, exist_ok=True)
    case_results: list[dict[str, Any]] = []
    for case in cases:
        result = run_case(case, workspace, config, sources, modes)
        case_results.append(result)
        (result_directory / f"{case['id']}.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    summary = aggregate_results(case_results, config)
    (evaluation_root / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (evaluation_root / "REPORT.md").write_text(
        render_markdown(summary, case_results), encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
