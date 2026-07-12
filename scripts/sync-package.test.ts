import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  PulseShelfSyncPackageV1,
  PulseShelfSyncPackageV2,
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
  isSafeArchivePath,
  syncPackageSchema,
  syncPackageV2Schema,
} from '../electron/syncPackageCore'
import {
  extractVerifiedEntries,
  isSymlinkAttributes,
  openSyncArchive,
  writeSyncArchive,
} from '../electron/syncArchive'

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

assert.equal(isSafeArchivePath('media/id/original.m4a'), true)
assert.equal(isSafeArchivePath('../escape.mp3'), false)
assert.equal(isSafeArchivePath('/absolute.mp3'), false)
assert.equal(isSafeArchivePath('C:/drive.mp3'), false)
assert.equal(isSafeArchivePath('media\\escape.mp3'), false)
assert.equal(isSymlinkAttributes((0o120000 << 16) >>> 0), true)

const archiveRoot = await mkdtemp(path.join(os.tmpdir(), 'pulse-sync-archive-'))
try {
  const mediaContent = Buffer.from('RIFF0000WAVEpulse-shelf-streaming-test')
  const mediaHash = createHash('sha256').update(mediaContent).digest('hex')
  const mediaPath = path.join(archiveRoot, 'fixture.wav')
  await writeFile(mediaPath, mediaContent)
  const recordId = randomUUID()
  const v2: PulseShelfSyncPackageV2 = {
    schemaVersion: 2,
    appVersion: '2.0.0',
    exportedAt: 1,
    deviceId: randomUUID(),
    tracks: [
      {
        recordId,
        identity: {
          fileSha256: mediaHash,
          durationMs: 1_000,
          normalizedTitle: 'fixture',
          normalizedArtist: 'pulse',
        },
        metadata: { title: 'Fixture', artist: 'Pulse' },
        media: {
          archivePath: `media/${recordId}/original.wav`,
          originalFileName: 'fixture.wav',
          extension: 'wav',
          size: mediaContent.byteLength,
          sha256: mediaHash,
          mimeType: 'audio/wav',
        },
      },
    ],
    playlists: [],
    exportOptions: {
      lyrics: true,
      playlists: true,
      likes: true,
      metadataOverrides: true,
      mediaFiles: true,
    },
  }
  assert.equal(syncPackageV2Schema.safeParse(v2).success, true)
  const archivePath = path.join(archiveRoot, 'valid.pssync')
  await writeSyncArchive(archivePath, v2, [
    { archivePath: v2.tracks[0].media!.archivePath, filePath: mediaPath },
  ])
  const opened = await openSyncArchive(archivePath)
  assert.equal(opened.manifest.schemaVersion, 2)
  const extracted = await extractVerifiedEntries(
    opened,
    [v2.tracks[0].media!],
    path.join(archiveRoot, 'extracted'),
  )
  assert.equal(
    createHash('sha256')
      .update(
        await readTestFile(extracted.get(v2.tracks[0].media!.archivePath)!),
      )
      .digest('hex'),
    mediaHash,
  )

  const unexpectedArchive = path.join(archiveRoot, 'unexpected.pssync')
  await writeSyncArchive(unexpectedArchive, v2, [
    { archivePath: v2.tracks[0].media!.archivePath, filePath: mediaPath },
    { archivePath: 'media/unexpected.exe', filePath: mediaPath },
  ])
  await assert.rejects(() => openSyncArchive(unexpectedArchive))
  await assert.rejects(() =>
    writeSyncArchive(path.join(archiveRoot, 'zip-slip.pssync'), v2, [
      { archivePath: '../escape.wav', filePath: mediaPath },
    ]),
  )

  const badHash = structuredClone(v2)
  badHash.tracks[0].media!.sha256 = 'f'.repeat(64)
  const badHashArchive = path.join(archiveRoot, 'bad-hash.pssync')
  await writeSyncArchive(badHashArchive, badHash, [
    { archivePath: badHash.tracks[0].media!.archivePath, filePath: mediaPath },
  ])
  const openedBadHash = await openSyncArchive(badHashArchive)
  await assert.rejects(() =>
    extractVerifiedEntries(
      openedBadHash,
      [badHash.tracks[0].media!],
      path.join(archiveRoot, 'bad-hash-extract'),
    ),
  )

  const badSize = structuredClone(v2)
  badSize.tracks[0].media!.size += 1
  const badSizeArchive = path.join(archiveRoot, 'bad-size.pssync')
  await writeSyncArchive(badSizeArchive, badSize, [
    { archivePath: badSize.tracks[0].media!.archivePath, filePath: mediaPath },
  ])
  await assert.rejects(() => openSyncArchive(badSizeArchive))

  const wrongFormat = structuredClone(v2)
  wrongFormat.tracks[0].media!.extension = 'm4a'
  wrongFormat.tracks[0].media!.archivePath = `media/${recordId}/original.m4a`
  const wrongFormatArchive = path.join(archiveRoot, 'wrong-format.pssync')
  await writeSyncArchive(wrongFormatArchive, wrongFormat, [
    {
      archivePath: wrongFormat.tracks[0].media!.archivePath,
      filePath: mediaPath,
    },
  ])
  const openedWrongFormat = await openSyncArchive(wrongFormatArchive)
  await assert.rejects(() =>
    extractVerifiedEntries(
      openedWrongFormat,
      [wrongFormat.tracks[0].media!],
      path.join(archiveRoot, 'wrong-format-extract'),
    ),
  )

  const executable = structuredClone(v2) as unknown as Record<string, unknown>
  ;(
    executable.tracks as Array<{ media: { extension: string } }>
  )[0].media.extension = 'exe'
  assert.equal(syncPackageV2Schema.safeParse(executable).success, false)

  const oversized = structuredClone(v2)
  oversized.tracks = Array.from({ length: 6 }, (_, index) => {
    const item = structuredClone(v2.tracks[0])
    item.recordId = randomUUID()
    item.identity.fileSha256 = String(index + 1).padStart(64, '0')
    item.media!.archivePath = `media/${item.recordId}/original.wav`
    item.media!.sha256 = item.identity.fileSha256
    item.media!.size = 4 * 1024 * 1024 * 1024
    return item
  })
  assert.equal(
    syncPackageV2Schema.safeParse(oversized).success,
    false,
    'v2 manifest media total must not exceed 20GB',
  )
} finally {
  await rm(archiveRoot, { recursive: true, force: true })
}

process.stdout.write('PULSE_SHELF_SYNC_PACKAGE_TEST_OK\n')

async function readTestFile(filePath: string) {
  const { readFile } = await import('node:fs/promises')
  return readFile(filePath)
}
