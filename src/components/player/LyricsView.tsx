import { FileText, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { usePlayerStore } from '../../stores/playerStore'
import { useAppStore } from '../../stores/appStore'
import type {
  AutoSyncAvailability,
  AutoSyncJob,
  AutoSyncResult,
  AutoSyncStage,
  GeneratedLyricsTimeline,
  GeneratedLyricsTimelineState,
  LyricsCandidate,
  LyricsLookupStatus,
  LyricsResult,
  LyricsSearchResult,
  LyricsSyncProfile,
  TrackLyrics,
} from '../../types/models'
import { formatTime } from '../../utils/format'
import { findActiveLyricLineIndex, parseLrc } from '../../utils/lyrics'
import { adjustLyricTimeMs } from '../../utils/lyricsSync'
import {
  generatedLyricsLineHash,
  generatedLyricsTextHash,
  splitGeneratedLyricsText,
} from '../../utils/generatedLyricsTimeline'
import { EmptyState } from '../common/EmptyState'

type LyricsSearchMode = 'all' | 'synced'
type LyricsSearchProgress =
  | 'preparing'
  | 'lrclib'
  | 'lyrica-connecting'
  | 'lyrica-searching'
  | 'organizing'

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
  const appliedLyrics = useAppStore((state) => state.data?.lyrics[trackId])
  const refreshData = useAppStore((state) => state.refreshData)
  const [lyrics, setLyrics] = useState<LyricsResult | null>(null)
  const [searchResult, setSearchResult] = useState<LyricsSearchResult | null>(
    null,
  )
  const [searchMode, setSearchMode] = useState<LyricsSearchMode>('all')
  const [searchProgress, setSearchProgress] =
    useState<LyricsSearchProgress>('preparing')
  const [searchElapsedMs, setSearchElapsedMs] = useState(0)
  const [searchTitle, setSearchTitle] = useState(currentTrack?.title ?? '')
  const [searchArtist, setSearchArtist] = useState(currentTrack?.artist ?? '')
  const [loading, setLoading] = useState(false)
  const [manualLyricsOpen, setManualLyricsOpen] = useState(false)
  const [manualLyricsApplying, setManualLyricsApplying] = useState(false)
  const [manualLyricsError, setManualLyricsError] = useState<string | null>(
    null,
  )
  const [selectingCandidateId, setSelectingCandidateId] = useState<
    number | null
  >(null)
  const [savedSyncProfile, setSavedSyncProfile] =
    useState<LyricsSyncProfile | null>(null)
  const [draftSyncProfile, setDraftSyncProfile] = useState<LyricsSyncProfile>({
    trackId,
    offsetMs: 0,
    anchors: [],
    updatedAt: 0,
  })
  const [syncEditing, setSyncEditing] = useState(false)
  const [selectedLineIndex, setSelectedLineIndex] = useState(0)
  const [autoSyncAvailability, setAutoSyncAvailability] =
    useState<AutoSyncAvailability | null>(null)
  const [autoSyncJob, setAutoSyncJob] = useState<AutoSyncJob | null>(null)
  const [autoSyncConfirming, setAutoSyncConfirming] = useState(false)
  const [autoSyncStarting, setAutoSyncStarting] = useState(false)
  const [autoSyncPreviewProfile, setAutoSyncPreviewProfile] =
    useState<LyricsSyncProfile | null>(null)
  const [generatedTimelineState, setGeneratedTimelineState] =
    useState<GeneratedLyricsTimelineState>({ timeline: null, valid: false })
  const [autoSyncPreviewTimeline, setAutoSyncPreviewTimeline] =
    useState<GeneratedLyricsTimeline | null>(null)
  const [draftGeneratedTimeline, setDraftGeneratedTimeline] =
    useState<GeneratedLyricsTimeline | null>(null)
  const [inlineGeneratedDraft, setInlineGeneratedDraft] =
    useState<GeneratedLyricsTimeline | null>(null)
  const [inlineGeneratedEditing, setInlineGeneratedEditing] = useState(false)
  const [inlineSelectedLineIndex, setInlineSelectedLineIndex] = useState<
    number | null
  >(null)
  const [inlineTimestampInput, setInlineTimestampInput] = useState('')
  const [inlineTimestampInputError, setInlineTimestampInputError] = useState<
    string | null
  >(null)
  const [inlineSaveError, setInlineSaveError] = useState<string | null>(null)
  const [autoSyncEditingJobId, setAutoSyncEditingJobId] = useState<
    string | null
  >(null)
  const [autoSyncUiError, setAutoSyncUiError] = useState<string | null>(null)
  const lineRefs = useRef<Array<HTMLButtonElement | null>>([])
  const autoScrollPausedUntil = useRef(0)
  const loadRequestId = useRef(0)
  const selectingCandidateRef = useRef<number | null>(null)
  const searchRequestId = useRef(0)
  const autoSyncJobRef = useRef<AutoSyncJob | null>(null)
  const ignoredAutoSyncJobIds = useRef(new Set<string>())
  const autoSyncAvailabilityRequestId = useRef(0)

  const refreshAutoSyncAvailability = useCallback(() => {
    const requestId = ++autoSyncAvailabilityRequestId.current
    return window.electronAPI
      .getLyricsAutoSyncAvailability(trackId)
      .then((availability) => {
        if (requestId === autoSyncAvailabilityRequestId.current)
          setAutoSyncAvailability(availability)
      })
      .catch((error: unknown) => {
        if (requestId !== autoSyncAvailabilityRequestId.current) return
        setAutoSyncAvailability({
          available: false,
          device: null,
          missingRequirements: [],
          reason: errorMessage(error, '자동 싱크 환경을 확인하지 못했습니다.'),
          checkedAt: Date.now(),
        })
      })
  }, [trackId])

  const receiveAutoSyncJob = useCallback(
    (next: AutoSyncJob | null) => {
      if (!next) {
        autoSyncJobRef.current = null
        setAutoSyncJob(null)
        return
      }
      if (
        next.trackId !== trackId ||
        ignoredAutoSyncJobIds.current.has(next.jobId)
      )
        return
      const current = autoSyncJobRef.current
      if (current?.jobId === next.jobId) {
        const currentIsTerminal = current.status !== 'running'
        if (
          current.updatedAt > next.updatedAt ||
          (currentIsTerminal && next.status === 'running')
        )
          return
      }
      if (next.status === 'cancelled') {
        autoSyncJobRef.current = null
        setAutoSyncJob(null)
        setAutoSyncPreviewProfile(null)
        setAutoSyncPreviewTimeline(null)
        setDraftGeneratedTimeline(null)
        setAutoSyncEditingJobId(null)
        setAutoSyncUiError(null)
        return
      }
      autoSyncJobRef.current = next
      setAutoSyncJob(next)
      if (next.status === 'failed') {
        setAutoSyncPreviewProfile(null)
        setAutoSyncPreviewTimeline(null)
        setDraftGeneratedTimeline(null)
        setAutoSyncEditingJobId(null)
        setAutoSyncUiError(
          next.error?.message ?? '자동 싱크 분석에 실패했습니다.',
        )
      } else {
        setAutoSyncUiError(null)
      }
    },
    [trackId],
  )

  useEffect(() => {
    const requestId = ++loadRequestId.current
    let active = true
    void window.electronAPI
      .loadLyrics(trackId)
      .then((result) => {
        if (active && loadRequestId.current === requestId) {
          setLyrics(result)
          void refreshData()
          void refreshAutoSyncAvailability()
        }
      })
      .catch(() => {
        if (active && loadRequestId.current === requestId)
          setLyrics({ kind: 'none', content: '', status: 'network-error' })
      })
    return () => {
      active = false
    }
  }, [refreshAutoSyncAvailability, refreshData, trackId])

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

  const refreshGeneratedTimeline = useCallback(() => {
    return window.electronAPI
      .getGeneratedLyricsTimeline(trackId)
      .then(setGeneratedTimelineState)
      .catch(() =>
        setGeneratedTimelineState({
          timeline: null,
          valid: false,
          reason: 'timeline-invalid',
        }),
      )
  }, [trackId])

  useEffect(() => {
    void refreshGeneratedTimeline()
  }, [refreshGeneratedTimeline])

  useEffect(() => {
    let active = true
    const onProgress = window.electronAPI.onLyricsAutoSyncProgress((job) => {
      if (job.trackId !== trackId && job.status === 'running')
        setAutoSyncAvailability((availability) =>
          availability?.available
            ? {
                ...availability,
                available: false,
                missingRequirements: ['job-active'],
                reason: '다른 곡의 자동 싱크 분석이 진행 중입니다.',
                checkedAt: Date.now(),
              }
            : availability,
        )
      receiveAutoSyncJob(job)
    })
    const receiveTerminalJob = (job: AutoSyncJob) => {
      receiveAutoSyncJob(job)
      void refreshAutoSyncAvailability()
    }
    const onCompleted =
      window.electronAPI.onLyricsAutoSyncCompleted(receiveTerminalJob)
    const onFailed =
      window.electronAPI.onLyricsAutoSyncFailed(receiveTerminalJob)
    void refreshAutoSyncAvailability()
    void window.electronAPI
      .getLyricsAutoSyncJob(trackId)
      .then((job) => {
        if (active && (job || !autoSyncJobRef.current)) receiveAutoSyncJob(job)
      })
      .catch((error: unknown) => {
        if (active)
          setAutoSyncUiError(
            errorMessage(error, '자동 싱크 작업 상태를 확인하지 못했습니다.'),
          )
      })
    return () => {
      active = false
      autoSyncAvailabilityRequestId.current += 1
      onProgress()
      onCompleted()
      onFailed()
    }
  }, [receiveAutoSyncJob, refreshAutoSyncAvailability, trackId])

  const rawLines = lyrics?.kind === 'lrc' ? parseLrc(lyrics.content) : []
  const plainLines =
    lyrics?.kind === 'text' ? splitGeneratedLyricsText(lyrics.content) : []
  const activeSyncProfile = syncEditing
    ? draftSyncProfile
    : (autoSyncPreviewProfile ?? savedSyncProfile)
  const activeGeneratedTimeline =
    inlineGeneratedDraft ??
    draftGeneratedTimeline ??
    autoSyncPreviewTimeline ??
    (generatedTimelineState.valid ? generatedTimelineState.timeline : null)
  const generatedTimingByLine = new Map(
    activeGeneratedTimeline?.lines.map((line) => [line.lineIndex, line]) ?? [],
  )
  const autoSyncLineTimingByLine = new Map(
    (autoSyncJob?.status === 'completed'
      ? autoSyncJob.result?.lineTimings
      : undefined
    )?.map((line) => [line.lineIndex, line]) ?? [],
  )
  const generatedTimingSourceByLine = new Map(
    activeGeneratedTimeline?.lines.map((line) => [
      line.lineIndex,
      line.source ?? (activeGeneratedTimeline.source === 'manual' ? 'manual' : 'direct'),
    ]) ?? [],
  )
  const generatedLines = plainLines.map((text, index) => ({
    text,
    timing: generatedTimingByLine.get(index),
  }))
  const autoSyncPreviewing = Boolean(
    autoSyncPreviewProfile || autoSyncPreviewTimeline,
  )
  const editingGeneratedTimeline = Boolean(syncEditing && draftGeneratedTimeline)
  const lines = rawLines.map((line) => ({
    ...line,
    originalTimeMs: Math.round(line.time * 1_000),
    time:
      adjustLyricTimeMs(
        Math.round(line.time * 1_000),
        activeSyncProfile ?? undefined,
      ) / 1_000,
  }))
  const activeIndex = findActiveLyricLineIndex(
    lyrics?.kind === 'text'
      ? generatedLines.map((line) =>
          line.timing ? line.timing.audioTimeMs / 1_000 : undefined,
        )
      : lines.map((line) => line.time),
    currentTime,
  )
  const activeLineIdentity = [
    trackId,
    lyrics?.kind ?? 'none',
    lyrics?.content ?? '',
    activeGeneratedTimeline?.createdAt ?? 'no-generated-timeline',
    activeIndex,
  ].join(':')
  useEffect(() => {
    if (
      activeIndex >= 0 &&
      (!inlineGeneratedEditing || inlineSelectedLineIndex === null) &&
      Date.now() >= autoScrollPausedUntil.current
    )
      lineRefs.current[activeIndex]?.scrollIntoView({
        block: 'center',
        behavior: 'smooth',
      })
  }, [activeIndex, activeLineIdentity, inlineGeneratedEditing, inlineSelectedLineIndex])

  useEffect(() => {
    if (!loading) return
    const startedAt = Date.now()
    const updateElapsed = () => {
      const elapsed = Date.now() - startedAt
      setSearchElapsedMs(elapsed)
      setSearchProgress(
        elapsed < 500
          ? 'preparing'
          : elapsed < 2_500
            ? 'lrclib'
            : elapsed < 8_000
              ? 'lyrica-connecting'
              : 'lyrica-searching',
      )
    }
    updateElapsed()
    const timer = window.setInterval(updateElapsed, 100)
    return () => window.clearInterval(timer)
  }, [loading])

  const search = async (
    mode: LyricsSearchMode = 'all',
    useCurrentMetadata = false,
  ) => {
    const requestId = ++searchRequestId.current
    setSearchMode(mode)
    setSearchProgress('preparing')
    setSearchElapsedMs(0)
    setSearchResult({ status: 'found', candidates: [], normalizedTitle: '' })
    setLoading(true)
    try {
      const result = await window.electronAPI.searchLyrics(
        trackId,
        useCurrentMetadata
          ? undefined
          : { title: searchTitle, artist: searchArtist },
      )
      if (requestId !== searchRequestId.current) return
      setSearchProgress('organizing')
      setSearchResult(result)
      if (useCurrentMetadata) {
        setSearchTitle(result.normalizedTitle || currentTrack?.title || '')
        setSearchArtist(result.originalArtist || currentTrack?.artist || '')
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 120))
    } catch {
      if (requestId !== searchRequestId.current) return
      setSearchResult({
        status: 'network-error',
        candidates: [],
        normalizedTitle: '',
      })
    } finally {
      if (requestId === searchRequestId.current) setLoading(false)
    }
  }

  const cancelSearch = () => {
    searchRequestId.current += 1
    setLoading(false)
    setSearchResult(null)
  }

  const clearLocalAutoSyncJob = (jobId: string) => {
    ignoredAutoSyncJobIds.current.add(jobId)
    autoSyncJobRef.current = null
    setAutoSyncJob(null)
    setAutoSyncPreviewProfile(null)
    setAutoSyncPreviewTimeline(null)
    setDraftGeneratedTimeline(null)
    setAutoSyncEditingJobId(null)
    setAutoSyncConfirming(false)
  }

  const cancelAutoSync = async () => {
    const job = autoSyncJobRef.current
    if (!job) return true
    clearLocalAutoSyncJob(job.jobId)
    setAutoSyncUiError(null)
    try {
      if (!(await window.electronAPI.cancelLyricsAutoSync(job.jobId)))
        throw new Error('자동 싱크 작업을 취소하지 못했습니다.')
      void refreshAutoSyncAvailability()
      return true
    } catch (error) {
      ignoredAutoSyncJobIds.current.delete(job.jobId)
      let current: AutoSyncJob | null | undefined
      try {
        current = await window.electronAPI.getLyricsAutoSyncJob(trackId)
      } catch {
        current = undefined
      }
      receiveAutoSyncJob(current === undefined ? job : current)
      void refreshAutoSyncAvailability()
      if (current === null) return true
      if (current && current.status !== 'running') return false
      setAutoSyncUiError(
        errorMessage(error, '자동 싱크 작업을 취소하지 못했습니다.'),
      )
      return false
    }
  }

  const discardAutoSync = async (expectedJobId?: string) => {
    const job = autoSyncJobRef.current
    if (!job || (expectedJobId && expectedJobId !== job.jobId)) {
      setAutoSyncPreviewProfile(null)
      setAutoSyncPreviewTimeline(null)
      setAutoSyncEditingJobId(null)
      return true
    }
    clearLocalAutoSyncJob(job.jobId)
    setAutoSyncUiError(null)
    try {
      if (!(await window.electronAPI.discardLyricsAutoSync(job.jobId)))
        throw new Error('자동 싱크 결과를 버리지 못했습니다.')
      void refreshAutoSyncAvailability()
      return true
    } catch (error) {
      ignoredAutoSyncJobIds.current.delete(job.jobId)
      let current: AutoSyncJob | null | undefined
      try {
        current = await window.electronAPI.getLyricsAutoSyncJob(trackId)
      } catch {
        current = undefined
      }
      receiveAutoSyncJob(current === undefined ? job : current)
      void refreshAutoSyncAvailability()
      if (current === null) return true
      setAutoSyncUiError(
        errorMessage(error, '자동 싱크 결과를 버리지 못했습니다.'),
      )
      return false
    }
  }

  const clearAutoSyncBeforeLyricsMutation = async () => {
    const job = autoSyncJobRef.current
    if (!job) return true
    return job.status === 'running'
      ? cancelAutoSync()
      : discardAutoSync(job.jobId)
  }

  const startAutoSync = async () => {
    setAutoSyncConfirming(false)
    setAutoSyncStarting(true)
    setAutoSyncPreviewProfile(null)
    setAutoSyncPreviewTimeline(null)
    setDraftGeneratedTimeline(null)
    setAutoSyncEditingJobId(null)
    setAutoSyncUiError(null)
    try {
      receiveAutoSyncJob(await window.electronAPI.startLyricsAutoSync(trackId))
    } catch (error) {
      void refreshAutoSyncAvailability()
      setAutoSyncUiError(
        errorMessage(error, '자동 싱크 분석을 시작하지 못했습니다.'),
      )
    } finally {
      setAutoSyncStarting(false)
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
    const keepGeneratedTimeline = generatedTimelineState.timeline
      ? window.confirm(
          '이 곡에 저장된 AI 줄별 타임라인이 있습니다.\n\n확인: 새 가사와 줄·텍스트가 같으면 유지\n취소: 기존 AI 타임라인 초기화',
        )
      : true
    if (!(await clearAutoSyncBeforeLyricsMutation())) return
    searchRequestId.current += 1
    setLoading(false)
    selectingCandidateRef.current = candidate.id
    setSelectingCandidateId(candidate.id)
    try {
      setLyrics(
        await window.electronAPI.saveLyricsSelection(trackId, candidate),
      )
      void refreshData()
      void refreshAutoSyncAvailability()
      setSavedSyncProfile(null)
      setDraftSyncProfile({ trackId, offsetMs: 0, anchors: [], updatedAt: 0 })
      if (!keepGeneratedTimeline) {
        await window.electronAPI.clearGeneratedLyricsTimeline(trackId)
        setGeneratedTimelineState({ timeline: null, valid: false })
      } else {
        await refreshGeneratedTimeline()
      }
      setSearchResult(null)
    } finally {
      selectingCandidateRef.current = null
      setSelectingCandidateId(null)
    }
  }

  const markInstrumental = async () => {
    if (!(await clearAutoSyncBeforeLyricsMutation())) return
    await window.electronAPI.markLyricsInstrumental(trackId)
    setLyrics({ kind: 'none', content: '', status: 'instrumental' })
    setSearchResult(null)
    setGeneratedTimelineState({ timeline: null, valid: false })
    void refreshAutoSyncAvailability()
  }

  const importLyricsFile = async () => {
    if (selectingCandidateRef.current !== null) return
    setManualLyricsError(null)
    try {
      const candidate = await window.electronAPI.importLyricsFile(trackId)
      if (!candidate) return
      if (!window.confirm('선택한 가사 파일을 현재 곡에 적용할까요?')) return
      await select(candidate)
    } catch (error) {
      window.alert(errorMessage(error, '가사 파일을 가져오지 못했습니다.'))
    }
  }

  const applyManualLyricsInput = async (content: string) => {
    setManualLyricsApplying(true)
    setManualLyricsError(null)
    try {
      const candidate = await window.electronAPI.parseLyricsInput(trackId, content)
      await select(candidate)
      setManualLyricsOpen(false)
    } catch (error) {
      setManualLyricsError(errorMessage(error, '입력한 가사를 적용하지 못했습니다.'))
    } finally {
      setManualLyricsApplying(false)
    }
  }

  const updateDraftSync = (patch: Partial<LyricsSyncProfile>) => {
    setDraftSyncProfile((profile) => ({ ...profile, ...patch }))
  }
  const addSelectedAnchor = () => {
    const line = lines[selectedLineIndex]
    if (!line) return
    const anchor = {
      lyricTimeMs: line.originalTimeMs,
      audioTimeMs: Math.max(
        0,
        Math.round(currentTime * 1_000 - draftSyncProfile.offsetMs),
      ),
    }
    const anchors = [
      ...draftSyncProfile.anchors.filter(
        (item) => item.lyricTimeMs !== anchor.lyricTimeMs,
      ),
      anchor,
    ].sort((left, right) => left.lyricTimeMs - right.lyricTimeMs)
    updateDraftSync({ anchors })
  }
  const addSelectedGeneratedTiming = () => {
    if (!draftGeneratedTimeline || !plainLines[selectedLineIndex]) return
    const timing = {
      lineIndex: selectedLineIndex,
      textHash: generatedLyricsLineHash(plainLines[selectedLineIndex]),
      audioTimeMs: Math.max(0, Math.round(currentTime * 1_000)),
      confidence: 1,
    }
    setDraftGeneratedTimeline((timeline) =>
      timeline
        ? {
            ...timeline,
            lines: [
              ...timeline.lines.filter(
                (line) => line.lineIndex !== timing.lineIndex,
              ),
              timing,
            ].sort((left, right) => left.lineIndex - right.lineIndex),
          }
        : timeline,
    )
  }
  const clearSelectedGeneratedTiming = () => {
    if (!draftGeneratedTimeline) return
    setDraftGeneratedTimeline((timeline) =>
      timeline
        ? {
            ...timeline,
            lines: timeline.lines.filter(
              (line) => line.lineIndex !== selectedLineIndex,
            ),
          }
        : timeline,
    )
  }
  const saveSync = async () => {
    const editingAutoResult = autoSyncEditingJobId !== null
    if (draftGeneratedTimeline) {
      try {
        const saved = await window.electronAPI.saveGeneratedLyricsTimeline({
          ...draftGeneratedTimeline,
          source: 'manual',
          createdAt: Date.now(),
        })
        setGeneratedTimelineState({ timeline: saved, valid: true })
        setDraftGeneratedTimeline(null)
        setAutoSyncPreviewProfile(null)
        setAutoSyncPreviewTimeline(null)
        setSyncEditing(false)
        if (autoSyncEditingJobId) {
          const jobId = autoSyncEditingJobId
          setAutoSyncEditingJobId(null)
          await discardAutoSync(jobId)
        }
      } catch (error) {
        setAutoSyncUiError(
          errorMessage(error, 'AI 줄별 타임라인을 저장하지 못했습니다.'),
        )
      }
      return
    }
    if (
      editingAutoResult &&
      savedSyncProfile &&
      !window.confirm(
        '기존에 저장한 가사 싱크 보정을 AI 자동 싱크 초안으로 덮어쓸까요?',
      )
    )
      return
    try {
      const saved = await window.electronAPI.saveLyricsSyncProfile({
        ...draftSyncProfile,
        updatedAt: Date.now(),
        source: draftSyncProfile.source ?? 'manual',
      })
      setSavedSyncProfile(saved)
      setDraftSyncProfile(saved)
      setAutoSyncPreviewProfile(null)
      setAutoSyncPreviewTimeline(null)
      setSyncEditing(false)
      if (autoSyncEditingJobId) {
        const jobId = autoSyncEditingJobId
        setAutoSyncEditingJobId(null)
        await discardAutoSync(jobId)
      }
    } catch (error) {
      setAutoSyncUiError(
        errorMessage(error, '가사 싱크 보정을 저장하지 못했습니다.'),
      )
    }
  }
  const resetSync = async () => {
    await window.electronAPI.clearLyricsSyncProfile(trackId)
    const empty = { trackId, offsetMs: 0, anchors: [], updatedAt: 0 }
    setSavedSyncProfile(null)
    setDraftSyncProfile(empty)
    setAutoSyncPreviewProfile(null)
    setAutoSyncPreviewTimeline(null)
    setAutoSyncEditingJobId(null)
    setSyncEditing(false)
  }

  const cancelSyncEditing = () => {
    setDraftSyncProfile(
      savedSyncProfile ?? { trackId, offsetMs: 0, anchors: [], updatedAt: 0 },
    )
    setAutoSyncPreviewProfile(null)
    setAutoSyncPreviewTimeline(null)
    setDraftGeneratedTimeline(null)
    setAutoSyncEditingJobId(null)
    setSyncEditing(false)
  }

  const toggleSyncEditing = () => {
    if (syncEditing) {
      cancelSyncEditing()
      return
    }
    setAutoSyncPreviewProfile(null)
    setAutoSyncPreviewTimeline(null)
    setDraftGeneratedTimeline(null)
    setAutoSyncEditingJobId(null)
    setDraftSyncProfile(
      savedSyncProfile ?? { trackId, offsetMs: 0, anchors: [], updatedAt: 0 },
    )
    setSyncEditing(true)
  }

  const previewAutoSync = () => {
    const result = autoSyncJobRef.current?.result
    if (!result) return
    setSyncEditing(false)
    setAutoSyncEditingJobId(null)
    if (result.generatedLyricsTimeline && plainLines.length) {
      setAutoSyncPreviewProfile(null)
      setAutoSyncPreviewTimeline((timeline) =>
        timeline ? null : result.generatedLyricsTimeline!,
      )
      return
    }
    if (!rawLines.length) return
    setAutoSyncPreviewTimeline(null)
    setAutoSyncPreviewProfile((profile) =>
      profile ? null : autoSyncProfile(result),
    )
  }

  const openAutoSyncInEditor = () => {
    const job = autoSyncJobRef.current
    if (!job?.result) return
    setAutoSyncPreviewProfile(null)
    setAutoSyncPreviewTimeline(null)
    if (job.result.generatedLyricsTimeline && plainLines.length) {
      setDraftGeneratedTimeline(
        generatedTimelineFromAutoSyncResult(job.result, plainLines),
      )
    } else {
      if (!rawLines.length) return
      setDraftGeneratedTimeline(null)
      setDraftSyncProfile(autoSyncProfile(job.result))
    }
    setAutoSyncEditingJobId(job.jobId)
    setSelectedLineIndex(Math.max(0, activeIndex))
    setSyncEditing(true)
  }

  const applyAutoSync = async () => {
    const job = autoSyncJobRef.current
    const result = job?.result
    if (!job || !result?.canApply) return
    if (result.generatedLyricsTimeline && plainLines.length) {
      if (
        generatedTimelineState.timeline &&
        !window.confirm(
          '기존에 저장한 AI 줄별 타임라인을 새 결과로 덮어쓸까요?',
        )
      )
        return
      try {
        const saved = await window.electronAPI.saveGeneratedLyricsTimeline(
          result.generatedLyricsTimeline,
        )
        setGeneratedTimelineState({ timeline: saved, valid: true })
        setAutoSyncPreviewTimeline(null)
        await discardAutoSync(job.jobId)
      } catch (error) {
        setAutoSyncUiError(
          errorMessage(error, 'AI 줄별 타임라인을 저장하지 못했습니다.'),
        )
      }
      return
    }
    if (!rawLines.length) return
    if (
      savedSyncProfile &&
      !window.confirm(
        '기존에 저장한 가사 싱크 보정을 AI 자동 싱크 결과로 덮어쓸까요?',
      )
    )
      return
    try {
      const saved = await window.electronAPI.saveLyricsSyncProfile(
        autoSyncProfile(result),
      )
      setSavedSyncProfile(saved)
      setDraftSyncProfile(saved)
      setAutoSyncPreviewProfile(null)
      setAutoSyncPreviewTimeline(null)
      setAutoSyncEditingJobId(null)
      setSyncEditing(false)
      await discardAutoSync(job.jobId)
    } catch (error) {
      setAutoSyncUiError(
        errorMessage(error, '자동 싱크 결과를 적용하지 못했습니다.'),
      )
    }
  }

  const inlineDraftIssues = validateGeneratedTimelineDraft(
    inlineGeneratedDraft,
    currentTrack?.duration ?? null,
  )
  const inlineDraftDirty = Boolean(
    inlineGeneratedDraft &&
      generatedTimelineState.timeline &&
      generatedTimelineSignature(inlineGeneratedDraft) !==
        generatedTimelineSignature(generatedTimelineState.timeline),
  )
  const selectInlineGeneratedLine = (lineIndex: number) => {
    const timing = inlineGeneratedDraft?.lines.find(
      (line) => line.lineIndex === lineIndex,
    )
    setInlineSelectedLineIndex(lineIndex)
    setInlineTimestampInput(
      timing ? formatGeneratedTimestamp(timing.audioTimeMs) : '',
    )
    setInlineTimestampInputError(null)
    setInlineSaveError(null)
  }
  const updateInlineGeneratedTiming = (lineIndex: number, audioTimeMs: number) => {
    if (!inlineGeneratedDraft || !plainLines[lineIndex]) return
    const existing = inlineGeneratedDraft.lines.find(
      (line) => line.lineIndex === lineIndex,
    )
    const timing = {
      lineIndex,
      textHash: generatedLyricsLineHash(plainLines[lineIndex]),
      audioTimeMs: Math.round(audioTimeMs),
      ...(existing?.confidence === undefined
        ? {}
        : { confidence: existing.confidence }),
      source: 'manual' as const,
    }
    setInlineGeneratedDraft((timeline) =>
      timeline
        ? {
            ...timeline,
            lines: [
              ...timeline.lines.filter((line) => line.lineIndex !== lineIndex),
              timing,
            ].sort((left, right) => left.lineIndex - right.lineIndex),
          }
        : timeline,
    )
  }
  const setInlineGeneratedToCurrentTime = () => {
    if (inlineSelectedLineIndex === null) return
    const milliseconds = Math.max(0, Math.round(currentTime * 1_000))
    updateInlineGeneratedTiming(inlineSelectedLineIndex, milliseconds)
    setInlineTimestampInput(formatGeneratedTimestamp(milliseconds))
    setInlineTimestampInputError(null)
  }
  const adjustInlineGeneratedTiming = (deltaMs: number) => {
    if (inlineSelectedLineIndex === null) return
    const timing = inlineGeneratedDraft?.lines.find(
      (line) => line.lineIndex === inlineSelectedLineIndex,
    )
    if (!timing) return
    const milliseconds = Math.max(0, timing.audioTimeMs + deltaMs)
    updateInlineGeneratedTiming(inlineSelectedLineIndex, milliseconds)
    setInlineTimestampInput(formatGeneratedTimestamp(milliseconds))
    setInlineTimestampInputError(null)
  }
  const deleteInlineGeneratedTiming = () => {
    if (inlineSelectedLineIndex === null) return
    setInlineGeneratedDraft((timeline) =>
      timeline
        ? {
            ...timeline,
            lines: timeline.lines.filter(
              (line) => line.lineIndex !== inlineSelectedLineIndex,
            ),
          }
        : timeline,
    )
    setInlineTimestampInput('')
    setInlineTimestampInputError(null)
  }
  const updateInlineTimestampInput = (value: string) => {
    setInlineTimestampInput(value)
    if (inlineSelectedLineIndex === null) return
    const milliseconds = parseGeneratedTimestamp(value)
    if (milliseconds === null) {
      setInlineTimestampInputError('mm:ss.SSS 형식으로 입력하세요.')
      return
    }
    setInlineTimestampInputError(null)
    updateInlineGeneratedTiming(inlineSelectedLineIndex, milliseconds)
  }
  const startInlineGeneratedEditing = () => {
    const timeline = generatedTimelineState.timeline
    if (!generatedTimelineState.valid || !timeline) return
    setInlineGeneratedDraft({ ...timeline, lines: timeline.lines.map((line) => ({ ...line })) })
    setInlineGeneratedEditing(true)
    setInlineSelectedLineIndex(null)
    setInlineTimestampInput('')
    setInlineTimestampInputError(null)
    setInlineSaveError(null)
  }
  const cancelInlineGeneratedEditing = () => {
    setInlineGeneratedDraft(null)
    setInlineGeneratedEditing(false)
    setInlineSelectedLineIndex(null)
    setInlineTimestampInput('')
    setInlineTimestampInputError(null)
    setInlineSaveError(null)
  }
  const saveInlineGeneratedEditing = async () => {
    if (!inlineGeneratedDraft || inlineTimestampInputError || inlineDraftIssues.size) {
      setInlineSaveError('timestamp 오류를 수정한 뒤 저장하세요.')
      return
    }
    try {
      const saved = await window.electronAPI.saveGeneratedLyricsTimeline({
        ...inlineGeneratedDraft,
        source: inlineDraftDirty ? 'manual' : inlineGeneratedDraft.source,
        createdAt: Date.now(),
      })
      setGeneratedTimelineState({ timeline: saved, valid: true })
      cancelInlineGeneratedEditing()
    } catch (error) {
      setInlineSaveError(
        errorMessage(error, 'AI 줄별 타임라인을 저장하지 못했습니다.'),
      )
    }
  }
  const resetGeneratedTimeline = async () => {
    if (
      inlineGeneratedEditing &&
      inlineDraftDirty &&
      !window.confirm(
        '저장하지 않은 줄별 timestamp 수정이 있습니다.\n\n확인: 편집을 취소하고 초기화\n취소: 계속 편집',
      )
    )
      return
    if (inlineGeneratedEditing) cancelInlineGeneratedEditing()
    await window.electronAPI.clearGeneratedLyricsTimeline(trackId)
    setGeneratedTimelineState({ timeline: null, valid: false })
    setAutoSyncPreviewTimeline(null)
  }

  const renderSyncEditor = () => {
    if (!syncEditing) return null
    if (editingGeneratedTimeline) {
      const selectedTiming = generatedTimingByLine.get(selectedLineIndex)
      return (
        <div className="lyrics-sync-editor" data-generated-sync-editor>
          <strong>
            선택 줄 {plainLines[selectedLineIndex] || '가사 줄을 선택하세요'}
          </strong>
          <span>현재 재생 시간: {formatTime(currentTime)}</span>
          <small>
            {selectedTiming
              ? `초기 timestamp: ${formatTime(selectedTiming.audioTimeMs / 1_000)}`
              : 'timestamp 미지정 · 현재 재생 시간으로 직접 지정할 수 있습니다.'}
          </small>
          <div>
            <button type="button" onClick={addSelectedGeneratedTiming}>
              선택 줄을 현재 시간에 맞추기
            </button>
            <button
              type="button"
              onClick={clearSelectedGeneratedTiming}
              disabled={!selectedTiming}
            >
              선택 줄 timestamp 지우기
            </button>
          </div>
          <small>timestamp {draftGeneratedTimeline?.lines.length ?? 0}개</small>
          <div>
            <button
              type="button"
              className="button button--primary"
              onClick={() => void saveSync()}
            >
              저장
            </button>
            <button type="button" className="button" onClick={cancelSyncEditing}>
              취소
            </button>
          </div>
        </div>
      )
    }
    return (
      <div className="lyrics-sync-editor">
        <strong>
          선택 줄 {lines[selectedLineIndex]?.text || '가사 줄을 선택하세요'}
        </strong>
        <span>현재 재생 시간: {formatTime(currentTime)}</span>
        <div>
          {[-1000, -100, 100, 1000].map((delta) => (
            <button
              type="button"
              key={delta}
              onClick={() =>
                updateDraftSync({
                  offsetMs: draftSyncProfile.offsetMs + delta,
                })
              }
            >
              {delta > 0 ? '+' : ''}
              {delta}ms
            </button>
          ))}
        </div>
        <div>
          <button type="button" onClick={addSelectedAnchor}>
            선택 줄을 현재 시간에 맞추기
          </button>
          <button
            type="button"
            onClick={() =>
              updateDraftSync({
                anchors: draftSyncProfile.anchors.slice(0, -1),
              })
            }
            disabled={!draftSyncProfile.anchors.length}
          >
            마지막 기준점 삭제
          </button>
        </div>
        <small>
          기준점 {draftSyncProfile.anchors.length}개 · 오프셋{' '}
          {draftSyncProfile.offsetMs}ms
        </small>
        <div>
          <button
            type="button"
            className="button button--primary"
            onClick={() => void saveSync()}
          >
            저장
          </button>
          <button type="button" className="button" onClick={cancelSyncEditing}>
            취소
          </button>
        </div>
      </div>
    )
  }

  const renderInlineGeneratedEditor = () => {
    if (!inlineGeneratedEditing) return null
    const selectedTiming =
      inlineSelectedLineIndex === null
        ? undefined
        : generatedTimingByLine.get(inlineSelectedLineIndex)
    const selectedIssue =
      inlineSelectedLineIndex === null
        ? undefined
        : inlineDraftIssues.get(inlineSelectedLineIndex)
    return (
      <section className="generated-timeline-editor" data-generated-inline-editor>
        <div className="generated-timeline-editor__actions">
          <strong>줄별 timestamp 편집</strong>
          <div>
            <button
              type="button"
              className="button button--primary"
              data-generated-inline-save
              disabled={Boolean(inlineTimestampInputError || inlineDraftIssues.size)}
              onClick={() => void saveInlineGeneratedEditing()}
            >
              저장
            </button>
            <button
              type="button"
              className="button"
              data-generated-inline-cancel
              onClick={cancelInlineGeneratedEditing}
            >
              취소
            </button>
          </div>
        </div>
        {inlineSelectedLineIndex === null ? (
          <p>가사 줄을 선택해 timestamp를 수정하세요.</p>
        ) : (
          <>
            <strong>
              선택 줄 {inlineSelectedLineIndex + 1}: {plainLines[inlineSelectedLineIndex]}
            </strong>
            <label className="generated-timeline-editor__input">
              timestamp
              <input
                type="text"
                inputMode="numeric"
                placeholder="mm:ss.SSS"
                value={inlineTimestampInput}
                onChange={(event) => updateInlineTimestampInput(event.target.value)}
              />
            </label>
            <div className="generated-timeline-editor__controls">
              <button
                type="button"
                className="generated-timeline-editor__control"
                data-generated-inline-current
                onClick={setInlineGeneratedToCurrentTime}
              >
                현재 재생 위치로 지정
              </button>
              <button
                type="button"
                className="generated-timeline-editor__control"
                data-generated-inline-play
                disabled={!selectedTiming}
                onClick={() =>
                  selectedTiming &&
                  usePlayerStore
                    .getState()
                    .seek(selectedTiming.audioTimeMs / 1_000)
                }
              >
                이 시간부터 재생
              </button>
              {[-500, -100, 100, 500].map((delta) => (
                <button
                  type="button"
                  key={delta}
                  className="generated-timeline-editor__control"
                  data-generated-inline-adjust={delta}
                  disabled={!selectedTiming}
                  onClick={() => adjustInlineGeneratedTiming(delta)}
                >
                  {delta > 0 ? '+' : ''}
                  {delta / 1_000}초
                </button>
              ))}
              <button
                type="button"
                className="generated-timeline-editor__control generated-timeline-editor__control--danger"
                data-generated-inline-delete
                disabled={!selectedTiming}
                onClick={deleteInlineGeneratedTiming}
              >
                timestamp 삭제
              </button>
              <button
                type="button"
                className="generated-timeline-editor__control"
                data-generated-inline-clear-selection
                onClick={() => setInlineSelectedLineIndex(null)}
              >
                선택 해제
              </button>
            </div>
          </>
        )}
        {(inlineTimestampInputError || selectedIssue || inlineSaveError) && (
          <p className="generated-timeline-editor__error" role="alert">
            {inlineTimestampInputError || selectedIssue || inlineSaveError}
          </p>
        )}
        {inlineDraftIssues.size > 0 && (
          <p className="generated-timeline-editor__error" role="alert">
            시간 순서 또는 오디오 범위를 벗어난 줄이 있어 저장할 수 없습니다.
          </p>
        )}
      </section>
    )
  }

  if (!lyrics) return <div className="lyrics-loading">가사를 불러오는 중…</div>
  if (manualLyricsOpen)
    return (
      <ManualLyricsInputPanel
        applying={manualLyricsApplying}
        error={manualLyricsError}
        onApply={applyManualLyricsInput}
        onCancel={() => {
          if (manualLyricsApplying) return
          setManualLyricsError(null)
          setManualLyricsOpen(false)
        }}
      />
    )
  if (searchResult)
    return (
      <LyricsSearchPanel
        result={searchResult}
        loading={loading}
        searchTitle={searchTitle}
        searchArtist={searchArtist}
        searchMode={searchMode}
        searchProgress={searchProgress}
        searchElapsedMs={searchElapsedMs}
        onSearchTitleChange={setSearchTitle}
        onSearchArtistChange={setSearchArtist}
        onSearch={() => void search(searchMode)}
        onCleanSearch={() => void search(searchMode, true)}
        onSelect={(candidate) => void select(candidate)}
        selectingCandidateId={selectingCandidateId}
        onMarkInstrumental={() => void markInstrumental()}
        onImportFile={() => void importLyricsFile()}
        onOpenManualInput={() => {
          setManualLyricsError(null)
          setManualLyricsOpen(true)
        }}
        onClose={() => (loading ? cancelSearch() : setSearchResult(null))}
        onCancel={cancelSearch}
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
        searchMode="all"
        searchProgress={searchProgress}
        searchElapsedMs={searchElapsedMs}
        onSearchTitleChange={setSearchTitle}
        onSearchArtistChange={setSearchArtist}
        onSearch={() => void search('all')}
        onCleanSearch={() => void search('all', true)}
        onSelect={(candidate) => void select(candidate)}
        selectingCandidateId={selectingCandidateId}
        onMarkInstrumental={() => void markInstrumental()}
        onImportFile={() => void importLyricsFile()}
        onOpenManualInput={() => {
          setManualLyricsError(null)
          setManualLyricsOpen(true)
        }}
        onCancel={cancelSearch}
      />
    )
  if (lyrics.kind === 'text')
    return (
      <div
        className={
          activeGeneratedTimeline
            ? 'lyrics-synced lyrics-generated'
            : 'lyrics-text'
        }
        data-generated-timeline-active={
          activeGeneratedTimeline ? 'true' : 'false'
        }
        data-auto-sync-preview-active={
          autoSyncPreviewTimeline ? 'true' : 'false'
        }
        onWheel={() => {
          autoScrollPausedUntil.current = Date.now() + 4_000
        }}
        onPointerDown={() => {
          autoScrollPausedUntil.current = Date.now() + 4_000
        }}
      >
        <LyricsAppliedInfo
          lyrics={appliedLyrics}
          syncProfile={activeSyncProfile}
          generatedTimeline={activeGeneratedTimeline}
          previewing={autoSyncPreviewing}
        />
        <LyricsSearchActions
          onFindSynced={() => void search('synced', true)}
          onChooseOther={() => void search('all', true)}
          onImportFile={() => void importLyricsFile()}
          onOpenManualInput={() => {
            setManualLyricsError(null)
            setManualLyricsOpen(true)
          }}
        />
        <LyricsAutoSyncControls
          availability={autoSyncAvailability}
          job={autoSyncJob}
          confirming={autoSyncConfirming}
          starting={autoSyncStarting}
          previewing={autoSyncPreviewing}
          hasTimedLyrics={false}
          hasPlainLyrics={plainLines.length >= 2}
          manualEditing={syncEditing}
          editingAutoResult={autoSyncEditingJobId !== null}
          error={autoSyncUiError}
          onRequestStart={() => setAutoSyncConfirming(true)}
          onCloseConfirmation={() => setAutoSyncConfirming(false)}
          onStart={() => void startAutoSync()}
          onCancel={() => void cancelAutoSync()}
          onPreview={previewAutoSync}
          onOpenEditor={openAutoSyncInEditor}
          onApply={() => void applyAutoSync()}
          onDiscard={() => void discardAutoSync()}
        />
        {renderSyncEditor()}
        {generatedTimelineState.timeline && !generatedTimelineState.valid && (
          <p className="lyrics-sync-unavailable" role="alert">
            저장된 AI 타임라인과 현재 가사의 줄 또는 텍스트가 달라 적용하지
            않았습니다.
          </p>
        )}
        {(generatedTimelineState.timeline || activeGeneratedTimeline) && (
          <div className="lyrics-sync-status">
            <span>
              {autoSyncPreviewTimeline
                ? `AI 줄별 타임라인 미리보기 · ${autoSyncPreviewTimeline.lines.length}줄`
                : generatedTimelineState.valid &&
                    generatedTimelineState.timeline
                  ? `AI 줄별 타임라인 · ${generatedTimelineState.timeline.lines.length}줄`
                  : 'AI 줄별 타임라인 미적용'}
            </span>
            {generatedTimelineState.timeline && !autoSyncPreviewTimeline && (
              <div className="generated-timeline-status-actions">
                <button
                  type="button"
                  data-generated-timeline-reset
                  onClick={() => void resetGeneratedTimeline()}
                >
                  초기화
                </button>
                {!inlineGeneratedEditing && (
                  <button
                    type="button"
                    data-generated-timeline-edit
                    disabled={!generatedTimelineState.valid || syncEditing}
                    onClick={startInlineGeneratedEditing}
                  >
                    편집
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {renderInlineGeneratedEditor()}
        {activeGeneratedTimeline ? (
          generatedLines.map((line, index) => (
            <button
              type="button"
              key={`${index}-${line.text}`}
              ref={(element) => {
                lineRefs.current[index] = element
              }}
              className={`${index === activeIndex ? 'is-active ' : ''}${inlineSelectedLineIndex === index ? 'is-selected' : ''}`}
              data-generated-line-index={index}
              data-generated-line-timed={line.timing ? 'true' : 'false'}
              data-generated-line-source={
                generatedTimingSourceByLine.get(index) ??
                autoSyncLineTimingByLine.get(index)?.source ??
                'unmatched'
              }
              disabled={
                !line.timing &&
                !editingGeneratedTimeline &&
                !inlineGeneratedEditing
              }
              onClick={() => {
                if (inlineGeneratedEditing) selectInlineGeneratedLine(index)
                else if (editingGeneratedTimeline) setSelectedLineIndex(index)
                else if (line.timing)
                  usePlayerStore
                    .getState()
                    .seek(line.timing.audioTimeMs / 1_000)
              }}
              onDoubleClick={() => {
                if (inlineGeneratedEditing && line.timing)
                  usePlayerStore
                    .getState()
                    .seek(line.timing.audioTimeMs / 1_000)
              }}
            >
              {inlineGeneratedEditing && (
                <span className="generated-lyric-line__timing">
                  {line.timing
                    ? formatGeneratedTimestamp(line.timing.audioTimeMs)
                    : '--:--.---'}
                </span>
              )}
              <span className="generated-lyric-line__text">{line.text}</span>
              {inlineGeneratedEditing && (
                <small
                  className="generated-lyric-line__source"
                  title={formatGeneratedTimingSource(
                    generatedTimingSourceByLine.get(index) ??
                      autoSyncLineTimingByLine.get(index)?.source ??
                      'unmatched',
                  )}
                >
                  {formatGeneratedTimingSource(
                    generatedTimingSourceByLine.get(index) ??
                      autoSyncLineTimingByLine.get(index)?.source ??
                      'unmatched',
                  )}
                  {inlineDraftIssues.get(index) && ' · 시간 오류'}
                </small>
              )}
            </button>
          ))
        ) : (
          <>
            <p className="lyrics-sync-unavailable">
              줄별 타임라인을 적용하면 현재 줄 강조와 자동 스크롤을 사용할 수
              있습니다.
            </p>
            <div className="lyrics-text__content">{lyrics.content}</div>
          </>
        )}
      </div>
    )
  return (
    <div
      className="lyrics-synced"
      data-auto-sync-preview-active={autoSyncPreviewProfile ? 'true' : 'false'}
      onWheel={() => {
        autoScrollPausedUntil.current = Date.now() + 4_000
      }}
      onPointerDown={() => {
        autoScrollPausedUntil.current = Date.now() + 4_000
      }}
    >
      <LyricsAppliedInfo
        lyrics={appliedLyrics}
        syncProfile={activeSyncProfile}
        previewing={autoSyncPreviewing}
      />
      <LyricsSearchActions
        onFindSynced={() => void search('synced', true)}
        onChooseOther={() => void search('all', true)}
        onImportFile={() => void importLyricsFile()}
        onOpenManualInput={() => {
          setManualLyricsError(null)
          setManualLyricsOpen(true)
        }}
      />
      <LyricsAutoSyncControls
        availability={autoSyncAvailability}
        job={autoSyncJob}
        confirming={autoSyncConfirming}
        starting={autoSyncStarting}
        previewing={autoSyncPreviewing}
        hasTimedLyrics={rawLines.length > 0}
        hasPlainLyrics={false}
        manualEditing={syncEditing}
        editingAutoResult={autoSyncEditingJobId !== null}
        error={autoSyncUiError}
        onRequestStart={() => setAutoSyncConfirming(true)}
        onCloseConfirmation={() => setAutoSyncConfirming(false)}
        onStart={() => void startAutoSync()}
        onCancel={() => void cancelAutoSync()}
        onPreview={previewAutoSync}
        onOpenEditor={openAutoSyncInEditor}
        onApply={() => void applyAutoSync()}
        onDiscard={() => void discardAutoSync()}
      />
      <div className="lyrics-sync-status">
        {syncStatusCopy(activeSyncProfile, autoSyncPreviewing)}
        {(savedSyncProfile || syncEditing) &&
          autoSyncEditingJobId === null &&
          autoSyncPreviewProfile === null && (
            <button type="button" onClick={() => void resetSync()}>
              초기화
            </button>
          )}
      </div>
      <button
        type="button"
        className="button lyrics-sync-trigger"
        onClick={toggleSyncEditing}
      >
        가사 싱크 맞추기
      </button>
      {syncEditing && (
        <div className="lyrics-sync-editor">
          <strong>
            선택 줄: {lines[selectedLineIndex]?.text || '가사 줄을 선택하세요'}
          </strong>
          <span>현재 재생 시간: {formatTime(currentTime)}</span>
          <div>
            {[-1000, -100, 100, 1000].map((delta) => (
              <button
                type="button"
                key={delta}
                onClick={() =>
                  updateDraftSync({
                    offsetMs: draftSyncProfile.offsetMs + delta,
                  })
                }
              >
                {delta > 0 ? '+' : ''}
                {delta}ms
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
                updateDraftSync({
                  anchors: draftSyncProfile.anchors.slice(0, -1),
                })
              }
              disabled={!draftSyncProfile.anchors.length}
            >
              마지막 기준점 삭제
            </button>
          </div>
          <small>
            기준점 {draftSyncProfile.anchors.length}개 · 오프셋{' '}
            {draftSyncProfile.offsetMs}ms
          </small>
          <div>
            <button
              type="button"
              className="button button--primary"
              onClick={() => void saveSync()}
            >
              저장
            </button>
            <button
              type="button"
              className="button"
              onClick={cancelSyncEditing}
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
          data-synced-line-index={index}
          data-synced-line-time={line.time}
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

const searchProgressCopy: Record<LyricsSearchProgress, string> = {
  preparing: '검색 준비 중',
  lrclib: 'LRCLIB 검색 중',
  'lyrica-connecting': 'Lyrica 서버 연결 중',
  'lyrica-searching': 'Lyrica 다중 소스 검색 중',
  organizing: '후보 정리 중',
}

const autoSyncStageCopy: Record<AutoSyncStage, string> = {
  preparing: '준비 중',
  separating: '보컬 분리 중',
  'releasing-separator': '보컬 모델 정리 중',
  transcribing: 'Whisper 분석 중',
  matching: '가사 줄 매칭 중',
  'building-anchors': '기준점 생성 중',
  validating: '결과 검증 중',
}

const autoSyncRequirementCopy: Record<string, string> = {
  service: '자동 싱크 서비스',
  python: 'Python 실행 환경',
  'python-packages': '필수 Python 패키지',
  cuda: 'CUDA',
  'nvidia-gpu': 'NVIDIA GPU',
  'separator-checkpoint': 'BS-RoFormer 체크포인트',
  'separator-config': 'BS-RoFormer 모델 설정',
  'whisper-model': 'Whisper large-v3 로컬 모델',
  ffmpeg: 'FFmpeg',
  'poc-script': '자동 싱크 PoC 스크립트',
  'cache-write': '작업·캐시 폴더 쓰기 권한',
  track: '현재 곡 정보',
  audio: '원본 오디오 파일',
  'plain-lyrics': '두 줄 이상의 일반 가사',
  'synced-lyrics': '원본 타임스탬프가 있는 동기화 가사',
  'job-active': '다른 자동 싱크 작업',
}

function autoSyncMissingRequirements(requirements: string[]) {
  return requirements
    .map((requirement) =>
      requirement.startsWith('python-package:')
        ? `Python 패키지 ${requirement.slice('python-package:'.length)}`
        : (autoSyncRequirementCopy[requirement] ?? requirement),
    )
    .join(' · ')
}

interface LyricsAutoSyncControlsProps {
  availability: AutoSyncAvailability | null
  job: AutoSyncJob | null
  confirming: boolean
  starting: boolean
  previewing: boolean
  hasTimedLyrics: boolean
  hasPlainLyrics: boolean
  manualEditing: boolean
  editingAutoResult: boolean
  error: string | null
  onRequestStart: () => void
  onCloseConfirmation: () => void
  onStart: () => void
  onCancel: () => void
  onPreview: () => void
  onOpenEditor: () => void
  onApply: () => void
  onDiscard: () => void
}

function LyricsAutoSyncControls({
  availability,
  job,
  confirming,
  starting,
  previewing,
  hasTimedLyrics,
  hasPlainLyrics,
  manualEditing,
  editingAutoResult,
  error,
  onRequestStart,
  onCloseConfirmation,
  onStart,
  onCancel,
  onPreview,
  onOpenEditor,
  onApply,
  onDiscard,
}: LyricsAutoSyncControlsProps) {
  const [now, setNow] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const restoreTriggerFocus = useRef(false)
  const running = job?.status === 'running'
  useEffect(() => {
    if (confirming) {
      restoreTriggerFocus.current = true
      return
    }
    if (!restoreTriggerFocus.current) return
    restoreTriggerFocus.current = false
    triggerRef.current?.focus()
  }, [confirming])
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [running, job?.jobId])

  const result = job?.status === 'completed' ? job.result : undefined
  const hasSupportedLyrics = hasTimedLyrics || hasPlainLyrics
  const generatedResult = Boolean(result?.generatedLyricsTimeline)
  const previewTimestampCount = result
    ? result.lineTimings.filter((line) => line.audioTimeMs !== null).length ||
      result.generatedLyricsTimeline?.lines.length ||
      result.lyricsSyncProfile.anchors.length
    : 0
  const canOpenEditor = Boolean(
    result && !running && !starting && !manualEditing && previewTimestampCount > 0,
  )
  const overallProgress = autoSyncProgressPercent(job?.overallProgress ?? null)
  const stageProgress = autoSyncProgressPercent(job?.stageProgress ?? null)
  const elapsedMs = job
    ? running
      ? Math.max(
          job.elapsedMs,
          job.elapsedMs + Math.max(0, (now || job.updatedAt) - job.updatedAt),
        )
      : job.elapsedMs
    : 0
  const canStart = Boolean(
    availability?.available &&
    hasSupportedLyrics &&
    !job &&
    !manualEditing &&
    !starting,
  )
  const availabilityCopy = manualEditing
    ? '가사 싱크 편집을 저장하거나 취소한 뒤 시작할 수 있습니다.'
    : starting
      ? '실행 환경을 다시 확인하고 있습니다.'
      : job?.status === 'running'
        ? '현재 곡의 자동 싱크를 분석하고 있습니다.'
        : job?.status === 'completed'
          ? '현재 결과를 적용하거나 버린 뒤 새 분석을 시작할 수 있습니다.'
          : job?.status === 'failed'
            ? '오류 결과를 닫은 뒤 다시 시도할 수 있습니다.'
            : !availability
              ? '자동 싱크 실행 환경을 확인하는 중…'
              : !availability.available
                ? [
                    availability.reason ||
                      '자동 싱크 실행 환경이 준비되지 않았습니다.',
                    autoSyncMissingRequirements(
                      availability.missingRequirements,
                    ),
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : !hasSupportedLyrics
                  ? '두 줄 이상의 일반 가사 또는 동기화 가사가 필요합니다.'
                  : [availability.gpuName, availability.modelName]
                      .filter(Boolean)
                      .join(' · ') || '자동 싱크를 사용할 수 있습니다.'

  return (
    <section className="lyrics-auto-sync" aria-label="AI 자동 싱크">
      <button
        ref={triggerRef}
        type="button"
        className="button lyrics-auto-sync__trigger"
        data-auto-sync-trigger
        disabled={!canStart}
        aria-describedby="lyrics-auto-sync-availability"
        onClick={onRequestStart}
      >
        AI 자동 싱크 생성
      </button>
      <small
        id="lyrics-auto-sync-availability"
        className={
          availability && !availability.available
            ? 'lyrics-auto-sync__availability is-unavailable'
            : 'lyrics-auto-sync__availability'
        }
        data-auto-sync-availability={
          availability?.available && hasSupportedLyrics
            ? 'available'
            : 'unavailable'
        }
      >
        {availabilityCopy}
      </small>

      {error && error !== job?.error?.message && (
        <div
          className="lyrics-auto-sync-card lyrics-auto-sync-card--error"
          role="alert"
          data-auto-sync-error
        >
          {error}
        </div>
      )}

      {starting && !job && (
        <div
          className="lyrics-auto-sync-card lyrics-auto-sync-progress"
          data-auto-sync-progress
          data-auto-sync-stage="preparing"
        >
          <div className="lyrics-auto-sync-card__heading">
            <strong aria-live="polite">준비 중</strong>
            <span>환경 재확인</span>
          </div>
          <progress aria-label="AI 자동 싱크 실행 환경 확인 중" />
          <p>Python, CUDA, 모델 및 FFmpeg를 확인하고 있습니다.</p>
        </div>
      )}

      {running && job && (
        <div
          className="lyrics-auto-sync-card lyrics-auto-sync-progress"
          data-auto-sync-progress
          data-auto-sync-stage={job.stage}
        >
          <div className="lyrics-auto-sync-card__heading">
            <strong aria-live="polite" aria-atomic="true">
              {autoSyncStageCopy[job.stage]}
            </strong>
            <span>
              {overallProgress === null
                ? '전체 진행률 계산 중'
                : `${overallProgress}%`}
            </span>
          </div>
          <progress
            max="100"
            value={overallProgress ?? undefined}
            aria-label="AI 자동 싱크 전체 진행률"
          />
          <dl>
            <div>
              <dt>단계 진행률</dt>
              <dd>
                {stageProgress === null ? '계산 중' : `${stageProgress}%`}
              </dd>
            </div>
            <div>
              <dt>완료 단계</dt>
              <dd>
                {job.completedStages} / {job.totalStages}
              </dd>
            </div>
            <div>
              <dt>경과 시간</dt>
              <dd>{formatAutoSyncElapsed(elapsedMs)}</dd>
            </div>
            <div>
              <dt>현재 모델</dt>
              <dd>{job.modelName ?? availability?.modelName ?? '확인 중'}</dd>
            </div>
          </dl>
          {job.message && <p aria-live="polite">{job.message}</p>}
          <div className="lyrics-auto-sync-actions">
            <button
              type="button"
              className="button"
              data-auto-sync-cancel
              onClick={onCancel}
            >
              취소
            </button>
          </div>
        </div>
      )}

      {job?.status === 'failed' && (
        <div
          className="lyrics-auto-sync-card lyrics-auto-sync-card--error"
          role="alert"
          data-auto-sync-error
        >
          <strong>자동 싱크를 완료하지 못했습니다.</strong>
          <p>
            {job.error?.message ??
              '분석 프로세스가 비정상적으로 종료되었습니다.'}
          </p>
          <div className="lyrics-auto-sync-actions">
            <button type="button" className="button" onClick={onDiscard}>
              오류 닫기
            </button>
          </div>
        </div>
      )}

      {job?.status === 'completed' && !result && (
        <div
          className="lyrics-auto-sync-card lyrics-auto-sync-card--error"
          role="alert"
          data-auto-sync-error
        >
          완료된 자동 싱크 결과를 읽을 수 없습니다.
        </div>
      )}

      {result && (
        <div
          className="lyrics-auto-sync-card lyrics-auto-sync-result"
          data-auto-sync-result
          data-auto-sync-quality={result.canApply ? 'accepted' : 'low'}
        >
          <div className="lyrics-auto-sync-card__heading">
            <strong>AI 자동 싱크 초안</strong>
            <span>{result.cacheHit ? '캐시 재사용' : '새 분석'}</span>
          </div>
          {previewing && (
            <p className="lyrics-auto-sync-preview-note" aria-live="polite">
              미리보기 중입니다. 이 결과는 아직 저장되지 않았습니다.
            </p>
          )}
          {editingAutoResult && (
            <p className="lyrics-auto-sync-preview-note" aria-live="polite">
              아래 수동 편집기에서 AI 초안을 수정하고 있습니다.
            </p>
          )}
          <dl>
            <div>
              <dt>매칭</dt>
              <dd>
                {result.matchedLines} / {result.totalLines}줄
              </dd>
            </div>
            <div>
              <dt>매칭률</dt>
              <dd>{formatAutoSyncPercent(result.matchRate)}</dd>
            </div>
            <div>
              <dt>평균 텍스트 신뢰도</dt>
              <dd>{formatAutoSyncPercent(result.confidence)} (정답률 아님)</dd>
            </div>
            <div>
              <dt>생성 기준점</dt>
              <dd>
                {result.generatedLyricsTimeline
                  ? `${result.generatedLyricsTimeline.lines.length}개 줄별 시간`
                  : `${result.lyricsSyncProfile.anchors.length}개`}
              </dd>
            </div>
            <div>
              <dt>매칭되지 않은 줄</dt>
              <dd>{result.unmatchedLines.length}개</dd>
            </div>
            <div>
              <dt>시간 outlier 제거</dt>
              <dd>{result.temporalOutlierLines.length}개</dd>
            </div>
            <div>
              <dt>처리 시간</dt>
              <dd>{formatAutoSyncElapsed(result.processingTimeMs)}</dd>
            </div>
            <div>
              <dt>peak GPU 메모리</dt>
              <dd>
                {result.peakGpuMemoryMiB === null
                  ? '측정 안 됨'
                  : `${result.peakGpuMemoryMiB.toLocaleString()} MiB`}
              </dd>
            </div>
            <div>
              <dt>사용 모델</dt>
              <dd>
                {result.model.separator} · {result.model.whisper}
              </dd>
            </div>
          </dl>
          {result.lowConfidenceLines.length > 0 && (
            <details className="lyrics-auto-sync-low-confidence">
              <summary>
                낮은 신뢰도 줄 {result.lowConfidenceLines.length}개
              </summary>
              <ol>
                {result.lowConfidenceLines.slice(0, 20).map((line) => (
                  <li key={`${line.lineIndex}-${line.confidence}`}>
                    {line.lineIndex + 1}번째 줄 ·{' '}
                    {formatAutoSyncPercent(line.confidence)}
                  </li>
                ))}
              </ol>
            </details>
          )}
          {!result.canApply && (
            <p className="lyrics-auto-sync-quality-warning" role="alert">
              {result.qualityMessage ||
                '자동 싱크 초안의 신뢰도가 너무 낮습니다.'}
            </p>
          )}
          <div className="lyrics-auto-sync-actions">
            <button
              type="button"
              className="button"
              data-auto-sync-preview
              data-auto-sync-previewing={previewing ? 'true' : 'false'}
              disabled={
                manualEditing ||
                (generatedResult ? !hasPlainLyrics : !hasTimedLyrics)
              }
              onClick={onPreview}
            >
              {previewing ? '미리 듣기 종료' : '미리 듣기'}
            </button>
            <button
              type="button"
              className="button"
              data-auto-sync-edit
              data-auto-sync-editable-timestamps={previewTimestampCount}
              disabled={!canOpenEditor}
              onClick={onOpenEditor}
            >
              수동 싱크 편집기로 열기
            </button>
            <button
              type="button"
              className="button button--primary"
              data-auto-sync-apply
              disabled={
                !result.canApply ||
                manualEditing ||
                (generatedResult ? !hasPlainLyrics : !hasTimedLyrics)
              }
              onClick={onApply}
            >
              적용
            </button>
            <button
              type="button"
              className="button"
              data-auto-sync-discard
              disabled={manualEditing}
              onClick={onDiscard}
            >
              결과 버리기
            </button>
          </div>
        </div>
      )}

      {confirming && (
        <div
          className="modal-backdrop"
          role="presentation"
          data-auto-sync-confirmation
        >
          <section
            ref={dialogRef}
            className="modal lyrics-auto-sync-confirmation"
            role="dialog"
            aria-modal="true"
            aria-labelledby="lyrics-auto-sync-confirm-title"
            aria-describedby="lyrics-auto-sync-confirm-description"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                onCloseConfirmation()
                return
              }
              if (event.key !== 'Tab') return
              const focusable = [
                ...(dialogRef.current?.querySelectorAll<HTMLElement>(
                  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
                ) ?? []),
              ]
              const first = focusable[0]
              const last = focusable.at(-1)
              if (!first || !last) return
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault()
                last.focus()
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault()
                first.focus()
              }
            }}
          >
            <h2 id="lyrics-auto-sync-confirm-title">
              AI 자동 싱크를 생성할까요?
            </h2>
            <div id="lyrics-auto-sync-confirm-description">
              <ul>
                <li>보컬 분리와 음성 분석을 수행합니다.</li>
                <li>RTX 3060에서 약 1~2분 걸릴 수 있습니다.</li>
                <li>처리 중 GPU 사용률이 높아질 수 있습니다.</li>
                <li>생성 결과는 바로 저장되지 않고 미리보기로 제공됩니다.</li>
              </ul>
            </div>
            <div className="lyrics-auto-sync-confirmation__actions">
              <button
                type="button"
                className="button"
                data-auto-sync-confirm-cancel
                autoFocus
                onClick={onCloseConfirmation}
              >
                취소
              </button>
              <button
                type="button"
                className="button button--primary"
                data-auto-sync-confirm-start
                onClick={onStart}
              >
                분석 시작
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  )
}

function autoSyncProfile(result: AutoSyncResult): LyricsSyncProfile {
  return {
    ...result.lyricsSyncProfile,
    updatedAt: Date.now(),
    source: 'ai',
    autoSyncMetadata: {
      model: `${result.model.separator} · ${result.model.whisper}`,
      matchedLines: result.matchedLines,
      totalLines: result.totalLines,
      confidence: result.confidence,
      processingTimeMs: result.processingTimeMs,
    },
  }
}

function generatedTimelineFromAutoSyncResult(
  result: AutoSyncResult,
  lines: string[],
): GeneratedLyricsTimeline {
  const fallbackTimings = result.generatedLyricsTimeline?.lines ?? []
  const previewTimings = result.lineTimings.length
    ? result.lineTimings
        .filter(
          (line) =>
            line.audioTimeMs !== null &&
            line.lineIndex >= 0 &&
            line.lineIndex < lines.length,
        )
        .map((line) => ({
          lineIndex: line.lineIndex,
          textHash: generatedLyricsLineHash(lines[line.lineIndex]),
          audioTimeMs: line.audioTimeMs!,
          confidence: line.confidence,
          source: line.source,
        }))
    : fallbackTimings
  return {
    trackId: result.trackId,
    source: 'ai',
    lines: previewTimings.sort((left, right) => left.lineIndex - right.lineIndex),
    lineCount: lines.length,
    lyricsTextHash: generatedLyricsTextHash(lines.join('\n')),
    model: result.generatedLyricsTimeline?.model,
    createdAt: Date.now(),
  }
}

function formatGeneratedTimestamp(milliseconds: number): string {
  const totalMilliseconds = Math.max(0, Math.round(milliseconds))
  const minutes = Math.floor(totalMilliseconds / 60_000)
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1_000)
  const remainder = totalMilliseconds % 1_000
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(remainder).padStart(3, '0')}`
}

function parseGeneratedTimestamp(value: string): number | null {
  const match = /^(\d+):([0-5]\d)\.(\d{3})$/.exec(value.trim())
  if (!match) return null
  const milliseconds =
    Number(match[1]) * 60_000 + Number(match[2]) * 1_000 + Number(match[3])
  return Number.isSafeInteger(milliseconds) ? milliseconds : null
}

function validateGeneratedTimelineDraft(
  timeline: GeneratedLyricsTimeline | null,
  durationSeconds: number | null,
): Map<number, string> {
  const issues = new Map<number, string>()
  if (!timeline) return issues
  const maximumMs =
    durationSeconds !== null && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? Math.round(durationSeconds * 1_000)
      : null
  let previousValidTimeMs: number | null = null
  for (const line of [...timeline.lines].sort(
    (left, right) => left.lineIndex - right.lineIndex,
  )) {
    if (!Number.isInteger(line.audioTimeMs) || line.audioTimeMs < 0) {
      issues.set(line.lineIndex, '음수 timestamp는 사용할 수 없습니다.')
      continue
    }
    if (maximumMs !== null && line.audioTimeMs > maximumMs) {
      issues.set(line.lineIndex, '오디오 길이를 초과했습니다.')
      continue
    }
    if (
      previousValidTimeMs !== null &&
      line.audioTimeMs <= previousValidTimeMs
    ) {
      issues.set(line.lineIndex, '이전 유효 줄보다 늦어야 합니다.')
      continue
    }
    previousValidTimeMs = line.audioTimeMs
  }
  return issues
}

function generatedTimelineSignature(timeline: GeneratedLyricsTimeline): string {
  return JSON.stringify({
    trackId: timeline.trackId,
    source: timeline.source,
    lines: [...timeline.lines].sort((left, right) => left.lineIndex - right.lineIndex),
    lineCount: timeline.lineCount,
    lyricsTextHash: timeline.lyricsTextHash,
    model: timeline.model,
  })
}

function formatGeneratedTimingSource(source: string): string {
  const labels: Record<string, string> = {
    direct: '직접 매칭',
    segment_recovered: 'segment 복구',
    interpolated: '보간',
    local_retry: '국소 재시도',
    unmatched: '미매칭',
    manual: '수동 수정',
  }
  return labels[source] ?? source
}

function autoSyncProgressPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null
  const percent = Math.abs(value) <= 1 ? value * 100 : value
  return Math.round(Math.max(0, Math.min(100, percent)))
}

function formatAutoSyncPercent(value: number) {
  const percent = Math.abs(value) <= 1 ? value * 100 : value
  return `${Math.max(0, Math.min(100, percent)).toFixed(1)}%`
}

function formatAutoSyncElapsed(value: number) {
  const totalSeconds = Math.max(0, Math.floor(value / 1_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes ? `${minutes}분 ${seconds}초` : `${seconds}초`
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function LyricsAppliedInfo({
  lyrics,
  syncProfile,
  generatedTimeline,
  previewing = false,
}: {
  lyrics?: TrackLyrics
  syncProfile: LyricsSyncProfile | null
  generatedTimeline?: GeneratedLyricsTimeline | null
  previewing?: boolean
}) {
  const isVideoSubtitle = Boolean(
    lyrics?.provider === 'lyrica' &&
    lyrics.providerSource &&
    ['youtube_transcript', 'youtube_captions', 'youtube_subtitles'].includes(
      lyrics.providerSource,
    ),
  )
  const source = formatLyricsSource(
    lyrics?.sourceLabel ??
    (lyrics?.provider === 'lyrica' || lyrics?.source === 'lyrica'
      ? 'Lyrica'
      : lyrics?.source === 'lrclib'
        ? 'LRCLIB'
        : lyrics?.source === 'local-lrc'
          ? '로컬 LRC'
        : lyrics?.source === 'local-txt'
          ? '로컬 텍스트'
          : lyrics?.source === 'imported-lrc'
            ? '가져온 LRC 파일'
            : lyrics?.source === 'imported-text'
              ? '가져온 텍스트 파일'
              : lyrics?.source === 'manual-input'
                ? '직접 입력한 가사'
                : '사용자 가사'),
    lyrics?.alternateSourceLabels,
  )
  const sync = generatedTimeline
    ? previewing
      ? 'AI 줄별 타임스탬프 미리보기'
      : 'AI 줄별 타임스탬프'
    : isVideoSubtitle
      ? '현재 영상 타임스탬프'
      : lyrics?.syncedLyrics
        ? '원곡 타임스탬프'
        : '타임스탬프 없음'

  return (
    <div className="lyrics-applied-info" aria-label="현재 적용된 가사 정보">
      <span>가사 출처: {source}</span>
      <span>싱크: {sync}</span>
      <span>
        사용자 보정:{' '}
        {generatedTimeline
          ? `${generatedTimeline.lines.length}개 줄별 시간`
          : syncCorrectionCopy(syncProfile, previewing)}
      </span>
    </div>
  )
}

function formatLyricsSource(primary: string, alternate: string[] = []) {
  const labels = [primary, ...alternate].filter(Boolean)
  if (labels.length < 2) return labels[0] || '사용자 가사'
  return labels.join(primary.startsWith('Lyrica') ? ' + ' : ' · ')
}

function syncCorrectionCopy(
  profile: LyricsSyncProfile | null,
  previewing = false,
) {
  if (!profile || (!profile.anchors.length && profile.offsetMs === 0))
    return '없음'
  const offset = `${profile.offsetMs >= 0 ? '+' : ''}${(profile.offsetMs / 1_000).toFixed(1)}초`
  const source = previewing
    ? 'AI 미리보기 · '
    : profile.source === 'ai'
      ? 'AI 자동 싱크 · '
      : ''
  return `${source}기준점 ${profile.anchors.length}개 · 오프셋 ${offset}`
}

function syncStatusCopy(profile: LyricsSyncProfile | null, previewing = false) {
  if (!profile) return '원본 싱크'
  if (previewing)
    return `AI 자동 싱크 미리보기 · 기준점 ${profile.anchors.length}개`
  if (profile.source === 'ai')
    return `AI 자동 싱크 · 기준점 ${profile.anchors.length}개`
  if (profile.anchors.length >= 3)
    return `사용자 구간 보정 ${profile.anchors.length}개`
  if (profile.anchors.length >= 1)
    return `사용자 기준점 ${profile.anchors.length}개`
  return `사용자 보정 ${profile.offsetMs >= 0 ? '+' : ''}${(profile.offsetMs / 1_000).toFixed(1)}초`
}

function ManualLyricsInputPanel({
  applying,
  error,
  onApply,
  onCancel,
}: {
  applying: boolean
  error: string | null
  onApply: (content: string) => void
  onCancel: () => void
}) {
  const [content, setContent] = useState('')
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal manual-lyrics-input"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-lyrics-input-title"
      >
        <h2 id="manual-lyrics-input-title">가사 직접 입력</h2>
        <p>
          LRC timestamp가 있으면 동기화 가사로, 없으면 일반 가사로 저장합니다.
        </p>
        <textarea
          autoFocus
          data-manual-lyrics-textarea
          value={content}
          maxLength={2_000_000}
          placeholder={'[00:15.200]첫 번째 줄\n[00:20.500]두 번째 줄\n\n또는 일반 가사를 붙여넣으세요.'}
          onChange={(event) => setContent(event.target.value)}
        />
        {error && <p className="manual-lyrics-input__error" role="alert">{error}</p>}
        <div>
          <button
            type="button"
            className="button button--primary"
            data-manual-lyrics-apply
            disabled={applying || !content.trim()}
            onClick={() => onApply(content)}
          >
            {applying ? '적용 중…' : '적용'}
          </button>
          <button
            type="button"
            className="button"
            data-manual-lyrics-cancel
            disabled={applying}
            onClick={onCancel}
          >
            취소
          </button>
        </div>
      </section>
    </div>
  )
}

function LyricsSearchActions({
  onFindSynced,
  onChooseOther,
  onImportFile,
  onOpenManualInput,
}: {
  onFindSynced: () => void
  onChooseOther: () => void
  onImportFile: () => void
  onOpenManualInput: () => void
}) {
  return (
    <div className="lyrics-search-actions-inline">
      <button
        type="button"
        className="button button--primary"
        data-lyrics-search-mode="synced"
        onClick={onFindSynced}
      >
        동기화 가사 찾기
      </button>
      <button
        type="button"
        className="button"
        data-lyrics-search-mode="all"
        onClick={onChooseOther}
      >
        다른 가사 선택
      </button>
      <button
        type="button"
        className="button"
        data-lyrics-import-file
        onClick={onImportFile}
      >
        파일에서 가져오기
      </button>
      <button
        type="button"
        className="button"
        data-lyrics-manual-input
        onClick={onOpenManualInput}
      >
        직접 입력
      </button>
    </div>
  )
}

interface LyricsSearchPanelProps {
  result: LyricsSearchResult
  loading: boolean
  searchTitle: string
  searchArtist: string
  searchMode: LyricsSearchMode
  searchProgress: LyricsSearchProgress
  searchElapsedMs: number
  onSearchTitleChange: (value: string) => void
  onSearchArtistChange: (value: string) => void
  onSearch: () => void
  onCleanSearch: () => void
  onSelect: (candidate: LyricsCandidate) => void
  selectingCandidateId: number | null
  onMarkInstrumental: () => void
  onImportFile: () => void
  onOpenManualInput: () => void
  onCancel: () => void
  onClose?: () => void
}

const providerAttemptCopy = {
  success: '후보를 확인했습니다.',
  'not-found': '검색 결과가 없습니다.',
  'network-error': '서버에 연결하지 못했습니다.',
  timeout: '응답 시간이 초과되었습니다.',
  'rate-limited': '요청이 일시적으로 제한되었습니다.',
  'invalid-response': '응답을 처리하지 못했습니다.',
  'server-error': '서버에 일시적인 문제가 있습니다.',
} as const

function providerName(provider: 'lyrica' | 'lrclib') {
  return provider === 'lyrica' ? 'Lyrica' : 'LRCLIB'
}

function LyricsSearchPanel({
  result,
  loading,
  searchTitle,
  searchArtist,
  searchMode,
  searchProgress,
  searchElapsedMs,
  onSearchTitleChange,
  onSearchArtistChange,
  onSearch,
  onCleanSearch,
  onSelect,
  selectingCandidateId,
  onMarkInstrumental,
  onImportFile,
  onOpenManualInput,
  onCancel,
  onClose,
}: LyricsSearchPanelProps) {
  const candidates =
    searchMode === 'synced'
      ? [...result.candidates].sort(
          (left, right) =>
            Number(Boolean(right.syncedLyrics)) -
            Number(Boolean(left.syncedLyrics)),
        )
      : result.candidates
  const hasSyncedCandidate = result.candidates.some((candidate) =>
    Boolean(candidate.syncedLyrics),
  )
  const providerAttempts = result.providerAttempts ?? []
  const searchFailed = !loading && !candidates.length
  const elapsedSeconds = Math.floor(searchElapsedMs / 1_000)
  const timedOut = searchElapsedMs >= 45_000 && !candidates.length
  const resultStatus = timedOut
    ? '공개 가사 서버의 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.'
    : result.status === 'not-found'
      ? '가사를 찾지 못했습니다.'
      : result.status === 'network-error'
        ? '가사 서버에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.'
        : statusCopy[result.status]

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
      {loading ? (
        <div
          className="lyrics-search-progress"
          data-lyrics-search-progress={searchProgress}
          aria-live="polite"
        >
          <strong>
            {searchMode === 'synced' ? '동기화 가사 찾기' : '다른 가사 선택'}
          </strong>
          <span>
            {searchProgressCopy[searchProgress]} · {elapsedSeconds}초 경과
          </span>
          <small>
            공개 가사 서버를 깨우는 중입니다. 첫 검색은 최대 30초 정도 걸릴 수
            있습니다.
          </small>
        </div>
      ) : (
        <p className="lyrics-search-status">
          {searchMode === 'synced' &&
          result.candidates.length > 0 &&
          !hasSyncedCandidate
            ? '동기화 가사를 찾지 못했습니다. 현재 일반 가사는 계속 사용할 수 있습니다.'
            : resultStatus}
        </p>
      )}
      {searchFailed && providerAttempts.length > 0 && (
        <section className="lyrics-provider-status" data-lyrics-provider-status>
          <strong>검색한 공급자</strong>
          <ul>
            {providerAttempts.map((attempt) => (
              <li key={attempt.provider} data-lyrics-provider={attempt.provider}>
                <span aria-hidden="true">✓</span>
                <b>{providerName(attempt.provider)}</b>
                <small>{providerAttemptCopy[attempt.status]}</small>
              </li>
            ))}
          </ul>
          <p>동기화 가사를 찾지 못했습니다.</p>
          <p>추천: LRC 파일 가져오기, TXT/직접 입력, AI 자동 싱크 생성</p>
        </section>
      )}
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
        {searchFailed && (
          <>
            <button
              type="button"
              className="button button--primary"
              data-lyrics-import-file
              onClick={onImportFile}
            >
              파일에서 가져오기
            </button>
            <button
              type="button"
              className="button"
              data-lyrics-manual-input
              onClick={onOpenManualInput}
            >
              직접 입력
            </button>
          </>
        )}
        <button
          type="button"
          className={`button${searchFailed ? '' : ' button--primary'}`}
          data-lyrics-search-submit
          disabled={loading}
          onClick={onSearch}
        >
          {loading ? '검색 중…' : searchFailed ? '다시 검색' : '검색'}
        </button>
        <button
          type="button"
          className="button"
          disabled={loading}
          onClick={onCleanSearch}
        >
          현재 제목 정리해서 다시 검색
        </button>
        <button
          type="button"
          className="button"
          disabled={loading}
          onClick={onMarkInstrumental}
        >
          연주곡으로 표시
        </button>
        {!searchFailed && (
          <>
            <button
              type="button"
              className="button"
              data-lyrics-import-file
              disabled={loading}
              onClick={onImportFile}
            >
              파일에서 가져오기
            </button>
            <button
              type="button"
              className="button"
              data-lyrics-manual-input
              disabled={loading}
              onClick={onOpenManualInput}
            >
              직접 입력
            </button>
          </>
        )}
        {loading && (
          <button
            type="button"
            className="button"
            data-lyrics-search-cancel
            onClick={onCancel}
          >
            취소
          </button>
        )}
      </div>
      {candidates.length > 0 && (
        <div className="lyrics-candidate-list">
          {candidates.map((candidate) => (
            <div
              className="lyrics-candidate"
              key={`${candidate.provider ?? 'lrclib'}:${candidate.id}`}
              data-lyrics-synced={candidate.syncedLyrics ? 'true' : 'false'}
            >
              <div className="lyrics-candidate__content">
                <strong>{candidate.trackName}</strong>
                <span>{candidate.artistName}</span>
                <small>
                  {formatLyricsSource(
                    candidate.sourceLabel ??
                      (candidate.provider === 'lyrica' ? 'Lyrica' : 'LRCLIB'),
                    candidate.alternateSourceLabels,
                  )}
                </small>
                <small>
                  {candidate.albumName || '앨범 정보 없음'} ·{' '}
                  {candidate.duration
                    ? formatTime(candidate.duration)
                    : '길이 정보 없음'}{' '}
                  · {candidate.syncedLyrics ? '동기화 가사' : '일반 가사'}
                </small>
                {candidate.score !== undefined && (
                  <small>신뢰도 {Math.round(candidate.score * 100)}%</small>
                )}
              </div>
              <button
                type="button"
                className="button lyrics-candidate__action"
                disabled={selectingCandidateId !== null}
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
