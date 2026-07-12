# Timing drift and short-gap recovery

## Failure song result

- Previous matcher preview: 30/42.
- Drift-safe preview: 31/42.
- Auto-applicable: 29/42 (69.048%).
- Sources: {'direct': 17, 'segment_recovered': 13, 'interpolated': 1, 'local_retry': 0, 'unmatched': 11}.
- Existing lines maintained/excluded: 28/[33, 34].
- New safe interpolated lines: [29].
- Low-confidence preview lines: [{'lineIndex': 33, 'source': 'segment_recovered', 'confidence': 0.604}, {'lineIndex': 34, 'source': 'segment_recovered', 'confidence': 0.6782}].
- Remaining unmatched: [14, 15, 16, 17, 18, 19, 35, 36, 37, 38, 39].

## Segment diagnostics

| Segment | Lines | Slope | Intercept ms | Boundary discontinuity ms | Unique direct support | Drift risk |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 0 | 0–13 | 0.926964 | -21345 | None | 6 | False |
| 1 | 20–27 | 0.602942 | 32550 | 8320 | 3 | False |
| 2 | 28–34 | 1.332227 | -72430 | 17610 | 2 | True |
| 3 | 40–41 | 0.803982 | 26906 | -23041 | 2 | True |

The late drift risk is caused by large boundary discontinuities, not cumulative extrapolation. Interpolation is confined to two direct anchors inside one segment; no line is extrapolated beyond anchor coverage.

## Normal cache regression

| Track | Baseline synced anchors | Drift-safe synced anchors | Pass |
| --- | ---: | ---: | --- |
| 02629ab0 | 59 | 59 | True |

Human ground truth is unavailable. These are structural consistency and safety results, not measured timing accuracy. No model inference was run.
