# Segment-aware matcher comparison

## Failure song

| Metric | Legacy | Improved |
| --- | ---: | ---: |
| Sequence selected | 30 | 30 |
| Timing outliers removed | 13 | 0 |
| Final valid lines | 17/42 | 30/42 |
| Coverage | 40.476% | 71.429% |
| Reverse times | 0 | 0 |
| Repeated collisions | 0 | 0 |

- Recovered former outliers: 13 lines, [6, 7, 8, 9, 10, 11, 20, 21, 26, 27, 28, 33, 34].
- GeneratedLyricsTimeline validation: True.
- Ground truth: unavailable. Coverage is an internal consistency result, not measured timing accuracy.
- Failure replay limitation: The raw failure-song token cache was pruned by an earlier UI test. The improved global path is replayed from preserved best/selected candidates; no model was rerun.

## Normal-song regression

| Track | Legacy | Improved | New removals | Regression |
| --- | ---: | ---: | ---: | --- |
| 5ea78a44 | 30/32 | 30/32 | 1 | PASS |
| c608ad3a | 35/36 | 35/36 | 1 | PASS |

## Conclusion

The fixed 1,500ms per-line filter was the dominant loss mechanism. Segment-aware filtering restores the monotonic, high-confidence runs without reducing either normal cached song. Matcher validation should precede any ASR replacement.
