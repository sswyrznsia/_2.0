import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import electron from 'electron'
import WebSocket from 'ws'

const root = process.cwd()
const debugPort = 9232
const trackId = '2558b1329a584b908f5cbcf0c577946a78ade7d634f839e3484192d231d66907'
const sourceStore = path.join(
  process.env.APPDATA ?? '',
  'pulse-shelf-2',
  'pulse-shelf-data.json',
)
const comparisonPath = path.join(
  root,
  'tools',
  'auto-sync-poc',
  'results',
  'timing-drift-comparison.json',
)
const harnessRoot = await mkdtemp(path.join(os.tmpdir(), 'pulse-shelf-drift-ui-'))
const userData = path.join(harnessRoot, 'user-data')
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function start(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => process.stdout.write(chunk))
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))
  return child
}

async function stop(child) {
  if (!child?.pid) return
  const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
    stdio: 'ignore',
  })
  await once(killer, 'exit').catch(() => undefined)
  await Promise.race([once(child, 'exit'), delay(1_000)])
  child.stdout.destroy()
  child.stderr.destroy()
  child.unref()
}

async function waitFor(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await delay(100)
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError}` : ''}`)
}

async function waitForDebugPortToClose(port, timeout = 10_000) {
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
    this.socket = new WebSocket(url)
    this.sequence = 1
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.socket.once('open', resolve)
      this.socket.once('error', reject)
    })
    this.socket.on('message', (raw) => {
      const message = JSON.parse(raw)
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      if (message.error) request.reject(new Error(message.error.message))
      else request.resolve(message.result)
    })
  }

  async connect() {
    await this.ready
  }

  send(method, params = {}) {
    const id = this.sequence++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }

  close() {
    this.socket.terminate()
  }
}

function splitLyrics(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g, '').trim())
    .filter(Boolean)
}

function hashText(value) {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}

async function seek(cdp, seconds) {
  await cdp.evaluate(`(() => {
    const input = document.querySelector('.progress-control input[type="range"]')
    if (!input) throw new Error('Player progress input is missing')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter.call(input, ${JSON.stringify(String(seconds))})
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
}

let vite
let app
let cdp
try {
  const [storeText, comparisonText] = await Promise.all([
    readFile(sourceStore, 'utf8'),
    readFile(comparisonPath, 'utf8'),
  ])
  const store = JSON.parse(storeText.replace(/^\uFEFF/, ''))
  const comparison = JSON.parse(comparisonText)
  const track = store.data.tracks.find((item) => item.id === trackId)
  const alternateTrack = store.data.tracks.find((item) => item.id !== trackId)
  const lyrics = store.data.lyrics[trackId]
  if (!track || !lyrics?.plainLyrics) throw new Error('Failure track or plain lyrics is missing')
  await stat(track.filePath)

  const textLines = splitLyrics(lyrics.plainLyrics)
  const safeTimings = comparison.failureSong.lineTimings.filter(
    (line) => line.audioTimeMs !== null && line.confidence >= 0.75,
  )
  const timeline = {
    trackId,
    source: 'ai',
    lines: safeTimings.map((line) => ({
      lineIndex: line.lineIndex,
      textHash: hashText(textLines[line.lineIndex]),
      audioTimeMs: line.audioTimeMs,
      confidence: line.confidence,
      source: line.source,
    })),
    lineCount: textLines.length,
    lyricsTextHash: hashText(textLines.join('\n')),
    model: 'cached-whisper-drift-safe',
    createdAt: Date.now(),
  }
  store.data.generatedLyricsTimelines ??= {}
  store.data.generatedLyricsTimelines[trackId] = timeline
  store.data.recentTrackIds = [trackId, ...store.data.recentTrackIds.filter((id) => id !== trackId)]
  store.data.settings.autoFetchLyricsOnPlay = false
  store.data.settings.restoreLastPage = false
  store.data.lastPage = 'home'
  store.data.onboardingCompleted = true
  store.data.playerSession = {
    ...store.data.playerSession,
    queueIds: alternateTrack ? [trackId, alternateTrack.id] : [trackId],
    currentIndex: 0,
    currentTime: 0,
  }
  await mkdir(userData, { recursive: true })
  await writeFile(path.join(userData, 'pulse-shelf-data.json'), JSON.stringify(store))

  vite = start(
    'cmd.exe',
    ['/d', '/s', '/c', 'npm run electron:dev -- --host 127.0.0.1'],
    { ELECTRON_STARTUP_PREVENT: '1' },
  )
  await waitFor(
    async () => (await fetch('http://127.0.0.1:5173/')).ok,
    'Vite server',
  )
  app = start(
    electron,
    ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`, `--remote-debugging-port=${debugPort}`],
    { VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173/', PULSE_SHELF_TEST_USER_DATA: userData },
  )
  const page = await waitFor(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
    return pages.find(
      (entry) =>
        entry.type === 'page' &&
        entry.url === 'http://127.0.0.1:5173/',
    )
  }, 'Electron DevTools endpoint')
  cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await waitFor(() => cdp.evaluate('document.readyState === "complete"'), 'document ready')
  const startupState = await cdp.evaluate(`({
    body: document.body?.innerText?.slice(0, 500) ?? '',
    location: location.href,
    apiKeys: Object.keys(window.electronAPI ?? {}),
  })`)
  process.stdout.write(`TIMING_DRIFT_UI_STARTUP ${JSON.stringify(startupState)}\n`)
  await waitFor(() => cdp.evaluate('Boolean(document.querySelector(".cover-item"))'), 'track cover', 60_000)
  await cdp.evaluate(`(() => {
    const item = [...document.querySelectorAll('.cover-item')].find((node) =>
      node.querySelector('strong')?.textContent.includes(${JSON.stringify(track.title)}))
    if (!item) throw new Error('Failure track cover is missing')
    item.click()
    document.querySelector('.open-now-panel')?.click()
  })()`)
  await waitFor(
    () => cdp.evaluate('document.querySelector(".now-panel")?.classList.contains("is-open")'),
    'Now Playing panel',
  )
  await cdp.evaluate('window.dispatchEvent(new CustomEvent("pulse:panel-tab", { detail: "lyrics" }))')
  await waitFor(
    () => cdp.evaluate('document.querySelector(".lyrics-generated")?.getAttribute("data-generated-timeline-active") === "true"'),
    'generated failure-song timeline',
  )

  await cdp.evaluate(`document.querySelector('[data-generated-timeline-edit]').click()`)
  await waitFor(
    () => cdp.evaluate(`Boolean(document.querySelector('[data-generated-inline-editor]'))`),
    'inline generated editor for failure song',
  )
  await seek(cdp, 70)
  await cdp.evaluate(`document.querySelector('[data-generated-line-index="14"]').click()`)
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-generated-line-index="14"]')?.classList.contains('is-selected')`),
    'selected unmatched failure-song line',
  )
  await cdp.evaluate(`document.querySelector('[data-generated-inline-current]').click()`)
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-generated-line-index="14"]')?.getAttribute('data-generated-line-timed') === 'true'`),
    'current position assigned to unmatched failure-song line',
  )
  await cdp.evaluate(`document.querySelector('[data-generated-line-index="23"]').click()`)
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-generated-line-index="23"]')?.classList.contains('is-selected')`),
    'selected existing failure-song line',
  )
  await cdp.evaluate(`document.querySelector('[data-generated-inline-adjust="500"]').click()`)
  await cdp.evaluate(`document.querySelector('[data-generated-inline-save]').click()`)
  await waitFor(
    () =>
      cdp.evaluate(
        `window.electronAPI.getGeneratedLyricsTimeline('${trackId}').then((state) => state.valid && state.timeline?.lines.some((line) => line.lineIndex === 14 && line.source === 'manual') && state.timeline?.lines.some((line) => line.lineIndex === 23 && line.source === 'manual'))`,
      ),
    'saved inline failure-song timing edits',
  )
  if (alternateTrack) {
    await cdp.evaluate(`window.electronAPI.sendPlayerCommand({ type: 'next' })`)
    await waitFor(
      () =>
        cdp.evaluate(
          `!document.querySelector('.now-panel__track strong')?.textContent.includes(${JSON.stringify(track.title)})`,
      ),
      'switch away from failure song',
    )
    await cdp.evaluate(`window.electronAPI.sendPlayerCommand({ type: 'previous' })`)
    await waitFor(
      () =>
        cdp.evaluate(
          `document.querySelector('.now-panel__track strong')?.textContent.includes(${JSON.stringify(track.title)})`,
        ),
      'return to failure song',
    )
  }

  const probes = [0.1, 118, 212]
  const assertions = []
  for (const seconds of probes) {
    const expected = [...safeTimings]
      .reverse()
      .find((line) => line.audioTimeMs <= seconds * 1_000)?.lineIndex ?? -1
    await seek(cdp, seconds)
    await waitFor(
      () => cdp.evaluate(`document.querySelector('[data-generated-line-index="${expected}"]')?.classList.contains('is-active')`),
      `active generated line ${expected} at ${seconds}s`,
    )
    const active = await cdp.evaluate(
      'Number(document.querySelector("[data-generated-line-index].is-active")?.getAttribute("data-generated-line-index"))',
    )
    assertions.push({ seconds, expectedLineIndex: expected, activeLineIndex: active })
  }
  cdp.close()
  cdp = undefined
  await stop(app)
  await waitForDebugPortToClose(debugPort)
  app = start(
    electron,
    ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`, `--remote-debugging-port=${debugPort}`],
    { VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173/', PULSE_SHELF_TEST_USER_DATA: userData },
  )
  const restartedPage = await waitFor(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
    return pages.find((entry) => entry.type === 'page' && entry.url === 'http://127.0.0.1:5173/')
  }, 'restarted Electron DevTools endpoint')
  cdp = new Cdp(restartedPage.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await waitFor(
    () => cdp.evaluate(`Boolean(window.electronAPI?.getGeneratedLyricsTimeline)`),
    'restarted renderer API',
  )
  const restartedTimeline = await cdp.evaluate(
    `window.electronAPI.getGeneratedLyricsTimeline('${trackId}')`,
  )
  if (
    !restartedTimeline.valid ||
    restartedTimeline.timeline?.lines.find((line) => line.lineIndex === 14)?.source !== 'manual' ||
    restartedTimeline.timeline?.lines.find((line) => line.lineIndex === 23)?.source !== 'manual'
  )
    throw new Error(`Inline failure-song edits did not persist after restart: ${JSON.stringify(restartedTimeline)}`)
  process.stdout.write(`PULSE_SHELF_TIMING_DRIFT_UI_TEST_OK ${JSON.stringify({ trackId, safeLines: safeTimings.length, assertions })}\n`)
} finally {
  cdp?.close()
  await stop(app)
  await stop(vite)
  await rm(harnessRoot, { recursive: true, force: true })
}
