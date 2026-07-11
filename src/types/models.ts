export type RepeatMode = 'off' | 'one' | 'all'
export type PageId =
  'home' | 'library' | 'youtube' | 'liked' | 'playlists' | 'focus' | 'settings'
export type MusicFormat = 'mp3' | 'flac' | 'wav' | 'm4a' | 'ogg'
export type FocusTimerMode = 'focus' | 'break'
export type FocusTimerStatus = 'idle' | 'running' | 'paused'

export interface Track {
  id: string
  fileName: string
  title: string
  artist: string
  album: string
  duration: number
  format: MusicFormat
  fileSize: number
  modifiedAt: number
  addedAt: number
  trackNumber?: number
  discNumber?: number
  year?: number
  coverUrl?: string
  liked: boolean
  lastPlayedAt?: number
  playCount: number
  source?: 'youtube' | 'direct'
  sourceUrl?: string
  sourceVideoId?: string
}

export interface LibraryExclusion {
  id: string
  filePathHash: string
  excludedAt: number
}

export interface LibraryMutationResult {
  data: AppData
  exclusionId?: string
  fileStatus: 'preserved' | 'trashed' | 'missing'
}

export interface TrackRemovalDetails {
  fileName: string
  folderName: string
}

export interface Playlist {
  id: string
  name: string
  trackIds: string[]
  createdAt: number
  updatedAt: number
  coverTrackId?: string
}

export interface Settings {
  theme: 'dark' | 'light' | 'system'
  restoreLastPage: boolean
  restoreQueue: boolean
  autoplay: boolean
  discordPresence: boolean
  autoLaunch: boolean
  closeBehavior: 'quit' | 'tray'
  miniAlwaysOnTop: boolean
  defaultVolume: number
  autoFetchLyricsOnImport: boolean
  autoFetchLyricsOnPlay: boolean
  preferSyncedLyrics: boolean
  lyricsAutoMatchThreshold: number
  taskbarModeEnabled: boolean
  taskbarModeShowOnStartup: boolean
  taskbarModeRestoreLastState: boolean
  taskbarTogglePosition: 'left' | 'custom' | 'right'
  taskbarToggleTrayReservedWidth: number
  taskbarToggleCustomRightGap: number
  taskbarModeShortcuts: boolean
  taskbarModeOpacity: number
}

export interface TaskbarModeState {
  enabled: boolean
  pulseTaskbarVisible: boolean
  modeWindowVisible: boolean
  toggleWindowVisible: boolean
  registeredShortcutCount: number
}

export type TaskbarModeAction = 'show-pulse' | 'show-windows' | 'toggle'

export interface TaskbarToggleSettingsPatch {
  taskbarTogglePosition: 'custom'
  taskbarToggleCustomRightGap: number
}

export interface TrackLyrics {
  trackId: string
  source: 'lrclib' | 'local-lrc' | 'local-txt' | 'manual'
  syncedLyrics?: string
  plainLyrics?: string
  instrumental?: boolean
  providerTrackId?: number
  fetchedAt: number
  matchedTitle?: string
  matchedArtist?: string
  userSelected?: boolean
}

export interface LyricsSyncAnchor {
  lyricTimeMs: number
  audioTimeMs: number
}

export interface LyricsSyncProfile {
  trackId: string
  offsetMs: number
  anchors: LyricsSyncAnchor[]
  updatedAt: number
}

export interface LyricsCandidate {
  id: number
  trackName: string
  artistName: string
  albumName?: string
  duration?: number
  syncedLyrics?: string
  plainLyrics?: string
  instrumental: boolean
  score?: number
  durationDelta?: number
}

export type LyricsLookupStatus =
  | 'found'
  | 'not-found'
  | 'low-confidence'
  | 'instrumental'
  | 'network-error'
  | 'rate-limited'
  | 'metadata-missing'

export interface LyricsSearchQuery {
  title?: string
  artist?: string
}

export interface LyricsSearchResult {
  status: LyricsLookupStatus
  candidates: LyricsCandidate[]
  normalizedTitle: string
  originalArtist?: string
}

export interface FocusTodo {
  id: string
  text: string
  completed: boolean
}

export interface FocusTimer {
  mode: FocusTimerMode
  status: FocusTimerStatus
  focusMinutes: number
  breakMinutes: number
  remainingSeconds: number
  startedAt?: number
  endsAt?: number
}

export interface FocusData {
  today: string
  focusedSeconds: number
  todos: FocusTodo[]
  timer: FocusTimer
}

export interface PlayerSession {
  queueIds: string[]
  currentIndex: number
  currentTime: number
  volume: number
  isMuted: boolean
  shuffle: boolean
  repeatMode: RepeatMode
}

export interface AppData {
  version: 4
  musicFolders: string[]
  tracks: Track[]
  libraryExclusions: LibraryExclusion[]
  playlists: Playlist[]
  recentTrackIds: string[]
  lyrics: Record<string, TrackLyrics>
  lyricsSyncProfiles: Record<string, LyricsSyncProfile>
  settings: Settings
  lastPage: PageId
  playerSession: PlayerSession
  focus: FocusData
  onboardingCompleted: boolean
}

export interface PlayerSnapshot {
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
}

export type PlayerCommand =
  | { type: 'toggle' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'seek'; value: number }
  | { type: 'toggle-shuffle' }
  | { type: 'cycle-repeat' }
  | { type: 'toggle-mute' }
  | { type: 'set-volume'; value: number }

export interface ScanProgress {
  phase: 'discovering' | 'reading' | 'finishing'
  discovered: number
  processed: number
  total: number
  currentFile: string
  errors: number
}

export interface ScanResult {
  cancelled: boolean
  tracks: Track[]
  folder?: string
  errors: string[]
}

export interface LyricsResult {
  kind: 'lrc' | 'text' | 'none'
  content: string
  status?: LyricsLookupStatus
}

export interface DataTransferResult {
  success: boolean
  cancelled: boolean
  message: string
  data?: AppData
}

export interface ViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface YouTubeViewState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  isVideoUrl: boolean
  videoId: string | null
  importAvailable: boolean
  importUnavailableReason: ImportAvailabilityReason
  existingTrackId: string | null
  error: string | null
}

export type YouTubeExtensionLoadState =
  | 'not-configured'
  | 'loaded'
  | 'disabled'
  | 'missing'
  | 'manifest-error'
  | 'load-error'

export interface YouTubeExtensionStatus {
  enabled: boolean
  extensionPath?: string
  extensionId?: string
  name?: string
  version?: string
  loadState: YouTubeExtensionLoadState
  error?: string
}

export type ImportAvailabilityReason =
  | 'ready'
  | 'service-not-installed'
  | 'binary-not-found'
  | 'unsupported-platform'
  | 'configuration-error'

export interface ImportAvailability {
  available: boolean
  reason: ImportAvailabilityReason
  outputDirectory: string
  version?: string
}

export type MediaImportStatus =
  | 'queued'
  | 'preparing'
  | 'downloading'
  | 'processing'
  | 'registering'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface MediaImportRequest {
  url: string
  source: 'youtube' | 'direct'
  replaceExisting?: boolean
}

export interface MediaImportJob {
  jobId: string
  source: 'youtube' | 'direct'
  sourceUrl: string
  sourceVideoId?: string
  status: MediaImportStatus
  progress: number | null
  title?: string
  message?: string
  errorCode?: string
  trackId?: string
  createdAt: number
  updatedAt: number
}
