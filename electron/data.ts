import { copyFileSync, existsSync, statSync } from 'node:fs'
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import ElectronStore from 'electron-store'
import { z } from 'zod'
import type {
  AppData,
  LibraryExclusion,
  MusicFormat,
  Track,
  TrackLyrics,
  LyricsSyncProfile,
} from '../src/types/models'

export interface StoredTrack extends Track {
  filePath: string
}

export interface StoredLibraryExclusion extends LibraryExclusion {
  track: StoredTrack
  lyrics?: TrackLyrics
  lyricsSyncProfile?: LyricsSyncProfile
}

export interface StoredAppData extends Omit<
  AppData,
  'tracks' | 'libraryExclusions'
> {
  tracks: StoredTrack[]
  libraryExclusions: StoredLibraryExclusion[]
}

const today = () => new Date().toISOString().slice(0, 10)

export const createDefaultData = (): StoredAppData => ({
  version: 4,
  musicFolders: [],
  tracks: [],
  libraryExclusions: [],
  playlists: [],
  recentTrackIds: [],
  lyrics: {},
  lyricsSyncProfiles: {},
  generatedLyricsTimelines: {},
  settings: {
    theme: 'dark',
    restoreLastPage: true,
    restoreQueue: true,
    autoplay: false,
    discordPresence: false,
    autoLaunch: false,
    closeBehavior: 'quit',
    miniAlwaysOnTop: true,
    defaultVolume: 0.8,
    autoFetchLyricsOnImport: true,
    autoFetchLyricsOnPlay: true,
    preferSyncedLyrics: true,
    lyricsAutoMatchThreshold: 0.9,
    taskbarModeEnabled: false,
    taskbarModeShowOnStartup: true,
    taskbarModeRestoreLastState: true,
    taskbarTogglePosition: 'right',
    taskbarToggleTrayReservedWidth: 350,
    taskbarToggleCustomRightGap: 362,
    taskbarModeShortcuts: true,
    taskbarModeOpacity: 1,
    taskbarLyricsEnabled: true,
    taskbarLyricsDisplay: 'current-next',
  },
  lastPage: 'home',
  playerSession: {
    queueIds: [],
    currentIndex: -1,
    currentTime: 0,
    volume: 0.8,
    isMuted: false,
    shuffle: false,
    repeatMode: 'off',
  },
  focus: {
    today: today(),
    focusedSeconds: 0,
    todos: [],
    timer: {
      mode: 'focus',
      status: 'idle',
      focusMinutes: 25,
      breakMinutes: 5,
      remainingSeconds: 25 * 60,
    },
  },
  onboardingCompleted: false,
})

const publicTrackSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  fileName: z.string().min(1).max(500),
  title: z.string().max(500),
  artist: z.string().max(500),
  album: z.string().max(500),
  duration: z.number().finite().nonnegative(),
  format: z.enum(['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus']),
  fileSize: z.number().int().nonnegative(),
  modifiedAt: z.number().nonnegative(),
  addedAt: z.number().nonnegative(),
  trackNumber: z.number().int().positive().optional(),
  discNumber: z.number().int().positive().optional(),
  year: z.number().int().min(1000).max(9999).optional(),
  coverUrl: z.string().startsWith('pulse-cover://track/').optional(),
  liked: z.boolean(),
  lastPlayedAt: z.number().nonnegative().optional(),
  playCount: z.number().int().nonnegative(),
  source: z.enum(['youtube', 'direct']).optional(),
  sourceUrl: z.string().url().startsWith('https://').max(2048).optional(),
  sourceVideoId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{11}$/)
    .optional(),
})

export const settingsSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']),
  restoreLastPage: z.boolean(),
  restoreQueue: z.boolean(),
  autoplay: z.boolean(),
  discordPresence: z.boolean(),
  autoLaunch: z.boolean(),
  closeBehavior: z.enum(['quit', 'tray']),
  miniAlwaysOnTop: z.boolean(),
  defaultVolume: z.number().min(0).max(1),
  autoFetchLyricsOnImport: z.boolean(),
  autoFetchLyricsOnPlay: z.boolean(),
  preferSyncedLyrics: z.boolean(),
  lyricsAutoMatchThreshold: z.number().min(0).max(1),
  taskbarModeEnabled: z.boolean(),
  taskbarModeShowOnStartup: z.boolean(),
  taskbarModeRestoreLastState: z.boolean(),
  taskbarTogglePosition: z.enum(['left', 'custom', 'right']),
  taskbarToggleTrayReservedWidth: z.number().int().min(180).max(700),
  taskbarToggleCustomRightGap: z.number().int().min(192).max(1_920),
  taskbarModeShortcuts: z.boolean(),
  taskbarModeOpacity: z.number().min(0.85).max(1),
  taskbarLyricsEnabled: z.boolean(),
  taskbarLyricsDisplay: z.enum(['off', 'current', 'current-next']),
})

export const appDataSchema = z.object({
  version: z.literal(4),
  musicFolders: z.array(z.string().min(1).max(32_767)).max(100),
  tracks: z.array(publicTrackSchema).max(200_000),
  libraryExclusions: z
    .array(
      z.object({
        id: z.string().uuid(),
        filePathHash: z.string().regex(/^[a-f0-9]{64}$/),
        excludedAt: z.number().nonnegative(),
      }),
    )
    .max(200_000),
  playlists: z
    .array(
      z.object({
        id: z.string().uuid(),
        syncId: z.string().uuid().optional(),
        name: z.string().trim().min(1).max(80),
        trackIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(100_000),
        createdAt: z.number().nonnegative(),
        updatedAt: z.number().nonnegative(),
        coverTrackId: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      }),
    )
    .max(5_000),
  recentTrackIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(24),
  lyrics: z.record(
    z.string().regex(/^[a-f0-9]{64}$/),
    z.object({
      trackId: z.string().regex(/^[a-f0-9]{64}$/),
      source: z.enum([
        'lrclib',
        'lyrica',
        'local-lrc',
        'local-txt',
        'manual',
        'imported-lrc',
        'imported-text',
        'manual-input',
      ]),
      syncedLyrics: z.string().max(2_000_000).optional(),
      plainLyrics: z.string().max(2_000_000).optional(),
      instrumental: z.boolean().optional(),
      providerTrackId: z.number().int().optional(),
      fetchedAt: z.number().nonnegative(),
      matchedTitle: z.string().max(500).optional(),
      matchedArtist: z.string().max(500).optional(),
      provider: z.enum(['lrclib', 'lyrica']).optional(),
      providerSource: z.string().max(60).optional(),
      sourceLabel: z.string().max(100).optional(),
      alternateSourceLabels: z.array(z.string().max(100)).max(10).optional(),
      userSelected: z.boolean().optional(),
    }),
  ),
  lyricsSyncProfiles: z.record(
    z.string().regex(/^[a-f0-9]{64}$/),
    z.object({
      trackId: z.string().regex(/^[a-f0-9]{64}$/),
      offsetMs: z.number().finite(),
      anchors: z
        .array(
          z.object({
            lyricTimeMs: z.number().finite().nonnegative(),
            audioTimeMs: z.number().finite().nonnegative(),
          }),
        )
        .max(100),
      updatedAt: z.number().finite().nonnegative(),
      source: z.enum(['manual', 'ai']).optional(),
      autoSyncMetadata: z
        .object({
          model: z.string().trim().min(1).max(200),
          matchedLines: z.number().int().nonnegative(),
          totalLines: z.number().int().positive(),
          confidence: z.number().finite().min(0).max(1),
          processingTimeMs: z.number().finite().nonnegative(),
        })
        .optional(),
    }),
  ),
  generatedLyricsTimelines: z.record(
    z.string().regex(/^[a-f0-9]{64}$/),
    z.object({
      trackId: z.string().regex(/^[a-f0-9]{64}$/),
      source: z.enum(['ai', 'manual']),
      lines: z
        .array(
          z.object({
            lineIndex: z.number().int().nonnegative(),
            textHash: z.string().regex(/^[a-f0-9]{16}$/),
            audioTimeMs: z.number().int().nonnegative(),
            confidence: z.number().finite().min(0).max(1).optional(),
            source: z
              .enum([
                'direct',
                'segment_recovered',
                'interpolated',
                'local_retry',
                'unmatched',
                'manual',
              ])
              .optional(),
          }),
        )
        .max(20_000),
      lineCount: z.number().int().positive().max(20_000),
      lyricsTextHash: z.string().regex(/^[a-f0-9]{16}$/),
      model: z.string().trim().min(1).max(500).optional(),
      createdAt: z.number().finite().nonnegative(),
    }),
  ),
  settings: settingsSchema,
  lastPage: z.enum([
    'home',
    'library',
    'youtube',
    'liked',
    'playlists',
    'focus',
    'settings',
  ]),
  playerSession: z.object({
    queueIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(100_000),
    currentIndex: z.number().int().min(-1),
    currentTime: z.number().finite().nonnegative(),
    volume: z.number().min(0).max(1),
    isMuted: z.boolean(),
    shuffle: z.boolean(),
    repeatMode: z.enum(['off', 'one', 'all']),
  }),
  focus: z.object({
    today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    focusedSeconds: z.number().int().nonnegative(),
    todos: z
      .array(
        z.object({
          id: z.string().uuid(),
          text: z.string().trim().min(1).max(120),
          completed: z.boolean(),
        }),
      )
      .max(500),
    timer: z.object({
      mode: z.enum(['focus', 'break']),
      status: z.enum(['idle', 'running', 'paused']),
      focusMinutes: z.number().int().min(1).max(180),
      breakMinutes: z.number().int().min(1).max(60),
      remainingSeconds: z
        .number()
        .int()
        .min(0)
        .max(180 * 60),
      startedAt: z.number().nonnegative().optional(),
      endsAt: z.number().nonnegative().optional(),
    }),
  }),
  onboardingCompleted: z.boolean(),
})

const storedDataSchema = appDataSchema.extend({
  tracks: z
    .array(
      publicTrackSchema.extend({ filePath: z.string().min(1).max(32_767) }),
    )
    .max(200_000),
  libraryExclusions: z
    .array(
      z.object({
        id: z.string().uuid(),
        filePathHash: z.string().regex(/^[a-f0-9]{64}$/),
        excludedAt: z.number().nonnegative(),
        track: publicTrackSchema.extend({
          filePath: z.string().min(1).max(32_767),
        }),
        lyrics: appDataSchema.shape.lyrics.valueType.optional(),
        lyricsSyncProfile:
          appDataSchema.shape.lyricsSyncProfiles.valueType.optional(),
      }),
    )
    .max(200_000),
})

let store: ElectronStore<{ data: StoredAppData }> | undefined
const trackIdReplacements = new Map<string, string>()

export function registerTrackIdReplacement(oldId: string, newId: string) {
  trackIdReplacements.set(oldId, newId)
}

function currentTrackId(id: string): string {
  return trackIdReplacements.get(id) ?? id
}

export function initializeStore() {
  const options = {
    name: 'pulse-shelf-data',
    clearInvalidConfig: true,
    defaults: { data: createDefaultData() },
  } as const
  store = new ElectronStore<{ data: StoredAppData }>(options)
  const raw = store.get('data') as unknown
  const migrated = migrateData(raw)
  const result = storedDataSchema.safeParse(migrated)
  if (!result.success) {
    backupInvalidStore(store.path)
    store.set('data', createDefaultData())
  } else {
    store.set('data', normalizeFocus(result.data))
  }
}

function backupInvalidStore(storePath: string) {
  try {
    if (existsSync(storePath))
      copyFileSync(storePath, `${storePath}.invalid-${Date.now()}.bak`)
  } catch {
    // Recovery must continue even when a backup cannot be written.
  }
}

function migrateData(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  let old = value as Record<string, unknown>
  const defaults = createDefaultData()
  if (old.version === 4) {
    const oldSettings = (old.settings ?? {}) as Record<string, unknown>
    const settings: Record<string, unknown> = {
      ...defaults.settings,
      ...oldSettings,
      taskbarModeEnabled:
        oldSettings.taskbarModeEnabled ??
        oldSettings.taskbarPlayerEnabled ??
        defaults.settings.taskbarModeEnabled,
      taskbarModeShowOnStartup:
        oldSettings.taskbarModeShowOnStartup ??
        oldSettings.taskbarPlayerShowOnStartup ??
        defaults.settings.taskbarModeShowOnStartup,
      taskbarModeRestoreLastState:
        oldSettings.taskbarModeRestoreLastState ?? true,
      taskbarTogglePosition:
        oldSettings.taskbarTogglePosition ??
        oldSettings.taskbarPlayerPosition ??
        defaults.settings.taskbarTogglePosition,
      taskbarToggleTrayReservedWidth:
        oldSettings.taskbarToggleTrayReservedWidth ??
        oldSettings.taskbarPlayerTrayReservedWidth ??
        defaults.settings.taskbarToggleTrayReservedWidth,
      taskbarToggleCustomRightGap:
        oldSettings.taskbarToggleCustomRightGap ??
        oldSettings.taskbarPlayerCustomRightGap ??
        defaults.settings.taskbarToggleCustomRightGap,
      taskbarModeShortcuts:
        oldSettings.taskbarModeShortcuts ??
        oldSettings.taskbarPlayerShortcuts ??
        defaults.settings.taskbarModeShortcuts,
      taskbarModeOpacity: oldSettings.taskbarModeOpacity ?? 1,
      taskbarLyricsEnabled: oldSettings.taskbarLyricsEnabled ?? true,
      taskbarLyricsDisplay:
        oldSettings.taskbarLyricsDisplay ?? 'current-next',
    }
    if (settings.taskbarTogglePosition === 'center')
      settings.taskbarTogglePosition = 'custom'
    for (const key of Object.keys(settings))
      if (key.startsWith('taskbarPlayer')) delete settings[key]
    return {
      ...defaults,
      ...old,
      lyrics: old.lyrics ?? {},
      libraryExclusions: old.libraryExclusions ?? [],
      settings,
    }
  }
  if (old.version === 3) {
    return {
      ...defaults,
      ...old,
      version: 4,
      lyrics: old.lyrics ?? {},
      libraryExclusions: [],
      settings: { ...defaults.settings, ...(old.settings as object) },
    }
  }
  if (old.version === 2) {
    const settings = (old.settings ?? {}) as Record<string, unknown>
    return {
      ...old,
      version: 4,
      lyrics: old.lyrics ?? {},
      libraryExclusions: [],
      settings: { ...defaults.settings, ...settings },
    }
  }
  if (old.version !== 1) return value
  const oldSettings = (old.settings ?? {}) as Record<string, unknown>
  const oldSession = (old.playerSession ?? {}) as Record<string, unknown>
  const oldFocus = (old.focus ?? {}) as Record<string, unknown>
  const tracks = Array.isArray(old.tracks)
    ? old.tracks.map((item) => {
        const track = item as Record<string, unknown>
        const filePath = String(track.filePath ?? '')
        let fileSize = 0
        let modifiedAt = Date.now()
        try {
          const stats = statSync(filePath)
          fileSize = stats.size
          modifiedAt = stats.mtimeMs
        } catch {
          // A later rescan removes missing files.
        }
        const extension = path.extname(filePath).slice(1).toLowerCase()
        const format: MusicFormat = [
          'mp3',
          'flac',
          'wav',
          'm4a',
          'aac',
          'ogg',
          'opus',
        ].includes(extension)
          ? (extension as MusicFormat)
          : 'mp3'
        return {
          ...track,
          filePath,
          fileName: path.basename(filePath) || String(track.title ?? 'Unknown'),
          format,
          fileSize,
          modifiedAt,
          addedAt: modifiedAt,
        }
      })
    : []
  old = {
    ...defaults,
    ...old,
    version: 4,
    tracks,
    libraryExclusions: [],
    settings: { ...defaults.settings, ...oldSettings },
    playerSession: { ...defaults.playerSession, ...oldSession },
    focus: { ...defaults.focus, ...oldFocus, timer: defaults.focus.timer },
    onboardingCompleted: (old.musicFolders as unknown[])?.length > 0,
  }
  return old
}

export function migratePublicData(value: unknown): unknown {
  return migrateData(value)
}

function normalizeFocus(data: StoredAppData): StoredAppData {
  const now = Date.now()
  const focus = { ...data.focus, timer: { ...data.focus.timer } }
  if (focus.today !== today()) {
    focus.today = today()
    focus.focusedSeconds = 0
  }
  if (
    focus.timer.status === 'running' &&
    focus.timer.endsAt &&
    focus.timer.startedAt
  ) {
    const elapsed = Math.max(
      0,
      Math.floor(
        (Math.min(now, focus.timer.endsAt) - focus.timer.startedAt) / 1000,
      ),
    )
    if (focus.timer.mode === 'focus') focus.focusedSeconds += elapsed
    focus.timer.remainingSeconds = Math.max(
      0,
      Math.ceil((focus.timer.endsAt - now) / 1000),
    )
    focus.timer.status = focus.timer.remainingSeconds > 0 ? 'paused' : 'idle'
    delete focus.timer.startedAt
    delete focus.timer.endsAt
  } else if (focus.timer.status === 'running') {
    focus.timer.status = 'paused'
    delete focus.timer.startedAt
    delete focus.timer.endsAt
  }
  return { ...data, focus }
}

export function getStoredData(): StoredAppData {
  if (!store) throw new Error('Data store has not been initialized')
  const normalized = normalizeFocus(store.get('data'))
  store.set('data', normalized)
  return structuredClone(normalized)
}

export function getPublicData(): AppData {
  const data = getStoredData()
  return {
    ...data,
    tracks: data.tracks.map(({ filePath, ...track }) => {
      void filePath
      return track
    }),
    libraryExclusions: data.libraryExclusions.map(
      ({ id, filePathHash, excludedAt }) => ({ id, filePathHash, excludedAt }),
    ),
  }
}

export function setStoredData(value: StoredAppData): StoredAppData {
  if (!store) throw new Error('Data store has not been initialized')
  const result = storedDataSchema.safeParse(value)
  if (!result.success) throw new Error('저장할 데이터가 올바르지 않습니다.')
  store.set('data', result.data)
  return structuredClone(result.data)
}

export async function setStoredDataWithImportBackup(
  value: StoredAppData,
  existingBackupPath?: string,
): Promise<{ data: StoredAppData; backupPath: string }> {
  if (!store) throw new Error('Data store has not been initialized')
  const result = storedDataSchema.safeParse(value)
  if (!result.success)
    throw new Error('가져올 동기화 데이터가 현재 저장 스키마와 맞지 않습니다.')

  const storePath = store.path
  const directory = path.dirname(storePath)
  const backupPath = existingBackupPath ?? (await createPreImportBackup())
  const stagingPath = path.join(
    directory,
    `.sync-import-${process.pid}-${Date.now()}.tmp`,
  )
  await writeFile(stagingPath, JSON.stringify({ data: result.data }), 'utf8')
  const staged = JSON.parse(await readFile(stagingPath, 'utf8')) as unknown
  const stagedResult = z.object({ data: storedDataSchema }).safeParse(staged)
  if (!stagedResult.success) {
    await rm(stagingPath, { force: true })
    throw new Error('동기화 데이터의 임시 저장 검증에 실패했습니다.')
  }

  try {
    // electron-store persists through an atomic temporary-file replacement.
    store.set('data', stagedResult.data.data)
    await rm(stagingPath, { force: true })
    return { data: structuredClone(stagedResult.data.data), backupPath }
  } catch (error) {
    await rm(stagingPath, { force: true }).catch(() => undefined)
    if (existsSync(backupPath)) await copyFile(backupPath, storePath)
    throw error
  }
}

export async function createPreImportBackup(): Promise<string> {
  if (!store) throw new Error('Data store has not been initialized')
  const storePath = store.path
  const directory = path.dirname(storePath)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(directory, `pre-import-backup-${timestamp}.json`)
  if (existsSync(storePath)) await copyFile(storePath, backupPath)
  else
    await writeFile(
      backupPath,
      JSON.stringify({ data: getStoredData() }),
      'utf8',
    )
  return backupPath
}

export function setPublicData(
  value: unknown,
  options: { preserveLyrics?: boolean } = {},
): AppData {
  if (!store) throw new Error('Data store has not been initialized')
  const result = appDataSchema.safeParse(value)
  if (!result.success)
    throw new Error('가져온 데이터 형식이 올바르지 않습니다.')
  const current = getStoredData()
  const publicById = new Map(
    result.data.tracks.map((track) => [track.id, track]),
  )
  const tracks = current.tracks.map((track) => {
    const editable = publicById.get(track.id)
    return editable
      ? {
          ...track,
          liked: editable.liked,
          lastPlayedAt: editable.lastPlayedAt,
          playCount: editable.playCount,
        }
      : track
  })
  const trackIds = new Set(tracks.map((track) => track.id))
  const lyricSource =
    options.preserveLyrics === false ? result.data.lyrics : current.lyrics
  const lyrics = Object.fromEntries(
    Object.entries(lyricSource).filter(
      ([trackId, value]) => trackIds.has(trackId) && value.trackId === trackId,
    ),
  )
  const lyricsSyncProfiles = Object.fromEntries(
    Object.entries(current.lyricsSyncProfiles).filter(
      ([trackId, profile]) =>
        trackIds.has(trackId) && profile.trackId === trackId,
    ),
  )
  const generatedLyricsTimelines = Object.fromEntries(
    Object.entries(current.generatedLyricsTimelines).filter(
      ([trackId, timeline]) =>
        trackIds.has(trackId) && timeline.trackId === trackId,
    ),
  )
  const stored: StoredAppData = {
    ...result.data,
    musicFolders: current.musicFolders,
    tracks,
    libraryExclusions: current.libraryExclusions,
    playlists: result.data.playlists.map((playlist) => ({
      ...playlist,
      trackIds: [
        ...new Set(
          playlist.trackIds
            .map(currentTrackId)
            .filter((id) => trackIds.has(id)),
        ),
      ],
      coverTrackId: playlist.coverTrackId
        ? currentTrackId(playlist.coverTrackId)
        : undefined,
    })),
    recentTrackIds: [
      ...new Set(
        result.data.recentTrackIds
          .map(currentTrackId)
          .filter((id) => trackIds.has(id)),
      ),
    ],
    lyrics,
    lyricsSyncProfiles,
    generatedLyricsTimelines,
    playerSession: {
      ...result.data.playerSession,
      queueIds: result.data.playerSession.queueIds
        .map(currentTrackId)
        .filter((id) => trackIds.has(id)),
    },
  }
  setStoredData(stored)
  return getPublicData()
}

export function resetData(): AppData {
  const data = createDefaultData()
  store?.set('data', data)
  return getPublicData()
}
