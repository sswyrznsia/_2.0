import { z } from 'zod'
import type {
  PulseShelfSyncPackage,
  SyncConflictKind,
  SyncConflictPreview,
  SyncImportTrackChoice,
  SyncPackageExportOptions,
  SyncPackageImportPlan,
  SyncPackageInspection,
  SyncTrackIdentity,
  SyncTrackPreview,
  SyncTrackRecord,
  SyncTrackRecordV2,
  TrackLyrics,
} from '../src/types/models'
import { appDataSchema, type StoredAppData, type StoredTrack } from './data'

export const SYNC_PACKAGE_MAX_BYTES = 20 * 1024 * 1024
export const SYNC_PACKAGE_V2_MAX_BYTES = 20 * 1024 * 1024 * 1024
export const SYNC_PACKAGE_MEDIA_MAX_BYTES = 4 * 1024 * 1024 * 1024
const hash64 = z.string().regex(/^[a-f0-9]{64}$/)

const identitySchema = z
  .object({
    youtubeVideoId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{11}$/)
      .optional(),
    sourceType: z.string().trim().min(1).max(80).optional(),
    sourceId: z.string().trim().min(1).max(300).optional(),
    fileSha256: hash64.optional(),
    durationMs: z
      .number()
      .int()
      .nonnegative()
      .max(24 * 60 * 60 * 1_000)
      .optional(),
    normalizedTitle: z.string().trim().min(1).max(500).optional(),
    normalizedArtist: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine(
    (identity) =>
      Boolean(
        identity.youtubeVideoId ||
        (identity.sourceType && identity.sourceId) ||
        identity.fileSha256 ||
        (identity.normalizedTitle &&
          identity.normalizedArtist &&
          identity.durationMs !== undefined),
      ),
    '기기 간 식별에 필요한 정보가 없습니다.',
  )

const portableLyricsSchema = appDataSchema.shape.lyrics.valueType
  .omit({ trackId: true })
  .strict()
const portableProfileSchema = appDataSchema.shape.lyricsSyncProfiles.valueType
  .omit({ trackId: true })
  .strict()
const portableTimelineSchema =
  appDataSchema.shape.generatedLyricsTimelines.valueType
    .omit({ trackId: true })
    .strict()

const exportOptionsSchema = z
  .object({
    lyrics: z.boolean(),
    playlists: z.boolean(),
    likes: z.boolean(),
    metadataOverrides: z.boolean(),
  })
  .strict()

const exportOptionsV2Schema = exportOptionsSchema
  .extend({ mediaFiles: z.boolean() })
  .strict()

const trackRecordSchema = z
  .object({
    recordId: z.string().uuid(),
    identity: identitySchema,
    metadata: z
      .object({
        title: z.string().max(500).optional(),
        artist: z.string().max(500).optional(),
        album: z.string().max(500).optional(),
      })
      .strict()
      .optional(),
    liked: z.boolean().optional(),
    lyrics: portableLyricsSchema.optional(),
    lyricsSyncProfile: portableProfileSchema.optional(),
    generatedLyricsTimeline: portableTimelineSchema.optional(),
  })
  .strict()

const mediaDescriptorSchema = z
  .object({
    archivePath: z.string().min(1).max(1_000),
    originalFileName: z.string().min(1).max(500),
    extension: z.enum(['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus']),
    size: z.number().int().positive().max(SYNC_PACKAGE_MEDIA_MAX_BYTES),
    sha256: hash64,
    mimeType: z.string().trim().min(1).max(100).optional(),
  })
  .strict()

const artworkDescriptorSchema = z
  .object({
    archivePath: z.string().min(1).max(1_000),
    extension: z.enum(['jpg', 'png']),
    size: z
      .number()
      .int()
      .positive()
      .max(15 * 1024 * 1024),
    sha256: hash64,
  })
  .strict()

const trackRecordV2Schema = trackRecordSchema
  .extend({
    media: mediaDescriptorSchema.optional(),
    artwork: artworkDescriptorSchema.optional(),
    mediaWarning: z
      .enum(['missing', 'unreadable', 'unsupported', 'too-large'])
      .optional(),
  })
  .strict()

const playlistRecordSchema = z
  .object({
    syncId: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    tracks: z.array(identitySchema).max(100_000),
    createdAt: z.number().finite().nonnegative(),
    updatedAt: z.number().finite().nonnegative(),
    coverTrack: identitySchema.optional(),
  })
  .strict()

function validatePackageDuplicates(
  value: {
    tracks: Array<{ recordId: string; identity: SyncTrackIdentity }>
    playlists: Array<{ syncId: string }>
  },
  context: z.RefinementCtx,
) {
  const recordIds = new Set<string>()
  const stableIdentities = new Set<string>()
  for (const [index, record] of value.tracks.entries()) {
    if (recordIds.has(record.recordId))
      context.addIssue({
        code: 'custom',
        path: ['tracks', index, 'recordId'],
        message: '중복된 트랙 recordId입니다.',
      })
    recordIds.add(record.recordId)
    const key = primaryIdentityKey(record.identity)
    if (key && stableIdentities.has(key))
      context.addIssue({
        code: 'custom',
        path: ['tracks', index, 'identity'],
        message: '중복된 안정 트랙 식별자입니다.',
      })
    if (key) stableIdentities.add(key)
  }
  const playlistIds = new Set<string>()
  for (const [index, playlist] of value.playlists.entries()) {
    if (playlistIds.has(playlist.syncId))
      context.addIssue({
        code: 'custom',
        path: ['playlists', index, 'syncId'],
        message: '중복된 플레이리스트 syncId입니다.',
      })
    playlistIds.add(playlist.syncId)
  }
}

export const syncPackageV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    appVersion: z.string().trim().min(1).max(100),
    exportedAt: z.number().finite().nonnegative(),
    deviceId: z.string().uuid(),
    tracks: z.array(trackRecordSchema).max(200_000),
    playlists: z.array(playlistRecordSchema).max(5_000),
    exportOptions: exportOptionsSchema,
  })
  .strict()
  .superRefine(validatePackageDuplicates)

export const syncPackageV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    appVersion: z.string().trim().min(1).max(100),
    exportedAt: z.number().finite().nonnegative(),
    deviceId: z.string().uuid(),
    tracks: z.array(trackRecordV2Schema).max(200_000),
    playlists: z.array(playlistRecordSchema).max(5_000),
    exportOptions: exportOptionsV2Schema,
  })
  .strict()
  .superRefine((value, context) => {
    validatePackageDuplicates(value, context)
    const archivePaths = new Set<string>()
    let totalMediaBytes = 0
    for (const [index, record] of value.tracks.entries()) {
      for (const [kind, descriptor] of [
        ['media', record.media],
        ['artwork', record.artwork],
      ] as const) {
        if (!descriptor) continue
        if (!isSafeArchivePath(descriptor.archivePath))
          context.addIssue({
            code: 'custom',
            path: ['tracks', index, kind, 'archivePath'],
            message: '안전하지 않은 archive 경로입니다.',
          })
        if (archivePaths.has(descriptor.archivePath))
          context.addIssue({
            code: 'custom',
            path: ['tracks', index, kind, 'archivePath'],
            message: '중복된 archive 경로입니다.',
          })
        archivePaths.add(descriptor.archivePath)
        if (kind === 'media') {
          totalMediaBytes += descriptor.size
          if (
            !descriptor.archivePath.startsWith(`media/${record.recordId}/`) ||
            !descriptor.archivePath.endsWith(`.${descriptor.extension}`) ||
            descriptor.originalFileName !==
              descriptor.originalFileName.replace(/\\/g, '/').split('/').pop()
          )
            context.addIssue({
              code: 'custom',
              path: ['tracks', index, 'media'],
              message: 'media descriptor 경로 또는 파일명이 올바르지 않습니다.',
            })
        } else if (
          !descriptor.archivePath.startsWith('artwork/') ||
          !descriptor.archivePath.endsWith(`.${descriptor.extension}`)
        )
          context.addIssue({
            code: 'custom',
            path: ['tracks', index, 'artwork'],
            message: 'artwork descriptor 경로가 올바르지 않습니다.',
          })
      }
    }
    if (totalMediaBytes > SYNC_PACKAGE_V2_MAX_BYTES)
      context.addIssue({
        code: 'custom',
        path: ['tracks'],
        message: '패키지 미디어 총 용량이 20GB를 초과합니다.',
      })
  })

export const syncPackageSchema = syncPackageV1Schema

export function isSafeArchivePath(value: string): boolean {
  if (!value || value.includes('\\') || value.includes('\0')) return false
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  const parts = value.split('/')
  return parts.every((part) => part && part !== '.' && part !== '..')
}

export function normalizeSyncText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

export function buildTrackIdentity(
  track: Pick<
    StoredTrack,
    'title' | 'artist' | 'duration' | 'source' | 'sourceVideoId'
  >,
  fileSha256?: string,
  lyrics?: TrackLyrics,
): SyncTrackIdentity {
  const provider =
    lyrics?.provider ??
    (lyrics?.source === 'lrclib' || lyrics?.source === 'lyrica'
      ? lyrics.source
      : undefined)
  return {
    youtubeVideoId: track.sourceVideoId,
    sourceType:
      provider && lyrics?.providerTrackId !== undefined
        ? `lyrics:${provider}`
        : undefined,
    sourceId:
      provider && lyrics?.providerTrackId !== undefined
        ? String(lyrics.providerTrackId)
        : undefined,
    fileSha256,
    durationMs: Math.round(track.duration * 1_000),
    normalizedTitle: normalizeSyncText(track.title) || undefined,
    normalizedArtist: normalizeSyncText(track.artist) || undefined,
  }
}

export function stableIdentityKeys(identity: SyncTrackIdentity): string[] {
  const keys: string[] = []
  if (identity.youtubeVideoId) keys.push(`youtube:${identity.youtubeVideoId}`)
  if (identity.sourceType && identity.sourceId)
    keys.push(`source:${identity.sourceType}:${identity.sourceId}`)
  if (identity.fileSha256) keys.push(`sha256:${identity.fileSha256}`)
  return keys
}

export function primaryIdentityKey(
  identity: SyncTrackIdentity,
): string | undefined {
  return stableIdentityKeys(identity)[0]
}

export function fallbackIdentityKey(
  identity: SyncTrackIdentity,
): string | undefined {
  return identity.normalizedTitle &&
    identity.normalizedArtist &&
    identity.durationMs !== undefined
    ? `fallback:${identity.normalizedTitle}:${identity.normalizedArtist}:${identity.durationMs}`
    : undefined
}

export function portableRecord(
  track: StoredTrack,
  identity: SyncTrackIdentity,
  data: StoredAppData,
  options: SyncPackageExportOptions,
  recordId: string,
): SyncTrackRecord {
  const lyrics = data.lyrics[track.id]
  const profile = data.lyricsSyncProfiles[track.id]
  const timeline = data.generatedLyricsTimelines[track.id]
  return {
    recordId,
    identity,
    metadata: options.metadataOverrides
      ? { title: track.title, artist: track.artist, album: track.album }
      : undefined,
    liked: options.likes ? track.liked : undefined,
    lyrics: options.lyrics && lyrics ? withoutTrackId(lyrics) : undefined,
    lyricsSyncProfile:
      options.lyrics && profile ? withoutTrackId(profile) : undefined,
    generatedLyricsTimeline:
      options.lyrics && timeline ? withoutTrackId(timeline) : undefined,
  }
}

function withoutTrackId<T extends { trackId: string }>(
  value: T,
): Omit<T, 'trackId'> {
  const { trackId, ...portable } = value
  void trackId
  return portable
}

export function inspectSyncPackage(
  packageValue: PulseShelfSyncPackage,
  localData: StoredAppData,
  localIdentities: Map<string, SyncTrackIdentity>,
  token: string,
  fileName: string,
): SyncPackageInspection {
  const stableMap = new Map<string, StoredTrack[]>()
  for (const track of localData.tracks) {
    const identity = localIdentities.get(track.id)
    if (!identity) continue
    for (const key of stableIdentityKeys(identity)) {
      const items = stableMap.get(key) ?? []
      items.push(track)
      stableMap.set(key, items)
    }
  }
  const tracks = packageValue.tracks.map((record) => {
    const exact = uniqueTracks(
      stableIdentityKeys(record.identity).flatMap(
        (key) => stableMap.get(key) ?? [],
      ),
    )
    if (exact.length === 1)
      return previewFor(record, 'exact', exact[0], [], localData)

    const possible = localData.tracks.filter((track) =>
      isFallbackCandidate(record.identity, track),
    )
    return previewFor(
      record,
      possible.length || exact.length > 1 ? 'possible' : 'missing',
      undefined,
      uniqueTracks([...exact, ...possible]),
      localData,
    )
  })
  return {
    token,
    fileName,
    exportedAt: packageValue.exportedAt,
    appVersion: packageValue.appVersion,
    tracks,
    playlistCount: packageValue.playlists.length,
    exactMatches: tracks.filter((track) => track.matchKind === 'exact').length,
    possibleMatches: tracks.filter((track) => track.matchKind === 'possible')
      .length,
    missingTracks: tracks.filter((track) => track.matchKind === 'missing')
      .length,
    conflictCount: tracks.reduce(
      (sum, track) => sum + track.conflicts.length,
      0,
    ),
    invalidEntries: 0,
    schemaVersion: packageValue.schemaVersion,
    mediaFiles:
      packageValue.schemaVersion === 2
        ? packageValue.tracks.filter((track) => Boolean(track.media)).length
        : 0,
    totalMediaBytes:
      packageValue.schemaVersion === 2
        ? packageValue.tracks.reduce(
            (sum, track) => sum + (track.media?.size ?? 0),
            0,
          )
        : 0,
    creatableTracks: tracks.filter(
      (track) => track.matchKind === 'missing' && track.mediaAvailable,
    ).length,
  }
}

function uniqueTracks(tracks: StoredTrack[]): StoredTrack[] {
  return [...new Map(tracks.map((track) => [track.id, track])).values()]
}

function isFallbackCandidate(
  identity: SyncTrackIdentity,
  track: StoredTrack,
): boolean {
  if (
    !identity.normalizedTitle ||
    !identity.normalizedArtist ||
    identity.durationMs === undefined
  )
    return false
  return (
    identity.normalizedTitle === normalizeSyncText(track.title) &&
    identity.normalizedArtist === normalizeSyncText(track.artist) &&
    Math.abs(identity.durationMs - Math.round(track.duration * 1_000)) <= 3_000
  )
}

function previewFor(
  record: SyncTrackRecord | SyncTrackRecordV2,
  matchKind: SyncTrackPreview['matchKind'],
  localTrack: StoredTrack | undefined,
  candidates: StoredTrack[],
  data: StoredAppData,
): SyncTrackPreview {
  const importedData = [
    record.lyrics && '가사',
    record.lyricsSyncProfile && '가사 보정',
    record.generatedLyricsTimeline && 'AI/수동 타임라인',
    record.liked !== undefined && '좋아요',
    record.metadata && '메타데이터',
    'media' in record && record.media && '음악 파일',
  ].filter((value): value is string => Boolean(value))
  return {
    recordId: record.recordId,
    title:
      record.metadata?.title ?? record.identity.normalizedTitle ?? '제목 없음',
    artist:
      record.metadata?.artist ??
      record.identity.normalizedArtist ??
      '아티스트 없음',
    matchKind,
    localTrackId: localTrack?.id,
    candidates: candidates.map((track) => ({
      trackId: track.id,
      title: track.title,
      artist: track.artist,
      durationMs: Math.round(track.duration * 1_000),
      conflicts: conflictsFor(record, track, data),
    })),
    conflicts: localTrack ? conflictsFor(record, localTrack, data) : [],
    importedData,
    mediaAvailable: 'media' in record && Boolean(record.media),
    mediaSize: 'media' in record ? (record.media?.size ?? 0) : 0,
    mediaWarning: 'mediaWarning' in record ? record.mediaWarning : undefined,
  }
}

function conflictsFor(
  record: SyncTrackRecord | SyncTrackRecordV2,
  track: StoredTrack,
  data: StoredAppData,
): SyncConflictPreview[] {
  const result: SyncConflictPreview[] = []
  const localLyrics = data.lyrics[track.id]
  if (
    record.lyrics &&
    localLyrics &&
    !sameValue(record.lyrics, withoutTrackId(localLyrics))
  )
    result.push({
      kind: 'lyrics',
      localSummary: lyricsSummary(localLyrics),
      importedSummary: lyricsSummary(record.lyrics),
      recommended:
        lyricsPriority(record.lyrics) > lyricsPriority(localLyrics) ||
        (lyricsPriority(record.lyrics) === lyricsPriority(localLyrics) &&
          record.lyrics.fetchedAt > localLyrics.fetchedAt)
          ? 'imported'
          : 'local',
    })
  const localProfile = data.lyricsSyncProfiles[track.id]
  if (
    record.lyricsSyncProfile &&
    localProfile &&
    !sameValue(record.lyricsSyncProfile, withoutTrackId(localProfile))
  )
    result.push({
      kind: 'lyricsSyncProfile',
      localSummary: `${localProfile.source ?? 'manual'} · ${localProfile.anchors.length}개 anchor`,
      importedSummary: `${record.lyricsSyncProfile.source ?? 'manual'} · ${record.lyricsSyncProfile.anchors.length}개 anchor`,
      recommended: preferImportedTimedData(
        localProfile,
        record.lyricsSyncProfile,
      ),
    })
  const localTimeline = data.generatedLyricsTimelines[track.id]
  if (
    record.generatedLyricsTimeline &&
    localTimeline &&
    !sameValue(record.generatedLyricsTimeline, withoutTrackId(localTimeline))
  )
    result.push({
      kind: 'generatedLyricsTimeline',
      localSummary: `${localTimeline.source} · ${localTimeline.lines.length}줄`,
      importedSummary: `${record.generatedLyricsTimeline.source} · ${record.generatedLyricsTimeline.lines.length}줄`,
      recommended: preferImportedTimedData(
        localTimeline,
        record.generatedLyricsTimeline,
      ),
    })
  if (
    record.metadata &&
    ['title', 'artist', 'album'].some(
      (key) =>
        record.metadata?.[key as keyof typeof record.metadata] !==
        track[key as 'title'],
    )
  )
    result.push({
      kind: 'metadata',
      localSummary: `${track.title} · ${track.artist}`,
      importedSummary: `${record.metadata.title ?? track.title} · ${record.metadata.artist ?? track.artist}`,
      recommended: 'local',
    })
  return result
}

function lyricsSummary(
  value: Omit<TrackLyrics, 'trackId'> | TrackLyrics,
): string {
  return `${value.source} · ${value.syncedLyrics ? '동기화' : value.plainLyrics ? '일반' : '연주곡'}`
}

function lyricsPriority(
  value: Omit<TrackLyrics, 'trackId'> | TrackLyrics,
): number {
  if (value.source === 'manual' || value.source === 'manual-input') return 6
  if (value.source === 'imported-lrc' || value.source === 'imported-text')
    return 5
  if (value.source === 'local-lrc' || value.source === 'local-txt') return 4
  if (value.userSelected) return 3
  return 1
}

function preferImportedTimedData(
  local: { source?: 'manual' | 'ai'; updatedAt?: number; createdAt?: number },
  imported: {
    source?: 'manual' | 'ai'
    updatedAt?: number
    createdAt?: number
  },
): 'local' | 'imported' {
  if (local.source === 'manual' && imported.source !== 'manual') return 'local'
  if (imported.source === 'manual' && local.source !== 'manual')
    return 'imported'
  return (imported.updatedAt ?? imported.createdAt ?? 0) >
    (local.updatedAt ?? local.createdAt ?? 0)
    ? 'imported'
    : 'local'
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function applySyncPackage(
  current: StoredAppData,
  packageValue: PulseShelfSyncPackage,
  inspection: SyncPackageInspection,
  plan: SyncPackageImportPlan,
): {
  data: StoredAppData
  summary: NonNullable<
    import('../src/types/models').SyncPackageOperationResult['summary']
  >
} {
  const data = structuredClone(current)
  const records = new Map(
    packageValue.tracks.map((record) => [record.recordId, record]),
  )
  const choices = new Map(
    plan.tracks.map((choice) => [choice.recordId, choice]),
  )
  const resolved = new Map<string, string>()
  let lyrics = 0
  let likes = 0
  let conflicts = 0

  for (const preview of inspection.tracks) {
    const record = records.get(preview.recordId)
    if (!record) continue
    const choice = choices.get(preview.recordId)
    const localTrackId =
      preview.matchKind === 'exact'
        ? preview.localTrackId
        : choice?.localTrackId
    if (!localTrackId) continue
    if (
      preview.matchKind === 'possible' &&
      !preview.candidates.some(
        (candidate) => candidate.trackId === localTrackId,
      )
    )
      continue
    const index = data.tracks.findIndex((track) => track.id === localTrackId)
    if (index < 0) continue
    const track = data.tracks[index]
    resolved.set(identityToken(record.identity), localTrackId)

    if (record.liked !== undefined) {
      const liked =
        plan.likesMode === 'union' ? track.liked || record.liked : record.liked
      if (liked !== track.liked) likes += 1
      data.tracks[index] = { ...track, liked }
    }
    const effectiveConflicts =
      preview.matchKind === 'possible'
        ? (preview.candidates.find(
            (candidate) => candidate.trackId === localTrackId,
          )?.conflicts ?? [])
        : preview.conflicts
    const conflictMap = new Map(
      effectiveConflicts.map((item) => [item.kind, item]),
    )
    const shouldImport = (kind: SyncConflictKind) => {
      const conflict = conflictMap.get(kind)
      if (!conflict) return true
      conflicts += 1
      return (
        choice?.conflicts?.[kind] === 'imported' ||
        (choice?.conflicts?.[kind] === undefined &&
          conflict.recommended === 'imported')
      )
    }
    if (record.lyrics && shouldImport('lyrics')) {
      data.lyrics[localTrackId] = { ...record.lyrics, trackId: localTrackId }
      lyrics += 1
    }
    if (record.lyricsSyncProfile && shouldImport('lyricsSyncProfile')) {
      data.lyricsSyncProfiles[localTrackId] = {
        ...record.lyricsSyncProfile,
        trackId: localTrackId,
      }
    }
    if (
      record.generatedLyricsTimeline &&
      shouldImport('generatedLyricsTimeline')
    ) {
      data.generatedLyricsTimelines[localTrackId] = {
        ...record.generatedLyricsTimeline,
        trackId: localTrackId,
      }
    }
    if (record.metadata && shouldImport('metadata')) {
      data.tracks[index] = { ...data.tracks[index], ...record.metadata }
    }
  }

  let playlists = 0
  for (const imported of packageValue.playlists) {
    const existingIndex = data.playlists.findIndex(
      (item) => item.syncId === imported.syncId,
    )
    const trackIds = [
      ...new Set(
        imported.tracks.flatMap((identity) => {
          const trackId = resolved.get(identityToken(identity))
          return trackId ? [trackId] : []
        }),
      ),
    ]
    const coverTrackId = imported.coverTrack
      ? resolved.get(identityToken(imported.coverTrack))
      : undefined
    const existing =
      existingIndex >= 0 ? data.playlists[existingIndex] : undefined
    const useImported =
      !existing ||
      plan.playlistMode === 'imported' ||
      (plan.playlistMode === 'newer' && imported.updatedAt > existing.updatedAt)
    if (!useImported) continue
    const playlist = {
      id: existing?.id ?? imported.syncId,
      syncId: imported.syncId,
      name: imported.name,
      trackIds,
      createdAt: existing?.createdAt ?? imported.createdAt,
      updatedAt: imported.updatedAt,
      coverTrackId,
    }
    if (existingIndex >= 0) data.playlists[existingIndex] = playlist
    else data.playlists.push(playlist)
    playlists += 1
  }

  const matchedTracks = inspection.tracks.filter((preview) => {
    const choice = choices.get(preview.recordId)
    return preview.matchKind === 'exact'
      ? Boolean(preview.localTrackId)
      : Boolean(choice?.localTrackId)
  }).length
  return {
    data,
    summary: {
      matchedTracks,
      skippedTracks: inspection.tracks.length - matchedTracks,
      lyrics,
      likes,
      playlists,
      conflicts,
    },
  }
}

function identityToken(identity: SyncTrackIdentity): string {
  return (
    primaryIdentityKey(identity) ??
    fallbackIdentityKey(identity) ??
    JSON.stringify(identity)
  )
}

export function choiceForPreview(
  preview: SyncTrackPreview,
): SyncImportTrackChoice {
  return {
    recordId: preview.recordId,
    localTrackId: preview.localTrackId,
    conflicts: Object.fromEntries(
      preview.conflicts.map((conflict) => [
        conflict.kind,
        conflict.recommended,
      ]),
    ),
  }
}

export type ValidatedSyncPackage = z.infer<typeof syncPackageSchema>
