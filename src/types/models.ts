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
  syncId?: string
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
  taskbarLyricsEnabled: boolean
  taskbarLyricsDisplay: 'off' | 'current' | 'current-next'
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

export type UserLyricsSource = 'imported-lrc' | 'imported-text' | 'manual-input'

export interface TrackLyrics {
  trackId: string
  source:
    | 'lrclib'
    | 'lyrica'
    | 'local-lrc'
    | 'local-txt'
    | 'manual'
    | UserLyricsSource
  syncedLyrics?: string
  plainLyrics?: string
  instrumental?: boolean
  providerTrackId?: number
  fetchedAt: number
  matchedTitle?: string
  matchedArtist?: string
  provider?: 'lrclib' | 'lyrica'
  providerSource?: string
  sourceLabel?: string
  alternateSourceLabels?: string[]
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
  source?: 'manual' | 'ai'
  autoSyncMetadata?: {
    model: string
    matchedLines: number
    totalLines: number
    confidence: number
    processingTimeMs: number
  }
}

export interface GeneratedLyricsLineTiming {
  lineIndex: number
  textHash: string
  audioTimeMs: number
  confidence?: number
  source?: AutoSyncTimingSource | 'manual'
}

export interface GeneratedLyricsTimeline {
  trackId: string
  source: 'ai' | 'manual'
  lines: GeneratedLyricsLineTiming[]
  lineCount: number
  lyricsTextHash: string
  model?: string
  createdAt: number
}

export interface GeneratedLyricsTimelineState {
  timeline: GeneratedLyricsTimeline | null
  valid: boolean
  reason?: 'lyrics-missing' | 'text-changed' | 'timeline-invalid'
}

export type AutoSyncStage =
  | 'preparing'
  | 'separating'
  | 'releasing-separator'
  | 'transcribing'
  | 'matching'
  | 'building-anchors'
  | 'validating'

export type AutoSyncJobStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export type AutoSyncErrorCode =
  | 'python-missing'
  | 'package-missing'
  | 'separator-model-missing'
  | 'whisper-model-missing'
  | 'cuda-unavailable'
  | 'gpu-out-of-memory'
  | 'ffmpeg-missing'
  | 'audio-missing'
  | 'plain-lyrics-missing'
  | 'synced-lyrics-missing'
  | 'separation-failed'
  | 'transcription-failed'
  | 'matching-failed'
  | 'profile-invalid'
  | 'duplicate-job'
  | 'cancelled'
  | 'process-failed'
  | 'service-unavailable'

export interface AutoSyncAvailability {
  available: boolean
  device: 'cuda' | 'cpu' | null
  gpuName?: string
  modelName?: string
  missingRequirements: string[]
  reason?: string
  checkedAt: number
}

export interface AutoSyncLineConfidence {
  lineIndex: number
  confidence: number
  source?: AutoSyncTimingSource
}

export type AutoSyncTimingSource =
  | 'direct'
  | 'segment_recovered'
  | 'interpolated'
  | 'local_retry'
  | 'unmatched'

export interface AutoSyncLineTiming {
  lineIndex: number
  source: AutoSyncTimingSource
  confidence: number
  audioTimeMs: number | null
}

export interface AutoSyncResult {
  trackId: string
  model: {
    separator: string
    whisper: string
  }
  matchedLines: number
  totalLines: number
  matchRate: number
  confidence: number
  lyricsSyncProfile: LyricsSyncProfile
  generatedLyricsTimeline?: GeneratedLyricsTimeline
  unmatchedLines: number[]
  temporalOutlierLines: number[]
  lowConfidenceLines: AutoSyncLineConfidence[]
  lineTimings: AutoSyncLineTiming[]
  processingTimeMs: number
  peakGpuMemoryMiB: number | null
  canApply: boolean
  qualityMessage?: string
  cacheHit: boolean
}

export interface AutoSyncJobError {
  code: AutoSyncErrorCode
  message: string
}

export interface AutoSyncJob {
  jobId: string
  trackId: string
  status: AutoSyncJobStatus
  stage: AutoSyncStage
  overallProgress: number | null
  stageProgress: number | null
  completedStages: number
  totalStages: number
  elapsedMs: number
  modelName?: string
  message?: string
  result?: AutoSyncResult
  error?: AutoSyncJobError
  createdAt: number
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
  provider?: 'lrclib' | 'lyrica'
  providerSource?: string
  sourceLabel?: string
  alternateSourceLabels?: string[]
  language?: string
  providerMetadata?: Record<string, string | number | boolean | null>
  timestampValid?: boolean
  validLrcLineCount?: number
  source?: UserLyricsSource
}

export type LyricsLookupStatus =
  | 'found'
  | 'not-found'
  | 'low-confidence'
  | 'instrumental'
  | 'network-error'
  | 'rate-limited'
  | 'metadata-missing'

export type LyricsProvider = 'lyrica' | 'lrclib'

export type LyricsProviderAttemptStatus =
  | 'success'
  | 'not-found'
  | 'network-error'
  | 'timeout'
  | 'rate-limited'
  | 'invalid-response'
  | 'server-error'

export interface LyricsProviderAttempt {
  provider: LyricsProvider
  status: LyricsProviderAttemptStatus
}

export interface LyricsSearchQuery {
  title?: string
  artist?: string
}

export interface LyricsSearchResult {
  status: LyricsLookupStatus
  candidates: LyricsCandidate[]
  normalizedTitle: string
  originalArtist?: string
  providerAttempts?: LyricsProviderAttempt[]
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
  generatedLyricsTimelines: Record<string, GeneratedLyricsTimeline>
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
  lyrics?: TaskbarLyricsSnapshot
}

export interface TaskbarLyricsSnapshot {
  currentLine?: string
  nextLine?: string
  hasSync: boolean
  source?: 'synced' | 'generated'
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

export interface SyncTrackIdentity {
  youtubeVideoId?: string
  sourceType?: string
  sourceId?: string
  fileSha256?: string
  durationMs?: number
  normalizedTitle?: string
  normalizedArtist?: string
}

export interface SyncPackageExportOptions {
  lyrics: boolean
  playlists: boolean
  likes: boolean
  metadataOverrides: boolean
}

export interface SyncTrackRecord {
  recordId: string
  identity: SyncTrackIdentity
  metadata?: {
    title?: string
    artist?: string
    album?: string
  }
  liked?: boolean
  lyrics?: Omit<TrackLyrics, 'trackId'>
  lyricsSyncProfile?: Omit<LyricsSyncProfile, 'trackId'>
  generatedLyricsTimeline?: Omit<GeneratedLyricsTimeline, 'trackId'>
}

export interface SyncPlaylistRecord {
  syncId: string
  name: string
  tracks: SyncTrackIdentity[]
  createdAt: number
  updatedAt: number
  coverTrack?: SyncTrackIdentity
}

export interface PulseShelfSyncPackageV1 {
  schemaVersion: 1
  appVersion: string
  exportedAt: number
  deviceId: string
  tracks: SyncTrackRecord[]
  playlists: SyncPlaylistRecord[]
  exportOptions: SyncPackageExportOptions
}

export type SyncTrackMatchKind = 'exact' | 'possible' | 'missing'
export type SyncConflictKind =
  'lyrics' | 'lyricsSyncProfile' | 'generatedLyricsTimeline' | 'metadata'

export interface SyncConflictPreview {
  kind: SyncConflictKind
  localSummary: string
  importedSummary: string
  recommended: 'local' | 'imported'
}

export interface SyncMatchCandidate {
  trackId: string
  title: string
  artist: string
  durationMs: number
  conflicts?: SyncConflictPreview[]
}

export interface SyncTrackPreview {
  recordId: string
  title: string
  artist: string
  matchKind: SyncTrackMatchKind
  localTrackId?: string
  candidates: SyncMatchCandidate[]
  conflicts: SyncConflictPreview[]
  importedData: string[]
}

export interface SyncPackageInspection {
  token: string
  fileName: string
  exportedAt: number
  appVersion: string
  tracks: SyncTrackPreview[]
  playlistCount: number
  exactMatches: number
  possibleMatches: number
  missingTracks: number
  conflictCount: number
  invalidEntries: number
}

export interface SyncPackageInspectResult {
  success: boolean
  cancelled: boolean
  message: string
  inspection?: SyncPackageInspection
}

export interface SyncImportTrackChoice {
  recordId: string
  localTrackId?: string
  conflicts?: Partial<Record<SyncConflictKind, 'local' | 'imported'>>
}

export interface SyncPackageImportPlan {
  token: string
  tracks: SyncImportTrackChoice[]
  likesMode: 'union' | 'replace'
  playlistMode: 'newer' | 'local' | 'imported'
}

export interface SyncPackageOperationResult {
  success: boolean
  cancelled: boolean
  message: string
  data?: AppData
  summary?: {
    matchedTracks: number
    skippedTracks: number
    lyrics: number
    likes: number
    playlists: number
    conflicts: number
  }
}

export interface SyncPackageStatus {
  busy: boolean
  operation?: 'export' | 'inspect' | 'import'
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
