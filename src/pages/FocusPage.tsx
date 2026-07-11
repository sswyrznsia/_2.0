import {
  ChevronDown,
  ChevronUp,
  Pause,
  Play,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { AlbumCover } from '../components/common/AlbumCover'
import { IconButton } from '../components/common/IconButton'
import { useAppStore } from '../stores/appStore'
import { usePlayerStore } from '../stores/playerStore'
import type { FocusTimer, FocusTimerMode } from '../types/models'
import { formatTime } from '../utils/format'

export function FocusPage() {
  const focusData = useAppStore((state) => state.data?.focus)
  const updateTimer = useAppStore((state) => state.updateFocusTimer)
  const addTodo = useAppStore((state) => state.addTodo)
  const toggleTodo = useAppStore((state) => state.toggleTodo)
  const deleteTodo = useAppStore((state) => state.deleteTodo)
  const moveTodo = useAppStore((state) => state.moveTodo)
  const currentTrack = usePlayerStore((state) => state.currentTrack)
  const [now, setNow] = useState(0)
  const [todoText, setTodoText] = useState('')
  const timer = focusData?.timer

  useEffect(() => {
    if (timer?.status !== 'running') return
    const interval = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(interval)
  }, [timer?.status])

  const remaining =
    timer?.status === 'running' && timer.endsAt && now
      ? Math.max(0, Math.ceil((timer.endsAt - now) / 1000))
      : (timer?.remainingSeconds ?? 0)

  useEffect(() => {
    if (
      !timer ||
      timer.status !== 'running' ||
      remaining > 0 ||
      !timer.startedAt ||
      !timer.endsAt
    )
      return
    const elapsed = Math.max(
      0,
      Math.floor((timer.endsAt - timer.startedAt) / 1000),
    )
    updateTimer(
      {
        ...timer,
        status: 'idle',
        remainingSeconds: 0,
        startedAt: undefined,
        endsAt: undefined,
      },
      timer.mode === 'focus' ? elapsed : 0,
    )
  }, [remaining, timer, updateTimer])

  if (!focusData || !timer) return null

  const start = () => {
    const startedAt = Date.now()
    const seconds =
      remaining ||
      (timer.mode === 'focus'
        ? timer.focusMinutes * 60
        : timer.breakMinutes * 60)
    updateTimer({
      ...timer,
      status: 'running',
      remainingSeconds: seconds,
      startedAt,
      endsAt: startedAt + seconds * 1000,
    })
    setNow(startedAt)
  }

  const pause = () => {
    if (timer.status !== 'running' || !timer.startedAt) return
    const elapsed = Math.max(
      0,
      Math.floor((Date.now() - timer.startedAt) / 1000),
    )
    updateTimer(
      {
        ...timer,
        status: 'paused',
        remainingSeconds: remaining,
        startedAt: undefined,
        endsAt: undefined,
      },
      timer.mode === 'focus' ? elapsed : 0,
    )
  }

  const reset = () =>
    updateTimer({
      ...timer,
      status: 'idle',
      remainingSeconds:
        (timer.mode === 'focus' ? timer.focusMinutes : timer.breakMinutes) * 60,
      startedAt: undefined,
      endsAt: undefined,
    })

  const changeMode = (mode: FocusTimerMode) => {
    if (timer.status === 'running') return
    updateTimer({
      ...timer,
      mode,
      status: 'idle',
      remainingSeconds:
        (mode === 'focus' ? timer.focusMinutes : timer.breakMinutes) * 60,
      startedAt: undefined,
      endsAt: undefined,
    })
  }

  const changeDuration = (
    kind: 'focusMinutes' | 'breakMinutes',
    value: number,
  ) => {
    const limit = kind === 'focusMinutes' ? 180 : 60
    const minutes = Math.max(1, Math.min(limit, Math.round(value)))
    const next: FocusTimer = { ...timer, [kind]: minutes }
    const affected =
      (kind === 'focusMinutes' && timer.mode === 'focus') ||
      (kind === 'breakMinutes' && timer.mode === 'break')
    updateTimer(
      affected && timer.status !== 'running'
        ? { ...next, status: 'idle', remainingSeconds: minutes * 60 }
        : next,
    )
  }

  const runningFocusSeconds =
    timer.status === 'running' && timer.mode === 'focus' && timer.startedAt
      ? Math.max(0, Math.floor((now - timer.startedAt) / 1000))
      : 0

  return (
    <div className="page focus-page">
      <header className="page-header">
        <div>
          <h1>집중 모드</h1>
          <p>
            오늘 집중{' '}
            {formatTime(focusData.focusedSeconds + runningFocusSeconds)}
          </p>
        </div>
      </header>
      <div className="focus-layout">
        <section className="timer-section">
          <div className="tabs" role="tablist" aria-label="타이머 모드">
            <button
              type="button"
              role="tab"
              aria-selected={timer.mode === 'focus'}
              disabled={timer.status === 'running'}
              onClick={() => changeMode('focus')}
            >
              집중
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={timer.mode === 'break'}
              disabled={timer.status === 'running'}
              onClick={() => changeMode('break')}
            >
              휴식
            </button>
          </div>
          <div className="timer-settings">
            <label>
              집중{' '}
              <input
                type="number"
                min="1"
                max="180"
                value={timer.focusMinutes}
                disabled={timer.status === 'running'}
                onChange={(event) =>
                  changeDuration('focusMinutes', Number(event.target.value))
                }
              />
              분
            </label>
            <label>
              휴식{' '}
              <input
                type="number"
                min="1"
                max="60"
                value={timer.breakMinutes}
                disabled={timer.status === 'running'}
                onChange={(event) =>
                  changeDuration('breakMinutes', Number(event.target.value))
                }
              />
              분
            </label>
          </div>
          <time>{formatTime(remaining)}</time>
          <div>
            <button
              type="button"
              className="button button--primary timer-button"
              onClick={timer.status === 'running' ? pause : start}
            >
              {timer.status === 'running' ? (
                <Pause fill="currentColor" />
              ) : (
                <Play fill="currentColor" />
              )}
              {timer.status === 'running'
                ? '일시정지'
                : timer.status === 'paused'
                  ? '재개'
                  : '시작'}
            </button>
            <IconButton label="타이머 초기화" onClick={reset}>
              <RotateCcw />
            </IconButton>
          </div>
          <div className="focus-playing">
            <AlbumCover
              src={currentTrack?.coverUrl}
              alt={currentTrack?.album ?? '현재 재생곡'}
            />
            <span>
              <strong>{currentTrack?.title ?? '재생 중인 곡 없음'}</strong>
              <small>
                {currentTrack?.artist ?? 'PlayerBar에서 음악을 선택하세요.'}
              </small>
            </span>
          </div>
        </section>
        <section className="todo-section">
          <h2>할 일</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              addTodo(todoText)
              setTodoText('')
            }}
          >
            <input
              value={todoText}
              maxLength={120}
              onChange={(event) => setTodoText(event.target.value)}
              placeholder="할 일을 입력하세요"
              aria-label="새 할 일"
            />
            <button
              type="submit"
              className="button"
              disabled={!todoText.trim()}
            >
              추가
            </button>
          </form>
          <div className="todo-list">
            {focusData.todos.map((todo, index) => (
              <div key={todo.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={todo.completed}
                    onChange={() => toggleTodo(todo.id)}
                  />
                  <span>{todo.text}</span>
                </label>
                <IconButton
                  label="한 칸 위로"
                  disabled={index === 0}
                  onClick={() => moveTodo(todo.id, -1)}
                >
                  <ChevronUp />
                </IconButton>
                <IconButton
                  label="한 칸 아래로"
                  disabled={index === focusData.todos.length - 1}
                  onClick={() => moveTodo(todo.id, 1)}
                >
                  <ChevronDown />
                </IconButton>
                <IconButton
                  label="할 일 삭제"
                  onClick={() => deleteTodo(todo.id)}
                >
                  <Trash2 />
                </IconButton>
              </div>
            ))}
            {!focusData.todos.length && <p>집중할 일을 간단히 적어 두세요.</p>}
          </div>
        </section>
      </div>
    </div>
  )
}
