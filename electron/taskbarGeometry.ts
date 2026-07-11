import type { Rectangle } from 'electron'

export type TaskbarEdge = 'top' | 'right' | 'bottom' | 'left'
export type TaskbarTogglePosition = 'left' | 'custom' | 'right'

export interface TaskbarDisplayGeometry {
  bounds: Rectangle
  workArea: Rectangle
}

export interface TaskbarRect extends Rectangle {
  edge: TaskbarEdge
}

export const DEFAULT_TRAY_RESERVED_WIDTH = 350
export const DEFAULT_CUSTOM_RIGHT_GAP = DEFAULT_TRAY_RESERVED_WIDTH + 12

const right = (rectangle: Rectangle) => rectangle.x + rectangle.width
const bottom = (rectangle: Rectangle) => rectangle.y + rectangle.height
const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum)

export function detectTaskbarEdge(
  display: TaskbarDisplayGeometry,
  fallback: TaskbarEdge = 'bottom',
): TaskbarEdge {
  const { bounds, workArea } = display
  const insets: Record<TaskbarEdge, number> = {
    top: Math.max(0, workArea.y - bounds.y),
    right: Math.max(0, right(bounds) - right(workArea)),
    bottom: Math.max(0, bottom(bounds) - bottom(workArea)),
    left: Math.max(0, workArea.x - bounds.x),
  }
  const edge = (Object.keys(insets) as TaskbarEdge[]).reduce((best, item) =>
    insets[item] > insets[best] ? item : best,
  )
  return insets[edge] > 1 ? edge : fallback
}

export function computeTaskbarRect(
  display: TaskbarDisplayGeometry,
  fallbackEdge: TaskbarEdge = 'bottom',
): TaskbarRect {
  const { bounds, workArea } = display
  const edge = detectTaskbarEdge(display, fallbackEdge)
  if (edge === 'top') {
    const height = Math.max(1, workArea.y - bounds.y)
    return { x: bounds.x, y: bounds.y, width: bounds.width, height, edge }
  }
  if (edge === 'left') {
    const width = Math.max(1, workArea.x - bounds.x)
    return { x: bounds.x, y: bounds.y, width, height: bounds.height, edge }
  }
  if (edge === 'right') {
    const x = right(workArea)
    return {
      x,
      y: bounds.y,
      width: Math.max(1, right(bounds) - x),
      height: bounds.height,
      edge,
    }
  }
  const y = bottom(workArea)
  return {
    x: bounds.x,
    y,
    width: bounds.width,
    height: Math.max(1, bottom(bounds) - y),
    edge,
  }
}

export function computeTaskbarHorizontalRange(
  taskbarRect: TaskbarRect,
  requestedWidth: number,
  trayReservedWidth = DEFAULT_TRAY_RESERVED_WIDTH,
) {
  const margin = 12
  const tray = clamp(trayReservedWidth, 180, taskbarRect.width - margin * 2)
  const rightBoundary = right(taskbarRect) - tray - margin
  const desiredLeftReserve = clamp(
    Math.round(taskbarRect.width * 0.38),
    320,
    640,
  )
  const leftReserve = Math.min(
    desiredLeftReserve,
    Math.max(margin, rightBoundary - taskbarRect.x - 36),
  )
  const minX = taskbarRect.x + leftReserve
  const availableWidth = Math.max(1, rightBoundary - minX)
  const width = Math.min(requestedWidth, availableWidth)
  return {
    minX,
    maxX: Math.max(minX, rightBoundary - width),
    width,
    leftReservedWidth: leftReserve,
    trayReservedWidth: tray,
  }
}

export function computeTaskbarToggleBounds(
  display: TaskbarDisplayGeometry,
  size: { width: number; height: number },
  position: TaskbarTogglePosition,
  fallbackEdge: TaskbarEdge = 'bottom',
  trayReservedWidth = DEFAULT_TRAY_RESERVED_WIDTH,
  customRightGap = DEFAULT_CUSTOM_RIGHT_GAP,
): Rectangle & {
  edge: TaskbarEdge
  taskbarRect: TaskbarRect
  leftReservedWidth: number
  trayReservedWidth: number
} {
  const taskbarRect = computeTaskbarRect(display, fallbackEdge)
  if (taskbarRect.edge === 'bottom' || taskbarRect.edge === 'top') {
    const range = computeTaskbarHorizontalRange(
      taskbarRect,
      size.width,
      trayReservedWidth,
    )
    const height = Math.min(size.height, taskbarRect.height)
    const presetX =
      position === 'left'
        ? range.minX
        : position === 'right'
          ? range.maxX
          : right(taskbarRect) - customRightGap - range.width
    return {
      x: clamp(Math.round(presetX), range.minX, range.maxX),
      y: clamp(
        taskbarRect.y + Math.floor((taskbarRect.height - height) / 2),
        taskbarRect.y,
        bottom(taskbarRect) - height,
      ),
      width: range.width,
      height,
      edge: taskbarRect.edge,
      taskbarRect,
      leftReservedWidth: range.leftReservedWidth,
      trayReservedWidth: range.trayReservedWidth,
    }
  }

  const margin = 4
  const width = Math.min(size.width, taskbarRect.width)
  const height = Math.min(size.height, taskbarRect.height - margin * 2)
  const y =
    position === 'left'
      ? taskbarRect.y + margin
      : position === 'right'
        ? bottom(taskbarRect) - height - margin
        : taskbarRect.y + Math.round((taskbarRect.height - height) / 2)
  return {
    x: taskbarRect.x + Math.floor((taskbarRect.width - width) / 2),
    y: clamp(y, taskbarRect.y, bottom(taskbarRect) - height),
    width,
    height,
    edge: taskbarRect.edge,
    taskbarRect,
    leftReservedWidth: 0,
    trayReservedWidth: 0,
  }
}

export function isFullscreenRect(
  rectangle: Rectangle,
  displayBounds: Rectangle,
  tolerance = 2,
) {
  return (
    Math.abs(rectangle.x - displayBounds.x) <= tolerance &&
    Math.abs(rectangle.y - displayBounds.y) <= tolerance &&
    Math.abs(rectangle.width - displayBounds.width) <= tolerance &&
    Math.abs(rectangle.height - displayBounds.height) <= tolerance
  )
}
