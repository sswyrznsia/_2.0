import type { GeneratedLyricsTimeline } from '../types/models'

export const GENERATED_TIMELINE_MIN_CONFIDENCE = 0.75
const LRC_TIMESTAMP = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g

export function splitGeneratedLyricsText(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(LRC_TIMESTAMP, '').trim())
    .filter(Boolean)
}

export function generatedLyricsTextHash(value: string): string {
  return hashText(splitGeneratedLyricsText(value).join('\n'))
}

export function generatedLyricsLineHash(value: string): string {
  return hashText(value.trim())
}

function hashText(value: string): string {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}

export function validateGeneratedLyricsTimeline(
  timeline: GeneratedLyricsTimeline,
  plainLyrics: string,
): GeneratedLyricsTimeline {
  const textLines = splitGeneratedLyricsText(plainLyrics)
  if (
    timeline.lineCount !== textLines.length ||
    timeline.lyricsTextHash !== generatedLyricsTextHash(plainLyrics)
  )
    throw new Error('저장된 AI 타임라인과 현재 가사 텍스트가 다릅니다.')

  let previousLineIndex = -1
  let previousAudioTimeMs = -1
  for (const line of timeline.lines) {
    if (
      line.lineIndex <= previousLineIndex ||
      line.lineIndex >= textLines.length ||
      line.audioTimeMs <= previousAudioTimeMs ||
      line.textHash !== generatedLyricsLineHash(textLines[line.lineIndex]) ||
      (line.confidence !== undefined &&
        (!Number.isFinite(line.confidence) ||
          line.confidence < 0 ||
          line.confidence > 1)) ||
      (line.source !== undefined &&
        ![
          'direct',
          'segment_recovered',
          'interpolated',
          'local_retry',
          'unmatched',
          'manual',
        ].includes(line.source)) ||
      (timeline.source === 'ai' &&
        (line.confidence === undefined ||
          line.confidence < GENERATED_TIMELINE_MIN_CONFIDENCE))
    )
      throw new Error('저장된 AI 타임라인의 줄 정보가 올바르지 않습니다.')
    previousLineIndex = line.lineIndex
    previousAudioTimeMs = line.audioTimeMs
  }
  return timeline
}
