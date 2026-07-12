import {
  Disc3,
  ListMusic,
  Maximize2,
  Minus,
  Pause,
  Play,
  Plus,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type {
  PlayerCommand,
  PlayerSnapshot,
  TaskbarModeAction,
  TaskbarModeState,
} from '../../types/models'
import { formatTime } from '../../utils/format'
import { AlbumCover } from '../common/AlbumCover'
import { IconButton } from '../common/IconButton'

const emptyState: TaskbarModeState = {
  enabled: false,
  pulseTaskbarVisible: false,
  modeWindowVisible: false,
  toggleWindowVisible: false,
  registeredShortcutCount: 0,
}

function useTaskbarRuntime() {
  const [player, setPlayer] = useState<PlayerSnapshot | null>(null)
  const [modeState, setModeState] = useState(emptyState)

  useEffect(() => {
    const unsubscribePlayer = window.electronAPI.onPlayerSnapshot(setPlayer)
    const unsubscribeMode = window.electronAPI.onTaskbarModeState(setModeState)
    void window.electronAPI.getTaskbarModeState().then(setModeState)
    document.documentElement.dataset.theme = 'dark'
    return () => {
      unsubscribePlayer()
      unsubscribeMode()
    }
  }, [])

  const action = (value: TaskbarModeAction) =>
    window.electronAPI.taskbarModeAction(value).then(setModeState)
  const command = (value: PlayerCommand) =>
    window.electronAPI.sendPlayerCommand(value)

  return { player, modeState, setModeState, action, command }
}

export function TaskbarMode() {
  const { player, action, command } = useTaskbarRuntime()
  const track = player?.currentTrack
  const progressMax = Math.max(player?.duration ?? 0, 0.01)
  const currentTime = Math.min(player?.currentTime ?? 0, progressMax)
  const lyrics = player?.lyrics
  const lyricsTooltip = [lyrics?.currentLine, lyrics?.nextLine]
    .filter(Boolean)
    .join('\n')

  return (
    <main className="taskbar-mode" aria-label="Pulse Shelf 작업표시줄">
      <div className="taskbar-mode__track">
        <button
          type="button"
          className="taskbar-mode__brand"
          title="Pulse Shelf 열기"
          onClick={() => void window.electronAPI.showMainWindow()}
        >
          <Disc3 />
          <span>Pulse Shelf</span>
        </button>
        <AlbumCover
          src={track?.coverUrl}
          alt={track?.album ?? '현재 재생곡'}
        />
        <span className="taskbar-mode__track-copy" aria-live="polite">
          <strong title={track?.title}>{track?.title ?? '재생 중인 곡 없음'}</strong>
          <span title={track?.artist}>{track?.artist ?? 'Pulse Shelf'}</span>
        </span>
      </div>

      <div className="taskbar-mode__center">
        <div className="taskbar-mode__controls">
          <IconButton
            label="셔플"
            active={player?.shuffle}
            disabled={!player?.queue.length}
            onClick={() => command({ type: 'toggle-shuffle' })}
          >
            <Shuffle />
          </IconButton>
          <IconButton
            label="이전 곡"
            disabled={!track}
            onClick={() => command({ type: 'previous' })}
          >
            <SkipBack fill="currentColor" />
          </IconButton>
          <IconButton
            className="taskbar-mode__play"
            label={player?.isPlaying ? '일시정지' : '재생'}
            disabled={!track}
            onClick={() => command({ type: 'toggle' })}
          >
            {player?.isPlaying ? (
              <Pause fill="currentColor" />
            ) : (
              <Play fill="currentColor" />
            )}
          </IconButton>
          <IconButton
            label="다음 곡"
            disabled={!track}
            onClick={() => command({ type: 'next' })}
          >
            <SkipForward fill="currentColor" />
          </IconButton>
          <IconButton
            label={`반복: ${player?.repeatMode ?? 'off'}`}
            active={player?.repeatMode !== 'off'}
            disabled={!player?.queue.length}
            onClick={() => command({ type: 'cycle-repeat' })}
          >
            {player?.repeatMode === 'one' ? <Repeat1 /> : <Repeat />}
          </IconButton>
        </div>
        <div className="taskbar-mode__progress">
          <span>{formatTime(currentTime)}</span>
          <input
            aria-label="재생 위치"
            type="range"
            min="0"
            max={progressMax}
            step="0.1"
            value={currentTime}
            disabled={!track}
            onChange={(event) =>
              command({ type: 'seek', value: Number(event.target.value) })
            }
          />
          <span>{formatTime(player?.duration ?? 0)}</span>
        </div>
      </div>

      {lyrics?.hasSync && lyrics.currentLine && (
        <div
          className="taskbar-mode__lyrics"
          data-taskbar-lyrics-source={lyrics.source}
          title={lyricsTooltip}
          aria-label="현재 가사"
        >
          <strong key={lyrics.currentLine}>{lyrics.currentLine}</strong>
          {lyrics.nextLine && <span>{lyrics.nextLine}</span>}
        </div>
      )}

      <div className="taskbar-mode__tools">
        <IconButton
          label={player?.isMuted ? '음소거 해제' : '음소거'}
          onClick={() => command({ type: 'toggle-mute' })}
        >
          {player?.isMuted || player?.volume === 0 ? <VolumeX /> : <Volume2 />}
        </IconButton>
        <input
          aria-label="볼륨"
          className="taskbar-mode__volume"
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={player?.isMuted ? 0 : (player?.volume ?? 0.8)}
          onChange={(event) =>
            command({ type: 'set-volume', value: Number(event.target.value) })
          }
        />
        <IconButton
          label="재생 큐 열기"
          onClick={() => void window.electronAPI.openMainQueue()}
        >
          <ListMusic />
        </IconButton>
        <IconButton
          label="Pulse Shelf 열기"
          onClick={() => void window.electronAPI.showMainWindow()}
        >
          <Maximize2 />
        </IconButton>
        <IconButton
          className="taskbar-mode__windows"
          label="Windows 작업표시줄로 돌아가기"
          title="Windows 작업표시줄로 돌아가기"
          onClick={() => void action('show-windows')}
        >
          <Minus />
        </IconButton>
      </div>
    </main>
  )
}

export function TaskbarToggle() {
  const { action, setModeState } = useTaskbarRuntime()
  const dragPointer = useRef<number | null>(null)
  const dragged = useRef(false)
  const dragStartX = useRef(0)

  const startDrag = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    dragPointer.current = event.pointerId
    dragged.current = false
    dragStartX.current = event.screenX
    event.currentTarget.setPointerCapture(event.pointerId)
    void window.electronAPI.startTaskbarToggleDrag(event.screenX)
  }
  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    if (dragPointer.current !== event.pointerId) return
    if (Math.abs(event.screenX - dragStartX.current) > 3) dragged.current = true
    window.electronAPI.moveTaskbarToggleDrag(event.screenX)
  }
  const endDrag = (
    event: PointerEvent<HTMLElement>,
    openWhenStationary = true,
  ) => {
    if (dragPointer.current !== event.pointerId) return
    dragPointer.current = null
    const shouldOpen = openWhenStationary && !dragged.current
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    const finished = window.electronAPI.endTaskbarToggleDrag(event.screenX)
    if (shouldOpen) void finished.then(() => action('show-pulse'))
    else void finished.then(setModeState)
    dragged.current = false
  }

  return (
    <main
      className="taskbar-toggle"
      aria-label="Pulse Shelf 작업표시줄 열기"
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={(event) => endDrag(event, false)}
    >
      <IconButton
        label="Pulse Shelf 작업표시줄 열기"
        title="Pulse Shelf 작업표시줄 열기"
        onClick={(event) => {
          if (event.detail === 0) void action('show-pulse')
        }}
      >
        <Plus />
      </IconButton>
    </main>
  )
}
