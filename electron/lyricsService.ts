import type {
  LyricsCandidate,
  LyricsLookupStatus,
  LyricsSearchQuery,
  LyricsSearchResult,
  Track,
} from '../src/types/models'

export interface LyricsSearchInput {
  title: string
  artist: string
  album?: string
  duration?: number
}

export interface LyricsLookupResult extends LyricsSearchResult {
  autoMatch?: LyricsCandidate
}

interface CoverHints {
  title: string
  originalArtist?: string
}

class LyricsRequestError extends Error {
  constructor(readonly status: LyricsLookupStatus) {
    super(status)
  }
}

const API = process.env.PULSE_SHELF_LRCLIB_API ?? 'https://lrclib.net/api'
const cache = new Map<string, LyricsCandidate[]>()
const inFlight = new Map<string, Promise<LyricsCandidate[]>>()

export function normalizeLyricsTitle(value: string): string {
  return value
    .replace(/\[[^\]]*\]|【[^】]*】|\([^)]*\)|（[^）]*）/g, ' ')
    .replace(
      /\b(?:official\s*(?:mv|music\s*video|lyrics?\s*video)?|music\s*video|lyrics?\s*video|covered\s+by|cover|mv|ost|bgm|1\s*hour|60\s*min(?:utes?)?)\b/gi,
      ' ',
    )
    .replace(/歌ってみた|1時間耐久|작업용/giu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractCoverHints(value: string): CoverHints {
  const slashCover = value.match(
    /^\s*(.+?)\s*\/\s*(.+?)\s+(?:covered\s+by|cover(?:ed)?\s+by)\s+.+$/i,
  )
  if (slashCover)
    return {
      title: normalizeLyricsTitle(slashCover[1]),
      originalArtist: normalizeLyricsTitle(slashCover[2]),
    }

  const original = value.match(/原曲\s*[:：]\s*([^【[(（]+?)(?=$|[【[(（])/u)
  const coverTitle = value.match(
    /^\s*(.+?)\s*[-–—]\s*(?:cover|covered\s+by|歌ってみた)\b/i,
  )
  return {
    title: normalizeLyricsTitle(coverTitle?.[1] ?? value),
    originalArtist: original ? normalizeLyricsTitle(original[1]) : undefined,
  }
}

function normalize(value: string) {
  return normalizeLyricsTitle(value).toLocaleLowerCase()
}

function similarity(left: string, right: string) {
  if (!left || !right) return 0
  if (left === right) return 1
  const a = new Set(left.split(' ').filter(Boolean))
  const b = new Set(right.split(' ').filter(Boolean))
  const overlap = [...a].filter((token) => b.has(token)).length
  return overlap / Math.max(1, new Set([...a, ...b]).size)
}

function durationScore(expected?: number, actual?: number) {
  if (!expected || !actual) return 0.5
  const difference = Math.abs(expected - actual)
  if (difference <= 3) return 1
  if (difference <= 10) return 0.8
  return Math.max(0, 0.65 - (difference - 10) / 300)
}

function key(query: LyricsSearchQuery) {
  return [query.title ?? '', query.artist ?? ''].join('\u0000')
}

function toCandidate(value: unknown): LyricsCandidate | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (
    typeof item.id !== 'number' ||
    typeof item.trackName !== 'string' ||
    typeof item.artistName !== 'string'
  )
    return null
  return {
    id: item.id,
    trackName: item.trackName,
    artistName: item.artistName,
    albumName: typeof item.albumName === 'string' ? item.albumName : undefined,
    duration: typeof item.duration === 'number' ? item.duration : undefined,
    syncedLyrics:
      typeof item.syncedLyrics === 'string' ? item.syncedLyrics : undefined,
    plainLyrics:
      typeof item.plainLyrics === 'string' ? item.plainLyrics : undefined,
    instrumental: item.instrumental === true,
  }
}

function errorStatus(error: unknown): LyricsLookupStatus {
  if (error instanceof LyricsRequestError) return error.status
  return 'network-error'
}

export function scoreLyricsCandidate(
  candidate: LyricsCandidate,
  input: LyricsSearchInput,
  originalArtist?: string,
): LyricsCandidate {
  const title = Math.max(
    similarity(normalize(candidate.trackName), normalize(input.title)),
    similarity(normalize(candidate.trackName), extractCoverHints(input.title).title),
  )
  const artist = Math.max(
    similarity(normalize(candidate.artistName), normalize(input.artist)),
    similarity(normalize(candidate.artistName), originalArtist ?? ''),
  )
  const album = input.album
    ? similarity(normalize(candidate.albumName ?? ''), normalize(input.album))
    : 0.5
  const duration = durationScore(input.duration, candidate.duration)
  const score = title * 0.48 + artist * 0.24 + album * 0.1 + duration * 0.12 + (candidate.syncedLyrics ? 0.06 : 0)
  return {
    ...candidate,
    score: Math.round(score * 1000) / 1000,
    durationDelta:
      input.duration && candidate.duration
        ? Math.abs(input.duration - candidate.duration)
        : undefined,
  }
}

function isLongRepeat(track: Track, candidate: LyricsCandidate) {
  return Boolean(
    track.duration &&
      candidate.duration &&
      Math.abs(track.duration - candidate.duration) >= 600,
  )
}

export class LyricsService {
  async search(
    query: LyricsSearchQuery,
    signal?: AbortSignal,
  ): Promise<LyricsCandidate[]> {
    const cacheKey = key(query)
    const cached = cache.get(cacheKey)
    if (cached) return cached
    const pending = inFlight.get(cacheKey)
    if (pending) return pending
    const request = this.request(query, signal).finally(() =>
      inFlight.delete(cacheKey),
    )
    inFlight.set(cacheKey, request)
    const results = await request
    cache.set(cacheKey, results)
    return results
  }

  async lookup(
    track: Track,
    minimumScore = 0.9,
    manualQuery?: LyricsSearchQuery,
    signal?: AbortSignal,
  ): Promise<LyricsLookupResult> {
    const title = manualQuery?.title?.trim() || track.title.trim()
    const artist = manualQuery?.artist?.trim() || track.artist.trim()
    const normalizedTitle = normalizeLyricsTitle(title)
    const hints = extractCoverHints(title)
    const isCoverSearch = /covered\s+by|\bcover\b|歌ってみた|原曲/iu.test(title)
    if (!normalizedTitle && !artist)
      return { status: 'metadata-missing', candidates: [], normalizedTitle }

    const input: LyricsSearchInput = {
      title,
      artist,
      album: track.album,
      duration: track.duration,
    }
    const queries: LyricsSearchQuery[] = [
      { title, artist },
      { title: normalizedTitle, artist },
      { title: normalizedTitle, artist: '' },
    ]
    if (hints.originalArtist)
      queries.push({ title: normalizedTitle, artist: hints.originalArtist })
    if (manualQuery?.title || manualQuery?.artist)
      queries.push({
        title: manualQuery.title ?? '',
        artist: manualQuery.artist ?? '',
      })
    const uniqueQueries = [...new Map(queries.map((query) => [key(query), query])).values()]
    const settled = await Promise.allSettled(
      uniqueQueries.map((query) => this.search(query, signal)),
    )
    const raw = settled.flatMap((result) =>
      result.status === 'fulfilled' ? result.value : [],
    )
    const errors = settled
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => errorStatus(result.reason))
    const candidates = [...new Map(raw.map((candidate) => [candidate.id, candidate])).values()]
      .map((candidate) => scoreLyricsCandidate(candidate, input, hints.originalArtist))
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    if (!candidates.length) {
      return {
        status: errors.includes('rate-limited')
          ? 'rate-limited'
          : errors.length
            ? 'network-error'
            : 'not-found',
        candidates,
        normalizedTitle,
        originalArtist: hints.originalArtist,
      }
    }
    const [best, second] = candidates
    const isUnambiguous = !second || (best.score ?? 0) - (second.score ?? 0) >= 0.1
    const autoMatch =
      best.score !== undefined &&
      best.score >= minimumScore &&
      isUnambiguous &&
      !isCoverSearch &&
      !isLongRepeat(track, best)
        ? best
        : undefined
    return {
      status: autoMatch
        ? best.instrumental
          ? 'instrumental'
          : 'found'
        : 'low-confidence',
      candidates,
      normalizedTitle,
      originalArtist: hints.originalArtist,
      autoMatch,
    }
  }

  clearCache() {
    cache.clear()
  }

  private async request(query: LyricsSearchQuery, signal?: AbortSignal) {
    const text = [query.title, query.artist].filter(Boolean).join(' ').trim()
    if (!text) return []
    const response = await fetch(`${API}/search?${new URLSearchParams({ q: text })}`, {
      signal,
      headers: { 'User-Agent': 'Pulse Shelf 2.0' },
    })
    if (!response.ok)
      throw new LyricsRequestError(
        response.status === 429 ? 'rate-limited' : 'network-error',
      )
    const payload = await response.json()
    if (!Array.isArray(payload)) return []
    return payload
      .map(toCandidate)
      .filter((item): item is LyricsCandidate => item !== null)
  }
}
