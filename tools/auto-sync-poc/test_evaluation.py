import unittest

from evaluation_metrics import (
    aggregate_results,
    percentile,
    render_markdown,
    score_against_ground_truth,
)


CASE = {
    "id": "case-a",
    "plainLyrics": ["青い空", "消えた行", "同じ歌", "同じ歌"],
    "groundTruthAnchors": [
        {"lineIndex": 0, "audioTimeMs": 1000},
        {"lineIndex": 1, "audioTimeMs": 2000},
        {"lineIndex": 2, "audioTimeMs": 5000},
        {"lineIndex": 3, "audioTimeMs": 10000},
    ],
    "errorAnnotations": [
        {"type": "omitted_lyrics", "lineIndices": [1]},
        {"type": "repeated_chorus", "lineIndices": [2, 3]},
    ],
}


def pipeline(anchors):
    return {
        "matchedLines": len(anchors),
        "anchors": anchors,
        "comparison": {
            "beforeMedianAbsErrorMs": 500,
            "afterLeaveOneOutMedianAbsErrorMs": 250,
        },
        "diagnostics": {"temporalOutlierLines": []},
    }


CONFIG = {
    "minimumCasesForRecommendation": 3,
    "integrationBenchmarks": {
        "minimumMatchRate": 0.75,
        "maximumMedianTimingErrorMs": 500,
        "maximumP90TimingErrorMs": 1500,
        "maximumFatalWrongSectionRate": 0.1,
    },
}


class EvaluationMetricTests(unittest.TestCase):
    def test_interpolated_percentile(self):
        self.assertEqual(percentile([100, 100, 4000], 0.9), 3220)

    def test_scores_human_timing_and_repeated_section_error(self):
        result = pipeline(
            [
                {"lineIndex": 0, "audioTimeMs": 1100},
                {"lineIndex": 2, "audioTimeMs": 9000},
                {"lineIndex": 3, "audioTimeMs": 10100},
            ]
        )
        score = score_against_ground_truth(CASE, result, fatal_error_ms=3000)
        self.assertEqual(score["matchedGroundTruthLines"], 3)
        self.assertEqual(score["matchRate"], 0.75)
        self.assertEqual(score["medianAbsoluteTimingErrorMs"], 100)
        self.assertEqual(score["meanAbsoluteTimingErrorMs"], 1400)
        self.assertEqual(score["p90TimingErrorMs"], 3220)
        self.assertEqual(score["maximumTimingErrorMs"], 4000)
        self.assertEqual(score["unmatchedGroundTruthLines"], [1])
        self.assertEqual(score["wrongRepeatedSectionMatchCount"], 1)
        self.assertEqual(score["wrongRepeatedSectionLines"], [2])
        self.assertEqual(score["errorAnalysis"]["omitted_lyrics"]["failedLines"], [1])

    def test_aggregate_recommends_only_variant_meeting_configured_benchmarks(self):
        weak = score_against_ground_truth(
            CASE,
            pipeline(
                [
                    {"lineIndex": 0, "audioTimeMs": 1100},
                    {"lineIndex": 2, "audioTimeMs": 9000},
                    {"lineIndex": 3, "audioTimeMs": 10100},
                ]
            ),
            3000,
        )
        strong = score_against_ground_truth(
            CASE,
            pipeline(
                [
                    {"lineIndex": 0, "audioTimeMs": 1100},
                    {"lineIndex": 1, "audioTimeMs": 2100},
                    {"lineIndex": 2, "audioTimeMs": 5100},
                    {"lineIndex": 3, "audioTimeMs": 10100},
                ]
            ),
            3000,
        )
        cases = []
        for index in range(3):
            cases.append(
                {
                    "id": f"case-{index}",
                    "variants": [
                        {
                            "variantId": "original:none",
                            "groundTruth": weak,
                            "processingSeconds": 20,
                            "peakGpuMemoryMiB": 3000,
                        },
                        {
                            "variantId": "vocals:none",
                            "groundTruth": strong,
                            "processingSeconds": 60,
                            "peakGpuMemoryMiB": 4500,
                        },
                    ],
                }
            )
        summary = aggregate_results(cases, CONFIG)
        self.assertFalse(summary["variants"]["original:none"]["meetsAllBenchmarks"])
        self.assertTrue(summary["variants"]["vocals:none"]["meetsAllBenchmarks"])
        self.assertEqual(summary["recommendation"]["bestVariant"], "vocals:none")
        self.assertEqual(
            summary["recommendation"]["status"], "consider-pilot-integration"
        )

    def test_fewer_than_three_cases_never_recommends_integration(self):
        strong = score_against_ground_truth(
            CASE,
            pipeline(
                [
                    {"lineIndex": 0, "audioTimeMs": 1000},
                    {"lineIndex": 1, "audioTimeMs": 2000},
                    {"lineIndex": 2, "audioTimeMs": 5000},
                    {"lineIndex": 3, "audioTimeMs": 10000},
                ]
            ),
            3000,
        )
        summary = aggregate_results(
            [
                {
                    "id": "only-one",
                    "variants": [
                        {
                            "variantId": "vocals:full",
                            "groundTruth": strong,
                            "processingSeconds": 50,
                            "peakGpuMemoryMiB": 4400,
                        }
                    ],
                }
            ],
            CONFIG,
        )
        self.assertEqual(
            summary["recommendation"]["status"],
            "insufficient-human-ground-truth",
        )

    def test_report_handles_zero_match_variant(self):
        empty = score_against_ground_truth(CASE, pipeline([]), 3000)
        cases = [
            {
                "id": "empty",
                "variants": [
                    {
                        "variantId": "original:none",
                        "groundTruth": empty,
                        "processingSeconds": 10,
                        "peakGpuMemoryMiB": 2000,
                    }
                ],
            }
        ]
        summary = aggregate_results(cases, CONFIG)
        report = render_markdown(summary, cases)
        self.assertIn("n/a", report)
        self.assertIn("insufficient-human-ground-truth", report)


if __name__ == "__main__":
    unittest.main()
