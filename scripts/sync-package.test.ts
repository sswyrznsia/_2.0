import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type {
  PulseShelfSyncPackageV1,
  SyncPackageImportPlan,
  SyncTrackIdentity,
} from '../src/types/models'
import {
  createDefaultData,
  type StoredAppData,
  type StoredTrack,
} from '../electron/data'
import {
  applySyncPackage,
  buildTrackIdentity,
  inspectSyncPackage,
  SYNC_PACKAGE_MAX_BYTES,
  syncPackageSchema,
} from '../electron/syncPackageCore'

const trackId = 'a'.repeat(64)
const secondTrackId = 'b'.repeat(64)

function track(id: string, overrides: Partial<StoredTrack> = {}): StoredTrack {
  return {
    id,
    filePath: `C:\\device-a\\${id}.mp3`,
    fileName: `${id}.mp3`,
    title: '꽃, 바람, 그대',
    artist: 'Mitsukiyo',
    album: 'Cover',
    duration: 219.5,
    format: 'mp3',
    fileSize: 100,
    modifiedAt: 1,
    addedAt: 1,
    liked: false,
    playCount: 0,
    ...overrides,
  }
}

function dataWith(...tracks: StoredTrack[]): StoredAppData {
  return { ...createDefaultData(), tracks }
}

function packageWith(
  identity: SyncTrackIdentity,
  overrides: Partial<PulseShelfSyncPackageV1['tracks'][number]> = {},
): PulseShelfSyncPackageV1 {
  return {
    schemaVersion: 1,
    appVersion: '2.0.0',
    exportedAt: 100,
    deviceId: randomUUID(),
    tracks: [{ recordId: randomUUID(), identity, ...overrides }],
    playlists: [],
    exportOptions: {
      lyrics: true,
      playlists: true,
      likes: true,
      metadataOverrides: true,
    },
  }
}

const youtubeTrack = track(trackId, {
  source: 'youtube',
  sourceVideoId: 'abcdefghijk',
})
const youtubePackage = packageWith(buildTrackIdentity(youtubeTrack))
const youtubeInspection = inspectSyncPackage(
  youtubePackage,
  dataWith(youtubeTrack),
  new Map([[trackId, buildTrackIdentity(youtubeTrack)]]),
  randomUUID(),
  'youtube.pssync',
)
assert.equal(
  youtubeInspection.exactMatches,
  1,
  'YouTube ID should match exactly',
)

const hash = '1'.repeat(64)
const movedTrack = track(trackId, { filePath: 'D:\\music\\moved.mp3' })
const hashPackage = packageWith(buildTrackIdentity(track(trackId), hash))
const hashInspection = inspectSyncPackage(
  hashPackage,
  dataWith(movedTrack),
  new Map([[trackId, buildTrackIdentity(movedTrack, hash)]]),
  randomUUID(),
  'hash.pssync',
)
assert.equal(
  hashInspection.exactMatches,
  1,
  'SHA identity must ignore local paths',
)

const fallbackPackage = packageWith(buildTrackIdentity(track(trackId)))
const fallbackInspection = inspectSyncPackage(
  fallbackPackage,
  dataWith(track(trackId)),
  new Map([[trackId, buildTrackIdentity(track(trackId))]]),
  randomUUID(),
  'fallback.pssync',
)
assert.equal(fallbackInspection.exactMatches, 0)
assert.equal(
  fallbackInspection.possibleMatches,
  1,
  'metadata fallback requires confirmation',
)
assert.equal(fallbackInspection.tracks[0].localTrackId, undefined)

const titleOnly = packageWith({ normalizedTitle: 'title' })
assert.equal(
  syncPackageSchema.safeParse(titleOnly).success,
  false,
  'title-only identity is invalid',
)
assert.throws(
  () => JSON.parse('{"schemaVersion":1'),
  'truncated JSON must fail',
)
assert.equal(SYNC_PACKAGE_MAX_BYTES, 20 * 1024 * 1024)

const secretPackage = structuredClone(youtubePackage) as unknown as Record<
  string,
  unknown
>
;(secretPackage.tracks as Record<string, unknown>[])[0].filePath =
  'C:\\secret.mp3'
assert.equal(
  syncPackageSchema.safeParse(secretPackage).success,
  false,
  'paths must be rejected',
)
const unsupported = { ...youtubePackage, schemaVersion: 2 }
assert.equal(syncPackageSchema.safeParse(unsupported).success, false)
const duplicate = structuredClone(youtubePackage)
duplicate.tracks.push({ ...duplicate.tracks[0], recordId: randomUUID() })
assert.equal(
  syncPackageSchema.safeParse(duplicate).success,
  false,
  'duplicate stable IDs must fail',
)

const local = dataWith(youtubeTrack, track(secondTrackId, { title: 'Other' }))
local.lyrics[trackId] = {
  trackId,
  source: 'manual-input',
  plainLyrics: 'local manual',
  fetchedAt: 200,
}
local.generatedLyricsTimelines[trackId] = {
  trackId,
  source: 'manual',
  lines: [
    {
      lineIndex: 0,
      textHash: '1'.repeat(16),
      audioTimeMs: 1_000,
      source: 'manual',
    },
  ],
  lineCount: 1,
  lyricsTextHash: '2'.repeat(16),
  createdAt: 200,
}
const incoming = packageWith(buildTrackIdentity(youtubeTrack), {
  liked: true,
  lyrics: { source: 'lrclib', plainLyrics: 'automatic', fetchedAt: 300 },
  generatedLyricsTimeline: {
    source: 'ai',
    lines: [
      {
        lineIndex: 0,
        textHash: '1'.repeat(16),
        audioTimeMs: 2_000,
        source: 'direct',
      },
    ],
    lineCount: 1,
    lyricsTextHash: '2'.repeat(16),
    createdAt: 300,
  },
})
incoming.playlists = [
  {
    syncId: randomUUID(),
    name: 'Portable',
    tracks: [incoming.tracks[0].identity],
    createdAt: 1,
    updatedAt: 2,
  },
]
const mergeInspection = inspectSyncPackage(
  incoming,
  local,
  new Map([
    [trackId, buildTrackIdentity(youtubeTrack)],
    [secondTrackId, buildTrackIdentity(local.tracks[1])],
  ]),
  randomUUID(),
  'merge.pssync',
)
assert.equal(mergeInspection.conflictCount, 2)
assert.ok(
  mergeInspection.tracks[0].conflicts.every(
    (conflict) => conflict.recommended === 'local',
  ),
)
const plan: SyncPackageImportPlan = {
  token: mergeInspection.token,
  tracks: [{ recordId: incoming.tracks[0].recordId, localTrackId: trackId }],
  likesMode: 'union',
  playlistMode: 'newer',
}
const merged = applySyncPackage(local, incoming, mergeInspection, plan)
assert.equal(merged.data.tracks[0].liked, true, 'likes should union by default')
assert.equal(
  merged.data.lyrics[trackId].plainLyrics,
  'local manual',
  'AI/provider must not replace manual lyrics',
)
assert.equal(merged.data.generatedLyricsTimelines[trackId].source, 'manual')
assert.deepEqual(merged.data.playlists[0].trackIds, [trackId])
assert.equal(merged.data.playlists[0].syncId, incoming.playlists[0].syncId)

const repeatedInspection = inspectSyncPackage(
  incoming,
  merged.data,
  new Map([
    [trackId, buildTrackIdentity(merged.data.tracks[0])],
    [secondTrackId, buildTrackIdentity(merged.data.tracks[1])],
  ]),
  randomUUID(),
  'merge.pssync',
)
const repeated = applySyncPackage(merged.data, incoming, repeatedInspection, {
  ...plan,
  token: repeatedInspection.token,
})
assert.equal(
  repeated.data.playlists.length,
  1,
  'repeated import must be idempotent',
)
assert.deepEqual(repeated.data.playlists[0].trackIds, [trackId])

process.stdout.write('PULSE_SHELF_SYNC_PACKAGE_TEST_OK\n')
