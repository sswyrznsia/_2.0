import { z } from 'zod'
import type { AutoSyncStage } from '../../src/types/models'

export const AUTO_SYNC_STAGES: AutoSyncStage[] = [
  'preparing',
  'separating',
  'releasing-separator',
  'transcribing',
  'matching',
  'building-anchors',
  'validating',
]

const stageSchema = z.enum(AUTO_SYNC_STAGES)

const stageEventSchema = z.object({
  event: z.literal('stage'),
  stage: stageSchema,
  message: z.string().max(500).optional(),
  model: z.string().max(200).optional(),
  cacheHit: z.boolean().optional(),
  overallProgress: z.number().finite().min(0).max(1).optional(),
  indeterminate: z.boolean().optional(),
})

const progressEventSchema = z.object({
  event: z.literal('progress'),
  stage: stageSchema,
  progress: z.number().finite().min(0).max(1),
  message: z.string().max(500).optional(),
  cacheHit: z.boolean().optional(),
  overallProgress: z.number().finite().min(0).max(1).optional(),
  indeterminate: z.boolean().optional(),
})

const completedEventSchema = z.object({
  event: z.literal('completed'),
  resultPath: z.string().max(32_767).optional(),
})

const failedEventSchema = z.object({
  event: z.literal('failed'),
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(1_000),
})

const workerEventSchema = z.discriminatedUnion('event', [
  stageEventSchema,
  progressEventSchema,
  completedEventSchema,
  failedEventSchema,
])

export type AutoSyncWorkerEvent = z.infer<typeof workerEventSchema>

export function parseAutoSyncWorkerEvent(
  line: string,
): AutoSyncWorkerEvent | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{') || trimmed.length > 16_384) return null
  try {
    const parsed = workerEventSchema.safeParse(JSON.parse(trimmed))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

const detailedAnchorSchema = z
  .object({
    lineIndex: z.number().int().nonnegative(),
    lyricTimeMs: z.number().int().nonnegative(),
    audioTimeMs: z.number().int().nonnegative(),
    confidence: z.number().finite().min(0).max(1),
    whisperText: z.string().max(10_000),
  })
  .strict()

const profileAnchorSchema = z
  .object({
    lyricTimeMs: z.number().int().nonnegative(),
    audioTimeMs: z.number().int().nonnegative(),
  })
  .strict()

const wordTokenSchema = z
  .object({
    text: z.string().min(1).max(10_000),
    start_ms: z.number().int().nonnegative(),
    end_ms: z.number().int().nonnegative(),
    probability: z.number().finite().min(0).max(1),
  })
  .strict()

const gpuMemorySchema = z
  .object({
    baselineMiB: z.number().int().nonnegative(),
    peakMiB: z.number().int().nonnegative(),
    peakIncrementMiB: z.number().int().nonnegative(),
    phasePeaksMiB: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict()

export const autoSyncOutputSchema = z
  .object({
    trackId: z.string().regex(/^[a-f0-9]{64}$/),
    model: z
      .object({
        separator: z.string().min(1).max(500),
        whisper: z.string().min(1).max(200),
      })
      .strict(),
    matchedLines: z.number().int().nonnegative().max(100),
    totalLines: z.number().int().min(2).max(20_000),
    confidence: z.number().finite().min(0).max(1),
    anchors: z.array(detailedAnchorSchema).max(100),
    unmatchedLines: z.array(z.number().int().nonnegative()).max(20_000),
    lyricsSyncProfile: z
      .object({
        trackId: z.string().regex(/^[a-f0-9]{64}$/),
        offsetMs: z.literal(0),
        anchors: z.array(profileAnchorSchema).max(100),
        updatedAt: z.literal(0),
      })
      .strict(),
    comparison: z
      .object({
        beforeMedianAbsErrorMs: z.number().int().nonnegative().nullable(),
        afterLeaveOneOutMedianAbsErrorMs: z
          .number()
          .int()
          .nonnegative()
          .nullable(),
      })
      .strict(),
    diagnostics: z
      .object({
        whisperTokens: z.array(wordTokenSchema).max(1_000_000),
        bestConfidenceByLine: z
          .array(z.number().finite().min(0).max(1))
          .max(20_000),
        temporalOutlierLines: z
          .array(z.number().int().nonnegative())
          .max(20_000),
      })
      .strict(),
    metrics: z
      .object({
        vocalSeparationSeconds: z.number().finite().nonnegative(),
        whisperSeconds: z.number().finite().nonnegative(),
        matchingSeconds: z.number().finite().nonnegative(),
        totalSeconds: z.number().finite().nonnegative(),
        whisperTokens: z.number().int().nonnegative(),
        gpuMemory: gpuMemorySchema,
      })
      .strict(),
  })
  .strict()

export type AutoSyncWorkerOutput = z.infer<typeof autoSyncOutputSchema>

export interface AutoSyncTrackSource {
  trackId: string
  audioPath: string
  fileSize: number
  modifiedAt: number
  plainLyrics?: string
  syncedLyrics?: string
  provider?: string
  providerSource?: string
}

export interface AutoSyncLogger {
  info: (message: string, details?: unknown) => void
  warn: (message: string, details?: unknown) => void
  error: (message: string, details?: unknown) => void
}
