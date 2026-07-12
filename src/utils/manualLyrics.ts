export interface ParsedManualLyrics {
  kind: 'lrc' | 'text'
  plainLyrics: string
  syncedLyrics?: string
}

const timestampPattern = /\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]/g
const metadataPattern = /^\[(?:ar|ti|al|by|offset|re|ve):[^\]]*\]\s*$/iu

function formatTimestamp(minutes: number, seconds: number, fraction?: string) {
  const milliseconds = Number((fraction ?? '').padEnd(3, '0').slice(0, 3))
  return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}]`
}

function cleanText(value: string) {
  return value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
}

/** Parses user-provided LRC without reordering its lyric lines. */
export function parseManualLyrics(content: string): ParsedManualLyrics {
  const normalized = cleanText(content)
  if (!normalized) throw new Error('가사 내용을 입력하세요.')

  const synced: string[] = []
  const plain: string[] = []
  let pendingTimestamps: string[] = []
  let sawTimestamp = false

  const appendTimedLine = (timestamps: string[], text: string) => {
    if (!text) return
    timestamps.forEach((timestamp) => synced.push(`${timestamp}${text}`))
    plain.push(text)
  }

  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim()
    if (!line || metadataPattern.test(line)) continue
    const matches = [...line.matchAll(timestampPattern)]
    if (matches.length) {
      sawTimestamp = true
      const timestamps = matches.map((match) =>
        formatTimestamp(Number(match[1]), Number(match[2]), match[3]),
      )
      const text = line.replace(timestampPattern, '').trim()
      if (text) appendTimedLine(timestamps, text)
      else pendingTimestamps = timestamps
      continue
    }
    if (pendingTimestamps.length) {
      appendTimedLine(pendingTimestamps, line)
      pendingTimestamps = []
    } else {
      plain.push(line)
    }
  }

  const plainLyrics = plain.join('\n').trim()
  if (sawTimestamp && synced.length && plainLyrics)
    return { kind: 'lrc', syncedLyrics: synced.join('\n'), plainLyrics }
  if (!plainLyrics) throw new Error('유효한 가사 줄을 찾지 못했습니다.')
  return { kind: 'text', plainLyrics }
}
