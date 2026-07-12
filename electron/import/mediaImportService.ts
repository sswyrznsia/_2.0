import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { createWriteStream, existsSync } from 'node:fs'
import { isIP } from 'node:net'
import {
  mkdir,
  readdir,
  rm,
  stat,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { Transform } from 'node:stream'
import { spawn } from 'node:child_process'
import { app } from 'electron'
import log from 'electron-log/main'
import type {
  ImportAvailability,
  MediaImportJob,
  MediaImportRequest,
} from '../../src/types/models'
import { extractYouTubeVideoId } from '../../src/utils/youtube'
import { getStoredData } from '../data'
import { getImportDirectory, registerImportedFile } from '../ipc/library'
import { ImportQueue } from './importQueue'
import { classifyToolError, MediaImportError } from './importErrors'
import type { ImportMetadata, QueuedImport } from './importTypes'

const SUPPORTED_EXTENSIONS = new Set([
  'mp3',
  'flac',
  'wav',
  'm4a',
  'aac',
  'ogg',
  'opus',
])
const MAX_TOOL_OUTPUT = 10 * 1024 * 1024
const MAX_COVER_BYTES = 15 * 1024 * 1024
const MAX_MEDIA_BYTES = 5 * 1024 * 1024 * 1024

type JobEvent = 'progress' | 'completed' | 'failed'

export class MediaImportService {
  private availability: ImportAvailability = {
    available: false,
    reason: 'service-not-installed',
    outputDirectory: '',
  }
  private readonly jobs = new Map<string, QueuedImport>()
  private readonly queue = new ImportQueue((item) => this.execute(item), 1)

  constructor(
    private readonly emit: (event: JobEvent, job: MediaImportJob) => void,
    private readonly onLibraryChanged: () => void,
  ) {}

  async initialize(): Promise<ImportAvailability> {
    const outputDirectory = getImportDirectory()
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      this.availability = {
        available: false,
        reason: 'unsupported-platform',
        outputDirectory,
      }
      return this.getAvailability()
    }
    const binary = this.toolPath()
    if (!existsSync(binary)) {
      this.availability = {
        available: false,
        reason: 'binary-not-found',
        outputDirectory,
      }
      return this.getAvailability()
    }
    try {
      await mkdir(outputDirectory, { recursive: true })
      const staleEntries = await readdir(outputDirectory, {
        withFileTypes: true,
      })
      await Promise.all(
        staleEntries
          .filter(
            (entry) =>
              entry.isDirectory() && entry.name.startsWith('.pulse-import-'),
          )
          .map((entry) =>
            rm(path.join(outputDirectory, entry.name), {
              recursive: true,
              force: true,
            }),
          ),
      )
      const probe = path.join(outputDirectory, `.write-test-${randomUUID()}`)
      await writeFile(probe, '')
      await unlink(probe)
      const version = (
        await this.runProcess(binary, ['--version'])
      ).stdout.trim()
      this.availability = {
        available: true,
        reason: 'ready',
        outputDirectory,
        version,
      }
    } catch (error) {
      log.error('Media import service initialization failed', error)
      this.availability = {
        available: false,
        reason: 'configuration-error',
        outputDirectory,
      }
    }
    return this.getAvailability()
  }

  getAvailability(): ImportAvailability {
    return { ...this.availability, outputDirectory: getImportDirectory() }
  }

  getJobs(): MediaImportJob[] {
    return [...this.jobs.values()]
      .map(({ job }) => ({ ...job }))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  hasActiveJobs(): boolean {
    return [...this.jobs.values()].some(({ job }) =>
      [
        'queued',
        'preparing',
        'downloading',
        'processing',
        'registering',
      ].includes(job.status),
    )
  }

  start(request: MediaImportRequest): MediaImportJob {
    if (!this.availability.available)
      throw new MediaImportError('service-unavailable')
    if (this.hasActiveJobs())
      throw new MediaImportError(
        'duplicate-content',
        '가져오기 작업이 이미 진행 중입니다.',
      )
    const normalized = this.normalizeRequest(request)
    const existing = getStoredData().tracks.find(
      (track) =>
        (normalized.sourceVideoId &&
          track.sourceVideoId === normalized.sourceVideoId) ||
        track.sourceUrl === normalized.url,
    )
    if (existing && !request.replaceExisting)
      throw new MediaImportError('duplicate-content')
    const running = [...this.jobs.values()].some(
      ({ job }) =>
        [
          'queued',
          'preparing',
          'downloading',
          'processing',
          'registering',
        ].includes(job.status) &&
        ((normalized.sourceVideoId &&
          job.sourceVideoId === normalized.sourceVideoId) ||
          job.sourceUrl === normalized.url),
    )
    if (running)
      throw new MediaImportError('duplicate-content', '현재 가져오는 중입니다.')

    const now = Date.now()
    const item: QueuedImport = {
      request: { ...request, url: normalized.url },
      controller: new AbortController(),
      job: {
        jobId: randomUUID(),
        source: request.source,
        sourceUrl: normalized.url,
        sourceVideoId: normalized.sourceVideoId,
        status: 'queued',
        progress: 0,
        message: '대기 중',
        createdAt: now,
        updatedAt: now,
      },
    }
    this.jobs.set(item.job.jobId, item)
    this.queue.add(item)
    this.emit('progress', item.job)
    return { ...item.job }
  }

  cancel(jobId: string): boolean {
    const item = this.jobs.get(jobId)
    if (
      !item ||
      ['registering', 'completed', 'failed', 'cancelled'].includes(
        item.job.status,
      )
    )
      return false
    const queued = this.queue.remove(jobId)
    item.controller.abort()
    if (item.process?.pid) {
      item.process.kill()
      if (process.platform === 'win32')
        spawn('taskkill.exe', ['/PID', String(item.process.pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        })
    }
    if (queued) this.finishCancelled(item)
    return true
  }

  shutdown() {
    for (const item of this.jobs.values()) this.cancel(item.job.jobId)
  }

  async cancelAllAndDrain() {
    this.shutdown()
    for (let attempt = 0; attempt < 200 && this.hasActiveJobs(); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 25))
  }

  private async execute(item: QueuedImport) {
    let tempDirectory = ''
    let finalPath = ''
    let committed = false
    try {
      this.throwIfCancelled(item)
      this.update(item, 'preparing', null, '미디어 정보를 확인하는 중')
      const outputDirectory = getImportDirectory()
      await mkdir(outputDirectory, { recursive: true })
      tempDirectory = path.join(
        outputDirectory,
        `.pulse-import-${item.job.jobId}`,
      )
      await mkdir(tempDirectory)

      const result =
        item.request.source === 'youtube'
          ? await this.downloadYouTube(item, tempDirectory)
          : await this.downloadDirect(item, tempDirectory)
      this.throwIfCancelled(item)
      this.update(item, 'processing', null, '완료 파일을 확인하는 중')
      const fileStats = await stat(result.filePath)
      if (!fileStats.isFile() || fileStats.size <= 0)
        throw new MediaImportError('processing-failed')
      const extension = path.extname(result.filePath).slice(1).toLowerCase()
      if (!SUPPORTED_EXTENSIONS.has(extension))
        throw new MediaImportError(
          'processing-failed',
          '지원되는 오디오 형식을 받지 못했습니다.',
        )
      finalPath = await this.availableOutputPath(
        outputDirectory,
        result.metadata.title,
        item.job.sourceVideoId,
        extension,
      )
      const cover = result.metadata.thumbnail
        ? await this.fetchCover(
            result.metadata.thumbnail,
            item.controller.signal,
          )
        : undefined

      this.throwIfCancelled(item)
      this.update(item, 'registering', null, '음악 라이브러리에 등록하는 중')
      let registration
      try {
        registration = await registerImportedFile(
          finalPath,
          {
            source: item.request.source,
            sourceUrl: item.job.sourceUrl,
            sourceVideoId: item.job.sourceVideoId,
            title: result.metadata.title,
            artist: result.metadata.artist,
            album: result.metadata.album,
            duration: result.metadata.duration,
            cover,
          },
          result.filePath,
        )
      } catch (error) {
        throw new MediaImportError(
          'registration-failed',
          error instanceof Error ? error.message : undefined,
        )
      }
      committed = true
      if (registration.replacedFilePath)
        await this.removeManagedFile(registration.replacedFilePath).catch(
          (error) => log.warn('Could not remove replaced import', error),
        )
      item.job.trackId = registration.trackId
      this.update(item, 'completed', 100, '가져오기 완료')
      try {
        this.onLibraryChanged()
        this.emit('completed', item.job)
      } catch (error) {
        log.warn('Media import completion notification failed', error)
      }
    } catch (error) {
      if (finalPath && !committed)
        await unlink(finalPath).catch(() => undefined)
      if (item.controller.signal.aborted || this.isCancelledError(error)) {
        this.finishCancelled(item)
      } else {
        const importError =
          error instanceof MediaImportError
            ? error
            : new MediaImportError('processing-failed')
        item.job.errorCode = importError.code
        this.update(item, 'failed', null, importError.message)
        this.emit('failed', item.job)
        log.error('Media import failed', {
          jobId: item.job.jobId,
          code: importError.code,
          error,
        })
      }
    } finally {
      if (tempDirectory)
        await rm(tempDirectory, { recursive: true, force: true }).catch(
          () => undefined,
        )
      item.process = undefined
    }
  }

  private async downloadYouTube(item: QueuedImport, directory: string) {
    const metadataResult = await this.runProcess(
      this.toolPath(),
      [
        '--dump-single-json',
        '--skip-download',
        '--no-playlist',
        '--no-warnings',
        '--',
        item.job.sourceUrl,
      ],
      item,
    )
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(metadataResult.stdout) as Record<string, unknown>
    } catch {
      throw new MediaImportError('metadata-unavailable')
    }
    const title = String(raw.title ?? '').trim()
    if (!title) throw new MediaImportError('metadata-unavailable')
    const metadata: ImportMetadata = {
      id: typeof raw.id === 'string' ? raw.id : undefined,
      title,
      artist:
        typeof raw.artist === 'string'
          ? raw.artist
          : typeof raw.uploader === 'string'
            ? raw.uploader
            : typeof raw.channel === 'string'
              ? raw.channel
              : undefined,
      album: typeof raw.album === 'string' ? raw.album : undefined,
      duration: typeof raw.duration === 'number' ? raw.duration : undefined,
      thumbnail: typeof raw.thumbnail === 'string' ? raw.thumbnail : undefined,
      fileSize:
        typeof raw.filesize === 'number'
          ? raw.filesize
          : typeof raw.filesize_approx === 'number'
            ? raw.filesize_approx
            : undefined,
    }
    item.job.title = title
    await this.ensureDiskSpace(directory, metadata.fileSize)
    this.update(item, 'downloading', 0, '오디오 다운로드 중')
    const output = path.join(directory, 'media.%(ext)s')
    await this.runProcess(
      this.toolPath(),
      [
        '--no-playlist',
        '--no-warnings',
        '--newline',
        '--progress',
        '--progress-template',
        'download:%(progress._percent_str)s',
        '--format',
        'bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio[ext=ogg]',
        '--output',
        output,
        '--',
        item.job.sourceUrl,
      ],
      item,
      (line) => {
        const match = /^(?:download:)?\s*([\d.]+)%/.exec(line.trim())
        if (match)
          this.update(
            item,
            'downloading',
            Number(match[1]),
            '오디오 다운로드 중',
          )
      },
    )
    return { filePath: await this.findDownloadedFile(directory), metadata }
  }

  private async downloadDirect(item: QueuedImport, directory: string) {
    this.update(item, 'downloading', 0, '미디어 다운로드 중')
    const response = await this.fetchDirect(
      item.job.sourceUrl,
      item.controller.signal,
    )
    if (!response.ok || !response.body)
      throw new MediaImportError(
        response.status === 404 ? 'content-unavailable' : 'network-error',
      )
    if (new URL(response.url).protocol !== 'https:')
      throw new MediaImportError('unsupported-url')
    const contentType = response.headers.get('content-type')?.split(';')[0]
    const extension = this.extensionForDirectUrl(response.url, contentType)
    if (!extension) throw new MediaImportError('unsupported-url')
    const total = Number(response.headers.get('content-length')) || undefined
    if (total && total > MAX_MEDIA_BYTES)
      throw new MediaImportError(
        'processing-failed',
        '미디어 파일이 너무 큽니다.',
      )
    await this.ensureDiskSpace(directory, total)
    const filePath = path.join(directory, `media.${extension}`)
    let downloaded = 0
    const stream = Readable.fromWeb(response.body as never)
    const limiter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        downloaded += chunk.length
        if (downloaded > MAX_MEDIA_BYTES) {
          callback(
            new MediaImportError(
              'processing-failed',
              '미디어 파일이 너무 큽니다.',
            ),
          )
          return
        }
        if (total)
          this.update(
            item,
            'downloading',
            Math.min(99, (downloaded / total) * 100),
            '미디어 다운로드 중',
          )
        callback(null, chunk)
      },
    })
    await pipeline(stream, limiter, createWriteStream(filePath), {
      signal: item.controller.signal,
    })
    const title = decodeURIComponent(
      path.basename(new URL(response.url).pathname, `.${extension}`),
    )
    item.job.title = title || '가져온 미디어'
    return { filePath, metadata: { title: item.job.title } as ImportMetadata }
  }

  private normalizeRequest(request: MediaImportRequest) {
    let parsed: URL
    try {
      parsed = new URL(request.url)
    } catch {
      throw new MediaImportError('unsupported-url')
    }
    if (parsed.protocol !== 'https:')
      throw new MediaImportError('unsupported-url')
    if (request.source === 'youtube') {
      const sourceVideoId = extractYouTubeVideoId(parsed.toString())
      if (!sourceVideoId) throw new MediaImportError('unsupported-url')
      return {
        url: `https://www.youtube.com/watch?v=${sourceVideoId}`,
        sourceVideoId,
      }
    }
    parsed.hash = ''
    return { url: parsed.toString(), sourceVideoId: undefined }
  }

  private update(
    item: QueuedImport,
    status: MediaImportJob['status'],
    progress: number | null,
    message: string,
  ) {
    item.job.status = status
    item.job.progress =
      progress === null ? null : Math.max(0, Math.min(100, progress))
    item.job.message = message
    item.job.updatedAt = Date.now()
    this.emit('progress', { ...item.job })
  }

  private finishCancelled(item: QueuedImport) {
    if (item.job.status === 'cancelled') return
    item.job.errorCode = 'cancelled'
    this.update(item, 'cancelled', null, '가져오기를 취소했습니다.')
    this.emit('failed', item.job)
  }

  private throwIfCancelled(item: QueuedImport) {
    if (item.controller.signal.aborted) throw new MediaImportError('cancelled')
  }

  private isCancelledError(error: unknown) {
    return (
      (error instanceof MediaImportError && error.code === 'cancelled') ||
      (error instanceof Error && error.name === 'AbortError')
    )
  }

  private toolPath() {
    const root = app.isPackaged
      ? process.resourcesPath
      : path.join(app.getAppPath(), 'resources')
    return path.join(root, 'bin', 'win32-x64', 'yt-dlp.exe')
  }

  private runProcess(
    executable: string,
    args: string[],
    item?: QueuedImport,
    onLine?: (line: string) => void,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      if (item?.controller.signal.aborted) {
        reject(new MediaImportError('cancelled'))
        return
      }
      const safeArgs =
        executable === this.toolPath()
          ? ['--ignore-config', '--no-plugin-dirs', ...args]
          : args
      const child = spawn(executable, safeArgs, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: app.getPath('temp'),
      })
      if (item) item.process = child
      const abort = () => {
        child.kill()
        if (process.platform === 'win32' && child.pid)
          spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
          })
      }
      item?.controller.signal.addEventListener('abort', abort, { once: true })
      let stdout = ''
      let stderr = ''
      let partial = ''
      const consume = (chunk: Buffer) => {
        if (stdout.length < MAX_TOOL_OUTPUT) stdout += chunk.toString()
        partial += chunk.toString()
        const lines = partial.split(/\r?\n/)
        partial = lines.pop() ?? ''
        lines.forEach((line) => onLine?.(line))
      }
      child.stdout?.on('data', consume)
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_TOOL_OUTPUT) stderr += chunk.toString()
      })
      child.on('error', (error) => reject(error))
      child.on('close', (code) => {
        item?.controller.signal.removeEventListener('abort', abort)
        if (item?.process === child) item.process = undefined
        if (partial) onLine?.(partial)
        if (item?.controller.signal.aborted)
          reject(new MediaImportError('cancelled'))
        else if (code === 0) resolve({ stdout, stderr })
        else reject(classifyToolError(stderr || stdout))
      })
    })
  }

  private async findDownloadedFile(directory: string): Promise<string> {
    const entries = await readdir(directory, { withFileTypes: true })
    const file = entries.find(
      (entry) =>
        entry.isFile() &&
        SUPPORTED_EXTENSIONS.has(
          path.extname(entry.name).slice(1).toLowerCase(),
        ),
    )
    if (!file) throw new MediaImportError('processing-failed')
    return path.join(directory, file.name)
  }

  private async ensureDiskSpace(directory: string, expected?: number) {
    if (!expected) return
    const space = await statfs(directory)
    if (space.bavail * space.bsize < expected * 1.2)
      throw new MediaImportError('insufficient-space')
  }

  private async availableOutputPath(
    directory: string,
    title: string,
    sourceId: string | undefined,
    extension: string,
  ) {
    const printableTitle = [...title]
      .filter((character) => (character.codePointAt(0) ?? 0) >= 32)
      .join('')
    const safeTitle =
      printableTitle
        .replace(/[<>:"/\\|?*]/g, ' ')
        .replace(/[. ]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160) || '가져온 미디어'
    const suffix = sourceId ? ` [${sourceId}]` : ''
    for (let index = 0; index < 10_000; index += 1) {
      const collision = index ? ` (${index + 1})` : ''
      const candidate = path.join(
        directory,
        `${safeTitle}${suffix}${collision}.${extension}`,
      )
      if (!existsSync(candidate)) return candidate
    }
    throw new MediaImportError('output-unavailable')
  }

  private async fetchCover(url: string, signal: AbortSignal) {
    try {
      const response = await fetch(url, { signal })
      if (!response.ok) return undefined
      const type = response.headers.get('content-type')?.toLowerCase()
      const extension: 'png' | 'jpg' | undefined = type?.includes('png')
        ? 'png'
        : type?.includes('jpeg')
          ? 'jpg'
          : undefined
      if (!extension) return undefined
      const length = Number(response.headers.get('content-length'))
      if (length > MAX_COVER_BYTES) return undefined
      const data = new Uint8Array(await response.arrayBuffer())
      return data.byteLength <= MAX_COVER_BYTES
        ? { data, extension }
        : undefined
    } catch {
      return undefined
    }
  }

  private extensionForDirectUrl(url: string, contentType?: string) {
    const byType: Record<string, string> = {
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'audio/x-m4a': 'm4a',
      'audio/ogg': 'ogg',
      'audio/flac': 'flac',
      'audio/wav': 'wav',
      'audio/x-wav': 'wav',
    }
    if (contentType && byType[contentType]) return byType[contentType]
    const extension = path.extname(new URL(url).pathname).slice(1).toLowerCase()
    return SUPPORTED_EXTENSIONS.has(extension) ? extension : undefined
  }

  private async removeManagedFile(filePath: string) {
    const root = path.resolve(getImportDirectory())
    const resolved = path.resolve(filePath)
    if (resolved.startsWith(`${root}${path.sep}`)) await unlink(resolved)
  }

  private async fetchDirect(
    url: string,
    signal: AbortSignal,
  ): Promise<Response> {
    let current = new URL(url)
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      await this.assertPublicUrl(current)
      let response: Response
      try {
        response = await fetch(current, { signal, redirect: 'manual' })
      } catch (error) {
        if (signal.aborted) throw error
        throw new MediaImportError('network-error')
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      const location = response.headers.get('location')
      if (!location || redirects === 5)
        throw new MediaImportError('network-error', '리디렉션이 너무 많습니다.')
      current = new URL(location, current)
    }
    throw new MediaImportError('network-error')
  }

  private async assertPublicUrl(url: URL) {
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new MediaImportError('unsupported-url')
    const addresses = isIP(url.hostname)
      ? [{ address: url.hostname }]
      : await lookup(url.hostname, { all: true, verbatim: true }).catch(() => {
          throw new MediaImportError('network-error')
        })
    if (
      !addresses.length ||
      addresses.some(({ address }) => this.isPrivateAddress(address))
    )
      throw new MediaImportError('unsupported-url')
  }

  private isPrivateAddress(address: string) {
    const normalized = address.toLowerCase()
    if (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fe80:')
    )
      return true
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
    const parts = normalized.split('.').map(Number)
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part)))
      return false
    return (
      parts[0] === 0 ||
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      parts[0] >= 224
    )
  }
}
