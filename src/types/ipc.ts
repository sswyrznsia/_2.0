import type {
  AppData,
  DataTransferResult,
  LyricsResult,
  LyricsCandidate,
  LyricsSearchQuery,
  LyricsSearchResult,
  LyricsSyncProfile,
  ImportAvailability,
  LibraryExclusion,
  LibraryMutationResult,
  MediaImportJob,
  MediaImportRequest,
  PlayerCommand,
  PlayerSnapshot,
  ScanProgress,
  ScanResult,
  Settings,
  TaskbarModeAction,
  TaskbarModeState,
  TaskbarToggleSettingsPatch,
  TrackRemovalDetails,
  ViewBounds,
  YouTubeViewState,
  YouTubeExtensionStatus,
} from './models'

export const IPC = {
  loadData: 'data:load',
  saveData: 'data:save',
  resetData: 'data:reset',
  exportData: 'data:export',
  importData: 'data:import',
  chooseMusicFolder: 'library:choose-folder',
  rescanMusicFolders: 'library:rescan',
  removeMusicFolder: 'library:remove-folder',
  removeTrack: 'library:remove-track',
  trashTrack: 'library:trash-track',
  getLibraryExclusions: 'library:get-exclusions',
  restoreLibraryExclusion: 'library:restore-exclusion',
  getTrackRemovalDetails: 'library:get-track-removal-details',
  scanProgress: 'library:scan-progress',
  cancelScan: 'library:cancel-scan',
  loadLyrics: 'library:load-lyrics',
  lyricsSearch: 'lyrics:search',
  lyricsSaveSelection: 'lyrics:save-selection',
  lyricsRemove: 'lyrics:remove',
  lyricsMarkInstrumental: 'lyrics:mark-instrumental',
  lyricsClearCache: 'lyrics:clear-cache',
  lyricsReload: 'lyrics:reload',
  lyricsSyncGet: 'lyrics-sync:get',
  lyricsSyncSave: 'lyrics-sync:save',
  lyricsSyncClear: 'lyrics-sync:clear',
  revealTrack: 'library:reveal-track',
  openMiniPlayer: 'window:open-mini',
  showMainWindow: 'window:show-main',
  minimizeMainWindow: 'window:minimize-main',
  hideMainWindow: 'window:hide-main',
  setMainWindowFullScreen: 'window:set-main-fullscreen',
  quitApp: 'app:quit',
  closeMiniPlayer: 'window:close-mini',
  taskbarModeAction: 'window:taskbar-mode-action',
  taskbarModeGetState: 'window:taskbar-mode-get-state',
  taskbarModeState: 'window:taskbar-mode-state',
  taskbarToggleDragStart: 'window:taskbar-toggle-drag-start',
  taskbarToggleDragMove: 'window:taskbar-toggle-drag-move',
  taskbarToggleDragEnd: 'window:taskbar-toggle-drag-end',
  taskbarToggleSettingsChanged: 'window:taskbar-toggle-settings-changed',
  taskbarCaptureDesktop: 'window:taskbar-capture-desktop',
  openMainQueue: 'window:open-main-queue',
  playerSnapshot: 'player:snapshot',
  playerCommand: 'player:command',
  logRendererError: 'log:renderer-error',
  youtubeOpen: 'youtube:view-show',
  youtubeClose: 'youtube:view-hide',
  youtubeBounds: 'youtube:view-set-bounds',
  youtubeNavigate: 'youtube:navigate',
  youtubeBack: 'youtube:back',
  youtubeForward: 'youtube:forward',
  youtubeReload: 'youtube:reload',
  youtubeHome: 'youtube:home',
  youtubeGetCurrentUrl: 'youtube:get-current-url',
  youtubeOpenExternal: 'youtube:open-external',
  youtubeClearData: 'youtube:clear-data',
  youtubeState: 'youtube:navigation-state-changed',
  youtubeExtensionGetStatus: 'youtube-extension:get-status',
  youtubeExtensionSelectFolder: 'youtube-extension:select-folder',
  youtubeExtensionLoad: 'youtube-extension:load',
  youtubeExtensionReload: 'youtube-extension:reload',
  youtubeExtensionDisable: 'youtube-extension:disable',
  youtubeExtensionRemove: 'youtube-extension:remove',
  youtubeExtensionOpenFolder: 'youtube-extension:open-folder',
  mediaImportGetAvailability: 'media-import:get-availability',
  mediaImportGetJobs: 'media-import:get-jobs',
  mediaImportStart: 'media-import:start',
  mediaImportCancel: 'media-import:cancel',
  mediaImportProgress: 'media-import:progress',
  mediaImportCompleted: 'media-import:completed',
  mediaImportFailed: 'media-import:failed',
} as const

export interface ElectronApi {
  loadData: () => Promise<AppData>
  saveData: (data: AppData) => Promise<AppData>
  resetData: () => Promise<AppData>
  exportData: () => Promise<DataTransferResult>
  importData: () => Promise<DataTransferResult>
  chooseMusicFolder: () => Promise<ScanResult>
  rescanMusicFolders: () => Promise<ScanResult>
  removeMusicFolder: (folder: string) => Promise<ScanResult>
  removeTrack: (trackId: string) => Promise<LibraryMutationResult>
  trashTrack: (trackId: string) => Promise<LibraryMutationResult>
  getLibraryExclusions: () => Promise<LibraryExclusion[]>
  restoreLibraryExclusion: (exclusionId: string) => Promise<AppData>
  getTrackRemovalDetails: (trackId: string) => Promise<TrackRemovalDetails>
  cancelScan: () => void
  onScanProgress: (listener: (progress: ScanProgress) => void) => () => void
  loadLyrics: (trackId: string) => Promise<LyricsResult>
  searchLyrics: (
    trackId: string,
    query?: LyricsSearchQuery,
  ) => Promise<LyricsSearchResult>
  saveLyricsSelection: (
    trackId: string,
    candidate: LyricsCandidate,
  ) => Promise<LyricsResult>
  removeLyrics: (trackId: string) => Promise<void>
  markLyricsInstrumental: (trackId: string) => Promise<void>
  clearLyricsCache: () => Promise<void>
  reloadLyrics: (trackId: string) => Promise<LyricsResult>
  getLyricsSyncProfile: (trackId: string) => Promise<LyricsSyncProfile | null>
  saveLyricsSyncProfile: (profile: LyricsSyncProfile) => Promise<LyricsSyncProfile>
  clearLyricsSyncProfile: (trackId: string) => Promise<void>
  revealTrack: (trackId: string) => Promise<boolean>
  openMiniPlayer: () => Promise<void>
  showMainWindow: () => Promise<void>
  minimizeMainWindow: () => Promise<void>
  hideMainWindow: () => Promise<void>
  setMainWindowFullScreen: (fullscreen: boolean) => Promise<void>
  quitApp: () => Promise<void>
  closeMiniPlayer: () => Promise<void>
  taskbarModeAction: (action: TaskbarModeAction) => Promise<TaskbarModeState>
  getTaskbarModeState: () => Promise<TaskbarModeState>
  onTaskbarModeState: (
    listener: (state: TaskbarModeState) => void,
  ) => () => void
  startTaskbarToggleDrag: (screenX: number) => Promise<void>
  moveTaskbarToggleDrag: (screenX: number) => void
  endTaskbarToggleDrag: (screenX: number) => Promise<TaskbarModeState>
  onTaskbarToggleSettingsChanged: (
    listener: (patch: TaskbarToggleSettingsPatch) => void,
  ) => () => void
  captureTaskbarDesktop: () => Promise<string | null>
  openMainQueue: () => Promise<void>
  onOpenMainQueue: (listener: () => void) => () => void
  sendPlayerSnapshot: (snapshot: PlayerSnapshot, settings: Settings) => void
  onPlayerSnapshot: (listener: (snapshot: PlayerSnapshot) => void) => () => void
  sendPlayerCommand: (command: PlayerCommand) => void
  onPlayerCommand: (listener: (command: PlayerCommand) => void) => () => void
  logRendererError: (message: string, stack?: string) => void
  youtubeOpen: () => Promise<YouTubeViewState>
  youtubeClose: () => Promise<void>
  setYouTubeBounds: (bounds: ViewBounds) => void
  navigateYouTube: (url: string) => Promise<YouTubeViewState>
  goBackYouTube: () => Promise<YouTubeViewState>
  goForwardYouTube: () => Promise<YouTubeViewState>
  reloadYouTube: () => Promise<YouTubeViewState>
  goHomeYouTube: () => Promise<YouTubeViewState>
  getCurrentYouTubeUrl: () => Promise<string>
  openYouTubeExternal: () => Promise<boolean>
  clearYouTubeData: () => Promise<void>
  onYouTubeState: (listener: (state: YouTubeViewState) => void) => () => void
  getYouTubeExtensionStatus: () => Promise<YouTubeExtensionStatus>
  selectYouTubeExtensionFolder: () => Promise<YouTubeExtensionStatus>
  loadYouTubeExtension: () => Promise<YouTubeExtensionStatus>
  reloadYouTubeExtension: () => Promise<YouTubeExtensionStatus>
  disableYouTubeExtension: () => Promise<YouTubeExtensionStatus>
  removeYouTubeExtension: () => Promise<YouTubeExtensionStatus>
  openYouTubeExtensionFolder: () => Promise<boolean>
  getMediaImportAvailability: () => Promise<ImportAvailability>
  getMediaImportJobs: () => Promise<MediaImportJob[]>
  startMediaImport: (request: MediaImportRequest) => Promise<MediaImportJob>
  cancelMediaImport: (jobId: string) => Promise<boolean>
  onMediaImportProgress: (listener: (job: MediaImportJob) => void) => () => void
  onMediaImportCompleted: (
    listener: (job: MediaImportJob) => void,
  ) => () => void
  onMediaImportFailed: (listener: (job: MediaImportJob) => void) => () => void
}
