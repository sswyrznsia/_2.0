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
    MatchCandidate,
    WordToken,
    adjust_time,
    atomic_write_json,
    build_match_candidates,
    build_timing_segments,
    classify_failure,
    cleanup_cache_temporary_files,
    choose_ordered_matches,
    filter_temporal_outliers,
    find_local_whisper_model,
    load_cached_tokens,
    map_original_times,
    normalize_text,
    interpolate_short_gaps,
    parse_synced_lyrics,
    plan_local_retry_requests,
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

    def test_keeps_fixed_offset_segment(self):
        anchors = [
            {
                "lineIndex": index,
                "lyricTimeMs": index * 10_000,
                "audioTimeMs": index * 10_000 + 4_000,
                "confidence": 0.9,
            }
            for index in range(8)
        ]
        filtered, removed = filter_temporal_outliers(anchors)
        self.assertEqual(removed, [])
        self.assertEqual(len(filtered), len(anchors))

    def test_keeps_mid_song_piecewise_offset_change(self):
        offsets = [0, 0, 0, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000, 0, 0, 0]
        anchors = [
            {
                "lineIndex": index,
                "lyricTimeMs": index * 10_000,
                "audioTimeMs": index * 10_000 + offset,
                "confidence": 0.9,
            }
            for index, offset in enumerate(offsets)
        ]
        filtered, removed = filter_temporal_outliers(anchors)
        self.assertEqual(removed, [])
        self.assertEqual(len(filtered), len(anchors))

    def test_keeps_gradual_tempo_drift(self):
        anchors = [
            {
                "lineIndex": index,
                "lyricTimeMs": index * 10_000,
                "audioTimeMs": round(index * 10_000 * 1.08 + 1_000),
                "confidence": 0.9,
            }
            for index in range(10)
        ]
        filtered, removed = filter_temporal_outliers(anchors)
        self.assertEqual(removed, [])
        self.assertEqual(len(filtered), len(anchors))

    def test_keeps_six_line_shift_run(self):
        offsets = [0, 0, 0, -7_000, -8_000, -8_500, -8_000, -7_500, -7_000, 0, 0, 0]
        anchors = [
            {
                "lineIndex": index,
                "lyricTimeMs": index * 10_000,
                "audioTimeMs": index * 10_000 + offset,
                "confidence": 0.9,
            }
            for index, offset in enumerate(offsets)
        ]
        filtered, removed = filter_temporal_outliers(anchors)
        self.assertEqual(removed, [])
        self.assertEqual(len(filtered), len(anchors))

    def test_recovers_all_thirteen_real_failure_song_shift_lines(self):
        selected = [
            (0, 20_400, 0, 0.9953),
            (1, 25_624, 4_640, 0.9857),
            (2, 30_849, 8_020, 0.9930),
            (3, 36_073, 11_440, 0.9746),
            (4, 41_298, 14_580, 0.9751),
            (5, 46_522, 18_680, 0.9865),
            (6, 51_746, 20_720, 0.9842),
            (7, 56_971, 24_260, 0.9693),
            (8, 62_195, 36_960, 0.9857),
            (9, 67_420, 42_620, 0.9663),
            (10, 72_644, 45_340, 0.9887),
            (11, 77_868, 48_680, 0.9628),
            (12, 83_093, 59_260, 0.9886),
            (13, 88_317, 65_740, 0.9390),
            (20, 124_888, 107_960, 0.8503),
            (21, 130_112, 110_820, 0.9875),
            (22, 135_337, 114_120, 0.8384),
            (23, 140_561, 117_380, 0.9982),
            (24, 145_785, 120_480, 0.9678),
            (25, 151_010, 123_200, 0.7969),
            (26, 156_234, 126_620, 0.9924),
            (27, 161_459, 130_080, 0.9183),
            (28, 166_683, 150_840, 0.9329),
            (30, 177_132, 163_100, 0.8325),
            (31, 182_356, 169_580, 0.8961),
            (32, 187_580, 176_460, 0.9724),
            (33, 192_805, 184_880, 0.9429),
            (34, 198_029, 192_600, 0.9688),
            (40, 229_376, 211_320, 0.9786),
            (41, 234_600, 215_520, 0.9844),
        ]
        anchors = [
            {
                "lineIndex": line_index,
                "lyricTimeMs": lyric_time,
                "audioTimeMs": audio_time,
                "confidence": confidence,
            }
            for line_index, lyric_time, audio_time, confidence in selected
        ]
        filtered, removed = filter_temporal_outliers(
            anchors,
            audio_duration_ms=254_676,
            repeated_line_indexes={12, 13, 14, 32, 33, 34},
        )
        self.assertEqual(removed, [])
        self.assertEqual(len(filtered), 30)
        low_repeated = {
            anchor["lineIndex"]: anchor
            for anchor in filtered
            if anchor["lineIndex"] in {33, 34}
        }
        self.assertTrue(
            all(anchor["source"] == "segment_recovered" for anchor in low_repeated.values())
        )
        self.assertTrue(
            all(anchor["confidence"] < 0.75 for anchor in low_repeated.values())
        )

    def test_segment_diagnostics_detect_boundary_discontinuity(self):
        anchors = [
            {"lineIndex": 0, "lyricTimeMs": 0, "audioTimeMs": 0, "confidence": 0.95},
            {"lineIndex": 1, "lyricTimeMs": 10_000, "audioTimeMs": 10_000, "confidence": 0.95},
            {"lineIndex": 2, "lyricTimeMs": 20_000, "audioTimeMs": 20_000, "confidence": 0.95},
            {"lineIndex": 3, "lyricTimeMs": 30_000, "audioTimeMs": 55_000, "confidence": 0.95},
            {"lineIndex": 4, "lyricTimeMs": 40_000, "audioTimeMs": 65_000, "confidence": 0.95},
        ]
        segments, mapping = build_timing_segments(anchors)
        self.assertEqual(len(segments), 2)
        self.assertEqual(mapping[2], 0)
        self.assertEqual(mapping[3], 1)
        self.assertGreater(abs(segments[1]["boundaryDiscontinuityMs"]), 10_000)
        self.assertTrue(segments[1]["driftRisk"])

    def test_interpolates_one_missing_line_only_between_anchors(self):
        lines = ["left", "missing words", "right"]
        anchors = [
            {"lineIndex": 0, "lyricTimeMs": 0, "audioTimeMs": 1_000, "confidence": 0.95},
            {"lineIndex": 2, "lyricTimeMs": 20_000, "audioTimeMs": 11_000, "confidence": 0.9},
        ]
        combined, interpolated = interpolate_short_gaps(lines, anchors, {0: 0, 2: 0})
        self.assertEqual(interpolated, [1])
        middle = next(item for item in combined if item["lineIndex"] == 1)
        self.assertEqual(middle["source"], "interpolated")
        self.assertGreater(middle["audioTimeMs"], 1_000)
        self.assertLess(middle["audioTimeMs"], 11_000)

    def test_interpolates_two_lines_proportional_to_lyrics_length(self):
        lines = ["left", "a", "muchlonger", "right"]
        anchors = [
            {"lineIndex": 0, "lyricTimeMs": 0, "audioTimeMs": 1_000, "confidence": 0.95},
            {"lineIndex": 3, "lyricTimeMs": 30_000, "audioTimeMs": 16_000, "confidence": 0.95},
        ]
        combined, interpolated = interpolate_short_gaps(lines, anchors, {0: 0, 3: 0})
        self.assertEqual(interpolated, [1, 2])
        times = [item["audioTimeMs"] for item in combined]
        self.assertEqual(times, sorted(times))
        self.assertGreater(times[2] - times[1], times[1] - times[0])

    def test_repeated_only_segment_is_not_valid_for_interpolation(self):
        lines = ["chorus", "missing", "chorus"]
        anchors = [
            {"lineIndex": 0, "lyricTimeMs": 0, "audioTimeMs": 1_000, "confidence": 0.95},
            {"lineIndex": 2, "lyricTimeMs": 20_000, "audioTimeMs": 11_000, "confidence": 0.95},
        ]
        segments, mapping = build_timing_segments(anchors, {0, 2})
        self.assertTrue(segments[0]["allRepeatedLyrics"])
        self.assertFalse(segments[0]["validForInterpolation"])
        combined, interpolated = interpolate_short_gaps(
            lines, anchors, mapping, {0, 2}
        )
        self.assertEqual(interpolated, [])
        self.assertEqual(len(combined), 2)

    def test_does_not_extrapolate_beyond_last_anchor(self):
        lines = ["first", "second", "trailing one", "trailing two"]
        anchors = [
            {"lineIndex": 0, "lyricTimeMs": 0, "audioTimeMs": 1_000, "confidence": 0.95},
            {"lineIndex": 1, "lyricTimeMs": 10_000, "audioTimeMs": 9_000, "confidence": 0.95},
        ]
        segments, mapping = build_timing_segments(anchors)
        self.assertTrue(segments[0]["validForInterpolation"])
        combined, interpolated = interpolate_short_gaps(lines, anchors, mapping)
        self.assertEqual(interpolated, [])
        self.assertEqual([item["lineIndex"] for item in combined], [0, 1])

    def test_does_not_interpolate_without_right_anchor_or_across_long_interlude(self):
        lines = ["left", "missing", "right", "trailing"]
        long_gap = [
            {"lineIndex": 0, "lyricTimeMs": 0, "audioTimeMs": 1_000, "confidence": 0.95},
            {"lineIndex": 2, "lyricTimeMs": 20_000, "audioTimeMs": 50_000, "confidence": 0.95},
        ]
        combined, interpolated = interpolate_short_gaps(lines, long_gap, {0: 0, 2: 0})
        self.assertEqual(interpolated, [])
        self.assertEqual(len(combined), 2)

    def test_local_retry_plan_is_bounded_to_missing_line_range(self):
        lines = ["left", "one", "two", "three", "right", "tail"]
        anchors = [
            {"lineIndex": 0, "audioTimeMs": 1_000},
            {"lineIndex": 4, "audioTimeMs": 20_000},
        ]
        requests = plan_local_retry_requests(lines, anchors)
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["allowedLineIndexes"], [1, 2, 3])
        self.assertEqual(requests[0]["startLineIndex"], 1)
        self.assertEqual(requests[0]["endLineIndex"], 3)
        self.assertEqual(requests[0]["status"], "not-run")

    def test_rejects_reverse_and_outside_audio_candidates(self):
        anchors = [
            {"lineIndex": 0, "lyricTimeMs": 0, "audioTimeMs": 1_000},
            {"lineIndex": 1, "lyricTimeMs": 10_000, "audioTimeMs": 2_000},
            {"lineIndex": 2, "lyricTimeMs": 20_000, "audioTimeMs": 1_500},
            {"lineIndex": 3, "lyricTimeMs": 30_000, "audioTimeMs": 31_000},
            {"lineIndex": 4, "lyricTimeMs": 40_000, "audioTimeMs": 61_000},
        ]
        filtered, removed = filter_temporal_outliers(
            anchors, audio_duration_ms=60_000
        )
        self.assertEqual(removed, [2, 4])
        self.assertEqual([anchor["lineIndex"] for anchor in filtered], [0, 1, 3])

    def test_rejects_incoherent_consecutive_timing_spikes(self):
        anchors = [
            {
                "lineIndex": index,
                "lyricTimeMs": index * 10_000,
                "audioTimeMs": audio_time,
                "confidence": 0.9,
            }
            for index, audio_time in enumerate(
                [0, 10_000, 20_000, 80_000, 150_000, 160_000, 170_000]
            )
        ]
        filtered, removed = filter_temporal_outliers(anchors)
        self.assertTrue(removed)
        self.assertLess(len(filtered), len(anchors))

    def test_global_path_prefers_adjacent_context_and_strict_time_order(self):
        candidates = [
            MatchCandidate(0, 0, 1, 1_000, 0.92, "a"),
            MatchCandidate(1, 1, 2, 2_000, 0.90, "chorus"),
            MatchCandidate(1, 4, 5, 8_000, 0.93, "chorus"),
            MatchCandidate(2, 2, 3, 3_000, 0.91, "b"),
            MatchCandidate(3, 5, 6, 9_000, 0.90, "chorus"),
        ]
        matches = choose_ordered_matches(
            candidates,
            expected_times_ms=[1_000, 2_000, 3_000, 9_000],
            repeated_line_indexes={1, 3},
        )
        self.assertEqual([match.line_index for match in matches], [0, 1, 2, 3])
        self.assertEqual([match.audio_time_ms for match in matches], [1_000, 2_000, 3_000, 9_000])
        self.assertTrue(
            all(left.audio_time_ms < right.audio_time_ms for left, right in zip(matches, matches[1:]))
        )
        self.assertLess(matches[1].confidence, 0.90)

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
