import {
  ChevronDown,
  ChevronUp,
  Ellipsis,
  FolderOpen,
  Heart,
  Info,
  ListEnd,
  ListPlus,
  Library,
  Play,
  Trash2,
} from 'lucide-react'
import { useState } from 'react'
import type { Track, TrackRemovalDetails } from '../../types/models'
import { formatTime } from '../../utils/format'
import { useAppStore } from '../../stores/appStore'
import { usePlayerStore } from '../../stores/playerStore'
import { AlbumCover } from '../common/AlbumCover'
import { IconButton } from '../common/IconButton'

interface TrackListProps {
  tracks: Track[]
  playlistId?: string
  hideAlbum?: boolean
  selectable?: boolean
  allowLibraryRemoval?: boolean
}

export function TrackList({
  tracks,
  playlistId,
  hideAlbum = false,
  selectable = true,
  allowLibraryRemoval = false,
}: TrackListProps) {
  const playlists = useAppStore((state) => state.data?.playlists ?? [])
  const toggleLike = useAppStore((state) => state.toggleLike)
  const addTrack = useAppStore((state) => state.addTrackToPlaylist)
  const addTracks = useAppStore((state) => state.addTracksToPlaylist)
  const removeTrack = useAppStore((state) => state.removeTrackFromPlaylist)
  const moveTrack = useAppStore((state) => state.movePlaylistTrack)
  const removeFromLibrary = useAppStore((state) => state.removeTrackFromLibrary)
  const trashTrack = useAppStore((state) => state.trashTrack)
  const pendingTrackIds = useAppStore((state) => state.pendingTrackIds)
  const player = usePlayerStore()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkPlaylist, setBulkPlaylist] = useState('')
  const [infoTrack, setInfoTrack] = useState<Track | null>(null)
  const [removal, setRemoval] = useState<{
    track: Track
    mode: 'library' | 'trash'
  } | null>(null)
  const [removalDetails, setRemovalDetails] =
    useState<TrackRemovalDetails | null>(null)

  const visibleIds = new Set(tracks.map((track) => track.id))
  const validSelected = new Set(
    [...selected].filter((id) => visibleIds.has(id)),
  )
  const selectedTracks = tracks.filter((track) => validSelected.has(track.id))
  const toggleSelected = (trackId: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(trackId)) next.delete(trackId)
      else next.add(trackId)
      return next
    })

  const openRemoval = (track: Track, mode: 'library' | 'trash') => {
    setRemoval({ track, mode })
    setRemovalDetails(null)
    if (mode === 'trash') {
      void window.electronAPI
        .getTrackRemovalDetails(track.id)
        .then(setRemovalDetails)
        .catch(() =>
          setRemovalDetails({
            fileName: track.fileName,
            folderName: '등록된 음악 폴더',
          }),
        )
    }
  }

  const confirmRemoval = async () => {
    if (!removal) return
    const succeeded =
      removal.mode === 'library'
        ? await removeFromLibrary(removal.track.id)
        : await trashTrack(removal.track.id)
    if (succeeded) setRemoval(null)
  }

  return (
    <>
      {selectable && validSelected.size > 0 && (
        <div
          className="bulk-actions"
          role="toolbar"
          aria-label="선택한 곡 작업"
        >
          <strong>{validSelected.size}곡 선택</strong>
          <button
            type="button"
            className="button"
            onClick={() => player.addToQueue(selectedTracks)}
          >
            <ListPlus /> 큐에 추가
          </button>
          <select
            aria-label="추가할 플레이리스트"
            value={bulkPlaylist}
            onChange={(event) => setBulkPlaylist(event.target.value)}
          >
            <option value="">플레이리스트 선택</option>
            {playlists.map((playlist) => (
              <option key={playlist.id} value={playlist.id}>
                {playlist.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="button"
            disabled={!bulkPlaylist}
            onClick={() => {
              addTracks(
                bulkPlaylist,
                selectedTracks.map((track) => track.id),
              )
              setSelected(new Set())
            }}
          >
            추가
          </button>
          <button
            type="button"
            className="button"
            onClick={() => setSelected(new Set())}
          >
            선택 해제
          </button>
        </div>
      )}
      <div className="track-table" role="table" aria-label="곡 목록">
        <div className="track-row track-row--header" role="row">
          <span>
            {selectable ? (
              <input
                type="checkbox"
                aria-label="표시된 곡 전체 선택"
                checked={
                  tracks.length > 0 && validSelected.size === tracks.length
                }
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? new Set(tracks.map((track) => track.id))
                      : new Set(),
                  )
                }
              />
            ) : (
              '#'
            )}
          </span>
          <span>곡</span>
          {!hideAlbum && <span>앨범</span>}
          <span className="track-duration">시간</span>
          <span aria-label="작업" />
        </div>
        {tracks.map((track, index) => (
          <div
            className={`track-row ${hideAlbum ? 'track-row--compact' : ''} ${player.currentTrack?.id === track.id ? 'is-current' : ''}`}
            role="row"
            key={track.id}
          >
            <span className="track-number">
              {selectable ? (
                <input
                  type="checkbox"
                  aria-label={`${track.title} 선택`}
                  checked={validSelected.has(track.id)}
                  onChange={() => toggleSelected(track.id)}
                />
              ) : player.currentTrack?.id === track.id ? (
                '▶'
              ) : (
                index + 1
              )}
            </span>
            <button
              type="button"
              className="track-main"
              onClick={() => void player.playTracks(tracks, index)}
              title={`${track.title} - ${track.artist}`}
            >
              <AlbumCover src={track.coverUrl} alt={track.album} />
              <span className="track-copy">
                <strong>{track.title}</strong>
                <span>{track.artist}</span>
              </span>
            </button>
            {!hideAlbum && (
              <span className="track-album" title={track.album}>
                {track.album}
              </span>
            )}
            <span className="track-duration">{formatTime(track.duration)}</span>
            <span className="track-actions">
              <IconButton
                label={track.liked ? '좋아요 취소' : '좋아요'}
                active={track.liked}
                onClick={() => toggleLike(track.id)}
              >
                <Heart fill={track.liked ? 'currentColor' : 'none'} />
              </IconButton>
              {playlistId && (
                <>
                  <IconButton
                    label="한 칸 위로"
                    disabled={index === 0}
                    onClick={() => moveTrack(playlistId, track.id, -1)}
                  >
                    <ChevronUp />
                  </IconButton>
                  <IconButton
                    label="한 칸 아래로"
                    disabled={index === tracks.length - 1}
                    onClick={() => moveTrack(playlistId, track.id, 1)}
                  >
                    <ChevronDown />
                  </IconButton>
                  <IconButton
                    label="플레이리스트에서 제거"
                    onClick={() => removeTrack(playlistId, track.id)}
                  >
                    <Trash2 />
                  </IconButton>
                </>
              )}
              <details className="action-menu">
                <summary aria-label={`${track.title} 곡 메뉴`} title="곡 메뉴">
                  <Ellipsis aria-hidden="true" />
                </summary>
                <div className="action-menu__items">
                  <button
                    type="button"
                    onClick={() => void player.playTracks([track])}
                  >
                    <Play /> 지금 재생
                  </button>
                  <button type="button" onClick={() => player.playNext(track)}>
                    <ListEnd /> 다음에 재생
                  </button>
                  <button
                    type="button"
                    onClick={() => player.addToQueue(track)}
                  >
                    <ListPlus /> 큐에 추가
                  </button>
                  <button type="button" onClick={() => toggleLike(track.id)}>
                    <Heart /> {track.liked ? '좋아요 취소' : '좋아요'}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void window.electronAPI.revealTrack(track.id)
                    }
                  >
                    <FolderOpen /> 파일 위치 열기
                  </button>
                  <button type="button" onClick={() => setInfoTrack(track)}>
                    <Info /> 곡 정보
                  </button>
                  <strong>
                    <ListPlus aria-hidden="true" /> 플레이리스트에 추가
                  </strong>
                  {playlists.length ? (
                    playlists.map((playlist) => (
                      <button
                        type="button"
                        key={playlist.id}
                        onClick={() => addTrack(playlist.id, track.id)}
                      >
                        {playlist.name}
                      </button>
                    ))
                  ) : (
                    <span>먼저 플레이리스트를 만드세요.</span>
                  )}
                  {allowLibraryRemoval && (
                    <>
                      <div
                        className="action-menu__separator"
                        role="separator"
                      />
                      <button
                        type="button"
                        onClick={() => openRemoval(track, 'library')}
                        disabled={pendingTrackIds.includes(track.id)}
                      >
                        <Library /> 라이브러리에서 제거
                      </button>
                      <button
                        type="button"
                        className="action-menu__danger"
                        onClick={() => openRemoval(track, 'trash')}
                        disabled={pendingTrackIds.includes(track.id)}
                      >
                        <Trash2 /> 파일을 휴지통으로 이동
                      </button>
                    </>
                  )}
                </div>
              </details>
            </span>
          </div>
        ))}
      </div>
      {infoTrack && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => setInfoTrack(null)}
        >
          <div
            className="modal track-info-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="track-info-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="track-info-title">곡 정보</h2>
            <dl>
              <div>
                <dt>제목</dt>
                <dd>{infoTrack.title}</dd>
              </div>
              <div>
                <dt>아티스트</dt>
                <dd>{infoTrack.artist}</dd>
              </div>
              <div>
                <dt>앨범</dt>
                <dd>{infoTrack.album}</dd>
              </div>
              <div>
                <dt>파일</dt>
                <dd>{infoTrack.fileName}</dd>
              </div>
              <div>
                <dt>형식</dt>
                <dd>{infoTrack.format.toUpperCase()}</dd>
              </div>
              <div>
                <dt>재생 시간</dt>
                <dd>{formatTime(infoTrack.duration)}</dd>
              </div>
            </dl>
            <div>
              <button
                type="button"
                className="button"
                onClick={() => setInfoTrack(null)}
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      )}
      {removal && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => setRemoval(null)}
        >
          <div
            className="modal track-removal-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="track-removal-title"
            data-testid="track-removal-dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="track-removal-title">
              {removal.mode === 'library'
                ? '라이브러리에서 제거할까요?'
                : '파일을 휴지통으로 이동할까요?'}
            </h2>
            {removal.mode === 'library' ? (
              <p>
                음악 파일은 PC에 그대로 유지됩니다. 폴더를 다시 검색해도
                자동으로 다시 추가되지 않습니다.
              </p>
            ) : (
              <>
                <p>
                  이 곡을 라이브러리에서 제거하고 실제 음악 파일을 Windows
                  휴지통으로 이동합니다.
                </p>
                <dl>
                  <div>
                    <dt>곡</dt>
                    <dd>{removal.track.title}</dd>
                  </div>
                  <div>
                    <dt>아티스트</dt>
                    <dd>{removal.track.artist}</dd>
                  </div>
                  <div>
                    <dt>파일</dt>
                    <dd>
                      {removalDetails?.fileName ?? removal.track.fileName}
                    </dd>
                  </div>
                  <div>
                    <dt>음악 폴더</dt>
                    <dd>{removalDetails?.folderName ?? '확인 중…'}</dd>
                  </div>
                </dl>
              </>
            )}
            {player.currentTrack?.id === removal.track.id && (
              <p className="track-removal-modal__warning">
                현재 재생 중인 곡입니다. 제거 후 다음 곡으로 전환되며, 다음 곡이
                없으면 재생이 중지됩니다.
              </p>
            )}
            <div>
              <button
                type="button"
                className="button"
                disabled={pendingTrackIds.includes(removal.track.id)}
                onClick={() => setRemoval(null)}
              >
                취소
              </button>
              <button
                type="button"
                className={
                  removal.mode === 'trash'
                    ? 'button button--danger'
                    : 'button button--primary'
                }
                disabled={pendingTrackIds.includes(removal.track.id)}
                onClick={() => void confirmRemoval()}
              >
                {pendingTrackIds.includes(removal.track.id)
                  ? '처리 중…'
                  : removal.mode === 'library'
                    ? '라이브러리에서 제거'
                    : '휴지통으로 이동'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
