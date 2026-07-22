import assert from 'node:assert/strict'
import {
  planTaskbarLyricsTransition,
  scheduleTaskbarLyricsTransition,
  TASKBAR_LYRICS_TRANSITION_SETTLE_MS,
  type TaskbarLyricsDisplay,
  type TaskbarLyricsLine,
} from '../src/components/taskbar/taskbarLyricsTransition'

const lyrics = ['line zero', 'line one', 'line two', 'line three', 'line four']

function display(
  activeIndex: number,
  sequenceId = 'track-a:lyrics-a',
): TaskbarLyricsDisplay {
  const lines: TaskbarLyricsLine[] = []
  if (activeIndex > 0)
    lines.push({
      id: `${sequenceId}:${activeIndex - 1}`,
      text: lyrics[activeIndex - 1],
      role: 'previous',
    })
  lines.push({
    id: `${sequenceId}:${activeIndex}`,
    text: lyrics[activeIndex],
    role: 'current',
  })
  if (activeIndex < lyrics.length - 1)
    lines.push({
      id: `${sequenceId}:${activeIndex + 1}`,
      text: lyrics[activeIndex + 1],
      role: 'next',
    })
  return {
    sequenceId,
    activeIndex,
    lines,
    signature: `${sequenceId}:${activeIndex}`,
  }
}

export function runTaskbarLyricsTransitionTests() {
  const forward = planTaskbarLyricsTransition(display(1), display(2))
  assert.equal(forward.kind, 'forward')
  assert.deepEqual(
    forward.rows.map(({ id, fromSlot, toSlot }) => ({ id, fromSlot, toSlot })),
    [
      { id: 'track-a:lyrics-a:0', fromSlot: -1, toSlot: -2 },
      { id: 'track-a:lyrics-a:1', fromSlot: 0, toSlot: -1 },
      { id: 'track-a:lyrics-a:2', fromSlot: 1, toSlot: 0 },
      { id: 'track-a:lyrics-a:3', fromSlot: 2, toSlot: 1 },
    ],
  )

  const backward = planTaskbarLyricsTransition(display(2), display(1))
  assert.equal(backward.kind, 'backward')
  assert.deepEqual(
    backward.rows.map(({ id, fromSlot, toSlot }) => ({ id, fromSlot, toSlot })),
    [
      { id: 'track-a:lyrics-a:1', fromSlot: -1, toSlot: 0 },
      { id: 'track-a:lyrics-a:2', fromSlot: 0, toSlot: 1 },
      { id: 'track-a:lyrics-a:3', fromSlot: 1, toSlot: 2 },
      { id: 'track-a:lyrics-a:0', fromSlot: -2, toSlot: -1 },
    ],
  )

  const largeSeek = planTaskbarLyricsTransition(display(0), display(4))
  assert.equal(largeSeek.kind, 'replace')
  assert.equal(largeSeek.rows.length, 2)
  assert.ok(largeSeek.rows.every((row) => row.fromSlot === row.toSlot))

  const trackChange = planTaskbarLyricsTransition(
    display(1, 'track-a:lyrics-a'),
    display(1, 'track-b:lyrics-b'),
  )
  assert.equal(trackChange.kind, 'replace')
  assert.ok(trackChange.rows.every((row) => row.fromSlot === row.toSlot))

  const sourceChange = planTaskbarLyricsTransition(
    display(1, 'track-a:lyrics-a'),
    display(2, 'track-a:lyrics-b'),
  )
  assert.equal(sourceChange.kind, 'replace')
  assert.ok(sourceChange.rows.every((row) => !row.id.includes('lyrics-a')))

  const interruptedForward = planTaskbarLyricsTransition(display(0), display(1))
  assert.equal(interruptedForward.kind, 'forward')
  const latest = planTaskbarLyricsTransition(interruptedForward.to, display(4))
  assert.equal(latest.kind, 'replace')
  assert.equal(latest.to.activeIndex, 4)
  assert.equal(
    latest.rows.filter((row) => row.toRole === 'current').length,
    1,
    'rapid updates must retain exactly one current line',
  )
  assert.equal(
    new Set(latest.rows.map((row) => row.id)).size,
    latest.rows.length,
    'stable line keys must not duplicate after replacement',
  )

  let nextHandle = 1
  const frameCallbacks = new Map<number, FrameRequestCallback>()
  const timerCallbacks = new Map<number, () => void>()
  const cancelledFrames = new Set<number>()
  const clearedTimers = new Set<number>()
  let animateCount = 0
  let settleCount = 0
  let scheduledTimeout = 0
  const cancel = scheduleTaskbarLyricsTransition(
    {
      requestAnimationFrame: (callback) => {
        const handle = nextHandle++
        frameCallbacks.set(handle, callback)
        return handle
      },
      cancelAnimationFrame: (handle) => void cancelledFrames.add(handle),
      setTimeout: (callback, timeout) => {
        scheduledTimeout = timeout
        const handle = nextHandle++
        timerCallbacks.set(handle, callback)
        return handle
      },
      clearTimeout: (handle) => void clearedTimers.add(handle),
    },
    () => {
      animateCount += 1
    },
    () => {
      settleCount += 1
    },
  )
  frameCallbacks.get(1)?.(0)
  cancel()
  frameCallbacks.get(3)?.(16)
  timerCallbacks.get(2)?.()
  assert.equal(scheduledTimeout, TASKBAR_LYRICS_TRANSITION_SETTLE_MS)
  assert.deepEqual([...cancelledFrames], [1, 3])
  assert.deepEqual([...clearedTimers], [2])
  assert.equal(animateCount, 0, 'unmount cleanup must cancel pending animation')
  assert.equal(settleCount, 0, 'unmount cleanup must cancel pending settle work')
}
