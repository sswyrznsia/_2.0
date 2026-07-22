import { BrowserWindow, type Rectangle } from 'electron'
import type {
  TaskbarLyricsAlignment,
  TaskbarLyricsCustomOffset,
  TaskbarLyricsPosition,
} from '../../src/types/models'
import type { TaskbarEdge } from './taskbarOverlayPositioner'

export const TASKBAR_LYRICS_PANEL_HEIGHT = 92
export const TASKBAR_LYRICS_PANEL_INSET = 6
export const TASKBAR_LYRICS_WINDOW_HEIGHT =
  TASKBAR_LYRICS_PANEL_HEIGHT + TASKBAR_LYRICS_PANEL_INSET * 2
export const TASKBAR_LYRICS_WINDOW_MIN_WIDTH = 480
export const TASKBAR_LYRICS_WINDOW_MAX_WIDTH = 760
// The transparent inset supplies the visible six-DIP panel-to-player gap.
export const TASKBAR_LYRICS_WINDOW_GAP = 0

export interface TaskbarLyricsBoundsOptions {
  height?: number
  minWidth?: number
  maxWidth?: number
  gap?: number
}

export interface TaskbarLyricsAnchor {
  playerBounds: Rectangle
  displayBounds: Rectangle
  edge: TaskbarEdge
  position?: TaskbarLyricsPosition
  alignment?: TaskbarLyricsAlignment
  customOffset?: TaskbarLyricsCustomOffset | null
}

export function calculateTaskbarLyricsAutomaticBounds(
  anchor: TaskbarLyricsAnchor,
  options: TaskbarLyricsBoundsOptions = {},
): Rectangle {
  const {
    playerBounds,
    displayBounds,
    edge,
    position = 'auto',
    alignment = 'center',
  } = anchor
  const height = Math.min(
    Math.max(1, Math.round(options.height ?? TASKBAR_LYRICS_WINDOW_HEIGHT)),
    displayBounds.height,
  )
  const minimumWidth = Math.max(
    1,
    Math.round(options.minWidth ?? TASKBAR_LYRICS_WINDOW_MIN_WIDTH),
  )
  const maximumWidth = Math.max(
    minimumWidth,
    Math.round(options.maxWidth ?? TASKBAR_LYRICS_WINDOW_MAX_WIDTH),
  )
  const width = Math.min(
    displayBounds.width,
    Math.max(minimumWidth, Math.min(playerBounds.width, maximumWidth)),
  )
  const gap = Math.max(0, Math.round(options.gap ?? TASKBAR_LYRICS_WINDOW_GAP))
  const minimumX = displayBounds.x
  const maximumX = displayBounds.x + displayBounds.width - width
  const preferredX =
    alignment === 'left'
      ? playerBounds.x
      : alignment === 'right'
        ? playerBounds.x + playerBounds.width - width
        : playerBounds.x + Math.floor((playerBounds.width - width) / 2)
  const x = Math.min(Math.max(preferredX, minimumX), maximumX)
  const minimumY = displayBounds.y
  const maximumY = displayBounds.y + displayBounds.height - height
  const aboveY = playerBounds.y - gap - height
  const belowY = playerBounds.y + playerBounds.height + gap
  const autoY =
    edge === 'top'
      ? belowY
      : edge === 'left' || edge === 'right'
        ? playerBounds.y + Math.floor((playerBounds.height - height) / 2)
        : aboveY
  const requestedY =
    position === 'above-player'
      ? aboveY
      : position === 'below-player'
        ? belowY
        : autoY
  const fitsDisplay = (value: number) =>
    value >= minimumY && value <= maximumY
  const preferredY =
    position !== 'auto' && !fitsDisplay(requestedY) && fitsDisplay(autoY)
      ? autoY
      : requestedY
  const y = Math.min(Math.max(preferredY, minimumY), maximumY)
  return { x, y, width, height }
}

export function calculateTaskbarLyricsBounds(
  anchor: TaskbarLyricsAnchor,
  options: TaskbarLyricsBoundsOptions = {},
): Rectangle {
  const automatic = calculateTaskbarLyricsAutomaticBounds(anchor, options)
  const offset = anchor.customOffset
  if (!offset) return automatic
  const minimumX = anchor.displayBounds.x
  const maximumX =
    anchor.displayBounds.x + anchor.displayBounds.width - automatic.width
  const minimumY = anchor.displayBounds.y
  const maximumY =
    anchor.displayBounds.y + anchor.displayBounds.height - automatic.height
  return {
    ...automatic,
    x: Math.min(
      Math.max(automatic.x + Math.round(offset.x), minimumX),
      maximumX,
    ),
    y: Math.min(
      Math.max(automatic.y + Math.round(offset.y), minimumY),
      maximumY,
    ),
  }
}

interface TaskbarLyricsWindowControllerOptions {
  preloadPath: string
  loadRenderer: (window: BrowserWindow) => Promise<void>
  configureWindow: (window: BrowserWindow) => void
  onReady?: (window: BrowserWindow) => void
  onStateChanged?: () => void
  onCustomOffsetChanged?: (offset: TaskbarLyricsCustomOffset | null) => void
}

export class TaskbarLyricsWindowController {
  private window: BrowserWindow | null = null
  private creating: Promise<BrowserWindow> | null = null
  private desiredVisible = false
  private displayAllowed = false
  private editing = false
  private settingBounds = false
  private moveListenerAttached = false
  private currentAnchor: TaskbarLyricsAnchor | null = null
  private offsetSaveTimer: NodeJS.Timeout | undefined
  private ignoredMoveBounds: Rectangle | null = null

  constructor(private readonly options: TaskbarLyricsWindowControllerOptions) {}

  getState() {
    const window = this.window
    return {
      desiredVisible: this.desiredVisible,
      visible: Boolean(window && !window.isDestroyed() && window.isVisible()),
      windowCount: window && !window.isDestroyed() ? 1 : 0,
      bounds: window && !window.isDestroyed() ? window.getBounds() : null,
      webContentsId:
        window && !window.isDestroyed() ? window.webContents.id : null,
      editing: this.editing,
      clickThrough: !this.editing,
      focusable: Boolean(
        window && !window.isDestroyed() && window.isFocusable(),
      ),
      moveListenerCount: this.moveListenerAttached ? 1 : 0,
    }
  }

  async toggle(anchor: TaskbarLyricsAnchor) {
    this.desiredVisible = !this.desiredVisible
    this.displayAllowed = true
    if (this.desiredVisible) await this.showIfDesired(anchor)
    else {
      this.flushCustomOffset()
      this.restoreClickThrough()
      this.hideWindow()
    }
    this.options.onStateChanged?.()
    return this.getState()
  }

  async showIfDesired(anchor: TaskbarLyricsAnchor) {
    this.displayAllowed = true
    this.currentAnchor = anchor
    if (!this.desiredVisible) return this.getState()
    const bounds = calculateTaskbarLyricsBounds(anchor)
    const window = await this.ensureWindow(bounds)
    if (!this.desiredVisible || !this.displayAllowed || window.isDestroyed())
      return this.getState()
    this.setBounds(window, bounds)
    window.showInactive()
    window.moveTop()
    this.options.onStateChanged?.()
    return this.getState()
  }

  reposition(anchor: TaskbarLyricsAnchor) {
    this.currentAnchor = anchor
    const window = this.window
    if (!window || window.isDestroyed()) return
    this.setBounds(window, calculateTaskbarLyricsBounds(anchor))
  }

  async enterEditMode(anchor: TaskbarLyricsAnchor) {
    this.currentAnchor = anchor
    const window = await this.ensureWindow(calculateTaskbarLyricsBounds(anchor))
    if (window.isDestroyed() || !this.desiredVisible || !this.displayAllowed)
      return this.getState()
    this.editing = true
    window.setMovable(true)
    window.setFocusable(true)
    window.setIgnoreMouseEvents(false)
    window.showInactive()
    window.moveTop()
    this.options.onStateChanged?.()
    return this.getState()
  }

  exitEditMode() {
    this.flushCustomOffset()
    this.restoreClickThrough()
    this.options.onStateChanged?.()
    return this.getState()
  }

  resetPosition(anchor: TaskbarLyricsAnchor) {
    this.cancelOffsetSave()
    const resetAnchor = { ...anchor, customOffset: null }
    this.currentAnchor = resetAnchor
    this.options.onCustomOffsetChanged?.(null)
    const window = this.window
    if (window && !window.isDestroyed())
      this.setBounds(window, calculateTaskbarLyricsBounds(resetAnchor))
    this.options.onStateChanged?.()
    return this.getState()
  }

  updateEditPosition(x: number, y: number) {
    const window = this.window
    const anchor = this.currentAnchor
    if (!this.editing || !window || window.isDestroyed() || !anchor)
      return this.getState()
    const automatic = calculateTaskbarLyricsAutomaticBounds(anchor)
    this.currentAnchor = {
      ...anchor,
      customOffset: { x: Math.round(x) - automatic.x, y: Math.round(y) - automatic.y },
    }
    this.flushCustomOffset()
    return this.getState()
  }

  suspend() {
    this.displayAllowed = false
    this.flushCustomOffset()
    this.restoreClickThrough()
    this.hideWindow()
  }

  hide() {
    this.desiredVisible = false
    this.suspend()
  }

  send(channel: string, ...args: unknown[]) {
    const window = this.window
    if (window && !window.isDestroyed()) window.webContents.send(channel, ...args)
  }

  destroy() {
    this.desiredVisible = false
    this.displayAllowed = false
    const window = this.window
    this.cancelOffsetSave()
    this.restoreClickThrough()
    this.detachMoveListener(window)
    this.window = null
    this.creating = null
    if (window && !window.isDestroyed()) window.destroy()
  }

  private async ensureWindow(bounds: Rectangle) {
    if (this.window && !this.window.isDestroyed()) return this.window
    if (this.creating) return this.creating
    this.creating = this.createWindow(bounds)
    try {
      return await this.creating
    } finally {
      this.creating = null
    }
  }

  private async createWindow(bounds: Rectangle) {
    const window = new BrowserWindow({
      ...bounds,
      title: 'Pulse Shelf Taskbar Lyrics',
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      focusable: false,
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    this.window = window
    this.options.configureWindow(window)
    window.setMenuBarVisibility(false)
    window.setVisibleOnAllWorkspaces(false)
    window.setIgnoreMouseEvents(true, { forward: true })
    window.on('move', this.handleWindowMove)
    this.moveListenerAttached = true
    window.on('closed', () => {
      if (this.window === window) {
        this.cancelOffsetSave()
        this.detachMoveListener(window)
        this.editing = false
        this.window = null
        this.options.onStateChanged?.()
      }
    })
    try {
      await this.options.loadRenderer(window)
      if (window.isDestroyed()) throw new Error('Taskbar lyrics window closed while loading')
      window.setAlwaysOnTop(true, 'pop-up-menu')
      this.options.onReady?.(window)
      return window
    } catch (error) {
      if (!window.isDestroyed()) window.destroy()
      throw error
    }
  }

  private hideWindow() {
    const window = this.window
    if (window && !window.isDestroyed()) window.hide()
  }

  private setBounds(window: BrowserWindow, bounds: Rectangle) {
    const current = window.getBounds()
    if (
      current.x !== bounds.x ||
      current.y !== bounds.y ||
      current.width !== bounds.width ||
      current.height !== bounds.height
    ) {
      this.ignoredMoveBounds = bounds
      this.settingBounds = true
      try {
        window.setBounds(bounds, false)
      } finally {
        this.settingBounds = false
      }
    }
  }

  private readonly handleWindowMove = () => {
    const window = this.window
    const anchor = this.currentAnchor
    if (
      !this.editing ||
      this.settingBounds ||
      !window ||
      window.isDestroyed() ||
      !anchor
    )
      return
    const automatic = calculateTaskbarLyricsAutomaticBounds(anchor)
    const current = window.getBounds()
    if (
      this.ignoredMoveBounds &&
      current.x === this.ignoredMoveBounds.x &&
      current.y === this.ignoredMoveBounds.y &&
      current.width === this.ignoredMoveBounds.width &&
      current.height === this.ignoredMoveBounds.height
    ) {
      this.ignoredMoveBounds = null
      return
    }
    this.ignoredMoveBounds = null
    this.currentAnchor = {
      ...anchor,
      customOffset: {
        x: current.x - automatic.x,
        y: current.y - automatic.y,
      },
    }
    this.cancelOffsetSave()
    this.offsetSaveTimer = setTimeout(() => this.flushCustomOffset(), 300)
  }

  private flushCustomOffset() {
    this.cancelOffsetSave()
    const window = this.window
    const anchor = this.currentAnchor
    if (!window || window.isDestroyed() || !anchor?.customOffset) return
    const automatic = calculateTaskbarLyricsAutomaticBounds(anchor)
    const clamped = calculateTaskbarLyricsBounds(anchor)
    this.setBounds(window, clamped)
    const offset = {
      x: clamped.x - automatic.x,
      y: clamped.y - automatic.y,
    }
    this.currentAnchor = { ...anchor, customOffset: offset }
    this.options.onCustomOffsetChanged?.(offset)
    this.options.onStateChanged?.()
  }

  private cancelOffsetSave() {
    if (this.offsetSaveTimer) clearTimeout(this.offsetSaveTimer)
    this.offsetSaveTimer = undefined
  }

  private restoreClickThrough() {
    this.editing = false
    const window = this.window
    if (!window || window.isDestroyed()) return
    window.setIgnoreMouseEvents(true, { forward: true })
    window.setFocusable(false)
    window.setMovable(false)
  }

  private detachMoveListener(window: BrowserWindow | null) {
    if (!window || !this.moveListenerAttached) return
    window.removeListener('move', this.handleWindowMove)
    this.moveListenerAttached = false
  }
}
