export interface LyricLine {
  time: number
  text: string
}

export function findActiveLyricLineIndex(
  timestamps: Array<number | null | undefined>,
  currentTime: number,
): number {
  if (!Number.isFinite(currentTime)) return -1
  let activeIndex = -1
  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index]
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
      if (timestamp <= currentTime) activeIndex = index
    }
  }
  return activeIndex
}

export function parseLrc(content: string): LyricLine[] {
  const lines: LyricLine[] = []
  const timestamp = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g
  for (const rawLine of content.split(/\r?\n/)) {
    const matches = [...rawLine.matchAll(timestamp)]
    if (!matches.length) continue
    const text = rawLine.replace(timestamp, '').trim()
    if (!text && matches.length === 1) continue
    for (const match of matches) {
      const fraction = match[3]
        ? Number(`0.${match[3].padEnd(3, '0').slice(0, 3)}`)
        : 0
      const time = Number(match[1]) * 60 + Number(match[2]) + fraction
      if (Number.isFinite(time)) lines.push({ time, text: text || '♪' })
    }
  }
  return lines.sort((a, b) => a.time - b.time)
}
