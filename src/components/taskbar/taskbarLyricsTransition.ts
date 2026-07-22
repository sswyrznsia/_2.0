export type TaskbarLyricsLineRole = 'previous' | 'current' | 'next'
export type TaskbarLyricsTransitionKind =
  | 'idle'
  | 'forward'
  | 'backward'
  | 'replace'

export interface TaskbarLyricsLine {
  id: string
  text: string
  role: TaskbarLyricsLineRole
}

export interface TaskbarLyricsDisplay {
  signature: string
  sequenceId: string
  activeIndex: number | null
  lines: TaskbarLyricsLine[]
}

export interface TaskbarLyricsTransitionRow {
  id: string
  text: string
  fromRole: TaskbarLyricsLineRole
  toRole: TaskbarLyricsLineRole | null
  fromSlot: number
  toSlot: number
  fromOpacity: number
  toOpacity: number
}

export interface TaskbarLyricsTransitionPlan {
  kind: TaskbarLyricsTransitionKind
  from: TaskbarLyricsDisplay | null
  to: TaskbarLyricsDisplay
  rows: TaskbarLyricsTransitionRow[]
}

export const TASKBAR_LYRICS_TRANSITION_DURATION_MS = 380
export const TASKBAR_LYRICS_TRANSITION_SETTLE_MS =
  TASKBAR_LYRICS_TRANSITION_DURATION_MS + 60

export interface TaskbarLyricsTransitionClock {
  requestAnimationFrame: (callback: FrameRequestCallback) => number
  cancelAnimationFrame: (handle: number) => void
  setTimeout: (callback: () => void, timeout: number) => number
  clearTimeout: (handle: number) => void
}

export function scheduleTaskbarLyricsTransition(
  clock: TaskbarLyricsTransitionClock,
  animate: () => void,
  settle: () => void,
) {
  let cancelled = false
  let secondFrame: number | null = null
  const firstFrame = clock.requestAnimationFrame(() => {
    if (cancelled) return
    secondFrame = clock.requestAnimationFrame(() => {
      if (!cancelled) animate()
    })
  })
  const settleTimer = clock.setTimeout(() => {
    if (!cancelled) settle()
  }, TASKBAR_LYRICS_TRANSITION_SETTLE_MS)

  return () => {
    cancelled = true
    clock.cancelAnimationFrame(firstFrame)
    if (secondFrame !== null) clock.cancelAnimationFrame(secondFrame)
    clock.clearTimeout(settleTimer)
  }
}

const roleSlot: Record<TaskbarLyricsLineRole, number> = {
  previous: -1,
  current: 0,
  next: 1,
}

const roleOpacity: Record<TaskbarLyricsLineRole, number> = {
  previous: 0.62,
  current: 1,
  next: 0.78,
}

function stationaryRows(display: TaskbarLyricsDisplay) {
  return display.lines.map<TaskbarLyricsTransitionRow>((line) => ({
    ...line,
    fromRole: line.role,
    toRole: line.role,
    fromSlot: roleSlot[line.role],
    toSlot: roleSlot[line.role],
    fromOpacity: roleOpacity[line.role],
    toOpacity: roleOpacity[line.role],
  }))
}

function sequentialRows(
  from: TaskbarLyricsDisplay,
  to: TaskbarLyricsDisplay,
  direction: 'forward' | 'backward',
) {
  const fromById = new Map(from.lines.map((line) => [line.id, line]))
  const toById = new Map(to.lines.map((line) => [line.id, line]))
  const ids = new Set([...fromById.keys(), ...toById.keys()])
  const enteringSlot = direction === 'forward' ? 2 : -2
  const exitingSlot = direction === 'forward' ? -2 : 2

  return [...ids].map<TaskbarLyricsTransitionRow>((id) => {
    const oldLine = fromById.get(id)
    const newLine = toById.get(id)
    const fromRole = oldLine?.role ?? newLine?.role ?? 'current'
    return {
      id,
      text: newLine?.text ?? oldLine?.text ?? '',
      fromRole,
      toRole: newLine?.role ?? null,
      fromSlot: oldLine ? roleSlot[oldLine.role] : enteringSlot,
      toSlot: newLine ? roleSlot[newLine.role] : exitingSlot,
      fromOpacity: oldLine ? roleOpacity[oldLine.role] : 0,
      toOpacity: newLine ? roleOpacity[newLine.role] : 0,
    }
  })
}

export function planTaskbarLyricsTransition(
  from: TaskbarLyricsDisplay | null,
  to: TaskbarLyricsDisplay,
): TaskbarLyricsTransitionPlan {
  if (!from)
    return { kind: 'idle', from, to, rows: stationaryRows(to) }
  if (from.signature === to.signature)
    return { kind: 'idle', from, to, rows: stationaryRows(to) }

  const sameSequence = from.sequenceId === to.sequenceId
  const hasIndexes = from.activeIndex !== null && to.activeIndex !== null
  const delta = hasIndexes ? to.activeIndex! - from.activeIndex! : 0
  if (sameSequence && delta === 1)
    return {
      kind: 'forward',
      from,
      to,
      rows: sequentialRows(from, to, 'forward'),
    }
  if (sameSequence && delta === -1)
    return {
      kind: 'backward',
      from,
      to,
      rows: sequentialRows(from, to, 'backward'),
    }

  return { kind: 'replace', from, to, rows: stationaryRows(to) }
}
