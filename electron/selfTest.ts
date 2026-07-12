import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { app, screen } from 'electron'
import {
  getPublicData,
  getStoredData,
  initializeStore,
  setPublicData,
  setStoredData,
  setStoredDataWithImportBackup,
} from './data'
import {
  cancelActiveScan,
  getImportDirectory,
  registerImportedFile,
  removeTrackFromLibrary,
  restoreLibraryExclusion,
  scanFolders,
  trashTrackFile,
} from './ipc/library'
import { loadTrackLyrics } from './ipc/lyrics'
import {
  computeTaskbarToggleBounds,
  computeTaskbarRect,
  detectTaskbarEdge,
  isFullscreenRect,
} from './taskbarGeometry'

function verifyTaskbarGeometry() {
  const fixtures = [
    {
      name: '1920x1080@100%',
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1032 },
    },
    {
      name: '1280x720@100%',
      bounds: { x: 0, y: 0, width: 1280, height: 720 },
      workArea: { x: 0, y: 0, width: 1280, height: 672 },
    },
    {
      name: '1920x1080@125%-DIP',
      bounds: { x: 0, y: 0, width: 1536, height: 864 },
      workArea: { x: 0, y: 0, width: 1536, height: 816 },
    },
    {
      name: '1920x1080@150%-DIP',
      bounds: { x: 0, y: 0, width: 1280, height: 720 },
      workArea: { x: 0, y: 0, width: 1280, height: 672 },
    },
    {
      name: 'secondary-monitor-left',
      bounds: { x: -1280, y: 120, width: 1280, height: 720 },
      workArea: { x: -1280, y: 120, width: 1280, height: 672 },
    },
  ]
  for (const fixture of fixtures) {
    for (const position of ['left', 'custom', 'right'] as const) {
      for (const size of [
        { width: 380, height: 44 },
        { width: 36, height: 36 },
      ]) {
        const result = computeTaskbarToggleBounds(fixture, size, position)
        const taskbarRect = computeTaskbarRect(fixture)
        if (
          result.x < taskbarRect.x ||
          result.y < taskbarRect.y ||
          result.x + result.width > taskbarRect.x + taskbarRect.width ||
          result.y + result.height > taskbarRect.y + taskbarRect.height
        )
          throw new Error(`Taskbar bounds escaped ${fixture.name}`)
      }
    }
  }
  const sideTaskbars = [
    {
      edge: 'top',
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 40, width: 1920, height: 1040 },
    },
    {
      edge: 'left',
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 48, y: 0, width: 1872, height: 1080 },
    },
    {
      edge: 'right',
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1872, height: 1080 },
    },
  ] as const
  for (const fixture of sideTaskbars)
    if (detectTaskbarEdge(fixture) !== fixture.edge)
      throw new Error(`Taskbar ${fixture.edge} edge was not detected`)
  const autoHide = {
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  }
  if (detectTaskbarEdge(autoHide, 'left') !== 'left')
    throw new Error('Auto-hide taskbar edge fallback was lost')
  if (
    !isFullscreenRect(
      { x: 0, y: 0, width: 1920, height: 1080 },
      autoHide.bounds,
    )
  )
    throw new Error('Fullscreen rectangle detection failed')
  for (const display of screen.getAllDisplays()) {
    const result = computeTaskbarToggleBounds(
      display,
      { width: 380, height: 44 },
      'right',
    )
    const taskbarRect = computeTaskbarRect(display)
    if (
      result.x < taskbarRect.x ||
      result.y < taskbarRect.y ||
      result.x + result.width > taskbarRect.x + taskbarRect.width ||
      result.y + result.height > taskbarRect.y + taskbarRect.height
    )
      throw new Error(`Actual display ${display.id} produced invalid bounds`)
  }
  process.stdout.write('PULSE_SHELF_TASKBAR_GEOMETRY_OK\n')
}

function createTestWav(frequency = 440): Buffer {
  const sampleRate = 8_000
  const samples = sampleRate
  const dataSize = samples * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(
      Math.round(
        Math.sin((index / sampleRate) * Math.PI * 2 * frequency) * 8_000,
      ),
      44 + index * 2,
    )
  }
  return buffer
}

export interface SelfTestFixture {
  root: string
  trackId: string
}

export async function runSelfTest(): Promise<SelfTestFixture> {
  verifyTaskbarGeometry()
  const root = await mkdtemp(path.join(os.tmpdir(), 'pulse-shelf-test-'))
  const musicFolder = path.join(root, 'music')
  await mkdir(musicFolder)
  app.setPath('userData', path.join(root, 'user-data'))
  await mkdir(app.getPath('userData'), { recursive: true })
  const audioPath = path.join(musicFolder, 'tone.wav')
  await writeFile(audioPath, createTestWav())
  await writeFile(
    path.join(musicFolder, 'tone.lrc'),
    '[00:00.00]Test line\n[00:00.50]Second line',
    'utf8',
  )

  initializeStore()
  const progressEvents: number[] = []
  const first = await scanFolders([musicFolder], (progress) =>
    progressEvents.push(progress.processed),
  )
  if (first.cancelled || first.tracks.length !== 1)
    throw new Error('Library scan did not return one track')
  const track = first.tracks[0]
  if (track.format !== 'wav' || track.duration < 0.9 || track.duration > 1.1)
    throw new Error('WAV metadata is invalid')
  if ('filePath' in track) throw new Error('Public track leaked its path')
  const lyrics = await loadTrackLyrics(track.id)
  if (lyrics.kind !== 'lrc' || !lyrics.content.includes('Second line'))
    throw new Error('LRC loading failed')
  const publicData = getPublicData()
  publicData.tracks[0].liked = true
  publicData.playlists = [
    {
      id: randomUUID(),
      name: 'Self test playlist',
      trackIds: [track.id],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      coverTrackId: track.id,
    },
  ]
  publicData.playerSession = {
    ...publicData.playerSession,
    queueIds: [track.id],
    currentIndex: 0,
    currentTime: 0.25,
    volume: 0.55,
  }
  setPublicData(publicData)
  await scanFolders([musicFolder], () => undefined)
  const restored = getPublicData()
  if (!restored.tracks[0].liked)
    throw new Error('Like state was not preserved after rescan')
  if (
    restored.playlists[0]?.trackIds[0] !== track.id ||
    restored.playerSession.queueIds[0] !== track.id ||
    restored.playerSession.volume !== 0.55
  )
    throw new Error('Playlist or player session persistence failed')
  if (!progressEvents.length) throw new Error('Scan progress was not emitted')

  const beforeSyncImport = getStoredData()
  let invalidSyncImportRejected = false
  try {
    await setStoredDataWithImportBackup({
      ...beforeSyncImport,
      tracks: beforeSyncImport.tracks.map((item, index) =>
        index === 0 ? { ...item, duration: -1 } : item,
      ),
    })
  } catch {
    invalidSyncImportRejected = true
  }
  if (
    !invalidSyncImportRejected ||
    JSON.stringify(getStoredData()) !== JSON.stringify(beforeSyncImport)
  )
    throw new Error('Invalid sync import changed the current data')
  const atomicImport = await setStoredDataWithImportBackup(beforeSyncImport)
  if (!existsSync(atomicImport.backupPath))
    throw new Error('Pre-import backup was not created')
  process.stdout.write('PULSE_SHELF_SYNC_IMPORT_ATOMIC_OK\n')

  const excludedPath = path.join(musicFolder, 'excluded.wav')
  await writeFile(excludedPath, createTestWav(510))
  await scanFolders([musicFolder], () => undefined)
  const excludedTrack = getPublicData().tracks.find(
    (item) => item.fileName === 'excluded.wav',
  )
  if (!excludedTrack) throw new Error('Removal fixture was not scanned')
  const removalData = getPublicData()
  removalData.tracks = removalData.tracks.map((item) =>
    item.id === excludedTrack.id ? { ...item, liked: true } : item,
  )
  removalData.playlists[0].trackIds.push(excludedTrack.id)
  removalData.playlists[0].coverTrackId = excludedTrack.id
  removalData.recentTrackIds = [excludedTrack.id]
  removalData.playerSession = {
    ...removalData.playerSession,
    queueIds: [excludedTrack.id],
    currentIndex: 0,
    currentTime: 0.5,
    repeatMode: 'one',
  }
  removalData.lyrics[excludedTrack.id] = {
    trackId: excludedTrack.id,
    source: 'manual',
    plainLyrics: 'Removal fixture lyrics',
    fetchedAt: Date.now(),
    userSelected: true,
  }
  setPublicData(removalData, { preserveLyrics: false })
  const removed = await removeTrackFromLibrary(excludedTrack.id)
  if (!removed.exclusionId || !existsSync(excludedPath))
    throw new Error('Library-only removal touched the source file')
  const afterRemoval = getPublicData()
  if (
    JSON.stringify(afterRemoval.libraryExclusions).includes(excludedPath) ||
    afterRemoval.tracks.some((item) => item.id === excludedTrack.id) ||
    afterRemoval.playlists.some((playlist) =>
      playlist.trackIds.includes(excludedTrack.id),
    ) ||
    afterRemoval.recentTrackIds.includes(excludedTrack.id) ||
    afterRemoval.playerSession.queueIds.includes(excludedTrack.id) ||
    afterRemoval.playerSession.currentIndex !== -1 ||
    afterRemoval.playerSession.repeatMode !== 'off' ||
    afterRemoval.lyrics[excludedTrack.id]
  )
    throw new Error('Related track data was not removed atomically')
  await writeFile(excludedPath, createTestWav(520))
  await scanFolders([musicFolder], () => undefined)
  if (getPublicData().tracks.some((item) => item.fileName === 'excluded.wav'))
    throw new Error('Excluded path was re-added after its content changed')
  initializeStore()
  if (
    !getPublicData().libraryExclusions.some(
      (item) => item.id === removed.exclusionId,
    )
  )
    throw new Error('Library exclusion did not survive store reinitialization')
  const restoredRemoval = await restoreLibraryExclusion(removed.exclusionId)
  const restoredExcludedTrack = restoredRemoval.tracks.find(
    (item) => item.fileName === 'excluded.wav',
  )
  if (
    !restoredExcludedTrack ||
    restoredRemoval.libraryExclusions.some(
      (item) => item.id === removed.exclusionId,
    ) ||
    restoredRemoval.lyrics[restoredExcludedTrack.id]?.plainLyrics !==
      'Removal fixture lyrics'
  )
    throw new Error('Excluded track undo did not restore the track and lyrics')
  process.stdout.write('PULSE_SHELF_LIBRARY_REMOVAL_OK\n')

  const trashPath = path.join(musicFolder, 'trash-fixture.wav')
  await writeFile(trashPath, createTestWav(530))
  await scanFolders([musicFolder], () => undefined)
  const trashTrack = getPublicData().tracks.find(
    (item) => item.fileName === 'trash-fixture.wav',
  )
  if (!trashTrack) throw new Error('Trash fixture was not scanned')
  const trashed = await trashTrackFile(trashTrack.id)
  if (
    trashed.fileStatus !== 'trashed' ||
    existsSync(trashPath) ||
    getPublicData().tracks.some((item) => item.id === trashTrack.id)
  )
    throw new Error('Temporary fixture was not moved to the Windows trash')
  process.stdout.write('PULSE_SHELF_LIBRARY_TRASH_OK\n')

  const unsafePath = path.join(musicFolder, 'unsafe.txt')
  await writeFile(unsafePath, 'not audio', 'utf8')
  const unsafeId = 'f'.repeat(64)
  const storedForFailure = getStoredData()
  setStoredData({
    ...storedForFailure,
    tracks: [
      ...storedForFailure.tracks,
      {
        ...storedForFailure.tracks[0],
        id: unsafeId,
        filePath: unsafePath,
        fileName: 'unsafe.txt',
      },
    ],
  })
  let unsafeRejected = false
  try {
    await trashTrackFile(unsafeId)
  } catch {
    unsafeRejected = true
  }
  if (
    !unsafeRejected ||
    !existsSync(unsafePath) ||
    !getPublicData().tracks.some((item) => item.id === unsafeId)
  )
    throw new Error('Failed trash operation mutated the library or source file')
  process.stdout.write('PULSE_SHELF_LIBRARY_TRASH_ATOMIC_OK\n')
  setStoredData({
    ...getStoredData(),
    tracks: getStoredData().tracks.filter((item) => item.id !== unsafeId),
  })

  const missingId = 'e'.repeat(64)
  const missingPath = path.join(musicFolder, 'missing.wav')
  const storedForMissing = getStoredData()
  setStoredData({
    ...storedForMissing,
    tracks: [
      ...storedForMissing.tracks,
      {
        ...storedForMissing.tracks[0],
        id: missingId,
        filePath: missingPath,
        fileName: 'missing.wav',
      },
    ],
  })
  const missing = await trashTrackFile(missingId)
  if (
    missing.fileStatus !== 'missing' ||
    getPublicData().tracks.some((item) => item.id === missingId)
  )
    throw new Error('Missing file record was not removed safely')
  process.stdout.write('PULSE_SHELF_LIBRARY_MISSING_OK\n')
  const importDirectory = getImportDirectory()
  const stagingDirectory = path.join(importDirectory, '.pulse-import-self-test')
  await mkdir(stagingDirectory, { recursive: true })
  const stagingPath = path.join(stagingDirectory, 'media.wav')
  const importedPath = path.join(
    importDirectory,
    'Imported tone [BaW_jenozKc].wav',
  )
  await writeFile(stagingPath, createTestWav(550))
  const imported = await registerImportedFile(
    importedPath,
    {
      source: 'youtube',
      sourceUrl: 'https://www.youtube.com/watch?v=BaW_jenozKc',
      sourceVideoId: 'BaW_jenozKc',
      title: 'Imported tone',
      artist: 'Self test',
      album: 'Authorized fixtures',
      duration: 1,
    },
    stagingPath,
  )
  const importedTrack = getPublicData().tracks.find(
    (item) => item.id === imported.trackId,
  )
  if (
    importedTrack?.sourceVideoId !== 'BaW_jenozKc' ||
    importedTrack.title !== 'Imported tone'
  )
    throw new Error('Imported track provenance or metadata was not registered')
  await scanFolders([musicFolder], () => undefined)
  const rescannedImport = getPublicData().tracks.find(
    (item) => item.sourceVideoId === 'BaW_jenozKc',
  )
  if (!rescannedImport || rescannedImport.title !== 'Imported tone')
    throw new Error('Imported track did not survive a library rescan')
  const replacementStage = path.join(stagingDirectory, 'replacement.wav')
  const replacementPath = path.join(
    importDirectory,
    'Imported tone replacement [BaW_jenozKc].wav',
  )
  await writeFile(replacementStage, createTestWav(660))
  const replacement = await registerImportedFile(
    replacementPath,
    {
      source: 'youtube',
      sourceUrl: 'https://www.youtube.com/watch?v=BaW_jenozKc',
      sourceVideoId: 'BaW_jenozKc',
      title: 'Imported tone replacement',
    },
    replacementStage,
  )
  if (
    !replacement.replacedFilePath ||
    getPublicData().tracks.filter(
      (item) => item.sourceVideoId === 'BaW_jenozKc',
    ).length !== 1
  )
    throw new Error('Imported source replacement created a duplicate')
  await unlink(replacement.replacedFilePath)
  await removeTrackFromLibrary(replacement.trackId)
  const reimportStage = path.join(stagingDirectory, 'reimport.wav')
  const reimportPath = path.join(
    importDirectory,
    'Imported tone reimport [BaW_jenozKc].wav',
  )
  await writeFile(reimportStage, createTestWav(770))
  await registerImportedFile(
    reimportPath,
    {
      source: 'youtube',
      sourceUrl: 'https://www.youtube.com/watch?v=BaW_jenozKc',
      sourceVideoId: 'BaW_jenozKc',
      title: 'Imported tone reimport',
    },
    reimportStage,
  )
  const reimported = getPublicData().tracks.filter(
    (item) => item.sourceVideoId === 'BaW_jenozKc',
  )
  if (
    reimported.length !== 1 ||
    reimported[0].title !== 'Imported tone reimport'
  )
    throw new Error('Removed YouTube source could not be imported again')
  process.stdout.write('PULSE_SHELF_LIBRARY_REIMPORT_OK\n')
  const cancelledScan = scanFolders([musicFolder], () => undefined)
  setTimeout(cancelActiveScan, 0)
  if (!(await cancelledScan).cancelled)
    throw new Error('Scan cancellation failed')
  return {
    root,
    trackId: track.id,
  }
}
