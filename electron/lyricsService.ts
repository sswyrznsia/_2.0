import type {
  LyricsCandidate,
  LyricsLookupStatus,
  LyricsProviderAttempt,
  LyricsProviderAttemptStatus,
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

type LyricaErrorKind =
  | 'not-found'
  | 'rate-limited'
  | 'server-error'
  | 'invalid-json'
  | 'timeout'
  | 'network-error'
  | 'cancelled'

class LyricsRequestError extends Error {
  constructor(
    readonly status: LyricsLookupStatus,
    readonly kind?: LyricaErrorKind,
  ) {
    super(kind ?? status)
  }
}

interface CacheEntry {
  candidates: LyricsCandidate[]
  expiresAt: number
}

const LRCLIB_API =
  process.env.PULSE_SHELF_LRCLIB_API ?? 'https://lrclib.net/api'
const LYRICA_TIMEOUT_MS = 8_000
const LYRICA_SUCCESS_CACHE_MS = 60 * 60 * 1_000
const LYRICA_MISS_CACHE_MS = 2 * 60 * 1_000
const MAX_SEARCH_QUERIES = 6
const MAX_LYRICA_QUERIES = 4
const lrclibCache = new Map<string, LyricsCandidate[]>()
const lrclibInFlight = new Map<string, Promise<LyricsCandidate[]>>()
const lyricaCache = new Map<string, CacheEntry>()
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
    language: z.string().max(100).optional(),
    plain_lyrics: z.string().max(2_000_000).optional(),
    lyrics: z.string().max(2_000_000).optional(),
    synced_lyrics: z.string().max(2_000_000).optional(),
    timed_lyrics: z.array(lyricaTimedLineSchema).max(20_000).optional(),
    hasTimestamps: z.boolean().optional(),
    metadata: z
      .object({
        album: z.string().max(500).optional(),
        duration: z
          .union([z.string().max(20), z.number().finite().nonnegative()])
          .optional(),
        language: z.string().max(100).optional(),
      })
      .passthrough()
      .optional(),
  }),
})

const ARTIST_ALIAS_GROUPS = [['미츠키요', 'mitsukiyo', 'ミツキヨ']] as const

function configuredLyricaApi() {
  return (
    process.env.LYRICA_API_BASE_URL ??
    process.env.PULSE_SHELF_LYRICA_API ??
    ''
  ).trim()
}

function stripFeaturing(value: string) {
  return value
    .replace(/\s+(?:feat(?:uring)?\.?|ft\.?)\s+.+$/giu, ' ')
    .replace(/\((?:feat(?:uring)?\.?|ft\.?)\s+[^)]*\)/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeLyricsTitle(value: string): string {
  return stripFeaturing(value)
    .replace(/\[[^\]]*\]|【[^】]*】|\([^)]*\)|（[^）]*）/gu, ' ')
    .replace(
      /\b(?:official\s*(?:mv|music\s*video|lyrics?\s*video)?|music\s*video|lyrics?\s*video|covered\s+by|cover|mv|ost|bgm|1\s*hour|60\s*min(?:utes?)?)\b/giu,
      ' ',
    )
    .replace(/노래방|커버|가사|뮤직비디오|오리지널|歌ってみた/giu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractCoverHints(value: string): CoverHints {
  const slashCover = value.match(
    /^\s*(.+?)\s*\/\s*(.+?)\s+(?:covered\s+by|cover(?:ed)?\s+by)\s+.+$/iu,
  )
  if (slashCover)
    return {
      title: normalizeLyricsTitle(slashCover[1]),
      originalArtist: normalizeLyricsTitle(slashCover[2]),
    }

  const original = value.match(/(?:원곡|original)\s*[:：]\s*([^【[(（]+)/iu)
  const coverTitle = value.match(
    /^\s*(.+?)\s*[-–—]\s*(?:cover|covered\s+by|커버)\b/iu,
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

function expandArtistAliases(value: string) {
  const pieces = value
    .split(/\s*(?:\/|\||,|·|・)\s*/u)
    .map((item) => item.trim())
    .filter(Boolean)
  const normalizedPieces = pieces.map(normalize)
  const aliases = new Set([value.trim(), ...pieces].filter(Boolean))
  for (const group of ARTIST_ALIAS_GROUPS) {
    if (group.some((alias) => normalizedPieces.includes(normalize(alias))))
      group.forEach((alias) => aliases.add(alias))
  }
  return [...aliases]
}

function artistSimilarity(left: string, right: string) {
  const leftAliases = expandArtistAliases(left)
  const rightAliases = expandArtistAliases(right)
  return Math.max(
    0,
    ...leftAliases.flatMap((a) =>
      rightAliases.map((b) => similarity(normalize(a), normalize(b))),
    ),
  )
}

function durationScore(expected?: number, actual?: number) {
  if (!expected || !actual) return 0.5
  const difference = Math.abs(expected - actual)
  if (difference <= 3) return 1
  if (difference <= 10) return 0.8
  return Math.max(0, 0.65 - (difference - 10) / 300)
}

function queryKey(query: LyricsSearchQuery, duration?: number) {
  const rawTitle = (query.title ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .trim()
  const rawArtist = (query.artist ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .trim()
  return [
    normalize(query.title ?? ''),
    normalize(query.artist ?? ''),
    stableHash(`${rawTitle}\u0000${rawArtist}`),
    duration ?? '',
  ].join('\u0000')
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
  const syncedLyrics =
    typeof item.syncedLyrics === 'string' ? item.syncedLyrics : undefined
  const timestampInfo = inspectLrcTimestamps(syncedLyrics)
  return {
    id: item.id,
    trackName: item.trackName,
    artistName: item.artistName,
    albumName: typeof item.albumName === 'string' ? item.albumName : undefined,
    duration: typeof item.duration === 'number' ? item.duration : undefined,
    syncedLyrics,
    plainLyrics:
      typeof item.plainLyrics === 'string' ? item.plainLyrics : undefined,
    instrumental: item.instrumental === true,
    provider: 'lrclib',
    sourceLabel: 'LRCLIB',
    timestampValid: timestampInfo.valid,
    validLrcLineCount: timestampInfo.count,
  }
}

function parseDuration(value: string | number | undefined) {
  if (typeof value === 'number') return value
  if (!value) return undefined
  const parts = value.split(':').map(Number)
  if (parts.some((part) => !Number.isFinite(part))) return undefined
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3_600 + parts[1] * 60 + parts[2]
  return undefined
}

function formatLrcTime(milliseconds: number) {
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = ((milliseconds % 60_000) / 1_000).toFixed(3).padStart(6, '0')
  return `${String(minutes).padStart(2, '0')}:${seconds}`
}

function inspectLrcTimestamps(lyrics?: string) {
  if (!lyrics) return { valid: false, count: 0, hash: '' }
  const values = [
    ...lyrics.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g),
  ].map((match) => {
    const fraction = (match[3] ?? '').padEnd(3, '0').slice(0, 3)
    return (
      Number(match[1]) * 60_000 + Number(match[2]) * 1_000 + Number(fraction)
    )
  })
  const valid =
    values.length > 0 &&
    values.every((value, index) => index === 0 || value >= values[index - 1])
  return {
    valid,
    count: valid ? values.length : 0,
    hash: stableHash(values.join(',')),
  }
}

function normalizeLyricaSource(source: string) {
  return source
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s-]+/g, '_')
    .slice(0, 60)
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

function stableHash(value: string) {
  let hash = 2_166_136_261
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function syntheticLyricaId(value: string) {
  return -Math.max(1, Number.parseInt(stableHash(value), 16))
}

function sanitizeMetadata(value: Record<string, unknown> | undefined) {
  if (!value) return undefined
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string | number | boolean | null] => {
      const item = entry[1]
      return (
        item === null || ['string', 'number', 'boolean'].includes(typeof item)
      )
    },
  )
  return entries.length ? Object.fromEntries(entries) : undefined
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
        .map((line) => `[${formatLrcTime(line.start_time)}]${line.text.trim()}`)
        .join('\n')
    : item.synced_lyrics?.trim() ||
      (hasLrcTimestamps ? item.lyrics?.trim() : undefined)
  const plainLyrics =
    item.plain_lyrics?.trim() ||
    (item.lyrics && !hasLrcTimestamps ? item.lyrics.trim() : '') ||
    (timed.length
      ? timed.map((line) => line.text.trim()).join('\n')
      : undefined)
  if (!syncedLyrics && !plainLyrics) return null
  const title = item.title?.trim() || 'Unknown title'
  const artist = item.artist?.trim() || 'Unknown artist'
  const sourceLabel = lyricaSourceLabel(item.source)
  const timestampInfo = inspectLrcTimestamps(syncedLyrics)
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
    language:
      item.language?.trim() || item.metadata?.language?.trim() || undefined,
    providerMetadata: sanitizeMetadata(item.metadata),
    timestampValid: timestampInfo.valid,
    validLrcLineCount: timestampInfo.count,
  }
}

function lyricsTextHash(candidate: LyricsCandidate) {
  const content = candidate.plainLyrics || candidate.syncedLyrics || ''
  const normalized = content
    .replace(/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g, '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  return normalized ? stableHash(normalized) : ''
}

function mergeCandidates(existing: LyricsCandidate, incoming: LyricsCandidate) {
  const preferred =
    existing.syncedLyrics && !incoming.syncedLyrics
      ? existing
      : incoming.syncedLyrics && !existing.syncedLyrics
        ? incoming
        : existing.provider === 'lyrica'
          ? existing
          : incoming.provider === 'lyrica'
            ? incoming
            : existing
  const other = preferred === existing ? incoming : existing
  const labels = new Set(
    [
      preferred.sourceLabel,
      other.sourceLabel,
      ...(preferred.alternateSourceLabels ?? []),
      ...(other.alternateSourceLabels ?? []),
    ].filter((label): label is string => Boolean(label)),
  )
  labels.delete(preferred.sourceLabel ?? '')
  return {
    ...other,
    ...preferred,
    syncedLyrics: preferred.syncedLyrics ?? other.syncedLyrics,
    plainLyrics: preferred.plainLyrics ?? other.plainLyrics,
    alternateSourceLabels: labels.size ? [...labels] : undefined,
  }
}

function deduplicateLyricsCandidates(candidates: LyricsCandidate[]) {
  const byIdentity = new Map<string, LyricsCandidate>()
  for (const candidate of candidates) {
    const textHash = lyricsTextHash(candidate)
    const timestampHash = inspectLrcTimestamps(candidate.syncedLyrics).hash
    const identity = [
      normalize(candidate.trackName),
      normalize(candidate.artistName),
      textHash,
      timestampHash,
    ].join('\u0000')
    const key = textHash ? identity : `${candidate.provider}:${candidate.id}`
    const existing = byIdentity.get(key)
    byIdentity.set(
      key,
      existing ? mergeCandidates(existing, candidate) : candidate,
    )
  }
  return [...byIdentity.values()]
}

function errorStatus(error: unknown): LyricsLookupStatus {
  if (error instanceof LyricsRequestError) return error.status
  return 'network-error'
}

function providerAttemptStatus(error: unknown): LyricsProviderAttemptStatus {
  if (!(error instanceof LyricsRequestError)) return 'network-error'
  switch (error.kind) {
    case 'rate-limited':
      return 'rate-limited'
    case 'timeout':
      return 'timeout'
    case 'invalid-json':
      return 'invalid-response'
    case 'server-error':
      return 'server-error'
    case 'not-found':
      return 'not-found'
    default:
      return 'network-error'
  }
}

function providerAttemptStatusFromErrors(errors: unknown[]) {
  if (!errors.length) return 'not-found' as const
  const statuses = errors.map(providerAttemptStatus)
  return (
    statuses.find((status) => status === 'rate-limited') ??
    statuses.find((status) => status === 'timeout') ??
    statuses.find((status) => status === 'server-error') ??
    statuses.find((status) => status === 'invalid-response') ??
    statuses[0]
  )
}

function buildSearchQueries(
  title: string,
  artist: string,
  hints: CoverHints,
  manual?: LyricsSearchQuery,
) {
  const cleanedTitle = hints.title || normalizeLyricsTitle(title)
  const titles = [title.trim(), stripFeaturing(title), cleanedTitle].filter(
    Boolean,
  )
  const artists = [
    ...(hints.originalArtist ? expandArtistAliases(hints.originalArtist) : []),
    ...expandArtistAliases(stripFeaturing(artist)),
  ].filter(Boolean)
  const pairs: LyricsSearchQuery[] = []
  for (const candidateTitle of titles)
    for (const candidateArtist of artists)
      pairs.push({ title: candidateTitle, artist: candidateArtist })
  if (manual?.title || manual?.artist)
    pairs.unshift({
      title: manual.title?.trim() ?? '',
      artist: manual.artist?.trim() ?? '',
    })
  const unique = [
    ...new Map(pairs.map((query) => [queryKey(query), query])).values(),
  ].slice(0, MAX_SEARCH_QUERIES - 1)
  unique.push({ title: cleanedTitle, artist: '' })
  return unique
}

export function scoreLyricsCandidate(
  candidate: LyricsCandidate,
  input: LyricsSearchInput,
  originalArtist?: string,
): LyricsCandidate {
  const cleanInputTitle = extractCoverHints(input.title).title
  const title = Math.max(
    similarity(normalize(candidate.trackName), normalize(input.title)),
    similarity(normalize(candidate.trackName), cleanInputTitle),
  )
  const artist = Math.max(
    artistSimilarity(candidate.artistName, input.artist),
    artistSimilarity(candidate.artistName, originalArtist ?? ''),
  )
  const album = input.album
    ? similarity(normalize(candidate.albumName ?? ''), normalize(input.album))
    : 0.5
  const duration = durationScore(input.duration, candidate.duration)
  const validLines = candidate.timestampValid
    ? (candidate.validLrcLineCount ?? 0)
    : 0
  const syncedQuality =
    candidate.syncedLyrics && candidate.timestampValid
      ? 0.75 + Math.min(0.25, validLines / 48)
      : 0
  const score =
    title * 0.46 +
    artist * 0.25 +
    album * 0.08 +
    duration * 0.12 +
    syncedQuality * 0.09
  return {
    ...candidate,
    score: Math.round(score * 1_000) / 1_000,
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

function shouldRetryLyrica(error: unknown) {
  return (
    error instanceof LyricsRequestError &&
    ['server-error', 'timeout', 'network-error'].includes(error.kind ?? '')
  )
}

export class LyricsService {
  constructor(private readonly lyricaTimeoutMs = LYRICA_TIMEOUT_MS) {}

  async search(query: LyricsSearchQuery, signal?: AbortSignal) {
    const cacheKey = queryKey(query)
    const cached = lrclibCache.get(cacheKey)
    if (cached) return cached
    const pending = lrclibInFlight.get(cacheKey)
    if (pending) return pending
    const request = this.requestLrclib(query, signal).finally(() =>
      lrclibInFlight.delete(cacheKey),
    )
    lrclibInFlight.set(cacheKey, request)
    const results = await request
    lrclibCache.set(cacheKey, results)
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
    const isCoverSearch = /covered\s+by|\bcover\b|커버|원곡/iu.test(title)
    if (!normalizedTitle && !artist)
      return {
        status: 'metadata-missing',
        candidates: [],
        normalizedTitle,
        providerAttempts: [],
      }

    const input: LyricsSearchInput = {
      title,
      artist,
      album: track.album,
      duration: track.duration,
    }
    const queries = buildSearchQueries(title, artist, hints, manualQuery)

    const providerAttempts: LyricsProviderAttempt[] = []
    const lyricaCandidates: LyricsCandidate[] = []
    let lyricaFailure: LyricsProviderAttemptStatus | undefined
    let lyricaAttempted = false
    if (configuredLyricaApi()) {
      for (const query of queries
        .filter((item) => item.title && item.artist)
        .slice(0, MAX_LYRICA_QUERIES)) {
        lyricaAttempted = true
        try {
          const found = await this.searchLyrica(query, track.duration, signal)
          lyricaCandidates.push(...found)
          if (found.length) break
        } catch (error) {
          if (signal?.aborted) throw signal.reason
          lyricaFailure = providerAttemptStatus(error)
          // Lyrica is optional. Any service/protocol error falls through to LRCLIB.
          break
        }
      }
    }
    if (lyricaAttempted)
      providerAttempts.push({
        provider: 'lyrica',
        status: lyricaCandidates.length ? 'success' : (lyricaFailure ?? 'not-found'),
      })

    const settled = await Promise.allSettled(
      queries.map((query) => this.search(query, signal)),
    )
    if (signal?.aborted) throw signal.reason
    const lrclibCandidates = settled.flatMap((result) =>
      result.status === 'fulfilled' ? result.value : [],
    )
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    const errors = rejected
      .map((result) => errorStatus(result.reason))
    providerAttempts.push({
      provider: 'lrclib',
      status: lrclibCandidates.length
        ? 'success'
        : providerAttemptStatusFromErrors(rejected.map((result) => result.reason)),
    })
    const candidates = deduplicateLyricsCandidates([
      ...lyricaCandidates,
      ...lrclibCandidates,
    ])
      .map((candidate) =>
        scoreLyricsCandidate(candidate, input, hints.originalArtist),
      )
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
        providerAttempts,
      }
    }
    const eligibleCandidates = candidates.filter(
      (candidate) => candidate.provider !== 'lyrica',
    )
    const [autoBest, autoSecond] = eligibleCandidates
    const isUnambiguous =
      !autoSecond || (autoBest.score ?? 0) - (autoSecond.score ?? 0) >= 0.1
    const titleMatch = Math.max(
      similarity(normalize(autoBest?.trackName ?? ''), normalize(title)),
      similarity(normalize(autoBest?.trackName ?? ''), hints.title),
    )
    const artistMatch = Math.max(
      artistSimilarity(autoBest?.artistName ?? '', artist),
      artistSimilarity(autoBest?.artistName ?? '', hints.originalArtist ?? ''),
    )
    const autoMatch =
      allowAutoMatch &&
      autoBest &&
      autoBest.score !== undefined &&
      autoBest.score >= minimumScore &&
      titleMatch >= 0.8 &&
      artistMatch >= 0.65 &&
      isUnambiguous &&
      !isCoverSearch &&
      !isLongRepeat(track, autoBest)
        ? autoBest
        : undefined
    return {
      status: autoMatch
        ? autoMatch.instrumental
          ? 'instrumental'
          : 'found'
        : 'low-confidence',
      candidates,
      normalizedTitle,
      originalArtist: hints.originalArtist,
      providerAttempts,
      autoMatch,
    }
  }

  clearCache() {
    lrclibCache.clear()
    lyricaCache.clear()
  }

  private async searchLyrica(
    query: LyricsSearchQuery,
    duration?: number,
    signal?: AbortSignal,
  ) {
    const cacheKey = queryKey(query, duration)
    const cached = lyricaCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.candidates
    if (cached) lyricaCache.delete(cacheKey)
    const pending = lyricaInFlight.get(cacheKey)
    if (pending) return pending
    const request = this.requestLyricaWithRetry(query, signal).finally(() =>
      lyricaInFlight.delete(cacheKey),
    )
    lyricaInFlight.set(cacheKey, request)
    const results = await request
    lyricaCache.set(cacheKey, {
      candidates: results,
      expiresAt:
        Date.now() +
        (results.length ? LYRICA_SUCCESS_CACHE_MS : LYRICA_MISS_CACHE_MS),
    })
    return results
  }

  private async requestLrclib(query: LyricsSearchQuery, signal?: AbortSignal) {
    const text = [query.title, query.artist].filter(Boolean).join(' ').trim()
    if (!text) return []
    const response = await fetch(
      `${LRCLIB_API}/search?${new URLSearchParams({ q: text })}`,
      {
        signal,
        headers: { 'User-Agent': 'Pulse Shelf 2.0' },
      },
    )
    if (!response.ok)
      throw new LyricsRequestError(
        response.status === 429 ? 'rate-limited' : 'network-error',
        response.status === 429
          ? 'rate-limited'
          : response.status >= 500
            ? 'server-error'
            : 'network-error',
      )
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new LyricsRequestError('network-error', 'invalid-json')
    }
    if (!Array.isArray(payload)) return []
    return payload
      .map(toCandidate)
      .filter((item): item is LyricsCandidate => item !== null)
  }

  private async requestLyricaWithRetry(
    query: LyricsSearchQuery,
    signal?: AbortSignal,
  ) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.requestLyrica(query, signal)
      } catch (error) {
        if (signal?.aborted)
          throw new LyricsRequestError('network-error', 'cancelled')
        if (attempt === 1 || !shouldRetryLyrica(error)) throw error
      }
    }
    return []
  }

  private async requestLyrica(query: LyricsSearchQuery, signal?: AbortSignal) {
    const artist = query.artist?.trim()
    const song = query.title?.trim()
    const baseUrl = configuredLyricaApi()
    if (!baseUrl || !artist || !song) return []
    let url: URL
    try {
      url = new URL('/lyrics/', baseUrl)
    } catch {
      throw new LyricsRequestError('network-error', 'network-error')
    }
    url.search = new URLSearchParams({
      artist,
      song,
      timestamps: 'true',
      fast: 'true',
    }).toString()
    const timeoutSignal = AbortSignal.timeout(this.lyricaTimeoutMs)
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal
    const token = process.env.LYRICA_API_TOKEN?.trim()
    let response: Response
    try {
      response = await fetch(url, {
        signal: requestSignal,
        headers: {
          'User-Agent': 'Pulse Shelf 2.0',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      })
    } catch {
      if (signal?.aborted)
        throw new LyricsRequestError('network-error', 'cancelled')
      if (timeoutSignal.aborted)
        throw new LyricsRequestError('network-error', 'timeout')
      throw new LyricsRequestError('network-error', 'network-error')
    }
    if (response.status === 404) return []
    if (response.status === 429)
      throw new LyricsRequestError('rate-limited', 'rate-limited')
    if (response.status >= 500)
      throw new LyricsRequestError('network-error', 'server-error')
    if (!response.ok)
      throw new LyricsRequestError('network-error', 'network-error')
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new LyricsRequestError('network-error', 'invalid-json')
    }
    const parsed = lyricaResponseSchema.safeParse(payload)
    if (!parsed.success) {
      if (
        payload &&
        typeof payload === 'object' &&
        (payload as { status?: unknown }).status === 'error'
      )
        return []
      throw new LyricsRequestError('network-error', 'invalid-json')
    }
    const candidate = toLyricaCandidate(parsed.data)
    return candidate ? [candidate] : []
  }
}
