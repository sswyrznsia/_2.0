import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as archiverModule from 'archiver'
import type { Archiver, ArchiverError, ZipOptions } from 'archiver'
import * as unzipper from 'unzipper'
import type {
  PulseShelfSyncPackageV2,
  SyncArtworkDescriptor,
  SyncMediaDescriptor,
} from '../src/types/models'
import {
  isSafeArchivePath,
  SYNC_PACKAGE_MAX_BYTES,
  SYNC_PACKAGE_MEDIA_MAX_BYTES,
  SYNC_PACKAGE_V2_MAX_BYTES,
  syncPackageV2Schema,
} from './syncPackageCore'

export interface SyncArchiveSource {
  archivePath: string
  filePath: string
}

export interface OpenedSyncArchive {
  manifest: PulseShelfSyncPackageV2
  entries: Map<string, unzipper.File>
}

const ZipArchive = (
  archiverModule as unknown as {
    ZipArchive: new (options?: ZipOptions) => Archiver
  }
).ZipArchive

const MAX_ARCHIVE_OVERHEAD = 100 * 1024 * 1024

export async function writeSyncArchive(
  targetPath: string,
  manifest: PulseShelfSyncPackageV2,
  sources: SyncArchiveSource[],
): Promise<void> {
  const validation = syncPackageV2Schema.safeParse(manifest)
  if (!validation.success)
    throw new Error('v2 manifest 형식이 올바르지 않습니다.')
  if (sources.some((source) => !isSafeArchivePath(source.archivePath)))
    throw new Error('안전하지 않은 archive 경로입니다.')
  const output = createWriteStream(targetPath, { flags: 'wx' })
  const archive = new ZipArchive({
    forceZip64: true,
    zlib: { level: 0 },
  })
  const completion = new Promise<void>((resolve, reject) => {
    output.once('close', resolve)
    output.once('error', reject)
    archive.once('error', reject)
    archive.on('warning', (error: ArchiverError) => {
      if (error.code !== 'ENOENT') reject(error)
    })
  })
  archive.pipe(output)
  archive.append(JSON.stringify(manifest, null, 2), {
    name: 'manifest.json',
    store: true,
  })
  for (const source of sources) {
    archive.append(createReadStream(source.filePath), {
      name: source.archivePath,
      store: true,
    })
  }
  await archive.finalize()
  await completion
}

export async function openSyncArchive(
  filePath: string,
): Promise<OpenedSyncArchive> {
  const archiveStat = await stat(filePath)
  if (archiveStat.size > SYNC_PACKAGE_V2_MAX_BYTES + MAX_ARCHIVE_OVERHEAD)
    throw new Error('동기화 패키지 용량이 허용 범위를 초과합니다.')
  const directory = await unzipper.Open.file(filePath)
  const entries = new Map<string, unzipper.File>()
  let totalUncompressed = 0
  for (const entry of directory.files) {
    const checkedPath =
      entry.type === 'Directory' ? entry.path.replace(/\/+$/g, '') : entry.path
    if (!isSafeArchivePath(checkedPath))
      throw new Error('ZIP 내부에 안전하지 않은 경로가 있습니다.')
    if (isSymlinkEntry(entry))
      throw new Error('심볼릭 링크 entry는 허용되지 않습니다.')
    if ((entry.flags & 1) !== 0)
      throw new Error('암호화된 ZIP entry는 허용되지 않습니다.')
    if (entry.type === 'Directory') continue
    if (entries.has(entry.path))
      throw new Error('ZIP 내부에 중복된 파일 경로가 있습니다.')
    if (entry.uncompressedSize > SYNC_PACKAGE_MEDIA_MAX_BYTES)
      throw new Error('개별 파일 용량이 4GB를 초과합니다.')
    totalUncompressed += entry.uncompressedSize
    if (totalUncompressed > SYNC_PACKAGE_V2_MAX_BYTES + SYNC_PACKAGE_MAX_BYTES)
      throw new Error('압축 해제 용량이 20GB를 초과합니다.')
    entries.set(entry.path, entry)
  }
  const manifestEntry = entries.get('manifest.json')
  if (!manifestEntry || manifestEntry.uncompressedSize > SYNC_PACKAGE_MAX_BYTES)
    throw new Error('manifest.json이 없거나 너무 큽니다.')
  let parsed: unknown
  try {
    parsed = JSON.parse(
      (await manifestEntry.buffer()).toString('utf8'),
    ) as unknown
  } catch {
    throw new Error('manifest.json이 올바른 JSON이 아닙니다.')
  }
  const validation = syncPackageV2Schema.safeParse(parsed)
  if (!validation.success)
    throw new Error('v2 manifest 형식이 올바르지 않습니다.')
  const manifest = validation.data
  const declared = new Map<
    string,
    SyncMediaDescriptor | SyncArtworkDescriptor
  >()
  for (const record of manifest.tracks) {
    if (record.media) declared.set(record.media.archivePath, record.media)
    if (record.artwork) declared.set(record.artwork.archivePath, record.artwork)
  }
  for (const entryPath of entries.keys()) {
    if (entryPath !== 'manifest.json' && !declared.has(entryPath))
      throw new Error('manifest에 선언되지 않은 ZIP entry가 있습니다.')
  }
  for (const [archivePath, descriptor] of declared) {
    const entry = entries.get(archivePath)
    if (!entry) throw new Error('manifest에 선언된 media entry가 없습니다.')
    if (entry.uncompressedSize !== descriptor.size)
      throw new Error('media entry 크기가 manifest와 일치하지 않습니다.')
  }
  return { manifest, entries }
}

export async function extractVerifiedEntries(
  archive: OpenedSyncArchive,
  descriptors: Array<SyncMediaDescriptor | SyncArtworkDescriptor>,
  destination: string,
): Promise<Map<string, string>> {
  await mkdir(destination, { recursive: true })
  const extracted = new Map<string, string>()
  try {
    for (const [index, descriptor] of descriptors.entries()) {
      const entry = archive.entries.get(descriptor.archivePath)
      if (!entry) throw new Error('추출할 media entry가 없습니다.')
      const extension =
        'originalFileName' in descriptor
          ? descriptor.extension
          : descriptor.extension
      const target = path.join(destination, `${index}.${extension}`)
      let size = 0
      const hash = createHash('sha256')
      const verifier = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.byteLength
          if (size > descriptor.size) {
            callback(new Error('압축 해제된 파일이 선언 크기를 초과합니다.'))
            return
          }
          hash.update(chunk)
          callback(null, chunk)
        },
      })
      await pipeline(
        entry.stream(),
        verifier,
        createWriteStream(target, { flags: 'wx' }),
      )
      if (size !== descriptor.size || hash.digest('hex') !== descriptor.sha256)
        throw new Error('media 파일의 크기 또는 SHA-256이 일치하지 않습니다.')
      if (
        'originalFileName' in descriptor &&
        !(await matchesAudioSignature(target, descriptor.extension))
      )
        throw new Error(
          'media 파일 내용이 선언된 오디오 형식과 일치하지 않습니다.',
        )
      extracted.set(descriptor.archivePath, target)
    }
    return extracted
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  }
}

function isSymlinkEntry(entry: unzipper.File): boolean {
  return isSymlinkAttributes(entry.externalFileAttributes)
}

export function isSymlinkAttributes(externalFileAttributes: number): boolean {
  const unixMode = (externalFileAttributes >>> 16) & 0o170000
  return unixMode === 0o120000
}

export async function matchesAudioSignature(
  filePath: string,
  extension: SyncMediaDescriptor['extension'],
): Promise<boolean> {
  const handle = await open(filePath, 'r')
  try {
    const header = Buffer.alloc(96)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    const value = header.subarray(0, bytesRead)
    if (extension === 'wav')
      return (
        value.subarray(0, 4).toString('ascii') === 'RIFF' &&
        value.subarray(8, 12).toString('ascii') === 'WAVE'
      )
    if (extension === 'flac')
      return value.subarray(0, 4).toString('ascii') === 'fLaC'
    if (extension === 'm4a')
      return (
        value.length >= 12 && value.subarray(4, 8).toString('ascii') === 'ftyp'
      )
    if (extension === 'mp3')
      return (
        value.subarray(0, 3).toString('ascii') === 'ID3' ||
        (value.length >= 2 && value[0] === 0xff && (value[1] & 0xe0) === 0xe0)
      )
    if (extension === 'aac')
      return (
        value.length >= 2 &&
        value[0] === 0xff &&
        (value[1] === 0xf1 || value[1] === 0xf9)
      )
    if (extension === 'ogg')
      return value.subarray(0, 4).toString('ascii') === 'OggS'
    return (
      value.subarray(0, 4).toString('ascii') === 'OggS' &&
      value.includes(Buffer.from('OpusHead'))
    )
  } finally {
    await handle.close()
  }
}
