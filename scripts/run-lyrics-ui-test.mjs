import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import electron from 'electron'
import sharp from 'sharp'
import WebSocket from 'ws'

const root = process.cwd()
const debugPort = 9231
const harnessRoot = await mkdtemp(
  path.join(os.tmpdir(), 'pulse-shelf-lyrics-ui-'),
)
const userData = path.join(harnessRoot, 'user-data')
const trackAId = 'b'.repeat(64)
const trackBId = 'c'.repeat(64)
const trackCId = 'd'.repeat(64)
const trackDId = '3'.repeat(64)
const autoSyncWorker = path.join(
  root,
  'scripts',
  'fixtures',
  'mock-auto-sync-worker.mjs',
)
const trackAPath = path.join(harnessRoot, 'track-a.wav')
const trackBPath = path.join(harnessRoot, 'track-b.wav')
const trackDPath = path.join(harnessRoot, 'track-d.wav')
const coverPath = (trackId) => path.join(userData, 'covers', `${trackId}.png`)
const searchScreenshot = path.join(
  root,
  'artifacts',
  'lyrics',
  'manual-search-results.png',
)
const selectionScreenshot = path.join(
  root,
  'artifacts',
  'lyrics',
  'manual-selection.png',
)
const coverScreenshot = path.join(
  root,
  'artifacts',
  'lyrics',
  'now-playing-cover-contain.png',
)
const horizontalCoverScreenshot = path.join(
  root,
  'artifacts',
  'lyrics',
  'now-playing-cover-horizontal.png',
)
let trackARequests = 0
let lyricaRequests = 0
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function silentWav(seconds = 1) {
  const samples = 44_100 * seconds
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + samples * 2, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(44_100, 24)
  buffer.writeUInt32LE(88_200, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples * 2, 40)
  return buffer
}

function start(command, args, env) {
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
  const killer = spawn(
    'taskkill.exe',
    ['/pid', String(child.pid), '/t', '/f'],
    {
      stdio: 'ignore',
    },
  )
  await once(killer, 'exit').catch(() => undefined)
  await Promise.race([once(child, 'exit'), delay(1_000)])
  child.stdout.destroy()
  child.stderr.destroy()
  child.unref()
}

async function waitFor(check, label, timeout = 20_000) {
  const end = Date.now() + timeout
  let lastError
  while (Date.now() < end) {
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
  const end = Date.now() + timeout
  while (Date.now() < end) {
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
    const id = this.id++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      )
    return result.result.value
  }

  close() {
    this.ws.terminate()
  }
}

async function clickCoverByTitle(cdp, title) {
  await waitFor(
    () =>
      cdp.evaluate(`(() => {
        const item = [...document.querySelectorAll('.cover-item')]
          .find((candidate) => candidate.querySelector('strong')?.textContent.includes(${JSON.stringify(title)}))
        if (!item) return false
        item.click()
        return true
      })()`),
    `${title} cover`,
  )
}

async function seekPlayer(cdp, seconds) {
  await cdp.evaluate(`(() => {
    const input = document.querySelector('.progress-control input[type="range"]')
    if (!input) throw new Error('Player progress input is missing')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter.call(input, ${JSON.stringify(String(seconds))})
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
}

async function pausePlayer(cdp) {
  const wasPlaying = await cdp.evaluate(`(() => {
    const button = document.querySelector('.play-button')
    const playing = Boolean(button?.querySelector('.lucide-pause'))
    if (playing) button.click()
    return playing
  })()`)
  if (wasPlaying)
    await waitFor(
      () =>
        cdp.evaluate(
          `!document.querySelector('.play-button .lucide-pause')`,
        ),
      'player paused for timing assertion',
    )
}

function fixture() {
  const now = Date.now()
  return {
    data: {
      version: 3,
      musicFolders: [],
      tracks: [
        {
          id: trackAId,
          fileName: 'cover-test.wav',
          title: 'Candidate Song - cover',
          artist: 'Cover Artist',
          album: 'Test Album',
          duration: 180,
          format: 'wav',
          fileSize: 0,
          modifiedAt: now,
          addedAt: now,
          liked: false,
          playCount: 0,
          filePath: trackAPath,
          coverUrl: `pulse-cover://track/${trackAId}`,
        },
        {
          id: trackBId,
          fileName: 'slow-test.wav',
          title: 'Slow Track',
          artist: 'Slow Artist',
          album: 'Test Album',
          duration: 200,
          format: 'wav',
          fileSize: 0,
          modifiedAt: now,
          addedAt: now,
          liked: false,
          playCount: 0,
          filePath: trackBPath,
          coverUrl: `pulse-cover://track/${trackBId}`,
        },
        {
          id: trackCId,
          fileName: 'square-test.wav',
          title: 'Square Track',
          artist: 'Square Artist',
          album: 'Test Album',
          duration: 210,
          format: 'wav',
          fileSize: 0,
          modifiedAt: now,
          addedAt: now,
          liked: false,
          playCount: 0,
          filePath: trackBPath,
          coverUrl: `pulse-cover://track/${trackCId}`,
        },
        {
          id: trackDId,
          fileName: 'no-cover-test.wav',
          title: 'No Cover Track',
          artist: 'No Cover Artist',
          album: 'Test Album',
          duration: 220,
          format: 'wav',
          fileSize: 0,
          modifiedAt: now,
          addedAt: now,
          liked: false,
          playCount: 0,
          filePath: trackDPath,
        },
      ],
      playlists: [],
      recentTrackIds: [trackAId, trackBId, trackCId, trackDId],
      lyrics: {},
      settings: {
        theme: 'dark',
        restoreLastPage: true,
        restoreQueue: true,
        autoplay: false,
        discordPresence: false,
        autoLaunch: false,
        closeBehavior: 'quit',
        miniAlwaysOnTop: true,
        defaultVolume: 0.8,
        autoFetchLyricsOnImport: false,
        autoFetchLyricsOnPlay: true,
        preferSyncedLyrics: true,
        lyricsAutoMatchThreshold: 0.9,
      },
      lastPage: 'home',
      playerSession: {
        queueIds: [],
        currentIndex: -1,
        currentTime: 0,
        volume: 0.8,
        isMuted: false,
        shuffle: false,
        repeatMode: 'off',
      },
      focus: {
        today: new Date().toISOString().slice(0, 10),
        focusedSeconds: 0,
        todos: [],
        timer: {
          mode: 'focus',
          status: 'idle',
          focusMinutes: 25,
          breakMinutes: 5,
          remainingSeconds: 1500,
        },
      },
      onboardingCompleted: true,
    },
  }
}

const candidate = {
  id: 77,
  trackName: 'Candidate Song',
  artistName: 'Original Artist',
  albumName: 'Candidate Album',
  duration: 181,
  syncedLyrics:
    '[00:00.00]Candidate lyrics\n[00:00.20]Second lyrics\n[00:00.40]Third lyrics\n[00:00.60]Fourth lyrics',
  plainLyrics: 'Candidate lyrics\nSecond lyrics\nThird lyrics\nFourth lyrics',
  instrumental: false,
}
const candidates = [
  candidate,
  {
    id: 78,
    trackName:
      '君の知らない物語と非常に長い日本語の楽曲タイトルを表示するためのテスト',
    artistName: 'supercell and a deliberately long featured artist name',
    albumName: 'Today Is A Beautiful Day · Long Album Edition With Extra Notes',
    duration: 339,
    syncedLyrics: '[00:00.00]Long title lyrics',
    plainLyrics: 'Long title lyrics',
    instrumental: false,
  },
  {
    id: 79,
    trackName:
      'A candidate with a very long English title that must stay contained',
    artistName: 'Long Artist',
    albumName:
      'A very long album name that should wrap inside the candidate content column',
    duration: 242,
    plainLyrics: 'Plain lyrics',
    instrumental: false,
  },
  {
    id: 80,
    trackName: '長いタイトルの四番目の候補',
    artistName: 'Fourth Artist',
    albumName: 'Fourth Album',
    duration: 199,
    syncedLyrics: '[00:00.00]Fourth lyrics',
    plainLyrics: 'Fourth lyrics',
    instrumental: false,
  },
  {
    id: 81,
    trackName: 'Fifth candidate',
    artistName: 'Fifth Artist',
    albumName: 'Fifth Album',
    duration: 260,
    plainLyrics: 'Fifth lyrics',
    instrumental: false,
  },
]

const server = createServer((request, response) => {
  if (request.url?.startsWith('/lyrics/')) {
    const url = new URL(request.url, 'http://127.0.0.1')
    const song = url.searchParams.get('song') ?? ''
    lyricaRequests += 1
    if (song.includes('No Cover Track')) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'error' }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    if (song.includes('Slow Track')) {
      response.end(
        JSON.stringify({
          status: 'success',
          data: {
            source: 'youtube_transcript',
            artist: 'Slow Artist',
            title: 'Slow Track',
            lyrics: 'Lyrica first line\nLyrica second line',
            timed_lyrics: [
              {
                text: 'Lyrica first line',
                start_time: 0,
                end_time: 500,
                id: 1,
              },
              {
                text: 'Lyrica second line',
                start_time: 500,
                end_time: 900,
                id: 2,
              },
            ],
            metadata: { album: 'Test Album', duration: 200 },
          },
        }),
      )
    } else
      response.end(
        JSON.stringify({
          status: 'error',
          error: { message: 'No lyrics found' },
        }),
      )
    return
  }
  if (request.url?.startsWith('/api/search')) {
    const query =
      new URL(request.url, 'http://127.0.0.1').searchParams.get('q') ?? ''
    if (query.includes('Square Track')) {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(candidates))
      }, 700)
      return
    }
    if (
      query.includes('Slow Track') ||
      query.includes('No Cover Track') ||
      query.includes('No Track')
    ) {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('[]')
      }, 500)
      return
    }
    trackARequests += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(candidates))
    return
  }
  response.writeHead(404)
  response.end()
})

let vite
let app
let cdp
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Lyrics test server did not start')
  await mkdir(userData, { recursive: true })
  await mkdir(path.dirname(coverPath(trackAId)), { recursive: true })
  await writeFile(trackAPath, silentWav())
  await writeFile(trackBPath, silentWav())
  await writeFile(trackDPath, silentWav(45))
  await sharp({
    create: {
      width: 180,
      height: 420,
      channels: 4,
      background: { r: 190, g: 76, b: 96, alpha: 1 },
    },
  })
    .png()
    .toFile(coverPath(trackAId))
  await sharp({
    create: {
      width: 420,
      height: 180,
      channels: 4,
      background: { r: 69, g: 119, b: 191, alpha: 1 },
    },
  })
    .png()
    .toFile(coverPath(trackBId))
  await sharp({
    create: {
      width: 300,
      height: 300,
      channels: 4,
      background: { r: 78, g: 151, b: 105, alpha: 1 },
    },
  })
    .png()
    .toFile(coverPath(trackCId))
  await writeFile(
    path.join(userData, 'pulse-shelf-data.json'),
    JSON.stringify(fixture()),
  )
  const viteStartedAt = Date.now()
  vite = start(
    'cmd.exe',
    ['/d', '/s', '/c', 'npm run electron:dev -- --host 127.0.0.1'],
    { ELECTRON_STARTUP_PREVENT: '1' },
  )
  await waitFor(
    async () => (await fetch('http://127.0.0.1:5173/')).ok,
    'Vite server',
  )
  await waitFor(async () => {
    const mainBundle = path.join(root, 'dist-electron', 'main.js')
    const [bundleStats, content] = await Promise.all([
      stat(mainBundle),
      readFile(mainBundle, 'utf8'),
    ])
    return (
      bundleStats.mtimeMs >= viteStartedAt &&
      content.includes('generated-lyrics-timeline:get')
    )
  }, 'current Electron main bundle')
  app = start(
    electron,
    [
      '.',
      '--no-sandbox',
      '--disable-gpu',
      `--user-data-dir=${userData}`,
      `--remote-debugging-port=${debugPort}`,
    ],
    {
      VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173/',
      PULSE_SHELF_TEST_USER_DATA: userData,
      PULSE_SHELF_LRCLIB_API: `http://127.0.0.1:${address.port}/api`,
      PULSE_SHELF_LYRICA_API: `http://127.0.0.1:${address.port}`,
      PULSE_SHELF_AUTO_SYNC_TEST_COMMAND: process.execPath,
      PULSE_SHELF_AUTO_SYNC_TEST_SCRIPT: autoSyncWorker,
      PULSE_SHELF_AUTO_SYNC_MOCK_NO_COUNT: '1',
    },
  )
  const page = await waitFor(async () => {
    const pages = await (
      await fetch(`http://127.0.0.1:${debugPort}/json/list`)
    ).json()
    return pages.find(
      (entry) => entry.type === 'page' && entry.url.includes('5173'),
    )
  }, 'Electron DevTools endpoint')
  cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector(".cover-item"))'),
    'recent track',
    60_000,
  )
  await cdp.evaluate('document.querySelector(".cover-item").click()')
  await cdp.evaluate('document.querySelector(".open-now-panel")?.click()')
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".now-panel")?.classList.contains("is-open")',
      ),
    'Now Playing panel',
  )
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".now-panel__cover")?.naturalHeight > 0',
      ),
    'vertical Now Playing cover',
  )
  const coverLayout = await cdp.evaluate(`(() => {
    const cover = document.querySelector('.now-panel__cover')
    const frame = document.querySelector('.now-panel__cover-frame')
    const backdrop = document.querySelector('.now-panel__cover-backdrop')
    const style = getComputedStyle(cover)
    const frameStyle = getComputedStyle(frame)
    const backdropStyle = getComputedStyle(backdrop)
    return {
      objectFit: style.objectFit,
      objectPosition: style.objectPosition,
      naturalWidth: cover.naturalWidth,
      naturalHeight: cover.naturalHeight,
      frameOverflow: frameStyle.overflow,
      backdropObjectFit: backdropStyle.objectFit,
      backdropFilter: backdropStyle.filter,
    }
  })()`)
  if (
    coverLayout.objectFit !== 'contain' ||
    coverLayout.objectPosition !== '50% 50%' ||
    coverLayout.naturalHeight <= coverLayout.naturalWidth ||
    coverLayout.frameOverflow !== 'hidden' ||
    coverLayout.backdropObjectFit !== 'cover' ||
    !coverLayout.backdropFilter.includes('blur')
  )
    throw new Error(
      `Now Playing cover layout is incorrect: ${JSON.stringify(coverLayout)}`,
    )
  await mkdir(path.dirname(coverScreenshot), { recursive: true })
  const coverCapture = await cdp.send('Page.captureScreenshot', {
    format: 'png',
  })
  await writeFile(coverScreenshot, Buffer.from(coverCapture.data, 'base64'))

  const selectCover = async (title, expectedShape) => {
    await clickCoverByTitle(cdp, title)
    await waitFor(
      () =>
        cdp.evaluate(
          `document.querySelector('.now-panel__track strong')?.textContent.includes('${title}')`,
        ),
      `${title} in Now Playing`,
    )
    if (expectedShape !== 'empty')
      await waitFor(
        () =>
          cdp.evaluate(
            'document.querySelector(".now-panel__cover")?.naturalHeight > 0',
          ),
        `${title} cover image`,
      )
    const state = await cdp.evaluate(`(() => {
      const cover = document.querySelector('.now-panel__cover')
      const backdrop = document.querySelector('.now-panel__cover-backdrop')
      return {
        hasBackdrop: Boolean(backdrop),
        empty: cover.classList.contains('album-cover--empty'),
        naturalWidth: cover.naturalWidth ?? 0,
        naturalHeight: cover.naturalHeight ?? 0,
        objectFit: getComputedStyle(cover).objectFit,
      }
    })()`)
    if (
      state.objectFit !== 'contain' ||
      state.hasBackdrop !== (expectedShape !== 'empty') ||
      state.empty !== (expectedShape === 'empty')
    )
      throw new Error(
        `${title} cover state is incorrect: ${JSON.stringify(state)}`,
      )
    if (expectedShape === 'wide' && state.naturalWidth <= state.naturalHeight)
      throw new Error(
        `Horizontal cover did not retain its natural aspect ratio: ${JSON.stringify(state)}`,
      )
    if (
      expectedShape === 'square' &&
      state.naturalWidth !== state.naturalHeight
    )
      throw new Error(
        `Square cover did not retain its natural aspect ratio: ${JSON.stringify(state)}`,
      )
  }
  await selectCover('Slow Track', 'wide')
  const horizontalCapture = await cdp.send('Page.captureScreenshot', {
    format: 'png',
  })
  await writeFile(
    horizontalCoverScreenshot,
    Buffer.from(horizontalCapture.data, 'base64'),
  )
  await selectCover('Square Track', 'square')
  await selectCover('No Cover Track', 'empty')
  await selectCover('Candidate Song', 'tall')
  await cdp.evaluate(
    'window.dispatchEvent(new CustomEvent("pulse:panel-tab", { detail: "lyrics" }))',
  )
  await waitFor(
    () =>
      cdp.evaluate('Boolean(document.querySelector(".lyrics-search-panel"))'),
    'manual lyrics search panel',
  )
  const controls = await cdp.evaluate(`(() => ({
    inputs: document.querySelectorAll('.lyrics-search-fields input').length,
    actions: document.querySelectorAll('.lyrics-search-actions button').length,
    candidateCount: document.querySelectorAll('.lyrics-candidate').length,
  }))()`)
  if (
    controls.inputs !== 2 ||
    controls.actions !== 3 ||
    controls.candidateCount !== 0
  )
    throw new Error(
      `Manual lyrics controls are incomplete: ${JSON.stringify(controls)}`,
    )
  await cdp.evaluate(
    'document.querySelector(".lyrics-search-actions .button--primary").click()',
  )
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector(".lyrics-candidate"))'),
    'lyrics candidate list',
  )
  const candidateText = await cdp.evaluate(
    'document.querySelector(".lyrics-candidate").innerText',
  )
  if (
    !candidateText.includes('Candidate Song') ||
    !candidateText.includes('동기화 가사')
  )
    throw new Error(`Candidate metadata is missing: ${candidateText}`)
  const assertCandidateLayout = async (label) => {
    const layout = await cdp.evaluate(`(() => {
      const list = document.querySelector('.lyrics-candidate-list')
      const rows = [...document.querySelectorAll('.lyrics-candidate')]
      return {
        listFits: list.scrollWidth <= list.clientWidth,
        rows: rows.map((row) => {
          const action = row.querySelector('.lyrics-candidate__action')
          const rowRect = row.getBoundingClientRect()
          const actionRect = action.getBoundingClientRect()
          return {
            fits: row.scrollWidth <= row.clientWidth,
            actionVisible:
              actionRect.left >= rowRect.left && actionRect.right <= rowRect.right,
            actionWidth: actionRect.width,
            contentWidth: row.querySelector('.lyrics-candidate__content').clientWidth,
          }
        }),
      }
    })()`)
    if (
      !layout.listFits ||
      layout.rows.length !== 5 ||
      layout.rows.some(
        (row) =>
          !row.fits ||
          !row.actionVisible ||
          row.actionWidth < 58 ||
          row.contentWidth < 1,
      )
    )
      throw new Error(
        `Lyrics candidate ${label} layout overflowed: ${JSON.stringify(layout)}`,
      )
  }
  await assertCandidateLayout('default panel')
  await cdp.evaluate(
    'document.querySelector(".now-panel").style.width = "240px"',
  )
  await delay(100)
  await assertCandidateLayout('narrow panel')
  await cdp.evaluate(
    'document.querySelector(".now-panel").style.removeProperty("width")',
  )
  await cdp.evaluate('document.querySelector(".now-panel").scrollTop = 10_000')
  await delay(100)
  await mkdir(path.dirname(searchScreenshot), { recursive: true })
  const searchCapture = await cdp.send('Page.captureScreenshot', {
    format: 'png',
  })
  await writeFile(searchScreenshot, Buffer.from(searchCapture.data, 'base64'))
  await cdp.evaluate(
    'document.querySelector(".lyrics-candidate .button").click()',
  )
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector(".lyrics-synced"))'),
    'selected synced lyrics',
  )
  await cdp.evaluate('document.querySelector(".lyrics-sync-trigger").click()')
  await waitFor(
    () =>
      cdp.evaluate('Boolean(document.querySelector(".lyrics-sync-editor"))'),
    'lyrics sync editor',
  )
  const syncControls = await cdp.evaluate(`(() => ({
    editor: document.querySelector('.lyrics-sync-editor')?.textContent,
    offsetButtons: [...document.querySelectorAll('.lyrics-sync-editor button')]
      .filter((button) => button.textContent.includes('ms')).length,
  }))()`)
  if (syncControls.offsetButtons !== 4)
    throw new Error(
      `Lyrics sync offset controls are incomplete: ${JSON.stringify(syncControls)}`,
    )
  await cdp.evaluate(`
    [...document.querySelectorAll('.lyrics-sync-editor button')]
      .find((button) => button.textContent.includes('+100ms')).click()
  `)
  await cdp.evaluate(
    'document.querySelector(".lyrics-sync-editor .button--primary").click()',
  )
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".lyrics-sync-status")?.textContent.includes("0.1")',
      ),
    'saved lyrics sync offset status',
  )
  const savedOffset = await cdp.evaluate(
    `window.electronAPI.getLyricsSyncProfile('${trackAId}')`,
  )
  if (savedOffset?.offsetMs !== 100)
    throw new Error(
      `Lyrics sync offset was not saved: ${JSON.stringify(savedOffset)}`,
    )
  await cdp.evaluate('document.querySelector(".lyrics-sync-trigger").click()')
  await cdp.evaluate(`
    [...document.querySelectorAll('.lyrics-sync-editor button')]
      .find((button) => button.textContent.includes('+100ms')).click()
  `)
  await cdp.evaluate(`
    [...document.querySelectorAll('.lyrics-sync-editor button')]
      .find((button) => button.textContent.includes('취소')).click()
  `)
  const cancelledOffset = await cdp.evaluate(
    `window.electronAPI.getLyricsSyncProfile('${trackAId}')`,
  )
  if (cancelledOffset?.offsetMs !== 100)
    throw new Error(
      'Cancelling lyrics sync editing did not restore the saved profile',
    )
  await cdp.evaluate(`window.electronAPI.saveLyricsSyncProfile({
    trackId: '${trackAId}', offsetMs: 0, updatedAt: Date.now(), anchors: [
      { lyricTimeMs: 0, audioTimeMs: 5000 },
      { lyricTimeMs: 200, audioTimeMs: 5200 },
      { lyricTimeMs: 400, audioTimeMs: 5600 },
      { lyricTimeMs: 600, audioTimeMs: 5800 }
    ]
  })`)
  const savedPiecewiseProfile = await cdp.evaluate(
    `window.electronAPI.getLyricsSyncProfile('${trackAId}')`,
  )
  if (savedPiecewiseProfile?.anchors?.length !== 4)
    throw new Error('Four-anchor piecewise lyrics sync profile was not saved')
  await cdp.evaluate('window.confirm = () => true')
  await cdp.evaluate(
    'document.querySelector("[data-lyrics-search-mode=\\"all\\"]").click()',
  )
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector(".lyrics-candidate"))'),
    'candidate selection after sync profile',
  )
  await cdp.evaluate(
    'document.querySelector(".lyrics-candidate .button").click()',
  )
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector(".lyrics-synced"))'),
    'synced lyrics after replacing candidate',
  )
  await pausePlayer(cdp)
  await seekPlayer(cdp, 0.1)
  await waitFor(
    () =>
      cdp.evaluate(
        `document.querySelector('[data-synced-line-index="0"]')?.classList.contains('is-active')`,
      ),
    'synced first line before next timestamp',
  )
  await seekPlayer(cdp, 0.1)
  await delay(100)
  const beforeExactSyncedBoundary = await cdp.evaluate(`(() => ({
    activeIndex: document.querySelector('[data-synced-line-index].is-active')?.getAttribute('data-synced-line-index') ?? null,
    inputValue: document.querySelector('.progress-control input[type="range"]')?.value ?? null,
    lineTimes: [...document.querySelectorAll('[data-synced-line-index]')].map((line) => line.getAttribute('data-synced-line-time')),
    playing: Boolean(document.querySelector('.play-button .lucide-pause')),
  }))()`)
  if (beforeExactSyncedBoundary.activeIndex !== '0')
    throw new Error(
      `Synced lyrics advanced before the next line timestamp: ${JSON.stringify(beforeExactSyncedBoundary)}`,
    )
  await seekPlayer(cdp, 0.2)
  await waitFor(
    () =>
      cdp.evaluate(
        `document.querySelector('[data-synced-line-index="1"]')?.classList.contains('is-active')`,
      ),
    'synced second line at exact timestamp',
  )
  await seekPlayer(cdp, 0.1)
  await waitFor(
    () =>
      cdp.evaluate(
        `document.querySelector('[data-synced-line-index="0"]')?.classList.contains('is-active')`,
      ),
    'synced first line after backward seek',
  )
  const clearedAfterReplacement = await cdp.evaluate(
    `window.electronAPI.getLyricsSyncProfile('${trackAId}')`,
  )
  if (clearedAfterReplacement !== null)
    throw new Error('Replacing lyrics did not clear the existing sync profile')
  await cdp.evaluate(`window.electronAPI.saveLyricsSyncProfile({
    trackId: '${trackAId}', offsetMs: 3000, updatedAt: Date.now(), anchors: []
  })`)
  const selectionCapture = await cdp.send('Page.captureScreenshot', {
    format: 'png',
  })
  await writeFile(
    selectionScreenshot,
    Buffer.from(selectionCapture.data, 'base64'),
  )

  await cdp.evaluate(`window.electronAPI.saveLyricsSelection('${trackCId}', {
    id: 901,
    trackName: 'Square Track',
    artistName: 'Square Artist',
    plainLyrics: 'Cached plain lyrics\\nSecond cached line',
    instrumental: false,
    provider: 'lrclib',
    sourceLabel: 'LRCLIB',
  })`)
  await clickCoverByTitle(cdp, 'Square Track')
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".now-panel__track strong")?.textContent.includes("Square Track")',
      ),
    'plain lyrics track',
  )
  await cdp.evaluate(
    'window.dispatchEvent(new CustomEvent("pulse:panel-tab", { detail: "lyrics" }))',
  )
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".lyrics-text__content")?.textContent.includes("Cached plain lyrics")',
      ),
    'cached plain lyrics',
  )
  const plainLyricsState = await cdp.evaluate(`(() => ({
    actions: document.querySelectorAll('.lyrics-text [data-lyrics-search-mode]').length,
    hasActiveLine: Boolean(document.querySelector('.lyrics-text .is-active')),
    warning: document.querySelector('.lyrics-sync-unavailable')?.textContent,
    autoSyncAvailable: document.querySelector('[data-auto-sync-availability]')?.getAttribute('data-auto-sync-availability'),
    autoSyncDisabled: document.querySelector('[data-auto-sync-trigger]')?.disabled,
  }))()`)
  if (
    plainLyricsState.actions !== 2 ||
    plainLyricsState.hasActiveLine ||
    !plainLyricsState.warning?.includes('줄별 타임라인') ||
    plainLyricsState.autoSyncAvailable !== 'available' ||
    plainLyricsState.autoSyncDisabled
  )
    throw new Error(
      `Plain lyrics actions or timestamp warning are missing: ${JSON.stringify(plainLyricsState)}`,
    )
  await cdp.evaluate(
    'document.querySelector("[data-lyrics-search-mode=\\"synced\\"]").click()',
  )
  const initialSearchFeedback = await cdp.evaluate(`(() => ({
    progress: document.querySelector('[data-lyrics-search-progress]')?.getAttribute('data-lyrics-search-progress'),
    elapsed: document.querySelector('[data-lyrics-search-progress]')?.textContent,
    cancelVisible: Boolean(document.querySelector('[data-lyrics-search-cancel]')),
    searchButtonsDisabled: [...document.querySelectorAll('.lyrics-search-actions button')]
      .filter((button) => !button.hasAttribute('data-lyrics-search-cancel'))
      .every((button) => button.disabled),
  }))()`)
  if (
    !initialSearchFeedback.progress ||
    !initialSearchFeedback.elapsed?.includes('초 경과') ||
    !initialSearchFeedback.cancelVisible ||
    !initialSearchFeedback.searchButtonsDisabled
  )
    throw new Error(
      `Immediate lyrics search feedback is incomplete: ${JSON.stringify(initialSearchFeedback)}`,
    )
  await cdp.evaluate(
    'document.querySelector("[data-lyrics-search-cancel]").click()',
  )
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".lyrics-text__content")?.textContent.includes("Cached plain lyrics")',
      ),
    'plain lyrics after cancelling an in-flight search',
  )
  await delay(850)
  const lyricsAfterCancelledSearch = await cdp.evaluate(
    'document.querySelector(".lyrics-text__content")?.textContent',
  )
  if (!lyricsAfterCancelledSearch?.includes('Cached plain lyrics'))
    throw new Error('Cancelled lyrics search replaced the existing lyrics')
  await cdp.evaluate(
    'document.querySelector("[data-lyrics-search-mode=\\"synced\\"]").click()',
  )
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector(".lyrics-candidate"))'),
    'synced lyrics search candidates',
  )
  const syncedFirstCandidate = await cdp.evaluate(
    'document.querySelector(".lyrics-candidate")?.getAttribute("data-lyrics-synced")',
  )
  if (syncedFirstCandidate !== 'true')
    throw new Error(
      `Synced lyrics search did not prioritize timed candidates: ${syncedFirstCandidate}`,
    )
  await cdp.evaluate(
    'document.querySelector(".lyrics-search-panel .section-heading button").click()',
  )
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".lyrics-text__content")?.textContent.includes("Cached plain lyrics")',
      ),
    'plain lyrics after search cancellation',
  )
  await cdp.evaluate(
    'document.querySelector("[data-lyrics-search-mode=\\"synced\\"]").click()',
  )
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector(".lyrics-candidate"))'),
    'timed lyrics candidates after search cancellation',
  )
  await cdp.evaluate(
    `[...document.querySelectorAll('.lyrics-candidate[data-lyrics-synced="true"]')]
      .find((row) => row.querySelector('strong')?.textContent.includes('Candidate Song'))
      ?.querySelector('.lyrics-candidate__action')?.click()`,
  )
  await waitFor(
    () =>
      cdp.evaluate(
        `window.electronAPI.loadLyrics('${trackCId}').then((lyrics) =>
          lyrics.kind === 'lrc' && lyrics.content.includes('Candidate lyrics'))`,
      ),
    'timed lyrics persistence after selection',
  )
  await clickCoverByTitle(cdp, 'Candidate Song')
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".now-panel__track strong")?.textContent.includes("Candidate Song")',
      ),
    'track switch after timed lyrics selection',
  )
  await clickCoverByTitle(cdp, 'Square Track')
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".now-panel__track strong")?.textContent.includes("Square Track")',
      ),
    'plain lyrics track after switching back',
  )
  await cdp.evaluate(
    'window.dispatchEvent(new CustomEvent("pulse:panel-tab", { detail: "lyrics" }))',
  )
  await waitFor(
    () =>
      cdp.evaluate(
        `window.electronAPI.loadLyrics('${trackCId}').then((lyrics) =>
          lyrics.kind === 'lrc' && lyrics.content.includes('Candidate lyrics'))`,
      ),
    'saved timed lyrics after track switch',
  )
  await waitFor(
    () =>
      cdp.evaluate(
        'Boolean(document.querySelector(".lyrics-synced .is-active"))',
      ),
    'timed lyrics UI after track switch',
  )
  await cdp.evaluate(`window.electronAPI.saveLyricsSelection('${trackDId}', {
    id: 902,
    trackName: 'Plain Timeline Track',
    artistName: 'Plain Timeline Artist',
    plainLyrics: '夜空を見上げた\\n名前を呼んでいた\\n静かな風が吹く\\n明日へ歩き出す\\n光を信じてる',
    instrumental: false,
    provider: 'lrclib',
    sourceLabel: 'LRCLIB',
  })`)
  await clickCoverByTitle(cdp, 'No Cover Track')
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".now-panel__track strong")?.textContent.includes("No Cover Track")',
      ),
    'plain timeline track',
  )
  await cdp.evaluate(
    'window.dispatchEvent(new CustomEvent("pulse:panel-tab", { detail: "lyrics" }))',
  )
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector("[data-auto-sync-availability=available]") && !document.querySelector("[data-auto-sync-trigger]")?.disabled',
      ),
    'plain-only auto-sync availability',
  )
  await cdp.evaluate(
    'document.querySelector("[data-auto-sync-trigger]").click()',
  )
  await waitFor(
    () =>
      cdp.evaluate(
        'Boolean(document.querySelector("[data-auto-sync-confirmation]"))',
      ),
    'plain-only auto-sync confirmation',
  )
  await cdp.evaluate(
    'document.querySelector("[data-auto-sync-confirm-start]").click()',
  )
  await waitFor(
    () =>
      cdp.evaluate(
        'Boolean(document.querySelector("[data-auto-sync-result]"))',
      ),
    'plain-only auto-sync result',
  )
  const plainResultText = await cdp.evaluate(
    'document.querySelector("[data-auto-sync-result]")?.innerText ?? ""',
  )
  if (!plainResultText.includes('3개 줄별 시간'))
    throw new Error(
      `Plain-only result did not exclude unsafe lines: ${plainResultText}`,
    )
  const beforePlainPreview = await cdp.evaluate(
    `window.electronAPI.getGeneratedLyricsTimeline('${trackDId}')`,
  )
  if (beforePlainPreview.timeline !== null)
    throw new Error('Plain-only result persisted before explicit apply')
  const plainEditorAvailability = await cdp.evaluate(`(() => ({
    editDisabled: document.querySelector('[data-auto-sync-edit]')?.disabled,
    applyDisabled: document.querySelector('[data-auto-sync-apply]')?.disabled,
    timestampCount: Number(document.querySelector('[data-auto-sync-edit]')?.getAttribute('data-auto-sync-editable-timestamps')),
  }))()`)
  if (
    plainEditorAvailability.editDisabled ||
    plainEditorAvailability.timestampCount !== 4
  )
    throw new Error(
      `Plain preview manual editor should accept low-confidence timestamps: ${JSON.stringify(plainEditorAvailability)}`,
    )
  await cdp.evaluate('document.querySelector("[data-auto-sync-edit]").click()')
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector("[data-generated-sync-editor]"))'),
    'plain-only generated timeline editor',
  )
  const generatedEditorInitialState = await cdp.evaluate(`(() => ({
    lowConfidenceTimed: document.querySelector('[data-generated-line-index="1"]')?.getAttribute('data-generated-line-timed'),
    unmatchedTimed: document.querySelector('[data-generated-line-index="4"]')?.getAttribute('data-generated-line-timed'),
    unmatchedDisabled: document.querySelector('[data-generated-line-index="4"]')?.disabled,
  }))()`)
  if (
    generatedEditorInitialState.lowConfidenceTimed !== 'true' ||
    generatedEditorInitialState.unmatchedTimed !== 'false' ||
    generatedEditorInitialState.unmatchedDisabled
  )
    throw new Error(
      `Generated editor did not retain preview timestamps and blank unmatched lines: ${JSON.stringify(generatedEditorInitialState)}`,
    )
  const whilePlainEditing = await cdp.evaluate(
    `window.electronAPI.getGeneratedLyricsTimeline('${trackDId}')`,
  )
  if (whilePlainEditing.timeline !== null)
    throw new Error('Opening the generated timeline editor unexpectedly persisted it')
  await cdp.evaluate(
    'document.querySelector("[data-generated-sync-editor] .button:not(.button--primary)").click()',
  )
  await cdp.evaluate(
    'document.querySelector("[data-auto-sync-preview]").click()',
  )
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".lyrics-generated")?.getAttribute("data-auto-sync-preview-active") === "true"',
      ),
    'plain-only generated timeline preview',
  )
  await pausePlayer(cdp)
  await cdp.evaluate(`(() => {
    window.__lyricsScrollCalls = []
    Element.prototype.scrollIntoView = function () {
      window.__lyricsScrollCalls.push(
        this.getAttribute('data-generated-line-index') ?? this.textContent ?? '',
      )
    }
  })()`)
  const duringPlainPreview = await cdp.evaluate(
    `window.electronAPI.getGeneratedLyricsTimeline('${trackDId}')`,
  )
  if (duringPlainPreview.timeline !== null)
    throw new Error('Plain-only preview unexpectedly persisted')
  await cdp.evaluate(
    `document.querySelector('[data-generated-line-index="0"]').click()`,
  )
  await waitFor(
    () =>
      cdp.evaluate(
        `document.querySelector('[data-generated-line-index="0"]')?.classList.contains('is-active')`,
      ),
    'first generated lyric highlight',
  )
  const firstGeneratedScrollCount = await cdp.evaluate(
    'window.__lyricsScrollCalls.length',
  )
  await seekPlayer(cdp, 20.7)
  await delay(100)
  const generatedBeforeNextTimestamp = await cdp.evaluate(`(() => ({
    firstActive: document.querySelector('[data-generated-line-index="0"]')?.classList.contains('is-active'),
    unmatchedActive: document.querySelector('[data-generated-line-index="1"]')?.classList.contains('is-active'),
    scrollCount: window.__lyricsScrollCalls.length,
  }))()`)
  if (
    !generatedBeforeNextTimestamp.firstActive ||
    generatedBeforeNextTimestamp.unmatchedActive ||
    generatedBeforeNextTimestamp.scrollCount !== firstGeneratedScrollCount
  )
    throw new Error(
      `Generated line did not stay active without repeated scrolling: ${JSON.stringify(generatedBeforeNextTimestamp)}`,
    )
  await cdp.evaluate(
    `document.querySelector('[data-generated-line-index="2"]').click()`,
  )
  await waitFor(
    () =>
      cdp.evaluate(
        `document.querySelector('[data-generated-line-index="2"]')?.classList.contains('is-active')`,
    ),
    'generated lyric highlight after seek',
  )
  const secondGeneratedScrollCount = await cdp.evaluate(
    'window.__lyricsScrollCalls.length',
  )
  if (secondGeneratedScrollCount !== firstGeneratedScrollCount + 1)
    throw new Error('Generated timeline did not scroll exactly once after active line changed')
  await seekPlayer(cdp, 5)
  await waitFor(
    () =>
      cdp.evaluate(
        `document.querySelector('[data-generated-line-index="0"]')?.classList.contains('is-active')`,
      ),
    'generated lyric highlight after backward seek',
  )
  const backwardGeneratedScrollCount = await cdp.evaluate(
    'window.__lyricsScrollCalls.length',
  )
  await seekPlayer(cdp, 10)
  await delay(100)
  const unchangedGeneratedScrollCount = await cdp.evaluate(
    'window.__lyricsScrollCalls.length',
  )
  if (unchangedGeneratedScrollCount !== backwardGeneratedScrollCount)
    throw new Error('Generated timeline scrolled while the active line was unchanged')
  await cdp.evaluate('document.querySelector("[data-auto-sync-apply]").click()')
  await waitFor(
    () =>
      cdp.evaluate(
        `window.electronAPI.getGeneratedLyricsTimeline('${trackDId}').then((state) => state.valid && state.timeline?.lines.length === 3)`,
      ),
    'plain-only generated timeline persistence',
  )
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector("[data-generated-timeline-edit]"))'),
    'inline generated timeline edit button',
  )
  await cdp.evaluate('document.querySelector("[data-generated-timeline-edit]").click()')
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector("[data-generated-inline-editor]"))'),
    'inline generated timeline editor',
  )
  await cdp.evaluate(`document.querySelector('[data-generated-line-index="2"]').click()`)
  await waitFor(
    () =>
      cdp.evaluate(
        `document.querySelector('[data-generated-line-index="2"]')?.classList.contains('is-selected')`,
      ),
    'selected inline generated line two',
  )
  const timestampControlVisual = await cdp.evaluate(`(() => {
    const current = document.querySelector('[data-generated-inline-current]')
    const remove = document.querySelector('[data-generated-inline-delete]')
    current.focus()
    const currentStyle = getComputedStyle(current)
    const removeStyle = getComputedStyle(remove)
    const rect = current.getBoundingClientRect()
    return {
      currentBackground: currentStyle.backgroundColor,
      currentColor: currentStyle.color,
      currentBorder: currentStyle.borderColor,
      focusOutline: currentStyle.outlineColor,
      removeBackground: removeStyle.backgroundColor,
      removeColor: removeStyle.color,
      removeBorder: removeStyle.borderColor,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    }
  })()`)
  if (
    timestampControlVisual.currentBackground !== 'rgb(24, 35, 61)' ||
    timestampControlVisual.currentColor !== 'rgb(244, 247, 255)' ||
    timestampControlVisual.currentBorder !== 'rgb(53, 70, 111)' ||
    timestampControlVisual.focusOutline !== 'rgb(120, 162, 255)' ||
    timestampControlVisual.removeBackground !== 'rgb(53, 28, 42)' ||
    timestampControlVisual.removeColor !== 'rgb(255, 215, 225)' ||
    timestampControlVisual.removeBorder !== 'rgb(113, 54, 76)'
  )
    throw new Error(
      `Timestamp control contrast is incorrect: ${JSON.stringify(timestampControlVisual)}`,
    )
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: timestampControlVisual.x,
    y: timestampControlVisual.y,
  })
  await delay(50)
  const timestampControlHover = await cdp.evaluate(
    `getComputedStyle(document.querySelector('[data-generated-inline-current]')).backgroundColor`,
  )
  if (timestampControlHover !== 'rgb(34, 52, 92)')
    throw new Error(`Timestamp control hover contrast is incorrect: ${timestampControlHover}`)
  const setInlineInput = async (value) =>
    cdp.evaluate(`(() => {
      const input = document.querySelector('[data-generated-inline-editor] input')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter.call(input, ${JSON.stringify(value)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
  await setInlineInput('00:00.500')
  const reverseInlineState = await cdp.evaluate(`(() => ({
    saveDisabled: document.querySelector('[data-generated-inline-save]')?.disabled,
    lineError: document.querySelector('[data-generated-inline-editor] [role=alert]')?.textContent,
  }))()`)
  if (!reverseInlineState.saveDisabled || !reverseInlineState.lineError)
    throw new Error(
      `Inline editor did not block reverse timestamp saving: ${JSON.stringify(reverseInlineState)}`,
    )
  await setInlineInput('99:59.999')
  const outOfRangeInlineState = await cdp.evaluate(
    `document.querySelector('[data-generated-inline-save]')?.disabled`,
  )
  if (!outOfRangeInlineState)
    throw new Error('Inline editor did not block out-of-range timestamp saving')
  await cdp.evaluate(`document.querySelector('[data-generated-line-index="1"]').click()`)
  await waitFor(
    () =>
      cdp.evaluate(
        `document.querySelector('[data-generated-line-index="1"]')?.classList.contains('is-selected')`,
      ),
    'selected inline generated unmatched line',
  )
  const disabledTimestampControl = await cdp.evaluate(`(() => {
    const button = document.querySelector('[data-generated-inline-delete]')
    const style = getComputedStyle(button)
    return {
      disabled: button.disabled,
      background: style.backgroundColor,
      color: style.color,
      border: style.borderColor,
      opacity: style.opacity,
      cursor: style.cursor,
    }
  })()`)
  if (
    !disabledTimestampControl.disabled ||
    disabledTimestampControl.background !== 'rgb(21, 29, 48)' ||
    disabledTimestampControl.color !== 'rgb(127, 138, 168)' ||
    disabledTimestampControl.border !== 'rgb(41, 52, 79)' ||
    disabledTimestampControl.opacity !== '0.7' ||
    disabledTimestampControl.cursor !== 'not-allowed'
  )
    throw new Error(
      `Disabled timestamp control contrast is incorrect: ${JSON.stringify(disabledTimestampControl)}`,
    )
  await cdp.evaluate(`(() => {
    document.querySelector('[data-generated-inline-current]').click()
  })()`)
  await waitFor(
    () =>
      cdp.evaluate(
        `document.querySelector('[data-generated-line-index="1"]')?.getAttribute('data-generated-line-timed') === 'true'`,
      ),
    'new inline generated timestamp',
  )
  await cdp.evaluate(`document.querySelector('[data-generated-inline-delete]').click()`)
  const deletedInlineTiming = await waitFor(
    () =>
      cdp.evaluate(
        `document.querySelector('[data-generated-line-index="1"]')?.getAttribute('data-generated-line-timed') === 'false'`,
      ),
    'deleted inline generated timestamp',
  )
  if (!deletedInlineTiming)
    throw new Error('Inline editor did not delete a generated timestamp')
  await cdp.evaluate('document.querySelector("[data-generated-inline-cancel]").click()')
  const afterInlineCancel = await cdp.evaluate(
    `window.electronAPI.getGeneratedLyricsTimeline('${trackDId}')`,
  )
  if (afterInlineCancel.timeline?.lines.length !== 3)
    throw new Error('Cancelling inline generated editing unexpectedly persisted changes')

  await seekPlayer(cdp, 10)
  await cdp.evaluate(`document.querySelector('[data-generated-timeline-edit]').click()`)
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector("[data-generated-inline-editor]"))'),
    'reopened inline generated timeline editor',
  )
  await cdp.evaluate(`document.querySelector('[data-generated-line-index="1"]').click()`)
  await waitFor(
    () =>
      cdp.evaluate(
        `document.querySelector('[data-generated-line-index="1"]')?.classList.contains('is-selected')`,
      ),
    'selected inline generated line one for save',
  )
  await cdp.evaluate(`document.querySelector('[data-generated-inline-current]').click()`)
  await cdp.evaluate(`document.querySelector('[data-generated-line-index="2"]').click()`)
  await waitFor(
    () =>
      cdp.evaluate(
        `document.querySelector('[data-generated-line-index="2"]')?.classList.contains('is-selected')`,
      ),
    'selected inline generated line two for save',
  )
  await cdp.evaluate(`document.querySelector('[data-generated-inline-adjust="500"]').click()`)
  await setInlineInput('00:21.300')
  const inlineDraftState = await cdp.evaluate(`(() => ({
    lineOneTimed: document.querySelector('[data-generated-line-index="1"]')?.getAttribute('data-generated-line-timed'),
    lineOneSource: document.querySelector('[data-generated-line-index="1"]')?.getAttribute('data-generated-line-source'),
    lineTwoSource: document.querySelector('[data-generated-line-index="2"]')?.getAttribute('data-generated-line-source'),
    saveDisabled: document.querySelector('[data-generated-inline-save]')?.disabled,
  }))()`)
  if (
    inlineDraftState.lineOneTimed !== 'true' ||
    inlineDraftState.lineOneSource !== 'manual' ||
    inlineDraftState.lineTwoSource !== 'manual' ||
    inlineDraftState.saveDisabled
  )
    throw new Error(
      `Inline editor did not retain draft timing and manual sources: ${JSON.stringify(inlineDraftState)}`,
    )
  await cdp.evaluate('document.querySelector("[data-generated-inline-save]").click()')
  await waitFor(
    () =>
      cdp.evaluate(
        `window.electronAPI.getGeneratedLyricsTimeline('${trackDId}').then((state) => state.valid && state.timeline?.lines.length === 4)`,
      ),
    'inline generated timeline save',
  )
  await waitFor(
    () =>
      cdp.evaluate(
        `document.querySelector('[data-generated-line-index="1"]')?.classList.contains('is-active')`,
      ),
    'active generated line after inline save',
  )
  await clickCoverByTitle(cdp, 'Candidate Song')
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".now-panel__track strong")?.textContent.includes("Candidate Song")',
      ),
    'track switch away from generated timeline',
  )
  await clickCoverByTitle(cdp, 'No Cover Track')
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector(".lyrics-generated"))'),
    'generated timeline after track switch and return',
  )
  await clickCoverByTitle(cdp, 'Candidate Song')

  const savedAfterSelection = JSON.parse(
    await readFile(path.join(userData, 'pulse-shelf-data.json'), 'utf8'),
  )
  if (savedAfterSelection.data.lyrics[trackAId]?.userSelected !== true)
    throw new Error(
      'Selected lyrics were not persisted with userSelected: true',
    )
  const requestsAfterSelection = trackARequests

  await clickCoverByTitle(cdp, 'Slow Track')
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".now-panel__track strong")?.textContent.includes("Slow Track")',
      ),
    'track B after selecting it',
  )
  await waitFor(
    () =>
      cdp.evaluate('Boolean(document.querySelector(".lyrics-search-panel"))'),
    'Lyrica fallback search panel',
  )
  await cdp.evaluate(
    'document.querySelector(".lyrics-search-actions .button--primary").click()',
  )
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector(".lyrics-candidate"))'),
    'Lyrica fallback candidate',
  )
  const lyricaCandidateText = await cdp.evaluate(
    'document.querySelector(".lyrics-candidate").innerText',
  )
  if (!lyricaCandidateText.includes('Lyrica · YouTube 자막'))
    throw new Error(`Lyrica source label is missing: ${lyricaCandidateText}`)
  await cdp.evaluate(
    'document.querySelector(".lyrics-candidate .button").click()',
  )
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".lyrics-synced")?.textContent.includes("Lyrica second line")',
      ),
    'selected Lyrica synced lyrics',
  )
  const appliedLyricaInfo = await cdp.evaluate(
    'document.querySelector(".lyrics-applied-info")?.innerText ?? ""',
  )
  if (
    !appliedLyricaInfo.includes('가사 출처: Lyrica · YouTube 자막') ||
    !appliedLyricaInfo.includes('싱크: 현재 영상 타임스탬프') ||
    !appliedLyricaInfo.includes('사용자 보정: 없음')
  )
    throw new Error(
      `Applied Lyrica information is incorrect: ${appliedLyricaInfo}`,
    )
  const savedLyricaLyrics = JSON.parse(
    await readFile(path.join(userData, 'pulse-shelf-data.json'), 'utf8'),
  )
  if (savedLyricaLyrics.data.lyrics[trackBId]?.source !== 'lyrica')
    throw new Error('Selected Lyrica lyrics did not persist their provider')
  if (
    savedLyricaLyrics.data.lyrics[trackBId]?.providerSource !==
    'youtube_transcript'
  )
    throw new Error(
      'Selected Lyrica lyrics did not persist their provider source',
    )
  const lyricaRequestsAfterSelection = lyricaRequests
  await clickCoverByTitle(cdp, 'Candidate Song')
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".now-panel__track strong")?.textContent.includes("Candidate Song")',
      ),
    'track A after returning to it',
  )
  await cdp.evaluate(
    'window.dispatchEvent(new CustomEvent("pulse:panel-tab", { detail: "lyrics" }))',
  )
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".lyrics-synced")?.textContent.includes("Candidate lyrics")',
      ),
    'saved lyrics after A to B to A',
  )
  await delay(700)
  if (trackARequests !== requestsAfterSelection)
    throw new Error('Returning to track A triggered another LRCLIB request')

  cdp.close()
  cdp = undefined
  await stop(app)
  await waitForDebugPortToClose(debugPort)
  app = start(
    electron,
    [
      '.',
      '--no-sandbox',
      '--disable-gpu',
      `--user-data-dir=${userData}`,
      `--remote-debugging-port=${debugPort}`,
    ],
    {
      VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173/',
      PULSE_SHELF_TEST_USER_DATA: userData,
      PULSE_SHELF_LRCLIB_API: `http://127.0.0.1:${address.port}/api`,
      PULSE_SHELF_LYRICA_API: `http://127.0.0.1:${address.port}`,
      PULSE_SHELF_AUTO_SYNC_TEST_COMMAND: process.execPath,
      PULSE_SHELF_AUTO_SYNC_TEST_SCRIPT: autoSyncWorker,
      PULSE_SHELF_AUTO_SYNC_MOCK_NO_COUNT: '1',
    },
  )
  const restartedPage = await waitFor(async () => {
    const pages = await (
      await fetch(`http://127.0.0.1:${debugPort}/json/list`)
    ).json()
    return pages.find(
      (entry) => entry.type === 'page' && entry.url.includes('5173'),
    )
  }, 'restarted Electron DevTools endpoint')
  cdp = new Cdp(restartedPage.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector(".cover-item"))'),
    'recent track after restart',
  )
  await clickCoverByTitle(cdp, 'Candidate Song')
  await cdp.evaluate('document.querySelector(".open-now-panel")?.click()')
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".now-panel")?.classList.contains("is-open")',
      ),
    'Now Playing panel after restart',
  )
  await cdp.evaluate(
    'window.dispatchEvent(new CustomEvent("pulse:panel-tab", { detail: "lyrics" }))',
  )
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".lyrics-synced")?.textContent.includes("Candidate lyrics")',
      ),
    'saved lyrics after app restart',
  )
  const persistedSyncProfile = await cdp.evaluate(
    `window.electronAPI.getLyricsSyncProfile('${trackAId}')`,
  )
  if (persistedSyncProfile?.offsetMs !== 3000)
    throw new Error(
      `Lyrics sync profile did not persist after restart: ${JSON.stringify(persistedSyncProfile)}`,
    )
  await clickCoverByTitle(cdp, 'No Cover Track')
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector(".lyrics-generated"))'),
    'generated timeline after app restart',
  )
  const restartedGeneratedTimeline = await cdp.evaluate(
    `window.electronAPI.getGeneratedLyricsTimeline('${trackDId}')`,
  )
  if (
    !restartedGeneratedTimeline.valid ||
    restartedGeneratedTimeline.timeline?.lines.length !== 4 ||
    restartedGeneratedTimeline.timeline?.lines.find((line) => line.lineIndex === 1)
      ?.source !== 'manual' ||
    restartedGeneratedTimeline.timeline?.lines.find((line) => line.lineIndex === 2)
      ?.source !== 'manual'
  )
    throw new Error(
      `Generated timeline did not persist after restart: ${JSON.stringify(restartedGeneratedTimeline)}`,
    )
  await cdp.evaluate(`window.electronAPI.saveLyricsSelection('${trackDId}', {
    id: 903,
    trackName: 'Changed Plain Lyrics',
    artistName: 'Plain Timeline Artist',
    plainLyrics: 'Plain lyrics',
    instrumental: false,
    provider: 'lrclib',
    sourceLabel: 'LRCLIB',
  })`)
  await clickCoverByTitle(cdp, 'Candidate Song')
  await clickCoverByTitle(cdp, 'No Cover Track')
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".lyrics-sync-unavailable[role=alert]")?.textContent.includes("현재 가사")',
      ),
    'stale generated timeline rejection after lyrics replacement',
  )
  const staleGeneratedTimeline = await cdp.evaluate(
    `window.electronAPI.getGeneratedLyricsTimeline('${trackDId}')`,
  )
  if (staleGeneratedTimeline.valid)
    throw new Error(
      `Generated timeline stale rejection failed: ${JSON.stringify(staleGeneratedTimeline)}`,
    )
  await cdp.evaluate(
    'document.querySelector("[data-generated-timeline-reset]").click()',
  )
  await waitFor(
    () =>
      cdp.evaluate(
        `window.electronAPI.getGeneratedLyricsTimeline('${trackDId}').then((state) => state.timeline === null)`,
      ),
    'generated timeline reset',
  )
  const resetPlainState = await cdp.evaluate(`(() => ({
    hasGenerated: Boolean(document.querySelector('.lyrics-generated')),
    hasActive: Boolean(document.querySelector('.lyrics-text .is-active')),
    text: document.querySelector('.lyrics-text__content')?.textContent,
  }))()`)
  if (
    resetPlainState.hasGenerated ||
    resetPlainState.hasActive ||
    !resetPlainState.text?.includes('Plain lyrics')
  )
    throw new Error(
      `Generated timeline reset did not restore plain lyrics: ${JSON.stringify(resetPlainState)}`,
    )
  const requestsAfterGeneratedTimelineReplacement = trackARequests
  const lyricaRequestsAfterGeneratedTimelineReplacement = lyricaRequests
  await clickCoverByTitle(cdp, 'Square Track')
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".lyrics-synced")?.textContent.includes("Candidate lyrics")',
      ),
    'timed lyrics after app restart',
  )
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector("[data-auto-sync-trigger]") && !document.querySelector("[data-auto-sync-trigger]")?.disabled',
      ),
    'low-quality synced auto-sync availability',
  )
  await cdp.evaluate('document.querySelector("[data-auto-sync-trigger]").click()')
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector("[data-auto-sync-confirmation]"))'),
    'low-quality synced auto-sync confirmation',
  )
  await cdp.evaluate('document.querySelector("[data-auto-sync-confirm-start]").click()')
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector("[data-auto-sync-result]"))'),
    'low-quality synced auto-sync result',
  )
  const lowQualityEditorAvailability = await cdp.evaluate(`(() => ({
    quality: document.querySelector('[data-auto-sync-result]')?.getAttribute('data-auto-sync-quality'),
    editDisabled: document.querySelector('[data-auto-sync-edit]')?.disabled,
    applyDisabled: document.querySelector('[data-auto-sync-apply]')?.disabled,
    timestampCount: Number(document.querySelector('[data-auto-sync-edit]')?.getAttribute('data-auto-sync-editable-timestamps')),
  }))()`)
  if (
    lowQualityEditorAvailability.quality !== 'low' ||
    lowQualityEditorAvailability.editDisabled ||
    !lowQualityEditorAvailability.applyDisabled ||
    lowQualityEditorAvailability.timestampCount !== 2
  )
    throw new Error(
      `Low-quality preview did not separate apply from manual editing: ${JSON.stringify(lowQualityEditorAvailability)}`,
    )
  await cdp.evaluate('document.querySelector("[data-auto-sync-edit]").click()')
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector(".lyrics-sync-editor"))'),
    'low-quality synced editor',
  )
  await cdp.evaluate(
    'document.querySelector(".lyrics-sync-editor .button:not(.button--primary)").click()',
  )
  await cdp.evaluate('document.querySelector("[data-auto-sync-discard]").click()')
  await cdp.evaluate(`window.electronAPI.saveLyricsSelection('${trackCId}', {
    id: 904,
    trackName: 'Square Track',
    artistName: 'Square Artist',
    syncedLyrics: '[00:00.00]Zero one\\n[00:01.00]Zero two',
    plainLyrics: 'Zero one\\nZero two',
    instrumental: false,
    provider: 'lrclib',
    sourceLabel: 'LRCLIB',
  })`)
  await clickCoverByTitle(cdp, 'Candidate Song')
  await clickCoverByTitle(cdp, 'Square Track')
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector(".lyrics-synced"))'),
    'zero-timestamp synced lyrics',
  )
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector("[data-auto-sync-trigger]") && !document.querySelector("[data-auto-sync-trigger]")?.disabled',
      ),
    'zero-timestamp auto-sync availability',
  )
  await cdp.evaluate('document.querySelector("[data-auto-sync-trigger]").click()')
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector("[data-auto-sync-confirmation]"))'),
    'zero-timestamp auto-sync confirmation',
  )
  await cdp.evaluate('document.querySelector("[data-auto-sync-confirm-start]").click()')
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector("[data-auto-sync-result]"))'),
    'zero-timestamp auto-sync result',
  )
  const zeroTimestampEditorAvailability = await cdp.evaluate(`(() => ({
    editDisabled: document.querySelector('[data-auto-sync-edit]')?.disabled,
    applyDisabled: document.querySelector('[data-auto-sync-apply]')?.disabled,
    timestampCount: Number(document.querySelector('[data-auto-sync-edit]')?.getAttribute('data-auto-sync-editable-timestamps')),
  }))()`)
  if (
    !zeroTimestampEditorAvailability.editDisabled ||
    !zeroTimestampEditorAvailability.applyDisabled ||
    zeroTimestampEditorAvailability.timestampCount !== 0
  )
    throw new Error(
      `Zero-timestamp preview should keep the manual editor unavailable: ${JSON.stringify(zeroTimestampEditorAvailability)}`,
    )
  await cdp.evaluate('document.querySelector("[data-auto-sync-discard]").click()')
  await clickCoverByTitle(cdp, 'Candidate Song')
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".lyrics-synced")?.textContent.includes("Candidate lyrics")',
      ),
    'track A after plain lyrics persistence check',
  )
  await waitFor(
    () =>
      cdp.evaluate(
        'Boolean(document.querySelector(".lyrics-sync-status button"))',
      ),
    'lyrics sync reset control',
  )
  await cdp.evaluate(
    'document.querySelector(".lyrics-sync-status button").click()',
  )
  await waitFor(
    () =>
      cdp.evaluate(
        `window.electronAPI.getLyricsSyncProfile('${trackAId}').then((profile) => profile === null)`,
      ),
    'lyrics sync reset',
  )
  if (trackARequests !== requestsAfterGeneratedTimelineReplacement)
    throw new Error(
      'Restarting the app triggered another LRCLIB request for track A',
    )
  await clickCoverByTitle(cdp, 'Slow Track')
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".now-panel__track strong")?.textContent.includes("Slow Track")',
      ),
    'Lyrica track after restart',
  )
  await cdp.evaluate(
    'window.dispatchEvent(new CustomEvent("pulse:panel-tab", { detail: "lyrics" }))',
  )
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".lyrics-synced")?.textContent.includes("Lyrica second line")',
      ),
    'persisted Lyrica lyrics after restart',
  )
  if (lyricaRequests !== lyricaRequestsAfterGeneratedTimelineReplacement)
    throw new Error('Restarting the app triggered another Lyrica request')
  await clickCoverByTitle(cdp, 'Candidate Song')
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".now-panel__track strong")?.textContent.includes("Candidate Song")',
      ),
    'track A after Lyrica persistence check',
  )
  await cdp.evaluate(`window.electronAPI.removeLyrics('${trackDId}')`)
  await clickCoverByTitle(cdp, 'No Cover Track')
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".now-panel__track strong")?.textContent.includes("No Cover Track")',
      ),
    'Lyrica error fixture track',
  )
  await cdp.evaluate(
    'window.dispatchEvent(new CustomEvent("pulse:panel-tab", { detail: "lyrics" }))',
  )
  await waitFor(
    () =>
      cdp.evaluate('Boolean(document.querySelector(".lyrics-search-panel"))'),
    'lyrics panel after Lyrica server error',
  )
  await cdp.evaluate(
    'document.querySelector(".lyrics-search-actions .button--primary").click()',
  )
  await waitFor(
    () =>
      cdp.evaluate(
        '!document.querySelector(".lyrics-search-actions .button--primary").disabled',
      ),
    'search recovery after Lyrica server error',
  )
  const unexpectedErrorCandidate = await cdp.evaluate(
    'document.querySelector(".lyrics-candidate")?.innerText ?? null',
  )
  if (unexpectedErrorCandidate)
    throw new Error(
      `Lyrica server error unexpectedly produced a candidate: ${unexpectedErrorCandidate}`,
    )
  await clickCoverByTitle(cdp, 'Candidate Song')
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".now-panel__track strong")?.textContent.includes("Candidate Song")',
      ),
    'track A after Lyrica error recovery',
  )

  await cdp.evaluate(`window.electronAPI.removeLyrics('${trackAId}')`)
  await clickCoverByTitle(cdp, 'Slow Track')
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".now-panel__track strong")?.textContent.includes("Slow Track")',
      ),
    'track B after removing track A lyrics',
  )
  await clickCoverByTitle(cdp, 'Candidate Song')
  await delay(700)
  const savedAfterRemoval = JSON.parse(
    await readFile(path.join(userData, 'pulse-shelf-data.json'), 'utf8'),
  )
  if (savedAfterRemoval.data.lyrics[trackAId])
    throw new Error('Removed lyrics were restored by stale renderer data')
  await cdp.evaluate(`window.electronAPI.saveLyricsSyncProfile({
    trackId: '${trackAId}', offsetMs: 1200, updatedAt: Date.now(), anchors: []
  })`)
  const removedWithSync = await cdp.evaluate(
    `window.electronAPI.removeTrack('${trackAId}')`,
  )
  if (!removedWithSync?.exclusionId)
    throw new Error(
      'Track removal did not create an undo exclusion for sync testing',
    )
  const restoredWithSync = await cdp.evaluate(
    `window.electronAPI.restoreLibraryExclusion(${JSON.stringify(removedWithSync.exclusionId)})`,
  )
  const restoredSyncTrack = restoredWithSync.tracks.find(
    (track) => track.fileName === 'track-a.wav',
  )
  if (!restoredSyncTrack)
    throw new Error('Removed track was not restored for sync profile testing')
  const restoredSyncProfile = await cdp.evaluate(
    `window.electronAPI.getLyricsSyncProfile(${JSON.stringify(restoredSyncTrack.id)})`,
  )
  if (restoredSyncProfile?.offsetMs !== 1200)
    throw new Error('Track removal undo did not restore the sync profile')
  process.stdout.write(
    `PULSE_SHELF_LYRICS_UI_TEST_OK\n${coverScreenshot}\n${horizontalCoverScreenshot}\n${searchScreenshot}\n${selectionScreenshot}\n`,
  )
} finally {
  cdp?.close()
  await stop(app)
  await stop(vite)
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await rm(harnessRoot, { recursive: true, force: true }).catch(() => undefined)
}
