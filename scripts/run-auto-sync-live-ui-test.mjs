import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:net'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import electron from 'electron'
import WebSocket from 'ws'

const root = process.cwd()
const trackId = process.env.PULSE_SHELF_AUTO_SYNC_TRACK_ID?.trim()
const plainOnly = process.env.PULSE_SHELF_AUTO_SYNC_PLAIN_ONLY_TEST === '1'
const allowCache = process.env.PULSE_SHELF_AUTO_SYNC_ALLOW_CACHE === '1'
const analysisTimeoutMs = 6 * 60 * 1_000
const realStorePath = path.join(
  process.env.APPDATA ?? '',
  'pulse-shelf-2',
  'pulse-shelf-data.json',
)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (process.platform !== 'win32')
  throw new Error('The live auto-sync UI test currently supports Windows only')
if (!/^[a-f0-9]{64}$/.test(trackId ?? ''))
  throw new Error(
    'PULSE_SHELF_AUTO_SYNC_TRACK_ID must be a 64-character lowercase hexadecimal track ID',
  )
if (!process.env.APPDATA)
  throw new Error('APPDATA is required to locate the real Pulse Shelf store')

function describeError(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

async function reservePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Could not reserve a local test port')
  }
  await new Promise((resolve) => server.close(resolve))
  return address.port
}

function startChild(label, command, args, env) {
  const child = spawn(command, args, {
    cwd: root,
    env,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.spawnError = null
  child.once('error', (error) => {
    child.spawnError = error
    process.stderr.write(`[${label}] ${describeError(error)}\n`)
  })
  const relay = (chunk) => process.stderr.write(`[${label}] ${chunk}`)
  child.stdout.on('data', relay)
  child.stderr.on('data', relay)
  return child
}

async function stopTree(child) {
  if (!child?.pid || child.exitCode !== null) return
  const killer = spawn(
    'taskkill.exe',
    ['/PID', String(child.pid), '/T', '/F'],
    {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
    },
  )
  await Promise.race([
    once(killer, 'exit').catch(() => undefined),
    delay(5_000),
  ])
  await Promise.race([once(child, 'exit').catch(() => undefined), delay(2_000)])
  child.stdout.destroy()
  child.stderr.destroy()
}

async function waitFor(check, label, timeout = 20_000, interval = 100) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await delay(interval)
  }
  throw new Error(
    `${label} timed out${lastError ? `: ${describeError(lastError)}` : ''}`,
  )
}

async function waitForDebugPortToClose(port, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/list`)
    } catch {
      return
    }
    await delay(100)
  }
  throw new Error(`Electron DevTools port ${port} did not close`)
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 1
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', resolve)
      this.ws.once('error', reject)
    })
    this.ws.on('message', (raw) => {
      const message = JSON.parse(raw)
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    this.ws.on('close', () => {
      for (const pending of this.pending.values())
        pending.reject(new Error('CDP connection closed'))
      this.pending.clear()
    })
  }

  async connect() {
    await this.ready
  }

  send(method, params = {}) {
    const id = this.id++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description
      throw new Error(description ?? response.exceptionDetails.text)
    }
    return response.result.value
  }

  close() {
    this.ws.terminate()
  }
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile()
  } catch {
    return false
  }
}

async function prepareIsolatedStore(realStoreBytes, isolatedStorePath) {
  let parsed
  try {
    parsed = JSON.parse(realStoreBytes.toString('utf8'))
  } catch (error) {
    throw new Error(`The real Pulse Shelf store is not valid JSON: ${error}`)
  }
  if (!parsed?.data || !Array.isArray(parsed.data.tracks))
    throw new Error('The real Pulse Shelf store does not contain app data')

  const isolated = structuredClone(parsed)
  const data = isolated.data
  const target = data.tracks.find((track) => track.id === trackId)
  if (!target)
    throw new Error(`Track ${trackId} is not present in the real store`)
  if (!target.filePath || !(await isFile(target.filePath)))
    throw new Error('The selected track audio file does not exist')

  let other
  for (const candidate of data.tracks) {
    if (
      candidate.id !== trackId &&
      candidate.filePath &&
      (await isFile(candidate.filePath))
    ) {
      other = candidate
      break
    }
  }
  if (!other)
    throw new Error(
      'A second track with an existing audio file is required for the track-isolation check',
    )

  data.lyricsSyncProfiles ??= {}
  data.generatedLyricsTimelines ??= {}
  const replacedProfile = data.lyricsSyncProfiles[trackId] ?? null
  const replacedTimeline = data.generatedLyricsTimelines[trackId] ?? null
  delete data.lyricsSyncProfiles[trackId]
  delete data.generatedLyricsTimelines[trackId]
  if (plainOnly) {
    const selectedLyrics = data.lyrics?.[trackId]
    if (!selectedLyrics?.plainLyrics)
      throw new Error('The selected live track does not have plain lyrics')
    delete selectedLyrics.syncedLyrics
  }
  data.settings = {
    ...data.settings,
    restoreLastPage: false,
    restoreQueue: false,
    autoplay: false,
    discordPresence: false,
    autoLaunch: false,
    closeBehavior: 'quit',
    autoFetchLyricsOnImport: false,
    autoFetchLyricsOnPlay: false,
    taskbarModeEnabled: false,
    taskbarModeShowOnStartup: false,
  }
  data.onboardingCompleted = true

  await mkdir(path.dirname(isolatedStorePath), { recursive: true })
  await writeFile(isolatedStorePath, JSON.stringify(isolated), 'utf8')
  return {
    target: structuredClone(target),
    other: structuredClone(other),
    replacedProfile,
    replacedTimeline,
  }
}

function electronEnvironment(userData, viteUrl) {
  const env = {
    ...process.env,
    VITE_DEV_SERVER_URL: viteUrl,
    PULSE_SHELF_TEST_USER_DATA: userData,
    PULSE_SHELF_AUTO_SYNC_LIVE_TEST: '1',
  }
  delete env.PULSE_SHELF_AUTO_SYNC_TEST_COMMAND
  delete env.PULSE_SHELF_AUTO_SYNC_TEST_SCRIPT
  delete env.PULSE_SHELF_UI_TEST
  delete env.PULSE_SHELF_UI_TEST_ROOT
  delete env.PULSE_SHELF_SELF_TEST
  return env
}

async function launchElectron(userData, viteUrl, vitePort, debugPort) {
  const child = startChild(
    'electron',
    electron,
    [
      '.',
      '--no-sandbox',
      '--disable-gpu',
      `--user-data-dir=${userData}`,
      `--remote-debugging-port=${debugPort}`,
    ],
    electronEnvironment(userData, viteUrl),
  )
  let exitDescription
  child.once('exit', (code, signal) => {
    exitDescription = `Electron exited early (code ${code}, signal ${signal})`
  })
  let cdp
  try {
    const page = await waitFor(
      async () => {
        if (child.spawnError) throw child.spawnError
        if (exitDescription) throw new Error(exitDescription)
        const pages = await (
          await fetch(`http://127.0.0.1:${debugPort}/json/list`)
        ).json()
        return pages.find(
          (entry) =>
            entry.type === 'page' &&
            entry.url.includes(`127.0.0.1:${vitePort}`),
        )
      },
      'Electron DevTools endpoint',
      40_000,
    )
    cdp = new Cdp(page.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await waitFor(
      () => cdp.evaluate('Boolean(document.querySelector(".sidebar"))'),
      'Pulse Shelf main window',
      30_000,
    )
    return { child, cdp, debugPort }
  } catch (error) {
    cdp?.close()
    await stopTree(child).catch(() => undefined)
    await waitForDebugPortToClose(debugPort).catch(() => undefined)
    throw error
  }
}

async function selectLibraryTrack(cdp, track) {
  const query = String(track.fileName || track.title)
  const expectedTitle = `${track.title} - ${track.artist}`
  await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('.sidebar nav button')]
      .find((item) => item.textContent?.trim() === '라이브러리')
    if (!button) throw new Error('Library navigation button is missing')
    button.click()
    return true
  })()`)
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector(".library-page"))'),
    'Library page',
  )
  await cdp.evaluate(`(() => {
    const input = document.querySelector('input[aria-label="라이브러리 검색"]')
    if (!(input instanceof HTMLInputElement))
      throw new Error('Library search input is missing')
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set
    setter.call(input, ${JSON.stringify(query)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await waitFor(
    () =>
      cdp.evaluate(`(() => [...document.querySelectorAll('.track-main')]
        .some((button) => button.getAttribute('title') === ${JSON.stringify(expectedTitle)}))()`),
    `library row for ${track.title}`,
  )
  await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('.track-main')]
      .find((item) => item.getAttribute('title') === ${JSON.stringify(expectedTitle)})
    if (!button) throw new Error('Expected library row disappeared')
    button.click()
    return true
  })()`)
  await waitFor(
    () =>
      cdp.evaluate(`(() => {
        const title = document.querySelector('.player-bar .player-track__copy strong')
        const artist = document.querySelector('.player-bar .player-track__copy > span')
        return title?.textContent === ${JSON.stringify(String(track.title))} &&
          artist?.textContent === ${JSON.stringify(String(track.artist))}
      })()`),
    `player selection for ${track.title}`,
  )
}

async function openLyricsPanel(cdp) {
  const isOpen = await cdp.evaluate(
    'document.querySelector(".now-panel")?.classList.contains("is-open")',
  )
  if (!isOpen)
    await cdp.evaluate('document.querySelector(".open-now-panel")?.click()')
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".now-panel")?.classList.contains("is-open")',
      ),
    'Now Playing panel',
  )
  await cdp.evaluate(
    'window.dispatchEvent(new CustomEvent("pulse:panel-tab", { detail: "lyrics" }))',
  )
}

async function selectTargetWithLyrics(cdp, target) {
  await selectLibraryTrack(cdp, target)
  await openLyricsPanel(cdp)
  await waitFor(
    () =>
      cdp.evaluate(
        `Boolean(document.querySelector(${JSON.stringify(
          plainOnly
            ? '.lyrics-text [data-auto-sync-trigger], .lyrics-generated [data-auto-sync-trigger]'
            : '.lyrics-synced [data-auto-sync-trigger]',
        )}))`,
      ),
    `${plainOnly ? 'plain-only' : 'timed'} target lyrics and auto-sync controls`,
    30_000,
  )
}

async function installJobRecorder(cdp) {
  await cdp.evaluate(`(() => {
    window.__pulseAutoSyncLive?.unsubscribe?.forEach((unsubscribe) => unsubscribe())
    const state = {
      progress: [],
      completed: [],
      failed: [],
      unsubscribe: [],
    }
    state.unsubscribe = [
      window.electronAPI.onLyricsAutoSyncProgress((job) =>
        state.progress.push(structuredClone(job))),
      window.electronAPI.onLyricsAutoSyncCompleted((job) =>
        state.completed.push(structuredClone(job))),
      window.electronAPI.onLyricsAutoSyncFailed((job) =>
        state.failed.push(structuredClone(job))),
    ]
    window.__pulseAutoSyncLive = state
    return true
  })()`)
}

async function waitForCompletedJob(cdp, startedAt) {
  const deadline = startedAt + analysisTimeoutMs
  while (Date.now() < deadline) {
    const job = await cdp.evaluate(
      `window.electronAPI.getLyricsAutoSyncJob(${JSON.stringify(trackId)})`,
    )
    if (job?.status === 'completed') return job
    if (job?.status === 'failed' || job?.status === 'cancelled')
      throw new Error(
        `Auto-sync ended as ${job.status}: ${JSON.stringify(job.error)}`,
      )
    await delay(500)
  }
  throw new Error('Real auto-sync analysis exceeded the six-minute timeout')
}

function validateResult(job) {
  const result = job?.result
  if (!result || result.trackId !== trackId)
    throw new Error('Completed job does not contain the target result DTO')
  if (result.cacheHit && !allowCache)
    throw new Error(
      'The live test reused an existing auto-sync cache; use a track/cache key that has not already been analyzed',
    )
  if (!result.canApply)
    throw new Error(
      `Real result did not pass the apply gate: ${JSON.stringify(result)}`,
    )
  if (plainOnly) {
    const lines = result.generatedLyricsTimeline?.lines
    if (!Array.isArray(lines) || lines.length < 3)
      throw new Error(
        'Real plain-only result did not produce at least three line timings',
      )
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (
        !/^[a-f0-9]{16}$/.test(line.textHash) ||
        typeof line.confidence !== 'number' ||
        line.confidence < 0.75 ||
        (index > 0 &&
          (lines[index - 1].lineIndex >= line.lineIndex ||
            lines[index - 1].audioTimeMs >= line.audioTimeMs))
      )
        throw new Error(
          'Real generated line timings are unsafe or not chronological',
        )
    }
  } else {
    const anchors = result.lyricsSyncProfile?.anchors
    if (!Array.isArray(anchors) || anchors.length < 3)
      throw new Error(
        'Real result did not produce at least three profile anchors',
      )
    for (let index = 1; index < anchors.length; index += 1) {
      if (
        anchors[index - 1].lyricTimeMs >= anchors[index].lyricTimeMs ||
        anchors[index - 1].audioTimeMs >= anchors[index].audioTimeMs
      )
        throw new Error('Real result anchors are not strictly chronological')
    }
  }
  if (!(result.processingTimeMs > 0))
    throw new Error('Real result did not report processing time')
  if (!(result.peakGpuMemoryMiB > 0))
    throw new Error('Real result did not report peak GPU memory')
  return result
}

function validateAppliedTimeline(state, result) {
  const timeline = state?.timeline
  if (
    !state?.valid ||
    !timeline ||
    timeline.trackId !== trackId ||
    timeline.source !== 'ai' ||
    timeline.createdAt <= 0 ||
    JSON.stringify(timeline.lines) !==
      JSON.stringify(result.generatedLyricsTimeline?.lines)
  )
    throw new Error(
      `Applied generated timeline is invalid: ${JSON.stringify(state)}`,
    )
  return timeline
}

function validateAppliedProfile(profile, result) {
  if (!profile || profile.trackId !== trackId || profile.source !== 'ai')
    throw new Error(
      `Applied profile is not AI-sourced: ${JSON.stringify(profile)}`,
    )
  if (
    !Array.isArray(profile.anchors) ||
    profile.anchors.length !== result.lyricsSyncProfile.anchors.length ||
    profile.offsetMs !== result.lyricsSyncProfile.offsetMs ||
    JSON.stringify(profile.anchors) !==
      JSON.stringify(result.lyricsSyncProfile.anchors) ||
    profile.updatedAt <= 0
  )
    throw new Error('Applied profile anchors or update time are invalid')
  const metadata = profile.autoSyncMetadata
  if (
    !metadata ||
    metadata.model !==
      `${result.model.separator} \u00b7 ${result.model.whisper}` ||
    metadata.matchedLines !== result.matchedLines ||
    metadata.totalLines !== result.totalLines ||
    metadata.confidence !== result.confidence ||
    metadata.processingTimeMs !== result.processingTimeMs
  )
    throw new Error(
      `Applied profile metadata does not match the result: ${JSON.stringify(metadata)}`,
    )
  return profile
}

async function seekAndCaptureHighlight(cdp) {
  const selected = await cdp.evaluate(`(() => {
    const buttons = [...document.querySelectorAll(
      '.lyrics-synced > button:not(.lyrics-sync-trigger):not(:disabled)',
    )]
    if (!buttons.length) return null
    const index = Math.min(buttons.length - 1, Math.max(0, Math.floor(buttons.length / 2)))
    const button = buttons[index]
    button.click()
    return { index, text: button.textContent?.trim() || '' }
  })()`)
  if (!selected)
    throw new Error('No timed lyric line was available for seek testing')
  return waitFor(
    () =>
      cdp.evaluate(`(() => {
        const active = document.querySelector('.lyrics-synced > button.is-active')
        return active
          ? { text: active.textContent?.trim() || '', expected: ${JSON.stringify(selected)} }
          : null
      })()`),
    'active lyric highlight after seek',
    10_000,
  )
}

async function normalQuit(session) {
  const { child, cdp, debugPort } = session
  const exited =
    child.exitCode === null ? once(child, 'exit') : Promise.resolve()
  await cdp.evaluate(
    'setTimeout(() => void window.electronAPI.quitApp(), 0); true',
  )
  const completed = await Promise.race([
    exited.then(() => true),
    delay(30_000).then(() => false),
  ])
  cdp.close()
  if (!completed) {
    await stopTree(child)
    throw new Error('Electron did not complete a normal quit within 30 seconds')
  }
  await waitForDebugPortToClose(debugPort)
}

async function cleanupElectron(session) {
  if (!session) return
  const { child, cdp, debugPort } = session
  if (child.exitCode === null && cdp) {
    const exited = once(child, 'exit').catch(() => undefined)
    try {
      await cdp.evaluate(`(async () => {
        const job = await window.electronAPI.getLyricsAutoSyncJob(${JSON.stringify(trackId)})
        if (job?.status === 'running')
          await window.electronAPI.cancelLyricsAutoSync(job.jobId)
        else if (job)
          await window.electronAPI.discardLyricsAutoSync(job.jobId)
        setTimeout(() => void window.electronAPI.quitApp(), 0)
        return true
      })()`)
      await Promise.race([exited, delay(30_000)])
    } catch {
      // The window may already be closing; taskkill below is the final fallback.
    }
  }
  cdp?.close()
  await stopTree(child)
  await waitForDebugPortToClose(debugPort).catch(() => undefined)
}

async function assertJobsClean(userData) {
  const jobsRoot = path.join(userData, 'auto-sync', 'jobs')
  try {
    const entries = await readdir(jobsRoot)
    if (entries.length)
      throw new Error(`Auto-sync job directories remain: ${entries.join(', ')}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return true
}

async function readIsolatedProfile(isolatedStorePath) {
  const stored = JSON.parse(await readFile(isolatedStorePath, 'utf8'))
  return stored.data?.lyricsSyncProfiles?.[trackId] ?? null
}

async function readIsolatedTimeline(isolatedStorePath) {
  const stored = JSON.parse(await readFile(isolatedStorePath, 'utf8'))
  return stored.data?.generatedLyricsTimelines?.[trackId] ?? null
}

const realStoreBytes = await readFile(realStorePath)
const realStoreSha256 = createHash('sha256')
  .update(realStoreBytes)
  .digest('hex')
const harnessRoot = await mkdtemp(
  path.join(os.tmpdir(), 'pulse-shelf-auto-sync-live-ui-'),
)
const userData = path.join(harnessRoot, 'user-data')
const isolatedStorePath = path.join(userData, 'pulse-shelf-data.json')
let vitePort
let debugPort
let viteUrl

let vite
let electronSession
let summary
let failure

try {
  vitePort = await reservePort()
  debugPort = await reservePort()
  viteUrl = `http://127.0.0.1:${vitePort}/`

  const { target, other, replacedProfile, replacedTimeline } =
    await prepareIsolatedStore(realStoreBytes, isolatedStorePath)
  const viteEnvironment = {
    ...process.env,
    ELECTRON_STARTUP_PREVENT: '1',
  }
  const viteStartedAt = Date.now()
  vite = startChild(
    'vite',
    'cmd.exe',
    [
      '/d',
      '/s',
      '/c',
      `npm run electron:dev -- --host 127.0.0.1 --port ${vitePort} --strictPort`,
    ],
    viteEnvironment,
  )
  await waitFor(async () => (await fetch(viteUrl)).ok, 'Vite server', 40_000)
  await waitFor(
    async () => {
      const mainBundle = path.join(root, 'dist-electron', 'main.js')
      const [bundleStats, content] = await Promise.all([
        stat(mainBundle),
        readFile(mainBundle, 'utf8'),
      ])
      return (
        bundleStats.mtimeMs >= viteStartedAt &&
        content.includes('generated-lyrics-timeline:get')
      )
    },
    'current Electron main bundle',
    40_000,
  )

  electronSession = await launchElectron(userData, viteUrl, vitePort, debugPort)
  let { cdp } = electronSession
  await selectTargetWithLyrics(cdp, target)
  const availability = await waitFor(
    async () => {
      const dto = await cdp.evaluate(
        `window.electronAPI.getLyricsAutoSyncAvailability(${JSON.stringify(trackId)})`,
      )
      const uiAvailable = await cdp.evaluate(
        `document.querySelector('[data-auto-sync-availability]')
          ?.getAttribute('data-auto-sync-availability') === 'available'`,
      )
      return dto?.available && uiAvailable ? dto : null
    },
    'real auto-sync availability',
    60_000,
    250,
  )
  if (availability.device !== 'cuda')
    throw new Error(
      `Expected CUDA availability: ${JSON.stringify(availability)}`,
    )

  await installJobRecorder(cdp)
  await cdp.evaluate(
    'document.querySelector("[data-auto-sync-trigger]").click()',
  )
  const confirmation = await waitFor(
    () =>
      cdp.evaluate(`(() => {
        const modal = document.querySelector('[data-auto-sync-confirmation]')
        return modal
          ? { title: modal.querySelector('h2')?.textContent, text: modal.textContent }
          : null
      })()`),
    'AI confirmation modal',
  )
  if (
    confirmation.title?.trim() !== 'AI 자동 싱크를 생성할까요?' ||
    !confirmation.text?.includes('보컬 분리와 음성 분석') ||
    !confirmation.text?.includes('바로 저장되지 않고 미리보기')
  )
    throw new Error(
      `Auto-sync confirmation copy is incomplete: ${JSON.stringify(confirmation)}`,
    )

  const startedAt = Date.now()
  await cdp.evaluate(
    'document.querySelector("[data-auto-sync-confirm-start]").click()',
  )
  const profileBeforeAnalysis = await cdp.evaluate(
    `window.electronAPI.getLyricsSyncProfile(${JSON.stringify(trackId)})`,
  )
  const timelineBeforeAnalysis = await cdp.evaluate(
    `window.electronAPI.getGeneratedLyricsTimeline(${JSON.stringify(trackId)})`,
  )
  if (
    profileBeforeAnalysis !== null ||
    timelineBeforeAnalysis?.timeline !== null
  )
    throw new Error(
      'The isolated target sync data changed before analysis completed',
    )

  await waitFor(
    () =>
      cdp.evaluate(`(() => {
        const stages = window.__pulseAutoSyncLive?.progress?.map((job) => job.stage) ?? []
        const visible = document.querySelector('[data-auto-sync-progress]')
          ?.getAttribute('data-auto-sync-stage')
        const resultVisible = Boolean(document.querySelector('[data-auto-sync-result]'))
        return (${allowCache ? 'resultVisible ||' : ''} stages.some((stage) => stage !== 'preparing')) && (visible || resultVisible)
          ? { stages, visible }
          : null
      })()`),
    'real worker progress stage',
    90_000,
    250,
  )

  await selectLibraryTrack(cdp, other)
  await delay(750)
  const leakCheck = await cdp.evaluate(`(async () => ({
    otherJob: await window.electronAPI.getLyricsAutoSyncJob(${JSON.stringify(other.id)}),
    targetJob: await window.electronAPI.getLyricsAutoSyncJob(${JSON.stringify(trackId)}),
    visibleProgress: Boolean(document.querySelector('[data-auto-sync-progress]')),
    visibleResult: Boolean(document.querySelector('[data-auto-sync-result]')),
  }))()`)
  if (
    leakCheck.otherJob !== null ||
    leakCheck.visibleProgress ||
    leakCheck.visibleResult ||
    leakCheck.targetJob?.trackId !== trackId
  )
    throw new Error(
      `Target auto-sync state leaked into the other track: ${JSON.stringify(leakCheck)}`,
    )

  await selectTargetWithLyrics(cdp, target)
  await waitFor(
    () =>
      cdp.evaluate(
        'Boolean(document.querySelector("[data-auto-sync-progress], [data-auto-sync-result]"))',
      ),
    'target job after returning to the original track',
  )
  const completedJob = await waitForCompletedJob(cdp, startedAt)
  const result = validateResult(completedJob)
  await waitFor(
    () =>
      cdp.evaluate(
        'Boolean(document.querySelector("[data-auto-sync-result]"))',
      ),
    'auto-sync result preview card',
  )

  const observedStages = await cdp.evaluate(
    `[...new Set((window.__pulseAutoSyncLive?.progress ?? []).map((job) => job.stage))]`,
  )
  const requiredStages = [
    'separating',
    'releasing-separator',
    'transcribing',
    'matching',
    'building-anchors',
    'validating',
  ]
  const missingStages = requiredStages.filter(
    (stage) => !observedStages.includes(stage),
  )
  if (missingStages.length && !result.cacheHit)
    throw new Error(
      `Worker progress stages were not observed: ${missingStages.join(', ')}`,
    )

  await cdp.evaluate(
    'document.querySelector("[data-auto-sync-preview]").click()',
  )
  await waitFor(
    () =>
      cdp.evaluate(
        `document.querySelector(${JSON.stringify(
          plainOnly ? '.lyrics-generated' : '.lyrics-synced',
        )})?.getAttribute('data-auto-sync-preview-active') === 'true'`,
      ),
    'temporary auto-sync preview',
  )
  const profileDuringPreview = await cdp.evaluate(
    `window.electronAPI.getLyricsSyncProfile(${JSON.stringify(trackId)})`,
  )
  const timelineDuringPreview = await cdp.evaluate(
    `window.electronAPI.getGeneratedLyricsTimeline(${JSON.stringify(trackId)})`,
  )
  if (profileDuringPreview !== null || timelineDuringPreview?.timeline !== null)
    throw new Error('Preview persisted auto-sync data before Apply')

  await cdp.evaluate('document.querySelector("[data-auto-sync-apply]").click()')
  const appliedProfile = plainOnly
    ? null
    : validateAppliedProfile(
        await waitFor(
          async () => {
            const profile = await cdp.evaluate(
              `window.electronAPI.getLyricsSyncProfile(${JSON.stringify(trackId)})`,
            )
            return profile?.source === 'ai' ? profile : null
          },
          'persisted AI sync profile',
          20_000,
        ),
        result,
      )
  const appliedTimeline = plainOnly
    ? validateAppliedTimeline(
        await waitFor(
          async () => {
            const state = await cdp.evaluate(
              `window.electronAPI.getGeneratedLyricsTimeline(${JSON.stringify(trackId)})`,
            )
            return state?.valid ? state : null
          },
          'persisted AI generated timeline',
          20_000,
        ),
        result,
      )
    : null
  await waitFor(
    () =>
      cdp.evaluate(
        `document.querySelector('.lyrics-sync-status')?.textContent
          ?.includes(${JSON.stringify(
            plainOnly ? 'AI 줄별 타임라인' : 'AI 자동 싱크',
          )})`,
      ),
    'applied AI sync UI status',
  )
  await waitFor(
    () =>
      cdp.evaluate(
        `window.electronAPI.getLyricsAutoSyncJob(${JSON.stringify(trackId)})
          .then((job) => job === null)`,
      ),
    'discarded transient result after Apply',
  )
  const highlightedLine = await seekAndCaptureHighlight(cdp)

  await normalQuit(electronSession)
  electronSession = undefined
  await assertJobsClean(userData)
  const profileOnDisk = plainOnly
    ? null
    : validateAppliedProfile(
        await readIsolatedProfile(isolatedStorePath),
        result,
      )
  const timelineOnDisk = plainOnly
    ? await readIsolatedTimeline(isolatedStorePath)
    : null
  if (
    plainOnly &&
    JSON.stringify(timelineOnDisk) !== JSON.stringify(appliedTimeline)
  )
    throw new Error(
      'Generated timeline was not persisted to the isolated store',
    )

  electronSession = await launchElectron(userData, viteUrl, vitePort, debugPort)
  ;({ cdp } = electronSession)
  await selectTargetWithLyrics(cdp, target)
  const restartedProfile = plainOnly
    ? null
    : validateAppliedProfile(
        await waitFor(
          () =>
            cdp.evaluate(
              `window.electronAPI.getLyricsSyncProfile(${JSON.stringify(trackId)})`,
            ),
          'AI profile after isolated-store restart',
        ),
        result,
      )
  const restartedTimeline = plainOnly
    ? validateAppliedTimeline(
        await waitFor(async () => {
          const state = await cdp.evaluate(
            `window.electronAPI.getGeneratedLyricsTimeline(${JSON.stringify(trackId)})`,
          )
          return state?.valid ? state : null
        }, 'AI generated timeline after isolated-store restart'),
        result,
      )
    : null
  const restartUiStatus = await waitFor(
    () =>
      cdp.evaluate(`(() => {
        const status = document.querySelector('.lyrics-sync-status')?.textContent?.trim()
        const info = document.querySelector('.lyrics-applied-info')?.textContent?.trim()
        const expectedStatus = ${JSON.stringify(
          plainOnly ? 'AI 줄별 타임라인' : 'AI 자동 싱크',
        )}
        const expectedInfo = ${JSON.stringify(
          plainOnly ? 'AI 줄별 타임스탬프' : 'AI 자동 싱크',
        )}
        return status?.includes(expectedStatus) && info?.includes(expectedInfo)
          ? { status, info }
          : null
      })()`),
    'AI profile UI after restart',
  )
  const restartedJob = await cdp.evaluate(
    `window.electronAPI.getLyricsAutoSyncJob(${JSON.stringify(trackId)})`,
  )
  if (restartedJob !== null)
    throw new Error(
      'A transient auto-sync job incorrectly survived app restart',
    )
  const staleResultVisible = await cdp.evaluate(
    'Boolean(document.querySelector("[data-auto-sync-result]"))',
  )
  if (staleResultVisible)
    throw new Error(
      'A transient auto-sync result incorrectly survived app restart',
    )

  await normalQuit(electronSession)
  electronSession = undefined
  await assertJobsClean(userData)

  summary = {
    trackId,
    target: { title: target.title, artist: target.artist },
    switchedTrack: { trackId: other.id, title: other.title },
    realStore: {
      path: realStorePath,
      sha256: realStoreSha256,
      hadTargetProfile: Boolean(replacedProfile),
      hadTargetTimeline: Boolean(replacedTimeline),
      unchanged: true,
    },
    availability: {
      device: availability.device,
      gpuName: availability.gpuName,
      modelName: availability.modelName,
    },
    progressStages: observedStages,
    trackIsolationVerified: true,
    result,
    previewDidNotPersist: true,
    applied: plainOnly
      ? {
          kind: 'generated-timeline',
          source: appliedTimeline.source,
          createdAt: appliedTimeline.createdAt,
          lineTimingCount: appliedTimeline.lines.length,
          diskLineTimingCount: timelineOnDisk.lines.length,
        }
      : {
          kind: 'sync-profile',
          source: appliedProfile.source,
          updatedAt: appliedProfile.updatedAt,
          anchorCount: appliedProfile.anchors.length,
          autoSyncMetadata: appliedProfile.autoSyncMetadata,
          diskAnchorCount: profileOnDisk.anchors.length,
        },
    highlightedLine,
    restart: {
      source: (restartedTimeline ?? restartedProfile).source,
      timingCount: plainOnly
        ? restartedTimeline.lines.length
        : restartedProfile.anchors.length,
      autoSyncMetadata: restartedProfile?.autoSyncMetadata,
      ui: restartUiStatus,
      transientJobRestored: false,
    },
    tempJobsCleaned: true,
  }
} catch (error) {
  failure = error
} finally {
  await cleanupElectron(electronSession).catch((error) => {
    failure ??= error
  })
  await stopTree(vite).catch((error) => {
    failure ??= error
  })
  try {
    const after = await readFile(realStorePath)
    if (!after.equals(realStoreBytes))
      throw new Error(
        'The real Pulse Shelf store changed during the isolated test',
      )
  } catch (error) {
    failure ??= error
  }
  await rm(harnessRoot, { recursive: true, force: true }).catch((error) => {
    failure ??= error
  })
}

if (failure) {
  process.stderr.write(`${describeError(failure)}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  process.stdout.write('PULSE_SHELF_AUTO_SYNC_LIVE_UI_TEST_OK\n')
}
