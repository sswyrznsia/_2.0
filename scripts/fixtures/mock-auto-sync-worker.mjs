import { spawn } from 'node:child_process'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

function argument(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1])
    throw new Error(`Missing mock worker argument: ${name}`)
  return process.argv[index + 1]
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

const inputPath = argument('--input')
const outputPath = argument('--output')
const workspaceRoot = argument('--workspace')
const input = JSON.parse(await readFile(inputPath, 'utf8'))
const mode = input.trackId[0]

if (process.env.PULSE_SHELF_AUTO_SYNC_MOCK_NO_COUNT !== '1')
  await appendFile(
    path.join(workspaceRoot, 'mock-worker-count.txt'),
    `${input.trackId}\n`,
    'utf8',
  )

process.stdout.write('mock worker: ordinary log line\n')
process.stdout.write('{malformed-json\n')
process.stdout.write(
  `${JSON.stringify({ event: 'progress', stage: 'separating', progress: 4 })}\n`,
)
process.stdout.write(`${JSON.stringify({ event: 'unknown', value: true })}\n`)
emit({ event: 'stage', stage: 'preparing', message: 'mock preparing' })
emit({
  event: 'progress',
  stage: 'separating',
  progress: 0.5,
  message: 'mock separation',
})

if (mode === 'e') {
  emit({ event: 'failed', code: 'oom', message: 'CUDA out of memory' })
  process.stderr.write('RuntimeError: CUDA out of memory\n')
  process.exitCode = 1
} else if (mode === 'f') {
  const descendant = spawn(
    process.execPath,
    ['-e', 'setInterval(() => undefined, 1000)'],
    { stdio: 'ignore', windowsHide: true },
  )
  descendant.unref()
  await writeFile(
    path.join(workspaceRoot, `.mock-tree-${input.trackId}.json`),
    JSON.stringify({ workerPid: process.pid, childPid: descendant.pid }),
    'utf8',
  )
  setInterval(() => undefined, 1_000)
  await new Promise(() => undefined)
} else {
  if (mode === 'b') await new Promise((resolve) => setTimeout(resolve, 400))

  emit({ event: 'stage', stage: 'releasing-separator' })
  emit({ event: 'progress', stage: 'transcribing', progress: 0.65 })
  emit({ event: 'stage', stage: 'matching' })
  emit({ event: 'stage', stage: 'building-anchors' })

  const totalLines = input.plainLyrics.length
  const matchedLines = Math.min(mode === 'd' ? 2 : 4, totalLines)
  const resultTrackId = mode === 'c' ? '0'.repeat(64) : input.trackId
  const anchors = Array.from({ length: matchedLines }, (_, lineIndex) => ({
    lineIndex,
    lyricTimeMs: lineIndex * 10_000,
    audioTimeMs:
      mode === '2' && lineIndex === 2 ? 500 : lineIndex * 10_000 + 750,
    confidence: lineIndex === 1 ? 0.7 : 0.92,
    whisperText: `mock line ${lineIndex + 1}`,
  }))
  const unmatchedLines = Array.from(
    { length: totalLines - matchedLines },
    (_, index) => matchedLines + index,
  )
  const result = {
    trackId: resultTrackId,
    model: {
      separator: 'model_bs_roformer_ep_317_sdr_12.9755.ckpt',
      whisper: 'large-v3',
    },
    matchedLines,
    totalLines,
    confidence: mode === 'd' ? 0.55 : 0.86,
    anchors,
    unmatchedLines,
    lyricsSyncProfile: {
      trackId: resultTrackId,
      offsetMs: 0,
      anchors: anchors.map(({ lyricTimeMs, audioTimeMs }) => ({
        lyricTimeMs,
        audioTimeMs,
      })),
      updatedAt: 0,
    },
    comparison: {
      beforeMedianAbsErrorMs: 750,
      afterLeaveOneOutMedianAbsErrorMs: null,
    },
    diagnostics: {
      whisperTokens: anchors.map((anchor, index) => ({
        text: `mock token ${index + 1}`,
        start_ms: anchor.audioTimeMs,
        end_ms: anchor.audioTimeMs + 500,
        probability: anchor.confidence,
      })),
      bestConfidenceByLine: Array.from(
        { length: totalLines },
        (_, index) => anchors[index]?.confidence ?? 0,
      ),
      temporalOutlierLines: [],
    },
    metrics: {
      vocalSeparationSeconds: 0.05,
      whisperSeconds: 0.1,
      matchingSeconds: 0.1,
      totalSeconds: 0.25,
      whisperTokens: anchors.length,
      gpuMemory: {
        baselineMiB: 1_111,
        peakMiB: 4_321,
        peakIncrementMiB: 3_210,
        phasePeaksMiB: { vocalSeparation: 4_000, whisper: 4_321 },
      },
    },
  }
  await writeFile(outputPath, `${JSON.stringify(result)}\n`, 'utf8')
  emit({ event: 'completed', resultPath: outputPath })
}
