# Qwen3 ForcedAligner one-song comparison

- Track: 誰も見てない夢を見ろ / 天音かなた(official) — Kanata Ch. Kanata Amane
- Input: cached separated vocals + current plain lyrics; existing Whisper result was not rerun.
- Human ground truth: unavailable. Accuracy/MAE improvement is therefore not claimed.
- Whisper large-v3: 17/42 valid lines (40.476%), original full pipeline 76.076 s; from cached vocals 40.62 s; peak 4857 MiB.
- Qwen3 ForcedAligner: 18/42 valid lines (42.857%), cached-model load + alignment 6.272 s; estimated full pipeline with the same separation cost 41.558 s; peak 7263 MiB.
- Reverse-order timestamps: Whisper 0, Qwen 0.
- Non-increasing (equal-or-earlier) line starts: Whisper 0, Qwen 15.
- Invalid or missing lines: Whisper 25, Qwen 24.
- Repeated-line collisions: Whisper 0, Qwen 0; ambiguous collisions are excluded from generated timelines.
- Conclusion: **not-recommended-from-this-run** — the selected singing sample produced collapsed or implausibly stretched line spans, so safe coverage did not improve enough

The `confidence` stored in the compatibility timeline is a structural token-coverage score, not a probability emitted by Qwen. Human listening validation is still required before production adoption.
