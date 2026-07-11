import { FileText, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { usePlayerStore } from '../../stores/playerStore'
import type {
  LyricsCandidate,
  LyricsLookupStatus,
  LyricsResult,
  LyricsSearchResult,
  LyricsSyncProfile,
} from '../../types/models'
import { formatTime } from '../../utils/format'
import { parseLrc } from '../../utils/lyrics'
import { adjustLyricTimeMs } from '../../utils/lyricsSync'
import { EmptyState } from '../common/EmptyState'

const statusCopy: Record<LyricsLookupStatus, string> = {
  found: '가사를 찾았습니다.',
  'not-found': '검색 결과가 없습니다.',
  'low-confidence': '후보는 있지만 자동으로 적용하기에는 신뢰도가 낮습니다.',
  instrumental: '연주곡으로 표시된 곡입니다.',
  'network-error': 'LRCLIB에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  'rate-limited':
    'LRCLIB 요청이 일시적으로 제한되었습니다. 잠시 후 다시 시도해 주세요.',
  'metadata-missing': '검색할 제목 또는 아티스트 정보가 부족합니다.',
}

export function LyricsView() {
  const currentTrack = usePlayerStore((state) => state.currentTrack)
  if (!currentTrack)
    return (
      <EmptyState
        icon={FileText}
        title="가사 정보가 없습니다"
        description="먼저 곡을 재생해 주세요."
      />
    )
  return <LoadedLyrics key={currentTrack.id} trackId={currentTrack.id} />
}

function LoadedLyrics({ trackId }: { trackId: string }) {
  const currentTime = usePlayerStore((state) => state.currentTime)
  const currentTrack = usePlayerStore((state) => state.currentTrack)
  const [lyrics, setLyrics] = useState<LyricsResult | null>(null)
  const [searchResult, setSearchResult] = useState<LyricsSearchResult | null>(
    null,
  )
  const [searchTitle, setSearchTitle] = useState(currentTrack?.title ?? '')
  const [searchArtist, setSearchArtist] = useState(currentTrack?.artist ?? '')
  const [loading, setLoading] = useState(false)
  const [selectingCandidateId, setSelectingCandidateId] = useState<
    number | null
  >(null)
  const [savedSyncProfile, setSavedSyncProfile] =
    useState<LyricsSyncProfile | null>(null)
  const [draftSyncProfile, setDraftSyncProfile] = useState<LyricsSyncProfile>(
    { trackId, offsetMs: 0, anchors: [], updatedAt: 0 },
  )
  const [syncEditing, setSyncEditing] = useState(false)
  const [selectedLineIndex, setSelectedLineIndex] = useState(0)
  const lineRefs = useRef<Array<HTMLButtonElement | null>>([])
  const autoScrollPausedUntil = useRef(0)
  const loadRequestId = useRef(0)
  const selectingCandidateRef = useRef<number | null>(null)

  useEffect(() => {
    const requestId = ++loadRequestId.current
    let active = true
    void window.electronAPI
      .loadLyrics(trackId)
      .then((result) => {
        if (active && loadRequestId.current === requestId) setLyrics(result)
      })
      .catch(() => {
        if (active && loadRequestId.current === requestId)
          setLyrics({ kind: 'none', content: '', status: 'network-error' })
      })
    return () => {
      active = false
    }
  }, [trackId])

  useEffect(() => {
    let active = true
    void window.electronAPI
      .getLyricsSyncProfile(trackId)
      .then((profile) => {
        if (!active) return
        setSavedSyncProfile(profile)
        setDraftSyncProfile(
          profile ?? { trackId, offsetMs: 0, anchors: [], updatedAt: 0 },
        )
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [trackId])

  const rawLines = lyrics?.kind === 'lrc' ? parseLrc(lyrics.content) : []
  const activeSyncProfile = syncEditing ? draftSyncProfile : savedSyncProfile
  const lines = rawLines.map((line) => ({
    ...line,
    originalTimeMs: Math.round(line.time * 1_000),
    time:
      adjustLyricTimeMs(
        Math.round(line.time * 1_000),
        activeSyncProfile ?? undefined,
      ) / 1_000,
  }))
  const activeIndex = lines.reduce(
    (found, line, index) => (line.time <= currentTime + 0.05 ? index : found),
    -1,
  )
  useEffect(() => {
    if (activeIndex >= 0 && Date.now() >= autoScrollPausedUntil.current)
      lineRefs.current[activeIndex]?.scrollIntoView({
        block: 'center',
        behavior: 'smooth',
      })
  }, [activeIndex])

  const search = async (useCurrentMetadata = false) => {
    setLoading(true)
    try {
      const result = await window.electronAPI.searchLyrics(
        trackId,
        useCurrentMetadata
          ? undefined
          : { title: searchTitle, artist: searchArtist },
      )
      setSearchResult(result)
      if (useCurrentMetadata) {
        setSearchTitle(result.normalizedTitle || currentTrack?.title || '')
        setSearchArtist(result.originalArtist || currentTrack?.artist || '')
      }
    } catch {
      setSearchResult({
        status: 'network-error',
        candidates: [],
        normalizedTitle: '',
      })
    } finally {
      setLoading(false)
    }
  }

  const select = async (candidate: LyricsCandidate) => {
    if (selectingCandidateRef.current !== null) return
    if (
      savedSyncProfile &&
      !window.confirm(
        '새 가사 후보를 선택하면 기존 가사 싱크 보정이 초기화됩니다. 계속할까요?',
      )
    )
      return
    selectingCandidateRef.current = candidate.id
    setSelectingCandidateId(candidate.id)
    try {
      setLyrics(await window.electronAPI.saveLyricsSelection(trackId, candidate))
      setSavedSyncProfile(null)
      setDraftSyncProfile({ trackId, offsetMs: 0, anchors: [], updatedAt: 0 })
      setSearchResult(null)
    } finally {
      selectingCandidateRef.current = null
      setSelectingCandidateId(null)
    }
  }

  const markInstrumental = async () => {
    await window.electronAPI.markLyricsInstrumental(trackId)
    setLyrics({ kind: 'none', content: '', status: 'instrumental' })
    setSearchResult(null)
  }

  const updateDraftSync = (patch: Partial<LyricsSyncProfile>) => {
    setDraftSyncProfile((profile) => ({ ...profile, ...patch }))
  }
  const addSelectedAnchor = () => {
    const line = lines[selectedLineIndex]
    if (!line) return
    const anchor = {
      lyricTimeMs: line.originalTimeMs,
      audioTimeMs: Math.max(0, Math.round(currentTime * 1_000 - draftSyncProfile.offsetMs)),
    }
    const anchors = [
      ...draftSyncProfile.anchors.filter(
        (item) => item.lyricTimeMs !== anchor.lyricTimeMs,
      ),
      anchor,
    ].sort((left, right) => left.lyricTimeMs - right.lyricTimeMs)
    updateDraftSync({ anchors })
  }
  const saveSync = async () => {
    const saved = await window.electronAPI.saveLyricsSyncProfile({
      ...draftSyncProfile,
      updatedAt: Date.now(),
    })
    setSavedSyncProfile(saved)
    setDraftSyncProfile(saved)
    setSyncEditing(false)
  }
  const resetSync = async () => {
    await window.electronAPI.clearLyricsSyncProfile(trackId)
    const empty = { trackId, offsetMs: 0, anchors: [], updatedAt: 0 }
    setSavedSyncProfile(null)
    setDraftSyncProfile(empty)
    setSyncEditing(false)
  }

  if (!lyrics) return <div className="lyrics-loading">가사를 불러오는 중…</div>
  if (searchResult)
    return (
      <LyricsSearchPanel
        result={searchResult}
        loading={loading}
        searchTitle={searchTitle}
        searchArtist={searchArtist}
        onSearchTitleChange={setSearchTitle}
        onSearchArtistChange={setSearchArtist}
        onSearch={() => void search()}
        onCleanSearch={() => void search(true)}
        onSelect={(candidate) => void select(candidate)}
        selectingCandidateId={selectingCandidateId}
        onMarkInstrumental={() => void markInstrumental()}
        onClose={() => setSearchResult(null)}
      />
    )
  if (lyrics.kind === 'none' || (lyrics.kind === 'lrc' && !lines.length))
    return (
      <LyricsSearchPanel
        result={{
          status: lyrics.status ?? 'not-found',
          candidates: [],
          normalizedTitle: '',
        }}
        loading={loading}
        searchTitle={searchTitle}
        searchArtist={searchArtist}
        onSearchTitleChange={setSearchTitle}
        onSearchArtistChange={setSearchArtist}
        onSearch={() => void search()}
        onCleanSearch={() => void search(true)}
        onSelect={(candidate) => void select(candidate)}
        selectingCandidateId={selectingCandidateId}
        onMarkInstrumental={() => void markInstrumental()}
      />
    )
  if (lyrics.kind === 'text')
    return <div className="lyrics-text">{lyrics.content}</div>
  return (
    <div
      className="lyrics-synced"
      onWheel={() => {
        autoScrollPausedUntil.current = Date.now() + 4_000
      }}
      onPointerDown={() => {
        autoScrollPausedUntil.current = Date.now() + 4_000
      }}
    >
      <button
        type="button"
        className="lyrics-search-trigger"
        onClick={() => void search(true)}
        aria-label="가사 후보 검색"
      >
        <Search />
      </button>
      <div className="lyrics-sync-status">
        {syncStatusCopy(savedSyncProfile)}
        {(savedSyncProfile || syncEditing) && (
          <button type="button" onClick={() => void resetSync()}>
            초기화
          </button>
        )}
      </div>
      <button
        type="button"
        className="button lyrics-sync-trigger"
        onClick={() => setSyncEditing((value) => !value)}
      >
        가사 싱크 맞추기
      </button>
      {syncEditing && (
        <div className="lyrics-sync-editor">
          <strong>선택 줄: {lines[selectedLineIndex]?.text || '가사 줄을 선택하세요'}</strong>
          <span>현재 재생 시간: {formatTime(currentTime)}</span>
          <div>
            {[-1000, -100, 100, 1000].map((delta) => (
              <button
                type="button"
                key={delta}
                onClick={() =>
                  updateDraftSync({ offsetMs: draftSyncProfile.offsetMs + delta })
                }
              >
                {delta > 0 ? '+' : ''}{delta}ms
              </button>
            ))}
          </div>
          <div>
            <button type="button" onClick={addSelectedAnchor}>
              이 줄을 현재 시간에 맞추기
            </button>
            <button
              type="button"
              onClick={() =>
                updateDraftSync({ anchors: draftSyncProfile.anchors.slice(0, -1) })
              }
              disabled={!draftSyncProfile.anchors.length}
            >
              마지막 기준점 삭제
            </button>
          </div>
          <small>기준점 {draftSyncProfile.anchors.length}개 · 오프셋 {draftSyncProfile.offsetMs}ms</small>
          <div>
            <button type="button" className="button button--primary" onClick={() => void saveSync()}>
              저장
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setDraftSyncProfile(savedSyncProfile ?? { trackId, offsetMs: 0, anchors: [], updatedAt: 0 })
                setSyncEditing(false)
              }}
            >
              취소
            </button>
          </div>
        </div>
      )}
      {lines.map((line, index) => (
        <button
          type="button"
          key={`${line.time}-${index}`}
          ref={(element) => {
            lineRefs.current[index] = element
          }}
          className={`${index === activeIndex ? 'is-active ' : ''}${syncEditing && index === selectedLineIndex ? 'is-selected' : ''}`}
          onClick={() => {
            if (syncEditing) setSelectedLineIndex(index)
            else usePlayerStore.getState().seek(line.time)
          }}
        >
          {line.text}
        </button>
      ))}
    </div>
  )
}

function syncStatusCopy(profile: LyricsSyncProfile | null) {
  if (!profile) return '원본 싱크'
  if (profile.anchors.length >= 3)
    return `사용자 구간 보정 ${profile.anchors.length}개`
  if (profile.anchors.length >= 1)
    return `사용자 기준점 ${profile.anchors.length}개`
  return `사용자 보정 ${profile.offsetMs >= 0 ? '+' : ''}${(profile.offsetMs / 1_000).toFixed(1)}초`
}

interface LyricsSearchPanelProps {
  result: LyricsSearchResult
  loading: boolean
  searchTitle: string
  searchArtist: string
  onSearchTitleChange: (value: string) => void
  onSearchArtistChange: (value: string) => void
  onSearch: () => void
  onCleanSearch: () => void
  onSelect: (candidate: LyricsCandidate) => void
  selectingCandidateId: number | null
  onMarkInstrumental: () => void
  onClose?: () => void
}

function LyricsSearchPanel({
  result,
  loading,
  searchTitle,
  searchArtist,
  onSearchTitleChange,
  onSearchArtistChange,
  onSearch,
  onCleanSearch,
  onSelect,
  selectingCandidateId,
  onMarkInstrumental,
  onClose,
}: LyricsSearchPanelProps) {
  return (
    <div className="lyrics-search-panel">
      <div className="section-heading">
        <h3>가사 검색</h3>
        {onClose && (
          <button type="button" aria-label="검색 결과 닫기" onClick={onClose}>
            <X />
          </button>
        )}
      </div>
      <p className="lyrics-search-status">{statusCopy[result.status]}</p>
      <div className="lyrics-search-fields">
        <label>
          제목
          <input
            value={searchTitle}
            maxLength={500}
            onChange={(event) => onSearchTitleChange(event.target.value)}
          />
        </label>
        <label>
          아티스트
          <input
            value={searchArtist}
            maxLength={500}
            onChange={(event) => onSearchArtistChange(event.target.value)}
          />
        </label>
      </div>
      <div className="lyrics-search-actions">
        <button
          type="button"
          className="button button--primary"
          disabled={loading}
          onClick={onSearch}
        >
          {loading ? '검색 중…' : '검색'}
        </button>
        <button
          type="button"
          className="button"
          disabled={loading}
          onClick={onCleanSearch}
        >
          현재 제목 정리해서 다시 검색
        </button>
        <button type="button" className="button" onClick={onMarkInstrumental}>
          연주곡으로 표시
        </button>
      </div>
      {result.candidates.length > 0 && (
        <div className="lyrics-candidate-list">
          {result.candidates.map((candidate) => (
            <div className="lyrics-candidate" key={candidate.id}>
              <div className="lyrics-candidate__content">
                <strong>{candidate.trackName}</strong>
                <span>{candidate.artistName}</span>
                <small>
                  {candidate.albumName || '앨범 정보 없음'} ·{' '}
                  {candidate.duration
                    ? formatTime(candidate.duration)
                    : '길이 정보 없음'}{' '}
                  · {candidate.syncedLyrics ? '동기화 가사' : '일반 가사'}
                </small>
              </div>
              <button
                type="button"
                className="button lyrics-candidate__action"
                disabled={loading || selectingCandidateId !== null}
                onClick={() => onSelect(candidate)}
              >
                선택
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
