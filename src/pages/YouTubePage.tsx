import {
  ArrowLeft,
  ArrowRight,
  CircleStop,
  Download,
  ExternalLink,
  Home,
  RefreshCw,
  Library,
  Play,
  Youtube,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { IconButton } from '../components/common/IconButton'
import { useAppStore } from '../stores/appStore'
import { usePlayerStore } from '../stores/playerStore'
import type {
  ImportAvailabilityReason,
  MediaImportJob,
  YouTubeViewState,
} from '../types/models'

const initialState: YouTubeViewState = {
  url: 'https://www.youtube.com/',
  title: 'YouTube',
  canGoBack: false,
  canGoForward: false,
  isLoading: true,
  isVideoUrl: false,
  videoId: null,
  importAvailable: false,
  importUnavailableReason: 'service-not-installed',
  existingTrackId: null,
  error: null,
}

const availabilityMessages: Record<ImportAvailabilityReason, string> = {
  ready: '가져오기 가능',
  'service-not-installed': '가져오기 서비스를 사용할 수 없습니다.',
  'binary-not-found': '가져오기 실행 파일을 찾을 수 없습니다.',
  'unsupported-platform': '현재 운영체제에서는 가져오기를 지원하지 않습니다.',
  'configuration-error': '가져오기 서비스 설정을 확인해 주세요.',
}

const activeStatuses = new Set<MediaImportJob['status']>([
  'queued',
  'preparing',
  'downloading',
  'processing',
  'registering',
])

export function YouTubePage() {
  const refreshData = useAppStore((state) => state.refreshData)
  const navigateApp = useAppStore((state) => state.navigate)
  const setLibraryQuery = useAppStore((state) => state.setLibraryQuery)
  const [viewState, setViewState] = useState(initialState)
  const [address, setAddress] = useState(initialState.url)
  const [message, setMessage] = useState('YouTube를 불러오는 중입니다.')
  const [job, setJob] = useState<MediaImportJob | null>(null)
  const [confirmation, setConfirmation] = useState<{
    url: string
    title: string
  } | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.electronAPI
      .getMediaImportJobs()
      .then((jobs) => {
        const active = jobs.find((item) => activeStatuses.has(item.status))
        setJob(active ?? jobs[0] ?? null)
      })
      .catch(() => undefined)
    const onProgress = window.electronAPI.onMediaImportProgress(setJob)
    const onCompleted = window.electronAPI.onMediaImportCompleted(
      (completed) => {
        setJob(completed)
        void refreshData()
      },
    )
    const onFailed = window.electronAPI.onMediaImportFailed(setJob)
    return () => {
      onProgress()
      onCompleted()
      onFailed()
    }
  }, [refreshData])

  useEffect(() => {
    const viewport = viewportRef.current
    const updateBounds = () => {
      if (!viewport) return
      const bounds = viewport.getBoundingClientRect()
      if (bounds.width < 1 || bounds.height < 1) return
      window.electronAPI.setYouTubeBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      })
    }
    const unsubscribe = window.electronAPI.onYouTubeState((state) => {
      setViewState(state)
      setAddress(state.url)
      setMessage(state.isLoading ? 'YouTube를 불러오는 중입니다.' : '')
    })
    void window.electronAPI
      .youtubeOpen()
      .then((state) => {
        setViewState(state)
        setAddress(state.url)
        window.requestAnimationFrame(updateBounds)
      })
      .catch((error: unknown) => {
        const errorMessage =
          error instanceof Error ? error.message : 'YouTube를 열지 못했습니다.'
        setMessage(errorMessage)
      })

    const observer = new ResizeObserver(updateBounds)
    if (viewport) observer.observe(viewport)
    window.addEventListener('resize', updateBounds)
    window.requestAnimationFrame(updateBounds)
    return () => {
      unsubscribe()
      observer.disconnect()
      window.removeEventListener('resize', updateBounds)
      void window.electronAPI.youtubeClose()
    }
  }, [])

  const navigate = (event: React.FormEvent) => {
    event.preventDefault()
    void window.electronAPI
      .navigateYouTube(address)
      .then(setViewState)
      .catch((error: unknown) =>
        setMessage(
          error instanceof Error ? error.message : '주소를 열지 못했습니다.',
        ),
      )
  }

  const importingCurrentVideo =
    job !== null &&
    activeStatuses.has(job.status) &&
    job.sourceVideoId === viewState.videoId
  const importingAnotherVideo =
    job !== null &&
    activeStatuses.has(job.status) &&
    job.sourceVideoId !== viewState.videoId
  const disabledReason = !viewState.isVideoUrl
    ? '영상 페이지가 아닙니다.'
    : !viewState.videoId
      ? '영상 URL을 확인할 수 없습니다.'
      : !viewState.importAvailable
        ? availabilityMessages[viewState.importUnavailableReason]
        : viewState.existingTrackId
          ? '이미 라이브러리에 존재합니다.'
          : importingCurrentVideo
            ? '현재 가져오는 중입니다.'
            : importingAnotherVideo
              ? '다른 영상을 가져오는 중입니다.'
              : null

  const restoreYouTubeView = async () => {
    const state = await window.electronAPI.youtubeOpen()
    setViewState(state)
    setAddress(state.url)
  }

  const requestImport = async () => {
    try {
      const url = await window.electronAPI.getCurrentYouTubeUrl()
      await window.electronAPI.youtubeClose()
      setConfirmation({ url, title: viewState.title })
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : '현재 영상 주소를 확인하지 못했습니다.',
      )
    }
  }

  const startImport = async () => {
    if (!confirmation) return
    const url = confirmation.url
    setConfirmation(null)
    try {
      const started = await window.electronAPI.startMediaImport({
        url,
        source: 'youtube',
      })
      setJob(started)
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : '가져오기를 시작하지 못했습니다.',
      )
    } finally {
      await restoreYouTubeView().catch(() => undefined)
    }
  }

  const closeConfirmation = async () => {
    setConfirmation(null)
    await restoreYouTubeView().catch(() => undefined)
  }

  const showImportedTrack = async (play: boolean) => {
    if (!job?.trackId) return
    await refreshData()
    const track = useAppStore
      .getState()
      .data?.tracks.find((item) => item.id === job.trackId)
    if (!track) {
      setMessage('등록된 곡을 라이브러리에서 찾지 못했습니다.')
      return
    }
    if (play) await usePlayerStore.getState().playTracks([track])
    else {
      setLibraryQuery(track.title)
      navigateApp('library')
    }
  }

  return (
    <div className="page youtube-page">
      <header className="youtube-toolbar">
        <div className="youtube-toolbar__navigation">
          <IconButton
            label="YouTube 뒤로"
            disabled={!viewState.canGoBack}
            onClick={() =>
              void window.electronAPI.goBackYouTube().then(setViewState)
            }
          >
            <ArrowLeft />
          </IconButton>
          <IconButton
            label="YouTube 앞으로"
            disabled={!viewState.canGoForward}
            onClick={() =>
              void window.electronAPI.goForwardYouTube().then(setViewState)
            }
          >
            <ArrowRight />
          </IconButton>
          <IconButton
            label="YouTube 새로고침"
            onClick={() =>
              void window.electronAPI.reloadYouTube().then(setViewState)
            }
          >
            <RefreshCw className={viewState.isLoading ? 'spin' : ''} />
          </IconButton>
          <IconButton
            label="YouTube 홈"
            onClick={() =>
              void window.electronAPI.goHomeYouTube().then(setViewState)
            }
          >
            <Home />
          </IconButton>
        </div>
        <form className="youtube-address" onSubmit={navigate}>
          <Youtube aria-hidden="true" />
          <input
            aria-label="현재 YouTube URL"
            value={address}
            maxLength={2048}
            onChange={(event) => setAddress(event.target.value)}
            spellCheck="false"
          />
        </form>
        <div className="youtube-toolbar__actions">
          <button
            type="button"
            className="button button--primary youtube-import"
            disabled={disabledReason !== null}
            title={disabledReason ?? '현재 영상을 가져옵니다.'}
            onClick={() => void requestImport()}
          >
            <Download />
            현재 영상 가져오기
          </button>
          <IconButton
            label="현재 페이지를 외부 브라우저에서 열기"
            onClick={() => void window.electronAPI.openYouTubeExternal()}
          >
            <ExternalLink />
          </IconButton>
        </div>
      </header>
      <div
        className="youtube-viewport"
        ref={viewportRef}
        aria-label="YouTube 웹 콘텐츠"
      >
        <div className="youtube-viewport__placeholder">
          <Youtube />
          <span>{message || 'YouTube 웹 콘텐츠'}</span>
        </div>
      </div>
      <footer className="youtube-status" role="status" aria-live="polite">
        <span className={viewState.isVideoUrl ? 'is-detected' : ''} />
        <div>
          <strong>
            {viewState.error
              ? '페이지 로드 실패'
              : job && activeStatuses.has(job.status)
                ? `${job.title || '영상'} · ${job.message || '가져오는 중'}${job.progress !== null ? ` ${Math.round(job.progress)}%` : ''}`
                : job?.status === 'completed'
                  ? '가져오기 완료 · 라이브러리에 등록되었습니다.'
                  : job?.status === 'failed'
                    ? '가져오기 실패'
                    : viewState.isVideoUrl
                      ? `영상 URL 감지됨 · ${viewState.title}`
                      : '영상 URL 아님'}
          </strong>
          <p>
            {viewState.error ||
              job?.message ||
              message ||
              `${disabledReason ?? '가져오기 가능'}${viewState.videoId ? ` · Video ID: ${viewState.videoId}` : ''}`}
          </p>
          {job && activeStatuses.has(job.status) && (
            <div className="media-import-progress">
              <progress
                max="100"
                value={job.progress ?? undefined}
                aria-label="가져오기 진행률"
              />
              <button
                type="button"
                className="button"
                onClick={() =>
                  void window.electronAPI.cancelMediaImport(job.jobId)
                }
              >
                <CircleStop /> 취소
              </button>
            </div>
          )}
          {job?.status === 'completed' && job.trackId && (
            <div className="media-import-actions">
              <button
                type="button"
                className="button"
                onClick={() => void showImportedTrack(false)}
              >
                <Library /> 라이브러리에서 보기
              </button>
              <button
                type="button"
                className="button button--primary"
                onClick={() => void showImportedTrack(true)}
              >
                <Play /> 바로 재생
              </button>
            </div>
          )}
        </div>
      </footer>
      {confirmation && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal media-import-confirmation"
            role="dialog"
            aria-modal="true"
            aria-labelledby="media-import-title"
          >
            <h2 id="media-import-title">현재 영상을 가져올까요?</h2>
            <p>
              본인이 소유했거나 다운로드 허가를 받은 콘텐츠만 가져오세요. 서비스
              이용약관과 저작권을 준수할 책임은 사용자에게 있습니다.
            </p>
            <dl>
              <div>
                <dt>영상</dt>
                <dd>{confirmation.title}</dd>
              </div>
              <div>
                <dt>주소</dt>
                <dd>{confirmation.url}</dd>
              </div>
            </dl>
            <div>
              <button
                type="button"
                className="button"
                onClick={() => void closeConfirmation()}
              >
                취소
              </button>
              <button
                type="button"
                className="button button--primary"
                onClick={() => void startImport()}
              >
                가져오기 시작
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
