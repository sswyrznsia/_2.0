import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
const trackDId = 'e'.repeat(64)
const trackAPath = path.join(harnessRoot, 'track-a.wav')
const trackBPath = path.join(harnessRoot, 'track-b.wav')
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

function silentWav() {
  const samples = 44_100
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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }

  close() {
    this.ws.terminate()
  }
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
          filePath: trackBPath,
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
    trackName: '君の知らない物語と非常に長い日本語の楽曲タイトルを表示するためのテスト',
    artistName: 'supercell and a deliberately long featured artist name',
    albumName: 'Today Is A Beautiful Day · Long Album Edition With Extra Notes',
    duration: 339,
    syncedLyrics: '[00:00.00]Long title lyrics',
    plainLyrics: 'Long title lyrics',
    instrumental: false,
  },
  {
    id: 79,
    trackName: 'A candidate with a very long English title that must stay contained',
    artistName: 'Long Artist',
    albumName: 'A very long album name that should wrap inside the candidate content column',
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
              { text: 'Lyrica first line', start_time: 0, end_time: 500, id: 1 },
              { text: 'Lyrica second line', start_time: 500, end_time: 900, id: 2 },
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

  const selectCover = async (index, title, expectedShape) => {
    await cdp.evaluate(
      `document.querySelectorAll('.cover-item')[${index}].click()`,
    )
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
  await selectCover(1, 'Slow Track', 'wide')
  const horizontalCapture = await cdp.send('Page.captureScreenshot', {
    format: 'png',
  })
  await writeFile(
    horizontalCoverScreenshot,
    Buffer.from(horizontalCapture.data, 'base64'),
  )
  await selectCover(2, 'Square Track', 'square')
  await selectCover(3, 'No Cover Track', 'empty')
  await selectCover(0, 'Candidate Song', 'tall')
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
          !row.fits || !row.actionVisible || row.actionWidth < 58 || row.contentWidth < 1,
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
    () => cdp.evaluate('Boolean(document.querySelector(".lyrics-sync-editor"))'),
    'lyrics sync editor',
  )
  const syncControls = await cdp.evaluate(`(() => ({
    editor: document.querySelector('.lyrics-sync-editor')?.textContent,
    offsetButtons: [...document.querySelectorAll('.lyrics-sync-editor button')]
      .filter((button) => button.textContent.includes('ms')).length,
  }))()`)
  if (syncControls.offsetButtons !== 4)
    throw new Error(`Lyrics sync offset controls are incomplete: ${JSON.stringify(syncControls)}`)
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
    throw new Error(`Lyrics sync offset was not saved: ${JSON.stringify(savedOffset)}`)
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
    throw new Error('Cancelling lyrics sync editing did not restore the saved profile')
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
  await cdp.evaluate('document.querySelector(".lyrics-search-trigger").click()')
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector(".lyrics-candidate"))'),
    'candidate selection after sync profile',
  )
  await cdp.evaluate('document.querySelector(".lyrics-candidate .button").click()')
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector(".lyrics-synced"))'),
    'synced lyrics after replacing candidate',
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

  const savedAfterSelection = JSON.parse(
    await readFile(path.join(userData, 'pulse-shelf-data.json'), 'utf8'),
  )
  if (savedAfterSelection.data.lyrics[trackAId]?.userSelected !== true)
    throw new Error(
      'Selected lyrics were not persisted with userSelected: true',
    )
  const requestsAfterSelection = trackARequests

  await cdp.evaluate('document.querySelectorAll(".cover-item")[1].click()')
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".now-panel__track strong")?.textContent.includes("Slow Track")',
      ),
    'track B after selecting it',
  )
  await waitFor(
    () => cdp.evaluate('Boolean(document.querySelector(".lyrics-search-panel"))'),
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
  await cdp.evaluate('document.querySelector(".lyrics-candidate .button").click()')
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
    throw new Error(`Applied Lyrica information is incorrect: ${appliedLyricaInfo}`)
  const savedLyricaLyrics = JSON.parse(
    await readFile(path.join(userData, 'pulse-shelf-data.json'), 'utf8'),
  )
  if (savedLyricaLyrics.data.lyrics[trackBId]?.source !== 'lyrica')
    throw new Error('Selected Lyrica lyrics did not persist their provider')
  if (savedLyricaLyrics.data.lyrics[trackBId]?.providerSource !== 'youtube_transcript')
    throw new Error('Selected Lyrica lyrics did not persist their provider source')
  const lyricaRequestsAfterSelection = lyricaRequests
  await cdp.evaluate('document.querySelectorAll(".cover-item")[0].click()')
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
  await cdp.evaluate('document.querySelectorAll(".cover-item")[0].click()')
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
  await cdp.evaluate('document.querySelector(".lyrics-sync-status button").click()')
  await waitFor(
    () =>
      cdp.evaluate(
        `window.electronAPI.getLyricsSyncProfile('${trackAId}').then((profile) => profile === null)`,
      ),
    'lyrics sync reset',
  )
  if (trackARequests !== requestsAfterSelection)
    throw new Error(
      'Restarting the app triggered another LRCLIB request for track A',
    )
  await cdp.evaluate('document.querySelectorAll(".cover-item")[1].click()')
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
  if (lyricaRequests !== lyricaRequestsAfterSelection)
    throw new Error('Restarting the app triggered another Lyrica request')
  await cdp.evaluate('document.querySelectorAll(".cover-item")[0].click()')
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".now-panel__track strong")?.textContent.includes("Candidate Song")',
      ),
    'track A after Lyrica persistence check',
  )
  await cdp.evaluate('document.querySelectorAll(".cover-item")[3].click()')
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
    () => cdp.evaluate('Boolean(document.querySelector(".lyrics-search-panel"))'),
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
  await cdp.evaluate('document.querySelectorAll(".cover-item")[0].click()')
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".now-panel__track strong")?.textContent.includes("Candidate Song")',
      ),
    'track A after Lyrica error recovery',
  )

  await cdp.evaluate(`window.electronAPI.removeLyrics('${trackAId}')`)
  await cdp.evaluate('document.querySelectorAll(".cover-item")[1].click()')
  await waitFor(
    () =>
      cdp.evaluate(
        'document.querySelector(".now-panel__track strong")?.textContent.includes("Slow Track")',
      ),
    'track B after removing track A lyrics',
  )
  await cdp.evaluate('document.querySelectorAll(".cover-item")[0].click()')
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
    throw new Error('Track removal did not create an undo exclusion for sync testing')
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
