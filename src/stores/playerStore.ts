import { create } from 'zustand'
import type { AppData, PlayerSession, RepeatMode, Track } from '../types/models'
import { useAppStore } from './appStore'

interface PlayerStore {
  currentTrack: Track | null
  queue: Track[]
  currentIndex: number
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  isMuted: boolean
  shuffle: boolean
  repeatMode: RepeatMode
  shuffleHistory: number[]
  error: string | null
  hydrate: (data: AppData) => void
  reconcileTracks: (tracks: Track[]) => void
  resetPlayer: (volume?: number) => void
  playTracks: (
    tracks: Track[],
    index?: number,
    shuffle?: boolean,
  ) => Promise<void>
  togglePlay: () => Promise<void>
  next: (fromEnded?: boolean) => Promise<void>
  previous: () => Promise<void>
  seek: (seconds: number) => void
  setVolume: (volume: number) => void
  toggleMute: () => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  playQueueIndex: (index: number) => Promise<void>
  addToQueue: (tracks: Track | Track[]) => void
  playNext: (track: Track) => void
  moveQueueItem: (index: number, direction: -1 | 1) => void
  moveQueueToNext: (index: number) => void
  removeFromQueue: (index: number) => void
  clearQueue: () => void
  clearError: () => void
}

const audio = new Audio()
audio.preload = 'metadata'
let recordedTrackId: string | null = null
let playbackFailures = 0
let errorAdvanceTimer: number | undefined
let lastPersistedSecond = 0
let suppressAudioEvents = false

const mediaUrl = (id: string) => `pulse-media://track/${id}`

function randomIndex(candidates: number[]): number {
  return candidates[Math.floor(Math.random() * candidates.length)] ?? -1
}

export const usePlayerStore = create<PlayerStore>((set, get) => {
  const persistSession = () => {
    const state = get()
    const session: PlayerSession = {
      queueIds: state.queue.map((track) => track.id),
      currentIndex: state.currentIndex,
      currentTime: state.currentTime,
      volume: state.volume,
      isMuted: state.isMuted,
      shuffle: state.shuffle,
      repeatMode: state.repeatMode,
    }
    useAppStore.getState().updatePlayerSession(session)
  }

  const loadIndex = async (index: number, shouldPlay = true) => {
    const track = get().queue[index]
    if (!track) return
    if (errorAdvanceTimer) window.clearTimeout(errorAdvanceTimer)
    recordedTrackId = null
    audio.src = mediaUrl(track.id)
    audio.load()
    set({
      currentTrack: track,
      currentIndex: index,
      currentTime: 0,
      duration: track.duration,
      error: null,
    })
    persistSession()
    if (shouldPlay) {
      try {
        await audio.play()
      } catch {
        set({
          isPlaying: false,
          error: '곡을 재생하지 못해 다음 곡으로 이동합니다.',
        })
      }
    }
  }

  const stopAtQueueEnd = () => {
    audio.pause()
    audio.currentTime = 0
    set({ isPlaying: false, currentTime: 0 })
    persistSession()
  }

  audio.addEventListener('play', () => {
    const track = get().currentTrack
    playbackFailures = 0
    set({ isPlaying: true, error: null })
    if (track && recordedTrackId !== track.id) {
      recordedTrackId = track.id
      useAppStore.getState().recordPlayed(track.id)
    }
  })
  audio.addEventListener('pause', () => {
    if (suppressAudioEvents) return
    set({ isPlaying: false, currentTime: audio.currentTime || 0 })
    persistSession()
  })
  audio.addEventListener('timeupdate', () => {
    const currentTime = audio.currentTime
    set({ currentTime })
    const second = Math.floor(currentTime)
    if (Math.abs(second - lastPersistedSecond) >= 10) {
      lastPersistedSecond = second
      persistSession()
    }
  })
  audio.addEventListener('durationchange', () => {
    if (Number.isFinite(audio.duration)) set({ duration: audio.duration })
  })
  audio.addEventListener('volumechange', () =>
    set({ volume: audio.volume, isMuted: audio.muted }),
  )
  audio.addEventListener('error', () => {
    if (!get().currentTrack) return
    playbackFailures += 1
    set({
      isPlaying: false,
      error: '파일이 없거나 지원하지 않는 형식이라 다음 곡으로 이동합니다.',
    })
    if (get().queue.length > 1 && playbackFailures < get().queue.length) {
      errorAdvanceTimer = window.setTimeout(() => void get().next(), 700)
    } else {
      set({ error: '재생 가능한 곡을 찾지 못했습니다.' })
    }
  })
  audio.addEventListener('ended', () => void get().next(true))

  return {
    currentTrack: null,
    queue: [],
    currentIndex: -1,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: 0.8,
    isMuted: false,
    shuffle: false,
    repeatMode: 'off',
    shuffleHistory: [],
    error: null,
    hydrate: (data) => {
      const session = data.playerSession
      const byId = new Map(data.tracks.map((track) => [track.id, track]))
      const queue = data.settings.restoreQueue
        ? session.queueIds.flatMap((id) => {
            const track = byId.get(id)
            return track ? [track] : []
          })
        : []
      const currentIndex = Math.min(session.currentIndex, queue.length - 1)
      const currentTrack = currentIndex >= 0 ? queue[currentIndex] : null
      audio.volume = Math.max(
        0,
        Math.min(1, session.volume ?? data.settings.defaultVolume),
      )
      audio.muted = session.isMuted
      set({
        queue,
        currentIndex,
        currentTrack,
        volume: audio.volume,
        isMuted: audio.muted,
        shuffle: session.shuffle,
        repeatMode: session.repeatMode,
        duration: currentTrack?.duration ?? 0,
        currentTime: currentTrack ? session.currentTime : 0,
        shuffleHistory: currentIndex >= 0 ? [currentIndex] : [],
      })
      if (currentTrack) {
        audio.src = mediaUrl(currentTrack.id)
        audio.addEventListener(
          'loadedmetadata',
          () => {
            audio.currentTime = Math.min(
              session.currentTime,
              Number.isFinite(audio.duration)
                ? audio.duration
                : session.currentTime,
            )
            if (data.settings.autoplay)
              void audio.play().catch(() => set({ isPlaying: false }))
          },
          { once: true },
        )
        audio.load()
      }
    },
    reconcileTracks: (tracks) => {
      const state = get()
      const byId = new Map(tracks.map((track) => [track.id, track]))
      const queue = state.queue.flatMap((track) => {
        const fresh = byId.get(track.id)
        return fresh ? [fresh] : []
      })
      const currentId = state.currentTrack?.id
      const currentIndex = currentId
        ? queue.findIndex((track) => track.id === currentId)
        : -1
      if (currentId && currentIndex < 0) {
        const wasPlaying = state.isPlaying
        if (!queue.length) {
          get().clearQueue()
          if (state.repeatMode === 'one') set({ repeatMode: 'off' })
          set({ error: '재생 중인 파일이 라이브러리에서 제거되었습니다.' })
        } else {
          const nextIndex = Math.min(state.currentIndex, queue.length - 1)
          set({
            queue,
            currentIndex: nextIndex,
            shuffleHistory: [nextIndex],
            repeatMode: state.repeatMode === 'one' ? 'off' : state.repeatMode,
          })
          void loadIndex(nextIndex, wasPlaying)
        }
      } else {
        set({
          queue,
          currentIndex,
          currentTrack: currentIndex >= 0 ? queue[currentIndex] : null,
          shuffleHistory: currentIndex >= 0 ? [currentIndex] : [],
        })
        persistSession()
      }
    },
    resetPlayer: (volume = 0.8) => {
      if (errorAdvanceTimer) window.clearTimeout(errorAdvanceTimer)
      suppressAudioEvents = true
      set({
        currentTrack: null,
        queue: [],
        currentIndex: -1,
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        volume,
        isMuted: false,
        shuffle: false,
        repeatMode: 'off',
        shuffleHistory: [],
        error: null,
      })
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      audio.volume = volume
      audio.muted = false
      suppressAudioEvents = false
    },
    playTracks: async (tracks, index = 0, shuffle = false) => {
      if (!tracks.length) return
      const selectedIndex = Math.max(0, Math.min(index, tracks.length - 1))
      playbackFailures = 0
      set({
        queue: [...tracks],
        shuffle,
        currentIndex: selectedIndex,
        shuffleHistory: [selectedIndex],
      })
      await loadIndex(selectedIndex)
    },
    togglePlay: async () => {
      if (!get().currentTrack) return
      if (audio.paused) {
        try {
          await audio.play()
        } catch {
          set({ error: '곡을 재생하지 못했습니다.' })
        }
      } else audio.pause()
    },
    next: async (fromEnded = false) => {
      const state = get()
      if (!state.queue.length) return
      if (fromEnded && state.repeatMode === 'one') {
        audio.currentTime = 0
        await audio.play()
        return
      }
      let nextIndex: number
      if (state.shuffle) {
        const visited = new Set(state.shuffleHistory)
        let candidates = state.queue
          .map((_, index) => index)
          .filter((index) => !visited.has(index))
        let history = state.shuffleHistory
        if (!candidates.length) {
          if (state.repeatMode !== 'all') {
            stopAtQueueEnd()
            return
          }
          candidates = state.queue
            .map((_, index) => index)
            .filter((index) => index !== state.currentIndex)
          history = [state.currentIndex]
        }
        nextIndex = randomIndex(candidates)
        if (nextIndex < 0) {
          if (state.repeatMode === 'all') nextIndex = state.currentIndex
          else {
            stopAtQueueEnd()
            return
          }
        }
        set({ shuffleHistory: [...history, nextIndex] })
      } else {
        nextIndex = state.currentIndex + 1
        if (nextIndex >= state.queue.length) {
          if (state.repeatMode !== 'all') {
            stopAtQueueEnd()
            return
          }
          nextIndex = 0
        }
      }
      await loadIndex(nextIndex)
    },
    previous: async () => {
      if (audio.currentTime > 3) {
        audio.currentTime = 0
        set({ currentTime: 0 })
        return
      }
      const state = get()
      if (state.shuffle && state.shuffleHistory.length > 1) {
        const history = state.shuffleHistory.slice(0, -1)
        const index = history.at(-1) ?? 0
        set({ shuffleHistory: history })
        await loadIndex(index)
        return
      }
      const index =
        state.currentIndex <= 0
          ? state.repeatMode === 'all'
            ? state.queue.length - 1
            : 0
          : state.currentIndex - 1
      await loadIndex(index)
    },
    seek: (seconds) => {
      if (!Number.isFinite(seconds) || !get().currentTrack) return
      audio.currentTime = Math.max(
        0,
        Math.min(seconds, audio.duration || get().duration),
      )
      set({ currentTime: audio.currentTime })
      persistSession()
    },
    setVolume: (volume) => {
      const next = Math.max(0, Math.min(1, volume))
      audio.volume = next
      if (next > 0 && audio.muted) audio.muted = false
      set({ volume: next, isMuted: audio.muted })
      persistSession()
    },
    toggleMute: () => {
      audio.muted = !audio.muted
      set({ isMuted: audio.muted })
      persistSession()
    },
    toggleShuffle: () => {
      const shuffle = !get().shuffle
      set({
        shuffle,
        shuffleHistory: get().currentIndex >= 0 ? [get().currentIndex] : [],
      })
      persistSession()
    },
    cycleRepeat: () => {
      const repeatMode =
        get().repeatMode === 'off'
          ? 'all'
          : get().repeatMode === 'all'
            ? 'one'
            : 'off'
      set({ repeatMode })
      persistSession()
    },
    playQueueIndex: async (index) => {
      set((state) => ({ shuffleHistory: [...state.shuffleHistory, index] }))
      await loadIndex(index)
    },
    addToQueue: (value) => {
      const tracks = Array.isArray(value) ? value : [value]
      set((state) => ({ queue: [...state.queue, ...tracks] }))
      persistSession()
    },
    playNext: (track) => {
      const state = get()
      const insertAt = Math.max(0, state.currentIndex + 1)
      const queue = [...state.queue]
      queue.splice(insertAt, 0, track)
      set({
        queue,
        shuffleHistory: state.currentIndex >= 0 ? [state.currentIndex] : [],
      })
      persistSession()
    },
    moveQueueItem: (index, direction) => {
      const state = get()
      const target = index + direction
      if (target < 0 || target >= state.queue.length) return
      const queue = [...state.queue]
      ;[queue[index], queue[target]] = [queue[target], queue[index]]
      let currentIndex = state.currentIndex
      if (currentIndex === index) currentIndex = target
      else if (currentIndex === target) currentIndex = index
      set({
        queue,
        currentIndex,
        shuffleHistory: currentIndex >= 0 ? [currentIndex] : [],
      })
      persistSession()
    },
    moveQueueToNext: (index) => {
      const state = get()
      if (
        index < 0 ||
        index >= state.queue.length ||
        index === state.currentIndex
      )
        return
      const queue = [...state.queue]
      const [track] = queue.splice(index, 1)
      let currentIndex = state.currentIndex
      if (index < currentIndex) currentIndex -= 1
      queue.splice(currentIndex + 1, 0, track)
      set({ queue, currentIndex, shuffleHistory: [currentIndex] })
      persistSession()
    },
    removeFromQueue: (index) => {
      const state = get()
      if (index < 0 || index >= state.queue.length) return
      const wasCurrent = index === state.currentIndex
      const wasPlaying = state.isPlaying
      const queue = state.queue.filter((_, queueIndex) => queueIndex !== index)
      if (!queue.length) {
        get().clearQueue()
        return
      }
      const currentIndex = wasCurrent
        ? Math.min(index, queue.length - 1)
        : index < state.currentIndex
          ? state.currentIndex - 1
          : state.currentIndex
      set({ queue, currentIndex, shuffleHistory: [currentIndex] })
      if (wasCurrent) void loadIndex(currentIndex, wasPlaying)
      else persistSession()
    },
    clearQueue: () => {
      suppressAudioEvents = true
      set({
        currentTrack: null,
        queue: [],
        currentIndex: -1,
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        shuffleHistory: [],
      })
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      suppressAudioEvents = false
      persistSession()
    },
    clearError: () => set({ error: null }),
  }
})
