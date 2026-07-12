import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app, dialog } from 'electron'
import { z } from 'zod'
import type {
  PulseShelfSyncPackageV1,
  SyncPackageExportOptions,
  SyncPackageImportPlan,
  SyncPackageInspectResult,
  SyncPackageInspection,
  SyncPackageOperationResult,
  SyncPackageStatus,
  SyncTrackIdentity,
} from '../../src/types/models'
import {
  appDataSchema,
  getStoredData,
  setStoredData,
  setStoredDataWithImportBackup,
  type StoredAppData,
  type StoredTrack,
} from '../data'
import {
  applySyncPackage,
  buildTrackIdentity,
  inspectSyncPackage,
  portableRecord,
  primaryIdentityKey,
  SYNC_PACKAGE_MAX_BYTES,
  syncPackageSchema,
} from '../syncPackageCore'

const exportOptionsSchema = z
  .object({
    lyrics: z.boolean(),
    playlists: z.boolean(),
    likes: z.boolean(),
    metadataOverrides: z.boolean(),
  })
  .strict()
const importPlanSchema = z
  .object({
    token: z.string().uuid(),
    tracks: z.array(
      z
        .object({
          recordId: z.string().uuid(),
          localTrackId: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          conflicts: z
            .record(
              z.enum([
                'lyrics',
                'lyricsSyncProfile',
                'generatedLyricsTimeline',
                'metadata',
              ]),
              z.enum(['local', 'imported']),
            )
            .optional(),
        })
        .strict(),
    ),
    likesMode: z.enum(['union', 'replace']),
    playlistMode: z.enum(['newer', 'local', 'imported']),
  })
  .strict()

interface HashCacheItem {
  filePath: string
  size: number
  mtimeMs: number
  sha256: string
}

interface SyncLocalState {
  deviceId: string
  hashes: HashCacheItem[]
}

interface PendingInspection {
  packageValue: PulseShelfSyncPackageV1
  inspection: SyncPackageInspection
}

const localStateSchema = z.object({
  deviceId: z.string().uuid(),
  hashes: z.array(
    z.object({
      filePath: z.string(),
      size: z.number().int().nonnegative(),
      mtimeMs: z.number().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
})

export class SyncPackageService {
  private status: SyncPackageStatus = { busy: false }
  private pending = new Map<string, PendingInspection>()

  getStatus(): SyncPackageStatus {
    return { ...this.status }
  }

  async exportPackage(value: unknown): Promise<SyncPackageOperationResult> {
    const options = exportOptionsSchema.safeParse(value)
    if (!options.success) return failure('내보내기 옵션이 올바르지 않습니다.')
    if (!this.begin('export'))
      return failure('다른 동기화 패키지 작업이 진행 중입니다.')
    try {
      const data = ensurePlaylistSyncIds(getStoredData())
      const localState = await this.loadLocalState()
      const identities = await this.buildIdentities(data, localState)
      const packageValue = buildPackage(
        data,
        identities,
        options.data,
        localState.deviceId,
      )
      const validated = syncPackageSchema.safeParse(packageValue)
      if (!validated.success)
        return failure('내보낼 데이터의 패키지 검증에 실패했습니다.')
      const json = JSON.stringify(validated.data, null, 2)
      if (Buffer.byteLength(json, 'utf8') > SYNC_PACKAGE_MAX_BYTES)
        return failure('동기화 패키지는 20MB를 초과할 수 없습니다.')
      const dialogResult = await dialog.showSaveDialog({
        title: 'Pulse Shelf 동기화 패키지 내보내기',
        defaultPath: `PulseShelfSync-${fileTimestamp(new Date())}.pssync`,
        filters: [
          { name: 'Pulse Shelf 동기화 패키지', extensions: ['pssync'] },
        ],
      })
      if (dialogResult.canceled || !dialogResult.filePath) return cancelled()
      const staging = `${dialogResult.filePath}.${randomUUID()}.tmp`
      try {
        await writeFile(staging, json, { encoding: 'utf8', flag: 'wx' })
        await rename(staging, dialogResult.filePath)
      } catch (error) {
        await rm(staging, { force: true }).catch(() => undefined)
        throw error
      }
      return {
        success: true,
        cancelled: false,
        message: `${validated.data.tracks.length}곡과 ${validated.data.playlists.length}개 플레이리스트를 내보냈습니다.`,
        summary: {
          matchedTracks: validated.data.tracks.length,
          skippedTracks: 0,
          lyrics: validated.data.tracks.filter((item) => item.lyrics).length,
          likes: validated.data.tracks.filter(
            (item) => item.liked !== undefined,
          ).length,
          playlists: validated.data.playlists.length,
          conflicts: 0,
        },
      }
    } catch {
      return failure('동기화 패키지를 내보내지 못했습니다.')
    } finally {
      this.end()
    }
  }

  async inspectPackage(): Promise<SyncPackageInspectResult> {
    if (!this.begin('inspect'))
      return { ...failure('다른 동기화 패키지 작업이 진행 중입니다.') }
    try {
      const dialogResult = await dialog.showOpenDialog({
        title: 'Pulse Shelf 동기화 패키지 가져오기',
        properties: ['openFile'],
        filters: [
          { name: 'Pulse Shelf 동기화 패키지', extensions: ['pssync'] },
        ],
      })
      if (dialogResult.canceled || !dialogResult.filePaths[0])
        return cancelled()
      const filePath = dialogResult.filePaths[0]
      const fileStat = await stat(filePath)
      if (fileStat.size > SYNC_PACKAGE_MAX_BYTES)
        return failure('동기화 패키지는 20MB를 초과할 수 없습니다.')
      let parsed: unknown
      try {
        parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown
      } catch {
        return failure('파일이 손상되었거나 올바른 JSON 패키지가 아닙니다.')
      }
      if (
        parsed &&
        typeof parsed === 'object' &&
        'schemaVersion' in parsed &&
        (parsed as { schemaVersion?: unknown }).schemaVersion !== 1
      )
        return failure('지원하지 않는 동기화 패키지 버전입니다.')
      const validated = syncPackageSchema.safeParse(parsed)
      if (!validated.success)
        return failure('동기화 패키지 형식 또는 항목 검증에 실패했습니다.')
      const data = getStoredData()
      const localState = await this.loadLocalState()
      const identities = await this.buildIdentities(data, localState)
      const token = randomUUID()
      const inspection = inspectSyncPackage(
        validated.data,
        data,
        identities,
        token,
        path.basename(filePath),
      )
      this.pending.clear()
      this.pending.set(token, { packageValue: validated.data, inspection })
      return {
        success: true,
        cancelled: false,
        message: '적용 전 미리보기를 만들었습니다.',
        inspection,
      }
    } catch {
      return failure('동기화 패키지를 검사하지 못했습니다.')
    } finally {
      this.end()
    }
  }

  async importPackage(value: unknown): Promise<SyncPackageOperationResult> {
    const plan = importPlanSchema.safeParse(value)
    if (!plan.success) return failure('가져오기 선택 내용이 올바르지 않습니다.')
    if (!this.begin('import'))
      return failure('다른 동기화 패키지 작업이 진행 중입니다.')
    try {
      const pending = this.pending.get(plan.data.token)
      if (!pending)
        return failure(
          '가져오기 미리보기가 만료되었습니다. 파일을 다시 선택해 주세요.',
        )
      const current = getStoredData()
      const merged = applySyncPackage(
        current,
        pending.packageValue,
        pending.inspection,
        plan.data as SyncPackageImportPlan,
      )
      const publicValidation = appDataSchema.safeParse(
        stripStoredData(merged.data),
      )
      if (!publicValidation.success)
        return failure('병합 결과가 현재 앱 데이터 스키마와 맞지 않습니다.')
      const saved = await setStoredDataWithImportBackup(merged.data)
      this.pending.delete(plan.data.token)
      return {
        success: true,
        cancelled: false,
        message: `${merged.summary.matchedTracks}곡의 동기화 데이터를 적용했습니다.`,
        data: stripStoredData(saved.data),
        summary: merged.summary,
      }
    } catch {
      return failure(
        '동기화 패키지를 적용하지 못했습니다. 기존 데이터는 유지되었습니다.',
      )
    } finally {
      this.end()
    }
  }

  private begin(
    operation: NonNullable<SyncPackageStatus['operation']>,
  ): boolean {
    if (this.status.busy) return false
    this.status = { busy: true, operation }
    return true
  }

  private end() {
    this.status = { busy: false }
  }

  private async buildIdentities(
    data: StoredAppData,
    localState: SyncLocalState,
  ): Promise<Map<string, SyncTrackIdentity>> {
    const result = new Map<string, SyncTrackIdentity>()
    for (const track of data.tracks) {
      const lyrics = data.lyrics[track.id]
      const fileSha256 = track.sourceVideoId
        ? undefined
        : await this.hashTrack(track, localState)
      result.set(track.id, buildTrackIdentity(track, fileSha256, lyrics))
    }
    await this.saveLocalState(localState)
    return result
  }

  private async hashTrack(
    track: StoredTrack,
    state: SyncLocalState,
  ): Promise<string | undefined> {
    try {
      const fileStat = await stat(track.filePath)
      const cached = state.hashes.find(
        (item) =>
          item.filePath === track.filePath &&
          item.size === fileStat.size &&
          item.mtimeMs === fileStat.mtimeMs,
      )
      if (cached) return cached.sha256
      const sha256 = await streamSha256(track.filePath)
      state.hashes = state.hashes.filter(
        (item) => item.filePath !== track.filePath,
      )
      state.hashes.push({
        filePath: track.filePath,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        sha256,
      })
      return sha256
    } catch {
      return undefined
    }
  }

  private async loadLocalState(): Promise<SyncLocalState> {
    try {
      const parsed = localStateSchema.safeParse(
        JSON.parse(await readFile(this.localStatePath(), 'utf8')) as unknown,
      )
      if (parsed.success) return parsed.data
    } catch {
      // First run or damaged cache: create a fresh device identity and hash cache.
    }
    return { deviceId: randomUUID(), hashes: [] }
  }

  private async saveLocalState(state: SyncLocalState) {
    const target = this.localStatePath()
    const staging = `${target}.${randomUUID()}.tmp`
    const json = JSON.stringify(state)
    await writeFile(staging, json, 'utf8')
    try {
      await rename(staging, target)
    } catch {
      await writeFile(target, json, 'utf8')
      await rm(staging, { force: true })
    }
  }

  private localStatePath() {
    return path.join(app.getPath('userData'), 'sync-package-state.json')
  }
}

function ensurePlaylistSyncIds(data: StoredAppData): StoredAppData {
  if (data.playlists.every((playlist) => playlist.syncId)) return data
  const next = {
    ...data,
    playlists: data.playlists.map((playlist) => ({
      ...playlist,
      syncId: playlist.syncId ?? randomUUID(),
    })),
  }
  return setStoredData(next)
}

function buildPackage(
  data: StoredAppData,
  identities: Map<string, SyncTrackIdentity>,
  options: SyncPackageExportOptions,
  deviceId: string,
): PulseShelfSyncPackageV1 {
  const recordIds = new Map(
    data.tracks.map((track) => [track.id, randomUUID()]),
  )
  const tracks = data.tracks.map((track) =>
    portableRecord(
      track,
      identities.get(track.id) ?? buildTrackIdentity(track),
      data,
      options,
      recordIds.get(track.id) as string,
    ),
  )
  const playlists = options.playlists
    ? data.playlists.map((playlist) => ({
        syncId: playlist.syncId as string,
        name: playlist.name,
        tracks: playlist.trackIds.flatMap((trackId) => {
          const identity = identities.get(trackId)
          return identity ? [identity] : []
        }),
        createdAt: playlist.createdAt,
        updatedAt: playlist.updatedAt,
        coverTrack: playlist.coverTrackId
          ? identities.get(playlist.coverTrackId)
          : undefined,
      }))
    : []
  return {
    schemaVersion: 1,
    appVersion: app.getVersion(),
    exportedAt: Date.now(),
    deviceId,
    tracks,
    playlists,
    exportOptions: options,
  }
}

function stripStoredData(data: StoredAppData) {
  const publicData = {
    ...data,
    tracks: data.tracks.map(({ filePath, ...track }) => {
      void filePath
      return track
    }),
    libraryExclusions: data.libraryExclusions.map(
      ({ id, filePathHash, excludedAt }) => ({ id, filePathHash, excludedAt }),
    ),
  }
  return publicData
}

async function streamSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function fileTimestamp(date: Date): string {
  const part = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`
}

function failure(message: string): SyncPackageOperationResult {
  return { success: false, cancelled: false, message }
}

function cancelled(): SyncPackageOperationResult {
  return { success: false, cancelled: true, message: '' }
}

export function hasStableIdentity(identity: SyncTrackIdentity): boolean {
  return Boolean(primaryIdentityKey(identity))
}
