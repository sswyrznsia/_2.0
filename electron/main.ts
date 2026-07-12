import { createReadStream, existsSync } from 'node:fs'
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
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  screen,
  session,
  shell,
  Tray,
  WebContentsView,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type Rectangle,
} from 'electron'
import ElectronStore from 'electron-store'
import log from 'electron-log/main'
import { z } from 'zod'
import { destroyDiscordPresence, updateDiscordPresence } from './discord'
import {
  getPublicData,
  getStoredData,
  initializeStore,
  resetData,
  setPublicData,
  settingsSchema,
  type StoredTrack,
} from './data'
import { exportAppData, importAppData } from './ipc/dataTransfer'
import {
  cancelActiveScan,
  chooseAndScanFolder,
  getLibraryExclusions,
  getTrackRemovalDetails,
  removeFolder,
  removeTrackFromLibrary,
  rescanFolders,
  restoreLibraryExclusion,
  trashTrackFile,
} from './ipc/library'
import {
  autoFetchImportedTrackLyrics,
  clearLyricsCache,
  loadTrackLyrics,
  markTrackInstrumental,
  removeTrackLyrics,
  reloadTrackLyrics,
  getLyricsSyncProfile,
  saveLyricsSyncProfile,
  clearLyricsSyncProfile,
  getGeneratedLyricsTimelineState,
  saveGeneratedLyricsTimeline,
  clearGeneratedLyricsTimeline,
  saveLyricsSelection,
  searchTrackLyrics,
} from './ipc/lyrics'
import { registerMediaImportIpc } from './ipc/mediaImport'
import { registerAutoSyncIpc } from './ipc/autoSync'
import { MediaImportService } from './import/mediaImportService'
import { AutoSyncService } from './autoSync/autoSyncService'
import { IPC } from '../src/types/ipc'
import type {
  MediaImportJob,
  PlayerCommand,
  PlayerSnapshot,
  ScanProgress,
  Settings,
  TaskbarModeAction,
  TaskbarModeState,
  TaskbarToggleSettingsPatch,
} from '../src/types/models'
import { extractYouTubeVideoId, isYouTubeVideoUrl } from '../src/utils/youtube'
import { YouTubeExtensionManager, YOUTUBE_PARTITION } from './youtubeExtension'
import {
  computeTaskbarToggleBounds,
  computeTaskbarHorizontalRange,
  computeTaskbarRect,
  type TaskbarEdge,
} from './taskbarGeometry'

if (
  process.env.PULSE_SHELF_UI_TEST === '1' ||
  process.env.PULSE_SHELF_SELF_TEST === '1'
) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('no-sandbox')
  process.stdout.on('error', () => undefined)
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pulse-media',
    privileges: {
      secure: true,
      standard: true,
      stream: true,
      supportFetchAPI: true,
    },
  },
  {
    scheme: 'pulse-cover',
    privileges: { secure: true, standard: true, supportFetchAPI: true },
  },
])

interface WindowState {
  main?: Rectangle
  mini?: Rectangle
}

interface TaskbarStoredState {
  pulseTaskbarVisible: boolean
}

const trackIdSchema = z.string().regex(/^[a-f0-9]{64}$/)

const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('toggle') }),
  z.object({ type: z.literal('next') }),
  z.object({ type: z.literal('previous') }),
  z.object({ type: z.literal('toggle-shuffle') }),
  z.object({ type: z.literal('cycle-repeat') }),
  z.object({ type: z.literal('toggle-mute') }),
  z.object({
    type: z.literal('set-volume'),
    value: z.number().finite().min(0).max(1),
  }),
  z.object({
    type: z.literal('seek'),
    value: z.number().finite().nonnegative(),
  }),
])
const taskbarModeActionSchema = z.enum(['show-pulse', 'show-windows', 'toggle'])
const taskbarToggleScreenXSchema = z
  .number()
  .finite()
  .min(-100_000)
  .max(100_000)
const snapshotSchema = z.object({
  currentTrack: z
    .object({
      id: trackIdSchema,
      title: z.string(),
      artist: z.string(),
      album: z.string(),
    })
    .passthrough()
    .nullable(),
  queue: z.array(z.object({ id: trackIdSchema }).passthrough()).max(100_000),
  currentIndex: z.number().int(),
  isPlaying: z.boolean(),
  currentTime: z.number().finite().nonnegative(),
  duration: z.number().finite().nonnegative(),
  volume: z.number().min(0).max(1),
  isMuted: z.boolean(),
  shuffle: z.boolean(),
  repeatMode: z.enum(['off', 'one', 'all']),
})
const viewBoundsSchema = z.object({
  x: z.number().int().min(0).max(20_000),
  y: z.number().int().min(0).max(20_000),
  width: z.number().int().min(1).max(20_000),
  height: z.number().int().min(1).max(20_000),
})

let mainWindow: BrowserWindow | null = null
let miniWindow: BrowserWindow | null = null
let taskbarModeWindow: BrowserWindow | null = null
let taskbarToggleWindow: BrowserWindow | null = null
let tray: Tray | null = null
let youtubeView: WebContentsView | null = null
let youtubeViewAttached = false
let youtubeViewError: string | null = null
let windowStateStore: ElectronStore<WindowState>
let taskbarStateStore: ElectronStore<TaskbarStoredState>
let isQuitting = false
let lastPresenceUpdate = 0
let lastPresenceKey = ''
let lastSnapshot: PlayerSnapshot | null = null
let lastTrayKey = ''
let mediaIndex = new Map<string, StoredTrack>()
let boundsSaveTimer: NodeJS.Timeout | undefined
let mediaImportService: MediaImportService | null = null
let autoSyncService: AutoSyncService | null = null
let youtubeExtensionManager: YouTubeExtensionManager | null = null
let youtubeViewBounds: Rectangle | null = null
let taskbarToggleDrag:
  { startScreenX: number; startWindowX: number; displayId: number } | undefined
let pulseTaskbarVisible = false
let taskbarRepositionListener: (() => void) | undefined
let taskbarBrowserWindowBlurListener: (() => void) | undefined
const taskbarToggleRetopTimers = new Set<NodeJS.Timeout>()
let taskbarToggleRecoveryTimer: NodeJS.Timeout | undefined
let taskbarToggleVisualBounds: Rectangle | null = null
let taskbarLastEnabled = false
let taskbarRegisteredShortcutCount = 0
let taskbarShortcutEnabled: boolean | undefined
let autoSyncShutdownComplete = false
let autoSyncShutdownPromise: Promise<void> | null = null
let quitCleanupComplete = false
const taskbarEdges = new Map<number, TaskbarEdge>()

const preloadPath = path.join(import.meta.dirname, 'preload.mjs')
const YOUTUBE_HOME = 'https://www.youtube.com/'
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'music.youtube.com',
  'm.youtube.com',
  'youtu.be',
])
const YOUTUBE_INTERNAL_HOSTS = new Set([
  ...YOUTUBE_HOSTS,
  'google.com',
  'www.google.com',
  'accounts.google.com',
  'consent.google.com',
  'gstatic.com',
  'www.gstatic.com',
  'googleusercontent.com',
  'accounts.youtube.com',
])
const assetPath = (name: string) =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'assets', name)
    : path.join(app.getAppPath(), 'assets', name)

function refreshMediaIndex() {
  mediaIndex = new Map(getStoredData().tracks.map((track) => [track.id, track]))
}

async function readAutoSyncSidecar(
  filePath: string,
  extension: '.lrc' | '.txt',
) {
  const sidecarPath = `${filePath.slice(0, -path.extname(filePath).length)}${extension}`
  try {
    const fileStats = await stat(sidecarPath)
    if (!fileStats.isFile() || fileStats.size > 2 * 1024 * 1024)
      return undefined
    const content = (await readFile(sidecarPath, 'utf8'))
      .replace(/^\uFEFF/, '')
      .trim()
    return content || undefined
  } catch {
    return undefined
  }
}

async function resolveAutoSyncTrack(trackId: string) {
  const data = getStoredData()
  const track = data.tracks.find((item) => item.id === trackId)
  if (!track) return null
  const selected = data.lyrics[trackId]
  const syncedLyrics =
    selected?.syncedLyrics ??
    (selected ? undefined : await readAutoSyncSidecar(track.filePath, '.lrc'))
  const plainLyrics =
    selected?.plainLyrics ??
    (selected ? undefined : await readAutoSyncSidecar(track.filePath, '.txt'))
  return {
    trackId,
    audioPath: track.filePath,
    fileSize: track.fileSize,
    modifiedAt: track.modifiedAt,
    duration: track.duration,
    plainLyrics,
    syncedLyrics,
    provider: selected?.provider ?? selected?.source,
    providerSource: selected?.providerSource,
  }
}

function assertMainSender(event: IpcMainInvokeEvent | IpcMainEvent) {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id)
    throw new Error('허용되지 않은 요청입니다.')
}

function assertTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent) {
  const ids = [
    mainWindow?.webContents.id,
    miniWindow?.webContents.id,
    taskbarModeWindow?.webContents.id,
    taskbarToggleWindow?.webContents.id,
  ].filter(Boolean)
  if (!ids.includes(event.sender.id))
    throw new Error('허용되지 않은 요청입니다.')
}

function secureWindow(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('render-process-gone', (_event, details) =>
    log.error('Renderer process terminated', details),
  )
  window.webContents.on('did-fail-load', (_event, code, description) =>
    log.error('Renderer failed to load', { code, description }),
  )
}

function hasAllowedHost(value: string, hosts: Set<string>): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && hosts.has(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

const isAllowedYouTubeUrl = (value: string) =>
  hasAllowedHost(value, YOUTUBE_HOSTS)
const isAllowedYouTubeInternalUrl = (value: string) =>
  hasAllowedHost(value, YOUTUBE_INTERNAL_HOSTS)

function normalizeYouTubeUrl(value: string): string {
  const candidate = /^https?:\/\//i.test(value.trim())
    ? value.trim()
    : `https://${value.trim()}`
  if (!isAllowedYouTubeUrl(candidate))
    throw new Error('YouTube 주소만 열 수 있습니다.')
  return new URL(candidate).toString()
}

function getYouTubeState() {
  const contents = youtubeView?.webContents
  const url = contents?.getURL() || YOUTUBE_HOME
  const videoId = extractYouTubeVideoId(url)
  const availability = mediaImportService?.getAvailability()
  const existingTrack = videoId
    ? getStoredData().tracks.find((track) => track.sourceVideoId === videoId)
    : undefined
  return {
    url,
    title: contents?.getTitle() || 'YouTube',
    canGoBack: contents?.navigationHistory.canGoBack() ?? false,
    canGoForward: contents?.navigationHistory.canGoForward() ?? false,
    isLoading: contents?.isLoading() ?? false,
    isVideoUrl: isYouTubeVideoUrl(url),
    videoId,
    importAvailable: availability?.available ?? false,
    importUnavailableReason:
      availability?.reason ?? ('service-not-installed' as const),
    existingTrackId: existingTrack?.id ?? null,
    error: youtubeViewError,
  }
}

function sendYouTubeState() {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send(IPC.youtubeState, getYouTubeState())
}

function attachYouTubeView() {
  if (!mainWindow || !youtubeView || youtubeViewAttached) return
  mainWindow.contentView.addChildView(youtubeView)
  youtubeViewAttached = true
  if (youtubeViewBounds) youtubeView.setBounds(youtubeViewBounds)
}

function detachYouTubeView() {
  if (!mainWindow || !youtubeView || !youtubeViewAttached) return
  mainWindow.contentView.removeChildView(youtubeView)
  youtubeViewAttached = false
}

function createYouTubeView() {
  if (youtubeView) {
    attachYouTubeView()
    return youtubeView
  }
  youtubeView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      partition: YOUTUBE_PARTITION,
    },
  })
  youtubeView.setBackgroundColor('#0B1020')
  const contents = youtubeView.webContents
  contents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  )
  contents.session.setPermissionCheckHandler(() => false)
  contents.session.on('will-download', (event) => event.preventDefault())
  contents.session.webRequest.onBeforeRequest(
    { urls: ['pulse-media://*/*', 'pulse-cover://*/*'] },
    (_details, callback) => callback({ cancel: true }),
  )
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedYouTubeInternalUrl(url)) void contents.loadURL(url)
    else {
      youtubeViewError = '허용되지 않은 팝업을 차단했습니다.'
      sendYouTubeState()
    }
    return { action: 'deny' }
  })
  const restrictNavigation = (event: Electron.Event, url: string) => {
    if (isAllowedYouTubeInternalUrl(url)) return
    event.preventDefault()
    youtubeViewError =
      'YouTube 및 로그인에 필요한 주소 외의 이동을 차단했습니다.'
    sendYouTubeState()
  }
  contents.on('will-navigate', restrictNavigation)
  contents.on('will-redirect', restrictNavigation)
  contents.on('did-start-loading', () => {
    youtubeViewError = null
    sendYouTubeState()
  })
  contents.on('did-stop-loading', sendYouTubeState)
  contents.on('did-navigate', sendYouTubeState)
  contents.on('did-navigate-in-page', sendYouTubeState)
  contents.on('did-redirect-navigation', sendYouTubeState)
  contents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      youtubeViewError = `페이지를 불러오지 못했습니다: ${errorDescription}`
      sendYouTubeState()
    },
  )
  contents.on('page-title-updated', sendYouTubeState)
  contents.on('render-process-gone', (_event, details) =>
    log.error('YouTube renderer process terminated', details),
  )
  attachYouTubeView()
  void contents.loadURL(YOUTUBE_HOME).catch((error) => {
    const description = error instanceof Error ? error.message : String(error)
    if (description.includes('ERR_ABORTED')) return
    if (youtubeViewAttached && !isQuitting) {
      youtubeViewError =
        'YouTube를 불러오지 못했습니다. 네트워크 연결을 확인하세요.'
      sendYouTubeState()
      log.warn('YouTube page failed to load', error)
    }
  })
  return youtubeView
}

function reloadYouTubeViewForExtension() {
  if (!youtubeView || youtubeView.webContents.isDestroyed()) return
  youtubeViewError = null
  youtubeView.webContents.reload()
  sendYouTubeState()
}

async function loadRenderer(
  window: BrowserWindow,
  mode: 'main' | 'mini' | 'taskbarMode' | 'taskbarToggle' = 'main',
) {
  const query = mode === 'main' ? '' : `?${mode}=1`
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (
    !app.isPackaged &&
    devUrl &&
    (devUrl.startsWith('http://localhost:') ||
      devUrl.startsWith('http://127.0.0.1:'))
  ) {
    await window.loadURL(`${devUrl}${query}`)
  } else {
    await window.loadFile(
      path.join(import.meta.dirname, '../dist/index.html'),
      mode === 'main' ? undefined : { query: { [mode]: '1' } },
    )
  }
}

function clampBounds(
  bounds: Rectangle | undefined,
  fallback: Rectangle,
): Rectangle {
  if (!bounds) return fallback
  const display = screen.getDisplayMatching(bounds)
  const area = display.workArea
  const width = Math.min(Math.max(bounds.width, fallback.width), area.width)
  const height = Math.min(Math.max(bounds.height, fallback.height), area.height)
  return {
    width,
    height,
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
  }
}

function saveBounds(kind: keyof WindowState, window: BrowserWindow) {
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer)
  boundsSaveTimer = setTimeout(() => {
    if (!window.isDestroyed())
      windowStateStore.set(kind, window.getNormalBounds())
  }, 250)
}

function createMainWindow() {
  if (mainWindow) return mainWindow
  const bounds = clampBounds(windowStateStore.get('main'), {
    x: 100,
    y: 80,
    width: 1600,
    height: 900,
  })
  mainWindow = new BrowserWindow({
    ...bounds,
    title: 'Pulse Shelf 2.0',
    minWidth: 1280,
    minHeight: 720,
    icon: assetPath('icon.png'),
    backgroundColor: '#0B1020',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const window = mainWindow
  secureWindow(window)
  window.once('ready-to-show', () => window.show())
  window.on('resize', () => saveBounds('main', window))
  window.on('move', () => {
    saveBounds('main', window)
    repositionTaskbarWindows()
  })
  window.on('close', (event) => {
    if (!isQuitting && getStoredData().settings.closeBehavior === 'tray') {
      event.preventDefault()
      window.hide()
    } else if (!isQuitting) {
      isQuitting = true
      app.quit()
    }
  })
  window.on('closed', () => {
    youtubeView?.webContents.close()
    youtubeView = null
    youtubeViewAttached = false
    mainWindow = null
  })
  void loadRenderer(window).catch((error) => {
    if (!isQuitting && !window.isDestroyed())
      log.error('Main window load failed', error)
  })
  return window
}

async function createMiniWindow() {
  if (miniWindow) {
    miniWindow.show()
    miniWindow.focus()
    return
  }
  const bounds = clampBounds(windowStateStore.get('mini'), {
    x: 120,
    y: 120,
    width: 440,
    height: 190,
  })
  miniWindow = new BrowserWindow({
    ...bounds,
    title: 'Pulse Shelf Mini',
    minWidth: 380,
    minHeight: 170,
    resizable: true,
    alwaysOnTop: getStoredData().settings.miniAlwaysOnTop,
    icon: assetPath('icon.png'),
    backgroundColor: '#0B1020',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const window = miniWindow
  secureWindow(window)
  window.once('ready-to-show', () => window.show())
  window.on('resize', () => saveBounds('mini', window))
  window.on('move', () => saveBounds('mini', window))
  window.on('closed', () => {
    miniWindow = null
  })
  await loadRenderer(window, 'mini')
  if (lastSnapshot) window.webContents.send(IPC.playerSnapshot, lastSnapshot)
}

const TASKBAR_TOGGLE_SIZE = { width: 36, height: 36 }
const TASKBAR_SHORTCUT = 'CommandOrControl+Alt+P'

function currentTaskbarDisplay() {
  if (taskbarModeWindow && !taskbarModeWindow.isDestroyed())
    return screen.getDisplayMatching(taskbarModeWindow.getBounds())
  if (taskbarToggleWindow && !taskbarToggleWindow.isDestroyed())
    return screen.getDisplayMatching(taskbarToggleWindow.getBounds())
  if (mainWindow && !mainWindow.isDestroyed())
    return screen.getDisplayMatching(mainWindow.getBounds())
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
}

function taskbarModeBounds(display = currentTaskbarDisplay()) {
  const result = computeTaskbarRect(
    display,
    taskbarEdges.get(display.id) ?? 'bottom',
  )
  taskbarEdges.set(display.id, result.edge)
  return result
}

function taskbarTogglePlacement(display = currentTaskbarDisplay()) {
  const settings = getStoredData().settings
  const result = computeTaskbarToggleBounds(
    display,
    TASKBAR_TOGGLE_SIZE,
    settings.taskbarTogglePosition,
    taskbarEdges.get(display.id) ?? 'bottom',
    settings.taskbarToggleTrayReservedWidth,
    settings.taskbarToggleCustomRightGap,
  )
  taskbarEdges.set(display.id, result.edge)
  return result
}

function setWindowBounds(window: BrowserWindow, bounds: Rectangle) {
  const current = window.getBounds()
  if (
    current.x !== bounds.x ||
    current.y !== bounds.y ||
    current.width !== bounds.width ||
    current.height !== bounds.height
  )
    window.setBounds(bounds, false)
}

function repositionTaskbarWindows() {
  const display = currentTaskbarDisplay()
  if (taskbarModeWindow && !taskbarModeWindow.isDestroyed())
    setWindowBounds(taskbarModeWindow, taskbarModeBounds(display))
  if (
    taskbarToggleWindow &&
    !taskbarToggleWindow.isDestroyed() &&
    !taskbarToggleDrag
  ) {
    const placement = taskbarTogglePlacement(display)
    setWindowBounds(taskbarToggleWindow, placement)
    applyTaskbarToggleShape(taskbarToggleWindow, placement)
  }
}

function applyTaskbarToggleShape(
  window: BrowserWindow,
  placement = taskbarTogglePlacement(),
) {
  taskbarToggleVisualBounds = {
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
  }
  if (process.platform !== 'darwin')
    window.setShape([
      { x: 0, y: 0, width: placement.width, height: placement.height },
    ])
}

function clearTaskbarToggleRetopTimers() {
  for (const timer of taskbarToggleRetopTimers) clearTimeout(timer)
  taskbarToggleRetopTimers.clear()
}

function stopTaskbarToggleRecovery() {
  if (!taskbarToggleRecoveryTimer) return
  clearInterval(taskbarToggleRecoveryTimer)
  taskbarToggleRecoveryTimer = undefined
}

function taskbarToggleShouldBeVisible() {
  return getStoredData().settings.taskbarModeEnabled && !pulseTaskbarVisible
}

function hideTaskbarToggleWindow() {
  const window = taskbarToggleWindow
  clearTaskbarToggleRetopTimers()
  stopTaskbarToggleRecovery()
  if (!window || window.isDestroyed()) return
  window.hide()
}

function reinforceTaskbarToggleWindow() {
  const window = taskbarToggleWindow
  if (
    !window ||
    window.isDestroyed() ||
    !getStoredData().settings.taskbarModeEnabled ||
    pulseTaskbarVisible
  )
    return
  window.setAlwaysOnTop(true, 'screen-saver', 1)
  if (!window.isVisible()) window.showInactive()
  window.moveTop()
}

function startTaskbarToggleRecovery() {
  stopTaskbarToggleRecovery()
  reinforceTaskbarToggleWindow()
  taskbarToggleRecoveryTimer = setInterval(reinforceTaskbarToggleWindow, 1_500)
}

function showTaskbarToggleWindow() {
  const window = taskbarToggleWindow
  if (!window || window.isDestroyed()) return
  const placement = taskbarTogglePlacement(currentTaskbarDisplay())
  setWindowBounds(window, placement)
  applyTaskbarToggleShape(window, placement)
  window.setAlwaysOnTop(true, 'screen-saver', 1)
  window.showInactive()
  window.moveTop()
}

function scheduleTaskbarToggleRetop() {
  clearTaskbarToggleRetopTimers()
  for (const delayMs of [100, 300]) {
    const timer = setTimeout(() => {
      taskbarToggleRetopTimers.delete(timer)
      const window = taskbarToggleWindow
      if (
        window &&
        !window.isDestroyed() &&
        window.isVisible() &&
        taskbarToggleShouldBeVisible()
      )
        window.moveTop()
    }, delayMs)
    taskbarToggleRetopTimers.add(timer)
  }
}

function startTaskbarToggleDrag(screenX: number) {
  const window = taskbarToggleWindow
  if (!window || window.isDestroyed()) return
  const display = screen.getDisplayMatching(window.getBounds())
  taskbarToggleDrag = {
    startScreenX: screenX,
    startWindowX:
      taskbarToggleVisualBounds?.x ?? taskbarTogglePlacement(display).x,
    displayId: display.id,
  }
}

function updateTaskbarToggleDrag(screenX: number) {
  const window = taskbarToggleWindow
  const drag = taskbarToggleDrag
  if (!window || window.isDestroyed() || !drag) return
  const display =
    screen.getAllDisplays().find(({ id }) => id === drag.displayId) ??
    currentTaskbarDisplay()
  const settings = getStoredData().settings
  const placement = taskbarTogglePlacement(display)
  const range = computeTaskbarHorizontalRange(
    placement.taskbarRect,
    placement.width,
    settings.taskbarToggleTrayReservedWidth,
  )
  const x = Math.min(
    Math.max(
      Math.round(drag.startWindowX + screenX - drag.startScreenX),
      range.minX,
    ),
    range.maxX,
  )
  applyTaskbarToggleShape(window, { ...placement, x })
  return { placement, x }
}

function endTaskbarToggleDrag(screenX: number) {
  const result = updateTaskbarToggleDrag(screenX)
  taskbarToggleDrag = undefined
  if (!result) return taskbarModeState()
  const rightGap = Math.round(
    result.placement.taskbarRect.x +
      result.placement.taskbarRect.width -
      (result.x + result.placement.width),
  )
  const patch: TaskbarToggleSettingsPatch = {
    taskbarTogglePosition: 'custom',
    taskbarToggleCustomRightGap: rightGap,
  }
  const data = getPublicData()
  const saved = setPublicData({
    ...data,
    settings: { ...data.settings, ...patch },
  })
  applySettings(saved.settings)
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send(IPC.taskbarToggleSettingsChanged, patch)
  return taskbarModeState()
}

function taskbarModeState(): TaskbarModeState {
  const enabled = getStoredData().settings.taskbarModeEnabled
  return {
    enabled,
    pulseTaskbarVisible: enabled && pulseTaskbarVisible,
    modeWindowVisible: Boolean(taskbarModeWindow?.isVisible()),
    toggleWindowVisible: Boolean(taskbarToggleWindow?.isVisible()),
    registeredShortcutCount: taskbarRegisteredShortcutCount,
  }
}

function sendTaskbarModeState() {
  const state = taskbarModeState()
  for (const window of [
    mainWindow,
    miniWindow,
    taskbarModeWindow,
    taskbarToggleWindow,
  ]) {
    if (window && !window.isDestroyed())
      window.webContents.send(IPC.taskbarModeState, state)
  }
  updateTrayMenu()
}

function taskbarWindowOptions(bounds: Rectangle) {
  return {
    ...bounds,
    frame: false,
    thickFrame: false,
    hasShadow: false,
    roundedCorners: false,
    transparent: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#0B1020',
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  }
}

async function waitForTaskbarRenderer(window: BrowserWindow, selector: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (window.isDestroyed()) return false
    const mounted = await window.webContents.executeJavaScript(
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
    )
    if (mounted) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

async function createTaskbarModeWindow() {
  if (taskbarModeWindow && !taskbarModeWindow.isDestroyed())
    return taskbarModeWindow
  const settings = getStoredData().settings
  const window = new BrowserWindow({
    ...taskbarWindowOptions(taskbarModeBounds()),
    title: 'Pulse Shelf Taskbar Mode',
    opacity: settings.taskbarModeOpacity,
  })
  taskbarModeWindow = window
  secureWindow(window)
  setWindowBounds(window, taskbarModeBounds())
  window.setMenuBarVisibility(false)
  window.on('closed', () => {
    taskbarModeWindow = null
    if (!isQuitting && pulseTaskbarVisible) void setPulseTaskbarVisible(false)
  })
  try {
    await loadRenderer(window, 'taskbarMode')
    if (!(await waitForTaskbarRenderer(window, '.taskbar-mode')))
      throw new Error('Taskbar mode renderer did not mount')
    const validation = await window.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('.taskbar-mode')
      const style = root ? getComputedStyle(root) : null
      return {
        root: Boolean(root),
        title: Boolean(document.querySelector('.taskbar-mode__track strong')),
        play: Boolean(document.querySelector('.taskbar-mode__play')),
        minus: Boolean(document.querySelector('.taskbar-mode__windows')),
        bodyWidth: document.body.getBoundingClientRect().width,
        bodyHeight: document.body.getBoundingClientRect().height,
        opacity: style?.opacity,
        display: style?.display,
        visibility: style?.visibility,
      }
    })()`)
    if (
      !window.webContents.getURL() ||
      !validation.root ||
      !validation.title ||
      !validation.play ||
      !validation.minus ||
      validation.bodyWidth <= 0 ||
      validation.bodyHeight <= 0 ||
      validation.opacity !== '1' ||
      validation.display === 'none' ||
      validation.visibility === 'hidden'
    )
      throw new Error(
        `Taskbar mode renderer validation failed: ${JSON.stringify(validation)}`,
      )
    window.setAlwaysOnTop(true, 'screen-saver')
    setWindowBounds(window, taskbarModeBounds())
  } catch (error) {
    log.error(
      'Pulse Shelf taskbar mode failed; restoring Windows taskbar',
      error,
    )
    if (!window.isDestroyed()) window.destroy()
    throw error
  }
  if (lastSnapshot) window.webContents.send(IPC.playerSnapshot, lastSnapshot)
  window.webContents.send(IPC.taskbarModeState, taskbarModeState())
  return window
}

async function createTaskbarToggleWindow() {
  if (taskbarToggleWindow && !taskbarToggleWindow.isDestroyed())
    return taskbarToggleWindow
  const display = currentTaskbarDisplay()
  const placement = taskbarTogglePlacement(display)
  const window = new BrowserWindow({
    ...taskbarWindowOptions(placement),
    title: 'Pulse Shelf Taskbar Toggle',
    backgroundColor: '#0B1020',
    focusable: false,
  })
  taskbarToggleWindow = window
  secureWindow(window)
  applyTaskbarToggleShape(window, placement)
  window.setMenuBarVisibility(false)
  window.on('closed', () => {
    clearTaskbarToggleRetopTimers()
    stopTaskbarToggleRecovery()
    taskbarToggleWindow = null
  })
  await loadRenderer(window, 'taskbarToggle')
  const valid = await waitForTaskbarRenderer(window, '.taskbar-toggle')
  if (!valid) throw new Error('Taskbar toggle renderer did not mount')
  applyTaskbarToggleShape(window, placement)
  window.webContents.send(IPC.taskbarModeState, taskbarModeState())
  return window
}

async function setPulseTaskbarVisible(visible: boolean) {
  const enabled = getStoredData().settings.taskbarModeEnabled
  pulseTaskbarVisible = enabled && visible
  taskbarStateStore.set('pulseTaskbarVisible', pulseTaskbarVisible)
  try {
    if (pulseTaskbarVisible) {
      const modeWindow = await createTaskbarModeWindow()
      repositionTaskbarWindows()
      hideTaskbarToggleWindow()
      modeWindow.showInactive()
      modeWindow.moveTop()
    } else if (enabled) {
      await createTaskbarToggleWindow()
      repositionTaskbarWindows()
      taskbarModeWindow?.hide()
      showTaskbarToggleWindow()
      startTaskbarToggleRecovery()
    } else {
      taskbarModeWindow?.hide()
      hideTaskbarToggleWindow()
    }
  } catch {
    pulseTaskbarVisible = false
    taskbarModeWindow?.hide()
    if (enabled) {
      try {
        await createTaskbarToggleWindow()
        repositionTaskbarWindows()
        showTaskbarToggleWindow()
        startTaskbarToggleRecovery()
      } catch (toggleError) {
        log.error('Taskbar toggle fallback also failed', toggleError)
      }
    }
  }
  taskbarStateStore.set('pulseTaskbarVisible', pulseTaskbarVisible)
  sendTaskbarModeState()
  return taskbarModeState()
}

function performTaskbarModeAction(action: TaskbarModeAction) {
  if (action === 'show-pulse') return setPulseTaskbarVisible(true)
  if (action === 'show-windows') return setPulseTaskbarVisible(false)
  return setPulseTaskbarVisible(!pulseTaskbarVisible)
}

function registerTaskbarShortcut(settings: Settings) {
  const shouldRegister =
    settings.taskbarModeEnabled && settings.taskbarModeShortcuts
  if (taskbarShortcutEnabled === shouldRegister) return
  taskbarShortcutEnabled = shouldRegister
  globalShortcut.unregister(TASKBAR_SHORTCUT)
  taskbarRegisteredShortcutCount = 0
  if (!shouldRegister) return
  if (
    globalShortcut.register(
      TASKBAR_SHORTCUT,
      () => void performTaskbarModeAction('toggle'),
    )
  )
    taskbarRegisteredShortcutCount = 1
  else log.warn(`Could not register taskbar mode shortcut: ${TASKBAR_SHORTCUT}`)
}

function applyTaskbarModeSettings(settings: Settings, initial = false) {
  if (!taskbarStateStore) return
  const becameEnabled = settings.taskbarModeEnabled && !taskbarLastEnabled
  taskbarLastEnabled = settings.taskbarModeEnabled
  registerTaskbarShortcut(settings)
  taskbarModeWindow?.setOpacity(settings.taskbarModeOpacity)
  if (!settings.taskbarModeEnabled) {
    pulseTaskbarVisible = false
    taskbarModeWindow?.hide()
    hideTaskbarToggleWindow()
    taskbarStateStore.set('pulseTaskbarVisible', false)
    sendTaskbarModeState()
    return
  }
  repositionTaskbarWindows()
  if (initial || becameEnabled) {
    const savedState = taskbarStateStore.has('pulseTaskbarVisible')
      ? taskbarStateStore.get('pulseTaskbarVisible')
      : settings.taskbarModeShowOnStartup
    const shouldShowPulse =
      initial && settings.taskbarModeRestoreLastState
        ? savedState
        : settings.taskbarModeShowOnStartup
    void setPulseTaskbarVisible(shouldShowPulse)
  } else sendTaskbarModeState()
}

function initializeTaskbarMode(settings: Settings) {
  taskbarLastEnabled = settings.taskbarModeEnabled
  registerTaskbarShortcut(settings)
  taskbarRepositionListener = () => {
    repositionTaskbarWindows()
  }
  screen.on('display-added', taskbarRepositionListener)
  screen.on('display-removed', taskbarRepositionListener)
  screen.on('display-metrics-changed', taskbarRepositionListener)
  taskbarBrowserWindowBlurListener = () => scheduleTaskbarToggleRetop()
  app.on('browser-window-blur', taskbarBrowserWindowBlurListener)
  applyTaskbarModeSettings(settings, true)
}

function sendPlayerCommand(command: PlayerCommand) {
  const window = mainWindow ?? createMainWindow()
  window.webContents.send(IPC.playerCommand, command)
}

function updateTrayMenu() {
  if (!tray) return
  const taskbarState = taskbarModeState()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Pulse Shelf 열기', click: () => showMainWindow() },
      { type: 'separator' },
      {
        label: lastSnapshot?.isPlaying ? '일시정지' : '재생',
        enabled: Boolean(lastSnapshot?.currentTrack),
        click: () => sendPlayerCommand({ type: 'toggle' }),
      },
      {
        label: '이전 곡',
        enabled: Boolean(lastSnapshot?.currentTrack),
        click: () => sendPlayerCommand({ type: 'previous' }),
      },
      {
        label: '다음 곡',
        enabled: Boolean(lastSnapshot?.currentTrack),
        click: () => sendPlayerCommand({ type: 'next' }),
      },
      { type: 'separator' },
      { label: '미니 플레이어', click: () => void createMiniWindow() },
      { type: 'separator' },
      {
        label: 'Pulse Shelf 작업표시줄 표시',
        enabled: taskbarState.enabled && !taskbarState.pulseTaskbarVisible,
        click: () => void performTaskbarModeAction('show-pulse'),
      },
      {
        label: 'Windows 작업표시줄로 전환',
        enabled: taskbarState.enabled && taskbarState.pulseTaskbarVisible,
        click: () => void performTaskbarModeAction('show-windows'),
      },
      { type: 'separator' },
      {
        label: '종료',
        click: () => {
          isQuitting = true
          app.quit()
        },
      },
    ]),
  )
}
function createTray() {
  const image = nativeImage
    .createFromPath(assetPath('icon.png'))
    .resize({ width: 20, height: 20 })
  tray = new Tray(image)
  tray.setToolTip('Pulse Shelf 2.0')
  tray.on('double-click', showMainWindow)
  updateTrayMenu()
}

function showMainWindow() {
  const window = mainWindow ?? createMainWindow()
  window.show()
  window.focus()
}

async function fileResponse(
  request: Request,
  track: StoredTrack,
): Promise<Response> {
  if (!existsSync(track.filePath))
    return new Response('Track not found', { status: 404 })
  const fileStats = await stat(track.filePath)
  const mime = {
    mp3: 'audio/mpeg',
    flac: 'audio/flac',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
  }[track.format]
  const range = request.headers.get('range')
  let start = 0
  let end = Math.max(0, fileStats.size - 1)
  let status = 200
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (!match)
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${fileStats.size}` },
      })
    if (match[1]) start = Number(match[1])
    if (match[2]) end = Number(match[2])
    if (!match[1] && match[2]) {
      const suffixLength = Number(match[2])
      start = Math.max(0, fileStats.size - suffixLength)
      end = fileStats.size - 1
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start > end ||
      start >= fileStats.size
    ) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${fileStats.size}` },
      })
    }
    end = Math.min(end, fileStats.size - 1)
    status = 206
  }
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Content-Length': String(end - start + 1),
    'Content-Type': mime,
  })
  if (status === 206)
    headers.set('Content-Range', `bytes ${start}-${end}/${fileStats.size}`)
  if (request.method === 'HEAD') return new Response(null, { status, headers })
  const stream = Readable.toWeb(
    createReadStream(track.filePath, { start, end }),
  )
  return new Response(stream as ReadableStream, { status, headers })
}

function registerProtocols() {
  protocol.handle('pulse-media', (request) => {
    const url = new URL(request.url)
    const id = url.pathname.slice(1)
    const track =
      url.hostname === 'track' && trackIdSchema.safeParse(id).success
        ? mediaIndex.get(id)
        : undefined
    return track
      ? fileResponse(request, track)
      : new Response('Track not found', { status: 404 })
  })
  protocol.handle('pulse-cover', async (request) => {
    const url = new URL(request.url)
    const id = url.pathname.slice(1)
    if (
      url.hostname !== 'track' ||
      !trackIdSchema.safeParse(id).success ||
      !mediaIndex.has(id)
    )
      return new Response('Cover not found', { status: 404 })
    const coversPath = path.join(app.getPath('userData'), 'covers')
    const coverPath = ['png', 'jpg']
      .map((ext) => path.join(coversPath, `${id}.${ext}`))
      .find(existsSync)
    if (!coverPath) return new Response('Cover not found', { status: 404 })
    const response = await net.fetch(pathToFileURL(coverPath).toString())
    const headers = new Headers(response.headers)
    headers.set(
      'Content-Type',
      coverPath.endsWith('.png') ? 'image/png' : 'image/jpeg',
    )
    return new Response(response.body, { status: response.status, headers })
  })
}

function progressSender(event: IpcMainInvokeEvent) {
  return (progress: ScanProgress) => {
    if (!event.sender.isDestroyed())
      event.sender.send(IPC.scanProgress, progress)
  }
}

function applySettings(settings: Settings) {
  app.setLoginItemSettings({ openAtLogin: settings.autoLaunch })
  miniWindow?.setAlwaysOnTop(settings.miniAlwaysOnTop)
  applyTaskbarModeSettings(settings)
}

function registerIpc() {
  ipcMain.handle(IPC.loadData, (event) => {
    assertTrustedSender(event)
    return getPublicData()
  })
  ipcMain.handle(IPC.saveData, async (event, value: unknown) => {
    assertMainSender(event)
    const saved = setPublicData(value)
    applySettings(saved.settings)
    refreshMediaIndex()
    return saved
  })
  ipcMain.handle(IPC.resetData, async (event) => {
    assertMainSender(event)
    await autoSyncService?.cancelActiveAndDrain()
    await mediaImportService?.cancelAllAndDrain()
    const data = resetData()
    applySettings(data.settings)
    mediaIndex.clear()
    await rm(path.join(app.getPath('userData'), 'covers'), {
      recursive: true,
      force: true,
    })
    await mediaImportService?.initialize()
    return data
  })
  ipcMain.handle(IPC.exportData, (event) => {
    assertMainSender(event)
    return exportAppData()
  })
  ipcMain.handle(IPC.importData, async (event) => {
    assertMainSender(event)
    await autoSyncService?.cancelActiveAndDrain()
    await mediaImportService?.cancelAllAndDrain()
    const result = await importAppData()
    if (result.data) {
      applySettings(result.data.settings)
      await mediaImportService?.initialize()
      refreshMediaIndex()
    }
    return result
  })
  ipcMain.handle(IPC.chooseMusicFolder, async (event) => {
    assertMainSender(event)
    const result = await chooseAndScanFolder(progressSender(event))
    if (result.errors.length)
      log.warn('Library scan completed with errors', result.errors)
    refreshMediaIndex()
    return result
  })
  ipcMain.handle(IPC.rescanMusicFolders, async (event) => {
    assertMainSender(event)
    const result = await rescanFolders(progressSender(event))
    if (result.errors.length)
      log.warn('Library rescan completed with errors', result.errors)
    refreshMediaIndex()
    return result
  })
  ipcMain.handle(IPC.removeMusicFolder, async (event, folder: unknown) => {
    assertMainSender(event)
    if (typeof folder !== 'string' || folder.length > 32_767)
      throw new Error('올바르지 않은 폴더입니다.')
    const result = await removeFolder(folder, progressSender(event))
    if (result.errors.length)
      log.warn(
        'Library folder removal rescan completed with errors',
        result.errors,
      )
    refreshMediaIndex()
    return result
  })
  ipcMain.handle(IPC.removeTrack, async (event, trackId: unknown) => {
    assertMainSender(event)
    const result = await removeTrackFromLibrary(trackIdSchema.parse(trackId))
    refreshMediaIndex()
    return result
  })
  ipcMain.handle(IPC.trashTrack, async (event, trackId: unknown) => {
    assertMainSender(event)
    const result = await trashTrackFile(trackIdSchema.parse(trackId))
    refreshMediaIndex()
    return result
  })
  ipcMain.handle(IPC.getLibraryExclusions, (event) => {
    assertMainSender(event)
    return getLibraryExclusions()
  })
  ipcMain.handle(IPC.getTrackRemovalDetails, (event, trackId: unknown) => {
    assertMainSender(event)
    return getTrackRemovalDetails(trackIdSchema.parse(trackId))
  })
  ipcMain.handle(
    IPC.restoreLibraryExclusion,
    async (event, exclusionId: unknown) => {
      assertMainSender(event)
      const id = z.string().uuid().parse(exclusionId)
      const data = await restoreLibraryExclusion(id)
      refreshMediaIndex()
      return data
    },
  )
  ipcMain.on(IPC.cancelScan, (event) => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return
    cancelActiveScan()
  })
  ipcMain.handle(IPC.loadLyrics, (event, trackId: unknown) => {
    assertTrustedSender(event)
    const id = trackIdSchema.parse(trackId)
    return loadTrackLyrics(id)
  })
  const lyricsCandidateSchema = z.object({
    id: z.number().int(),
    trackName: z.string().max(500),
    artistName: z.string().max(500),
    albumName: z.string().max(500).optional(),
    duration: z.number().nonnegative().optional(),
    syncedLyrics: z.string().max(2_000_000).optional(),
    plainLyrics: z.string().max(2_000_000).optional(),
    instrumental: z.boolean(),
    provider: z.enum(['lrclib', 'lyrica']).optional(),
    providerSource: z.string().trim().min(1).max(60).optional(),
    sourceLabel: z.string().trim().min(1).max(100).optional(),
  })
  const lyricsSearchQuerySchema = z.object({
    title: z.string().trim().max(500).optional(),
    artist: z.string().trim().max(500).optional(),
  })
  ipcMain.handle(
    IPC.lyricsSearch,
    (event, trackId: unknown, query: unknown) => {
      assertTrustedSender(event)
      return searchTrackLyrics(
        trackIdSchema.parse(trackId),
        query === undefined ? undefined : lyricsSearchQuerySchema.parse(query),
      )
    },
  )
  ipcMain.handle(
    IPC.lyricsSaveSelection,
    (event, trackId: unknown, candidate: unknown) => {
      assertTrustedSender(event)
      return saveLyricsSelection(
        trackIdSchema.parse(trackId),
        lyricsCandidateSchema.parse(candidate),
      )
    },
  )
  ipcMain.handle(IPC.lyricsRemove, (event, trackId: unknown) => {
    assertTrustedSender(event)
    removeTrackLyrics(trackIdSchema.parse(trackId))
  })
  ipcMain.handle(IPC.lyricsMarkInstrumental, (event, trackId: unknown) => {
    assertTrustedSender(event)
    markTrackInstrumental(trackIdSchema.parse(trackId))
  })
  ipcMain.handle(IPC.lyricsClearCache, (event) => {
    assertTrustedSender(event)
    clearLyricsCache()
  })
  ipcMain.handle(IPC.lyricsReload, (event, trackId: unknown) => {
    assertTrustedSender(event)
    return reloadTrackLyrics(trackIdSchema.parse(trackId))
  })
  const lyricsSyncProfileSchema = z.object({
    trackId: trackIdSchema,
    offsetMs: z.number().finite(),
    anchors: z
      .array(
        z.object({
          lyricTimeMs: z.number().finite().nonnegative(),
          audioTimeMs: z.number().finite().nonnegative(),
        }),
      )
      .max(100),
    updatedAt: z.number().finite().nonnegative(),
    source: z.enum(['manual', 'ai']).optional(),
    autoSyncMetadata: z
      .object({
        model: z.string().trim().min(1).max(200),
        matchedLines: z.number().int().nonnegative(),
        totalLines: z.number().int().positive(),
        confidence: z.number().finite().min(0).max(1),
        processingTimeMs: z.number().finite().nonnegative(),
      })
      .optional(),
  })
  ipcMain.handle(IPC.lyricsSyncGet, (event, trackId: unknown) => {
    assertTrustedSender(event)
    return getLyricsSyncProfile(trackIdSchema.parse(trackId))
  })
  ipcMain.handle(IPC.lyricsSyncSave, async (event, profile: unknown) => {
    assertTrustedSender(event)
    const parsed = lyricsSyncProfileSchema.parse(profile)
    if (
      parsed.source === 'ai' &&
      autoSyncService?.getJob(parsed.trackId)?.status === 'completed'
    )
      await autoSyncService.assertResultCurrent(parsed.trackId)
    return saveLyricsSyncProfile(parsed)
  })
  ipcMain.handle(IPC.lyricsSyncClear, (event, trackId: unknown) => {
    assertTrustedSender(event)
    clearLyricsSyncProfile(trackIdSchema.parse(trackId))
  })
  const generatedLyricsTimelineSchema = z.object({
    trackId: trackIdSchema,
    source: z.enum(['ai', 'manual']),
    lines: z
      .array(
        z.object({
          lineIndex: z.number().int().nonnegative(),
          textHash: z.string().regex(/^[a-f0-9]{16}$/),
          audioTimeMs: z.number().int().nonnegative(),
          confidence: z.number().finite().min(0).max(1).optional(),
          source: z
            .enum([
              'direct',
              'segment_recovered',
              'interpolated',
              'local_retry',
              'unmatched',
              'manual',
            ])
            .optional(),
        }),
      )
      .max(20_000),
    lineCount: z.number().int().positive().max(20_000),
    lyricsTextHash: z.string().regex(/^[a-f0-9]{16}$/),
    model: z.string().trim().min(1).max(500).optional(),
    createdAt: z.number().finite().nonnegative(),
  })
  ipcMain.handle(IPC.generatedLyricsTimelineGet, (event, trackId: unknown) => {
    assertTrustedSender(event)
    return getGeneratedLyricsTimelineState(trackIdSchema.parse(trackId))
  })
  ipcMain.handle(
    IPC.generatedLyricsTimelineSave,
    async (event, timeline: unknown) => {
      assertTrustedSender(event)
      const parsed = generatedLyricsTimelineSchema.parse(timeline)
      if (
        parsed.source === 'ai' &&
        autoSyncService?.getJob(parsed.trackId)?.status === 'completed'
      )
        await autoSyncService.assertResultCurrent(parsed.trackId)
      return saveGeneratedLyricsTimeline(parsed)
    },
  )
  ipcMain.handle(
    IPC.generatedLyricsTimelineClear,
    (event, trackId: unknown) => {
      assertTrustedSender(event)
      clearGeneratedLyricsTimeline(trackIdSchema.parse(trackId))
    },
  )
  ipcMain.handle(IPC.revealTrack, (event, trackId: unknown) => {
    assertMainSender(event)
    const id = trackIdSchema.parse(trackId)
    const track = mediaIndex.get(id)
    if (!track || !existsSync(track.filePath)) return false
    shell.showItemInFolder(track.filePath)
    return true
  })
  ipcMain.handle(IPC.openMiniPlayer, (event) => {
    assertTrustedSender(event)
    return createMiniWindow()
  })
  ipcMain.handle(IPC.showMainWindow, (event) => {
    assertTrustedSender(event)
    showMainWindow()
  })
  ipcMain.handle(IPC.openMainQueue, (event) => {
    assertTrustedSender(event)
    showMainWindow()
    mainWindow?.webContents.send(IPC.openMainQueue)
  })
  ipcMain.handle(IPC.minimizeMainWindow, (event) => {
    assertTrustedSender(event)
    mainWindow?.minimize()
  })
  ipcMain.handle(IPC.hideMainWindow, (event) => {
    assertTrustedSender(event)
    mainWindow?.hide()
  })
  ipcMain.handle(IPC.setMainWindowFullScreen, (event, value: unknown) => {
    assertTrustedSender(event)
    const fullscreen = z.boolean().parse(value)
    mainWindow?.setFullScreen(fullscreen)
  })
  ipcMain.handle(IPC.quitApp, (event) => {
    assertTrustedSender(event)
    isQuitting = true
    app.quit()
  })
  ipcMain.handle(IPC.closeMiniPlayer, (event) => {
    assertTrustedSender(event)
    miniWindow?.close()
  })
  ipcMain.handle(IPC.taskbarModeGetState, (event) => {
    assertTrustedSender(event)
    return taskbarModeState()
  })
  ipcMain.handle(IPC.taskbarModeAction, async (event, value: unknown) => {
    assertTrustedSender(event)
    return performTaskbarModeAction(taskbarModeActionSchema.parse(value))
  })
  ipcMain.handle(IPC.taskbarToggleDragStart, (event, value: unknown) => {
    assertTrustedSender(event)
    startTaskbarToggleDrag(taskbarToggleScreenXSchema.parse(value))
  })
  ipcMain.on(IPC.taskbarToggleDragMove, (event, value: unknown) => {
    assertTrustedSender(event)
    updateTaskbarToggleDrag(taskbarToggleScreenXSchema.parse(value))
  })
  ipcMain.handle(IPC.taskbarToggleDragEnd, (event, value: unknown) => {
    assertTrustedSender(event)
    return endTaskbarToggleDrag(taskbarToggleScreenXSchema.parse(value))
  })
  ipcMain.handle(IPC.taskbarCaptureDesktop, async (event) => {
    assertTrustedSender(event)
    if (
      !process.env.PULSE_SHELF_TEST_USER_DATA ||
      process.env.PULSE_SHELF_CAPTURE_DESKTOP !== '1'
    )
      return null
    const display = currentTaskbarDisplay()
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.bounds.width * display.scaleFactor),
        height: Math.round(display.bounds.height * display.scaleFactor),
      },
    })
    const source =
      sources.find(({ display_id }) => display_id === String(display.id)) ??
      sources[0]
    if (!source || source.thumbnail.isEmpty()) return null
    return source.thumbnail.toDataURL()
  })
  ipcMain.handle(IPC.youtubeOpen, (event) => {
    assertMainSender(event)
    createYouTubeView()
    const state = getYouTubeState()
    sendYouTubeState()
    return state
  })
  ipcMain.handle(IPC.youtubeClose, (event) => {
    assertMainSender(event)
    detachYouTubeView()
  })
  ipcMain.on(IPC.youtubeBounds, (event, value: unknown) => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return
    const result = viewBoundsSchema.safeParse(value)
    if (result.success) {
      youtubeViewBounds = result.data
      if (youtubeView && youtubeViewAttached) youtubeView.setBounds(result.data)
    }
  })
  ipcMain.handle(IPC.youtubeNavigate, (event, value: unknown) => {
    assertMainSender(event)
    if (typeof value !== 'string' || value.length > 2048)
      throw new Error('올바르지 않은 주소입니다.')
    const url = normalizeYouTubeUrl(value)
    const view = createYouTubeView()
    void view.webContents.loadURL(url)
    return getYouTubeState()
  })
  ipcMain.handle(IPC.youtubeBack, (event) => {
    assertMainSender(event)
    const history = createYouTubeView().webContents.navigationHistory
    if (history.canGoBack()) history.goBack()
    return getYouTubeState()
  })
  ipcMain.handle(IPC.youtubeForward, (event) => {
    assertMainSender(event)
    const history = createYouTubeView().webContents.navigationHistory
    if (history.canGoForward()) history.goForward()
    return getYouTubeState()
  })
  ipcMain.handle(IPC.youtubeReload, (event) => {
    assertMainSender(event)
    youtubeViewError = null
    createYouTubeView().webContents.reload()
    return getYouTubeState()
  })
  ipcMain.handle(IPC.youtubeHome, (event) => {
    assertMainSender(event)
    youtubeViewError = null
    void createYouTubeView().webContents.loadURL(YOUTUBE_HOME)
    return getYouTubeState()
  })
  ipcMain.handle(IPC.youtubeGetCurrentUrl, (event) => {
    assertMainSender(event)
    return youtubeView?.webContents.getURL() || YOUTUBE_HOME
  })
  ipcMain.handle(IPC.youtubeOpenExternal, async (event) => {
    assertMainSender(event)
    const url = youtubeView?.webContents.getURL() || YOUTUBE_HOME
    if (!isAllowedYouTubeInternalUrl(url)) return false
    await shell.openExternal(url)
    return true
  })
  ipcMain.handle(IPC.youtubeClearData, async (event) => {
    assertMainSender(event)
    if (!youtubeView) return
    const youtubeSession = youtubeView.webContents.session
    detachYouTubeView()
    youtubeView.webContents.close()
    youtubeView = null
    youtubeViewError = null
    await youtubeSession.clearStorageData()
    await youtubeSession.clearCache()
  })
  ipcMain.handle(IPC.youtubeExtensionGetStatus, (event) => {
    assertMainSender(event)
    return (
      youtubeExtensionManager?.getStatus() ?? {
        enabled: false,
        loadState: 'not-configured' as const,
      }
    )
  })
  ipcMain.handle(IPC.youtubeExtensionSelectFolder, async (event) => {
    assertMainSender(event)
    if (!mainWindow || !youtubeExtensionManager)
      throw new Error('확장 프로그램 관리자를 초기화하지 못했습니다.')
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '압축 해제된 Chrome 확장 프로그램 폴더 선택',
      properties: ['openDirectory'],
    })
    if (result.canceled || !result.filePaths[0])
      return youtubeExtensionManager.getStatus()
    return youtubeExtensionManager.select(result.filePaths[0])
  })
  ipcMain.handle(IPC.youtubeExtensionLoad, async (event) => {
    assertMainSender(event)
    if (!youtubeExtensionManager)
      throw new Error('확장 프로그램 관리자를 초기화하지 못했습니다.')
    return youtubeExtensionManager.load()
  })
  ipcMain.handle(IPC.youtubeExtensionReload, async (event) => {
    assertMainSender(event)
    if (!youtubeExtensionManager)
      throw new Error('확장 프로그램 관리자를 초기화하지 못했습니다.')
    return youtubeExtensionManager.reload()
  })
  ipcMain.handle(IPC.youtubeExtensionDisable, async (event) => {
    assertMainSender(event)
    if (!youtubeExtensionManager)
      throw new Error('확장 프로그램 관리자를 초기화하지 못했습니다.')
    return youtubeExtensionManager.disable()
  })
  ipcMain.handle(IPC.youtubeExtensionRemove, async (event) => {
    assertMainSender(event)
    if (!youtubeExtensionManager)
      throw new Error('확장 프로그램 관리자를 초기화하지 못했습니다.')
    return youtubeExtensionManager.remove()
  })
  ipcMain.handle(IPC.youtubeExtensionOpenFolder, async (event) => {
    assertMainSender(event)
    const extensionPath = youtubeExtensionManager?.getStatus().extensionPath
    if (!extensionPath || !existsSync(extensionPath)) return false
    shell.showItemInFolder(extensionPath)
    return true
  })
  ipcMain.on(IPC.playerCommand, (event, value: unknown) => {
    const trustedIds = [
      mainWindow?.webContents.id,
      miniWindow?.webContents.id,
      taskbarModeWindow?.webContents.id,
    ].filter(Boolean)
    if (!trustedIds.includes(event.sender.id)) return
    const result = commandSchema.safeParse(value)
    if (result.success) sendPlayerCommand(result.data)
  })
  ipcMain.on(
    IPC.playerSnapshot,
    (event, value: unknown, rawSettings: unknown) => {
      if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return
      const snapshotResult = snapshotSchema.safeParse(value)
      const settingsResult = settingsSchema.safeParse(rawSettings)
      if (!snapshotResult.success || !settingsResult.success) return
      const snapshot = value as PlayerSnapshot
      lastSnapshot = snapshot
      miniWindow?.webContents.send(IPC.playerSnapshot, snapshot)
      taskbarModeWindow?.webContents.send(IPC.playerSnapshot, snapshot)
      const trayKey = `${snapshot.currentTrack?.id}:${snapshot.isPlaying}`
      if (trayKey !== lastTrayKey) {
        lastTrayKey = trayKey
        updateTrayMenu()
      }
      const key = `${snapshot.currentTrack?.id}:${snapshot.isPlaying}:${settingsResult.data.discordPresence}`
      const now = Date.now()
      if (key !== lastPresenceKey || now - lastPresenceUpdate > 15_000) {
        lastPresenceKey = key
        lastPresenceUpdate = now
        void updateDiscordPresence(snapshot, settingsResult.data)
      }
    },
  )
  ipcMain.on(
    IPC.logRendererError,
    (event, message: unknown, stack: unknown) => {
      const trustedIds = [
        mainWindow?.webContents.id,
        miniWindow?.webContents.id,
        taskbarModeWindow?.webContents.id,
        taskbarToggleWindow?.webContents.id,
      ].filter(Boolean)
      if (!trustedIds.includes(event.sender.id)) return
      if (typeof message === 'string')
        log.error(
          'Renderer error:',
          message.slice(0, 2000),
          typeof stack === 'string' ? stack.slice(0, 8000) : '',
        )
    },
  )
  if (!mediaImportService)
    throw new Error('Media import service is not initialized')
  registerMediaImportIpc({
    service: mediaImportService,
    assertMainSender,
    currentYouTubeUrl: () => youtubeView?.webContents.getURL() || YOUTUBE_HOME,
  })
  if (!autoSyncService)
    throw new Error('Automatic lyrics sync service is not initialized')
  registerAutoSyncIpc({ service: autoSyncService, assertMainSender })
}

async function waitForRenderer(selector: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await mainWindow?.webContents.executeJavaScript(
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
    )
    if (ready) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Renderer did not display ${selector}`)
}

async function runRestartPersistenceTest() {
  initializeStore()
  const expectedVideoId = process.env.PULSE_SHELF_RESTART_VIDEO_ID
  if (!expectedVideoId) throw new Error('Restart test video ID is missing')
  const track = getStoredData().tracks.find(
    (item) => item.sourceVideoId === expectedVideoId,
  )
  if (!track || !existsSync(track.filePath))
    throw new Error('Restart test could not find the imported track or file')
  const service = new MediaImportService(
    () => undefined,
    () => undefined,
  )
  const availability = await service.initialize()
  if (!availability.available)
    throw new Error(
      `Restart media import service unavailable: ${availability.reason}`,
    )
  refreshMediaIndex()
  registerProtocols()
  const response = await net.fetch(`pulse-media://track/${track.id}`, {
    headers: { Range: 'bytes=0-255' },
  })
  if (response.status !== 206)
    throw new Error(`Restart protocol check failed: ${response.status}`)
  const testWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  await testWindow.loadURL('about:blank')
  const playbackResult = await testWindow.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const audio = new Audio(${JSON.stringify(`pulse-media://track/${track.id}`)});
      audio.volume = 0;
      audio.onplaying = () => resolve('playing');
      audio.onerror = () => resolve('error');
      audio.play().catch(() => resolve('error'));
      setTimeout(() => resolve('timeout'), 8000);
    })
  `)
  testWindow.destroy()
  if (playbackResult !== 'playing')
    throw new Error(`Restart playback failed: ${playbackResult}`)
  await writeFile(
    path.join(app.getPath('userData'), 'restart-test-report.json'),
    JSON.stringify(
      {
        status: 'passed',
        packaged: app.isPackaged,
        importAvailable: availability.available,
        ytDlpVersion: availability.version,
        trackId: track.id,
        sourceVideoId: track.sourceVideoId,
        filePath: track.filePath,
        playback: playbackResult,
      },
      null,
      2,
    ),
    'utf8',
  )
}

async function runUiSelfTest() {
  const expectedVideoId = 'bm5DkN4PmHk'
  const validVideoUrls = [
    `https://www.youtube.com/watch?v=${expectedVideoId}`,
    `https://music.youtube.com/watch?v=${expectedVideoId}`,
    `https://youtu.be/${expectedVideoId}`,
    `https://www.youtube.com/shorts/${expectedVideoId}`,
  ]
  const invalidVideoUrls = [
    'https://www.youtube.com/',
    'https://www.youtube.com/results?search_query=test',
    `https://youtube.com.evil.example/watch?v=${expectedVideoId}`,
    'https://www.youtube.com/watch?v=invalid',
  ]
  if (
    validVideoUrls.some(
      (url) =>
        extractYouTubeVideoId(url) !== expectedVideoId ||
        !isYouTubeVideoUrl(url),
    ) ||
    invalidVideoUrls.some(
      (url) => extractYouTubeVideoId(url) !== null || isYouTubeVideoUrl(url),
    )
  ) {
    throw new Error('YouTube video URL parser regression check failed')
  }
  const window = mainWindow
  if (!window) throw new Error('Main window was not created')
  await waitForRenderer('.app-shell')
  const pageCheck = await window.webContents.executeJavaScript(`
    (async () => {
      const buttons = [...document.querySelectorAll('.sidebar nav button')];
      for (const button of buttons) {
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (document.querySelector('.fatal-error')) return { ok: false, label: button.textContent };
      }
      buttons[0]?.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { ok: true, count: buttons.length };
    })()
  `)
  if (!pageCheck.ok || pageCheck.count !== 7)
    throw new Error(
      `Sidebar page regression check failed: ${JSON.stringify(pageCheck)}`,
    )
  await window.webContents.executeJavaScript(`
    document.querySelectorAll('.sidebar nav button')[2]?.click()
  `)
  await waitForRenderer('.youtube-page')
  await new Promise((resolve) => setTimeout(resolve, 250))
  const youtubeBounds = youtubeView?.getBounds()
  if (
    !youtubeView ||
    !youtubeViewAttached ||
    !youtubeBounds ||
    youtubeBounds.width < 300 ||
    youtubeBounds.height < 200
  ) {
    throw new Error(
      `YouTube WebContentsView bounds check failed: ${JSON.stringify(youtubeBounds)}`,
    )
  }
  const liveUiUrl = process.env.PULSE_SHELF_UI_LIVE_TEST_URL
  if (liveUiUrl) {
    const expectedVideoId = extractYouTubeVideoId(liveUiUrl)
    if (!expectedVideoId)
      throw new Error('Live UI test URL is not a supported YouTube video URL')
    await youtubeView.webContents.loadURL(liveUiUrl).catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes('ERR_ABORTED'))
        throw error
    })
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (extractYouTubeVideoId(youtubeView.webContents.getURL())) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    sendYouTubeState()
    await new Promise((resolve) => setTimeout(resolve, 150))
    const importState = getYouTubeState()
    const importButton = await window.webContents.executeJavaScript(`({
      disabled: document.querySelector('.youtube-import')?.disabled,
      title: document.querySelector('.youtube-import')?.title
    })`)
    if (
      importState.videoId !== expectedVideoId ||
      !importState.importAvailable ||
      importButton.disabled
    )
      throw new Error(
        `Live UI import button check failed: ${JSON.stringify({ importState, importButton })}`,
      )

    await window.webContents.executeJavaScript(
      `document.querySelector('.youtube-import')?.click()`,
    )
    await waitForRenderer('.media-import-confirmation')
    const confirmation = await window.webContents.executeJavaScript(`({
      text: document.querySelector('.media-import-confirmation')?.textContent,
      modal: document.querySelector('.media-import-confirmation')?.getAttribute('aria-modal')
    })`)
    if (
      youtubeViewAttached ||
      confirmation.modal !== 'true' ||
      !confirmation.text?.includes('다운로드 허가') ||
      !confirmation.text?.includes(liveUiUrl)
    )
      throw new Error(
        `Live UI confirmation check failed: ${JSON.stringify(confirmation)}`,
      )
    await window.webContents.executeJavaScript(
      `document.querySelector('.media-import-confirmation .button--primary')?.click()`,
    )

    let sawProgress = false
    let completed = false
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      const state = await window.webContents.executeJavaScript(`({
        hasProgress: Boolean(document.querySelector('.media-import-progress progress')),
        hasCancel: document.querySelector('.media-import-progress .button')?.textContent?.includes('취소') ?? false,
        completed: Boolean(document.querySelector('.media-import-actions')),
        status: document.querySelector('.youtube-status')?.textContent
      })`)
      if (state.hasProgress && state.hasCancel) sawProgress = true
      if (state.completed) {
        completed = true
        break
      }
      if (state.status?.includes('가져오기 실패'))
        throw new Error(`Live UI import failed: ${state.status}`)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (!sawProgress || !completed || !youtubeViewAttached)
      throw new Error(
        `Live UI progress/completion check failed: ${JSON.stringify({ sawProgress, completed, youtubeViewAttached })}`,
      )

    await window.webContents.executeJavaScript(
      `document.querySelector('.media-import-actions .button--primary')?.click()`,
    )
    let playbackVerified = false
    for (let attempt = 0; attempt < 80; attempt += 1) {
      playbackVerified = await window.webContents.executeJavaScript(`
        document.querySelector('.player-controls .play-button')?.getAttribute('aria-label') === '일시정지' &&
        document.querySelector('.player-track strong')?.textContent?.includes('Big Buck Bunny')
      `)
      if (playbackVerified) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const duplicateState = await window.webContents.executeJavaScript(`({
      disabled: document.querySelector('.youtube-import')?.disabled,
      title: document.querySelector('.youtube-import')?.title
    })`)
    if (
      !playbackVerified ||
      !duplicateState.disabled ||
      !duplicateState.title?.includes('이미 라이브러리에 존재')
    )
      throw new Error(
        `Live UI playback/duplicate check failed: ${JSON.stringify({ playbackVerified, duplicateState })}`,
      )

    await window.webContents.executeJavaScript(
      `document.querySelector('.media-import-actions .button')?.click()`,
    )
    await waitForRenderer('.library-page')
    const libraryContainsTrack = await window.webContents.executeJavaScript(
      `document.querySelector('.library-page')?.textContent?.includes('Big Buck Bunny')`,
    )
    if (!libraryContainsTrack)
      throw new Error(
        'Live UI library navigation did not show the imported track',
      )
    process.stdout.write('PULSE_SHELF_UI_LIVE_TEST_OK\n')
  }
  await window.webContents.executeJavaScript(`
    document.querySelectorAll('.sidebar nav button')[0]?.click()
  `)
  await new Promise((resolve) => setTimeout(resolve, 100))
  if (youtubeViewAttached)
    throw new Error('YouTube WebContentsView remained visible after navigation')
  window.setContentSize(1280, 720)
  await new Promise((resolve) => setTimeout(resolve, 250))
  const compact = await window.webContents.executeJavaScript(`({
    width: innerWidth,
    bodyWidth: document.body.scrollWidth,
    sidebarWidth: document.querySelector('.sidebar')?.getBoundingClientRect().width,
    playerBottom: document.querySelector('.player-bar')?.getBoundingClientRect().bottom,
    homeSections: document.querySelectorAll('.home-page > .content-section').length
  })`)
  if (
    compact.width !== 1280 ||
    compact.bodyWidth > compact.width ||
    compact.sidebarWidth > 80 ||
    Math.abs(compact.playerBottom - 720) > 1 ||
    compact.homeSections !== 2
  ) {
    throw new Error(`1280x720 layout check failed: ${JSON.stringify(compact)}`)
  }
  window.setContentSize(1600, 900)
  await new Promise((resolve) => setTimeout(resolve, 250))
  const defaultLayout = await window.webContents.executeJavaScript(`({
    width: innerWidth,
    bodyWidth: document.body.scrollWidth,
    sidebarWidth: document.querySelector('.sidebar')?.getBoundingClientRect().width,
    playerBottom: document.querySelector('.player-bar')?.getBoundingClientRect().bottom
  })`)
  if (
    defaultLayout.width !== 1600 ||
    defaultLayout.bodyWidth > defaultLayout.width ||
    defaultLayout.sidebarWidth < 200 ||
    Math.abs(defaultLayout.playerBottom - 900) > 1
  ) {
    throw new Error(
      `1600x900 layout check failed: ${JSON.stringify(defaultLayout)}`,
    )
  }
  await createMiniWindow()
  const miniId = miniWindow?.id
  await createMiniWindow()
  if (!miniWindow || miniWindow.id !== miniId || !tray)
    throw new Error('Mini-player singleton or tray check failed')
  process.stdout.write('PULSE_SHELF_UI_TEST_OK\n')
}

const testUserData = process.env.PULSE_SHELF_TEST_USER_DATA
if (testUserData) {
  app.setPath('userData', testUserData)
  app.disableHardwareAcceleration()
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', showMainWindow)
  app.whenReady().then(async () => {
    if (process.env.PULSE_SHELF_YOUTUBE_EXTENSION_TEST === '1') {
      try {
        initializeStore()
        const extensionPath = app.isPackaged
          ? path.join(
              process.resourcesPath,
              'extensions',
              'pulse-youtube-extension',
            )
          : path.join(
              app.getAppPath(),
              'resources',
              'extensions',
              'pulse-youtube-extension',
            )
        const youtubeSession = session.fromPartition(YOUTUBE_PARTITION)
        const extension =
          await youtubeSession.extensions.loadExtension(extensionPath)
        if (
          !youtubeSession.extensions
            .getAllExtensions()
            .some((item) => item.id === extension.id)
        )
          throw new Error('YouTube session did not retain the loaded extension')
        const testWindow = new BrowserWindow({ show: false })
        const testView = new WebContentsView({
          webPreferences: {
            partition: YOUTUBE_PARTITION,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
          },
        })
        testWindow.contentView.addChildView(testView)
        if (testView.webContents.session !== youtubeSession)
          throw new Error('YouTube WebContentsView partition does not match')
        await youtubeSession.extensions.removeExtension(extension.id)
        testWindow.destroy()
        process.stdout.write('PULSE_SHELF_YOUTUBE_EXTENSION_TEST_OK\n')
      } finally {
        app.quit()
      }
      return
    }
    if (process.env.PULSE_SHELF_TASKBAR_GEOMETRY_TEST === '1') {
      try {
        const { runTaskbarDisplayTest } = await import('./taskbarTest')
        await runTaskbarDisplayTest()
      } finally {
        app.quit()
      }
      return
    }
    if (process.env.PULSE_SHELF_SELF_TEST === '1') {
      if (process.env.PULSE_SHELF_RESTART_VERIFY === '1') {
        try {
          await runRestartPersistenceTest()
        } finally {
          app.quit()
        }
        return
      }
      const { runSelfTest } = await import('./selfTest')
      const fixture = await runSelfTest()
      let liveImportTrackId: string | undefined
      let liveImportFilePath: string | undefined
      const liveImportUrl = process.env.PULSE_SHELF_IMPORT_LIVE_TEST_URL
      if (liveImportUrl) {
        const liveImportEvents: MediaImportJob[] = []
        const liveService = new MediaImportService(
          (_event, job) => liveImportEvents.push({ ...job }),
          () => undefined,
        )
        const availability = await liveService.initialize()
        if (!availability.available)
          throw new Error(
            `Live media import service unavailable: ${availability.reason}`,
          )
        const started = liveService.start({
          source: 'youtube',
          url: liveImportUrl,
        })
        for (let attempt = 0; attempt < 1_200; attempt += 1) {
          const job = liveService
            .getJobs()
            .find((item) => item.jobId === started.jobId)
          if (job?.status === 'completed') {
            liveImportTrackId = job.trackId
            break
          }
          if (job?.status === 'failed' || job?.status === 'cancelled')
            throw new Error(`Live media import failed: ${job.message}`)
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        if (!liveImportTrackId) throw new Error('Live media import timed out')
        const completedEvents = liveImportEvents.filter(
          (event) => event.jobId === started.jobId,
        )
        const requiredStatuses: MediaImportJob['status'][] = [
          'preparing',
          'downloading',
          'processing',
          'registering',
          'completed',
        ]
        if (
          requiredStatuses.some(
            (status) =>
              !completedEvents.some((event) => event.status === status),
          ) ||
          !completedEvents.some(
            (event) =>
              event.status === 'downloading' && event.progress !== null,
          )
        )
          throw new Error(
            'Live import did not emit the required progress states',
          )
        const liveTrack = getStoredData().tracks.find(
          (track) => track.id === liveImportTrackId,
        )
        if (!liveTrack || !existsSync(liveTrack.filePath))
          throw new Error('Live imported file or library entry is missing')
        liveImportFilePath = liveTrack.filePath
        initializeStore()
        if (
          !getStoredData().tracks.some(
            (track) =>
              track.id === liveImportTrackId &&
              track.sourceUrl === liveImportUrl &&
              existsSync(track.filePath),
          )
        )
          throw new Error('Live import did not survive store reinitialization')
        let duplicateRejected = false
        try {
          liveService.start({ source: 'youtube', url: liveImportUrl })
        } catch (error) {
          duplicateRejected =
            error instanceof Error &&
            'code' in error &&
            error.code === 'duplicate-content'
        }
        if (!duplicateRejected)
          throw new Error('Duplicate live import was not rejected')

        const cancellation = liveService.start({
          source: 'youtube',
          url: liveImportUrl,
          replaceExisting: true,
        })
        let cancellationCompleted = false
        for (let attempt = 0; attempt < 1_200; attempt += 1) {
          const job = liveService
            .getJobs()
            .find((item) => item.jobId === cancellation.jobId)
          if (job?.status === 'downloading')
            liveService.cancel(cancellation.jobId)
          if (job?.status === 'cancelled') {
            cancellationCompleted = true
            break
          }
          if (job?.status === 'completed' || job?.status === 'failed')
            throw new Error(`Live cancellation ended as ${job.status}`)
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        await liveService.cancelAllAndDrain()
        const importEntries = await readdir(path.dirname(liveImportFilePath))
        if (
          !cancellationCompleted ||
          importEntries.some((entry) => entry.startsWith('.pulse-import-')) ||
          !existsSync(liveImportFilePath) ||
          getStoredData().tracks.filter(
            (track) => track.sourceVideoId === liveTrack.sourceVideoId,
          ).length !== 1
        )
          throw new Error('Live cancellation cleanup or preservation failed')
        process.stdout.write('PULSE_SHELF_IMPORT_LIVE_TEST_OK\n')
        process.stdout.write('PULSE_SHELF_IMPORT_PROGRESS_OK\n')
        process.stdout.write('PULSE_SHELF_IMPORT_DUPLICATE_OK\n')
        process.stdout.write('PULSE_SHELF_IMPORT_CANCEL_OK\n')
        process.stdout.write(
          `PULSE_SHELF_IMPORT_FILE=${Buffer.from(liveImportFilePath).toString('base64')}\n`,
        )
      }
      process.stdout.write(
        `PULSE_SHELF_SELF_TEST_TEMP=${Buffer.from(fixture.root).toString('base64')}\n`,
      )
      try {
        refreshMediaIndex()
        registerProtocols()
        const response = await net.fetch(
          `pulse-media://track/${fixture.trackId}`,
          { headers: { Range: 'bytes=0-43' } },
        )
        if (
          response.status !== 206 ||
          response.headers.get('content-type') !== 'audio/wav'
        ) {
          throw new Error(
            `Custom protocol range test failed: ${response.status}`,
          )
        }
        if (liveImportTrackId) {
          const importedResponse = await net.fetch(
            `pulse-media://track/${liveImportTrackId}`,
            { headers: { Range: 'bytes=0-255' } },
          )
          if (
            importedResponse.status !== 206 ||
            importedResponse.headers.get('content-type') !== 'audio/mp4'
          )
            throw new Error(
              `Imported M4A protocol check failed: ${importedResponse.status}`,
            )
        }
        const testWindow = new BrowserWindow({
          show: false,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        })
        await testWindow.loadURL('about:blank')
        const playbackResult = await testWindow.webContents.executeJavaScript(`
          new Promise((resolve) => {
            const audio = new Audio(${JSON.stringify(`pulse-media://track/${fixture.trackId}`)});
            audio.volume = 0;
            audio.onended = () => resolve('ended');
            audio.onerror = () => resolve('error');
            audio.play().catch(() => resolve('error'));
            setTimeout(() => resolve('timeout'), 4000);
          })
        `)
        if (playbackResult !== 'ended')
          throw new Error(`Chromium WAV playback failed: ${playbackResult}`)
        if (liveImportTrackId) {
          const importedPlaybackResult = await testWindow.webContents
            .executeJavaScript(`
              new Promise((resolve) => {
                const audio = new Audio(${JSON.stringify(`pulse-media://track/${liveImportTrackId}`)});
                audio.volume = 0;
                audio.onplaying = () => resolve('playing');
                audio.onerror = () => resolve('error');
                audio.play().catch(() => resolve('error'));
                setTimeout(() => resolve('timeout'), 8000);
              })
            `)
          if (importedPlaybackResult !== 'playing')
            throw new Error(
              `Chromium imported audio playback failed: ${importedPlaybackResult}`,
            )
          process.stdout.write('PULSE_SHELF_IMPORT_PLAYBACK_OK\n')
        }
        await writeFile(
          path.join(fixture.root, 'self-test-report.json'),
          JSON.stringify(
            {
              status: 'passed',
              packaged: app.isPackaged,
              liveImport: Boolean(liveImportTrackId),
              sourceUrl: liveImportUrl,
              trackId: liveImportTrackId,
              filePath: liveImportFilePath,
              playback: liveImportTrackId ? 'playing' : undefined,
            },
            null,
            2,
          ),
          'utf8',
        )
        testWindow.destroy()
        process.stdout.write('PULSE_SHELF_SELF_TEST_OK\n')
      } finally {
        app.quit()
      }
      return
    }
    let uiTestRoot: string | undefined
    if (process.env.PULSE_SHELF_UI_TEST === '1') {
      uiTestRoot =
        process.env.PULSE_SHELF_UI_TEST_ROOT ??
        (await mkdtemp(path.join(os.tmpdir(), 'pulse-shelf-ui-test-')))
      const userData = testUserData ?? path.join(uiTestRoot, 'user-data')
      await mkdir(userData, { recursive: true })
      app.setPath('userData', userData)
      process.stdout.write(
        `PULSE_SHELF_UI_TEST_TEMP=${Buffer.from(uiTestRoot).toString('base64')}\n`,
      )
    }
    log.initialize()
    initializeStore()
    const autoSyncWorkspace = app.isPackaged
      ? process.resourcesPath
      : path.resolve(import.meta.dirname, '..')
    const allowAutoSyncTestWorker =
      process.env.PULSE_SHELF_UI_TEST === '1' || Boolean(testUserData)
    const testWorkerCommand = allowAutoSyncTestWorker
      ? process.env.PULSE_SHELF_AUTO_SYNC_TEST_COMMAND
      : undefined
    const testWorkerScript = allowAutoSyncTestWorker
      ? process.env.PULSE_SHELF_AUTO_SYNC_TEST_SCRIPT
      : undefined
    autoSyncService = new AutoSyncService({
      workspaceRoot: autoSyncWorkspace,
      workRoot: path.join(app.getPath('userData'), 'auto-sync'),
      resolveTrack: resolveAutoSyncTrack,
      emit: (event, job) => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        const channel =
          event === 'completed'
            ? IPC.lyricsAutoSyncCompleted
            : event === 'failed'
              ? IPC.lyricsAutoSyncFailed
              : IPC.lyricsAutoSyncProgress
        mainWindow.webContents.send(channel, job)
      },
      logger: {
        info: (message, details) => log.info(message, details ?? ''),
        warn: (message, details) => log.warn(message, details ?? ''),
        error: (message, details) => log.error(message, details ?? ''),
      },
      workerOverride:
        testWorkerCommand && testWorkerScript
          ? {
              command: testWorkerCommand,
              script: testWorkerScript,
              gpuName: 'Auto-sync UI test GPU',
            }
          : undefined,
      availabilityOverride:
        testUserData &&
        process.env.PULSE_SHELF_AUTO_SYNC_LIVE_TEST !== '1' &&
        !(testWorkerCommand && testWorkerScript)
          ? {
              available: false,
              device: null,
              missingRequirements: ['service'],
              reason: '이 테스트에서는 AI 자동 싱크 환경 확인을 생략합니다.',
              checkedAt: Date.now(),
            }
          : undefined,
    })
    youtubeExtensionManager = new YouTubeExtensionManager(
      () => session.fromPartition(YOUTUBE_PARTITION),
      reloadYouTubeViewForExtension,
    )
    await youtubeExtensionManager.restore()
    mediaImportService = new MediaImportService(
      (event, job) => {
        if (event === 'completed' && job.trackId)
          void autoFetchImportedTrackLyrics(job.trackId).catch(
            (error: unknown) =>
              log.warn('Automatic lyrics lookup failed', error),
          )
        if (!mainWindow || mainWindow.isDestroyed()) return
        const channel =
          event === 'completed'
            ? IPC.mediaImportCompleted
            : event === 'failed'
              ? IPC.mediaImportFailed
              : IPC.mediaImportProgress
        mainWindow.webContents.send(channel, job)
      },
      () => {
        refreshMediaIndex()
        sendYouTubeState()
      },
    )
    await mediaImportService.initialize()
    windowStateStore = new ElectronStore<WindowState>({ name: 'window-state' })
    taskbarStateStore = new ElectronStore<TaskbarStoredState>({
      name: 'taskbar-mode-state',
    })
    refreshMediaIndex()
    registerProtocols()
    registerIpc()
    Menu.setApplicationMenu(null)
    session.defaultSession.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    )
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      if (app.isPackaged && details.resourceType === 'mainFrame') {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [
              "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: pulse-cover:; media-src 'self' pulse-media:; connect-src 'self'",
            ],
          },
        })
      } else callback({ responseHeaders: details.responseHeaders })
    })
    createTray()
    createMainWindow()
    const settings = getStoredData().settings
    app.setLoginItemSettings({ openAtLogin: settings.autoLaunch })
    initializeTaskbarMode(settings)
    if (uiTestRoot) {
      try {
        await runUiSelfTest()
      } finally {
        isQuitting = true
        app.quit()
      }
      return
    }
    app.on('activate', showMainWindow)
  })
}

process.on('uncaughtException', (error) =>
  log.error('Uncaught exception', error),
)
process.on('unhandledRejection', (reason) =>
  log.error('Unhandled rejection', reason),
)
app.on('before-quit', (event) => {
  isQuitting = true
  if (autoSyncService && !autoSyncShutdownComplete) {
    event.preventDefault()
    autoSyncShutdownPromise ??= autoSyncService
      .shutdown()
      .catch((error: unknown) =>
        log.error('Automatic lyrics sync shutdown failed', error),
      )
      .finally(() => {
        autoSyncShutdownComplete = true
        app.quit()
      })
    return
  }
  if (quitCleanupComplete) return
  quitCleanupComplete = true
  clearTaskbarToggleRetopTimers()
  stopTaskbarToggleRecovery()
  if (taskbarRepositionListener) {
    screen.removeListener('display-added', taskbarRepositionListener)
    screen.removeListener('display-removed', taskbarRepositionListener)
    screen.removeListener('display-metrics-changed', taskbarRepositionListener)
    taskbarRepositionListener = undefined
  }
  if (taskbarBrowserWindowBlurListener) {
    app.removeListener('browser-window-blur', taskbarBrowserWindowBlurListener)
    taskbarBrowserWindowBlurListener = undefined
  }
  globalShortcut.unregister(TASKBAR_SHORTCUT)
  taskbarShortcutEnabled = undefined
  mediaImportService?.shutdown()
  youtubeView?.webContents.close()
  youtubeView = null
  destroyDiscordPresence()
  tray?.destroy()
  taskbarModeWindow?.destroy()
  taskbarModeWindow = null
  taskbarToggleWindow?.destroy()
  taskbarToggleWindow = null
})
app.on('window-all-closed', () => {
  if (process.env.PULSE_SHELF_TASKBAR_GEOMETRY_TEST === '1') return
  if (isQuitting || getStoredData().settings.closeBehavior === 'quit')
    app.quit()
})
