import {
  ArrowLeft,
  FolderPlus,
  Library,
  Play,
  RefreshCw,
  Search,
  Shuffle,
  Square,
} from 'lucide-react'
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { AlbumCover } from '../components/common/AlbumCover'
import { EmptyState } from '../components/common/EmptyState'
import { TrackList } from '../components/library/TrackList'
import {
  useAppStore,
  type LibraryDetail,
  type LibrarySort,
} from '../stores/appStore'
import { usePlayerStore } from '../stores/playerStore'
import type { Track } from '../types/models'

const PAGE_SIZE = 200

export function LibraryPage() {
  const data = useAppStore((state) => state.data)
  const isScanning = useAppStore((state) => state.isScanning)
  const progress = useAppStore((state) => state.scanProgress)
  const addFolder = useAppStore((state) => state.addMusicFolder)
  const rescan = useAppStore((state) => state.rescan)
  const cancelScan = useAppStore((state) => state.cancelScan)
  const query = useAppStore((state) => state.libraryQuery)
  const setQuery = useAppStore((state) => state.setLibraryQuery)
  const tab = useAppStore((state) => state.libraryTab)
  const setTab = useAppStore((state) => state.setLibraryTab)
  const sort = useAppStore((state) => state.librarySort)
  const setSort = useAppStore((state) => state.setLibrarySort)
  const detail = useAppStore((state) => state.libraryDetail)
  const setDetail = useAppStore((state) => state.setLibraryDetail)
  const playTracks = usePlayerStore((state) => state.playTracks)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const deferredQuery = useDeferredValue(query)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const focus = () => searchRef.current?.focus()
    window.addEventListener('pulse:focus-search', focus)
    return () => window.removeEventListener('pulse:focus-search', focus)
  }, [])

  const sorted = useMemo(() => {
    if (!data) return []
    const normalized = deferredQuery.trim().toLocaleLowerCase()
    const filtered = data.tracks.filter((track) =>
      [track.title, track.artist, track.album, track.fileName].some((value) =>
        value.toLocaleLowerCase().includes(normalized),
      ),
    )
    return [...filtered].sort((a, b) => compareTracks(a, b, sort))
  }, [data, deferredQuery, sort])

  if (!data) return null

  if (detail) {
    const detailTracks = tracksForDetail(data.tracks, detail)
    if (detailTracks.length) {
      const title =
        detail.type === 'artist' ? detail.key : detailTracks[0].album
      const subtitle =
        detail.type === 'artist'
          ? `${new Set(detailTracks.map((track) => `${track.album}\u0000${track.artist}`)).size}개 앨범 · ${detailTracks.length}곡`
          : `${detailTracks[0].artist} · ${detailTracks.length}곡`
      return (
        <div className="page library-detail">
          <button
            type="button"
            className="back-button"
            onClick={() => setDetail(null)}
          >
            <ArrowLeft /> 라이브러리로 돌아가기
          </button>
          <header className="playlist-hero">
            <AlbumCover src={detailTracks[0].coverUrl} alt={title} />
            <div>
              <h1>{title}</h1>
              <p>{subtitle}</p>
              <div className="page-actions">
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => void playTracks(detailTracks)}
                >
                  <Play fill="currentColor" />
                  전체 재생
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => void playTracks(detailTracks, 0, true)}
                >
                  <Shuffle />
                  셔플 재생
                </button>
              </div>
            </div>
          </header>
          <TrackList
            tracks={detailTracks}
            hideAlbum={detail.type === 'album'}
            allowLibraryRemoval
          />
        </div>
      )
    }
    return (
      <div className="page library-detail">
        <button
          type="button"
          className="back-button"
          onClick={() => setDetail(null)}
        >
          <ArrowLeft /> 라이브러리로 돌아가기
        </button>
        <EmptyState
          icon={Library}
          title="이 항목의 곡이 없습니다"
          description="파일이 이동되거나 라이브러리에서 제거되었습니다."
        />
      </div>
    )
  }

  return (
    <div className="page library-page">
      <header className="page-header">
        <div>
          <h1>라이브러리</h1>
          <p>
            {data.tracks.length}곡 · {data.musicFolders.length}개 폴더
          </p>
        </div>
        <div className="page-actions">
          {isScanning ? (
            <button
              type="button"
              className="button button--danger"
              onClick={cancelScan}
            >
              <Square fill="currentColor" />
              검색 취소
            </button>
          ) : (
            <button
              type="button"
              className="button"
              onClick={() => void rescan()}
              disabled={!data.musicFolders.length}
            >
              <RefreshCw />
              다시 검색
            </button>
          )}
          <button
            type="button"
            className="button button--primary"
            onClick={() => void addFolder()}
            disabled={isScanning}
          >
            <FolderPlus />
            폴더 추가
          </button>
        </div>
      </header>
      {isScanning && <ScanStatus progress={progress} />}
      <div className="library-toolbar">
        <label className="search-input">
          <Search aria-hidden="true" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setVisibleCount(PAGE_SIZE)
            }}
            placeholder="곡, 앨범, 아티스트, 파일명 검색"
            aria-label="라이브러리 검색"
          />
        </label>
        <div className="tabs" role="tablist" aria-label="라이브러리 보기">
          {(
            [
              ['tracks', '곡'],
              ['albums', '앨범'],
              ['artists', '아티스트'],
            ] as const
          ).map(([value, label]) => (
            <button
              type="button"
              role="tab"
              key={value}
              aria-selected={tab === value}
              onClick={() => {
                setTab(value)
                setVisibleCount(PAGE_SIZE)
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="sort-select">
          정렬
          <select
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as LibrarySort)
              setVisibleCount(PAGE_SIZE)
            }}
          >
            <option value="title">곡 제목</option>
            <option value="artist">아티스트</option>
            <option value="album">앨범</option>
            <option value="added">최근 추가</option>
            <option value="recent">최근 재생</option>
            <option value="plays">재생 횟수</option>
            <option value="duration">재생 시간</option>
          </select>
        </label>
      </div>
      {!data.tracks.length ? (
        <EmptyState
          icon={Library}
          title="음악 라이브러리가 비어 있습니다"
          description="MP3, FLAC, WAV, M4A 또는 OGG 파일이 있는 폴더를 추가하세요."
          action={{ label: '음악 폴더 추가', onClick: () => void addFolder() }}
        />
      ) : !sorted.length ? (
        <EmptyState
          icon={Search}
          title="검색 결과가 없습니다"
          description="다른 검색어로 다시 찾아보세요."
        />
      ) : tab === 'tracks' ? (
        <>
          <TrackList
            tracks={sorted.slice(0, visibleCount)}
            allowLibraryRemoval
          />
          {visibleCount < sorted.length && (
            <button
              type="button"
              className="button load-more"
              onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
            >
              다음 {Math.min(PAGE_SIZE, sorted.length - visibleCount)}곡 표시
            </button>
          )}
        </>
      ) : (
        <GroupView
          tracks={sorted}
          groupBy={tab === 'albums' ? 'album' : 'artist'}
          onOpen={setDetail}
          onPlay={(tracks) => void playTracks(tracks)}
        />
      )}
    </div>
  )
}

function compareTracks(a: Track, b: Track, sort: LibrarySort): number {
  if (sort === 'added') return b.addedAt - a.addedAt
  if (sort === 'recent') return (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0)
  if (sort === 'plays') return b.playCount - a.playCount
  if (sort === 'duration') return b.duration - a.duration
  return a[sort].localeCompare(b[sort], 'ko')
}

function tracksForDetail(tracks: Track[], detail: LibraryDetail): Track[] {
  return tracks
    .filter((track) =>
      detail.type === 'artist'
        ? track.artist === detail.key
        : `${track.album}\u0000${track.artist}` === detail.key,
    )
    .sort(
      (a, b) =>
        (a.discNumber ?? 1) - (b.discNumber ?? 1) ||
        (a.trackNumber ?? 9999) - (b.trackNumber ?? 9999) ||
        a.title.localeCompare(b.title, 'ko'),
    )
}

function GroupView({
  tracks,
  groupBy,
  onOpen,
  onPlay,
}: {
  tracks: Track[]
  groupBy: 'album' | 'artist'
  onOpen: (detail: LibraryDetail) => void
  onPlay: (tracks: Track[]) => void
}) {
  const groups = new Map<string, Track[]>()
  tracks.forEach((track) => {
    const key =
      groupBy === 'album' ? `${track.album}\u0000${track.artist}` : track.artist
    const group = groups.get(key)
    if (group) group.push(track)
    else groups.set(key, [track])
  })
  return (
    <div className="group-grid">
      {[...groups.entries()].map(([key, groupTracks]) => {
        const name = groupBy === 'album' ? groupTracks[0].album : key
        const albumCount = new Set(
          groupTracks.map((track) => `${track.album}\u0000${track.artist}`),
        ).size
        return (
          <div className="group-item" key={key}>
            <button
              type="button"
              className="group-item__main"
              onClick={() => onOpen({ type: groupBy, key })}
            >
              <AlbumCover src={groupTracks[0].coverUrl} alt={name} />
              <span>
                <strong title={name}>{name}</strong>
                <small>
                  {groupBy === 'album'
                    ? `${groupTracks[0].artist} · ${groupTracks.length}곡`
                    : `${albumCount}개 앨범 · ${groupTracks.length}곡`}
                </small>
              </span>
            </button>
            <button
              type="button"
              className="group-item__play"
              aria-label={`${name} 전체 재생`}
              title="전체 재생"
              onClick={() => onPlay(groupTracks)}
            >
              <Play fill="currentColor" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

function ScanStatus({
  progress,
}: {
  progress: ReturnType<typeof useAppStore.getState>['scanProgress']
}) {
  const percent = progress?.total
    ? Math.round((progress.processed / progress.total) * 100)
    : 0
  const label =
    progress?.phase === 'discovering'
      ? '음악 파일 찾는 중'
      : progress?.phase === 'finishing'
        ? '라이브러리 정리 중'
        : '메타데이터 읽는 중'
  return (
    <div className="scan-status" role="status" aria-live="polite">
      <div>
        <strong>{label}</strong>
        <span>{progress?.currentFile || '준비 중…'}</span>
        <span>
          {progress?.phase === 'discovering'
            ? `${progress.discovered}개 발견`
            : `${progress?.processed ?? 0} / ${progress?.total ?? 0}`}
        </span>
      </div>
      <progress max="100" value={percent} aria-label="검색 진행률" />
    </div>
  )
}
