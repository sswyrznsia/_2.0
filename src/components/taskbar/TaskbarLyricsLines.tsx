import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { TaskbarLyricsSnapshot } from '../../types/models'
import {
  planTaskbarLyricsTransition,
  scheduleTaskbarLyricsTransition,
  type TaskbarLyricsDisplay,
  type TaskbarLyricsLineRole,
  type TaskbarLyricsTransitionPlan,
} from './taskbarLyricsTransition'

type TransitionPhase = 'idle' | 'entering' | 'animating'

interface TaskbarLyricsLinesProps {
  trackId?: string
  status: TaskbarLyricsSnapshot['status'] | 'loading'
  lyrics?: TaskbarLyricsSnapshot
  previousLine: string
  currentLine: string
  nextLine: string
}

interface TaskbarLyricsDisplayInput
  extends Omit<TaskbarLyricsLinesProps, 'lyrics'> {
  source?: TaskbarLyricsSnapshot['source']
  sequenceId?: string
  previousLineIndex?: number
  currentLineIndex?: number
  nextLineIndex?: number
}

interface RenderState {
  phase: TransitionPhase
  plan: TaskbarLyricsTransitionPlan
}

function lineId(
  sequenceId: string,
  role: TaskbarLyricsLineRole,
  index: number | undefined,
  text: string,
) {
  return `${sequenceId}:${index ?? role}:${text}`
}

function displayFromProps({
  trackId,
  status,
  source,
  sequenceId: snapshotSequenceId,
  previousLineIndex,
  currentLineIndex,
  nextLineIndex,
  previousLine,
  currentLine,
  nextLine,
}: TaskbarLyricsDisplayInput): TaskbarLyricsDisplay {
  const sequenceId =
    status === 'active' && snapshotSequenceId
      ? snapshotSequenceId
      : `${trackId ?? 'no-track'}:${status}:${source ?? 'none'}`
  const lines = [
    previousLine
      ? {
          role: 'previous' as const,
          text: previousLine,
          index: previousLineIndex,
        }
      : null,
    {
      role: 'current' as const,
      text: currentLine,
      index: currentLineIndex,
    },
    nextLine
      ? {
          role: 'next' as const,
          text: nextLine,
          index: nextLineIndex,
        }
      : null,
  ]
    .filter((line) => line !== null)
    .map(({ role, text, index }) => ({
      id: lineId(sequenceId, role, index, text),
      role,
      text,
    }))
  const activeIndex =
    status === 'active' && Number.isInteger(currentLineIndex)
      ? currentLineIndex ?? null
      : null
  return {
    sequenceId,
    activeIndex,
    lines,
    signature: `${sequenceId}:${activeIndex ?? 'none'}:${lines
      .map((line) => line.id)
      .join('|')}`,
  }
}

export function TaskbarLyricsLines(props: TaskbarLyricsLinesProps) {
  const {
    trackId,
    status,
    lyrics,
    previousLine,
    currentLine,
    nextLine,
  } = props
  const source = lyrics?.source
  const sequenceId = lyrics?.sequenceId
  const previousLineIndex = lyrics?.previousLineIndex
  const currentLineIndex = lyrics?.currentLineIndex
  const nextLineIndex = lyrics?.nextLineIndex
  const display = useMemo(
    () =>
      displayFromProps({
        trackId,
        status,
        source,
        sequenceId,
        previousLineIndex,
        currentLineIndex,
        nextLineIndex,
        previousLine,
        currentLine,
        nextLine,
      }),
    [
      currentLine,
      currentLineIndex,
      nextLine,
      nextLineIndex,
      previousLine,
      previousLineIndex,
      sequenceId,
      source,
      status,
      trackId,
    ],
  )
  const latestDisplay = useRef(display)
  const cancelSchedule = useRef<(() => void) | null>(null)
  const [renderState, setRenderState] = useState<RenderState>(() => ({
    phase: 'idle',
    plan: planTaskbarLyricsTransition(null, display),
  }))

  useEffect(() => {
    const from = latestDisplay.current
    latestDisplay.current = display
    cancelSchedule.current?.()
    cancelSchedule.current = null

    const plan = planTaskbarLyricsTransition(from, display)
    if (plan.kind !== 'forward' && plan.kind !== 'backward') {
      setRenderState({ phase: 'idle', plan })
      return
    }

    setRenderState({ phase: 'entering', plan })
    cancelSchedule.current = scheduleTaskbarLyricsTransition(
      window,
      () => {
        setRenderState((current) =>
          current.plan.to.signature === display.signature
            ? { ...current, phase: 'animating' }
            : current,
        )
      },
      () => {
        cancelSchedule.current = null
        setRenderState({
          phase: 'idle',
          plan: planTaskbarLyricsTransition(null, latestDisplay.current),
        })
      },
    )

    return () => {
      cancelSchedule.current?.()
      cancelSchedule.current = null
    }
  }, [display])

  const activeLine = display.lines.find((line) => line.role === 'current')?.text

  return (
    <div
      className="taskbar-lyrics-viewport"
      data-lyric-transition={renderState.plan.kind}
      data-lyric-transition-phase={renderState.phase}
      data-active-lyric-index={display.activeIndex ?? undefined}
      data-active-lyric-line={activeLine}
    >
      {renderState.plan.rows.map((row) => {
        const visibleRole = row.toRole ?? row.fromRole
        return (
          <span
            key={row.id}
            className={`taskbar-lyrics-line taskbar-lyrics-window__${visibleRole}`}
            data-line-id={row.id}
            data-line-role={row.toRole ?? 'outgoing'}
            data-from-slot={row.fromSlot}
            data-to-slot={row.toSlot}
            style={
              {
                '--lyric-from-opacity': row.fromOpacity,
                '--lyric-to-opacity': row.toOpacity,
              } as CSSProperties
            }
            title={row.text}
            aria-hidden={row.toRole !== 'current'}
          >
            {row.text}
          </span>
        )
      })}
    </div>
  )
}
