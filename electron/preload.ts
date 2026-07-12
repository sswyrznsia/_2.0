import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronApi } from '../src/types/ipc'
import { IPC } from '../src/types/ipc'
import type {
  AutoSyncJob,
  MediaImportJob,
  PlayerCommand,
  PlayerSnapshot,
  TaskbarModeState,
  TaskbarToggleSettingsPatch,
} from '../src/types/models'
import type { ScanProgress, YouTubeViewState } from '../src/types/models'

const api: ElectronApi = {
  loadData: () => ipcRenderer.invoke(IPC.loadData),
  saveData: (data) => ipcRenderer.invoke(IPC.saveData, data),
  resetData: () => ipcRenderer.invoke(IPC.resetData),
  exportData: () => ipcRenderer.invoke(IPC.exportData),
  importData: () => ipcRenderer.invoke(IPC.importData),
  exportSyncPackage: (options) =>
    ipcRenderer.invoke(IPC.syncPackageExport, options),
  inspectSyncPackage: () => ipcRenderer.invoke(IPC.syncPackageInspect),
  importSyncPackage: (plan) => ipcRenderer.invoke(IPC.syncPackageImport, plan),
  getSyncPackageStatus: () => ipcRenderer.invoke(IPC.syncPackageGetStatus),
  estimateSyncPackage: (options) =>
    ipcRenderer.invoke(IPC.syncPackageEstimate, options),
  chooseMusicFolder: () => ipcRenderer.invoke(IPC.chooseMusicFolder),
  rescanMusicFolders: () => ipcRenderer.invoke(IPC.rescanMusicFolders),
  removeMusicFolder: (folder) =>
    ipcRenderer.invoke(IPC.removeMusicFolder, folder),
  removeTrack: (trackId) => ipcRenderer.invoke(IPC.removeTrack, trackId),
  trashTrack: (trackId) => ipcRenderer.invoke(IPC.trashTrack, trackId),
  getLibraryExclusions: () => ipcRenderer.invoke(IPC.getLibraryExclusions),
  restoreLibraryExclusion: (exclusionId) =>
    ipcRenderer.invoke(IPC.restoreLibraryExclusion, exclusionId),
  getTrackRemovalDetails: (trackId) =>
    ipcRenderer.invoke(IPC.getTrackRemovalDetails, trackId),
  cancelScan: () => ipcRenderer.send(IPC.cancelScan),
  onScanProgress: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      progress: ScanProgress,
    ) => listener(progress)
    ipcRenderer.on(IPC.scanProgress, handler)
    return () => ipcRenderer.removeListener(IPC.scanProgress, handler)
  },
  loadLyrics: (trackId) => ipcRenderer.invoke(IPC.loadLyrics, trackId),
  searchLyrics: (trackId, query) =>
    ipcRenderer.invoke(IPC.lyricsSearch, trackId, query),
  saveLyricsSelection: (trackId, candidate) =>
    ipcRenderer.invoke(IPC.lyricsSaveSelection, trackId, candidate),
  importLyricsFile: (trackId) =>
    ipcRenderer.invoke(IPC.lyricsImportFile, trackId),
  parseLyricsInput: (trackId, content) =>
    ipcRenderer.invoke(IPC.lyricsParseInput, trackId, content),
  removeLyrics: (trackId) => ipcRenderer.invoke(IPC.lyricsRemove, trackId),
  markLyricsInstrumental: (trackId) =>
    ipcRenderer.invoke(IPC.lyricsMarkInstrumental, trackId),
  clearLyricsCache: () => ipcRenderer.invoke(IPC.lyricsClearCache),
  reloadLyrics: (trackId) => ipcRenderer.invoke(IPC.lyricsReload, trackId),
  getLyricsSyncProfile: (trackId) =>
    ipcRenderer.invoke(IPC.lyricsSyncGet, trackId),
  saveLyricsSyncProfile: (profile) =>
    ipcRenderer.invoke(IPC.lyricsSyncSave, profile),
  clearLyricsSyncProfile: (trackId) =>
    ipcRenderer.invoke(IPC.lyricsSyncClear, trackId),
  getGeneratedLyricsTimeline: (trackId) =>
    ipcRenderer.invoke(IPC.generatedLyricsTimelineGet, trackId),
  saveGeneratedLyricsTimeline: (timeline) =>
    ipcRenderer.invoke(IPC.generatedLyricsTimelineSave, timeline),
  clearGeneratedLyricsTimeline: (trackId) =>
    ipcRenderer.invoke(IPC.generatedLyricsTimelineClear, trackId),
  getLyricsAutoSyncAvailability: (trackId) =>
    ipcRenderer.invoke(IPC.lyricsAutoSyncGetAvailability, trackId),
  startLyricsAutoSync: (trackId) =>
    ipcRenderer.invoke(IPC.lyricsAutoSyncStart, trackId),
  cancelLyricsAutoSync: (jobId) =>
    ipcRenderer.invoke(IPC.lyricsAutoSyncCancel, jobId),
  getLyricsAutoSyncJob: (trackId) =>
    ipcRenderer.invoke(IPC.lyricsAutoSyncGetActiveJob, trackId),
  discardLyricsAutoSync: (jobId) =>
    ipcRenderer.invoke(IPC.lyricsAutoSyncDiscard, jobId),
  onLyricsAutoSyncProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, job: AutoSyncJob) =>
      listener(job)
    ipcRenderer.on(IPC.lyricsAutoSyncProgress, handler)
    return () => ipcRenderer.removeListener(IPC.lyricsAutoSyncProgress, handler)
  },
  onLyricsAutoSyncCompleted: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, job: AutoSyncJob) =>
      listener(job)
    ipcRenderer.on(IPC.lyricsAutoSyncCompleted, handler)
    return () =>
      ipcRenderer.removeListener(IPC.lyricsAutoSyncCompleted, handler)
  },
  onLyricsAutoSyncFailed: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, job: AutoSyncJob) =>
      listener(job)
    ipcRenderer.on(IPC.lyricsAutoSyncFailed, handler)
    return () => ipcRenderer.removeListener(IPC.lyricsAutoSyncFailed, handler)
  },
  revealTrack: (trackId) => ipcRenderer.invoke(IPC.revealTrack, trackId),
  openMiniPlayer: () => ipcRenderer.invoke(IPC.openMiniPlayer),
  showMainWindow: () => ipcRenderer.invoke(IPC.showMainWindow),
  minimizeMainWindow: () => ipcRenderer.invoke(IPC.minimizeMainWindow),
  hideMainWindow: () => ipcRenderer.invoke(IPC.hideMainWindow),
  setMainWindowFullScreen: (fullscreen) =>
    ipcRenderer.invoke(IPC.setMainWindowFullScreen, fullscreen),
  quitApp: () => ipcRenderer.invoke(IPC.quitApp),
  closeMiniPlayer: () => ipcRenderer.invoke(IPC.closeMiniPlayer),
  taskbarModeAction: (action) =>
    ipcRenderer.invoke(IPC.taskbarModeAction, action),
  getTaskbarModeState: () => ipcRenderer.invoke(IPC.taskbarModeGetState),
  onTaskbarModeState: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: TaskbarModeState,
    ) => listener(state)
    ipcRenderer.on(IPC.taskbarModeState, handler)
    return () => ipcRenderer.removeListener(IPC.taskbarModeState, handler)
  },
  startTaskbarToggleDrag: (screenX) =>
    ipcRenderer.invoke(IPC.taskbarToggleDragStart, screenX),
  moveTaskbarToggleDrag: (screenX) =>
    ipcRenderer.send(IPC.taskbarToggleDragMove, screenX),
  endTaskbarToggleDrag: (screenX) =>
    ipcRenderer.invoke(IPC.taskbarToggleDragEnd, screenX),
  onTaskbarToggleSettingsChanged: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      patch: TaskbarToggleSettingsPatch,
    ) => listener(patch)
    ipcRenderer.on(IPC.taskbarToggleSettingsChanged, handler)
    return () =>
      ipcRenderer.removeListener(IPC.taskbarToggleSettingsChanged, handler)
  },
  captureTaskbarDesktop: () => ipcRenderer.invoke(IPC.taskbarCaptureDesktop),
  openMainQueue: () => ipcRenderer.invoke(IPC.openMainQueue),
  onOpenMainQueue: (listener) => {
    const handler = () => listener()
    ipcRenderer.on(IPC.openMainQueue, handler)
    return () => ipcRenderer.removeListener(IPC.openMainQueue, handler)
  },
  sendPlayerSnapshot: (snapshot, settings) =>
    ipcRenderer.send(IPC.playerSnapshot, snapshot, settings),
  onPlayerSnapshot: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: PlayerSnapshot,
    ) => listener(snapshot)
    ipcRenderer.on(IPC.playerSnapshot, handler)
    return () => ipcRenderer.removeListener(IPC.playerSnapshot, handler)
  },
  sendPlayerCommand: (command) => ipcRenderer.send(IPC.playerCommand, command),
  onPlayerCommand: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      command: PlayerCommand,
    ) => listener(command)
    ipcRenderer.on(IPC.playerCommand, handler)
    return () => ipcRenderer.removeListener(IPC.playerCommand, handler)
  },
  logRendererError: (message, stack) =>
    ipcRenderer.send(IPC.logRendererError, message, stack),
  youtubeOpen: () => ipcRenderer.invoke(IPC.youtubeOpen),
  youtubeClose: () => ipcRenderer.invoke(IPC.youtubeClose),
  setYouTubeBounds: (bounds) => ipcRenderer.send(IPC.youtubeBounds, bounds),
  navigateYouTube: (url) => ipcRenderer.invoke(IPC.youtubeNavigate, url),
  goBackYouTube: () => ipcRenderer.invoke(IPC.youtubeBack),
  goForwardYouTube: () => ipcRenderer.invoke(IPC.youtubeForward),
  reloadYouTube: () => ipcRenderer.invoke(IPC.youtubeReload),
  goHomeYouTube: () => ipcRenderer.invoke(IPC.youtubeHome),
  getCurrentYouTubeUrl: () => ipcRenderer.invoke(IPC.youtubeGetCurrentUrl),
  openYouTubeExternal: () => ipcRenderer.invoke(IPC.youtubeOpenExternal),
  clearYouTubeData: () => ipcRenderer.invoke(IPC.youtubeClearData),
  getYouTubeExtensionStatus: () =>
    ipcRenderer.invoke(IPC.youtubeExtensionGetStatus),
  selectYouTubeExtensionFolder: () =>
    ipcRenderer.invoke(IPC.youtubeExtensionSelectFolder),
  loadYouTubeExtension: () => ipcRenderer.invoke(IPC.youtubeExtensionLoad),
  reloadYouTubeExtension: () => ipcRenderer.invoke(IPC.youtubeExtensionReload),
  disableYouTubeExtension: () =>
    ipcRenderer.invoke(IPC.youtubeExtensionDisable),
  removeYouTubeExtension: () => ipcRenderer.invoke(IPC.youtubeExtensionRemove),
  openYouTubeExtensionFolder: () =>
    ipcRenderer.invoke(IPC.youtubeExtensionOpenFolder),
  onYouTubeState: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: YouTubeViewState,
    ) => listener(state)
    ipcRenderer.on(IPC.youtubeState, handler)
    return () => ipcRenderer.removeListener(IPC.youtubeState, handler)
  },
  getMediaImportAvailability: () =>
    ipcRenderer.invoke(IPC.mediaImportGetAvailability),
  getMediaImportJobs: () => ipcRenderer.invoke(IPC.mediaImportGetJobs),
  startMediaImport: (request) =>
    ipcRenderer.invoke(IPC.mediaImportStart, request),
  cancelMediaImport: (jobId) =>
    ipcRenderer.invoke(IPC.mediaImportCancel, jobId),
  onMediaImportProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, job: MediaImportJob) =>
      listener(job)
    ipcRenderer.on(IPC.mediaImportProgress, handler)
    return () => ipcRenderer.removeListener(IPC.mediaImportProgress, handler)
  },
  onMediaImportCompleted: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, job: MediaImportJob) =>
      listener(job)
    ipcRenderer.on(IPC.mediaImportCompleted, handler)
    return () => ipcRenderer.removeListener(IPC.mediaImportCompleted, handler)
  },
  onMediaImportFailed: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, job: MediaImportJob) =>
      listener(job)
    ipcRenderer.on(IPC.mediaImportFailed, handler)
    return () => ipcRenderer.removeListener(IPC.mediaImportFailed, handler)
  },
}

contextBridge.exposeInMainWorld('electronAPI', api)
