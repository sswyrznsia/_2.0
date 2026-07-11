import {
  ExternalLink,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { PlayerSnapshot } from '../../types/models'
import { formatTime } from '../../utils/format'
import { AlbumCover } from '../common/AlbumCover'
import { IconButton } from '../common/IconButton'

export function MiniPlayer() {
  const [player, setPlayer] = useState<PlayerSnapshot | null>(null)
  useEffect(() => {
    const unsubscribe = window.electronAPI.onPlayerSnapshot(setPlayer)
    void window.electronAPI.loadData().then((data) => {
      const theme =
        data.settings.theme === 'system'
          ? window.matchMedia('(prefers-color-scheme: light)').matches
            ? 'light'
            : 'dark'
          : data.settings.theme
      document.documentElement.dataset.theme = theme
    })
    return unsubscribe
  }, [])
  const send = (type: 'toggle' | 'next' | 'previous') =>
    window.electronAPI.sendPlayerCommand({ type })
  return (
    <main className="mini-player">
      <div className="mini-player__top">
        <span>Pulse Shelf</span>
        <div>
          <IconButton
            label="메인 창 열기"
            onClick={() => void window.electronAPI.showMainWindow()}
          >
            <ExternalLink />
          </IconButton>
          <IconButton
            label="미니 플레이어 닫기"
            onClick={() => void window.electronAPI.closeMiniPlayer()}
          >
            <X />
          </IconButton>
        </div>
      </div>
      <div className="mini-player__content">
        <AlbumCover
          src={player?.currentTrack?.coverUrl}
          alt={player?.currentTrack?.album ?? '현재 재생곡'}
        />
        <div className="mini-player__track">
          <strong title={player?.currentTrack?.title}>
            {player?.currentTrack?.title ?? '재생 중인 곡 없음'}
          </strong>
          <span>
            {player?.currentTrack?.artist ?? '메인 창에서 곡을 선택하세요.'}
          </span>
          <div>
            <IconButton
              label="이전 곡"
              disabled={!player?.currentTrack}
              onClick={() => send('previous')}
            >
              <SkipBack fill="currentColor" />
            </IconButton>
            <IconButton
              label={player?.isPlaying ? '일시정지' : '재생'}
              className="play-button"
              disabled={!player?.currentTrack}
              onClick={() => send('toggle')}
            >
              {player?.isPlaying ? (
                <Pause fill="currentColor" />
              ) : (
                <Play fill="currentColor" />
              )}
            </IconButton>
            <IconButton
              label="다음 곡"
              disabled={!player?.currentTrack}
              onClick={() => send('next')}
            >
              <SkipForward fill="currentColor" />
            </IconButton>
          </div>
        </div>
      </div>
      <div className="progress-control mini-player__progress">
        <span>{formatTime(player?.currentTime ?? 0)}</span>
        <input
          aria-label="재생 위치"
          type="range"
          min="0"
          max={Math.max(player?.duration ?? 0, 0.01)}
          value={Math.min(
            player?.currentTime ?? 0,
            Math.max(player?.duration ?? 0, 0.01),
          )}
          step="0.1"
          disabled={!player?.currentTrack}
          onChange={(event) =>
            window.electronAPI.sendPlayerCommand({
              type: 'seek',
              value: Number(event.target.value),
            })
          }
        />
        <span>{formatTime(player?.duration ?? 0)}</span>
      </div>
    </main>
  )
}
