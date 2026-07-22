import { AlertCircle, CheckCircle2, PanelRightOpen, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Sidebar } from './components/layout/Sidebar'
import { IconButton } from './components/common/IconButton'
import { NowPlayingPanel } from './components/player/NowPlayingPanel'
import { PlayerBar } from './components/player/PlayerBar'
import { Onboarding } from './components/onboarding/Onboarding'
import { FocusPage } from './pages/FocusPage'
import { HomePage } from './pages/HomePage'
import { LibraryPage } from './pages/LibraryPage'
import { LikedPage } from './pages/LikedPage'
import { PlaylistsPage } from './pages/PlaylistsPage'
import { SettingsPage } from './pages/SettingsPage'
import { YouTubePage } from './pages/YouTubePage'
import { useAppStore } from './stores/appStore'
import { usePlayerStore } from './stores/playerStore'
import type { PlayerSnapshot } from './types/models'

const pages = {
  home: HomePage,
  library: LibraryPage,
  youtube: YouTubePage,
  liked: LikedPage,
  playlists: PlaylistsPage,
  focus: FocusPage,
  settings: SettingsPage,
}

function snapshot(): PlayerSnapshot {
  const player = usePlayerStore.getState()
  return {
    currentTrack: player.currentTrack,
    queue: player.queue,
    currentIndex: player.currentIndex,
    isPlaying: player.isPlaying,
    currentTime: player.currentTime,
    duration: player.duration,
    volume: player.volume,
    isMuted: player.isMuted,
    shuffle: player.shuffle,
    repeatMode: player.repeatMode,
  }
}

export default function App() {
  const initialize = useAppStore((state) => state.initialize)
  const data = useAppStore((state) => state.data)
  const page = useAppStore((state) => state.page)
  const isLoading = useAppStore((state) => state.isLoading)
  const error = useAppStore((state) => state.error)
  const clearError = useAppStore((state) => state.clearError)
  const notice = useAppStore((state) => state.notice)
  const clearNotice = useAppStore((state) => state.clearNotice)
  const playerError = usePlayerStore((state) => state.error)
  const clearPlayerError = usePlayerStore((state) => state.clearError)
  const nowPlayingOpen = useAppStore((state) => state.nowPlayingOpen)
  const setNowPlayingOpen = useAppStore((state) => state.setNowPlayingOpen)
  const hydrated = useRef(false)
  const Page = pages[page]
  const theme = data?.settings.theme
  const settings = data?.settings
  const tracks = data?.tracks

  useEffect(() => {
    void initialize()
  }, [initialize])

  useEffect(() => {
    if (!data || hydrated.current) return
    hydrated.current = true
    usePlayerStore.getState().hydrate(data)
  }, [data])

  useEffect(() => {
    if (!tracks || !hydrated.current) return
    usePlayerStore.getState().reconcileTracks(tracks)
    if (notice) usePlayerStore.getState().clearError()
  }, [notice, tracks])

  useEffect(() => {
    if (!theme) return
    const applyTheme = () => {
      const resolvedTheme =
        theme === 'system'
          ? window.matchMedia('(prefers-color-scheme: light)').matches
            ? 'light'
            : 'dark'
          : theme
      document.documentElement.dataset.theme = resolvedTheme
    }
    applyTheme()
    const media = window.matchMedia('(prefers-color-scheme: light)')
    media.addEventListener('change', applyTheme)
    return () => media.removeEventListener('change', applyTheme)
  }, [theme])

  useEffect(() => {
    if (!settings) return
    window.electronAPI.sendPlayerSnapshot(snapshot(), settings)
    return usePlayerStore.subscribe(() =>
      window.electronAPI.sendPlayerSnapshot(
        snapshot(),
        useAppStore.getState().data?.settings ?? settings,
      ),
    )
  }, [settings])

  useEffect(
    () =>
      window.electronAPI.onPlayerCommand((command) => {
        const player = usePlayerStore.getState()
        if (command.type === 'toggle') void player.togglePlay()
        if (command.type === 'next') void player.next()
        if (command.type === 'previous') void player.previous()
        if (command.type === 'seek') player.seek(command.value)
        if (command.type === 'toggle-shuffle') player.toggleShuffle()
        if (command.type === 'cycle-repeat') player.cycleRepeat()
        if (command.type === 'toggle-mute') player.toggleMute()
        if (command.type === 'set-volume') player.setVolume(command.value)
      }),
    [],
  )

  useEffect(
    () =>
      window.electronAPI.onTaskbarToggleSettingsChanged((patch) =>
        useAppStore.getState().syncExternalSettings(patch),
      ),
    [],
  )

  useEffect(
    () =>
      window.electronAPI.onTaskbarLyricsSettingsChanged((patch) =>
        useAppStore.getState().syncExternalSettings(patch),
      ),
    [],
  )

  useEffect(
    () =>
      window.electronAPI.onOpenMainQueue(() => {
        useAppStore.getState().setNowPlayingOpen(true)
        window.dispatchEvent(
          new CustomEvent('pulse:panel-tab', { detail: 'queue' }),
        )
      }),
    [],
  )

  useEffect(() => {
    if (window.innerWidth < 1450) setNowPlayingOpen(false)
    const handleResize = () => {
      if (window.innerWidth < 1450) setNowPlayingOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return
      const target = event.target as HTMLElement
      const editing =
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
        target.isContentEditable
      if (editing) return
      const player = usePlayerStore.getState()
      if (event.code === 'Space' && !event.ctrlKey) {
        event.preventDefault()
        void player.togglePlay()
      }
      if (event.ctrlKey && event.key === 'ArrowRight') {
        event.preventDefault()
        void player.next()
      }
      if (event.ctrlKey && event.key === 'ArrowLeft') {
        event.preventDefault()
        void player.previous()
      }
      if (event.ctrlKey && event.key === 'ArrowUp') {
        event.preventDefault()
        player.setVolume(player.volume + 0.05)
      }
      if (event.ctrlKey && event.key === 'ArrowDown') {
        event.preventDefault()
        player.setVolume(player.volume - 0.05)
      }
      if (event.ctrlKey && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        useAppStore.getState().navigate('library')
      }
      if (event.ctrlKey && event.key.toLowerCase() === 'm') {
        event.preventDefault()
        void window.electronAPI.openMiniPlayer()
      }
      if (event.ctrlKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        useAppStore.getState().navigate('library')
        window.setTimeout(
          () => window.dispatchEvent(new Event('pulse:focus-search')),
          0,
        )
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleResize)
    }
  }, [setNowPlayingOpen])

  useEffect(() => {
    const onError = (event: ErrorEvent) =>
      window.electronAPI.logRendererError(
        event.message,
        event.error instanceof Error ? event.error.stack : undefined,
      )
    const onRejection = (event: PromiseRejectionEvent) =>
      window.electronAPI.logRendererError(
        event.reason instanceof Error
          ? event.reason.message
          : String(event.reason),
        event.reason instanceof Error ? event.reason.stack : undefined,
      )
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  if (isLoading)
    return (
      <div className="app-loading">
        <div className="loading-mark" />
        <strong>Pulse Shelf</strong>
        <span>라이브러리를 불러오는 중…</span>
      </div>
    )

  if (!data)
    return (
      <main className="fatal-error" role="alert">
        <h1>앱 데이터를 불러오지 못했습니다</h1>
        <p>{error ?? '저장소를 확인한 뒤 다시 시도하세요.'}</p>
        <button
          type="button"
          className="button button--primary"
          onClick={() => void initialize()}
        >
          다시 시도
        </button>
      </main>
    )

  return (
    <div className={`app-shell ${nowPlayingOpen ? 'with-now-panel' : ''}`}>
      <Sidebar />
      <main
        className={`main-content ${
          nowPlayingOpen ? '' : 'main-content--with-panel-trigger'
        }`}
      >
        {!nowPlayingOpen && (
          <IconButton
            className="open-now-panel"
            label="현재 재생 패널 열기"
            onClick={() => setNowPlayingOpen(true)}
          >
            <PanelRightOpen />
          </IconButton>
        )}
        <Page />
      </main>
      <NowPlayingPanel />
      <PlayerBar />
      <Onboarding />
      {(error || playerError) && !notice && (
        <div className="toast" role="alert">
          <AlertCircle />
          <span>{error ?? playerError}</span>
          <IconButton
            label="오류 닫기"
            onClick={() => {
              clearError()
              clearPlayerError()
            }}
          >
            <X />
          </IconButton>
        </div>
      )}
      {notice && (
        <div className="toast toast--success" role="status">
          <CheckCircle2 />
          <span>{notice.message}</span>
          {notice.action && notice.actionLabel && (
            <button
              type="button"
              className="toast__action"
              onClick={() => void notice.action?.().catch(() => undefined)}
            >
              {notice.actionLabel}
            </button>
          )}
          <IconButton label="알림 닫기" onClick={clearNotice}>
            <X />
          </IconButton>
        </div>
      )}
    </div>
  )
}
