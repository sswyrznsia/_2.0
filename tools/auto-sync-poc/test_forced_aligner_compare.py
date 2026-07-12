import unittest
from dataclasses import dataclass

from forced_aligner_compare import (
    AlignedItem,
    coerce_aligned_items,
    fnv1a64,
    make_timeline,
    map_items_to_lines,
    mapping_text,
    repeated_line_collisions,
    split_plain_lyrics,
    validate_compatible_timeline,
)


class ForcedAlignerCompareTests(unittest.TestCase):
    def test_coerces_official_result_wrapper(self):
        @dataclass
        class Item:
            text: str
            start_time: float
            end_time: float

        @dataclass
        class Result:
            items: list[Item]

        items = coerce_aligned_items([Result([Item("歌", 1.0, 2.0)])])
        self.assertEqual(items, [AlignedItem("歌", 1.0, 2.0)])

    def test_hash_matches_typescript_fnv1a_utf8(self):
        self.assertEqual(fnv1a64("hello"), "a430d84680aabd0b")
        self.assertEqual(len(fnv1a64("誰も見てない夢を見ろ")), 16)

    def test_maps_exact_tokens_to_non_empty_lines(self):
        lyrics = ["今度こそ、生き返れない", "朝が生を教えた"]
        items = [
            AlignedItem("今度こそ", 1.0, 1.5),
            AlignedItem("生き返れない", 1.5, 2.5),
            AlignedItem("朝が", 3.0, 3.4),
            AlignedItem("生を教えた", 3.4, 4.2),
        ]
        lines, diagnostics = map_items_to_lines(lyrics, items, 10_000)
        self.assertTrue(diagnostics["exactFullTextReconstruction"])
        self.assertTrue(all(line["valid"] for line in lines))
        self.assertEqual(lines[1]["startTimeMs"], 3000)

    def test_text_mismatch_is_not_forced_valid(self):
        lines, _ = map_items_to_lines(
            ["正しい歌詞"], [AlignedItem("違う歌詞", 1.0, 2.0)], 10_000
        )
        self.assertFalse(lines[0]["valid"])
        self.assertIn("full-text-token-mismatch", lines[0]["invalidReasons"])

    def test_reverse_time_is_invalid(self):
        lines, _ = map_items_to_lines(
            ["最初", "次"],
            [AlignedItem("最初", 4.0, 5.0), AlignedItem("次", 3.0, 3.5)],
            10_000,
        )
        self.assertTrue(lines[0]["valid"])
        self.assertFalse(lines[1]["valid"])
        self.assertIn("non-monotonic-time", lines[1]["invalidReasons"])

    def test_implausibly_short_and_long_lines_are_invalid(self):
        short, _ = map_items_to_lines(
            ["長い歌詞の一行"], [AlignedItem("長い歌詞の一行", 1.0, 1.1)], 200_000
        )
        long, _ = map_items_to_lines(
            ["短い行"], [AlignedItem("短い行", 1.0, 20.0)], 200_000
        )
        self.assertIn("implausibly-short-line-duration", short[0]["invalidReasons"])
        self.assertIn("implausibly-long-line-duration", long[0]["invalidReasons"])

    def test_repeated_line_overlap_is_invalidated(self):
        lyrics = ["同じサビ", "別の行", "同じサビ"]
        items = [
            AlignedItem("同じサビ", 1.0, 5.0),
            AlignedItem("別の行", 2.0, 3.0),
            AlignedItem("同じサビ", 4.0, 6.0),
        ]
        lines, diagnostics = map_items_to_lines(lyrics, items, 10_000)
        self.assertEqual(len(diagnostics["repeatedLineCollisions"]), 1)
        self.assertFalse(lines[0]["valid"])
        self.assertFalse(lines[2]["valid"])

    def test_generated_timeline_has_only_valid_lines_and_text_hashes(self):
        lyrics = "一行目\n\n二行目"
        lines, _ = map_items_to_lines(
            split_plain_lyrics(lyrics),
            [AlignedItem("一行目", 1.0, 2.0), AlignedItem("二行目", 3.0, 4.0)],
            10_000,
        )
        timeline = make_timeline("track", lyrics, "model", lines)
        self.assertEqual(timeline["lineCount"], 2)
        self.assertEqual(len(timeline["lines"]), 2)
        self.assertEqual(timeline["lines"][0]["textHash"], fnv1a64("一行目"))
        self.assertEqual(timeline["lyricsTextHash"], fnv1a64("一行目\n二行目"))
        self.assertEqual(validate_compatible_timeline(timeline, lyrics), {"valid": True, "errors": []})

    def test_generated_timeline_rejects_changed_lyrics(self):
        lyrics = "元の歌詞"
        lines, _ = map_items_to_lines(
            [lyrics], [AlignedItem(lyrics, 1.0, 2.0)], 10_000
        )
        timeline = make_timeline("track", lyrics, "model", lines)
        validation = validate_compatible_timeline(timeline, "変更した歌詞")
        self.assertFalse(validation["valid"])
        self.assertIn("lyrics-text-hash-mismatch", validation["errors"])

    def test_mapping_text_ignores_spacing_and_punctuation(self):
        self.assertEqual(mapping_text("ああ 生きてた。"), "ああ生きてた")


if __name__ == "__main__":
    unittest.main()
