import type { Rectangle } from 'electron'

export type TaskbarEdge = 'bottom' | 'top' | 'left' | 'right'
export type TaskbarPlayerPlacement = 'above' | 'taskbar-overlay' | 'disabled'

export interface TaskbarDisplayGeometry {
  id: number
  bounds: Rectangle
  workArea: Rectangle
}

export interface TaskbarGeometry {
  displayId: number
  edge: TaskbarEdge
  taskbarBounds: Rectangle
  overlayBounds: Rectangle
  thickness: number
}

export interface TaskbarOverlayOptions {
  leftSafeInset?: number
  rightSafeInset?: number
  minWidth?: number
  maxWidth?: number
  verticalPadding?: number
}

export const TASKBAR_LEFT_SAFE_INSET = 520
export const TASKBAR_RIGHT_SAFE_INSET = 360
export const TASKBAR_OVERLAY_MIN_WIDTH = 480
export const TASKBAR_OVERLAY_MAX_WIDTH = 960
export const TASKBAR_VERTICAL_PADDING = 3
export const ABOVE_TASKBAR_PLAYER_HEIGHT = 48

const right = (rectangle: Rectangle) => rectangle.x + rectangle.width
const bottom = (rectangle: Rectangle) => rectangle.y + rectangle.height
const positive = (value: number) => Math.max(0, Math.round(value))

export function taskbarGaps(display: TaskbarDisplayGeometry) {
  const { bounds, workArea } = display
  return {
    left: positive(workArea.x - bounds.x),
    top: positive(workArea.y - bounds.y),
    right: positive(right(bounds) - right(workArea)),
    bottom: positive(bottom(bounds) - bottom(workArea)),
  } satisfies Record<TaskbarEdge, number>
}

export function detectTaskbarGeometry(
  display: TaskbarDisplayGeometry,
): Omit<TaskbarGeometry, 'overlayBounds'> | null {
  const gaps = taskbarGaps(display)
  const edges: TaskbarEdge[] = ['bottom', 'top', 'left', 'right']
  const edge = edges.reduce((largest, candidate) =>
    gaps[candidate] > gaps[largest] ? candidate : largest,
  )
  const thickness = gaps[edge]
  if (thickness <= 0) return null

  const { bounds } = display
  const taskbarBounds: Rectangle =
    edge === 'top'
      ? { x: bounds.x, y: bounds.y, width: bounds.width, height: thickness }
      : edge === 'bottom'
        ? {
            x: bounds.x,
            y: bottom(bounds) - thickness,
            width: bounds.width,
            height: thickness,
          }
        : edge === 'left'
          ? { x: bounds.x, y: bounds.y, width: thickness, height: bounds.height }
          : {
              x: right(bounds) - thickness,
              y: bounds.y,
              width: thickness,
              height: bounds.height,
            }

  return { displayId: display.id, edge, taskbarBounds, thickness }
}

export function calculateTaskbarOverlayGeometry(
  display: TaskbarDisplayGeometry,
  options: TaskbarOverlayOptions = {},
): TaskbarGeometry | null {
  const detected = detectTaskbarGeometry(display)
  if (!detected) return null
  if (detected.edge === 'left' || detected.edge === 'right') return null

  const leftSafeInset = positive(
    options.leftSafeInset ?? TASKBAR_LEFT_SAFE_INSET,
  )
  const rightSafeInset = positive(
    options.rightSafeInset ?? TASKBAR_RIGHT_SAFE_INSET,
  )
  const minWidth = Math.max(
    1,
    positive(options.minWidth ?? TASKBAR_OVERLAY_MIN_WIDTH),
  )
  const maxWidth = Math.max(
    minWidth,
    positive(options.maxWidth ?? TASKBAR_OVERLAY_MAX_WIDTH),
  )
  const verticalPadding = positive(
    options.verticalPadding ?? TASKBAR_VERTICAL_PADDING,
  )
  const availableWidth =
    detected.taskbarBounds.width - leftSafeInset - rightSafeInset
  const height = detected.taskbarBounds.height - verticalPadding * 2
  if (availableWidth < minWidth || height <= 0) return null

  const width = Math.min(availableWidth, maxWidth)
  const overlayBounds: Rectangle = {
    x:
      detected.taskbarBounds.x +
      leftSafeInset +
      Math.floor((availableWidth - width) / 2),
    y: detected.taskbarBounds.y + verticalPadding,
    width,
    height,
  }
  return { ...detected, overlayBounds }
}

export function calculateAboveTaskbarBounds(
  display: TaskbarDisplayGeometry,
  height = ABOVE_TASKBAR_PLAYER_HEIGHT,
): Rectangle {
  const detected = detectTaskbarGeometry(display)
  const safeHeight = Math.max(1, Math.min(positive(height), display.workArea.height))
  const y =
    detected?.edge === 'top'
      ? display.workArea.y
      : bottom(display.workArea) - safeHeight
  return {
    x: display.workArea.x,
    y,
    width: Math.max(1, display.workArea.width),
    height: safeHeight,
  }
}

export function resolveTaskbarPlayerPlacement(
  placement: TaskbarPlayerPlacement,
  platform: NodeJS.Platform = process.platform,
): TaskbarPlayerPlacement {
  return placement === 'taskbar-overlay' && platform !== 'win32'
    ? 'above'
    : placement
}
