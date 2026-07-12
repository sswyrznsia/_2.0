import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import electron from 'electron'
import WebSocket from 'ws'

const root = process.cwd()
const harnessRoot = await mkdtemp(path.join(os.tmpdir(), 'pulse-shelf-ui-test-'))
const userData = path.join(harnessRoot, 'user-data')
const musicFolder = path.join(harnessRoot, 'music')
const screenshotDir = path.join(root, 'artifacts', 'home-layout')
const debugPort = 9222
const taskbarTest = process.env.PULSE_SHELF_TASKBAR_TEST === '1'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

function start() {
  const child = spawn(
    electron,
    ['.', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${debugPort}`],
    {
      cwd: root,
      env: {
        ...process.env,
        PULSE_SHELF_TEST_USER_DATA: userData,
        PULSE_SHELF_DISABLE_FOREGROUND_PROBE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.on('data', (chunk) => process.stdout.write(chunk))
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))
  return child
}

async function stop(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
    })
    await once(killer, 'exit').catch(() => undefined)
  } else child.kill()
}

async function json(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} returned ${response.status}`)
  return response.json()
}

function testWav() {
  const sampleRate = 8_000
  const samples = sampleRate * 5
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + samples * 2, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples * 2, 40)
  return buffer
}

function generatedLyricsHash(value) {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}

function fixture(audioPath, nextAudioPath) {
  const id = 'a'.repeat(64)
  const nextId = 'b'.repeat(64)
  const generatedLyrics = 'Generated first line\nGenerated second line'
  const now = Date.now()
  const track = (trackId, filePath, title, artist, addedAt) => ({
    id: trackId,
    fileName: path.basename(filePath),
    title,
    artist,
    album: 'Layout Test Album',
    duration: 180,
    format: 'wav',
    fileSize: testWav().byteLength,
    modifiedAt: now,
    addedAt,
    liked: false,
    playCount: 1,
    lastPlayedAt: addedAt,
    filePath,
  })
  return {
    data: {
      version: 4,
      musicFolders: [musicFolder],
      tracks: [
        track(id, audioPath, 'Layout Test Track', 'Pulse Shelf', now),
        track(nextId, nextAudioPath, 'Next Layout Track', 'Pulse Shelf Test', now - 1),
      ],
      libraryExclusions: [],
      playlists: [],
      recentTrackIds: [id, nextId],
      lyrics: {
        [id]: {
          trackId: id,
          source: 'manual',
          syncedLyrics: '[00:00.000]今度こそ生き返れない そう思ったベッドの中で何度も何度も歌う長い日本語の歌詞です\n[00:00.500]そう思ったベッドの中',
          plainLyrics: '今度こそ生き返れない そう思ったベッドの中で何度も何度も歌う長い日本語の歌詞です\nそう思ったベッドの中',
          fetchedAt: now,
          userSelected: true,
        },
        [nextId]: {
          trackId: nextId,
          source: 'manual-input',
          plainLyrics: generatedLyrics,
          fetchedAt: now,
          userSelected: true,
        },
      },
      lyricsSyncProfiles: {},
      generatedLyricsTimelines: {
        [nextId]: {
          trackId: nextId,
          source: 'manual',
          lineCount: 2,
          lyricsTextHash: generatedLyricsHash(generatedLyrics),
          lines: generatedLyrics.split('\n').map((text, lineIndex) => ({
            lineIndex,
            textHash: generatedLyricsHash(text),
            audioTimeMs: lineIndex * 500,
          })),
          createdAt: now,
        },
      },
      settings: {
        theme: 'dark', restoreLastPage: true, restoreQueue: true, autoplay: false,
        discordPresence: false, autoLaunch: false, closeBehavior: 'tray',
        miniAlwaysOnTop: true, defaultVolume: 0.8,
        autoFetchLyricsOnImport: true, autoFetchLyricsOnPlay: true,
        preferSyncedLyrics: true, lyricsAutoMatchThreshold: 0.9,
        taskbarModeEnabled: taskbarTest,
        taskbarModeShowOnStartup: taskbarTest,
        taskbarModeRestoreLastState: true,
        taskbarTogglePosition: 'right',
        taskbarToggleTrayReservedWidth: 350,
        taskbarToggleCustomRightGap: 362,
        taskbarModeShortcuts: true,
        taskbarModeOpacity: 1,
        taskbarLyricsEnabled: true,
        taskbarLyricsDisplay: 'current-next',
      },
      lastPage: 'home',
      playerSession: {
        queueIds: [id, nextId], currentIndex: 0, currentTime: 0,
        volume: 0.8, isMuted: false, shuffle: false, repeatMode: 'off',
      },
      focus: {
        today: new Date().toISOString().slice(0, 10), focusedSeconds: 0, todos: [],
        timer: { mode: 'focus', status: 'idle', focusMinutes: 25, breakMinutes: 5, remainingSeconds: 1500 },
      },
      onboardingCompleted: true,
    },
  }
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.nextId = 1
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
  connect() { return this.ready }
  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }
  close() { this.ws.close() }
}

async function connectTarget(query, label) {
  const target = await waitFor(async () => {
    const pages = await json(`http://127.0.0.1:${debugPort}/json/list`)
    return pages.find((page) => page.type === 'page' && query(page.url))
  }, label)
  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  return cdp
}

async function click(page, selector) {
  const point = await page.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) return null
    const rect = element.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  if (!point) throw new Error(`Missing ${selector}`)
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}

async function runPowerShell(script, label, captureOutput = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { stdio: ['ignore', captureOutput ? 'pipe' : 'ignore', 'ignore'] },
    )
    let output = ''
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error(`${label} exited ${code}`)),
    )
  })
}

async function clickNativeDesktop(x, y, count = 1) {
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PulseShelfNativeClick {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
"@
[void][PulseShelfNativeClick]::SetProcessDpiAwarenessContext([IntPtr](-4))
[void][PulseShelfNativeClick]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})
for ($index = 0; $index -lt ${count}; $index++) {
  [PulseShelfNativeClick]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  [PulseShelfNativeClick]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 35
}`
  await runPowerShell(script, 'Native click')
}

const measure = `(() => {
  const rect = (selector) => {
    const element = document.querySelector(selector)
    if (!element) return null
    const value = element.getBoundingClientRect()
    return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height }
  }
  const home = document.querySelector('.home-page')
  const main = document.querySelector('.main-content')
  return {
    viewport: { width: innerWidth, height: innerHeight },
    scroll: {
      document: [document.documentElement.clientHeight, document.documentElement.scrollHeight],
      home: [home?.clientHeight, home?.scrollHeight], main: [main?.clientHeight, main?.scrollHeight],
    },
    card: rect('.cover-grid .cover-item-wrap'), cover: rect('.cover-grid .cover-item .album-cover'),
    title: rect('.cover-grid .cover-item strong'), artist: rect('.cover-grid .cover-item > span[title]'),
    playlist: rect('.home-playlists'), empty: rect('.home-playlists .empty-state'),
    panelTrigger: rect('.open-now-panel'), playlistAll: rect('.home-playlists .section-heading > button'),
    player: rect('.player-bar'), home: rect('.home-page'), main: rect('.main-content'),
  }
})()`

function assertLayout(data, target) {
  const fail = (message) => { throw new Error(`${target.width}x${target.height}: ${message}\n${JSON.stringify(data, null, 2)}`) }
  for (const key of ['card', 'cover', 'title', 'artist', 'playlist', 'empty', 'panelTrigger', 'playlistAll', 'player', 'home', 'main'])
    if (!data[key]) fail(`missing ${key}`)
  if (Object.values(data.scroll).some(([client, scroll]) => scroll > client)) fail('vertical overflow')
  if (data.playlist.width < 280) fail('playlist column is too narrow')
  if (data.card.width < target.cardMin || data.card.width > target.cardMax) fail('recent card width is out of range')
  if (data.cover.width > target.cardMax) fail('cover is too wide')
  if (data.title.bottom >= data.player.top || data.artist.bottom >= data.player.top) fail('track metadata overlaps PlayerBar')
  const overlaps = (left, right) => left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top
  if (overlaps(data.panelTrigger, data.playlistAll)) fail('Now Playing panel trigger overlaps the playlist action')
}

let app
const pages = []
try {
  await mkdir(userData, { recursive: true })
  await mkdir(musicFolder, { recursive: true })
  await mkdir(screenshotDir, { recursive: true })
  const audioPath = path.join(musicFolder, 'layout-test.wav')
  const nextAudioPath = path.join(musicFolder, 'layout-test-next.wav')
  await writeFile(audioPath, testWav())
  await writeFile(nextAudioPath, testWav())
  await writeFile(path.join(userData, 'pulse-shelf-data.json'), JSON.stringify(fixture(audioPath, nextAudioPath)), 'utf8')
  app = start()
  let main = await connectTarget((url) => url.includes('index.html') && !url.includes('taskbarMode=1') && !url.includes('taskbarToggle=1') && !url.includes('mini=1'), 'main renderer')
  pages.push(main)
  await waitFor(() => main.evaluate(`Boolean(document.querySelector('.cover-grid .cover-item-wrap'))`), 'HomePage')

  if (!taskbarTest) {
    const results = []
    for (const target of [
      { width: 1280, height: 720, cardMin: 140, cardMax: 160 },
      { width: 1600, height: 900, cardMin: 160, cardMax: 180 },
    ]) {
      await main.send('Emulation.setDeviceMetricsOverride', { width: target.width, height: target.height, deviceScaleFactor: 1, mobile: false })
      await delay(180)
      const measurement = await main.evaluate(measure)
      assertLayout(measurement, target)
      const capture = await main.send('Page.captureScreenshot', { format: 'png' })
      const screenshot = path.join(screenshotDir, `home-dev-${target.width}x${target.height}.png`)
      await writeFile(screenshot, Buffer.from(capture.data, 'base64'))
      results.push({ target, screenshot })
    }
    process.stdout.write(`PULSE_SHELF_UI_TEST_OK\n${JSON.stringify(results, null, 2)}\n`)
  } else {
    let mode = await connectTarget((url) => url.includes('taskbarMode=1'), 'taskbar mode renderer')
    pages.push(mode)
    await waitFor(() => mode.evaluate(`Boolean(document.querySelector('.taskbar-mode'))`), 'taskbar mode UI')
    const initial = await mode.evaluate(`(async () => ({
      width: innerWidth, height: innerHeight, x: screenX, y: screenY,
      screenWidth: screen.width, screenHeight: screen.height,
      title: document.querySelector('.taskbar-mode__track strong')?.textContent,
      controls: document.querySelectorAll('.taskbar-mode__controls button').length,
      tools: document.querySelectorAll('.taskbar-mode__tools button').length,
      progress: Boolean(document.querySelector('.taskbar-mode__progress input')),
      opacity: getComputedStyle(document.querySelector('.taskbar-mode')).opacity,
      state: await window.electronAPI.getTaskbarModeState()
    }))()`)
    if (initial.width !== initial.screenWidth || initial.y + initial.height !== initial.screenHeight || initial.title !== 'Layout Test Track' || initial.controls !== 5 || initial.tools !== 4 || !initial.progress || initial.opacity !== '1' || !initial.state.pulseTaskbarVisible || !initial.state.modeWindowVisible || initial.state.toggleWindowVisible || initial.state.registeredShortcutCount > 1)
      throw new Error(`Invalid taskbar mode: ${JSON.stringify(initial)}`)
    const initialLyrics = await mode.evaluate(`(() => {
      const root = document.querySelector('.taskbar-mode__lyrics')
      return {
        current: root?.querySelector('strong')?.textContent,
        next: root?.querySelector('span')?.textContent,
        source: root?.getAttribute('data-taskbar-lyrics-source'),
        title: root?.getAttribute('title'),
        width: root?.getBoundingClientRect().width,
        textOverflow: root ? getComputedStyle(root.querySelector('strong')).textOverflow : '',
        currentFontSize: root ? getComputedStyle(root.querySelector('strong')).fontSize : '',
        nextFontSize: root ? getComputedStyle(root.querySelector('span')).fontSize : '',
        nextOpacity: root ? getComputedStyle(root.querySelector('span')).opacity : '',
      }
    })()`)
    if (
      !initialLyrics.current?.startsWith('今度こそ生き返れない') ||
      initialLyrics.next !== 'そう思ったベッドの中' ||
      initialLyrics.source !== 'synced' ||
      initialLyrics.width > 500 ||
      initialLyrics.textOverflow !== 'ellipsis' ||
      initialLyrics.currentFontSize !== '16px' ||
      initialLyrics.nextFontSize !== '13px' ||
      initialLyrics.nextOpacity !== '0.65'
    )
      throw new Error(`Initial taskbar lyrics are invalid: ${JSON.stringify(initialLyrics)}`)
    await mode.evaluate(`window.electronAPI.sendPlayerCommand({ type: 'seek', value: 0.6 })`)
    await waitFor(
      () =>
        mode.evaluate(
          `document.querySelector('.taskbar-mode__lyrics strong')?.textContent === 'そう思ったベッドの中'`,
        ),
      'taskbar synced lyrics seek update',
    )
    await mode.evaluate(`window.electronAPI.sendPlayerCommand({ type: 'next' })`)
    await waitFor(
      () =>
        mode.evaluate(
          `document.querySelector('.taskbar-mode__track strong')?.textContent === 'Next Layout Track' && document.querySelector('.taskbar-mode__lyrics')?.getAttribute('data-taskbar-lyrics-source') === 'generated'`,
        ),
      'taskbar generated timeline lyrics',
    )
    await mode.evaluate(`window.electronAPI.saveLyricsSelection('${'b'.repeat(64)}', {
      id: -901,
      trackName: 'Next Layout Track',
      artistName: 'Pulse Shelf Test',
      plainLyrics: 'Plain line one\\nPlain line two',
      instrumental: false,
      source: 'manual-input',
      sourceLabel: 'Manual input'
    })`)
    await mode.evaluate(`window.electronAPI.sendPlayerCommand({ type: 'seek', value: 0.2 })`)
    await waitFor(
      () => mode.evaluate(`!document.querySelector('.taskbar-mode__lyrics')`),
      'taskbar plain lyrics hidden',
    )
    process.stdout.write('PULSE_SHELF_TASKBAR_WINDOW_OK\n')
    process.stdout.write(
      initial.state.registeredShortcutCount === 1
        ? 'PULSE_SHELF_TASKBAR_SHORTCUT_OK\n'
        : 'PULSE_SHELF_TASKBAR_SHORTCUT_OCCUPIED\n',
    )

    await click(mode, '.taskbar-mode__windows')
    let toggle = await connectTarget((url) => url.includes('taskbarToggle=1'), 'taskbar toggle renderer')
    pages.push(toggle)
    await waitFor(() => toggle.evaluate(`(async () => {
      const state = await window.electronAPI.getTaskbarModeState()
      const rect = document.querySelector('.taskbar-toggle')?.getBoundingClientRect()
      return rect?.width === 36 && rect?.height === 36 && state.toggleWindowVisible && !state.modeWindowVisible && !state.pulseTaskbarVisible
    })()`), 'Windows taskbar state')
    process.stdout.write('PULSE_SHELF_TASKBAR_SWITCH_OK\n')
    const nativeGeometry = await toggle.evaluate(`({
      y: screenY + document.querySelector('.taskbar-toggle').getBoundingClientRect().top,
      height: document.querySelector('.taskbar-toggle')?.getBoundingClientRect().height,
      scale: devicePixelRatio,
      screenWidth: screen.width,
      screenHeight: screen.height
    })`)
    const verifyToggle = async (label) =>
      waitFor(() => toggle.evaluate(`(async () => {
        const state = await window.electronAPI.getTaskbarModeState()
        const rect = document.querySelector('.taskbar-toggle')?.getBoundingClientRect()
        return state.toggleWindowVisible && !state.pulseTaskbarVisible &&
          rect?.width === 36 && rect?.height === 36
      })()`), label)
    await clickNativeDesktop(
      50 * nativeGeometry.scale,
      (nativeGeometry.y + nativeGeometry.height / 2) * nativeGeometry.scale,
      100,
    )
    await delay(1_700)
    await verifyToggle('100 blank taskbar clicks')
    process.stdout.write('PULSE_SHELF_TASKBAR_NATIVE_CLICK_OK\n')
    const physicalWidth = nativeGeometry.screenWidth * nativeGeometry.scale
    const physicalHeight = nativeGeometry.screenHeight * nativeGeometry.scale
    const physicalTaskbarY =
      (nativeGeometry.screenHeight - 20) * nativeGeometry.scale
    await clickNativeDesktop(physicalWidth * 0.66, physicalTaskbarY)
    await delay(1_700)
    await verifyToggle('taskbar app icon click')
    await clickNativeDesktop(physicalWidth * 0.79, physicalTaskbarY)
    await delay(1_700)
    await verifyToggle('taskbar tray click')
    await clickNativeDesktop(physicalWidth * 0.965, physicalTaskbarY)
    await delay(1_700)
    await verifyToggle('taskbar clock click')
    await main.evaluate(`window.electronAPI.minimizeMainWindow()`)
    await delay(250)
    await clickNativeDesktop(physicalWidth * 0.9, physicalHeight * 0.2)
    await delay(1_700)
    await verifyToggle('desktop click')
    process.stdout.write('PULSE_SHELF_TASKBAR_VISIBLE_AFTER_CLICKS_OK\n')
    await click(toggle, '.taskbar-toggle button')
    await waitFor(async () => {
      const state = await toggle.evaluate(
        `window.electronAPI.getTaskbarModeState()`,
      )
      return state.pulseTaskbarVisible &&
        state.modeWindowVisible &&
        !state.toggleWindowVisible
        ? state
        : undefined
    }, 'plus button state transition')
    process.stdout.write('PULSE_SHELF_TASKBAR_PLUS_OK\n')
    const finalExit = once(app, 'exit')
    await main.evaluate(`setTimeout(() => void window.electronAPI.quitApp(), 0); true`)
    await finalExit
    app = undefined
    process.stdout.write('PULSE_SHELF_TASKBAR_TEST_OK\n')
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`)
  process.exitCode = 1
} finally {
  for (const page of pages) page.close()
  await stop(app)
  await rm(harnessRoot, { recursive: true, force: true }).catch(() => undefined)
}
