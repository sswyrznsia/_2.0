import { ListMusic, Pencil, Play, Plus, Shuffle, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { AlbumCover } from '../components/common/AlbumCover'
import { EmptyState } from '../components/common/EmptyState'
import { IconButton } from '../components/common/IconButton'
import { TrackList } from '../components/library/TrackList'
import { tracksForPlaylist, useAppStore } from '../stores/appStore'
import { usePlayerStore } from '../stores/playerStore'
import { formatRelativeDate } from '../utils/format'

export function PlaylistsPage() {
  const data = useAppStore((state) => state.data)
  const selectedId = useAppStore((state) => state.selectedPlaylistId)
  const selectPlaylist = useAppStore((state) => state.selectPlaylist)
  const createPlaylist = useAppStore((state) => state.createPlaylist)
  const renamePlaylist = useAppStore((state) => state.renamePlaylist)
  const deletePlaylist = useAppStore((state) => state.deletePlaylist)
  const playTracks = usePlayerStore((state) => state.playTracks)
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  if (!data) return null
  const selected = data.playlists.find((playlist) => playlist.id === selectedId)

  const submitCreate = (event: React.FormEvent) => {
    event.preventDefault()
    const id = createPlaylist(name)
    if (id) {
      setName('')
      selectPlaylist(id)
    }
  }

  if (selected) {
    const tracks = tracksForPlaylist(data, selected)
    return (
      <div className="page playlist-detail">
        <button
          type="button"
          className="back-button"
          onClick={() => useAppStore.setState({ selectedPlaylistId: null })}
        >
          ← 모든 플레이리스트
        </button>
        <header className="playlist-hero">
          <AlbumCover src={tracks[0]?.coverUrl} alt={selected.name} />
          <div>
            {renaming ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  renamePlaylist(selected.id, name || selected.name)
                  setRenaming(false)
                }}
              >
                <input
                  autoFocus
                  aria-label="새 플레이리스트 이름"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
                <button className="button button--primary" type="submit">
                  저장
                </button>
                <button
                  className="button"
                  type="button"
                  onClick={() => setRenaming(false)}
                >
                  취소
                </button>
              </form>
            ) : (
              <h1>{selected.name}</h1>
            )}
            <p>
              {tracks.length}곡 · {formatRelativeDate(selected.updatedAt)}
            </p>
            <div className="page-actions">
              <button
                type="button"
                className="button button--primary"
                disabled={!tracks.length}
                onClick={() => void playTracks(tracks)}
              >
                <Play fill="currentColor" />
                전체 재생
              </button>
              <button
                type="button"
                className="button"
                disabled={!tracks.length}
                onClick={() => void playTracks(tracks, 0, true)}
              >
                <Shuffle />
                셔플 재생
              </button>
              <IconButton
                label="이름 변경"
                onClick={() => {
                  setName(selected.name)
                  setRenaming(true)
                }}
              >
                <Pencil />
              </IconButton>
              <IconButton
                label="플레이리스트 삭제"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 />
              </IconButton>
            </div>
          </div>
        </header>
        {tracks.length ? (
          <TrackList tracks={tracks} playlistId={selected.id} />
        ) : (
          <EmptyState
            icon={ListMusic}
            title="아직 곡이 없습니다"
            description="라이브러리의 곡 메뉴에서 이 플레이리스트에 추가하세요."
          />
        )}
        {deleteOpen && (
          <div
            className="modal-backdrop"
            role="presentation"
            onMouseDown={() => setDeleteOpen(false)}
          >
            <div
              className="modal"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="delete-title"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <h2 id="delete-title">플레이리스트를 삭제할까요?</h2>
              <p>“{selected.name}” 목록만 삭제되며 음악 파일은 유지됩니다.</p>
              <div>
                <button
                  type="button"
                  className="button"
                  onClick={() => setDeleteOpen(false)}
                >
                  취소
                </button>
                <button
                  type="button"
                  className="button button--danger"
                  onClick={() => {
                    deletePlaylist(selected.id)
                    setDeleteOpen(false)
                  }}
                >
                  삭제
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>플레이리스트</h1>
          <p>원하는 순서로 음악을 정리하세요.</p>
        </div>
      </header>
      <form className="create-playlist" onSubmit={submitCreate}>
        <label htmlFor="playlist-name">새 플레이리스트</label>
        <input
          id="playlist-name"
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          placeholder="이름을 입력하세요"
        />
        <button
          type="submit"
          className="button button--primary"
          disabled={!name.trim()}
        >
          <Plus />
          만들기
        </button>
      </form>
      {data.playlists.length ? (
        <div className="playlist-grid playlist-grid--large">
          {data.playlists.map((playlist) => {
            const tracks = tracksForPlaylist(data, playlist)
            return (
              <button
                type="button"
                className="playlist-item"
                key={playlist.id}
                onClick={() => selectPlaylist(playlist.id)}
              >
                <AlbumCover src={tracks[0]?.coverUrl} alt={playlist.name} />
                <span>
                  <strong>{playlist.name}</strong>
                  <small>
                    {tracks.length}곡 · {formatRelativeDate(playlist.updatedAt)}
                  </small>
                </span>
              </button>
            )
          })}
        </div>
      ) : (
        <EmptyState
          icon={ListMusic}
          title="플레이리스트가 없습니다"
          description="위 입력창에서 첫 플레이리스트를 만들어 보세요."
        />
      )}
    </div>
  )
}
