import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { app, dialog, shell } from 'electron'
import { parseFile } from 'music-metadata'
import type {
  MusicFormat,
  LibraryMutationResult,
  ScanProgress,
  ScanResult,
} from '../../src/types/models'
import {
  getPublicData,
  getStoredData,
  registerTrackIdReplacement,
  setStoredData,
  type StoredTrack,
} from '../data'

const SUPPORTED_EXTENSIONS = new Set<MusicFormat>([
  'mp3',
  'flac',
  'wav',
  'm4a',
  'aac',
  'ogg',
  'opus',
])
const HASH_CHUNK_SIZE = 64 * 1024

export interface ImportedTrackMetadata {
  source: 'youtube' | 'direct'
  sourceUrl: string
  sourceVideoId?: string
  title?: string
  artist?: string
  album?: string
  duration?: number
  cover?: { data: Uint8Array; extension: 'jpg' | 'png' }
}

interface ScanToken {
  cancelled: boolean
}

let activeScan: ScanToken | null = null
let mutationTail = Promise.resolve()

async function acquireLibraryMutation(): Promise<() => void> {
  const previous = mutationTail
  let release: () => void = () => {}
  mutationTail = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  return release
}

export async function withLibraryMutation<T>(
  work: () => Promise<T>,
): Promise<T> {
  const release = await acquireLibraryMutation()
  try {
    return await work()
  } finally {
    release()
  }
}

export function cancelActiveScan() {
  if (activeScan) activeScan.cancelled = true
}

export function getImportDirectory(): string {
  return path.join(app.getPath('userData'), 'imports')
}

function hashLibraryPath(filePath: string): string {
  return createHash('sha256')
    .update(path.resolve(filePath).toLowerCase())
    .digest('hex')
}

function isWithinPath(filePath: string, root: string): boolean {
  const relative = path.relative(root, filePath)
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  )
}

function withoutTrack(data: ReturnType<typeof getStoredData>, trackId: string) {
  const oldQueue = data.playerSession.queueIds
  const oldIndex = data.playerSession.currentIndex
  const currentRemoved = oldQueue[oldIndex] === trackId
  const removedBefore = oldQueue
    .slice(0, Math.max(0, oldIndex))
    .filter((id) => id === trackId).length
  const queueIds = oldQueue.filter((id) => id !== trackId)
  const currentIndex = queueIds.length
    ? currentRemoved
      ? Math.min(Math.max(0, oldIndex - removedBefore), queueIds.length - 1)
      : Math.min(Math.max(-1, oldIndex - removedBefore), queueIds.length - 1)
    : -1
  const lyrics = { ...data.lyrics }
  const lyricsSyncProfiles = { ...data.lyricsSyncProfiles }
  delete lyrics[trackId]
  delete lyricsSyncProfiles[trackId]
  return {
    ...data,
    tracks: data.tracks.filter((track) => track.id !== trackId),
    playlists: data.playlists.map((playlist) => {
      const trackIds = playlist.trackIds.filter((id) => id !== trackId)
      return {
        ...playlist,
        trackIds,
        coverTrackId:
          playlist.coverTrackId === trackId
            ? trackIds[0]
            : playlist.coverTrackId,
        updatedAt:
          trackIds.length === playlist.trackIds.length
            ? playlist.updatedAt
            : Date.now(),
      }
    }),
    recentTrackIds: data.recentTrackIds.filter((id) => id !== trackId),
    lyrics,
    lyricsSyncProfiles,
    playerSession: {
      ...data.playerSession,
      queueIds,
      currentIndex,
      currentTime:
        currentRemoved || currentIndex < 0 ? 0 : data.playerSession.currentTime,
      repeatMode:
        currentRemoved && data.playerSession.repeatMode === 'one'
          ? ('off' as const)
          : data.playerSession.repeatMode,
    },
  }
}

async function removeCover(trackId: string) {
  const covers = path.join(app.getPath('userData'), 'covers')
  await Promise.all(
    ['jpg', 'png'].map((extension) =>
      rm(path.join(covers, `${trackId}.${extension}`), { force: true }),
    ),
  )
}

export async function removeTrackFromLibrary(
  trackId: string,
): Promise<LibraryMutationResult> {
  const releaseMutation = await acquireLibraryMutation()
  try {
    const data = getStoredData()
    const track = data.tracks.find((item) => item.id === trackId)
    if (!track) throw new Error('라이브러리에 존재하지 않는 곡입니다.')
    const exclusionId = randomUUID()
    const next = withoutTrack(data, trackId)
    setStoredData({
      ...next,
      libraryExclusions: [
        ...data.libraryExclusions.filter(
          (item) => item.filePathHash !== hashLibraryPath(track.filePath),
        ),
        {
          id: exclusionId,
          filePathHash: hashLibraryPath(track.filePath),
          excludedAt: Date.now(),
          track,
          lyrics: data.lyrics[trackId],
          lyricsSyncProfile: data.lyricsSyncProfiles[trackId],
        },
      ],
    })
    return { data: getPublicData(), exclusionId, fileStatus: 'preserved' }
  } finally {
    releaseMutation()
  }
}

async function assertTrashableTrackFile(
  filePath: string,
  musicFolders: string[],
): Promise<string | null> {
  let fileInfo
  try {
    fileInfo = await lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink())
    throw new Error('일반 음악 파일만 휴지통으로 이동할 수 있습니다.')
  const resolvedFile = await realpath(filePath)
  const importRoot = await realpath(getImportDirectory()).catch(() => '')
  const allowedRoots = await Promise.all(
    musicFolders.map((folder) => realpath(folder).catch(() => '')),
  )
  if (importRoot) allowedRoots.push(importRoot)
  if (!allowedRoots.some((root) => root && isWithinPath(resolvedFile, root)))
    throw new Error('허용된 음악 폴더 밖의 파일은 이동할 수 없습니다.')
  const insideImport = Boolean(
    importRoot && isWithinPath(resolvedFile, importRoot),
  )
  const protectedRoots = [
    app.getPath('userData'),
    app.getAppPath(),
    process.resourcesPath,
  ]
  if (
    !insideImport &&
    protectedRoots.some((root) => {
      const resolvedRoot = path.resolve(root)
      return (
        resolvedFile === resolvedRoot ||
        isWithinPath(resolvedFile, resolvedRoot)
      )
    })
  )
    throw new Error('Pulse Shelf 프로그램 및 데이터 파일은 이동할 수 없습니다.')
  const format = path
    .extname(resolvedFile)
    .slice(1)
    .toLowerCase() as MusicFormat
  if (!SUPPORTED_EXTENSIONS.has(format))
    throw new Error('지원되는 음악 파일만 휴지통으로 이동할 수 있습니다.')
  return resolvedFile
}

export async function trashTrackFile(
  trackId: string,
): Promise<LibraryMutationResult> {
  const releaseMutation = await acquireLibraryMutation()
  try {
    const data = getStoredData()
    const track = data.tracks.find((item) => item.id === trackId)
    if (!track) throw new Error('라이브러리에 존재하지 않는 곡입니다.')
    const resolvedFile = await assertTrashableTrackFile(
      track.filePath,
      data.musicFolders,
    )
    if (resolvedFile) await shell.trashItem(resolvedFile)
    setStoredData(withoutTrack(data, trackId))
    await removeCover(trackId).catch(() => undefined)
    return {
      data: getPublicData(),
      fileStatus: resolvedFile ? 'trashed' : 'missing',
    }
  } finally {
    releaseMutation()
  }
}

export function getLibraryExclusions() {
  return getPublicData().libraryExclusions
}

export function getTrackRemovalDetails(trackId: string) {
  const data = getStoredData()
  const track = data.tracks.find((item) => item.id === trackId)
  if (!track) throw new Error('라이브러리에 존재하지 않는 곡입니다.')
  const normalizedPath = path.resolve(track.filePath)
  const importDirectory = path.resolve(getImportDirectory())
  const folder = data.musicFolders.find((item) =>
    isWithinPath(normalizedPath, path.resolve(item)),
  )
  return {
    fileName: track.fileName,
    folderName:
      normalizedPath === importDirectory ||
      isWithinPath(normalizedPath, importDirectory)
        ? 'Pulse Shelf 가져오기'
        : path.basename(folder ?? path.dirname(normalizedPath)),
  }
}

export async function restoreLibraryExclusion(exclusionId: string) {
  const releaseMutation = await acquireLibraryMutation()
  try {
    const data = getStoredData()
    const exclusion = data.libraryExclusions.find(
      (item) => item.id === exclusionId,
    )
    if (!exclusion) throw new Error('복원할 제외 항목을 찾을 수 없습니다.')
    const fileInfo = await lstat(exclusion.track.filePath).catch(() => null)
    if (!fileInfo?.isFile() || fileInfo.isSymbolicLink())
      throw new Error('원본 음악 파일을 찾을 수 없어 복원하지 못했습니다.')
    const fileStats = await stat(exclusion.track.filePath)
    const trackId = await fingerprint(exclusion.track.filePath, fileStats.size)
    const restored = await parseTrack(
      exclusion.track.filePath,
      trackId,
      fileStats.size,
      fileStats.mtimeMs,
      exclusion.track,
    )
    const tracks = data.tracks.some((track) => track.id === trackId)
      ? data.tracks
      : [...data.tracks, restored].sort((a, b) =>
          a.title.localeCompare(b.title, 'ko'),
        )
    const lyrics = { ...data.lyrics }
    const lyricsSyncProfiles = { ...data.lyricsSyncProfiles }
    if (exclusion.lyrics && !lyrics[trackId])
      lyrics[trackId] = { ...exclusion.lyrics, trackId }
    if (exclusion.lyricsSyncProfile && !lyricsSyncProfiles[trackId])
      lyricsSyncProfiles[trackId] = {
        ...exclusion.lyricsSyncProfile,
        trackId,
      }
    setStoredData({
      ...data,
      tracks,
      lyrics,
      lyricsSyncProfiles,
      libraryExclusions: data.libraryExclusions.filter(
        (item) => item.id !== exclusionId,
      ),
    })
    return getPublicData()
  } finally {
    releaseMutation()
  }
}

async function fingerprint(filePath: string, size: number): Promise<string> {
  const handle = await open(filePath, 'r')
  try {
    const firstSize = Math.min(HASH_CHUNK_SIZE, size)
    const lastSize = Math.min(HASH_CHUNK_SIZE, Math.max(0, size - firstSize))
    const first = Buffer.alloc(firstSize)
    const last = Buffer.alloc(lastSize)
    if (firstSize) await handle.read(first, 0, firstSize, 0)
    if (lastSize)
      await handle.read(last, 0, lastSize, Math.max(0, size - lastSize))
    return createHash('sha256')
      .update(String(size))
      .update(first)
      .update(last)
      .digest('hex')
  } finally {
    await handle.close()
  }
}

async function findAudioFiles(
  folders: string[],
  token: ScanToken,
  onProgress: (progress: ScanProgress) => void,
): Promise<{ files: string[]; errors: string[] }> {
  const files: string[] = []
  const errors: string[] = []
  const pending = [...folders]
  while (pending.length && !token.cancelled) {
    const current = pending.pop()
    if (!current) break
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      errors.push(`${path.basename(current)} 폴더에 접근할 수 없습니다.`)
      continue
    }
    for (const entry of entries) {
      if (token.cancelled) break
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(entryPath)
      else if (entry.isFile()) {
        const format = path
          .extname(entry.name)
          .slice(1)
          .toLowerCase() as MusicFormat
        if (SUPPORTED_EXTENSIONS.has(format)) files.push(entryPath)
      }
    }
    onProgress({
      phase: 'discovering',
      discovered: files.length,
      processed: 0,
      total: 0,
      currentFile: path.basename(current),
      errors: errors.length,
    })
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { files, errors }
}

async function parseTrack(
  filePath: string,
  id: string,
  fileSize: number,
  modifiedAt: number,
  previous?: StoredTrack,
): Promise<StoredTrack> {
  const metadata = await parseFile(filePath, {
    duration: true,
    skipCovers: false,
  })
  let coverUrl: string | undefined
  const picture = metadata.common.picture?.[0]
  if (picture && picture.data.byteLength <= 15 * 1024 * 1024) {
    try {
      const extension = picture.format.toLowerCase().includes('png')
        ? 'png'
        : 'jpg'
      const coversPath = path.join(app.getPath('userData'), 'covers')
      await mkdir(coversPath, { recursive: true })
      await writeFile(path.join(coversPath, `${id}.${extension}`), picture.data)
      await unlink(
        path.join(coversPath, `${id}.${extension === 'png' ? 'jpg' : 'png'}`),
      ).catch(() => undefined)
      coverUrl = `pulse-cover://track/${id}`
    } catch {
      coverUrl = previous?.coverUrl
    }
  }
  const format = path.extname(filePath).slice(1).toLowerCase() as MusicFormat
  return {
    id,
    filePath,
    fileName: path.basename(filePath),
    title: previous?.source
      ? previous.title
      : (
          metadata.common.title?.trim() ||
          path.basename(filePath, path.extname(filePath))
        ).slice(0, 500),
    artist: previous?.source
      ? previous.artist
      : (metadata.common.artist?.trim() || '알 수 없는 아티스트').slice(0, 500),
    album: previous?.source
      ? previous.album
      : (metadata.common.album?.trim() || '알 수 없는 앨범').slice(0, 500),
    duration: previous?.source
      ? previous.duration
      : Number.isFinite(metadata.format.duration)
        ? (metadata.format.duration ?? 0)
        : 0,
    format,
    fileSize,
    modifiedAt,
    addedAt: previous?.addedAt ?? Date.now(),
    trackNumber:
      metadata.common.track.no && metadata.common.track.no > 0
        ? metadata.common.track.no
        : undefined,
    discNumber:
      metadata.common.disk.no && metadata.common.disk.no > 0
        ? metadata.common.disk.no
        : undefined,
    year:
      metadata.common.year &&
      metadata.common.year >= 1000 &&
      metadata.common.year <= 9999
        ? metadata.common.year
        : undefined,
    coverUrl: coverUrl ?? previous?.coverUrl,
    liked: previous?.liked ?? false,
    lastPlayedAt: previous?.lastPlayedAt,
    playCount: previous?.playCount ?? 0,
    source: previous?.source,
    sourceUrl: previous?.sourceUrl,
    sourceVideoId: previous?.sourceVideoId,
  }
}

export async function scanFolders(
  folders: string[],
  onProgress: (progress: ScanProgress) => void,
  selectedFolder?: string,
): Promise<ScanResult> {
  if (activeScan) throw new Error('이미 음악 라이브러리를 검색하고 있습니다.')
  const token: ScanToken = { cancelled: false }
  activeScan = token
  const releaseMutation = await acquireLibraryMutation()
  try {
    const before = getStoredData()
    const previousByPath = new Map(
      before.tracks.map((track) => [
        path.normalize(track.filePath).toLocaleLowerCase(),
        track,
      ]),
    )
    const previousById = new Map(
      before.tracks.map((track) => [track.id, track]),
    )
    const excludedPathHashes = new Set(
      before.libraryExclusions.map((item) => item.filePathHash),
    )
    const importDirectory = getImportDirectory()
    const scanRoots = [
      ...new Set([
        ...folders.map((folder) => path.normalize(folder)),
        ...(existsSync(importDirectory)
          ? [path.normalize(importDirectory)]
          : []),
      ]),
    ]
    const discovery = await findAudioFiles(scanRoots, token, onProgress)
    if (token.cancelled)
      return { cancelled: true, tracks: [], errors: discovery.errors }

    const uniquePaths = [
      ...new Set(discovery.files.map((item) => path.normalize(item))),
    ]
    const tracks: StoredTrack[] = []
    const seenIds = new Set<string>()
    const errors = [...discovery.errors]

    for (let index = 0; index < uniquePaths.length; index += 4) {
      if (token.cancelled) break
      const batch = uniquePaths.slice(index, index + 4)
      const results = await Promise.allSettled(
        batch.map(async (filePath) => {
          if (excludedPathHashes.has(hashLibraryPath(filePath))) return null
          const fileStats = await stat(filePath)
          const previousPath = previousByPath.get(filePath.toLocaleLowerCase())
          if (
            previousPath &&
            previousPath.fileSize === fileStats.size &&
            Math.abs(previousPath.modifiedAt - fileStats.mtimeMs) < 1
          ) {
            return {
              ...previousPath,
              filePath,
              fileName: path.basename(filePath),
            }
          }
          const id =
            previousPath?.id ?? (await fingerprint(filePath, fileStats.size))
          return parseTrack(
            filePath,
            id,
            fileStats.size,
            fileStats.mtimeMs,
            previousById.get(id) ?? previousPath,
          )
        }),
      )
      results.forEach((result, resultIndex) => {
        if (result.status === 'fulfilled' && result.value) {
          if (!seenIds.has(result.value.id)) {
            seenIds.add(result.value.id)
            tracks.push(result.value)
          }
        } else {
          errors.push(
            `${path.basename(batch[resultIndex])}: 파일을 읽지 못했습니다.`,
          )
        }
      })
      onProgress({
        phase: 'reading',
        discovered: uniquePaths.length,
        processed: Math.min(index + batch.length, uniquePaths.length),
        total: uniquePaths.length,
        currentFile: path.basename(batch.at(-1) ?? ''),
        errors: errors.length,
      })
      await new Promise((resolve) => setImmediate(resolve))
    }

    if (token.cancelled) return { cancelled: true, tracks: [], errors }
    onProgress({
      phase: 'finishing',
      discovered: uniquePaths.length,
      processed: uniquePaths.length,
      total: uniquePaths.length,
      currentFile: '',
      errors: errors.length,
    })
    tracks.sort((a, b) => a.title.localeCompare(b.title, 'ko'))
    const latest = getStoredData()
    const latestById = new Map(latest.tracks.map((track) => [track.id, track]))
    const mergedTracks = tracks.map((track) => {
      const latestTrack = latestById.get(track.id)
      return latestTrack
        ? {
            ...track,
            liked: latestTrack.liked,
            lastPlayedAt: latestTrack.lastPlayedAt,
            playCount: latestTrack.playCount,
            addedAt: latestTrack.addedAt,
          }
        : track
    })
    const validIds = new Set(mergedTracks.map((track) => track.id))
    setStoredData({
      ...latest,
      musicFolders: folders,
      tracks: mergedTracks,
      recentTrackIds: latest.recentTrackIds.filter((id) => validIds.has(id)),
      playerSession: {
        ...latest.playerSession,
        queueIds: latest.playerSession.queueIds.filter((id) =>
          validIds.has(id),
        ),
      },
    })
    return {
      cancelled: false,
      tracks: mergedTracks.map(({ filePath, ...track }) => {
        void filePath
        return track
      }),
      folder: selectedFolder,
      errors,
    }
  } finally {
    activeScan = null
    releaseMutation()
  }
}

export async function registerImportedFile(
  filePath: string,
  metadata: ImportedTrackMetadata,
  stagingPath?: string,
): Promise<{ trackId: string; replacedFilePath?: string }> {
  const releaseMutation = await acquireLibraryMutation()
  try {
    const importDirectory = path.resolve(getImportDirectory())
    const resolvedFile = path.resolve(filePath)
    if (
      resolvedFile !== importDirectory &&
      !resolvedFile.startsWith(`${importDirectory}${path.sep}`)
    )
      throw new Error('앱 관리 가져오기 폴더 밖의 파일은 등록할 수 없습니다.')
    if (stagingPath) {
      const resolvedStaging = path.resolve(stagingPath)
      if (!resolvedStaging.startsWith(`${importDirectory}${path.sep}`))
        throw new Error('올바르지 않은 임시 미디어 경로입니다.')
      await rename(resolvedStaging, resolvedFile)
    }
    const fileStats = await stat(resolvedFile)
    if (!fileStats.isFile()) throw new Error('완료된 미디어 파일이 없습니다.')
    const format = path
      .extname(resolvedFile)
      .slice(1)
      .toLowerCase() as MusicFormat
    if (!SUPPORTED_EXTENSIONS.has(format))
      throw new Error('라이브러리가 지원하지 않는 미디어 형식입니다.')

    const before = getStoredData()
    const previous = before.tracks.find(
      (track) =>
        (metadata.sourceVideoId &&
          track.sourceVideoId === metadata.sourceVideoId) ||
        track.sourceUrl === metadata.sourceUrl,
    )
    const id = await fingerprint(resolvedFile, fileStats.size)
    const contentDuplicate = before.tracks.find(
      (track) => track.id === id && track.id !== previous?.id,
    )
    if (contentDuplicate)
      throw new Error(
        `같은 미디어가 이미 라이브러리에 있습니다: ${contentDuplicate.title}`,
      )
    const parsed = await parseTrack(
      resolvedFile,
      id,
      fileStats.size,
      fileStats.mtimeMs,
      previous,
    )
    const track: StoredTrack = {
      ...parsed,
      title: metadata.title?.trim().slice(0, 500) || parsed.title,
      artist: metadata.artist?.trim().slice(0, 500) || parsed.artist,
      album: metadata.album?.trim().slice(0, 500) || parsed.album,
      duration:
        metadata.duration !== undefined && Number.isFinite(metadata.duration)
          ? Math.max(0, metadata.duration)
          : parsed.duration,
      source: metadata.source,
      sourceUrl: metadata.sourceUrl,
      sourceVideoId: metadata.sourceVideoId,
    }
    if (metadata.cover && metadata.cover.data.byteLength <= 15 * 1024 * 1024) {
      const coversPath = path.join(app.getPath('userData'), 'covers')
      await mkdir(coversPath, { recursive: true })
      await writeFile(
        path.join(coversPath, `${id}.${metadata.cover.extension}`),
        metadata.cover.data,
      )
      await unlink(
        path.join(
          coversPath,
          `${id}.${metadata.cover.extension === 'png' ? 'jpg' : 'png'}`,
        ),
      ).catch(() => undefined)
      track.coverUrl = `pulse-cover://track/${id}`
    }

    const oldId = previous?.id
    const replaceId = (value: string) => (oldId && value === oldId ? id : value)
    const latest = getStoredData()
    const latestPrevious = oldId
      ? latest.tracks.find((item) => item.id === oldId)
      : undefined
    if (latestPrevious) {
      track.liked = latestPrevious.liked
      track.lastPlayedAt = latestPrevious.lastPlayedAt
      track.playCount = latestPrevious.playCount
      track.addedAt = latestPrevious.addedAt
    }
    const tracks = latest.tracks
      .filter(
        (item) =>
          item.id !== id &&
          item.id !== oldId &&
          item.sourceUrl !== metadata.sourceUrl &&
          (!metadata.sourceVideoId ||
            item.sourceVideoId !== metadata.sourceVideoId),
      )
      .concat(track)
      .sort((a, b) => a.title.localeCompare(b.title, 'ko'))
    setStoredData({
      ...latest,
      tracks,
      playlists: latest.playlists.map((playlist) => ({
        ...playlist,
        trackIds: [...new Set(playlist.trackIds.map(replaceId))],
        coverTrackId: playlist.coverTrackId
          ? replaceId(playlist.coverTrackId)
          : undefined,
      })),
      recentTrackIds: [...new Set(latest.recentTrackIds.map(replaceId))],
      playerSession: {
        ...latest.playerSession,
        queueIds: latest.playerSession.queueIds.map(replaceId),
      },
    })
    if (oldId && oldId !== id) registerTrackIdReplacement(oldId, id)
    return {
      trackId: id,
      replacedFilePath:
        previous?.filePath !== resolvedFile ? previous?.filePath : undefined,
    }
  } finally {
    releaseMutation()
  }
}

export async function chooseAndScanFolder(
  onProgress: (progress: ScanProgress) => void,
): Promise<ScanResult> {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: '음악 폴더 선택',
  })
  if (result.canceled || !result.filePaths[0])
    return { cancelled: true, tracks: [], errors: [] }
  const current = getStoredData()
  const folders = [
    ...new Set([...current.musicFolders, path.normalize(result.filePaths[0])]),
  ]
  return scanFolders(folders, onProgress, result.filePaths[0])
}

export function rescanFolders(
  onProgress: (progress: ScanProgress) => void,
): Promise<ScanResult> {
  return scanFolders(getStoredData().musicFolders, onProgress)
}

export function removeFolder(
  folder: string,
  onProgress: (progress: ScanProgress) => void,
): Promise<ScanResult> {
  const current = getStoredData()
  const normalized = path.normalize(folder)
  if (!current.musicFolders.includes(normalized))
    throw new Error('등록되지 않은 음악 폴더입니다.')
  return scanFolders(
    current.musicFolders.filter((item) => item !== normalized),
    onProgress,
  )
}
