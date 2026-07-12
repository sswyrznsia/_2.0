# Whisper 40% failure diagnostics

## Stage counts

| Stage | Lines |
| --- | ---: |
| Total lyrics | 42 |
| Raw transcript candidate linked | 42 |
| Text similarity passed | 36 |
| Matcher confidence passed | 36 |
| Ordered sequence selected | 30 |
| Removed as temporal outliers | 13 |
| Final valid | 17 (40.476%) |

## Drop reasons

| Reason | Count |
| --- | ---: |
| no_transcript_candidate | 0 |
| text_similarity_below_threshold | 6 |
| sequence_constraint | 3 |
| duplicate_or_repeated_section_conflict | 3 |
| timing_outlier | 13 |
| low_confidence | 0 |
| reversed_time | 0 |
| outside_audio_range | 0 |
| unmatched | 0 |
| unknown | 0 |

## Thirteen temporal outliers

| Line | Lyrics | Local deviation (ms) | Reason |
| ---: | --- | ---: | --- |
| 6 | まだやれるのか まだやらなきゃなのか | 3746 | local offset deviation exceeded 1500ms |
| 7 | いっそ無理矢理もがれてしまえば なんてね | 6173 | local offset deviation exceeded 1500ms |
| 8 | 「僕は元気です」そう言って今日も笑って | 3930 | local offset deviation exceeded 1500ms |
| 9 | 心はがらんどうです | 3446 | local offset deviation exceeded 1500ms |
| 10 | 大げさな音がする | 2286 | local offset deviation exceeded 1500ms |
| 11 | ああ 終末の鐘の音か | 4872 | local offset deviation exceeded 1500ms |
| 20 | 感情の捨て方はさ | 4969 | local offset deviation exceeded 1500ms |
| 21 | 粗大ゴミのシールを貼る | 2605 | local offset deviation exceeded 1500ms |
| 26 | それでも君が笑ってくれるなら | 3056 | local offset deviation exceeded 1500ms |
| 27 | いっそ心をなくしてしまえば なんてね | 9553 | local offset deviation exceeded 1500ms |
| 28 | 「敵わない」なんて 一瞬でも思ったら負けだ | 5980 | local offset deviation exceeded 1500ms |
| 33 | それでもこの喉が 千切れるぐらい叫ぶよ | 4023 | local offset deviation exceeded 1500ms |
| 34 | この腕が 真白なこの羽が | 9159 | local offset deviation exceeded 1500ms |

## Assessment

- Raw transcript: 36/42 lines had a candidate above the configured matcher threshold; only 17 survived. Whisper contains substantial correct lyric text, although six repeated-chorus lines have weak transcription matches.
- Matcher: The ordered matcher selected 30 lines, then the local-offset filter removed 13. 19 threshold-passing lines were ultimately discarded.
- Cover-version difference: No line provides strong evidence of a different cover lyric edition. Low-similarity lines are concentrated in repeated chorus passages and are more consistent with ASR omissions or matcher ambiguity.
- Repeated-section problem lines: [14, 15, 16, 17, 18, 33, 34, 35, 36, 37, 38]

## Representative successes

- L23 `潰れる音がするんだ` → 117380ms, confidence 0.9982
- L0 `今度こそ生き返れない` → 0ms, confidence 0.9953
- L2 `気付けばカーテンの隙間から` → 8020ms, confidence 0.993

## Representative failures

- L6 `まだやれるのか まだやらなきゃなのか` → timing_outlier: local offset deviation exceeded 1500ms
- L14 `この腕が 真白なこの羽が` → duplicate_or_repeated_section_conflict: high-scoring repeated text was not selected by the forward-only sequence path
- L15 `僕のこの命が「生きたい」と歌ってる` → text_similarity_below_threshold: best text similarity was below the configured threshold
- L19 `だから 僕を見てろよ` → sequence_constraint: high-scoring candidate was excluded by the global forward-only sequence path

This report replays the cached matcher only. Whisper and BS-RoFormer were not executed.
