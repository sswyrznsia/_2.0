import { create } from 'zustand'
import type {
  AppData,
  FocusTimer,
  FocusTodo,
  PageId,
  Playlist,
  PlayerSession,
  ScanProgress,
  Settings,
  Track,
} from '../types/models'

interface AppNotice {
  message: string
  actionLabel?: string
  action?: () => Promise<void>
}

export type LibraryTab = 'tracks' | 'albums' | 'artists'
export type LibrarySort =
  'title' | 'artist' | 'album' | 'added' | 'recent' | 'plays' | 'duration'
export interface LibraryDetail {
  type: 'album' | 'artist'
  key: string
}

interface AppStore {
  data: AppData | null
  page: PageId
  selectedPlaylistId: string | null
  nowPlayingOpen: boolean
  isLoading: boolean
  isScanning: boolean
  scanProgress: ScanProgress | null
  error: string | null
  notice: AppNotice | null
  pendingTrackIds: string[]
  libraryQuery: string
  libraryTab: LibraryTab
  librarySort: LibrarySort
  libraryDetail: LibraryDetail | null
  initialize: () => Promise<void>
  navigate: (page: PageId) => void
  selectPlaylist: (id: string) => void
  setNowPlayingOpen: (open: boolean) => void
  setLibraryQuery: (query: string) => void
  setLibraryTab: (tab: LibraryTab) => void
  setLibrarySort: (sort: LibrarySort) => void
  setLibraryDetail: (detail: LibraryDetail | null) => void
  addMusicFolder: () => Promise<void>
  rescan: () => Promise<void>
  cancelScan: () => void
  removeMusicFolder: (folder: string) => Promise<void>
  refreshData: () => Promise<void>
  removeTrackFromLibrary: (trackId: string) => Promise<boolean>
  trashTrack: (trackId: string) => Promise<boolean>
  toggleLike: (trackId: string) => void
  recordPlayed: (trackId: string) => void
  createPlaylist: (name: string) => string | null
  renamePlaylist: (id: string, name: string) => void
  deletePlaylist: (id: string) => void
  addTrackToPlaylist: (playlistId: string, trackId: string) => void
  addTracksToPlaylist: (playlistId: string, trackIds: string[]) => void
  removeTrackFromPlaylist: (playlistId: string, trackId: string) => void
  movePlaylistTrack: (
    playlistId: string,
    trackId: string,
    direction: -1 | 1,
  ) => void
  updateSettings: (patch: Partial<Settings>) => void
  syncExternalSettings: (patch: Partial<Settings>) => void
  updatePlayerSession: (session: PlayerSession) => void
  updateFocusTimer: (timer: FocusTimer, focusedDelta?: number) => void
  addTodo: (text: string) => void
  toggleTodo: (id: string) => void
  deleteTodo: (id: string) => void
  moveTodo: (id: string, direction: -1 | 1) => void
  completeOnboarding: (settings: Partial<Settings>) => void
  exportData: () => Promise<string>
  importData: () => Promise<string>
  resetAllData: () => Promise<AppData>
  clearError: () => void
  clearNotice: () => void
}

let scanListenerInitialized = false

function save(data: AppData, set: (partial: Partial<AppStore>) => void) {
  void window.electronAPI.saveData(data).catch((error: unknown) => {
    set({
      error:
        error instanceof Error
          ? error.message
          : '데이터를 저장하지 못했습니다.',
    })
  })
}

export const useAppStore = create<AppStore>((set, get) => {
  const update = (mutate: (data: AppData) => AppData) => {
    const current = get().data
    if (!current) return
    const data = mutate(current)
    set({ data })
    save(data, set)
  }

  const finishScan = async (
    result: Awaited<ReturnType<typeof window.electronAPI.rescanMusicFolders>>,
  ) => {
    if (!result.cancelled) {
      const data = await window.electronAPI.loadData()
      set({
        data,
        error: result.errors.length
          ? `${result.errors.length}개 파일 또는 폴더를 읽지 못했습니다.`
          : null,
      })
    }
  }

  return {
    data: null,
    page: 'home',
    selectedPlaylistId: null,
    nowPlayingOpen: true,
    isLoading: true,
    isScanning: false,
    scanProgress: null,
    error: null,
    notice: null,
    pendingTrackIds: [],
    libraryQuery: '',
    libraryTab: 'tracks',
    librarySort: 'title',
    libraryDetail: null,
    initialize: async () => {
      set({ isLoading: true, error: null })
      if (!scanListenerInitialized) {
        scanListenerInitialized = true
        window.electronAPI.onScanProgress((scanProgress) =>
          set({ scanProgress, isScanning: true }),
        )
      }
      try {
        const data = await window.electronAPI.loadData()
        set({
          data,
          page: data.settings.restoreLastPage ? data.lastPage : 'home',
          isLoading: false,
        })
      } catch (error) {
        set({
          error:
            error instanceof Error
              ? error.message
              : '앱 데이터를 불러오지 못했습니다.',
          isLoading: false,
        })
      }
    },
    navigate: (page) => {
      set({
        page,
        selectedPlaylistId:
          page === 'playlists' ? get().selectedPlaylistId : null,
      })
      update((data) => ({ ...data, lastPage: page }))
    },
    selectPlaylist: (id) => {
      set({ page: 'playlists', selectedPlaylistId: id })
      update((data) => ({ ...data, lastPage: 'playlists' }))
    },
    setNowPlayingOpen: (nowPlayingOpen) => set({ nowPlayingOpen }),
    setLibraryQuery: (libraryQuery) => set({ libraryQuery }),
    setLibraryTab: (libraryTab) => set({ libraryTab, libraryDetail: null }),
    setLibrarySort: (librarySort) => set({ librarySort }),
    setLibraryDetail: (libraryDetail) => set({ libraryDetail }),
    addMusicFolder: async () => {
      set({ isScanning: true, scanProgress: null, error: null })
      try {
        await finishScan(await window.electronAPI.chooseMusicFolder())
      } catch (error) {
        set({
          error:
            error instanceof Error
              ? error.message
              : '음악 폴더를 읽지 못했습니다.',
        })
      } finally {
        set({ isScanning: false, scanProgress: null })
      }
    },
    rescan: async () => {
      set({ isScanning: true, scanProgress: null, error: null })
      try {
        await finishScan(await window.electronAPI.rescanMusicFolders())
      } catch (error) {
        set({
          error:
            error instanceof Error
              ? error.message
              : '폴더를 다시 검색하지 못했습니다.',
        })
      } finally {
        set({ isScanning: false, scanProgress: null })
      }
    },
    cancelScan: () => window.electronAPI.cancelScan(),
    removeMusicFolder: async (folder) => {
      set({ isScanning: true, scanProgress: null, error: null })
      try {
        await finishScan(await window.electronAPI.removeMusicFolder(folder))
      } catch (error) {
        set({
          error:
            error instanceof Error
              ? error.message
              : '음악 폴더를 제거하지 못했습니다.',
        })
      } finally {
        set({ isScanning: false, scanProgress: null })
      }
    },
    refreshData: async () => set({ data: await window.electronAPI.loadData() }),
    removeTrackFromLibrary: async (trackId) => {
      if (get().pendingTrackIds.includes(trackId)) return false
      set((state) => ({
        pendingTrackIds: [...state.pendingTrackIds, trackId],
        error: null,
      }))
      try {
        const result = await window.electronAPI.removeTrack(trackId)
        const exclusionId = result.exclusionId
        set({
          data: result.data,
          notice: {
            message: '라이브러리에서 제거했습니다.',
            actionLabel: exclusionId ? '되돌리기' : undefined,
            action: exclusionId
              ? async () => {
                  const data =
                    await window.electronAPI.restoreLibraryExclusion(
                      exclusionId,
                    )
                  set({
                    data,
                    notice: { message: '라이브러리에 다시 추가했습니다.' },
                  })
                }
              : undefined,
          },
        })
        return true
      } catch (error) {
        set({
          error:
            error instanceof Error
              ? error.message
              : '라이브러리에서 곡을 제거하지 못했습니다.',
        })
        return false
      } finally {
        set((state) => ({
          pendingTrackIds: state.pendingTrackIds.filter((id) => id !== trackId),
        }))
      }
    },
    trashTrack: async (trackId) => {
      if (get().pendingTrackIds.includes(trackId)) return false
      set((state) => ({
        pendingTrackIds: [...state.pendingTrackIds, trackId],
        error: null,
      }))
      try {
        const result = await window.electronAPI.trashTrack(trackId)
        set({
          data: result.data,
          notice: {
            message:
              result.fileStatus === 'missing'
                ? '파일을 찾을 수 없어 라이브러리에서만 제거했습니다.'
                : '파일을 Windows 휴지통으로 이동했습니다. 휴지통에서 복원할 수 있습니다.',
          },
        })
        return true
      } catch (error) {
        set({
          error:
            error instanceof Error
              ? error.message
              : '파일을 휴지통으로 이동하지 못했습니다.',
        })
        return false
      } finally {
        set((state) => ({
          pendingTrackIds: state.pendingTrackIds.filter((id) => id !== trackId),
        }))
      }
    },
    toggleLike: (trackId) =>
      update((data) => ({
        ...data,
        tracks: data.tracks.map((track) =>
          track.id === trackId ? { ...track, liked: !track.liked } : track,
        ),
      })),
    recordPlayed: (trackId) =>
      update((data) => {
        const now = Date.now()
        return {
          ...data,
          tracks: data.tracks.map((track) =>
            track.id === trackId
              ? { ...track, lastPlayedAt: now, playCount: track.playCount + 1 }
              : track,
          ),
          recentTrackIds: [
            trackId,
            ...data.recentTrackIds.filter((id) => id !== trackId),
          ].slice(0, 24),
        }
      }),
    createPlaylist: (name) => {
      const normalized = name.trim()
      if (!normalized) return null
      const id = crypto.randomUUID()
      const now = Date.now()
      const playlist: Playlist = {
        id,
        name: normalized,
        trackIds: [],
        createdAt: now,
        updatedAt: now,
      }
      update((data) => ({ ...data, playlists: [...data.playlists, playlist] }))
      return id
    },
    renamePlaylist: (id, name) => {
      const normalized = name.trim()
      if (!normalized) return
      update((data) => ({
        ...data,
        playlists: data.playlists.map((playlist) =>
          playlist.id === id
            ? { ...playlist, name: normalized, updatedAt: Date.now() }
            : playlist,
        ),
      }))
    },
    deletePlaylist: (id) => {
      update((data) => ({
        ...data,
        playlists: data.playlists.filter((playlist) => playlist.id !== id),
      }))
      set({ selectedPlaylistId: null })
    },
    addTrackToPlaylist: (playlistId, trackId) =>
      get().addTracksToPlaylist(playlistId, [trackId]),
    addTracksToPlaylist: (playlistId, trackIds) =>
      update((data) => ({
        ...data,
        playlists: data.playlists.map((playlist) => {
          if (playlist.id !== playlistId) return playlist
          const nextIds = [...new Set([...playlist.trackIds, ...trackIds])]
          return {
            ...playlist,
            trackIds: nextIds,
            coverTrackId: playlist.coverTrackId ?? nextIds[0],
            updatedAt: Date.now(),
          }
        }),
      })),
    removeTrackFromPlaylist: (playlistId, trackId) =>
      update((data) => ({
        ...data,
        playlists: data.playlists.map((playlist) =>
          playlist.id === playlistId
            ? (() => {
                const trackIds = playlist.trackIds.filter(
                  (id) => id !== trackId,
                )
                return {
                  ...playlist,
                  trackIds,
                  coverTrackId:
                    playlist.coverTrackId === trackId
                      ? trackIds[0]
                      : playlist.coverTrackId,
                  updatedAt: Date.now(),
                }
              })()
            : playlist,
        ),
      })),
    movePlaylistTrack: (playlistId, trackId, direction) =>
      update((data) => ({
        ...data,
        playlists: data.playlists.map((playlist) => {
          if (playlist.id !== playlistId) return playlist
          const index = playlist.trackIds.indexOf(trackId)
          const target = index + direction
          if (index < 0 || target < 0 || target >= playlist.trackIds.length)
            return playlist
          const trackIds = [...playlist.trackIds]
          ;[trackIds[index], trackIds[target]] = [
            trackIds[target],
            trackIds[index],
          ]
          return { ...playlist, trackIds, updatedAt: Date.now() }
        }),
      })),
    updateSettings: (patch) =>
      update((data) => ({ ...data, settings: { ...data.settings, ...patch } })),
    syncExternalSettings: (patch) =>
      set((state) =>
        state.data
          ? {
              data: {
                ...state.data,
                settings: { ...state.data.settings, ...patch },
              },
            }
          : state,
      ),
    updatePlayerSession: (playerSession) =>
      update((data) => ({ ...data, playerSession })),
    updateFocusTimer: (timer, focusedDelta = 0) =>
      update((data) => {
        const date = new Date().toISOString().slice(0, 10)
        return {
          ...data,
          focus: {
            ...data.focus,
            today: date,
            focusedSeconds:
              (data.focus.today === date ? data.focus.focusedSeconds : 0) +
              focusedDelta,
            timer,
          },
        }
      }),
    addTodo: (text) => {
      const normalized = text.trim()
      if (!normalized) return
      const todo: FocusTodo = {
        id: crypto.randomUUID(),
        text: normalized,
        completed: false,
      }
      update((data) => ({
        ...data,
        focus: { ...data.focus, todos: [...data.focus.todos, todo] },
      }))
    },
    toggleTodo: (id) =>
      update((data) => ({
        ...data,
        focus: {
          ...data.focus,
          todos: data.focus.todos.map((todo) =>
            todo.id === id ? { ...todo, completed: !todo.completed } : todo,
          ),
        },
      })),
    deleteTodo: (id) =>
      update((data) => ({
        ...data,
        focus: {
          ...data.focus,
          todos: data.focus.todos.filter((todo) => todo.id !== id),
        },
      })),
    moveTodo: (id, direction) =>
      update((data) => {
        const todos = [...data.focus.todos]
        const index = todos.findIndex((todo) => todo.id === id)
        const target = index + direction
        if (index < 0 || target < 0 || target >= todos.length) return data
        ;[todos[index], todos[target]] = [todos[target], todos[index]]
        return { ...data, focus: { ...data.focus, todos } }
      }),
    completeOnboarding: (settings) =>
      update((data) => ({
        ...data,
        onboardingCompleted: true,
        settings: { ...data.settings, ...settings },
      })),
    exportData: async () => (await window.electronAPI.exportData()).message,
    importData: async () => {
      const result = await window.electronAPI.importData()
      if (result.success && result.data) set({ data: result.data })
      if (!result.success && !result.cancelled) set({ error: result.message })
      return result.message
    },
    resetAllData: async () => {
      const data = await window.electronAPI.resetData()
      set({ data, page: 'home', selectedPlaylistId: null, error: null })
      return data
    },
    clearError: () => set({ error: null }),
    clearNotice: () => set({ notice: null }),
  }
})

export function tracksForPlaylist(data: AppData, playlist: Playlist): Track[] {
  const tracks = new Map(data.tracks.map((track) => [track.id, track]))
  return playlist.trackIds.flatMap((id) => {
    const track = tracks.get(id)
    return track ? [track] : []
  })
}
