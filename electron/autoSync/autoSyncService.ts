import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import type {
  AutoSyncAvailability,
  AutoSyncErrorCode,
  AutoSyncJob,
  AutoSyncResult,
  AutoSyncStage,
  GeneratedLyricsTimeline,
  LyricsSyncProfile,
} from '../../src/types/models'
import { validateLyricsSyncProfile } from '../../src/utils/lyricsSync'
import {
  GENERATED_TIMELINE_MIN_CONFIDENCE,
  generatedLyricsLineHash,
  generatedLyricsTextHash,
  splitGeneratedLyricsText,
} from '../../src/utils/generatedLyricsTimeline'
import {
  AutoSyncError,
  autoSyncErrorMessage,
  toAutoSyncError,
} from './autoSyncErrors'
import { AutoSyncProcess } from './autoSyncProcess'
import {
  AUTO_SYNC_STAGES,
  autoSyncOutputSchema,
  type AutoSyncLogger,
  type AutoSyncTrackSource,
  type AutoSyncWorkerEvent,
  type AutoSyncWorkerOutput,
} from './autoSyncTypes'

const MODEL_FILENAME = 'model_bs_roformer_ep_317_sdr_12.9755.ckpt'
const MODEL_CONFIG_FILENAME = 'model_bs_roformer_ep_317_sdr_12.9755.yaml'
const WHISPER_MODEL = 'large-v3'
const MAX_RESULT_BYTES = 25 * 1024 * 1024
const CACHE_ENTRIES_TO_KEEP = 3
const LRC_TIMESTAMP = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g
const WHISPER_REQUIRED_FILES = [
  'model.bin',
  'config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'vocabulary.json',
] as const

type JobEvent = 'progress' | 'completed' | 'failed'

interface WorkerOverride {
  command: string
  script: string
  gpuName?: string
}

export interface AutoSyncServiceOptions {
  workspaceRoot: string
  workRoot: string
  resolveTrack: (
    trackId: string,
  ) => AutoSyncTrackSource | null | Promise<AutoSyncTrackSource | null>
  emit: (event: JobEvent, job: AutoSyncJob) => void
  logger: AutoSyncLogger
  workerOverride?: WorkerOverride
  availabilityOverride?: AutoSyncAvailability
}

interface PreparedTrack extends AutoSyncTrackSource {
  lines: string[]
  syncedLyrics: string
  timelineMode: 'timed' | 'generated'
  actualFileSize: number
  actualModifiedAt: number
}

interface PreparedTrackResult {
  track: PreparedTrack | null
  missingRequirements: string[]
}

interface PythonProbeResult {
  packages: Record<string, boolean>
  cudaAvailable: boolean
  gpuName?: string
}

const unavailableReasons: Record<string, string> = {
  python: '자동 싱크용 Python 실행 환경이 없습니다.',
  'python-packages': '필요한 Python 패키지가 설치되지 않았습니다.',
  cuda: 'CUDA를 사용할 수 없습니다.',
  'nvidia-gpu': 'CUDA를 지원하는 NVIDIA GPU를 찾지 못했습니다.',
  'separator-checkpoint': 'BS-RoFormer 체크포인트가 없습니다.',
  'separator-config': 'BS-RoFormer 모델 설정 파일이 없습니다.',
  'whisper-model': 'Whisper large-v3 로컬 모델이 없습니다.',
  ffmpeg: 'FFmpeg 실행 파일이 없습니다.',
  'poc-script': '자동 싱크 PoC 스크립트가 없습니다.',
  'cache-write': '자동 싱크 작업 또는 캐시 폴더에 쓸 수 없습니다.',
  track: '곡 정보를 찾지 못했습니다.',
  audio: '원본 오디오 파일을 찾지 못했습니다.',
  'plain-lyrics': '두 줄 이상의 일반 가사가 필요합니다.',
  'synced-lyrics': '원본 타임스탬프가 있는 동기화 가사가 필요합니다.',
  'job-active': '다른 자동 싱크 작업이 이미 진행 중입니다.',
}

const requirementErrors: Record<string, AutoSyncErrorCode> = {
  python: 'python-missing',
  'python-packages': 'package-missing',
  cuda: 'cuda-unavailable',
  'nvidia-gpu': 'cuda-unavailable',
  'separator-checkpoint': 'separator-model-missing',
  'separator-config': 'separator-model-missing',
  'whisper-model': 'whisper-model-missing',
  ffmpeg: 'ffmpeg-missing',
  audio: 'audio-missing',
  'plain-lyrics': 'plain-lyrics-missing',
  'synced-lyrics': 'synced-lyrics-missing',
  'job-active': 'duplicate-job',
}

function cloneJob(job: AutoSyncJob): AutoSyncJob {
  return structuredClone(job)
}

function lyricsLines(value: string | undefined): string[] {
  return splitGeneratedLyricsText(value ?? '')
}

function hasOriginalTimestamps(value: string | undefined): value is string {
  if (!value) return false
  const matches = value.match(LRC_TIMESTAMP)
  return Boolean(matches?.length)
}

function syntheticSyncedLyrics(
  lines: string[],
  durationSeconds: number | undefined,
): string {
  const durationMs =
    durationSeconds && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? Math.round(durationSeconds * 1_000)
      : (lines.length + 1) * 6_000
  const startMs = Math.min(30_000, Math.round(durationMs * 0.08))
  const endMs = Math.max(startMs, Math.round(durationMs * 0.92))
  return lines
    .map((line, index) => {
      const timeMs = Math.round(
        startMs + ((endMs - startMs) * index) / Math.max(1, lines.length - 1),
      )
      const minutes = Math.floor(timeMs / 60_000)
      const seconds = Math.floor((timeMs % 60_000) / 1_000)
      const milliseconds = timeMs % 1_000
      return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}]${line}`
    })
    .join('\n')
}

function reasonFor(missingRequirements: string[]): string | undefined {
  const first = missingRequirements[0]
  return first
    ? (unavailableReasons[first] ?? '자동 싱크 환경을 확인해 주세요.')
    : undefined
}

function errorForRequirement(requirement: string): AutoSyncError {
  const code = requirementErrors[requirement] ?? 'service-unavailable'
  return new AutoSyncError(code, unavailableReasons[requirement])
}

async function isWritableDirectory(directory: string): Promise<boolean> {
  try {
    await mkdir(directory, { recursive: true })
    const probe = path.join(directory, `.write-test-${randomUUID()}`)
    await writeFile(probe, '')
    await unlink(probe)
    return true
  } catch {
    return false
  }
}

async function isNonEmptyFile(filePath: string): Promise<boolean> {
  try {
    const fileStats = await stat(filePath)
    return fileStats.isFile() && fileStats.size > 0
  } catch {
    return false
  }
}

async function findFile(
  root: string,
  fileName: string,
): Promise<string | null> {
  if (!existsSync(root)) return null
  const pending = [root]
  while (pending.length) {
    const current = pending.shift()!
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name)
      if (
        entry.isFile() &&
        entry.name.toLowerCase() === fileName.toLowerCase() &&
        (await isNonEmptyFile(entryPath))
      )
        return entryPath
      if (entry.isDirectory()) pending.push(entryPath)
    }
  }
  return null
}

async function findCompleteWhisperModel(
  cacheRoot: string,
): Promise<string | null> {
  const snapshots = path.join(
    cacheRoot,
    'whisper',
    'models--Systran--faster-whisper-large-v3',
    'snapshots',
  )
  if (!existsSync(snapshots)) return null
  const entries = await readdir(snapshots, { withFileTypes: true }).catch(
    () => [],
  )
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const snapshot = path.join(snapshots, entry.name)
    const complete = (
      await Promise.all(
        WHISPER_REQUIRED_FILES.map((name) =>
          isNonEmptyFile(path.join(snapshot, name)),
        ),
      )
    ).every(Boolean)
    if (complete) return snapshot
  }
  return null
}

async function computeModelFingerprint(
  checkpoint: string,
  checkpointConfig: string,
  whisperSnapshot: string,
): Promise<string> {
  const files = [
    checkpoint,
    checkpointConfig,
    ...WHISPER_REQUIRED_FILES.map((name) => path.join(whisperSnapshot, name)),
  ]
  const signatures = await Promise.all(
    files.map(async (filePath) => {
      const fileStats = await stat(filePath)
      return [path.basename(filePath), fileStats.size, fileStats.mtimeMs]
    }),
  )
  const hash = createHash('sha256')
    .update(path.basename(whisperSnapshot))
    .update(JSON.stringify(signatures))
  for (const filePath of [
    checkpointConfig,
    path.join(whisperSnapshot, 'config.json'),
    path.join(whisperSnapshot, 'preprocessor_config.json'),
  ])
    hash.update(await readFile(filePath))
  return hash.digest('hex')
}

async function runPythonProbe(
  pythonPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<PythonProbeResult> {
  if (signal.aborted) throw new Error('Python probe cancelled')
  const source = [
    'import importlib.util, json',
    "names = ['audio_separator', 'faster_whisper', 'rapidfuzz', 'torch']",
    'packages = {name: importlib.util.find_spec(name) is not None for name in names}',
    'cuda = False',
    'gpu = None',
    "if packages['torch']:",
    ' import torch',
    ' cuda = bool(torch.cuda.is_available())',
    ' gpu = torch.cuda.get_device_name(0) if cuda else None',
    "print(json.dumps({'packages': packages, 'cudaAvailable': cuda, 'gpuName': gpu}))",
  ].join('\n')
  const child = spawn(pythonPath, ['-c', source], {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const abort = () => child.kill()
  signal.addEventListener('abort', abort, { once: true })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout = (stdout + chunk).slice(-64 * 1024)
  })
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-64 * 1024)
  })
  const timeout = setTimeout(() => child.kill(), 30_000)
  let code: number | null
  try {
    ;[code] = (await once(child, 'close')) as [number | null]
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
  }
  if (signal.aborted) throw new Error('Python probe cancelled')
  if (code !== 0) throw new Error(stderr || 'Python probe failed')
  return JSON.parse(stdout.trim()) as PythonProbeResult
}

export class AutoSyncService {
  private readonly jobs = new Map<string, AutoSyncJob>()
  private readonly latestJobByTrack = new Map<string, string>()
  private readonly cancelledJobs = new Set<string>()
  private readonly workerCacheHits = new Set<string>()
  private readonly resultCacheKeys = new Map<string, string>()
  private baseAvailability: AutoSyncAvailability = {
    available: false,
    device: null,
    missingRequirements: ['service'],
    reason: '자동 싱크 환경을 확인하는 중입니다.',
    checkedAt: 0,
  }
  private initializePromise: Promise<AutoSyncAvailability> | null = null
  private availabilityRefreshPromise: Promise<void> | null = null
  private readonly lifecycleController = new AbortController()
  private activeJobId: string | null = null
  private activeProcess: AutoSyncProcess | null = null
  private activeExecution: Promise<void> | null = null
  private startReserved = false
  private shuttingDown = false
  private operationGeneration = 0
  private ffmpegPath: string | null = null
  private modelFingerprint = 'unavailable'

  constructor(private readonly options: AutoSyncServiceOptions) {}

  initialize(): Promise<AutoSyncAvailability> {
    this.initializePromise ??= this.initializeInternal()
    return this.initializePromise
  }

  private async initializeInternal(): Promise<AutoSyncAvailability> {
    const jobsRoot = path.join(this.options.workRoot, 'jobs')
    try {
      await rm(jobsRoot, { recursive: true, force: true })
      await mkdir(jobsRoot, { recursive: true })
    } catch (error) {
      this.options.logger.error(
        'Auto-sync job directory initialization failed',
        error,
      )
      this.baseAvailability = {
        available: false,
        device: null,
        missingRequirements: ['cache-write'],
        reason: unavailableReasons['cache-write'],
        checkedAt: Date.now(),
      }
      return { ...this.baseAvailability }
    }
    this.baseAvailability = await this.detectAvailability()
    return { ...this.baseAvailability }
  }

  private async detectAvailability(): Promise<AutoSyncAvailability> {
    const checkedAt = Date.now()
    if (this.options.availabilityOverride) {
      this.modelFingerprint = 'availability-override'
      return { ...this.options.availabilityOverride, checkedAt }
    }
    if (this.options.workerOverride) {
      this.modelFingerprint = createHash('sha256')
        .update(this.options.workerOverride.command)
        .update('\0')
        .update(this.options.workerOverride.script)
        .digest('hex')
      return {
        available: true,
        device: 'cuda',
        gpuName: this.options.workerOverride.gpuName ?? 'Test GPU',
        modelName: WHISPER_MODEL,
        missingRequirements: [],
        checkedAt,
      }
    }

    const missing: string[] = []
    const workspace = this.options.workspaceRoot
    const cacheRoot = path.join(workspace, '.poc-cache')
    const pythonPath = path.join(
      workspace,
      '.venv-auto-sync',
      'Scripts',
      'python.exe',
    )
    const scriptPath = path.join(
      workspace,
      'tools',
      'auto-sync-poc',
      'auto_sync_poc.py',
    )
    const checkpoint = path.join(cacheRoot, 'models', MODEL_FILENAME)
    const checkpointConfig = path.join(
      cacheRoot,
      'models',
      MODEL_CONFIG_FILENAME,
    )
    const [pythonReady, scriptReady, checkpointReady, checkpointConfigReady] =
      await Promise.all([
        isNonEmptyFile(pythonPath),
        isNonEmptyFile(scriptPath),
        isNonEmptyFile(checkpoint),
        isNonEmptyFile(checkpointConfig),
      ])
    if (!pythonReady) missing.push('python')
    if (!scriptReady) missing.push('poc-script')
    if (!checkpointReady) missing.push('separator-checkpoint')
    if (!checkpointConfigReady) missing.push('separator-config')
    const whisperSnapshot = await findCompleteWhisperModel(cacheRoot)
    if (!whisperSnapshot) missing.push('whisper-model')
    this.ffmpegPath = await findFile(
      path.join(cacheRoot, 'ffmpeg'),
      'ffmpeg.exe',
    )
    if (!this.ffmpegPath) missing.push('ffmpeg')
    if (
      !(await isWritableDirectory(this.options.workRoot)) ||
      !(await isWritableDirectory(path.join(cacheRoot, 'auto-sync')))
    )
      missing.push('cache-write')
    if (checkpointReady && checkpointConfigReady && whisperSnapshot) {
      try {
        this.modelFingerprint = await computeModelFingerprint(
          checkpoint,
          checkpointConfig,
          whisperSnapshot,
        )
      } catch (error) {
        this.options.logger.error('Auto-sync model fingerprint failed', error)
        missing.push('whisper-model')
        this.modelFingerprint = 'unavailable'
      }
    }

    let probe: PythonProbeResult | undefined
    if (pythonReady) {
      try {
        probe = await runPythonProbe(
          pythonPath,
          workspace,
          this.processEnvironment(),
          this.lifecycleController.signal,
        )
        const missingPackages = Object.entries(probe.packages)
          .filter(([, available]) => !available)
          .map(([name]) => name)
        if (missingPackages.length) {
          missing.push('python-packages')
          missing.push(
            ...missingPackages.map((name) => `python-package:${name}`),
          )
        }
        if (!probe.cudaAvailable) missing.push('cuda')
        if (!probe.gpuName) missing.push('nvidia-gpu')
      } catch (error) {
        this.options.logger.error('Auto-sync Python probe failed', error)
        missing.push('python-packages')
      }
    }
    const uniqueMissing = [...new Set(missing)]
    return {
      available: uniqueMissing.length === 0,
      device: probe?.cudaAvailable ? 'cuda' : null,
      gpuName: probe?.gpuName,
      modelName: WHISPER_MODEL,
      missingRequirements: uniqueMissing,
      reason: reasonFor(uniqueMissing),
      checkedAt,
    }
  }

  async getAvailability(trackId: string): Promise<AutoSyncAvailability> {
    await this.initialize()
    const busy = Boolean(this.activeJobId || this.startReserved)
    if (!busy) await this.refreshBaseAvailability(false)
    const prepared = await this.prepareTrack(trackId)
    return this.availabilityForPreparedTrack(prepared, busy)
  }

  private availabilityForPreparedTrack(
    prepared: PreparedTrackResult,
    busy: boolean,
  ): AutoSyncAvailability {
    const missing = [
      ...this.baseAvailability.missingRequirements,
      ...prepared.missingRequirements,
    ]
    if (busy) missing.push('job-active')
    const uniqueMissing = [...new Set(missing)]
    return {
      ...this.baseAvailability,
      available: uniqueMissing.length === 0,
      missingRequirements: uniqueMissing,
      reason: reasonFor(uniqueMissing),
      checkedAt: Date.now(),
    }
  }

  getJob(trackId: string): AutoSyncJob | null {
    const jobId = this.latestJobByTrack.get(trackId)
    const job = jobId ? this.jobs.get(jobId) : undefined
    return job ? cloneJob(job) : null
  }

  hasActiveJob(): boolean {
    return Boolean(this.activeJobId)
  }

  async start(trackId: string): Promise<AutoSyncJob> {
    if (this.shuttingDown) throw new AutoSyncError('service-unavailable')
    if (this.startReserved || this.activeJobId)
      throw new AutoSyncError('duplicate-job')
    this.startReserved = true
    const generation = this.operationGeneration
    try {
      await this.initialize()
      this.assertStartAllowed(generation)
      await this.refreshBaseAvailability(true)
      this.assertStartAllowed(generation)
      const prepared = await this.prepareTrack(trackId)
      const availability = this.availabilityForPreparedTrack(prepared, false)
      if (!availability.available)
        throw errorForRequirement(
          availability.missingRequirements[0] ?? 'service',
        )
      this.assertStartAllowed(generation)
      if (!prepared.track)
        throw errorForRequirement(prepared.missingRequirements[0] ?? 'track')
      const now = Date.now()
      const job: AutoSyncJob = {
        jobId: randomUUID(),
        trackId,
        status: 'running',
        stage: 'preparing',
        overallProgress: 0,
        stageProgress: null,
        completedStages: 0,
        totalStages: AUTO_SYNC_STAGES.length,
        elapsedMs: 0,
        modelName: WHISPER_MODEL,
        message: '자동 싱크 작업을 준비하는 중입니다.',
        createdAt: now,
        updatedAt: now,
      }
      this.jobs.set(job.jobId, job)
      this.latestJobByTrack.set(trackId, job.jobId)
      this.activeJobId = job.jobId
      this.options.emit('progress', cloneJob(job))
      this.activeExecution = this.execute(job, prepared.track).finally(() => {
        this.activeExecution = null
      })
      return cloneJob(job)
    } finally {
      this.startReserved = false
    }
  }

  async cancel(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId)
    if (!job || job.status !== 'running' || this.activeJobId !== jobId)
      return false
    this.cancelledJobs.add(jobId)
    await this.activeProcess?.cancel()
    return true
  }

  discard(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (!job || job.status === 'running') return false
    this.jobs.delete(jobId)
    this.resultCacheKeys.delete(jobId)
    if (this.latestJobByTrack.get(job.trackId) === jobId)
      this.latestJobByTrack.delete(job.trackId)
    return true
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      await this.activeExecution?.catch(() => undefined)
      return
    }
    this.shuttingDown = true
    this.operationGeneration += 1
    this.lifecycleController.abort()
    if (this.activeJobId) await this.cancel(this.activeJobId)
    await this.waitForPendingStart()
    if (this.activeExecution)
      await Promise.race([
        this.activeExecution.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 12_000)),
      ])
    await rm(path.join(this.options.workRoot, 'jobs'), {
      recursive: true,
      force: true,
    }).catch(() => undefined)
  }

  async cancelActiveAndDrain(): Promise<void> {
    this.operationGeneration += 1
    if (this.activeJobId) await this.cancel(this.activeJobId)
    await this.waitForPendingStart()
    if (this.activeExecution) await this.activeExecution.catch(() => undefined)
  }

  async assertResultCurrent(trackId: string): Promise<void> {
    const jobId = this.latestJobByTrack.get(trackId)
    const job = jobId ? this.jobs.get(jobId) : undefined
    const expectedCacheKey = jobId ? this.resultCacheKeys.get(jobId) : undefined
    if (!job || job.status !== 'completed' || !expectedCacheKey)
      throw new AutoSyncError(
        'matching-failed',
        '적용할 자동 싱크 결과를 찾지 못했습니다.',
      )
    const current = await this.prepareTrack(trackId)
    if (!current.track || this.cacheKey(current.track) !== expectedCacheKey)
      throw new AutoSyncError(
        'matching-failed',
        '분석 완료 후 곡 파일 또는 가사가 변경되어 결과를 적용할 수 없습니다.',
      )
  }

  private async refreshBaseAvailability(force: boolean): Promise<void> {
    if (
      !force &&
      this.baseAvailability.checkedAt > 0 &&
      Date.now() - this.baseAvailability.checkedAt < 60_000
    )
      return
    this.availabilityRefreshPromise ??= this.detectAvailability()
      .then((availability) => {
        this.baseAvailability = availability
      })
      .finally(() => {
        this.availabilityRefreshPromise = null
      })
    await this.availabilityRefreshPromise
  }

  private assertStartAllowed(generation: number) {
    if (this.shuttingDown || generation !== this.operationGeneration)
      throw new AutoSyncError('service-unavailable')
  }

  private async waitForPendingStart() {
    for (let attempt = 0; attempt < 200 && this.startReserved; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 25))
  }

  private async prepareTrack(trackId: string): Promise<PreparedTrackResult> {
    let source: AutoSyncTrackSource | null
    try {
      source = await this.options.resolveTrack(trackId)
    } catch (error) {
      this.options.logger.error('Auto-sync track lookup failed', error)
      return { track: null, missingRequirements: ['track'] }
    }
    if (!source || source.trackId !== trackId)
      return { track: null, missingRequirements: ['track'] }
    let fileStats
    try {
      fileStats = await stat(source.audioPath)
    } catch {
      return { track: null, missingRequirements: ['audio'] }
    }
    if (!fileStats.isFile())
      return { track: null, missingRequirements: ['audio'] }
    const originalSyncedLyrics = source.syncedLyrics
    const lines = lyricsLines(source.plainLyrics || originalSyncedLyrics)
    const missing: string[] = []
    if (lines.length < 2) missing.push('plain-lyrics')
    if (missing.length) return { track: null, missingRequirements: missing }
    const timelineMode = hasOriginalTimestamps(originalSyncedLyrics)
      ? 'timed'
      : 'generated'
    const syncedLyrics =
      timelineMode === 'timed'
        ? originalSyncedLyrics!
        : syntheticSyncedLyrics(lines, source.duration)
    return {
      track: {
        ...source,
        lines,
        syncedLyrics,
        timelineMode,
        actualFileSize: fileStats.size,
        actualModifiedAt: fileStats.mtimeMs,
      },
      missingRequirements: [],
    }
  }

  private cacheKey(track: PreparedTrack): string {
    return createHash('sha256')
      .update(track.trackId)
      .update('\0')
      .update(String(track.actualFileSize))
      .update('\0')
      .update(String(track.actualModifiedAt))
      .update('\0')
      .update(track.lines.join('\n'))
      .update('\0')
      .update(track.syncedLyrics)
      .update('\0')
      .update(track.timelineMode)
      .update('\0')
      .update(`${this.modelFingerprint}:0.66:ja`)
      .digest('hex')
  }

  private async execute(job: AutoSyncJob, track: PreparedTrack): Promise<void> {
    const jobDirectory = path.join(this.options.workRoot, 'jobs', job.jobId)
    const workerTemp = path.join(jobDirectory, 'worker')
    const inputPath = path.join(jobDirectory, 'input.json')
    const outputPath = path.join(jobDirectory, 'result.json')
    const cacheKey = this.cacheKey(track)
    const cacheDirectory = path.join(
      this.options.workspaceRoot,
      '.poc-cache',
      'auto-sync',
      cacheKey,
    )
    const cachedResultPath = path.join(cacheDirectory, 'result.json')
    const startedAt = Date.now()
    try {
      await mkdir(workerTemp, { recursive: true })
      this.throwIfCancelled(job.jobId)
      const cached = await this.readValidatedResult(
        cachedResultPath,
        track,
        true,
      ).catch(async () => {
        await rm(cachedResultPath, { force: true }).catch(() => undefined)
        return null
      })
      if (cached) {
        this.throwIfCancelled(job.jobId)
        this.resultCacheKeys.set(job.jobId, cacheKey)
        await this.pruneCache(cacheKey)
        this.throwIfCancelled(job.jobId)
        this.completeJob(job, cached)
        return
      }

      await writeFile(
        inputPath,
        `${JSON.stringify(
          {
            trackId: track.trackId,
            audioPath: track.audioPath,
            plainLyrics: track.lines,
            syncedLyrics: track.syncedLyrics,
            language: 'ja',
            provider: {
              name: track.provider,
              source: track.providerSource,
            },
            workDirectory: workerTemp,
            resultPath: outputPath,
            settings: {
              whisperModel: WHISPER_MODEL,
              confidenceThreshold: 0.66,
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
      this.throwIfCancelled(job.jobId)
      const command =
        this.options.workerOverride?.command ??
        path.join(
          this.options.workspaceRoot,
          '.venv-auto-sync',
          'Scripts',
          'python.exe',
        )
      const script =
        this.options.workerOverride?.script ??
        path.join(
          this.options.workspaceRoot,
          'tools',
          'auto-sync-poc',
          'auto_sync_poc.py',
        )
      const args = [
        script,
        '--input',
        inputPath,
        '--output',
        outputPath,
        '--workspace',
        this.options.workspaceRoot,
        '--temp-root',
        workerTemp,
        '--cache-key',
        cacheKey,
        '--json-events',
      ]
      this.activeProcess = new AutoSyncProcess({
        command,
        args,
        cwd: this.options.workspaceRoot,
        env: this.processEnvironment(),
        logger: this.options.logger,
      })
      await this.activeProcess.run((event) =>
        this.handleWorkerEvent(job, event),
      )
      this.throwIfCancelled(job.jobId)
      const current = await this.prepareTrack(track.trackId)
      if (!current.track || this.cacheKey(current.track) !== cacheKey)
        throw new AutoSyncError(
          'matching-failed',
          '분석 중 곡 파일 또는 가사가 변경되어 결과를 폐기했습니다.',
        )
      this.updateStage(job, 'validating', null, '결과를 검증하는 중입니다.')
      const result = await this.readValidatedResult(
        outputPath,
        track,
        this.workerCacheHits.has(job.jobId),
      )
      if (!result) throw new AutoSyncError('profile-invalid')
      this.throwIfCancelled(job.jobId)
      await mkdir(cacheDirectory, { recursive: true })
      const rawResult = await readFile(outputPath)
      const cacheTemp = path.join(cacheDirectory, `.result-${randomUUID()}.tmp`)
      await writeFile(cacheTemp, rawResult)
      await rename(cacheTemp, cachedResultPath)
      this.throwIfCancelled(job.jobId)
      this.resultCacheKeys.set(job.jobId, cacheKey)
      await this.pruneCache(cacheKey)
      this.throwIfCancelled(job.jobId)
      this.completeJob(job, {
        ...result,
        processingTimeMs: Math.max(
          result.processingTimeMs,
          Date.now() - startedAt,
        ),
      })
    } catch (error) {
      const failure = this.cancelledJobs.has(job.jobId)
        ? new AutoSyncError('cancelled')
        : toAutoSyncError(error)
      job.status = failure.code === 'cancelled' ? 'cancelled' : 'failed'
      job.error = { code: failure.code, message: failure.message }
      job.message = failure.message
      job.elapsedMs = Date.now() - job.createdAt
      job.updatedAt = Date.now()
      job.stageProgress = null
      this.options.logger.error('Auto-sync job failed', {
        jobId: job.jobId,
        trackId: job.trackId,
        code: failure.code,
        error,
      })
      this.options.emit('failed', cloneJob(job))
    } finally {
      await this.activeProcess?.cancel().catch(() => undefined)
      this.activeProcess = null
      this.cancelledJobs.delete(job.jobId)
      this.workerCacheHits.delete(job.jobId)
      if (this.activeJobId === job.jobId) this.activeJobId = null
      if (job.status === 'cancelled') {
        this.jobs.delete(job.jobId)
        if (this.latestJobByTrack.get(job.trackId) === job.jobId)
          this.latestJobByTrack.delete(job.trackId)
      }
      if (job.status !== 'completed') this.resultCacheKeys.delete(job.jobId)
      await this.cleanupCacheTemporaryFiles(cacheDirectory)
      await rm(jobDirectory, { recursive: true, force: true }).catch((error) =>
        this.options.logger.warn('Auto-sync temp cleanup failed', error),
      )
    }
  }

  private handleWorkerEvent(job: AutoSyncJob, event: AutoSyncWorkerEvent) {
    if (
      (event.event === 'stage' || event.event === 'progress') &&
      event.cacheHit
    )
      this.workerCacheHits.add(job.jobId)
    if (event.event === 'stage')
      this.updateStage(
        job,
        event.stage,
        null,
        event.message,
        event.model,
        event.overallProgress,
      )
    else if (event.event === 'progress')
      this.updateStage(
        job,
        event.stage,
        event.indeterminate ? null : event.progress,
        event.message,
        undefined,
        event.overallProgress,
      )
  }

  private updateStage(
    job: AutoSyncJob,
    stage: AutoSyncStage,
    stageProgress: number | null,
    message?: string,
    model?: string,
    overallProgress?: number,
  ) {
    if (job.status !== 'running') return
    const stageIndex = Math.max(0, AUTO_SYNC_STAGES.indexOf(stage))
    job.stage = stage
    job.completedStages = stageIndex
    job.overallProgress =
      overallProgress ?? stageIndex / AUTO_SYNC_STAGES.length
    job.stageProgress = stageProgress
    job.elapsedMs = Date.now() - job.createdAt
    job.updatedAt = Date.now()
    if (message) job.message = message
    job.modelName =
      model ??
      (stage === 'separating' || stage === 'releasing-separator'
        ? MODEL_FILENAME
        : stage === 'transcribing'
          ? WHISPER_MODEL
          : job.modelName)
    this.options.emit('progress', cloneJob(job))
  }

  private completeJob(job: AutoSyncJob, result: AutoSyncResult) {
    job.status = 'completed'
    job.stage = 'validating'
    job.overallProgress = 1
    job.stageProgress = 1
    job.completedStages = AUTO_SYNC_STAGES.length
    job.elapsedMs = Date.now() - job.createdAt
    job.updatedAt = Date.now()
    job.result = result
    job.message = result.canApply
      ? '자동 싱크 초안이 준비되었습니다.'
      : result.qualityMessage
    this.options.emit('completed', cloneJob(job))
  }

  private throwIfCancelled(jobId: string) {
    if (this.cancelledJobs.has(jobId)) throw new AutoSyncError('cancelled')
  }

  private async readValidatedResult(
    resultPath: string,
    track: PreparedTrack,
    cacheHit: boolean,
  ): Promise<AutoSyncResult | null> {
    let resultStats
    try {
      resultStats = await stat(resultPath)
    } catch {
      if (cacheHit) return null
      throw new AutoSyncError(
        'process-failed',
        '자동 싱크 결과 파일이 없습니다.',
      )
    }
    if (
      !resultStats.isFile() ||
      resultStats.size <= 0 ||
      resultStats.size > MAX_RESULT_BYTES
    )
      throw new AutoSyncError('profile-invalid')
    let parsed: AutoSyncWorkerOutput
    try {
      parsed = autoSyncOutputSchema.parse(
        JSON.parse(await readFile(resultPath, 'utf8')),
      )
    } catch (error) {
      throw new AutoSyncError('profile-invalid', undefined, { cause: error })
    }
    return this.toPublicResult(parsed, track, cacheHit)
  }

  private toPublicResult(
    output: AutoSyncWorkerOutput,
    track: PreparedTrack,
    cacheHit: boolean,
  ): AutoSyncResult {
    if (
      output.trackId !== track.trackId ||
      output.lyricsSyncProfile.trackId !== track.trackId ||
      output.totalLines !== track.lines.length ||
      output.matchedLines !== output.anchors.length ||
      output.matchedLines !== output.lyricsSyncProfile.anchors.length ||
      output.matchedLines > output.totalLines
    )
      throw new AutoSyncError('profile-invalid')

    const matchedIndices = new Set<number>()
    for (let index = 0; index < output.anchors.length; index += 1) {
      const anchor = output.anchors[index]
      const profileAnchor = output.lyricsSyncProfile.anchors[index]
      if (
        anchor.lineIndex >= output.totalLines ||
        matchedIndices.has(anchor.lineIndex) ||
        anchor.lyricTimeMs !== profileAnchor.lyricTimeMs ||
        anchor.audioTimeMs !== profileAnchor.audioTimeMs
      )
        throw new AutoSyncError('profile-invalid')
      matchedIndices.add(anchor.lineIndex)
    }
    const unmatched = new Set(output.unmatchedLines)
    if (
      unmatched.size !== output.unmatchedLines.length ||
      output.unmatchedLines.some(
        (lineIndex) =>
          lineIndex >= output.totalLines || matchedIndices.has(lineIndex),
      ) ||
      unmatched.size + matchedIndices.size !== output.totalLines
    )
      throw new AutoSyncError('profile-invalid')

    if (
      output.diagnostics.bestConfidenceByLine.length !== output.totalLines ||
      output.metrics.whisperTokens !==
        output.diagnostics.whisperTokens.length ||
      output.diagnostics.whisperTokens.some(
        (token) => token.end_ms < token.start_ms,
      )
    )
      throw new AutoSyncError('profile-invalid')

    const lineTimings =
      output.diagnostics.lineTimings ??
      Array.from({ length: output.totalLines }, (_, lineIndex) => {
        const anchor = output.anchors.find((item) => item.lineIndex === lineIndex)
        return {
          lineIndex,
          source: anchor ? (anchor.source ?? 'direct') : 'unmatched',
          confidence: anchor?.confidence ?? 0,
          audioTimeMs: anchor?.audioTimeMs ?? null,
        }
      })
    if (
      lineTimings.length !== output.totalLines ||
      lineTimings.some((line, index) => line.lineIndex !== index)
    )
      throw new AutoSyncError('profile-invalid')

    let previousGeneratedAudioTimeMs = -1
    const safeGeneratedAnchors =
      track.timelineMode === 'generated'
        ? [...output.anchors]
            .sort((left, right) => left.lineIndex - right.lineIndex)
            .filter((anchor) => {
              if (
                anchor.confidence < GENERATED_TIMELINE_MIN_CONFIDENCE ||
                anchor.audioTimeMs <= previousGeneratedAudioTimeMs
              )
                return false
              previousGeneratedAudioTimeMs = anchor.audioTimeMs
              return true
            })
        : []
    let validated: LyricsSyncProfile
    try {
      validated = validateLyricsSyncProfile(
        track.timelineMode === 'generated'
          ? {
              ...output.lyricsSyncProfile,
              anchors: safeGeneratedAnchors.map(
                ({ lyricTimeMs, audioTimeMs }) => ({
                  lyricTimeMs,
                  audioTimeMs,
                }),
              ),
            }
          : output.lyricsSyncProfile,
      )
    } catch (error) {
      throw new AutoSyncError('profile-invalid', undefined, { cause: error })
    }
    const matchRate = output.matchedLines / output.totalLines
    const processingTimeMs = Math.round(output.metrics.totalSeconds * 1_000)
    const profile: LyricsSyncProfile = {
      ...validated,
      source: 'ai',
      autoSyncMetadata: {
        model: output.model.whisper,
        matchedLines: output.matchedLines,
        totalLines: output.totalLines,
        confidence: output.confidence,
        processingTimeMs,
      },
    }
    let generatedLyricsTimeline: GeneratedLyricsTimeline | undefined
    if (track.timelineMode === 'generated') {
      generatedLyricsTimeline = {
        trackId: track.trackId,
        source: 'ai',
        lines: safeGeneratedAnchors.map((anchor) => ({
          lineIndex: anchor.lineIndex,
          textHash: generatedLyricsLineHash(track.lines[anchor.lineIndex]),
          audioTimeMs: anchor.audioTimeMs,
          confidence: anchor.confidence,
          source: anchor.source,
        })),
        lineCount: track.lines.length,
        lyricsTextHash: generatedLyricsTextHash(track.lines.join('\n')),
        model: `${output.model.separator} · ${output.model.whisper}`,
        createdAt: Date.now(),
      }
    }
    const applicableLineCount =
      generatedLyricsTimeline?.lines.length ?? validated.anchors.length
    const applicableMatchRate = applicableLineCount / output.totalLines
    const canApply = applicableLineCount >= 3 && applicableMatchRate >= 0.4
    const outliers = output.diagnostics?.temporalOutlierLines ?? []
    if (
      new Set(outliers).size !== outliers.length ||
      outliers.some((lineIndex) => lineIndex >= output.totalLines)
    )
      throw new AutoSyncError('profile-invalid')
    return {
      trackId: output.trackId,
      model: output.model,
      matchedLines: output.matchedLines,
      totalLines: output.totalLines,
      matchRate,
      confidence: output.confidence,
      lyricsSyncProfile: profile,
      generatedLyricsTimeline,
      unmatchedLines: output.unmatchedLines,
      temporalOutlierLines: outliers,
      lowConfidenceLines: output.anchors
        .filter((anchor) => anchor.confidence < 0.75)
        .map((anchor) => ({
          lineIndex: anchor.lineIndex,
          confidence: anchor.confidence,
          ...(anchor.source ? { source: anchor.source } : {}),
        })),
      lineTimings,
      processingTimeMs,
      peakGpuMemoryMiB: output.metrics.gpuMemory?.peakMiB ?? null,
      canApply,
      qualityMessage: canApply
        ? undefined
        : '자동 싱크 초안의 신뢰도가 너무 낮습니다.',
      cacheHit,
    }
  }

  private processEnvironment(): NodeJS.ProcessEnv {
    const workspace = this.options.workspaceRoot
    const torchLib = path.join(
      workspace,
      '.venv-auto-sync',
      'Lib',
      'site-packages',
      'torch',
      'lib',
    )
    const additions = [
      this.ffmpegPath ? path.dirname(this.ffmpegPath) : '',
      torchLib,
      process.env.PATH ?? '',
    ].filter(Boolean)
    return {
      ...process.env,
      PATH: additions.join(path.delimiter),
      HF_HUB_DISABLE_XET: '1',
      PYTHONUTF8: '1',
    }
  }

  private async pruneCache(activeKey: string) {
    // A mock worker must never prune real developer caches during UI tests.
    if (this.options.workerOverride) return
    const cacheRoot = path.join(
      this.options.workspaceRoot,
      '.poc-cache',
      'auto-sync',
    )
    let entries
    try {
      entries = await readdir(cacheRoot, { withFileTypes: true })
    } catch {
      return
    }
    try {
      const directories = await Promise.all(
        entries
          .filter(
            (entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name),
          )
          .map(async (entry) => ({
            name: entry.name,
            modifiedAt: (await stat(path.join(cacheRoot, entry.name))).mtimeMs,
          })),
      )
      const retained = new Set(
        directories
          .sort((left, right) => right.modifiedAt - left.modifiedAt)
          .slice(0, CACHE_ENTRIES_TO_KEEP)
          .map((entry) => entry.name),
      )
      retained.add(activeKey)
      await Promise.all(
        directories
          .filter((entry) => !retained.has(entry.name))
          .map((entry) =>
            rm(path.join(cacheRoot, entry.name), {
              recursive: true,
              force: true,
            }),
          ),
      )
    } catch (error) {
      this.options.logger.warn('Auto-sync cache pruning failed', error)
    }
  }

  private async cleanupCacheTemporaryFiles(cacheDirectory: string) {
    let entries
    try {
      entries = await readdir(cacheDirectory, { withFileTypes: true })
    } catch {
      return
    }
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.startsWith('.') &&
            entry.name.endsWith('.tmp'),
        )
        .map((entry) =>
          rm(path.join(cacheDirectory, entry.name), { force: true }).catch(
            (error) =>
              this.options.logger.warn(
                'Auto-sync cache temp cleanup failed',
                error,
              ),
          ),
        ),
    )
  }
}

export function autoSyncRequirementMessage(requirement: string): string {
  return (
    unavailableReasons[requirement] ??
    autoSyncErrorMessage('service-unavailable')
  )
}
