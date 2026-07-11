import {
  ChevronDown,
  ChevronUp,
  Heart,
  ListEnd,
  ListMusic,
  Music,
  PanelRightClose,
  Play,
  Shuffle,
  Trash2,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import { usePlayerStore } from '../../stores/playerStore'
import { formatTime } from '../../utils/format'
import { AlbumCover } from '../common/AlbumCover'
import { EmptyState } from '../common/EmptyState'
import { IconButton } from '../common/IconButton'
import { LyricsView } from './LyricsView'

type PanelTab = 'queue' | 'lyrics' | 'info'

export function NowPlayingPanel() {
  const [tab, setTab] = useState<PanelTab>('queue')
  const open = useAppStore((state) => state.nowPlayingOpen)
  const close = useAppStore((state) => state.setNowPlayingOpen)
  const data = useAppStore((state) => state.data)
  const toggleLike = useAppStore((state) => state.toggleLike)
  const player = usePlayerStore()
  const currentTrack =
    data?.tracks.find((track) => track.id === player.currentTrack?.id) ??
    player.currentTrack

  useEffect(() => {
    const setRequestedTab = (event: Event) => {
      const detail = (event as CustomEvent<PanelTab>).detail
      if (['queue', 'lyrics', 'info'].includes(detail)) setTab(detail)
    }
    window.addEventListener('pulse:panel-tab', setRequestedTab)
    return () => window.removeEventListener('pulse:panel-tab', setRequestedTab)
  }, [])

  return (
    <aside
      className={`now-panel ${open ? 'is-open' : ''}`}
      aria-label="현재 재생 패널"
      aria-hidden={!open}
    >
      <div className="now-panel__header">
        <h2>현재 재생</h2>
        <IconButton label="현재 재생 패널 닫기" onClick={() => close(false)}>
          <PanelRightClose />
        </IconButton>
      </div>
      <div className="now-panel__cover-frame">
        {currentTrack?.coverUrl && (
          <img
            className="now-panel__cover-backdrop"
            src={currentTrack.coverUrl}
            alt=""
            aria-hidden="true"
          />
        )}
        <AlbumCover
          className="now-panel__cover"
          src={currentTrack?.coverUrl}
          alt={currentTrack?.album ?? '현재 재생곡'}
        />
      </div>
      <div className="now-panel__track">
        <div>
          <strong title={currentTrack?.title}>
            {currentTrack?.title ?? '재생 중인 곡 없음'}
          </strong>
          <span>
            {currentTrack?.artist ?? '곡을 선택하면 여기에 표시됩니다.'}
          </span>
          {currentTrack && <span>{currentTrack.album}</span>}
        </div>
        <IconButton
          label={currentTrack?.liked ? '좋아요 취소' : '좋아요'}
          active={currentTrack?.liked}
          disabled={!currentTrack}
          onClick={() => currentTrack && toggleLike(currentTrack.id)}
        >
          <Heart fill={currentTrack?.liked ? 'currentColor' : 'none'} />
        </IconButton>
      </div>
      <div
        className="tabs tabs--panel"
        role="tablist"
        aria-label="현재 재생 정보"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'queue'}
          onClick={() => setTab('queue')}
        >
          재생 큐
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'lyrics'}
          onClick={() => setTab('lyrics')}
        >
          가사
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'info'}
          onClick={() => setTab('info')}
        >
          곡 정보
        </button>
      </div>
      <div className="now-panel__body">
        {tab === 'queue' &&
          (player.queue.length ? (
            <>
              <div className="queue-toolbar">
                <button
                  type="button"
                  className="button"
                  onClick={() => void player.playQueueIndex(0)}
                >
                  <Play fill="currentColor" />
                  처음부터
                </button>
                <IconButton
                  label="셔플 켜기 또는 끄기"
                  active={player.shuffle}
                  onClick={player.toggleShuffle}
                >
                  <Shuffle />
                </IconButton>
                <IconButton
                  label="재생 큐 전체 비우기"
                  onClick={player.clearQueue}
                >
                  <Trash2 />
                </IconButton>
              </div>
              <div className="queue-list">
                {player.queue.map((track, index) => (
                  <div
                    className={
                      index === player.currentIndex ? 'is-current' : ''
                    }
                    key={`${track.id}-${index}`}
                  >
                    <button
                      type="button"
                      onClick={() => void player.playQueueIndex(index)}
                      title={track.title}
                    >
                      <span>
                        {index === player.currentIndex ? '▶' : index + 1}
                      </span>
                      <span>
                        <strong>{track.title}</strong>
                        <small>{track.artist}</small>
                      </span>
                      <span>{formatTime(track.duration)}</span>
                    </button>
                    <span className="queue-actions">
                      <IconButton
                        label="한 칸 위로"
                        disabled={index === 0}
                        onClick={() => player.moveQueueItem(index, -1)}
                      >
                        <ChevronUp />
                      </IconButton>
                      <IconButton
                        label="한 칸 아래로"
                        disabled={index === player.queue.length - 1}
                        onClick={() => player.moveQueueItem(index, 1)}
                      >
                        <ChevronDown />
                      </IconButton>
                      <IconButton
                        label="다음에 재생"
                        disabled={index === player.currentIndex}
                        onClick={() => player.moveQueueToNext(index)}
                      >
                        <ListEnd />
                      </IconButton>
                      <IconButton
                        label="재생 큐에서 제거"
                        onClick={() => player.removeFromQueue(index)}
                      >
                        <Trash2 />
                      </IconButton>
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <EmptyState
              icon={ListMusic}
              title="재생 큐가 비어 있습니다"
              description="라이브러리에서 곡을 재생해 보세요."
            />
          ))}
        {tab === 'lyrics' && <LyricsView />}
        {tab === 'info' &&
          (currentTrack ? (
            <dl className="track-info">
              <div>
                <dt>제목</dt>
                <dd>{currentTrack.title}</dd>
              </div>
              <div>
                <dt>아티스트</dt>
                <dd>{currentTrack.artist}</dd>
              </div>
              <div>
                <dt>앨범</dt>
                <dd>{currentTrack.album}</dd>
              </div>
              <div>
                <dt>파일</dt>
                <dd>{currentTrack.fileName}</dd>
              </div>
              <div>
                <dt>형식</dt>
                <dd>{currentTrack.format.toUpperCase()}</dd>
              </div>
              <div>
                <dt>재생 시간</dt>
                <dd>{formatTime(currentTrack.duration)}</dd>
              </div>
              {currentTrack.year && (
                <div>
                  <dt>연도</dt>
                  <dd>{currentTrack.year}</dd>
                </div>
              )}
              <div>
                <dt>재생 횟수</dt>
                <dd>{currentTrack.playCount}회</dd>
              </div>
            </dl>
          ) : (
            <EmptyState
              icon={Music}
              title="곡 정보가 없습니다"
              description="먼저 곡을 재생하세요."
            />
          ))}
      </div>
    </aside>
  )
}
