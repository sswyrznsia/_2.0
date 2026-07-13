import type { LyricsSyncProfile } from '../types/models'

const finite = (value: number) => Number.isFinite(value)

// One minute is enough for badly timestamped files while preventing a typo in
// the editor from moving a whole song by an implausible amount.
export const MAX_LYRICS_SYNC_OFFSET_MS = 60 * 1_000

export function parseLyricsOffsetSeconds(input: string): number | null {
  const value = input.trim()
  if (!/^[+-]?(?:\d+|\d+\.\d{1,3})$/.test(value)) return null
  const milliseconds = Math.round(Number(value) * 1_000)
  if (
    !Number.isFinite(milliseconds) ||
    Math.abs(milliseconds) > MAX_LYRICS_SYNC_OFFSET_MS
  )
    return null
  return milliseconds
}

export function validateLyricsSyncProfile(
  profile: LyricsSyncProfile,
): LyricsSyncProfile {
  if (!/^[a-f0-9]{64}$/.test(profile.trackId))
    throw new Error('Invalid track ID')
  if (
    !finite(profile.offsetMs) ||
    !Number.isInteger(profile.offsetMs) ||
    Math.abs(profile.offsetMs) > MAX_LYRICS_SYNC_OFFSET_MS
  )
    throw new Error('Invalid lyrics offset')
  if (!finite(profile.updatedAt) || profile.updatedAt < 0)
    throw new Error('Invalid sync update time')
  const anchors = [...profile.anchors]
    .map((anchor) => ({ ...anchor }))
    .sort((left, right) => left.lyricTimeMs - right.lyricTimeMs)
  if (anchors.length > 100) throw new Error('Too many lyrics sync anchors')
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index]
    if (
      !finite(anchor.lyricTimeMs) ||
      !finite(anchor.audioTimeMs) ||
      anchor.lyricTimeMs < 0 ||
      anchor.audioTimeMs < 0
    )
      throw new Error('Invalid lyrics sync anchor')
    const previous = anchors[index - 1]
    if (
      previous &&
      (previous.lyricTimeMs >= anchor.lyricTimeMs ||
        previous.audioTimeMs >= anchor.audioTimeMs)
    )
      throw new Error('Lyrics sync anchors must stay in chronological order')
  }
  return { ...profile, anchors }
}

export function adjustLyricTimeMs(
  originalTimeMs: number,
  profile?: LyricsSyncProfile,
): number {
  if (!finite(originalTimeMs)) return 0
  if (!profile) return Math.max(0, originalTimeMs)
  const valid = validateLyricsSyncProfile(profile)
  const { anchors, offsetMs } = valid
  if (!anchors.length) return Math.max(0, originalTimeMs + offsetMs)
  if (anchors.length === 1) {
    const anchor = anchors[0]
    return Math.max(
      0,
      originalTimeMs + anchor.audioTimeMs - anchor.lyricTimeMs + offsetMs,
    )
  }
  let left = anchors[0]!
  let right = anchors[1]!
  const last = anchors.at(-1)!
  if (originalTimeMs >= last.lyricTimeMs) {
    left = anchors.at(-2)!
    right = last
  } else if (originalTimeMs > left.lyricTimeMs) {
    for (let index = 1; index < anchors.length; index += 1) {
      if (originalTimeMs <= anchors[index].lyricTimeMs) {
        left = anchors[index - 1]
        right = anchors[index]
        break
      }
    }
  }
  const slope =
    (right.audioTimeMs - left.audioTimeMs) /
    (right.lyricTimeMs - left.lyricTimeMs)
  return Math.max(
    0,
    left.audioTimeMs + (originalTimeMs - left.lyricTimeMs) * slope + offsetMs,
  )
}
