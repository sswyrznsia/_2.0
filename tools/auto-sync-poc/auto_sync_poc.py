from __future__ import annotations

import argparse
import contextlib
import gc
import json
import math
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import unicodedata
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable, TextIO

try:
    from rapidfuzz import fuzz
except ImportError:
    fuzz = None


MODEL_FILENAME = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"
WHISPER_REQUIRED_FILES = (
    "model.bin",
    "config.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "vocabulary.json",
)
LRC_TIMESTAMP = re.compile(r"\[(\d{1,3}):(\d{2}(?:[.:]\d{1,3})?)\]")
CACHE_KEY = re.compile(r"^[a-f0-9]{64}$")
STAGE_PROGRESS_WINDOWS = {
    "preparing": (0.0, 0.03),
    "separating": (0.03, 0.40),
    "releasing-separator": (0.40, 0.44),
    "transcribing": (0.44, 0.78),
    "matching": (0.78, 0.92),
    "building-anchors": (0.92, 0.97),
    "validating": (0.97, 0.99),
}


class AutoSyncFailure(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class JsonEventEmitter:
    def __init__(self, enabled: bool = False, stream: TextIO | None = None) -> None:
        self.enabled = enabled
        self.stream = stream or sys.stdout
        self.current_stage = "preparing"
        self._last_progress: dict[str, float] = {}

    def _emit(self, payload: dict[str, Any]) -> None:
        if not self.enabled:
            return
        print(
            json.dumps(payload, ensure_ascii=True, separators=(",", ":")),
            file=self.stream,
            flush=True,
        )

    def stage(
        self,
        stage: str,
        *,
        message: str | None = None,
        cache_hit: bool = False,
        indeterminate: bool = True,
    ) -> None:
        if stage not in STAGE_PROGRESS_WINDOWS:
            raise ValueError(f"Unknown automatic sync stage: {stage}")
        self.current_stage = stage
        start, _ = STAGE_PROGRESS_WINDOWS[stage]
        payload: dict[str, Any] = {
            "event": "stage",
            "stage": stage,
            "progress": None if indeterminate else 0.0,
            "overallProgress": start,
            "indeterminate": indeterminate,
        }
        if message:
            payload["message"] = message
        if cache_hit:
            payload["cacheHit"] = True
        self._emit(payload)

    def progress(
        self,
        stage: str,
        progress: float,
        *,
        current: int | None = None,
        total: int | None = None,
        message: str | None = None,
        cache_hit: bool = False,
        force: bool = False,
    ) -> None:
        if stage not in STAGE_PROGRESS_WINDOWS:
            raise ValueError(f"Unknown automatic sync stage: {stage}")
        value = max(0.0, min(1.0, float(progress)))
        previous = self._last_progress.get(stage, -1.0)
        if not force and value < 1.0 and value - previous < 0.02:
            return
        self._last_progress[stage] = value
        start, end = STAGE_PROGRESS_WINDOWS[stage]
        payload: dict[str, Any] = {
            "event": "progress",
            "stage": stage,
            "progress": round(value, 4),
            "overallProgress": round(start + (end - start) * value, 4),
        }
        if current is not None:
            payload["current"] = current
        if total is not None:
            payload["total"] = total
        if message:
            payload["message"] = message
        if cache_hit:
            payload["cacheHit"] = True
        self._emit(payload)

    def completed(self, result_path: Path) -> None:
        self._emit(
            {
                "event": "completed",
                "progress": 1.0,
                "overallProgress": 1.0,
                "resultPath": str(result_path.resolve()),
            }
        )

    def failed(self, code: str, message: str) -> None:
        self._emit(
            {
                "event": "failed",
                "stage": self.current_stage,
                "code": code,
                "message": sanitize_error_message(message),
            }
        )


@dataclass(frozen=True)
class WordToken:
    text: str
    start_ms: int
    end_ms: int
    probability: float = 1.0


@dataclass(frozen=True)
class MatchCandidate:
    line_index: int
    token_start: int
    token_end: int
    audio_time_ms: int
    confidence: float
    whisper_text: str


def sanitize_error_message(message: str, limit: int = 300) -> str:
    compact = " ".join(str(message).split()) or "Automatic sync process failed"
    return compact[:limit]


def classify_failure(error: BaseException, stage: str) -> str:
    if isinstance(error, AutoSyncFailure):
        return error.code
    message = str(error).lower()
    if isinstance(error, (ModuleNotFoundError, ImportError)) or "no module named" in message:
        return "package"
    if (
        isinstance(error, MemoryError)
        or "out of memory" in message
        or "cuda_error_out_of_memory" in message
    ):
        return "oom"
    if "cuda" in message or "cublas" in message or "cudnn" in message:
        return "cuda"
    if "ffmpeg" in message or "ffprobe" in message:
        return "ffmpeg"
    if any(
        value in message
        for value in (
            "checkpoint",
            "model.bin",
            ".ckpt",
            "tokenizer.json",
            "vocabulary.json",
            "hugging face",
            "huggingface",
        )
    ):
        return "model"
    if stage in {"separating", "releasing-separator"}:
        return "separation"
    if stage == "transcribing":
        return "transcription"
    if stage in {"matching", "building-anchors"}:
        return "matching"
    if isinstance(error, OSError):
        return "process"
    if stage == "validating":
        return "profile"
    return "process"


def validate_cache_key(value: str | None) -> str | None:
    if value is None:
        return None
    if not CACHE_KEY.fullmatch(value):
        raise AutoSyncFailure("process", "Cache key must be 64 lowercase hexadecimal characters")
    return value


def cleanup_cache_temporary_files(directory: Path) -> None:
    if not directory.is_dir():
        return
    for path in directory.glob(".*.tmp"):
        if path.is_file():
            _discard_invalid_cache_file(path)


def atomic_write_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def atomic_write_json(path: Path, payload: Any) -> None:
    atomic_write_text(
        path,
        json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
    )


def atomic_copy_file(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
    )
    os.close(descriptor)
    temporary_path = Path(temporary_name)
    try:
        shutil.copyfile(source, temporary_path)
        os.replace(temporary_path, destination)
    finally:
        temporary_path.unlink(missing_ok=True)


def _discard_invalid_cache_file(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def load_cached_vocal(path: Path) -> Path | None:
    try:
        if path.is_file() and path.stat().st_size > 0:
            return path
    except OSError:
        pass
    if path.exists():
        _discard_invalid_cache_file(path)
    return None


def load_cached_tokens(path: Path) -> list[WordToken] | None:
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("version") != 1 or not isinstance(payload.get("tokens"), list):
            raise ValueError("Unsupported token cache")
        tokens: list[WordToken] = []
        for item in payload["tokens"]:
            if not isinstance(item, dict):
                raise ValueError("Invalid cached token")
            text = item.get("text")
            start_ms = item.get("start_ms")
            end_ms = item.get("end_ms")
            probability = item.get("probability")
            if (
                not isinstance(text, str)
                or not text
                or isinstance(start_ms, bool)
                or not isinstance(start_ms, int)
                or isinstance(end_ms, bool)
                or not isinstance(end_ms, int)
                or start_ms < 0
                or end_ms < start_ms
                or isinstance(probability, bool)
                or not isinstance(probability, (int, float))
                or not math.isfinite(float(probability))
                or not 0 <= float(probability) <= 1
            ):
                raise ValueError("Invalid cached token")
            tokens.append(WordToken(text, start_ms, end_ms, float(probability)))
        return tokens
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        _discard_invalid_cache_file(path)
        return None


def write_cached_tokens(path: Path, tokens: list[WordToken]) -> None:
    atomic_write_json(path, {"version": 1, "tokens": [asdict(token) for token in tokens]})


class GpuMonitor:
    def __init__(self) -> None:
        self.baseline_mib = self._read_used_mib()
        self.peaks: dict[str, int] = {}
        self.phase = "setup"
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._sample, daemon=True)

    @staticmethod
    def _read_used_mib() -> int:
        try:
            output = subprocess.check_output(
                [
                    "nvidia-smi",
                    "--query-gpu=memory.used",
                    "--format=csv,noheader,nounits",
                ],
                text=True,
                timeout=3,
            )
            return max(int(float(line.strip())) for line in output.splitlines() if line.strip())
        except (OSError, ValueError, subprocess.SubprocessError):
            return 0

    def set_phase(self, phase: str) -> None:
        self.phase = phase
        self.peaks.setdefault(phase, self._read_used_mib())

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> dict[str, Any]:
        self._stop.set()
        self._thread.join(timeout=3)
        peak = max(self.peaks.values(), default=self.baseline_mib)
        return {
            "baselineMiB": self.baseline_mib,
            "peakMiB": peak,
            "peakIncrementMiB": max(0, peak - self.baseline_mib),
            "phasePeaksMiB": self.peaks,
        }

    def _sample(self) -> None:
        while not self._stop.wait(0.25):
            used = self._read_used_mib()
            self.peaks[self.phase] = max(self.peaks.get(self.phase, 0), used)


def normalize_text(value: str) -> str:
    value = LRC_TIMESTAMP.sub("", value)
    value = unicodedata.normalize("NFKC", value).lower()
    # Whisper commonly mixes katakana and hiragana. Comparing in hiragana avoids
    # penalizing that orthographic difference while preserving Japanese order.
    value = "".join(
        chr(ord(char) - 0x60) if "ァ" <= char <= "ヶ" else char for char in value
    )
    return "".join(char for char in value if char.isalnum() or "ぁ" <= char <= "ん")


def split_plain_lyrics(value: str | list[str]) -> list[str]:
    lines = value if isinstance(value, list) else value.splitlines()
    return [
        LRC_TIMESTAMP.sub("", line).strip()
        for line in lines
        if LRC_TIMESTAMP.sub("", line).strip()
    ]


def parse_synced_lyrics(value: str | None) -> list[tuple[int, str]]:
    if not value:
        return []
    parsed: list[tuple[int, str]] = []
    for line in value.splitlines():
        match = LRC_TIMESTAMP.search(line)
        if not match:
            continue
        minutes = int(match.group(1))
        seconds = float(match.group(2).replace(":", "."))
        parsed.append((round((minutes * 60 + seconds) * 1000), LRC_TIMESTAMP.sub("", line).strip()))
    return parsed


def map_original_times(lines: list[str], synced: list[tuple[int, str]]) -> list[int | None]:
    if len(lines) == len(synced):
        # Equal line counts alone do not prove that plain and timed lyrics are
        # the same edition. Keep the original timestamp only when the line text
        # is recognizably related, otherwise let matching reject that line.
        return [
            time_ms
            if fuzz.ratio(normalize_text(line), normalize_text(synced_text)) / 100
            >= 0.55
            else None
            for line, (time_ms, synced_text) in zip(lines, synced, strict=True)
        ]
    times: list[int | None] = [None] * len(lines)
    cursor = 0
    for line_index, line in enumerate(lines):
        target = normalize_text(line)
        best: tuple[float, int] | None = None
        for synced_index in range(cursor, min(len(synced), cursor + 8)):
            score = fuzz.ratio(target, normalize_text(synced[synced_index][1])) / 100
            if best is None or score > best[0]:
                best = (score, synced_index)
        if best and best[0] >= 0.55:
            times[line_index] = synced[best[1]][0]
            cursor = best[1] + 1
    return times


def build_match_candidates(
    lines: list[str],
    tokens: list[WordToken],
    confidence_threshold: float,
    progress_callback: Callable[[int, int], None] | None = None,
) -> list[MatchCandidate]:
    candidates: list[MatchCandidate] = []
    normalized_tokens = [normalize_text(token.text) for token in tokens]
    for line_index, line in enumerate(lines):
        target = normalize_text(line)
        if not target:
            if progress_callback:
                progress_callback(line_index + 1, len(lines))
            continue
        per_start: list[MatchCandidate] = []
        for start in range(len(tokens)):
            combined = ""
            best: MatchCandidate | None = None
            probabilities: list[float] = []
            for end in range(start, min(len(tokens), start + 20)):
                combined += normalized_tokens[end]
                probabilities.append(max(0.0, min(1.0, tokens[end].probability)))
                if len(combined) < max(1, math.floor(len(target) * 0.35)):
                    continue
                direct = fuzz.ratio(target, combined) / 100
                weighted = fuzz.WRatio(target, combined) / 100
                text_score = direct * 0.75 + weighted * 0.25
                probability = statistics.fmean(probabilities)
                confidence = text_score * (0.88 + probability * 0.12)
                candidate = MatchCandidate(
                    line_index=line_index,
                    token_start=start,
                    token_end=end + 1,
                    audio_time_ms=tokens[start].start_ms,
                    confidence=confidence,
                    whisper_text="".join(token.text for token in tokens[start : end + 1]).strip(),
                )
                if best is None or candidate.confidence > best.confidence:
                    best = candidate
                if len(combined) > len(target) * 2.2 + 8:
                    break
            if best and best.confidence >= confidence_threshold:
                per_start.append(best)
        # Keeping several locations is important for repeated choruses; global
        # sequence matching below chooses the earliest compatible occurrence.
        candidates.extend(sorted(per_start, key=lambda item: item.confidence, reverse=True)[:40])
        if progress_callback:
            progress_callback(line_index + 1, len(lines))
    return candidates


def choose_ordered_matches(
    candidates: list[MatchCandidate],
    progress_callback: Callable[[int, int], None] | None = None,
) -> list[MatchCandidate]:
    nodes = sorted(candidates, key=lambda item: (item.line_index, item.token_end, item.token_start))
    if not nodes:
        return []
    scores = [candidate.confidence - 0.35 for candidate in nodes]
    previous: list[int | None] = [None] * len(nodes)
    for index, candidate in enumerate(nodes):
        for prior_index in range(index):
            prior = nodes[prior_index]
            if prior.line_index >= candidate.line_index or prior.token_end > candidate.token_start:
                continue
            score = scores[prior_index] + candidate.confidence - 0.35
            if score > scores[index]:
                scores[index] = score
                previous[index] = prior_index
        if progress_callback:
            progress_callback(index + 1, len(nodes))
    cursor: int | None = max(range(len(nodes)), key=scores.__getitem__)
    selected: list[MatchCandidate] = []
    while cursor is not None:
        selected.append(nodes[cursor])
        cursor = previous[cursor]
    return list(reversed(selected))


def adjust_time(original_ms: int, anchors: list[dict[str, int]]) -> int:
    if not anchors:
        return original_ms
    if len(anchors) == 1:
        anchor = anchors[0]
        return max(0, original_ms + anchor["audioTimeMs"] - anchor["lyricTimeMs"])
    ordered = sorted(anchors, key=lambda item: item["lyricTimeMs"])
    left, right = ordered[0], ordered[1]
    if original_ms >= ordered[-1]["lyricTimeMs"]:
        left, right = ordered[-2], ordered[-1]
    else:
        for index in range(1, len(ordered)):
            if original_ms <= ordered[index]["lyricTimeMs"]:
                left, right = ordered[index - 1], ordered[index]
                break
    lyric_delta = right["lyricTimeMs"] - left["lyricTimeMs"]
    if lyric_delta <= 0:
        return original_ms
    slope = (right["audioTimeMs"] - left["audioTimeMs"]) / lyric_delta
    return max(0, round(left["audioTimeMs"] + (original_ms - left["lyricTimeMs"]) * slope))


def comparison_metrics(anchors: list[dict[str, Any]]) -> dict[str, int | None]:
    if not anchors:
        return {"beforeMedianAbsErrorMs": None, "afterLeaveOneOutMedianAbsErrorMs": None}
    before = [abs(anchor["audioTimeMs"] - anchor["lyricTimeMs"]) for anchor in anchors]
    after: list[int] = []
    if len(anchors) >= 3:
        for index, anchor in enumerate(anchors):
            training = [
                {"lyricTimeMs": item["lyricTimeMs"], "audioTimeMs": item["audioTimeMs"]}
                for other_index, item in enumerate(anchors)
                if other_index != index
            ]
            after.append(abs(adjust_time(anchor["lyricTimeMs"], training) - anchor["audioTimeMs"]))
    return {
        "beforeMedianAbsErrorMs": round(statistics.median(before)),
        "afterLeaveOneOutMedianAbsErrorMs": round(statistics.median(after)) if after else None,
    }


def filter_temporal_outliers(
    anchors: list[dict[str, Any]], max_local_deviation_ms: int = 1500
) -> tuple[list[dict[str, Any]], list[int]]:
    if len(anchors) < 5:
        return anchors, []
    ordered = sorted(anchors, key=lambda item: item["lineIndex"])
    kept: list[dict[str, Any]] = []
    removed: list[int] = []
    for index, anchor in enumerate(ordered):
        if index < 2 or index + 2 >= len(ordered):
            kept.append(anchor)
            continue
        neighbors = ordered[index - 2 : index] + ordered[index + 1 : index + 3]
        local_delta = statistics.median(
            item["audioTimeMs"] - item["lyricTimeMs"] for item in neighbors
        )
        delta = anchor["audioTimeMs"] - anchor["lyricTimeMs"]
        if abs(delta - local_delta) > max_local_deviation_ms:
            removed.append(anchor["lineIndex"])
        else:
            kept.append(anchor)
    return kept, removed


def separate_vocals(
    audio_path: Path,
    temp_dir: Path,
    model_dir: Path,
    release_callback: Callable[[], None] | None = None,
) -> Path:
    checkpoint = model_dir / MODEL_FILENAME
    model_config = checkpoint.with_suffix(".yaml")
    if not checkpoint.is_file() or not model_config.is_file():
        raise AutoSyncFailure(
            "separator-model",
            f"Local BS-RoFormer model cache is missing or incomplete: {MODEL_FILENAME}",
        )
    from audio_separator.separator import Separator

    separator = Separator(
        output_dir=str(temp_dir),
        output_format="WAV",
        model_file_dir=str(model_dir),
        output_single_stem="Vocals",
        use_autocast=True,
        mdxc_params={
            "segment_size": 256,
            "override_model_segment_size": False,
            "batch_size": 1,
            "overlap": 8,
            "pitch_shift": 0,
        },
    )
    separator.load_model(MODEL_FILENAME)
    outputs = separator.separate(str(audio_path))
    paths = [
        Path(output) if Path(output).is_absolute() else temp_dir / output
        for output in outputs
    ]
    vocal = next((path for path in paths if "vocal" in path.name.lower()), None)
    if vocal is None or not vocal.exists():
        raise RuntimeError(f"BS-RoFormer did not produce a vocal stem: {outputs}")
    if release_callback:
        release_callback()
    del separator
    gc.collect()
    try:
        import torch

        torch.cuda.empty_cache()
    except (ImportError, RuntimeError):
        pass
    return vocal


def find_local_whisper_model(model_name: str, cache_dir: Path) -> Path:
    if model_name == "large-v3":
        snapshots = cache_dir / "models--Systran--faster-whisper-large-v3" / "snapshots"
        local_snapshot = next(
            (
                path
                for path in sorted(snapshots.glob("*"))
                if path.is_dir()
                and all((path / file_name).is_file() for file_name in WHISPER_REQUIRED_FILES)
            ),
            None,
        )
        if local_snapshot is not None:
            return local_snapshot.resolve()
    else:
        local_path = Path(model_name).expanduser()
        if local_path.is_dir() and all(
            (local_path / file_name).is_file() for file_name in WHISPER_REQUIRED_FILES
        ):
            return local_path.resolve()
    raise AutoSyncFailure(
        "whisper-model",
        f"Local faster-whisper model cache is missing or incomplete: {model_name}",
    )


def load_whisper_model(model_name: str, cache_dir: Path):
    model_reference = find_local_whisper_model(model_name, cache_dir)
    from faster_whisper import WhisperModel

    return WhisperModel(
        str(model_reference),
        device="cuda",
        compute_type="float16",
        download_root=str(cache_dir),
        local_files_only=True,
    )


def transcribe_with_model(
    model,
    audio_path: Path,
    hotwords: str | None,
) -> list[WordToken]:
    segments, _ = model.transcribe(
        str(audio_path),
        language="ja",
        beam_size=5,
        temperature=0.0,
        condition_on_previous_text=False,
        repetition_penalty=1.15,
        no_repeat_ngram_size=3,
        hallucination_silence_threshold=2.0,
        hotwords=hotwords[:4_000] if hotwords else None,
        word_timestamps=True,
        vad_filter=False,
    )
    tokens: list[WordToken] = []
    for segment in segments:
        words = segment.words or []
        if words:
            for word in words:
                if word.start is None or word.end is None or not normalize_text(word.word):
                    continue
                tokens.append(
                    WordToken(
                        text=word.word,
                        start_ms=round(word.start * 1000),
                        end_ms=round(word.end * 1000),
                        probability=float(word.probability or 0),
                    )
                )
        elif normalize_text(segment.text):
            tokens.append(
                WordToken(segment.text, round(segment.start * 1000), round(segment.end * 1000), 0.5)
            )
    return tokens


def transcribe_vocals(
    vocal_path: Path,
    model_name: str,
    cache_dir: Path,
    known_lines: list[str],
) -> list[WordToken]:
    model = load_whisper_model(model_name, cache_dir)
    try:
        return transcribe_with_model(model, vocal_path, " ".join(known_lines))
    finally:
        del model


def load_input(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    required = {"trackId", "audioPath", "plainLyrics", "syncedLyrics"}
    missing = sorted(required - payload.keys())
    if missing:
        raise ValueError(f"Missing input fields: {', '.join(missing)}")
    return payload


def validate_pipeline_result(result: dict[str, Any]) -> None:
    track_id = result.get("trackId")
    # The standalone evaluation runner uses human-readable case IDs. The Electron
    # service independently enforces the app's 64-character track IDs before a
    # result can reach preview or persistence.
    if not isinstance(track_id, str) or not track_id or len(track_id) > 500:
        raise AutoSyncFailure("profile", "Result trackId is invalid")
    matched_lines = result.get("matchedLines")
    total_lines = result.get("totalLines")
    anchors = result.get("anchors")
    profile = result.get("lyricsSyncProfile")
    if (
        isinstance(matched_lines, bool)
        or not isinstance(matched_lines, int)
        or isinstance(total_lines, bool)
        or not isinstance(total_lines, int)
        or not isinstance(anchors, list)
        or not isinstance(profile, dict)
        or total_lines < 2
        or matched_lines < 0
        or matched_lines > total_lines
    ):
        raise AutoSyncFailure("profile", "Result line counts are invalid")
    compatible = profile.get("anchors")
    if (
        profile.get("trackId") != track_id
        or profile.get("offsetMs") != 0
        or profile.get("updatedAt") != 0
        or not isinstance(compatible, list)
        or len(anchors) != matched_lines
        or len(compatible) != matched_lines
        or len(compatible) > 100
    ):
        raise AutoSyncFailure("profile", "Result profile shape is invalid")
    previous_lyric = -1
    previous_audio = -1
    for index, anchor in enumerate(compatible):
        if not isinstance(anchor, dict) or set(anchor) != {"lyricTimeMs", "audioTimeMs"}:
            raise AutoSyncFailure("profile", "Result profile anchor shape is invalid")
        lyric_time = anchor.get("lyricTimeMs")
        audio_time = anchor.get("audioTimeMs")
        if (
            isinstance(lyric_time, bool)
            or not isinstance(lyric_time, int)
            or isinstance(audio_time, bool)
            or not isinstance(audio_time, int)
            or lyric_time < 0
            or audio_time < 0
            or lyric_time <= previous_lyric
            or audio_time <= previous_audio
        ):
            raise AutoSyncFailure("profile", "Result anchors are not strictly chronological")
        detailed = anchors[index]
        if (
            not isinstance(detailed, dict)
            or detailed.get("lyricTimeMs") != lyric_time
            or detailed.get("audioTimeMs") != audio_time
        ):
            raise AutoSyncFailure("profile", "Detailed and compatible anchors do not match")
        previous_lyric = lyric_time
        previous_audio = audio_time
    unmatched = result.get("unmatchedLines")
    if (
        not isinstance(unmatched, list)
        or any(isinstance(index, bool) or not isinstance(index, int) for index in unmatched)
        or any(index < 0 or index >= total_lines for index in unmatched)
        or len(unmatched) != len(set(unmatched))
        or matched_lines + len(unmatched) != total_lines
    ):
        raise AutoSyncFailure("profile", "Result unmatched line indices are invalid")


def run_pipeline(
    payload: dict[str, Any],
    workspace: Path,
    *,
    event_emitter: JsonEventEmitter | None = None,
    temp_root: Path | None = None,
    cache_key: str | None = None,
    emit_preparing: bool = True,
) -> dict[str, Any]:
    emitter = event_emitter or JsonEventEmitter()
    if emit_preparing:
        emitter.stage("preparing", indeterminate=True)
    started = time.perf_counter()
    if fuzz is None:
        raise AutoSyncFailure("package", "Missing required Python package: rapidfuzz")
    track_id = payload.get("trackId")
    if not isinstance(track_id, str) or not CACHE_KEY.fullmatch(track_id):
        raise AutoSyncFailure("profile", "trackId must be 64 lowercase hexadecimal characters")
    audio_path = Path(payload["audioPath"]).resolve()
    if not audio_path.is_file():
        raise AutoSyncFailure("audio", "Audio file does not exist")
    lines = split_plain_lyrics(payload["plainLyrics"])
    if len(lines) < 2:
        raise AutoSyncFailure("matching", "At least two non-empty plain lyric lines are required")
    synced = parse_synced_lyrics(payload.get("syncedLyrics"))
    original_times = map_original_times(lines, synced)
    if not any(time_ms is not None for time_ms in original_times):
        raise AutoSyncFailure(
            "profile", "Existing synced lyrics are required to produce lyricTimeMs anchors"
        )
    settings = payload.get("settings", {})
    threshold = float(settings.get("confidenceThreshold", 0.66))
    if not math.isfinite(threshold) or not 0 <= threshold <= 1:
        raise AutoSyncFailure("matching", "Confidence threshold must be between zero and one")
    model_name = str(settings.get("whisperModel", "large-v3"))
    validated_cache_key = validate_cache_key(cache_key)
    cache_root = workspace / ".poc-cache"
    working_temp_root = (temp_root or (workspace / ".poc-tmp")).resolve()
    working_temp_root.mkdir(parents=True, exist_ok=True)
    intermediate_cache = (
        cache_root / "auto-sync" / validated_cache_key if validated_cache_key else None
    )
    if intermediate_cache:
        cleanup_cache_temporary_files(intermediate_cache)
    cached_vocal_path = intermediate_cache / "vocals.wav" if intermediate_cache else None
    cached_tokens_path = intermediate_cache / "tokens.json" if intermediate_cache else None
    cached_tokens = load_cached_tokens(cached_tokens_path) if cached_tokens_path else None
    cached_vocal = load_cached_vocal(cached_vocal_path) if cached_vocal_path else None
    monitor = GpuMonitor()
    monitor.start()
    durations: dict[str, float] = {
        "vocalSeparationSeconds": 0.0,
        "whisperSeconds": 0.0,
    }
    try:
        with tempfile.TemporaryDirectory(
            prefix="auto-sync-", dir=working_temp_root
        ) as directory:
            temp_dir = Path(directory)
            monitor.set_phase("vocalSeparation")
            if cached_tokens is not None:
                emitter.stage(
                    "separating",
                    message="Cache hit: completed transcription; vocal separation skipped",
                    cache_hit=True,
                    indeterminate=False,
                )
                emitter.progress(
                    "separating", 1.0, message="Cached transcription", cache_hit=True, force=True
                )
                emitter.stage(
                    "releasing-separator",
                    message="Cache hit: separator model was not loaded",
                    cache_hit=True,
                    indeterminate=False,
                )
                emitter.progress(
                    "releasing-separator", 1.0, cache_hit=True, force=True
                )
                vocal_path: Path | None = None
            else:
                if cached_vocal:
                    emitter.stage(
                        "separating",
                        message="Cache hit: using completed vocal stem",
                        cache_hit=True,
                        indeterminate=False,
                    )
                    emitter.progress(
                        "separating", 1.0, message="Cached vocal stem", cache_hit=True, force=True
                    )
                    emitter.stage(
                        "releasing-separator",
                        message="Cache hit: separator model was not loaded",
                        cache_hit=True,
                        indeterminate=False,
                    )
                    emitter.progress(
                        "releasing-separator", 1.0, cache_hit=True, force=True
                    )
                    vocal_path = cached_vocal
                else:
                    emitter.stage("separating", indeterminate=True)
                    stage = time.perf_counter()
                    released = False

                    def release_separator() -> None:
                        nonlocal released
                        emitter.progress("separating", 1.0, force=True)
                        emitter.stage("releasing-separator", indeterminate=True)
                        released = True

                    vocal_path = separate_vocals(
                        audio_path,
                        temp_dir,
                        cache_root / "models",
                        release_callback=release_separator,
                    )
                    durations["vocalSeparationSeconds"] = round(
                        time.perf_counter() - stage, 3
                    )
                    if not released:
                        emitter.progress("separating", 1.0, force=True)
                        emitter.stage("releasing-separator", indeterminate=True)
                    emitter.progress("releasing-separator", 1.0, force=True)
                    if cached_vocal_path:
                        try:
                            atomic_copy_file(vocal_path, cached_vocal_path)
                        except (OSError, ValueError, TypeError) as error:
                            print(
                                f"Vocal cache write skipped: {error}",
                                file=sys.stderr,
                                flush=True,
                            )
            monitor.set_phase("whisper")
            if cached_tokens is not None:
                emitter.stage(
                    "transcribing",
                    message="Cache hit: using completed Whisper tokens",
                    cache_hit=True,
                    indeterminate=False,
                )
                emitter.progress(
                    "transcribing", 1.0, message="Cached Whisper tokens", cache_hit=True, force=True
                )
                tokens = cached_tokens
            else:
                if vocal_path is None:
                    raise AutoSyncFailure("transcription", "No vocal source is available")
                emitter.stage("transcribing", indeterminate=True)
                stage = time.perf_counter()
                tokens = transcribe_vocals(
                    vocal_path,
                    model_name,
                    cache_root / "whisper",
                    lines,
                )
                durations["whisperSeconds"] = round(time.perf_counter() - stage, 3)
                emitter.progress("transcribing", 1.0, force=True)
                if cached_tokens_path:
                    try:
                        write_cached_tokens(cached_tokens_path, tokens)
                    except (OSError, ValueError, TypeError) as error:
                        print(f"Token cache write skipped: {error}", file=sys.stderr, flush=True)
            monitor.set_phase("matching")
            emitter.stage("matching", indeterminate=False)
            stage = time.perf_counter()

            def candidate_progress(current: int, total: int) -> None:
                emitter.progress(
                    "matching",
                    0.6 * current / max(1, total),
                    current=current,
                    total=total,
                )

            all_candidates = build_match_candidates(
                lines, tokens, 0.0, progress_callback=candidate_progress
            )
            candidates = [
                candidate
                for candidate in all_candidates
                if candidate.confidence >= threshold
            ]

            def ordered_progress(current: int, total: int) -> None:
                emitter.progress(
                    "matching",
                    0.6 + 0.4 * current / max(1, total),
                    current=current,
                    total=total,
                )

            matches = choose_ordered_matches(candidates, progress_callback=ordered_progress)
            if not candidates:
                emitter.progress("matching", 1.0, force=True)
            durations["matchingSeconds"] = round(time.perf_counter() - stage, 3)
    finally:
        gpu = monitor.stop()
        # TemporaryDirectory removes stems on normal and exceptional unwinds.
        # The service still removes its job root after forcibly terminating a worker.
        try:
            if working_temp_root.exists() and not any(working_temp_root.iterdir()):
                working_temp_root.rmdir()
        except OSError:
            pass

    emitter.stage("building-anchors", indeterminate=False)
    anchors: list[dict[str, Any]] = []
    for match_index, match in enumerate(matches):
        lyric_time = original_times[match.line_index]
        if lyric_time is not None:
            anchors.append(
                {
                    "lineIndex": match.line_index,
                    "lyricTimeMs": lyric_time,
                    "audioTimeMs": match.audio_time_ms,
                    "confidence": round(match.confidence, 4),
                    "whisperText": match.whisper_text,
                }
            )
        emitter.progress(
            "building-anchors",
            (match_index + 1) / max(1, len(matches)),
            current=match_index + 1,
            total=len(matches),
        )
    if not matches:
        emitter.progress(
            "building-anchors", 1.0, current=0, total=0, force=True
        )
    anchors, temporal_outlier_lines = filter_temporal_outliers(anchors)
    matched_indices = {anchor["lineIndex"] for anchor in anchors}
    compatible_anchors = [
        {"lyricTimeMs": anchor["lyricTimeMs"], "audioTimeMs": anchor["audioTimeMs"]}
        for anchor in anchors
    ]
    confidence = statistics.fmean(anchor["confidence"] for anchor in anchors) if anchors else 0.0
    best_by_line = {
        line_index: max(
            (
                candidate.confidence
                for candidate in all_candidates
                if candidate.line_index == line_index
            ),
            default=0.0,
        )
        for line_index in range(len(lines))
    }
    result = {
        "trackId": payload["trackId"],
        "model": {"separator": MODEL_FILENAME, "whisper": model_name},
        "matchedLines": len(anchors),
        "totalLines": len(lines),
        "confidence": round(confidence, 4),
        "anchors": anchors,
        "unmatchedLines": [index for index in range(len(lines)) if index not in matched_indices],
        "lyricsSyncProfile": {
            "trackId": payload["trackId"],
            "offsetMs": 0,
            "anchors": compatible_anchors,
            "updatedAt": 0,
        },
        "comparison": comparison_metrics(anchors),
        "diagnostics": {
            "whisperTokens": [asdict(token) for token in tokens],
            "bestConfidenceByLine": [round(best_by_line[index], 4) for index in range(len(lines))],
            "temporalOutlierLines": temporal_outlier_lines,
        },
        "metrics": {
            **durations,
            "totalSeconds": round(time.perf_counter() - started, 3),
            "whisperTokens": len(tokens),
            "gpuMemory": gpu,
        },
    }
    emitter.stage("validating", indeterminate=True)
    validate_pipeline_result(result)
    emitter.progress("validating", 1.0, force=True)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Standalone Pulse Shelf automatic lyrics sync PoC")
    parser.add_argument(
        "--input", type=Path, required=True, help="Input JSON matching input.schema.json"
    )
    parser.add_argument("--output", type=Path, required=True, help="Result JSON path")
    parser.add_argument("--workspace", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument(
        "--json-events",
        action="store_true",
        help="Emit machine-readable JSON Lines events instead of the pretty result",
    )
    parser.add_argument(
        "--temp-root",
        type=Path,
        help="Service-owned directory under which the worker creates its temporary stem",
    )
    parser.add_argument(
        "--cache-key",
        help="64-character lowercase hexadecimal key for completed vocal/token reuse",
    )
    args = parser.parse_args()
    emitter = JsonEventEmitter(args.json_events, sys.stdout)
    try:
        emitter.stage("preparing", indeterminate=True)
        stdout_context = (
            contextlib.redirect_stdout(sys.stderr)
            if args.json_events
            else contextlib.nullcontext()
        )
        with stdout_context:
            result = run_pipeline(
                load_input(args.input),
                args.workspace.resolve(),
                event_emitter=emitter,
                temp_root=args.temp_root.resolve() if args.temp_root else None,
                cache_key=args.cache_key,
                emit_preparing=False,
            )
            atomic_write_json(args.output, result)
        if args.json_events:
            emitter.completed(args.output)
        else:
            print(json.dumps(result, ensure_ascii=True, indent=2))
        return 0
    except (Exception, KeyboardInterrupt) as error:
        emitter.failed(classify_failure(error, emitter.current_stage), str(error))
        traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
