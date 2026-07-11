import { Clock3, Heart, ListMusic, MoreHorizontal, Play } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AlbumCover } from '../components/common/AlbumCover'
import { EmptyState } from '../components/common/EmptyState'
import { IconButton } from '../components/common/IconButton'
import { tracksForPlaylist, useAppStore } from '../stores/appStore'
import { usePlayerStore } from '../stores/playerStore'
import { formatRelativeDate } from '../utils/format'

function useHomeLimits() {
  const [isWide, setIsWide] = useState(() => window.innerWidth >= 1600)

  useEffect(() => {
    const updateLayout = () => setIsWide(window.innerWidth >= 1600)
    window.addEventListener('resize', updateLayout)
    return () => window.removeEventListener('resize', updateLayout)
  }, [])

  return isWide ? { recent: 6, playlists: 5 } : { recent: 4, playlists: 4 }
}

export function HomePage() {
  const data = useAppStore((state) => state.data)
  const addFolder = useAppStore((state) => state.addMusicFolder)
  const navigate = useAppStore((state) => state.navigate)
  const selectPlaylist = useAppStore((state) => state.selectPlaylist)
  const toggleLike = useAppStore((state) => state.toggleLike)
  const playTracks = usePlayerStore((state) => state.playTracks)
  const currentTrackId = usePlayerStore((state) => state.currentTrack?.id)
  const limits = useHomeLimits()

  if (!data) return null

  const trackMap = new Map(data.tracks.map((track) => [track.id, track]))
  const recent = data.recentTrackIds.flatMap((id) => {
    const track = trackMap.get(id)
    return track ? [track] : []
  })
  const visibleRecent = recent.slice(0, limits.recent)
  const visiblePlaylists = data.playlists.slice(0, limits.playlists)

  return (
    <div className="page home-page">
      <section className="content-section home-recent">
        <div className="section-heading">
          <h1>최근 재생</h1>
          {recent.length > 0 && (
            <button type="button" onClick={() => navigate('library')}>
              모두 보기
            </button>
          )}
        </div>
        {recent.length ? (
          <div className="cover-grid">
            {visibleRecent.map((track, index) => (
              <div
                className={`cover-item-wrap ${
                  currentTrackId === track.id ? 'is-current' : ''
                }`}
                key={track.id}
              >
                <button
                  type="button"
                  className="cover-item"
                  onClick={() => void playTracks(recent, index)}
                >
                  <AlbumCover src={track.coverUrl} alt={track.album} />
                  <span className="cover-item__play" aria-hidden="true">
                    <Play fill="currentColor" />
                  </span>
                  <strong title={track.title}>{track.title}</strong>
                  <span title={track.artist}>{track.artist}</span>
                </button>
                <IconButton
                  label={track.liked ? '좋아요 취소' : '좋아요'}
                  active={track.liked}
                  onClick={() => toggleLike(track.id)}
                >
                  <Heart fill={track.liked ? 'currentColor' : 'none'} />
                </IconButton>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={Clock3}
            title="최근 재생한 곡이 없습니다"
            description="라이브러리에 음악을 추가하고 첫 곡을 재생해 보세요."
            action={
              data.tracks.length
                ? {
                    label: '라이브러리 열기',
                    onClick: () => navigate('library'),
                  }
                : { label: '음악 폴더 추가', onClick: () => void addFolder() }
            }
          />
        )}
      </section>

      <section className="content-section home-playlists">
        <div className="section-heading">
          <h2>플레이리스트</h2>
          <button type="button" onClick={() => navigate('playlists')}>
            모두 보기
          </button>
        </div>
        {data.playlists.length ? (
          <div className="playlist-list">
            {visiblePlaylists.map((playlist) => {
              const tracks = tracksForPlaylist(data, playlist)
              return (
                <div className="home-playlist-row" key={playlist.id}>
                  <button
                    type="button"
                    className="playlist-item"
                    onClick={() => selectPlaylist(playlist.id)}
                  >
                    <AlbumCover src={tracks[0]?.coverUrl} alt={playlist.name} />
                    <span>
                      <strong title={playlist.name}>{playlist.name}</strong>
                      <small>
                        {tracks.length}곡 ·{' '}
                        {formatRelativeDate(playlist.updatedAt)}
                      </small>
                    </span>
                  </button>
                  <details className="home-playlist-menu">
                    <summary aria-label={`${playlist.name} 메뉴`}>
                      <MoreHorizontal />
                    </summary>
                    <div>
                      <button
                        type="button"
                        onClick={() => selectPlaylist(playlist.id)}
                      >
                        열기
                      </button>
                      <button
                        type="button"
                        disabled={!tracks.length}
                        onClick={() => void playTracks(tracks)}
                      >
                        재생
                      </button>
                    </div>
                  </details>
                </div>
              )
            })}
          </div>
        ) : (
          <EmptyState
            icon={ListMusic}
            title="플레이리스트가 없습니다"
            description="자주 듣는 곡을 모아 보세요."
            action={{
              label: '첫 플레이리스트 만들기',
              onClick: () => navigate('playlists'),
            }}
          />
        )}
      </section>
    </div>
  )
}
