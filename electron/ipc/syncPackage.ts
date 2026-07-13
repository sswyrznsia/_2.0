import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { app, dialog, shell } from 'electron'
import { z } from 'zod'
import {
  CONFLICT_IMPORT_ACTIONS,
  EXISTING_FILE_ACTIONS,
  LIKED_IMPORT_ACTIONS,
  MEDIA_IMPORT_ACTIONS,
  normalizeSyncImportPlanInput,
  PLAYLIST_IMPORT_ACTIONS,
} from '../../src/types/syncImportDecisions'
import type {
  AppData,
  PulseShelfSyncPackage,
  PulseShelfSyncPackageV1,
  PulseShelfSyncPackageV2,
  SyncArtworkDescriptor,
  SyncConflictKind,
  SyncMediaDescriptor,
  SyncPackageEstimate,
  SyncPackageExportOptions,
  SyncImportValidationIssue,
  SyncImportTrackChoice,
  SyncPackageImportPlan,
  SyncPackageInspectResult,
  SyncPackageInspection,
  SyncPackageOperationResult,
  SyncPackageStatus,
  SyncTrackIdentity,
  SyncTrackRecordV2,
} from '../../src/types/models'
import {
  appDataSchema,
  createPreImportBackup,
  getStoredData,
  registerTrackIdReplacement,
  setStoredData,
  setStoredDataWithImportBackup,
  type StoredAppData,
  type StoredTrack,
} from '../data'
import { withLibraryMutation } from './library'
import {
  extractVerifiedEntries,
  matchesAudioSignature,
  openSyncArchive,
  writeSyncArchive,
  type OpenedSyncArchive,
  type SyncArchiveSource,
} from '../syncArchive'
import {
  applySyncPackage,
  buildTrackIdentity,
  inspectSyncPackage,
  portableRecord,
  primaryIdentityKey,
  SYNC_PACKAGE_MAX_BYTES,
  SYNC_PACKAGE_MEDIA_MAX_BYTES,
  SYNC_PACKAGE_V2_MAX_BYTES,
  syncPackageV1Schema,
  syncPackageV2Schema,
} from '../syncPackageCore'

const SUPPORTED_MEDIA = new Set([
  'mp3',
  'flac',
  'wav',
  'm4a',
  'aac',
  'ogg',
  'opus',
])
const MIME_BY_EXTENSION: Record<string, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
}
const DISK_SAFETY_BYTES = 64 * 1024 * 1024

const exportOptionsSchema = z
  .object({
    lyrics: z.boolean(),
    playlists: z.boolean(),
    likes: z.boolean(),
    metadataOverrides: z.boolean(),
    mediaFiles: z.boolean(),
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
            .partialRecord(
              z.enum([
                'lyrics',
                'lyricsSyncProfile',
                'generatedLyricsTimeline',
                'metadata',
              ]),
              z.enum(CONFLICT_IMPORT_ACTIONS),
            )
            .optional(),
          mediaAction: z.enum(MEDIA_IMPORT_ACTIONS).optional(),
          existingFileAction: z.enum(EXISTING_FILE_ACTIONS).optional(),
        })
        .strict(),
    ),
    likesMode: z.enum(LIKED_IMPORT_ACTIONS),
    playlistMode: z.enum(PLAYLIST_IMPORT_ACTIONS),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>()
    for (const [index, choice] of value.tracks.entries()) {
      if (seen.has(choice.recordId))
        context.addIssue({
          code: 'custom',
          path: ['tracks', index, 'recordId'],
          message: '중복된 가져오기 선택입니다.',
        })
      seen.add(choice.recordId)
    }
  })

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
  packageValue: PulseShelfSyncPackage
  inspection: SyncPackageInspection
  archive?: OpenedSyncArchive
}

interface ValidatedImportPlan {
  plan?: SyncPackageImportPlan
  issues: SyncImportValidationIssue[]
}

export function parseSyncImportPlan(value: unknown) {
  const normalizedValue = normalizeSyncImportPlanInput(value)
  return {
    normalizedValue,
    result: importPlanSchema.safeParse(normalizedValue),
  }
}

export interface SyncImportRuntimeContext {
  currentTrackId?: string
  currentTrackPlaying?: boolean
  stopCurrentTrack?: () => Promise<void>
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

  async estimatePackage(value: unknown): Promise<SyncPackageEstimate> {
    const options = exportOptionsSchema.parse(value)
    const data = getStoredData()
    let mediaFiles = 0
    let mediaBytes = 0
    let excludedMedia = 0
    if (options.mediaFiles) {
      for (const track of data.tracks) {
        try {
          const extension = path.extname(track.filePath).slice(1).toLowerCase()
          const fileStat = await stat(track.filePath)
          if (
            !fileStat.isFile() ||
            !SUPPORTED_MEDIA.has(extension) ||
            fileStat.size <= 0 ||
            fileStat.size > SYNC_PACKAGE_MEDIA_MAX_BYTES
          ) {
            excludedMedia += 1
            continue
          }
          mediaFiles += 1
          mediaBytes += fileStat.size
        } catch {
          excludedMedia += 1
        }
      }
    }
    return {
      totalTracks: data.tracks.length,
      mediaFiles,
      mediaBytes,
      excludedMedia,
      exceedsLimit: mediaBytes > SYNC_PACKAGE_V2_MAX_BYTES,
    }
  }

  async exportPackage(
    value: unknown,
    targetPath?: string,
  ): Promise<SyncPackageOperationResult> {
    const options = exportOptionsSchema.safeParse(value)
    if (!options.success) return failure('내보내기 옵션이 올바르지 않습니다.')
    if (!this.begin('export'))
      return failure('다른 동기화 패키지 작업이 진행 중입니다.')
    try {
      const data = ensurePlaylistSyncIds(getStoredData())
      const localState = await this.loadLocalState()
      const identities = await this.buildIdentities(
        data,
        localState,
        options.data.mediaFiles,
      )
      let outputPath = targetPath
      if (!outputPath) {
        const dialogResult = await dialog.showSaveDialog({
          title: 'Pulse Shelf 동기화 패키지 내보내기',
          defaultPath: `PulseShelfSync-${fileTimestamp(new Date())}.pssync`,
          filters: [
            { name: 'Pulse Shelf 동기화 패키지', extensions: ['pssync'] },
          ],
        })
        if (dialogResult.canceled || !dialogResult.filePath) return cancelled()
        outputPath = dialogResult.filePath
      }

      if (!options.data.mediaFiles) {
        const packageValue = buildV1Package(
          data,
          identities,
          options.data,
          localState.deviceId,
        )
        const validated = syncPackageV1Schema.safeParse(packageValue)
        if (!validated.success)
          return failure('내보낼 v1 패키지 검증에 실패했습니다.')
        const json = JSON.stringify(validated.data, null, 2)
        if (Buffer.byteLength(json, 'utf8') > SYNC_PACKAGE_MAX_BYTES)
          return failure('metadata-only 패키지는 20MB를 초과할 수 없습니다.')
        await atomicWriteText(outputPath, json)
        return exportResult(validated.data, 0, 0)
      }

      const built = await this.buildV2Package(
        data,
        identities,
        options.data,
        localState.deviceId,
        localState,
      )
      if (built.mediaBytes > SYNC_PACKAGE_V2_MAX_BYTES)
        return failure('음악 파일 총 용량은 20GB를 초과할 수 없습니다.')
      if (!(await hasDiskSpace(path.dirname(outputPath), built.mediaBytes)))
        return failure('동기화 패키지를 저장할 디스크 여유 공간이 부족합니다.')
      const validated = syncPackageV2Schema.safeParse(built.packageValue)
      if (!validated.success)
        return failure('내보낼 v2 manifest 검증에 실패했습니다.')
      const staging = `${outputPath}.${randomUUID()}.tmp`
      try {
        await writeSyncArchive(staging, validated.data, built.sources)
        await rename(staging, outputPath)
      } catch (error) {
        await rm(staging, { force: true }).catch(() => undefined)
        throw error
      }
      return exportResult(validated.data, built.mediaFiles, built.mediaBytes)
    } catch (error) {
      return failure(safeError(error, '동기화 패키지를 내보내지 못했습니다.'))
    } finally {
      this.end()
    }
  }

  async inspectPackage(sourcePath?: string): Promise<SyncPackageInspectResult> {
    if (!this.begin('inspect'))
      return { ...failure('다른 동기화 패키지 작업이 진행 중입니다.') }
    try {
      let filePath = sourcePath
      if (!filePath) {
        const dialogResult = await dialog.showOpenDialog({
          title: 'Pulse Shelf 동기화 패키지 가져오기',
          properties: ['openFile'],
          filters: [
            { name: 'Pulse Shelf 동기화 패키지', extensions: ['pssync'] },
          ],
        })
        if (dialogResult.canceled || !dialogResult.filePaths[0])
          return cancelled()
        filePath = dialogResult.filePaths[0]
      }
      const isZip = await hasZipSignature(filePath)
      let packageValue: PulseShelfSyncPackage
      let archive: OpenedSyncArchive | undefined
      if (isZip) {
        archive = await openSyncArchive(filePath)
        packageValue = archive.manifest
      } else {
        const fileStat = await stat(filePath)
        if (fileStat.size > SYNC_PACKAGE_MAX_BYTES)
          return failure('metadata-only 패키지는 20MB를 초과할 수 없습니다.')
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
        const validated = syncPackageV1Schema.safeParse(parsed)
        if (!validated.success)
          return failure('v1 동기화 패키지 검증에 실패했습니다.')
        packageValue = validated.data
      }

      const data = getStoredData()
      const localState = await this.loadLocalState()
      const identities = await this.buildIdentities(
        data,
        localState,
        packageValue.schemaVersion === 2,
      )
      const token = randomUUID()
      const inspection = inspectSyncPackage(
        packageValue,
        data,
        identities,
        token,
        path.basename(filePath),
      )
      this.pending.clear()
      this.pending.set(token, { packageValue, inspection, archive })
      return {
        success: true,
        cancelled: false,
        message: '적용 전 미리보기를 만들었습니다.',
        inspection,
      }
    } catch (error) {
      return failure(safeError(error, '동기화 패키지를 검사하지 못했습니다.'))
    } finally {
      this.end()
    }
  }

  async importPackage(
    value: unknown,
    runtime: SyncImportRuntimeContext = {},
  ): Promise<SyncPackageOperationResult> {
    this.logImportPayload(value)
    const { normalizedValue, result: plan } = parseSyncImportPlan(value)
    if (!plan.success) {
      const issues = plan.error.issues.map((issue) => ({
        recordId: recordIdAtPath(normalizedValue, issue.path),
        field: issue.path.join('.') || 'plan',
        message: schemaIssueMessage(issue.path),
        value: schemaIssueValue(issue),
      }))
      logSchemaValidation(plan.error.issues, normalizedValue)
      this.logImportValidation('schema-rejected', undefined, issues)
      return invalidPlan(issues)
    }
    if (!this.begin('import'))
      return failure('다른 동기화 패키지 작업이 진행 중입니다.')
    try {
      const pending = this.pending.get(plan.data.token)
      if (!pending) {
        this.logImportValidation('stale-preview', plan.data.token, [
          {
            field: 'token',
            message: '미리보기 정보가 오래되었습니다. 패키지를 다시 검사하세요.',
          },
        ])
        return stalePreview()
      }
      const validated = validateImportPlan(
        plan.data as SyncPackageImportPlan,
        pending.inspection,
      )
      if (!validated.plan) {
        this.logImportValidation(
          'plan-rejected',
          plan.data.token,
          validated.issues,
        )
        return invalidPlan(validated.issues)
      }
      const selectedPlan = validated.plan
      const result =
        pending.packageValue.schemaVersion === 2
          ? await withLibraryMutation(() =>
              this.importV2(
                pending,
                selectedPlan,
                runtime,
              ),
            )
          : await this.importV1(pending, selectedPlan)
      if (result.success) this.pending.delete(plan.data.token)
      return result
    } catch (error) {
      return failure(
        safeError(
          error,
          '동기화 패키지를 적용하지 못했습니다. 기존 데이터와 파일은 유지되었습니다.',
        ),
      )
    } finally {
      this.end()
    }
  }

  private logImportPayload(value: unknown) {
    if (!isDevelopmentTraceEnabled() || !value || typeof value !== 'object')
      return
    const payload = value as { token?: unknown; tracks?: unknown }
    const tracks = Array.isArray(payload.tracks)
      ? payload.tracks
          .filter((track): track is Record<string, unknown> =>
            Boolean(track && typeof track === 'object'),
          )
          .map((track) => ({
            recordId: typeof track.recordId === 'string' ? track.recordId : '',
            mediaAction:
              typeof track.mediaAction === 'string' ? track.mediaAction : '',
            conflictResolution:
              track.conflicts && typeof track.conflicts === 'object'
                ? Object.fromEntries(
                    Object.entries(track.conflicts as Record<string, unknown>)
                      .filter(([, conflictValue]) =>
                        typeof conflictValue === 'string',
                      )
                      .map(([kind, conflictValue]) => [
                        kind,
                        conflictValue,
                      ]),
                  )
                : [],
          }))
      : []
    console.debug('[sync-package] import payload', {
      previewId: typeof payload.token === 'string' ? payload.token : '',
      tracks,
    })
  }

  private logImportValidation(
    stage: string,
    previewId: string | undefined,
    issues: SyncImportValidationIssue[],
  ) {
    if (!isDevelopmentTraceEnabled()) return
    console.debug('[sync-package] import validation', {
      stage,
      previewId: previewId ?? '',
      rejected: issues.map(({ recordId, field, value }) => ({
        recordId,
        field,
        value,
      })),
    })
  }

  private async importV1(
    pending: PendingInspection,
    plan: SyncPackageImportPlan,
  ): Promise<SyncPackageOperationResult> {
    const current = getStoredData()
    const merged = applySyncPackage(
      current,
      pending.packageValue,
      pending.inspection,
      plan,
    )
    if (!appDataSchema.safeParse(stripStoredData(merged.data)).success)
      return failure('병합 결과가 현재 앱 데이터 스키마와 맞지 않습니다.')
    const saved = await setStoredDataWithImportBackup(merged.data)
    const unchanged = JSON.stringify(current) === JSON.stringify(merged.data)
    return {
      success: true,
      cancelled: false,
      message: unchanged
        ? '적용할 새로운 데이터가 없습니다.'
        : `${merged.summary.matchedTracks}곡의 동기화 데이터를 적용했습니다.`,
      data: stripStoredData(saved.data),
      summary: {
        ...merged.summary,
        unchangedItems: unchanged ? pending.packageValue.tracks.length : 0,
        warnings: [],
      },
    }
  }

  private async importV2(
    pending: PendingInspection,
    plan: SyncPackageImportPlan,
    runtime: SyncImportRuntimeContext,
  ): Promise<SyncPackageOperationResult> {
    if (!pending.archive || pending.packageValue.schemaVersion !== 2)
      return failure('v2 archive 미리보기 정보가 없습니다.')
    const records = new Map(
      pending.packageValue.tracks.map((record) => [record.recordId, record]),
    )
    const previews = new Map(
      pending.inspection.tracks.map((preview) => [preview.recordId, preview]),
    )
    const selected = plan.tracks.filter((choice) => {
      const record = records.get(choice.recordId)
      return Boolean(
        record?.media &&
        (choice.mediaAction === 'create' || choice.mediaAction === 'replace'),
      )
    })
    const descriptors = selected.flatMap((choice) => {
      const record = records.get(choice.recordId)
      return record?.media
        ? [record.media, ...(record.artwork ? [record.artwork] : [])]
        : []
    })
    const mediaBytes = selected.reduce(
      (sum, choice) => sum + (records.get(choice.recordId)?.media?.size ?? 0),
      0,
    )
    const syncedMedia = path.join(app.getPath('userData'), 'synced-media')
    if (!(await hasDiskSpace(syncedMedia, mediaBytes)))
      return failure('가져온 음악 파일을 저장할 디스크 여유 공간이 부족합니다.')
    const staging = path.join(syncedMedia, `.sync-stage-${plan.token}`)
    await rm(staging, { recursive: true, force: true })
    const extracted = descriptors.length
      ? await extractVerifiedEntries(pending.archive, descriptors, staging)
      : new Map<string, string>()

    const replacingCurrent = selected.some((choice) => {
      if (choice.mediaAction !== 'replace') return false
      const preview = previews.get(choice.recordId)
      const localTrackId =
        preview?.matchKind === 'exact'
          ? preview.localTrackId
          : choice.localTrackId
      return localTrackId === runtime.currentTrackId
    })
    if (
      replacingCurrent &&
      runtime.currentTrackPlaying &&
      runtime.stopCurrentTrack
    )
      await runtime.stopCurrentTrack()

    const backupPath = await createPreImportBackup()
    const movedFiles: string[] = []
    const oldFilesToTrash: string[] = []
    const idReplacements: Array<[string, string]> = []
    const warnings: string[] = []
    let working = getStoredData()
    let createdTracks = 0
    let replacedMedia = 0
    let keptLocalMedia = 0
    let dataCommitted = false
    const beforeImport = getStoredData()
    const effectiveInspection = structuredClone(pending.inspection)
    const effectivePlan = structuredClone(plan)
    try {
      await mkdir(syncedMedia, { recursive: true })
      for (const choice of effectivePlan.tracks) {
        const record = records.get(choice.recordId)
        const preview = effectiveInspection.tracks.find(
          (item) => item.recordId === choice.recordId,
        )
        if (!record || !preview) continue
        if (choice.mediaAction === 'keep') keptLocalMedia += 1
        if (
          !record.media ||
          (choice.mediaAction !== 'create' && choice.mediaAction !== 'replace')
        )
          continue
        const extractedMedia = extracted.get(record.media.archivePath)
        if (!extractedMedia)
          throw new Error('검증된 media staging 파일이 없습니다.')
        const finalPath = await availableSyncedMediaPath(syncedMedia, record)
        await rename(extractedMedia, finalPath)
        movedFiles.push(finalPath)
        const fileStat = await stat(finalPath)
        const existingId =
          preview.matchKind === 'exact'
            ? preview.localTrackId
            : choice.localTrackId
        const existing = existingId
          ? working.tracks.find((track) => track.id === existingId)
          : undefined
        if (choice.mediaAction === 'replace' && !existing)
          throw new Error('교체할 로컬 Track을 찾지 못했습니다.')
        const nextTrack = buildImportedTrack(
          record,
          finalPath,
          fileStat,
          existing,
        )
        const duplicate = working.tracks.find(
          (track) => track.id === nextTrack.id && track.id !== existing?.id,
        )
        if (duplicate)
          throw new Error(
            `같은 음악 파일이 이미 등록되어 있습니다: ${duplicate.title}`,
          )
        if (existing) {
          working = replaceTrack(working, existing.id, nextTrack)
          if (existing.id !== nextTrack.id)
            idReplacements.push([existing.id, nextTrack.id])
          if (choice.existingFileAction === 'trash')
            oldFilesToTrash.push(existing.filePath)
          replacedMedia += 1
        } else {
          working.tracks.push(nextTrack)
          working.tracks.sort((left, right) =>
            left.title.localeCompare(right.title, 'ko'),
          )
          createdTracks += 1
        }
        const artwork = record.artwork
          ? extracted.get(record.artwork.archivePath)
          : undefined
        if (artwork && record.artwork) {
          const coverDirectory = path.join(app.getPath('userData'), 'covers')
          await mkdir(coverDirectory, { recursive: true })
          const coverPath = path.join(
            coverDirectory,
            `${nextTrack.id}.${record.artwork.extension}`,
          )
          try {
            await stat(coverPath)
            await rm(artwork, { force: true })
          } catch {
            await rename(artwork, coverPath)
            movedFiles.push(coverPath)
          }
          const index = working.tracks.findIndex(
            (track) => track.id === nextTrack.id,
          )
          working.tracks[index] = {
            ...working.tracks[index],
            coverUrl: `pulse-cover://track/${nextTrack.id}`,
          }
        }
        preview.matchKind = 'exact'
        preview.localTrackId = nextTrack.id
        preview.candidates = []
        choice.localTrackId = nextTrack.id
      }

      const merged = applySyncPackage(
        working,
        pending.packageValue,
        effectiveInspection,
        effectivePlan,
      )
      if (!appDataSchema.safeParse(stripStoredData(merged.data)).success)
        throw new Error('병합 결과가 현재 앱 데이터 스키마와 맞지 않습니다.')
      const saved = await setStoredDataWithImportBackup(merged.data, backupPath)
      dataCommitted = true
      for (const [oldId, newId] of idReplacements)
        registerTrackIdReplacement(oldId, newId)
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      for (const oldFile of oldFilesToTrash) {
        try {
          await shell.trashItem(oldFile)
        } catch {
          warnings.push(
            `${path.basename(oldFile)} 원본 파일을 휴지통으로 이동하지 못했습니다.`,
          )
        }
      }
      const unchangedItems =
        JSON.stringify(beforeImport) === JSON.stringify(merged.data)
          ? pending.packageValue.tracks.length
          : 0
      return {
        success: true,
        cancelled: false,
        message: unchangedItems
          ? '적용할 새로운 데이터가 없습니다.'
          : `가져오기 완료: 새 곡 ${createdTracks}개, 미디어 교체 ${replacedMedia}개`,
        data: stripStoredData(saved.data),
        summary: {
          ...merged.summary,
          createdTracks,
          replacedMedia,
          keptLocalMedia,
          importedTimelines: pending.packageValue.tracks.filter(
            (record) => record.generatedLyricsTimeline,
          ).length,
          updatedMetadata: pending.packageValue.tracks.filter(
            (record) => record.metadata,
          ).length,
          unchangedItems,
          skippedMissingMedia: pending.inspection.tracks.filter(
            (item) => item.matchKind === 'missing' && !item.mediaAvailable,
          ).length,
          warnings,
        },
      }
    } catch (error) {
      if (!dataCommitted)
        for (const moved of movedFiles)
          await rm(moved, { force: true }).catch(() => undefined)
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw error
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
    hashAllFiles = false,
  ): Promise<Map<string, SyncTrackIdentity>> {
    const result = new Map<string, SyncTrackIdentity>()
    for (const track of data.tracks) {
      const lyrics = data.lyrics[track.id]
      const fileSha256 =
        hashAllFiles || !track.sourceVideoId
          ? await this.hashTrack(track, localState)
          : undefined
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

  private async buildV2Package(
    data: StoredAppData,
    identities: Map<string, SyncTrackIdentity>,
    options: SyncPackageExportOptions,
    deviceId: string,
    state: SyncLocalState,
  ): Promise<{
    packageValue: PulseShelfSyncPackageV2
    sources: SyncArchiveSource[]
    mediaFiles: number
    mediaBytes: number
  }> {
    const base = buildBaseRecords(data, identities, options)
    const sources: SyncArchiveSource[] = []
    let mediaFiles = 0
    let mediaBytes = 0
    const tracks: SyncTrackRecordV2[] = []
    for (const track of data.tracks) {
      const record = base.records.get(track.id) as SyncTrackRecordV2
      record.metadata ??= {
        title: track.title,
        artist: track.artist,
        album: track.album,
      }
      try {
        const extension = path.extname(track.filePath).slice(1).toLowerCase()
        const fileStat = await stat(track.filePath)
        if (!SUPPORTED_MEDIA.has(extension)) {
          record.mediaWarning = 'unsupported'
        } else if (!fileStat.isFile() || fileStat.size <= 0) {
          record.mediaWarning = 'missing'
        } else if (fileStat.size > SYNC_PACKAGE_MEDIA_MAX_BYTES) {
          record.mediaWarning = 'too-large'
        } else if (
          !(await matchesAudioSignature(
            track.filePath,
            extension as SyncMediaDescriptor['extension'],
          ))
        ) {
          record.mediaWarning = 'unsupported'
        } else {
          const sha256 =
            identities.get(track.id)?.fileSha256 ??
            (await this.hashTrack(track, state))
          if (!sha256) throw new Error('hash unavailable')
          record.identity.fileSha256 = sha256
          const archivePath = `media/${record.recordId}/original.${extension}`
          record.media = {
            archivePath,
            originalFileName: path.basename(track.filePath),
            extension: extension as SyncMediaDescriptor['extension'],
            size: fileStat.size,
            sha256,
            mimeType: MIME_BY_EXTENSION[extension],
          }
          sources.push({ archivePath, filePath: track.filePath })
          mediaFiles += 1
          mediaBytes += fileStat.size
        }
      } catch {
        record.mediaWarning = 'unreadable'
      }
      const artwork = await findArtwork(track)
      if (artwork) {
        const descriptor: SyncArtworkDescriptor = {
          archivePath: `artwork/${record.recordId}.${artwork.extension}`,
          extension: artwork.extension,
          size: artwork.size,
          sha256: artwork.sha256,
        }
        record.artwork = descriptor
        sources.push({
          archivePath: descriptor.archivePath,
          filePath: artwork.filePath,
        })
      }
      tracks.push(record)
    }
    await this.saveLocalState(state)
    return {
      packageValue: {
        schemaVersion: 2,
        appVersion: app.getVersion(),
        exportedAt: Date.now(),
        deviceId,
        tracks,
        playlists: base.playlists,
        exportOptions: options,
      },
      sources,
      mediaFiles,
      mediaBytes,
    }
  }

  private async loadLocalState(): Promise<SyncLocalState> {
    try {
      const parsed = localStateSchema.safeParse(
        JSON.parse(await readFile(this.localStatePath(), 'utf8')) as unknown,
      )
      if (parsed.success) return parsed.data
    } catch {
      // First run or damaged cache.
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
  return setStoredData({
    ...data,
    playlists: data.playlists.map((playlist) => ({
      ...playlist,
      syncId: playlist.syncId ?? randomUUID(),
    })),
  })
}

function buildBaseRecords(
  data: StoredAppData,
  identities: Map<string, SyncTrackIdentity>,
  options: SyncPackageExportOptions,
) {
  const records = new Map(
    data.tracks.map((track) => [
      track.id,
      portableRecord(
        track,
        identities.get(track.id) ?? buildTrackIdentity(track),
        data,
        options,
        randomUUID(),
      ),
    ]),
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
  return { records, playlists }
}

function buildV1Package(
  data: StoredAppData,
  identities: Map<string, SyncTrackIdentity>,
  options: SyncPackageExportOptions,
  deviceId: string,
): PulseShelfSyncPackageV1 {
  const base = buildBaseRecords(data, identities, options)
  return {
    schemaVersion: 1,
    appVersion: app.getVersion(),
    exportedAt: Date.now(),
    deviceId,
    tracks: [...base.records.values()],
    playlists: base.playlists,
    exportOptions: {
      lyrics: options.lyrics,
      playlists: options.playlists,
      likes: options.likes,
      metadataOverrides: options.metadataOverrides,
    },
  }
}

function buildImportedTrack(
  record: SyncTrackRecordV2,
  filePath: string,
  fileStat: Awaited<ReturnType<typeof stat>>,
  existing?: StoredTrack,
): StoredTrack {
  if (!record.media) throw new Error('media descriptor가 없습니다.')
  const youtubeVideoId = record.identity.youtubeVideoId
  return {
    id: record.media.sha256,
    filePath,
    fileName: path.basename(filePath),
    title:
      record.metadata?.title ??
      existing?.title ??
      record.media.originalFileName,
    artist:
      record.metadata?.artist ?? existing?.artist ?? '알 수 없는 아티스트',
    album: record.metadata?.album ?? existing?.album ?? '알 수 없는 앨범',
    duration:
      record.identity.durationMs !== undefined
        ? record.identity.durationMs / 1_000
        : (existing?.duration ?? 0),
    format: record.media.extension,
    fileSize: Number(fileStat.size),
    modifiedAt: Number(fileStat.mtimeMs),
    addedAt: existing?.addedAt ?? Date.now(),
    trackNumber: existing?.trackNumber,
    discNumber: existing?.discNumber,
    year: existing?.year,
    coverUrl: existing?.coverUrl,
    liked: existing?.liked ?? record.liked ?? false,
    lastPlayedAt: existing?.lastPlayedAt,
    playCount: existing?.playCount ?? 0,
    source: youtubeVideoId ? 'youtube' : existing?.source,
    sourceUrl: youtubeVideoId
      ? `https://www.youtube.com/watch?v=${youtubeVideoId}`
      : existing?.sourceUrl,
    sourceVideoId: youtubeVideoId ?? existing?.sourceVideoId,
  }
}

function replaceTrack(
  data: StoredAppData,
  oldId: string,
  track: StoredTrack,
): StoredAppData {
  const newId = track.id
  const replace = (id: string) => (id === oldId ? newId : id)
  const remapRecord = <T extends { trackId: string }>(
    values: Record<string, T>,
  ): Record<string, T> => {
    const next = { ...values }
    const existing = next[oldId]
    if (existing) {
      delete next[oldId]
      next[newId] = { ...existing, trackId: newId }
    }
    return next
  }
  return {
    ...data,
    tracks: data.tracks
      .filter((item) => item.id !== oldId && item.id !== newId)
      .concat(track),
    playlists: data.playlists.map((playlist) => ({
      ...playlist,
      trackIds: [...new Set(playlist.trackIds.map(replace))],
      coverTrackId: playlist.coverTrackId
        ? replace(playlist.coverTrackId)
        : undefined,
    })),
    recentTrackIds: [...new Set(data.recentTrackIds.map(replace))],
    playerSession: {
      ...data.playerSession,
      queueIds: data.playerSession.queueIds.map(replace),
    },
    lyrics: remapRecord(data.lyrics),
    lyricsSyncProfiles: remapRecord(data.lyricsSyncProfiles),
    generatedLyricsTimelines: remapRecord(data.generatedLyricsTimelines),
  }
}

async function availableSyncedMediaPath(
  directory: string,
  record: SyncTrackRecordV2,
): Promise<string> {
  if (!record.media) throw new Error('media descriptor가 없습니다.')
  const identity = sanitizeFilePart(
    primaryIdentityKey(record.identity) ?? record.recordId,
    80,
  )
  const original = sanitizeFilePart(
    path.basename(
      record.media.originalFileName,
      path.extname(record.media.originalFileName),
    ),
    100,
  )
  const base = `${identity}-${original}`
  for (let index = 0; index < 10_000; index += 1) {
    const suffix = index ? `-${index}` : ''
    const candidate = path.join(
      directory,
      `${base}${suffix}.${record.media.extension}`,
    )
    try {
      await stat(candidate)
    } catch {
      return candidate
    }
  }
  throw new Error('동기화 미디어 파일명을 만들지 못했습니다.')
}

function sanitizeFilePart(value: string, max: number): string {
  const sanitized = value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*]/g, '_')
    .split('')
    .map((character) => (character.charCodeAt(0) < 32 ? '_' : character))
    .join('')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, max)
  return sanitized || 'track'
}

async function findArtwork(
  track: StoredTrack,
): Promise<
  | { filePath: string; extension: 'jpg' | 'png'; size: number; sha256: string }
  | undefined
> {
  if (!track.coverUrl?.startsWith('pulse-cover://track/')) return undefined
  for (const extension of ['jpg', 'png'] as const) {
    const filePath = path.join(
      app.getPath('userData'),
      'covers',
      `${track.id}.${extension}`,
    )
    try {
      const fileStat = await stat(filePath)
      if (
        !fileStat.isFile() ||
        fileStat.size <= 0 ||
        fileStat.size > 15 * 1024 * 1024
      )
        continue
      return {
        filePath,
        extension,
        size: fileStat.size,
        sha256: await streamSha256(filePath),
      }
    } catch {
      // Try the other supported artwork extension.
    }
  }
  return undefined
}

async function hasZipSignature(filePath: string): Promise<boolean> {
  const handle = await open(filePath, 'r')
  try {
    const signature = Buffer.alloc(4)
    const result = await handle.read(signature, 0, 4, 0)
    return (
      result.bytesRead === 4 && signature[0] === 0x50 && signature[1] === 0x4b
    )
  } finally {
    await handle.close()
  }
}

async function hasDiskSpace(
  directory: string,
  requiredBytes: number,
): Promise<boolean> {
  await mkdir(directory, { recursive: true })
  try {
    const info = await statfs(directory)
    return info.bavail * info.bsize >= requiredBytes + DISK_SAFETY_BYTES
  } catch {
    return true
  }
}

async function atomicWriteText(target: string, value: string) {
  const staging = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(staging, value, { encoding: 'utf8', flag: 'wx' })
    await rename(staging, target)
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined)
    throw error
  }
}

function stripStoredData(data: StoredAppData): AppData {
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

function exportResult(
  packageValue: PulseShelfSyncPackage,
  mediaFiles: number,
  mediaBytes: number,
): SyncPackageOperationResult {
  return {
    success: true,
    cancelled: false,
    message: `${packageValue.tracks.length}곡과 ${packageValue.playlists.length}개 플레이리스트를 내보냈습니다.`,
    summary: {
      matchedTracks: packageValue.tracks.length,
      skippedTracks: 0,
      lyrics: packageValue.tracks.filter((item) => item.lyrics).length,
      likes: packageValue.tracks.filter((item) => item.liked !== undefined)
        .length,
      playlists: packageValue.playlists.length,
      conflicts: 0,
      createdTracks: 0,
      replacedMedia: 0,
      keptLocalMedia: mediaFiles,
      unchangedItems: 0,
      skippedMissingMedia: packageValue.tracks.length - mediaFiles,
      warnings: mediaBytes
        ? [`음악 파일 ${mediaFiles}개 · ${mediaBytes} bytes`]
        : [],
    },
  }
}

function safeError(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message) return fallback
  if (
    /[\\/]/.test(error.message) ||
    /\b(?:ENOENT|EPERM|EACCES|stack|traceback)\b/i.test(error.message) ||
    /[A-Za-z]:/.test(error.message)
  )
    return fallback
  return error.message.slice(0, 300)
}

function failure(message: string): SyncPackageOperationResult {
  return { success: false, cancelled: false, message }
}

function invalidPlan(
  validationIssues: SyncImportValidationIssue[],
): SyncPackageOperationResult {
  return {
    success: false,
    cancelled: false,
    code: 'invalid-plan',
    message:
      validationIssues[0]?.message ??
      '가져오기 선택 내용을 확인하세요.',
    validationIssues,
  }
}

function stalePreview(): SyncPackageOperationResult {
  return {
    success: false,
    cancelled: false,
    code: 'stale-preview',
    message: '미리보기 정보가 오래되었습니다. 패키지를 다시 검사하세요.',
    validationIssues: [
      {
        field: 'token',
        message: '미리보기 정보가 오래되었습니다. 패키지를 다시 검사하세요.',
      },
    ],
  }
}

function recordIdAtPath(value: unknown, pathParts: PropertyKey[]): string | undefined {
  if (!value || typeof value !== 'object' || pathParts[0] !== 'tracks')
    return undefined
  const index = pathParts[1]
  if (typeof index !== 'number') return undefined
  const tracks = (value as { tracks?: unknown }).tracks
  if (!Array.isArray(tracks)) return undefined
  const recordId = (tracks[index] as { recordId?: unknown } | undefined)
    ?.recordId
  return typeof recordId === 'string' ? recordId : undefined
}

function schemaIssueValue(issue: { code: string; input?: unknown }): string {
  if (typeof issue.input === 'string') return issue.input.slice(0, 80)
  return issue.code
}

function expectedImportValues(pathParts: PropertyKey[]): readonly string[] | undefined {
  if (pathParts.includes('conflicts')) return CONFLICT_IMPORT_ACTIONS
  switch (pathParts[pathParts.length - 1]) {
    case 'mediaAction':
      return MEDIA_IMPORT_ACTIONS
    case 'existingFileAction':
      return EXISTING_FILE_ACTIONS
    case 'likesMode':
      return LIKED_IMPORT_ACTIONS
    case 'playlistMode':
      return PLAYLIST_IMPORT_ACTIONS
    default:
      return undefined
  }
}

function schemaIssueMessage(pathParts: PropertyKey[]): string {
  if (pathParts.includes('conflicts'))
    return '이 곡의 충돌 처리 방식을 다시 선택해주세요.'
  switch (pathParts[pathParts.length - 1]) {
    case 'mediaAction':
      return '이 곡의 미디어 처리 방식을 다시 선택해주세요.'
    case 'existingFileAction':
      return '기존 파일 처리 방식을 다시 선택해주세요.'
    case 'likesMode':
      return '좋아요 가져오기 방식을 다시 선택해주세요.'
    case 'playlistMode':
      return '재생목록 가져오기 방식을 다시 선택해주세요.'
    default:
      return '가져오기 선택값이 허용된 형식이 아닙니다.'
  }
}

function logSchemaValidation(
  schemaIssues: ReadonlyArray<{
    code: string
    path: PropertyKey[]
    input?: unknown
  }>,
  value: unknown,
) {
  if (!isDevelopmentTraceEnabled()) return
  const previewId =
    value && typeof value === 'object' && typeof (value as { token?: unknown }).token === 'string'
      ? (value as { token: string }).token
      : ''
  console.debug('[sync-package] import schema validation', {
    previewId,
    rejected: schemaIssues.map((issue) => ({
      recordId: recordIdAtPath(value, issue.path),
      field: issue.path.join('.'),
      code: issue.code,
      expected: expectedImportValues(issue.path),
      received: schemaIssueValue(issue),
    })),
  })
}

function isDevelopmentTraceEnabled(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.PULSE_SHELF_UI_TEST === '1'
}

export function validateImportPlan(
  plan: SyncPackageImportPlan,
  inspection: SyncPackageInspection,
): ValidatedImportPlan {
  const issues: SyncImportValidationIssue[] = []
  if (plan.token !== inspection.token) {
    issues.push({
      field: 'token',
      message: '미리보기 정보가 오래되었습니다. 패키지를 다시 검사하세요.',
    })
  }

  const choices = new Map<string, SyncImportTrackChoice>()
  for (const choice of plan.tracks) {
    if (choices.has(choice.recordId)) {
      issues.push({
        recordId: choice.recordId,
        field: 'recordId',
        message: '같은 곡의 가져오기 선택이 두 번 포함되어 있습니다.',
      })
    }
    choices.set(choice.recordId, choice)
  }

  for (const preview of inspection.tracks) {
    const choice = choices.get(preview.recordId)
    if (!choice) {
      issues.push({
        recordId: preview.recordId,
        field: 'recordId',
        message: `${preview.title}의 가져오기 선택이 저장되지 않았습니다.`,
      })
      continue
    }
    if (!choice.mediaAction) {
      issues.push({
        recordId: preview.recordId,
        field: 'mediaAction',
        message: `${preview.title}의 미디어 작업을 선택하세요.`,
      })
    } else if (
      !preview.mediaAvailable &&
      choice.mediaAction !== 'skip'
    ) {
      issues.push({
        recordId: preview.recordId,
        field: 'mediaAction',
        message: `${preview.title}에는 가져올 미디어가 없어 건너뛰기로 설정해야 합니다.`,
        value: choice.mediaAction,
      })
    } else if (
      preview.matchKind === 'missing' &&
      !['create', 'skip'].includes(choice.mediaAction)
    ) {
      issues.push({
        recordId: preview.recordId,
        field: 'mediaAction',
        message: `${preview.title}의 미디어 작업은 새 곡으로 가져오기 또는 건너뛰기여야 합니다.`,
        value: choice.mediaAction,
      })
    } else if (
      choice.mediaAction === 'replace' &&
      !(
        preview.localTrackId ||
        (choice.localTrackId &&
          preview.candidates.some(
            (candidate) => candidate.trackId === choice.localTrackId,
          ))
      )
    ) {
      issues.push({
        recordId: preview.recordId,
        field: 'mediaAction',
        message: `${preview.title}의 미디어 교체 대상 로컬 곡을 선택하세요.`,
      })
    }

    const effectiveConflicts =
      preview.matchKind === 'possible' && choice.localTrackId
        ? (preview.candidates.find(
            (candidate) => candidate.trackId === choice.localTrackId,
          )?.conflicts ?? [])
        : preview.matchKind === 'possible'
          ? []
          : preview.conflicts
    for (const conflict of effectiveConflicts) {
      if (!choice.conflicts?.[conflict.kind]) {
        issues.push({
          recordId: preview.recordId,
          field: `conflicts.${conflict.kind}`,
          message: `${preview.title}의 ${conflictLabelForMessage(conflict.kind)} 충돌 처리 방식을 선택하세요.`,
        })
      }
    }
  }
  for (const choice of plan.tracks) {
    if (!inspection.tracks.some((item) => item.recordId === choice.recordId)) {
      issues.push({
        recordId: choice.recordId,
        field: 'recordId',
        message: '미리보기에 없는 곡 선택이 포함되어 있습니다. 패키지를 다시 검사하세요.',
      })
    }
  }
  return issues.length ? { issues } : { plan, issues: [] }
}

function conflictLabelForMessage(kind: SyncConflictKind): string {
  return {
    lyrics: '가사',
    lyricsSyncProfile: 'LyricsSyncProfile',
    generatedLyricsTimeline: 'GeneratedLyricsTimeline',
    metadata: '메타데이터',
  }[kind]
}

function cancelled(): SyncPackageOperationResult {
  return { success: false, cancelled: true, message: '' }
}
