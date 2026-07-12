# Automatic lyrics sync PoC

This is a standalone experiment. It does not import Electron code, modify Pulse Shelf data, or save a `lyricsSyncProfile` into the app.

Pipeline:

1. Separate the vocal stem with `model_bs_roformer_ep_317_sdr_12.9755.ckpt`.
2. Transcribe approximate Japanese timing/text with faster-whisper.
3. Match the selected plain lyric lines to Whisper tokens using monotonic fuzzy matching.
4. Emit only high-confidence matches, plus an app-compatible `lyricsSyncProfile` projection.
5. Delete the temporary vocal stem even when separation or transcription fails.

## Environment

Create a Python 3.11 virtual environment at `.venv-auto-sync`, then install CUDA Torch first and the PoC dependencies second. Reinstall the matching CUDA Torch/torchvision pair last because generic package resolution may otherwise select a CPU wheel.

```powershell
.venv-auto-sync\Scripts\python.exe -m pip install -r tools\auto-sync-poc\requirements.txt
.venv-auto-sync\Scripts\python.exe -m pip install --force-reinstall torch==2.10.0 torchvision==0.25.0 --index-url https://download.pytorch.org/whl/cu126
```

Place FFmpeg under `.poc-cache/ffmpeg` and download the separator model once:

```powershell
$env:PATH = "$(Resolve-Path .poc-cache\ffmpeg\ffmpeg-master-latest-win64-gpl\bin);$env:PATH"
.venv-auto-sync\Scripts\audio-separator.exe --model_filename model_bs_roformer_ep_317_sdr_12.9755.ckpt --model_file_dir .poc-cache\models --download_model_only
```

Download the configured faster-whisper model explicitly before the first run:

```powershell
.venv-auto-sync\Scripts\python.exe -c "from huggingface_hub import snapshot_download; snapshot_download('Systran/faster-whisper-large-v3', cache_dir=r'.poc-cache\whisper')"
```

The worker runs with local-only model loading and never downloads a model automatically. A complete snapshot must contain `model.bin`, `config.json`, `preprocessor_config.json`, `tokenizer.json`, and `vocabulary.json`.

## Run

Create an input JSON matching `input.schema.json`. `syncedLyrics` supplies the original `lyricTimeMs`; Whisper text is never used as replacement lyrics.

The profile corrects an existing timed lyric track, so plain-only lyrics are not sufficient: at least two non-empty plain lines and at least one mappable timestamp in `syncedLyrics` are required.

```powershell
powershell -ExecutionPolicy Bypass -File tools\auto-sync-poc\run.ps1 `
  -InputJson tools\auto-sync-poc\current-track.input.json `
  -OutputJson tools\auto-sync-poc\results\current-track.result.json
```

The detailed `anchors` include line index and confidence for evaluation. `lyricsSyncProfile.anchors` contains only `{ lyricTimeMs, audioTimeMs }`, which is the shape consumed by the existing manual sync editor. `updatedAt` is deliberately zero and the PoC never sends or persists it.

The existing `run.ps1` invocation remains the human-readable/default mode. It writes the result atomically and prints the final result as pretty JSON.

### Electron worker mode

The Electron main process invokes the same Python file with opt-in worker flags (it must still use an argument array with `shell: false`):

```powershell
.venv-auto-sync\Scripts\python.exe tools\auto-sync-poc\auto_sync_poc.py `
  --input <job-input.json> `
  --output <job-result.json> `
  --workspace <workspace> `
  --temp-root <service-owned-job-directory> `
  --cache-key <64-lowercase-hex-cache-key> `
  --json-events
```

With `--json-events`, the worker's own stdout contains compact, flushed, one-object-per-line events only; the final pretty result is not printed. Ordinary `print` output produced while the pipeline runs is redirected to stderr. A caller must nevertheless parse only objects whose `event` is one of `stage`, `progress`, `completed`, or `failed`, because third-party native logging can bypass Python's stdout redirect.

Stages are emitted in this order:

1. `preparing`
2. `separating`
3. `releasing-separator`
4. `transcribing`
5. `matching`
6. `building-anchors`
7. `validating`

Separation and transcription are indeterminate unless skipped by a cache hit. Matching reports real processed-line/candidate progress and anchor building reports real processed-match progress. Example event shapes:

```json
{"event":"stage","stage":"separating","progress":null,"overallProgress":0.03,"indeterminate":true}
{"event":"progress","stage":"matching","progress":0.6,"overallProgress":0.864,"current":44,"total":44}
{"event":"completed","progress":1.0,"overallProgress":1.0,"resultPath":"D:\\jobs\\result.json"}
{"event":"failed","stage":"transcribing","code":"oom","message":"CUDA out of memory"}
```

Failure codes are intentionally short: `python`, `package`, `model`, `separator-model`, `whisper-model`, `cuda`, `oom`, `ffmpeg`, `audio`, `separation`, `transcription`, `matching`, `profile`, or `process`. The concise event is safe for UI mapping; the full traceback remains on stderr for logs.

`--temp-root` changes only the transient stem location. `TemporaryDirectory` removes the stem on normal and Python-exception exits. A force-killed process cannot run Python cleanup, so the Electron service remains responsible for terminating the whole process tree and deleting its owned job directory after the child closes.

`--cache-key` enables completed intermediate reuse under `.poc-cache/auto-sync/<key>/`:

- `vocals.wav` is published atomically only after separation and separator release finish.
- `tokens.json` is published atomically only after transcription finishes.
- A valid token hit skips both GPU stages; a vocal-only hit skips separation.
- Invalid/partial cache files are ignored and removed. Cache write failure does not fail a successful analysis.

The worker deliberately does not derive the key. The main-process service must include the track/file fingerprint, normalized plain-lyrics hash, and model/settings in the 64-hex key so changed audio, lyrics, or models never reuse stale intermediates. Result files are also written through a same-directory temporary file followed by atomic replacement; callers should still use a unique output path per job so an older result cannot be mistaken for a failed run.

## Mock tests (no models or audio required)

```powershell
.venv-auto-sync\Scripts\python.exe tools\auto-sync-poc\test_auto_sync_poc.py -v
```

The tests cover Japanese normalization, original timestamp mapping, forward-only repeated chorus matching, unmatched-line rejection, piecewise anchor compatibility, JSONL event framing/stages, atomic writes, cache validation/reuse, and temporary-stem cleanup without loading models or audio.

Validate a real result with the exact profile validator used by the manual sync editor:

```powershell
node tools\auto-sync-poc\verify-profile.mjs tools\auto-sync-poc\results\current-track.result.json
```

## Human-ground-truth evaluation

The evaluation tool runs six variants per song:

- original audio / separated vocal
- no hotwords / full plain lyrics / human-curated keyword hotwords

Private inputs live under `evaluation/cases` and `evaluation/ground-truth`. JSON files in those folders and raw result JSON files are gitignored so personal paths, audio metadata, and human annotations are not committed. Audio is read in place and never copied into the repository.

Copy the two `*.example.json` files to private JSON filenames. For each song, manually verify `groundTruthAnchors[].audioTimeMs`; do not derive those values from LRCLIB or the automatic output. `keywordHotwords` must also be manually limited to proper nouns and distinctive key terms so the keywords mode is genuinely different from the full-lyrics mode.

At least three valid cases are required. Validate without loading models:

```powershell
tools\auto-sync-poc\evaluate.ps1 -DryRun
```

Run all six variants:

```powershell
tools\auto-sync-poc\evaluate.ps1
```

For a partial diagnostic run:

```powershell
tools\auto-sync-poc\evaluate.ps1 -Sources original -HotwordModes none,keywords
```

Outputs:

- `evaluation/results/<case-id>.json`: per-pipeline anchors, human errors, leave-one-out diagnostics, time, and VRAM
- `evaluation/summary.json`: cross-song and cross-variant aggregate metrics
- `evaluation/REPORT.md`: Markdown comparison and recommendation

The recommendation thresholds are data in `evaluation/config.json`, not hard-coded product gates. Human-ground-truth timing errors determine the recommendation. Leave-one-out error is retained only as a separate internal-consistency diagnostic.
