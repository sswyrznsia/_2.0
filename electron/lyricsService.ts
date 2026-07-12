import type {
  LyricsCandidate,
  LyricsLookupStatus,
  LyricsSearchQuery,
  LyricsSearchResult,
  Track,
} from '../src/types/models'
import { z } from 'zod'

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
const LYRICA_API =
  process.env.PULSE_SHELF_LYRICA_API ?? 'https://wilooper-lyrica.hf.space'
const cache = new Map<string, LyricsCandidate[]>()
const inFlight = new Map<string, Promise<LyricsCandidate[]>>()
const lyricaCache = new Map<string, LyricsCandidate[]>()
const lyricaInFlight = new Map<string, Promise<LyricsCandidate[]>>()

const lyricaTimedLineSchema = z.object({
  text: z.string().max(10_000),
  start_time: z.number().finite().nonnegative(),
  end_time: z.number().finite().nonnegative().optional(),
})
const lyricaResponseSchema = z.object({
  status: z.literal('success'),
  data: z.object({
    source: z.string().trim().min(1).max(100),
    artist: z.string().max(500).optional(),
    title: z.string().max(500).optional(),
    plain_lyrics: z.string().max(2_000_000).optional(),
    lyrics: z.string().max(2_000_000).optional(),
    synced_lyrics: z.string().max(2_000_000).optional(),
    timed_lyrics: z.array(lyricaTimedLineSchema).max(20_000).optional(),
    hasTimestamps: z.boolean().optional(),
    metadata: z
      .object({
        album: z.string().max(500).optional(),
        duration: z.union([z.string().max(20), z.number().finite().nonnegative()]).optional(),
      })
      .optional(),
  }),
})

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
    provider: 'lrclib',
    sourceLabel: 'LRCLIB',
  }
}

function parseDuration(value: string | number | undefined) {
  if (typeof value === 'number') return value
  if (!value) return undefined
  const parts = value.split(':').map(Number)
  if (parts.some((part) => !Number.isFinite(part))) return undefined
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return undefined
}

function formatLrcTime(milliseconds: number) {
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = ((milliseconds % 60_000) / 1_000).toFixed(3).padStart(6, '0')
  return `${String(minutes).padStart(2, '0')}:${seconds}`
}

function normalizeLyricaSource(source: string) {
  return source.trim().toLocaleLowerCase().replace(/[\s-]+/g, '_').slice(0, 60)
}

function lyricaSourceLabel(source: string) {
  const normalized = normalizeLyricaSource(source)
  const labels: Record<string, string> = {
    youtube_music: 'Lyrica · YouTube Music',
    youtube_transcript: 'Lyrica · YouTube 자막',
    youtube_captions: 'Lyrica · YouTube 자막',
    youtube_subtitles: 'Lyrica · YouTube 자막',
    netease: 'Lyrica · NetEase',
    megalobiz: 'Lyrica · Megalobiz',
    musixmatch: 'Lyrica · Musixmatch',
    simpmusic: 'Lyrica · SimpMusic',
    genius: 'Lyrica · Genius',
    lrclib: 'Lyrica · LRCLIB',
  }
  return labels[normalized] ?? `Lyrica · ${source.trim().slice(0, 60)}`
}

function syntheticLyricaId(value: string) {
  let hash = 2_166_136_261
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16_777_619)
  }
  return -Math.max(1, hash >>> 0)
}

function toLyricaCandidate(value: unknown): LyricsCandidate | null {
  const result = lyricaResponseSchema.safeParse(value)
  if (!result.success) return null
  const item = result.data.data
  const timed = item.timed_lyrics?.filter((line) => line.text.trim()) ?? []
  const hasLrcTimestamps = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/.test(
    item.lyrics ?? '',
  )
  const syncedLyrics = timed.length
    ? timed
        .map(
          (line) =>
            `[${formatLrcTime(line.start_time)}]${line.text.trim()}`,
        )
        .join('\n')
    : item.synced_lyrics?.trim() ||
      (hasLrcTimestamps ? item.lyrics?.trim() : undefined)
  const plainLyrics =
    item.plain_lyrics?.trim() ||
    (item.lyrics && !hasLrcTimestamps ? item.lyrics.trim() : '') ||
    (timed.length ? timed.map((line) => line.text.trim()).join('\n') : undefined)
  if (!syncedLyrics && !plainLyrics) return null
  const title = item.title?.trim() || 'Unknown title'
  const artist = item.artist?.trim() || 'Unknown artist'
  const sourceLabel = lyricaSourceLabel(item.source)
  return {
    id: syntheticLyricaId(
      [title, artist, sourceLabel, syncedLyrics ?? plainLyrics].join('\u0000'),
    ),
    trackName: title,
    artistName: artist,
    albumName: item.metadata?.album?.trim() || undefined,
    duration: parseDuration(item.metadata?.duration),
    syncedLyrics,
    plainLyrics,
    instrumental: false,
    provider: 'lyrica',
    providerSource: normalizeLyricaSource(item.source),
    sourceLabel,
  }
}

function lyricsFingerprint(candidate: LyricsCandidate) {
  const content = candidate.plainLyrics || candidate.syncedLyrics || ''
  return content
    .replace(/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g, '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function deduplicateLyricsCandidates(candidates: LyricsCandidate[]) {
  const byLyrics = new Map<string, LyricsCandidate>()
  for (const candidate of candidates) {
    const fingerprint = lyricsFingerprint(candidate)
    const key = fingerprint || `${candidate.provider}:${candidate.id}`
    const existing = byLyrics.get(key)
    if (!existing) {
      byLyrics.set(key, candidate)
      continue
    }
    if (existing.provider === 'lrclib') {
      byLyrics.set(key, {
        ...existing,
        syncedLyrics: existing.syncedLyrics ?? candidate.syncedLyrics,
        plainLyrics: existing.plainLyrics ?? candidate.plainLyrics,
      })
    } else if (candidate.provider === 'lrclib') byLyrics.set(key, candidate)
  }
  return [...byLyrics.values()]
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
    allowAutoMatch = true,
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
    let candidates = [...new Map(raw.map((candidate) => [candidate.id, candidate])).values()]
      .map((candidate) => scoreLyricsCandidate(candidate, input, hints.originalArtist))
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    const [lrclibBest, lrclibSecond] = candidates
    const lrclibIsClear = Boolean(
      lrclibBest &&
        (lrclibBest.score ?? 0) >= 0.9 &&
        (!lrclibSecond ||
          (lrclibBest.score ?? 0) - (lrclibSecond.score ?? 0) >= 0.1),
    )
    if (!lrclibIsClear || isCoverSearch) {
      const lyricaQuery = {
        title: normalizedTitle || title,
        artist: hints.originalArtist || artist,
      }
      try {
        const lyricaCandidates = await this.searchLyrica(lyricaQuery, signal)
        candidates = deduplicateLyricsCandidates([
          ...candidates,
          ...lyricaCandidates,
        ])
          .map((candidate) =>
            scoreLyricsCandidate(candidate, input, hints.originalArtist),
          )
          .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
      } catch {
        // Lyrica is a best-effort fallback. LRCLIB results remain usable.
      }
    }
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
    const requiredScore =
      best.provider === 'lyrica' ? Math.max(minimumScore, 0.94) : minimumScore
    const lyricaMayAutoMatch =
      best.provider !== 'lyrica' ||
      (Boolean(best.syncedLyrics) &&
        best.providerSource === 'lrclib')
    const autoMatch =
      allowAutoMatch &&
      lyricaMayAutoMatch &&
      best.score !== undefined &&
      best.score >= requiredScore &&
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
    lyricaCache.clear()
  }

  private async searchLyrica(
    query: LyricsSearchQuery,
    signal?: AbortSignal,
  ): Promise<LyricsCandidate[]> {
    const cacheKey = key(query)
    const cached = lyricaCache.get(cacheKey)
    if (cached) return cached
    const pending = lyricaInFlight.get(cacheKey)
    if (pending) return pending
    const request = this.requestLyrica(query, signal).finally(() =>
      lyricaInFlight.delete(cacheKey),
    )
    lyricaInFlight.set(cacheKey, request)
    const results = await request
    lyricaCache.set(cacheKey, results)
    return results
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

  private async requestLyrica(
    query: LyricsSearchQuery,
    signal?: AbortSignal,
  ): Promise<LyricsCandidate[]> {
    const artist = query.artist?.trim()
    const song = query.title?.trim()
    if (!artist || !song) return []
    const request = async (timestamps: boolean) => {
      const timeoutSignal = AbortSignal.timeout(45_000)
      const requestSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal
      const url = new URL('/lyrics/', LYRICA_API)
      url.search = new URLSearchParams({
        artist,
        song,
        timestamps: String(timestamps),
      }).toString()
      const response = await fetch(url, {
        signal: requestSignal,
        headers: { 'User-Agent': 'Pulse Shelf 2.0' },
      })
      if (!response.ok)
        throw new LyricsRequestError(
          response.status === 429 ? 'rate-limited' : 'network-error',
        )
      return toLyricaCandidate(await response.json())
    }
    const synced = await request(true)
    if (synced) return [synced]
    const plain = await request(false)
    return plain ? [plain] : []
  }
}
