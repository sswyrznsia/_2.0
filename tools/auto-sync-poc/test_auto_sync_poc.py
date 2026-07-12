import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import auto_sync_poc

from auto_sync_poc import (
    AutoSyncFailure,
    JsonEventEmitter,
    WordToken,
    adjust_time,
    atomic_write_json,
    build_match_candidates,
    classify_failure,
    cleanup_cache_temporary_files,
    choose_ordered_matches,
    filter_temporal_outliers,
    find_local_whisper_model,
    load_cached_tokens,
    map_original_times,
    normalize_text,
    parse_synced_lyrics,
    run_pipeline,
    separate_vocals,
    split_plain_lyrics,
    validate_cache_key,
    validate_pipeline_result,
    write_cached_tokens,
)


class FlushRecordingStream(io.StringIO):
    def __init__(self):
        super().__init__()
        self.flush_count = 0

    def flush(self):
        self.flush_count += 1
        super().flush()


class FakeGpuMonitor:
    def __init__(self):
        self.phase = "setup"

    def set_phase(self, phase):
        self.phase = phase

    def start(self):
        pass

    def stop(self):
        return {
            "baselineMiB": 0,
            "peakMiB": 0,
            "peakIncrementMiB": 0,
            "phasePeaksMiB": {self.phase: 0},
        }


class AutoSyncPocTests(unittest.TestCase):
    @staticmethod
    def payload(audio_path):
        return {
            "trackId": "a" * 64,
            "audioPath": str(audio_path),
            "plainLyrics": ["青い空", "夜の星"],
            "syncedLyrics": "[00:01.00]青い空\n[00:02.00]夜の星",
        }

    @staticmethod
    def fake_separate(_audio_path, temp_dir, _model_dir, release_callback=None):
        vocal = temp_dir / "mock-vocals.wav"
        vocal.write_bytes(b"RIFF mock vocal")
        if release_callback:
            release_callback()
        return vocal

    @staticmethod
    def fake_transcribe(_vocal_path, _model_name, _cache_dir, _known_lines):
        return [
            WordToken("青い空", 1200, 1700, 0.95),
            WordToken("夜の星", 2200, 2700, 0.96),
        ]

    def test_normalizes_japanese_script_and_lrc_timestamp(self):
        self.assertEqual(normalize_text("[00:12.40] アオイ、空!"), "あおい空")

    def test_maps_plain_lines_to_original_times(self):
        lines = split_plain_lyrics("青い空\n夜の星")
        synced = parse_synced_lyrics("[00:10.00]青い空\n[00:20.50]夜の星")
        self.assertEqual(map_original_times(lines, synced), [10000, 20500])

    def test_equal_length_different_lyrics_do_not_borrow_timestamps(self):
        lines = ["青い空", "夜の星"]
        synced = parse_synced_lyrics("[00:10.00]赤い海\n[00:20.00]朝の風")
        self.assertEqual(map_original_times(lines, synced), [None, None])

    def test_whisper_cache_requires_one_complete_local_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            snapshots = (
                cache
                / "models--Systran--faster-whisper-large-v3"
                / "snapshots"
            )
            incomplete = snapshots / "000-incomplete"
            complete = snapshots / "111-complete"
            incomplete.mkdir(parents=True)
            complete.mkdir()
            (incomplete / "model.bin").write_bytes(b"incomplete")
            for file_name in auto_sync_poc.WHISPER_REQUIRED_FILES:
                (complete / file_name).write_bytes(b"ready")
            self.assertEqual(
                find_local_whisper_model("large-v3", cache),
                complete.resolve(),
            )

    def test_whisper_model_never_falls_back_to_download(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(
                AutoSyncFailure, "missing or incomplete"
            ) as raised:
                find_local_whisper_model("large-v3", Path(directory))
            self.assertEqual(raised.exception.code, "whisper-model")

    def test_separator_never_falls_back_to_model_download(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(
                AutoSyncFailure, "missing or incomplete"
            ) as raised:
                separate_vocals(root / "audio.wav", root / "temp", root / "models")
            self.assertEqual(raised.exception.code, "separator-model")

    def test_repeated_chorus_matches_in_forward_order(self):
        lines = ["青い空", "同じ歌", "夜の星", "同じ歌"]
        tokens = [
            WordToken("青い空", 12000, 13500, 0.95),
            WordToken("同じ歌", 18000, 19500, 0.94),
            WordToken("夜の星", 24000, 25500, 0.96),
            WordToken("同じ歌", 30000, 31500, 0.93),
        ]
        matches = choose_ordered_matches(build_match_candidates(lines, tokens, 0.66))
        self.assertEqual([match.line_index for match in matches], [0, 1, 2, 3])
        self.assertEqual([match.audio_time_ms for match in matches], [12000, 18000, 24000, 30000])

    def test_unrecognized_line_is_not_forced_into_anchor(self):
        lines = ["青い空", "認識されない長い歌詞"]
        tokens = [WordToken("青い空", 1000, 2000, 0.95)]
        matches = choose_ordered_matches(build_match_candidates(lines, tokens, 0.66))
        self.assertEqual([match.line_index for match in matches], [0])

    def test_piecewise_profile_uses_existing_anchor_shape(self):
        anchors = [
            {"lyricTimeMs": 10000, "audioTimeMs": 12000},
            {"lyricTimeMs": 20000, "audioTimeMs": 24000},
        ]
        self.assertEqual(adjust_time(15000, anchors), 18000)
        self.assertEqual(set(anchors[0]), {"lyricTimeMs", "audioTimeMs"})

    def test_evaluation_case_id_remains_compatible_with_pipeline_validation(self):
        result = {
            "trackId": "japanese-cover-01",
            "matchedLines": 2,
            "totalLines": 2,
            "anchors": [
                {"lineIndex": 0, "lyricTimeMs": 1000, "audioTimeMs": 1200},
                {"lineIndex": 1, "lyricTimeMs": 2000, "audioTimeMs": 2300},
            ],
            "unmatchedLines": [],
            "lyricsSyncProfile": {
                "trackId": "japanese-cover-01",
                "offsetMs": 0,
                "anchors": [
                    {"lyricTimeMs": 1000, "audioTimeMs": 1200},
                    {"lyricTimeMs": 2000, "audioTimeMs": 2300},
                ],
                "updatedAt": 0,
            },
        }
        validate_pipeline_result(result)

    def test_rejects_isolated_temporal_outlier(self):
        anchors = [
            {"lineIndex": 0, "lyricTimeMs": 10000, "audioTimeMs": 10100},
            {"lineIndex": 1, "lyricTimeMs": 20000, "audioTimeMs": 20100},
            {"lineIndex": 2, "lyricTimeMs": 30000, "audioTimeMs": 27000},
            {"lineIndex": 3, "lyricTimeMs": 40000, "audioTimeMs": 40150},
            {"lineIndex": 4, "lyricTimeMs": 50000, "audioTimeMs": 50200},
        ]
        filtered, removed = filter_temporal_outliers(anchors)
        self.assertEqual(removed, [2])
        self.assertEqual([anchor["lineIndex"] for anchor in filtered], [0, 1, 3, 4])

    def test_json_events_are_compact_one_line_objects_and_flush(self):
        stream = FlushRecordingStream()
        emitter = JsonEventEmitter(True, stream)
        emitter.stage("preparing")
        emitter.progress("matching", 0.5, current=1, total=2, force=True)
        emitter.completed(Path("result.json"))
        emitter.failed("process", "line one\nline two")

        lines = stream.getvalue().splitlines()
        payloads = [json.loads(line) for line in lines]
        self.assertEqual([item["event"] for item in payloads], [
            "stage", "progress", "completed", "failed"
        ])
        self.assertEqual(payloads[1]["stage"], "matching")
        self.assertEqual(payloads[3]["message"], "line one line two")
        self.assertEqual(stream.flush_count, 4)
        self.assertTrue(all("\n" not in line for line in lines))

    def test_json_event_cli_redirects_ordinary_stdout_and_omits_pretty_result(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "result.json"
            stdout = FlushRecordingStream()
            stderr = io.StringIO()

            def fake_pipeline(_payload, _workspace, **options):
                print("third-party ordinary log")
                options["event_emitter"].stage("matching", indeterminate=False)
                return {"worker": "result"}

            arguments = [
                "auto_sync_poc.py",
                "--input",
                str(root / "input.json"),
                "--output",
                str(output),
                "--workspace",
                str(root),
                "--json-events",
            ]
            with (
                patch.object(sys, "argv", arguments),
                patch.object(sys, "stdout", stdout),
                patch.object(sys, "stderr", stderr),
                patch.object(auto_sync_poc, "load_input", return_value={}),
                patch.object(auto_sync_poc, "run_pipeline", side_effect=fake_pipeline),
            ):
                self.assertEqual(auto_sync_poc.main(), 0)

            events = [json.loads(line) for line in stdout.getvalue().splitlines()]
            self.assertEqual(
                [event["event"] for event in events],
                ["stage", "stage", "completed"],
            )
            self.assertNotIn("third-party ordinary log", stdout.getvalue())
            self.assertIn("third-party ordinary log", stderr.getvalue())
            self.assertNotIn('"worker": "result"', stdout.getvalue())
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), {"worker": "result"})

    def test_atomic_json_write_replaces_target_without_partial_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "result.json"
            target.write_text('{"old":true}\n', encoding="utf-8")
            atomic_write_json(target, {"new": True})
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), {"new": True})
            self.assertEqual(list(root.glob(f".{target.name}.*.tmp")), [])

    def test_cache_key_and_token_cache_validation_cleanup(self):
        self.assertEqual(validate_cache_key("b" * 64), "b" * 64)
        with self.assertRaises(AutoSyncFailure):
            validate_cache_key("B" * 64)
        with tempfile.TemporaryDirectory() as directory:
            cache_path = Path(directory) / "tokens.json"
            expected = [WordToken("青", 100, 200, 0.9)]
            write_cached_tokens(cache_path, expected)
            self.assertEqual(load_cached_tokens(cache_path), expected)
            cache_path.write_text('{"version":1,"tokens":[{"text":"bad"}]}', encoding="utf-8")
            self.assertIsNone(load_cached_tokens(cache_path))
            self.assertFalse(cache_path.exists())
            orphan = Path(directory) / ".tokens.json.interrupted.tmp"
            orphan.write_text("partial", encoding="utf-8")
            cleanup_cache_temporary_files(Path(directory))
            self.assertFalse(orphan.exists())

    def test_pipeline_emits_ordered_stages_and_cleans_owned_temp_stem(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            audio = workspace / "song.wav"
            audio.write_bytes(b"mock audio")
            temp_root = workspace / "job-temp"
            stream = FlushRecordingStream()
            emitter = JsonEventEmitter(True, stream)
            with (
                patch.object(auto_sync_poc, "GpuMonitor", FakeGpuMonitor),
                patch.object(auto_sync_poc, "separate_vocals", self.fake_separate),
                patch.object(auto_sync_poc, "transcribe_vocals", self.fake_transcribe),
            ):
                result = run_pipeline(
                    self.payload(audio),
                    workspace,
                    event_emitter=emitter,
                    temp_root=temp_root,
                )
            events = [json.loads(line) for line in stream.getvalue().splitlines()]
            stages = [event["stage"] for event in events if event["event"] == "stage"]
            self.assertEqual(
                stages,
                [
                    "preparing",
                    "separating",
                    "releasing-separator",
                    "transcribing",
                    "matching",
                    "building-anchors",
                    "validating",
                ],
            )
            self.assertEqual(result["matchedLines"], 2)
            self.assertFalse(temp_root.exists())

    def test_pipeline_failure_still_cleans_temporary_vocal(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            audio = workspace / "song.wav"
            audio.write_bytes(b"mock audio")
            temp_root = workspace / "job-temp"

            def fail_transcription(*_args):
                raise RuntimeError("mock transcription failure")

            with (
                patch.object(auto_sync_poc, "GpuMonitor", FakeGpuMonitor),
                patch.object(auto_sync_poc, "separate_vocals", self.fake_separate),
                patch.object(auto_sync_poc, "transcribe_vocals", fail_transcription),
            ):
                with self.assertRaisesRegex(RuntimeError, "mock transcription failure"):
                    run_pipeline(self.payload(audio), workspace, temp_root=temp_root)
            self.assertFalse(temp_root.exists())

    def test_completed_token_cache_skips_both_gpu_stages_and_marks_hits(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            audio = workspace / "song.wav"
            audio.write_bytes(b"mock audio")
            cache_key = "c" * 64
            with (
                patch.object(auto_sync_poc, "GpuMonitor", FakeGpuMonitor),
                patch.object(auto_sync_poc, "separate_vocals", self.fake_separate),
                patch.object(auto_sync_poc, "transcribe_vocals", self.fake_transcribe),
            ):
                first = run_pipeline(
                    self.payload(audio), workspace, cache_key=cache_key
                )
            stream = FlushRecordingStream()
            emitter = JsonEventEmitter(True, stream)
            with (
                patch.object(auto_sync_poc, "GpuMonitor", FakeGpuMonitor),
                patch.object(
                    auto_sync_poc,
                    "separate_vocals",
                    side_effect=AssertionError("separator should be skipped"),
                ),
                patch.object(
                    auto_sync_poc,
                    "transcribe_vocals",
                    side_effect=AssertionError("Whisper should be skipped"),
                ),
            ):
                second = run_pipeline(
                    self.payload(audio),
                    workspace,
                    event_emitter=emitter,
                    cache_key=cache_key,
                )
            events = [json.loads(line) for line in stream.getvalue().splitlines()]
            cache_stages = [
                event for event in events if event["event"] == "stage" and event.get("cacheHit")
            ]
            self.assertEqual(
                [event["stage"] for event in cache_stages],
                ["separating", "releasing-separator", "transcribing"],
            )
            self.assertEqual(first["anchors"], second["anchors"])
            self.assertEqual(second["metrics"]["vocalSeparationSeconds"], 0.0)
            self.assertEqual(second["metrics"]["whisperSeconds"], 0.0)

    def test_failure_classifier_maps_oom_and_pipeline_stages(self):
        self.assertEqual(
            classify_failure(RuntimeError("CUDA out of memory"), "transcribing"), "oom"
        )
        self.assertEqual(
            classify_failure(RuntimeError("decoder failed"), "transcribing"),
            "transcription",
        )


if __name__ == "__main__":
    unittest.main()
