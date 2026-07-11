import {
  Expand,
  Heart,
  ListMusic,
  Maximize2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { usePlayerStore } from '../../stores/playerStore'
import { formatTime } from '../../utils/format'
import { AlbumCover } from '../common/AlbumCover'
import { IconButton } from '../common/IconButton'

export function PlayerBar() {
  const player = usePlayerStore()
  const data = useAppStore((state) => state.data)
  const toggleLike = useAppStore((state) => state.toggleLike)
  const setNowPlayingOpen = useAppStore((state) => state.setNowPlayingOpen)
  const currentTrack =
    data?.tracks.find((track) => track.id === player.currentTrack?.id) ??
    player.currentTrack
  const progressMax = Math.max(player.duration, 0.01)

  return (
    <footer className="player-bar">
      <div className="player-track">
        <AlbumCover
          src={currentTrack?.coverUrl}
          alt={currentTrack?.album ?? '현재 재생곡'}
        />
        <span className="player-track__copy">
          <strong title={currentTrack?.title}>
            {currentTrack?.title ?? '재생 중인 곡 없음'}
          </strong>
          <span title={currentTrack?.artist}>
            {currentTrack?.artist ?? '라이브러리에서 곡을 선택하세요'}
          </span>
        </span>
        <IconButton
          label={currentTrack?.liked ? '좋아요 취소' : '좋아요'}
          active={currentTrack?.liked}
          disabled={!currentTrack}
          onClick={() => currentTrack && toggleLike(currentTrack.id)}
        >
          <Heart fill={currentTrack?.liked ? 'currentColor' : 'none'} />
        </IconButton>
      </div>

      <div className="player-controls">
        <div className="player-controls__buttons">
          <IconButton
            label="셔플"
            active={player.shuffle}
            onClick={player.toggleShuffle}
            disabled={!player.queue.length}
          >
            <Shuffle />
          </IconButton>
          <IconButton
            label="이전 곡"
            onClick={() => void player.previous()}
            disabled={!player.currentTrack}
          >
            <SkipBack fill="currentColor" />
          </IconButton>
          <IconButton
            label={player.isPlaying ? '일시정지' : '재생'}
            className="play-button"
            onClick={() => void player.togglePlay()}
            disabled={!player.currentTrack}
          >
            {player.isPlaying ? (
              <Pause fill="currentColor" />
            ) : (
              <Play fill="currentColor" />
            )}
          </IconButton>
          <IconButton
            label="다음 곡"
            onClick={() => void player.next()}
            disabled={!player.currentTrack}
          >
            <SkipForward fill="currentColor" />
          </IconButton>
          <IconButton
            label={`반복: ${player.repeatMode === 'off' ? '없음' : player.repeatMode === 'one' ? '한 곡' : '전체'}`}
            active={player.repeatMode !== 'off'}
            onClick={player.cycleRepeat}
            disabled={!player.queue.length}
          >
            {player.repeatMode === 'one' ? <Repeat1 /> : <Repeat />}
          </IconButton>
        </div>
        <div className="progress-control">
          <span>{formatTime(player.currentTime)}</span>
          <input
            aria-label="재생 위치"
            type="range"
            min="0"
            max={progressMax}
            step="0.1"
            value={Math.min(player.currentTime, progressMax)}
            disabled={!player.currentTrack}
            onChange={(event) => player.seek(Number(event.target.value))}
          />
          <span>{formatTime(player.duration)}</span>
        </div>
      </div>

      <div className="player-tools">
        <IconButton
          label={player.isMuted ? '음소거 해제' : '음소거'}
          onClick={player.toggleMute}
        >
          {player.isMuted || player.volume === 0 ? <VolumeX /> : <Volume2 />}
        </IconButton>
        <input
          aria-label="볼륨"
          className="volume-slider"
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={player.isMuted ? 0 : player.volume}
          onChange={(event) => player.setVolume(Number(event.target.value))}
        />
        <IconButton
          label="재생 큐 열기"
          onClick={() => {
            setNowPlayingOpen(true)
            window.dispatchEvent(
              new CustomEvent('pulse:panel-tab', { detail: 'queue' }),
            )
          }}
        >
          <ListMusic />
        </IconButton>
        <IconButton
          label="미니 플레이어 열기"
          onClick={() => void window.electronAPI.openMiniPlayer()}
        >
          <Expand />
        </IconButton>
        <IconButton
          label="현재 재생 화면 열기"
          onClick={() => setNowPlayingOpen(true)}
        >
          <Maximize2 />
        </IconButton>
      </div>
    </footer>
  )
}
