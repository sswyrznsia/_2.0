import assert from 'node:assert/strict'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  AutoSyncErrorCode,
  AutoSyncJob,
  AutoSyncJobStatus,
} from '../src/types/models'
import { AutoSyncError } from '../electron/autoSync/autoSyncErrors'
import {
  AutoSyncService,
  type AutoSyncServiceOptions,
} from '../electron/autoSync/autoSyncService'
import type {
  AutoSyncLogger,
  AutoSyncTrackSource,
} from '../electron/autoSync/autoSyncTypes'
import { validateGeneratedLyricsTimeline } from '../src/utils/generatedLyricsTimeline'

const TRACK_NORMAL = 'a'.repeat(64)
const TRACK_SLOW = 'b'.repeat(64)
const TRACK_MISMATCH = 'c'.repeat(64)
const TRACK_LOW_QUALITY = 'd'.repeat(64)
const TRACK_OOM = 'e'.repeat(64)
const TRACK_TREE = 'f'.repeat(64)
const TRACK_OTHER = '1'.repeat(64)
const TRACK_REVERSE = '2'.repeat(64)
const MOCK_WORKER = path.resolve(
  'scripts',
  'fixtures',
  'mock-auto-sync-worker.mjs',
)

type JobEvent = 'progress' | 'completed' | 'failed'

interface LogEntry {
  message: string
  details?: unknown
}

interface TestFixture {
  root: string
  workspaceRoot: string
  workRoot: string
  audioPath: string
  tracks: Map<string, AutoSyncTrackSource>
  events: Array<{ event: JobEvent; job: AutoSyncJob }>
  logs: {
    info: LogEntry[]
    warn: LogEntry[]
    error: LogEntry[]
  }
  service: AutoSyncService
}

const plainLyrics = [
  '첫 번째 줄',
  '두 번째 줄',
  '세 번째 줄',
  '네 번째 줄',
  '다섯 번째 줄',
].join('\n')

const syncedLyrics = [
  '[00:00.00]첫 번째 줄',
  '[00:10.00]두 번째 줄',
  '[00:20.00]세 번째 줄',
  '[00:30.00]네 번째 줄',
  '[00:40.00]다섯 번째 줄',
].join('\n')

function trackSource(
  trackId: string,
  audioPath: string,
  overrides: Partial<AutoSyncTrackSource> = {},
): AutoSyncTrackSource {
  return {
    trackId,
    audioPath,
    fileSize: 16,
    modifiedAt: 1,
    plainLyrics,
    syncedLyrics,
    provider: 'lrclib',
    ...overrides,
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function waitFor<T>(
  check: () =>
    T | undefined | null | false | Promise<T | undefined | null | false>,
  label: string,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`${label} timed out`)
}

async function waitForJob(
  service: AutoSyncService,
  trackId: string,
  statuses: AutoSyncJobStatus[],
): Promise<AutoSyncJob> {
  try {
    return await waitFor(
      () => {
        const job = service.getJob(trackId)
        return job && statuses.includes(job.status) ? job : undefined
      },
      `${trackId.slice(0, 8)} job ${statuses.join('/')}`,
    )
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; latest job=${JSON.stringify(service.getJob(trackId))}`,
      { cause: error },
    )
  }
}

async function waitForIdle(service: AutoSyncService) {
  await waitFor(() => !service.hasActiveJob(), 'auto-sync service idle')
}

async function waitForEmittedJob(
  fixture: TestFixture,
  trackId: string,
  event: JobEvent,
  status: AutoSyncJobStatus,
): Promise<AutoSyncJob> {
  return waitFor(
    () =>
      fixture.events.find(
        (entry) =>
          entry.event === event &&
          entry.job.trackId === trackId &&
          entry.job.status === status,
      )?.job,
    `${trackId.slice(0, 8)} emitted ${event}/${status}`,
  )
}

async function assertStartError(
  promise: Promise<unknown>,
  code: AutoSyncErrorCode,
) {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof AutoSyncError && error.code === code,
  )
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readTreePids(workspaceRoot: string, trackId: string) {
  return JSON.parse(
    await readFile(
      path.join(workspaceRoot, `.mock-tree-${trackId}.json`),
      'utf8',
    ),
  ) as { workerPid: number; childPid: number }
}

async function cleanupMockProcesses(workspaceRoot: string) {
  const entries = await readdir(workspaceRoot).catch(() => [])
  for (const entry of entries.filter((name) =>
    name.startsWith('.mock-tree-'),
  )) {
    try {
      const pids = JSON.parse(
        await readFile(path.join(workspaceRoot, entry), 'utf8'),
      ) as { workerPid?: number; childPid?: number }
      for (const pid of [pids.workerPid, pids.childPid]) {
        if (pid && isProcessAlive(pid)) process.kill(pid)
      }
    } catch {
      // Best-effort cleanup for a process that the service already terminated.
    }
  }
}

async function createFixture(): Promise<TestFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pulse-auto-sync-test-'))
  const workspaceRoot = path.join(root, 'workspace')
  const workRoot = path.join(root, 'work')
  const audioPath = path.join(root, 'track.wav')
  await mkdir(workspaceRoot, { recursive: true })
  await mkdir(workRoot, { recursive: true })
  await writeFile(audioPath, Buffer.from('mock audio bytes'))
  const tracks = new Map<string, AutoSyncTrackSource>()
  const events: Array<{ event: JobEvent; job: AutoSyncJob }> = []
  const logs = {
    info: [] as LogEntry[],
    warn: [] as LogEntry[],
    error: [] as LogEntry[],
  }
  const logger: AutoSyncLogger = {
    info: (message, details) => logs.info.push({ message, details }),
    warn: (message, details) => logs.warn.push({ message, details }),
    error: (message, details) => logs.error.push({ message, details }),
  }
  const options: AutoSyncServiceOptions = {
    workspaceRoot,
    workRoot,
    resolveTrack: (trackId) => tracks.get(trackId) ?? null,
    emit: (event, job) => events.push({ event, job }),
    logger,
    workerOverride: {
      command: process.execPath,
      script: MOCK_WORKER,
      gpuName: 'Mock RTX 3060',
    },
  }
  return {
    root,
    workspaceRoot,
    workRoot,
    audioPath,
    tracks,
    events,
    logs,
    service: new AutoSyncService(options),
  }
}

async function disposeFixture(fixture: TestFixture) {
  await fixture.service.shutdown().catch(() => undefined)
  await cleanupMockProcesses(fixture.workspaceRoot)
  await rm(fixture.root, { recursive: true, force: true })
}

async function withFixture(callback: (fixture: TestFixture) => Promise<void>) {
  const fixture = await createFixture()
  try {
    await callback(fixture)
  } finally {
    await disposeFixture(fixture)
  }
}

async function run(name: string, test: () => Promise<void>) {
  await test()
  process.stdout.write(`AUTO_SYNC_TEST_OK ${name}\n`)
}

await run('availability requirements', () =>
  withFixture(async (fixture) => {
    fixture.tracks.set(
      TRACK_NORMAL,
      trackSource(TRACK_NORMAL, fixture.audioPath),
    )
    fixture.tracks.set(
      TRACK_SLOW,
      trackSource(TRACK_SLOW, path.join(fixture.root, 'missing.wav')),
    )
    fixture.tracks.set(
      TRACK_LOW_QUALITY,
      trackSource(TRACK_LOW_QUALITY, fixture.audioPath, {
        plainLyrics: '한 줄뿐인 가사',
      }),
    )
    fixture.tracks.set(
      TRACK_OOM,
      trackSource(TRACK_OOM, fixture.audioPath, {
        syncedLyrics: undefined,
      }),
    )

    const ready = await fixture.service.getAvailability(TRACK_NORMAL)
    assert.equal(ready.available, true)
    assert.equal(ready.device, 'cuda')
    assert.equal(ready.gpuName, 'Mock RTX 3060')
    assert.deepEqual(ready.missingRequirements, [])

    const missingAudio = await fixture.service.getAvailability(TRACK_SLOW)
    assert.equal(missingAudio.available, false)
    assert.deepEqual(missingAudio.missingRequirements, ['audio'])
    await assertStartError(fixture.service.start(TRACK_SLOW), 'audio-missing')

    const missingPlain =
      await fixture.service.getAvailability(TRACK_LOW_QUALITY)
    assert.equal(missingPlain.available, false)
    assert.deepEqual(missingPlain.missingRequirements, ['plain-lyrics'])
    await assertStartError(
      fixture.service.start(TRACK_LOW_QUALITY),
      'plain-lyrics-missing',
    )

    const plainOnly = await fixture.service.getAvailability(TRACK_OOM)
    assert.equal(plainOnly.available, true)
    assert.deepEqual(plainOnly.missingRequirements, [])
  }),
)

await run('plain-only result produces a separate safe generated timeline', () =>
  withFixture(async (fixture) => {
    fixture.tracks.set(
      TRACK_OTHER,
      trackSource(TRACK_OTHER, fixture.audioPath, {
        syncedLyrics: undefined,
      }),
    )
    await fixture.service.start(TRACK_OTHER)
    const completed = await waitForJob(fixture.service, TRACK_OTHER, [
      'completed',
      'failed',
    ])
    assert.equal(
      completed.status,
      'completed',
      `plain-only mock failed: ${JSON.stringify(fixture.logs)}`,
    )
    await waitForIdle(fixture.service)
    const timeline = completed.result?.generatedLyricsTimeline
    assert.ok(timeline)
    assert.deepEqual(
      timeline.lines.map((line) => line.lineIndex),
      [0, 2, 3],
      'the 0.70 confidence line must not enter the generated timeline',
    )
    assert.equal(completed.result?.canApply, true)
    assert.doesNotThrow(() =>
      validateGeneratedLyricsTimeline(timeline, plainLyrics),
    )
  }),
)

await run('plain-only reverse timing is excluded from automatic apply', () =>
  withFixture(async (fixture) => {
    fixture.tracks.set(
      TRACK_REVERSE,
      trackSource(TRACK_REVERSE, fixture.audioPath, {
        syncedLyrics: undefined,
      }),
    )
    await fixture.service.start(TRACK_REVERSE)
    const completed = await waitForJob(fixture.service, TRACK_REVERSE, [
      'completed',
    ])
    await waitForIdle(fixture.service)
    assert.deepEqual(
      completed.result?.generatedLyricsTimeline?.lines.map(
        (line) => line.lineIndex,
      ),
      [0, 3],
    )
    assert.equal(completed.result?.canApply, false)
  }),
)

await run('JSONL progress completion and track isolation', () =>
  withFixture(async (fixture) => {
    fixture.tracks.set(
      TRACK_NORMAL,
      trackSource(TRACK_NORMAL, fixture.audioPath),
    )
    const started = await fixture.service.start(TRACK_NORMAL)
    assert.equal(started.status, 'running')
    const completed = await waitForJob(fixture.service, TRACK_NORMAL, [
      'completed',
      'failed',
      'cancelled',
    ])
    assert.equal(
      completed.status,
      'completed',
      JSON.stringify({ error: completed.error, logs: fixture.logs }, null, 2),
    )
    await waitForIdle(fixture.service)
    await waitFor(
      async () =>
        !(await exists(path.join(fixture.workRoot, 'jobs', started.jobId))),
      'completed job temp cleanup',
    )

    assert.equal(completed.result?.trackId, TRACK_NORMAL)
    assert.equal(completed.result?.canApply, true)
    assert.equal(completed.result?.cacheHit, false)
    assert.equal(completed.result?.lyricsSyncProfile.source, 'ai')
    assert.equal(completed.result?.peakGpuMemoryMiB, 4_321)
    assert.deepEqual(completed.result?.lowConfidenceLines, [
      { lineIndex: 1, confidence: 0.7 },
    ])
    assert.equal(fixture.service.getJob(TRACK_OTHER), null)
    assert.ok(
      fixture.events.some(
        ({ event, job }) =>
          event === 'progress' &&
          job.trackId === TRACK_NORMAL &&
          job.stage === 'transcribing',
      ),
    )
    assert.equal(
      fixture.events.filter(({ event }) => event === 'completed').length,
      1,
    )
    assert.ok(
      fixture.logs.info.some(({ details }) => details === '{malformed-json'),
      'malformed JSON should be treated as an ordinary worker log',
    )
    assert.ok(
      fixture.logs.info.some(
        ({ details }) =>
          typeof details === 'string' && details.includes('"progress":4'),
      ),
      'schema-invalid JSON should be ignored without failing the job',
    )
  }),
)

await run('single global job and duplicate blocking', () =>
  withFixture(async (fixture) => {
    fixture.tracks.set(TRACK_SLOW, trackSource(TRACK_SLOW, fixture.audioPath))
    fixture.tracks.set(
      TRACK_NORMAL,
      trackSource(TRACK_NORMAL, fixture.audioPath),
    )
    const running = await fixture.service.start(TRACK_SLOW)
    assert.equal(fixture.service.discard(running.jobId), false)
    const serviceInternals = fixture.service as unknown as {
      baseAvailability: { checkedAt: number }
    }
    serviceInternals.baseAvailability.checkedAt = 1
    const otherAvailability =
      await fixture.service.getAvailability(TRACK_NORMAL)
    assert.equal(otherAvailability.available, false)
    assert.ok(otherAvailability.missingRequirements.includes('job-active'))
    assert.equal(
      serviceInternals.baseAvailability.checkedAt,
      1,
      'an active GPU job must suppress the stale environment probe',
    )
    await assertStartError(fixture.service.start(TRACK_NORMAL), 'duplicate-job')
    assert.equal(await fixture.service.cancel(running.jobId), true)
    const cancelled = await waitForEmittedJob(
      fixture,
      TRACK_SLOW,
      'failed',
      'cancelled',
    )
    assert.equal(cancelled.error?.code, 'cancelled')
    await waitForIdle(fixture.service)
    assert.equal(fixture.service.getJob(TRACK_SLOW), null)
  }),
)

await run('mismatched worker result rejection', () =>
  withFixture(async (fixture) => {
    fixture.tracks.set(
      TRACK_MISMATCH,
      trackSource(TRACK_MISMATCH, fixture.audioPath),
    )
    await fixture.service.start(TRACK_MISMATCH)
    const failed = await waitForJob(fixture.service, TRACK_MISMATCH, ['failed'])
    await waitForIdle(fixture.service)
    assert.equal(failed.error?.code, 'profile-invalid')
    assert.equal(failed.result, undefined)
    assert.equal(fixture.service.getJob(TRACK_NORMAL), null)
    assert.ok(
      fixture.events.some(
        ({ event, job }) =>
          event === 'failed' && job.trackId === TRACK_MISMATCH,
      ),
    )
  }),
)

await run('low quality result remains preview-only', () =>
  withFixture(async (fixture) => {
    fixture.tracks.set(
      TRACK_LOW_QUALITY,
      trackSource(TRACK_LOW_QUALITY, fixture.audioPath),
    )
    await fixture.service.start(TRACK_LOW_QUALITY)
    const completed = await waitForJob(fixture.service, TRACK_LOW_QUALITY, [
      'completed',
    ])
    await waitForIdle(fixture.service)
    assert.equal(completed.result?.matchedLines, 2)
    assert.equal(completed.result?.canApply, false)
    assert.match(completed.result?.qualityMessage ?? '', /신뢰도가 너무 낮/)
  }),
)

await run('OOM error classification', () =>
  withFixture(async (fixture) => {
    fixture.tracks.set(TRACK_OOM, trackSource(TRACK_OOM, fixture.audioPath))
    await fixture.service.start(TRACK_OOM)
    const failed = await waitForJob(fixture.service, TRACK_OOM, ['failed'])
    await waitForIdle(fixture.service)
    assert.equal(failed.error?.code, 'gpu-out-of-memory')
    assert.doesNotMatch(failed.error?.message ?? '', /RuntimeError|traceback/i)
    assert.ok(
      fixture.logs.error.some(({ message }) =>
        message.includes('worker failure details'),
      ),
    )
  }),
)

await run('final result cache reuse and discard', () =>
  withFixture(async (fixture) => {
    fixture.tracks.set(
      TRACK_NORMAL,
      trackSource(TRACK_NORMAL, fixture.audioPath),
    )
    const first = await fixture.service.start(TRACK_NORMAL)
    const firstCompleted = await waitForJob(fixture.service, TRACK_NORMAL, [
      'completed',
    ])
    assert.equal(firstCompleted.result?.cacheHit, false)
    await waitForIdle(fixture.service)

    const second = await fixture.service.start(TRACK_NORMAL)
    const secondCompleted = await waitForJob(fixture.service, TRACK_NORMAL, [
      'completed',
    ])
    assert.equal(secondCompleted.jobId, second.jobId)
    assert.equal(secondCompleted.result?.cacheHit, true)
    await waitForIdle(fixture.service)

    const invocations = (
      await readFile(
        path.join(fixture.workspaceRoot, 'mock-worker-count.txt'),
        'utf8',
      )
    )
      .trim()
      .split(/\r?\n/)
    assert.deepEqual(invocations, [TRACK_NORMAL])
    assert.equal(fixture.service.discard(second.jobId), true)
    assert.equal(fixture.service.getJob(TRACK_NORMAL), null)
    assert.equal(fixture.service.discard(second.jobId), false)
    assert.equal(fixture.service.discard(first.jobId), true)
  }),
)

await run('completed result is rejected after lyrics change', () =>
  withFixture(async (fixture) => {
    fixture.tracks.set(
      TRACK_NORMAL,
      trackSource(TRACK_NORMAL, fixture.audioPath),
    )
    await fixture.service.start(TRACK_NORMAL)
    await waitForJob(fixture.service, TRACK_NORMAL, ['completed'])
    await waitForIdle(fixture.service)
    await assert.doesNotReject(
      fixture.service.assertResultCurrent(TRACK_NORMAL),
    )
    fixture.tracks.set(
      TRACK_NORMAL,
      trackSource(TRACK_NORMAL, fixture.audioPath, {
        plainLyrics: `${plainLyrics}\n변경된 줄`,
      }),
    )
    await assertStartError(
      fixture.service.assertResultCurrent(TRACK_NORMAL),
      'matching-failed',
    )
  }),
)

await run('cancel kills worker tree and cleans job temp', () =>
  withFixture(async (fixture) => {
    fixture.tracks.set(TRACK_TREE, trackSource(TRACK_TREE, fixture.audioPath))
    const started = await fixture.service.start(TRACK_TREE)
    const markerPath = path.join(
      fixture.workspaceRoot,
      `.mock-tree-${TRACK_TREE}.json`,
    )
    await waitFor(() => exists(markerPath), 'mock worker tree marker')
    const pids = await readTreePids(fixture.workspaceRoot, TRACK_TREE)
    assert.equal(await fixture.service.cancel(started.jobId), true)
    const cancelled = await waitForEmittedJob(
      fixture,
      TRACK_TREE,
      'failed',
      'cancelled',
    )
    assert.equal(cancelled.error?.code, 'cancelled')
    await waitForIdle(fixture.service)
    await waitFor(
      async () =>
        !(await exists(path.join(fixture.workRoot, 'jobs', started.jobId))),
      'cancelled job temp cleanup',
    )
    await waitFor(
      () => !isProcessAlive(pids.workerPid),
      'mock worker termination',
    )
    if (process.platform === 'win32')
      await waitFor(
        () => !isProcessAlive(pids.childPid),
        'mock worker descendant termination',
      )
    assert.equal(await fixture.service.cancel(started.jobId), false)
  }),
)

await run('shutdown drains work and removes job root', () =>
  withFixture(async (fixture) => {
    fixture.tracks.set(TRACK_TREE, trackSource(TRACK_TREE, fixture.audioPath))
    const started = await fixture.service.start(TRACK_TREE)
    const markerPath = path.join(
      fixture.workspaceRoot,
      `.mock-tree-${TRACK_TREE}.json`,
    )
    await waitFor(() => exists(markerPath), 'shutdown worker tree marker')
    const pids = await readTreePids(fixture.workspaceRoot, TRACK_TREE)
    await fixture.service.shutdown()
    const cancelled = await waitForEmittedJob(
      fixture,
      TRACK_TREE,
      'failed',
      'cancelled',
    )
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(fixture.service.getJob(TRACK_TREE), null)
    assert.equal(await exists(path.join(fixture.workRoot, 'jobs')), false)
    await waitFor(
      () => !isProcessAlive(pids.workerPid),
      'shutdown worker termination',
    )
    if (process.platform === 'win32')
      await waitFor(
        () => !isProcessAlive(pids.childPid),
        'shutdown worker descendant termination',
      )
    await assertStartError(
      fixture.service.start(TRACK_NORMAL),
      'service-unavailable',
    )
    assert.equal(started.trackId, TRACK_TREE)
  }),
)
