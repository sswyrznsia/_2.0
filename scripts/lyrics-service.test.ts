import assert from 'node:assert/strict'
import type { LyricsCandidate, Track } from '../src/types/models'
import {
  extractCoverHints,
  LyricsService,
  normalizeLyricsTitle,
} from '../electron/lyricsService'
import {
  adjustLyricTimeMs,
  validateLyricsSyncProfile,
} from '../src/utils/lyricsSync'
import {
  generatedLyricsLineHash,
  generatedLyricsTextHash,
  splitGeneratedLyricsText,
  validateGeneratedLyricsTimeline,
} from '../src/utils/generatedLyricsTimeline'
import { findActiveLyricLineIndex } from '../src/utils/lyrics'

const track = (overrides: Partial<Track> = {}): Track => ({
  id: 'a'.repeat(64),
  fileName: 'test.mp3',
  title: 'Test Song',
  artist: 'Test Artist',
  album: 'Test Album',
  duration: 180,
  format: 'mp3',
  fileSize: 0,
  modifiedAt: 0,
  addedAt: 0,
  liked: false,
  playCount: 0,
  ...overrides,
})

const candidate = (
  overrides: Partial<LyricsCandidate> = {},
): LyricsCandidate => ({
  id: 1,
  trackName: 'Test Song',
  artistName: 'Test Artist',
  albumName: 'Test Album',
  duration: 180,
  syncedLyrics: '[00:00.00]Test',
  instrumental: false,
  ...overrides,
})

async function withFetch(
  response: LyricsCandidate[] | Error | number,
  callback: () => Promise<void>,
) {
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    if (response instanceof Error) throw response
    if (typeof response === 'number')
      return new Response('', { status: response })
    return new Response(JSON.stringify(response), { status: 200 })
  }) as typeof fetch
  try {
    new LyricsService().clearCache()
    await callback()
  } finally {
    globalThis.fetch = original
  }
}

async function withProviderFetch(
  responses: {
    lrclib: unknown
    lyricaSynced?: unknown
    lyricaPlain?: unknown
    lyricaStatus?: number
  },
  callback: (calls: { lrclib: number; lyrica: number }) => Promise<void>,
) {
  const original = globalThis.fetch
  const calls = { lrclib: 0, lyrica: 0 }
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'lrclib.net' || url.pathname.includes('/api/search')) {
      calls.lrclib += 1
      return new Response(JSON.stringify(responses.lrclib), { status: 200 })
    }
    calls.lyrica += 1
    if (responses.lyricaStatus)
      return new Response('', { status: responses.lyricaStatus })
    const payload =
      url.searchParams.get('timestamps') === 'true'
        ? responses.lyricaSynced
        : responses.lyricaPlain
    return new Response(JSON.stringify(payload), { status: 200 })
  }) as typeof fetch
  try {
    new LyricsService().clearCache()
    await callback(calls)
  } finally {
    globalThis.fetch = original
  }
}

const lyricaPayload = (overrides: Record<string, unknown> = {}) => ({
  status: 'success',
  data: {
    source: 'youtube_music',
    artist: 'Test Artist',
    title: 'Test Song',
    plain_lyrics: 'First line\nSecond line',
    timed_lyrics: [
      { text: 'First line', start_time: 0, end_time: 1_250, id: 1 },
      { text: 'Second line', start_time: 1_250, end_time: 2_500, id: 2 },
    ],
    metadata: { album: 'Test Album', duration: 180 },
    ...overrides,
  },
})

assert.equal(
  normalizeLyricsTitle('【Official MV】Song Title (Lyrics Video) 🎵'),
  'Song Title',
)
assert.deepEqual(extractCoverHints('夜に駆ける / YOASOBI covered by A'), {
  title: '夜に駆ける',
  originalArtist: 'YOASOBI',
})
assert.equal(
  extractCoverHints('Original Song - 歌ってみた').title,
  'Original Song',
)

await withFetch([candidate()], async () => {
  const result = await new LyricsService().lookup(track())
  assert.equal(result.status, 'found')
  assert.equal(result.autoMatch?.id, 1)
})

await withProviderFetch(
  { lrclib: [candidate()], lyricaSynced: lyricaPayload() },
  async (calls) => {
    const result = await new LyricsService().lookup(track())
    assert.equal(result.autoMatch?.provider, 'lrclib')
    assert.equal(calls.lyrica, 0)
  },
)

await withProviderFetch(
  { lrclib: [], lyricaSynced: lyricaPayload() },
  async (calls) => {
    const result = await new LyricsService().lookup(track())
    assert.equal(calls.lyrica, 1)
    assert.equal(result.candidates[0]?.provider, 'lyrica')
    assert.equal(result.candidates[0]?.sourceLabel, 'Lyrica · YouTube Music')
    assert.match(
      result.candidates[0]?.syncedLyrics ?? '',
      /\[00:01\.250\]Second line/,
    )
    assert.equal(result.autoMatch, undefined)
  },
)

await withProviderFetch(
  {
    lrclib: [],
    lyricaSynced: { status: 'error', error: { message: 'not found' } },
    lyricaPlain: lyricaPayload({
      source: 'netease',
      timed_lyrics: undefined,
      plain_lyrics: undefined,
      lyrics: '[Verse 1]\nPlain fallback lyrics',
    }),
  },
  async () => {
    const result = await new LyricsService().lookup(track())
    assert.equal(
      result.candidates[0]?.plainLyrics,
      '[Verse 1]\nPlain fallback lyrics',
    )
    assert.equal(result.candidates[0]?.syncedLyrics, undefined)
    assert.equal(result.candidates[0]?.sourceLabel, 'Lyrica · NetEase')
  },
)

await withProviderFetch(
  {
    lrclib: [
      candidate({
        trackName: 'Unrelated title',
        plainLyrics: 'Same lyrics body',
        syncedLyrics: undefined,
      }),
    ],
    lyricaSynced: lyricaPayload({
      plain_lyrics: 'Same lyrics body',
      timed_lyrics: undefined,
      lyrics: 'Same lyrics body',
    }),
  },
  async () => {
    const result = await new LyricsService().lookup(track())
    assert.equal(result.candidates.length, 1)
    assert.equal(result.candidates[0]?.provider, 'lrclib')
  },
)

await withProviderFetch({ lrclib: [], lyricaStatus: 500 }, async () => {
  const result = await new LyricsService().lookup(track())
  assert.equal(result.candidates.length, 0)
})

await withProviderFetch(
  { lrclib: [], lyricaSynced: lyricaPayload() },
  async (calls) => {
    const service = new LyricsService()
    await service.lookup(track())
    await service.lookup(track())
    assert.equal(calls.lyrica, 1)
  },
)

await withProviderFetch(
  {
    lrclib: [],
    lyricaSynced: lyricaPayload({ source: 'lrclib' }),
  },
  async () => {
    const result = await new LyricsService().lookup(track())
    assert.equal(result.autoMatch?.provider, 'lyrica')
    assert.equal(result.autoMatch?.providerSource, 'lrclib')
  },
)

await withFetch(
  [
    candidate({
      trackName: '夜に駆ける',
      artistName: 'YOASOBI',
      albumName: '',
    }),
  ],
  async () => {
    const result = await new LyricsService().lookup(
      track({
        title: '【歌ってみた】夜に駆ける / YOASOBI covered by A',
        artist: 'A',
        album: '',
      }),
    )
    assert.equal(result.originalArtist, 'YOASOBI')
    assert.equal(
      result.status,
      'low-confidence',
      'Japanese cover must stay manual',
    )
    assert.equal(result.candidates[0]?.trackName, '夜に駆ける')
  },
)

await withFetch(
  [candidate({ trackName: 'Song', artistName: 'Singer' })],
  async () => {
    const result = await new LyricsService().lookup(
      track({ title: 'Song - cover', artist: 'Cover Artist', album: '' }),
    )
    assert.equal(result.status, 'low-confidence', 'cover must stay manual')
    assert.equal(result.candidates.length, 1)
  },
)

await withFetch(
  [candidate({ trackName: 'Smile', artistName: 'Artist' })],
  async () => {
    const result = await new LyricsService().lookup(
      track({
        title: '✨ Smile (Official Music Video)',
        artist: 'Artist',
        album: '',
      }),
    )
    assert.equal(result.autoMatch?.trackName, 'Smile')
  },
)

await withFetch([candidate()], async () => {
  const result = await new LyricsService().lookup(track({ duration: 3600 }))
  assert.equal(
    result.status,
    'low-confidence',
    'long duration mismatch must stay manual',
  )
  assert.equal(result.autoMatch, undefined)
  assert.equal(result.candidates.length, 1)
})

await withFetch([candidate({ instrumental: true })], async () => {
  const result = await new LyricsService().lookup(track())
  assert.equal(result.status, 'instrumental')
  assert.equal(result.autoMatch?.instrumental, true)
})

await withFetch([candidate({ duration: 188 })], async () => {
  const result = await new LyricsService().lookup(track())
  assert.equal(result.autoMatch?.id, 1)
})

await withFetch([candidate(), candidate({ id: 2 })], async () => {
  const result = await new LyricsService().lookup(track())
  assert.equal(result.status, 'found')
  assert.equal(result.candidates.length, 1)
  assert.equal(result.autoMatch?.id, 1)
})

await withFetch(429, async () => {
  const result = await new LyricsService().lookup(
    track({ title: 'Rate Limit Test' }),
  )
  assert.equal(result.status, 'rate-limited')
})

await withFetch(new Error('offline'), async () => {
  const result = await new LyricsService().lookup(
    track({ title: 'Offline Test' }),
  )
  assert.equal(result.status, 'network-error')
})

await withFetch([], async () => {
  const result = await new LyricsService().lookup(
    track({ title: 'No Lyrics Here', artist: 'Nobody' }),
  )
  assert.equal(result.status, 'not-found')
})

const syncProfile = (
  anchors: Array<{ lyricTimeMs: number; audioTimeMs: number }>,
  offsetMs = 0,
) => ({
  trackId: 'a'.repeat(64),
  offsetMs,
  anchors,
  updatedAt: 1,
})

assert.equal(adjustLyricTimeMs(10_000, syncProfile([], 3_000)), 13_000)
assert.equal(
  adjustLyricTimeMs(
    10_000,
    syncProfile([{ lyricTimeMs: 5_000, audioTimeMs: 8_000 }]),
  ),
  13_000,
)
assert.equal(
  adjustLyricTimeMs(
    50_000,
    syncProfile([
      { lyricTimeMs: 0, audioTimeMs: 0 },
      { lyricTimeMs: 100_000, audioTimeMs: 102_000 },
    ]),
  ),
  51_000,
)
assert.ok(
  Math.abs(
    adjustLyricTimeMs(
      35_000,
      syncProfile([
        { lyricTimeMs: 0, audioTimeMs: 5_000 },
        { lyricTimeMs: 30_000, audioTimeMs: 35_000 },
        { lyricTimeMs: 60_000, audioTimeMs: 75_000 },
        { lyricTimeMs: 90_000, audioTimeMs: 105_000 },
      ]),
    ) - 41_666.6667,
  ) < 0.01,
)
assert.equal(adjustLyricTimeMs(100, syncProfile([], -1_000)), 0)
assert.throws(() =>
  validateLyricsSyncProfile(
    syncProfile([
      { lyricTimeMs: 10, audioTimeMs: 100 },
      { lyricTimeMs: 10, audioTimeMs: 200 },
    ]),
  ),
)

const sparseTimeline = [10, undefined, 25]
assert.equal(findActiveLyricLineIndex([10, 18], 9.999), -1)
assert.equal(findActiveLyricLineIndex([10, 18], 10), 0)
assert.equal(findActiveLyricLineIndex([10, 18], 17.999), 0)
assert.equal(findActiveLyricLineIndex([10, 18], 18), 1)
assert.equal(findActiveLyricLineIndex(sparseTimeline, 24.999), 0)
assert.equal(findActiveLyricLineIndex(sparseTimeline, 25), 2)
assert.equal(findActiveLyricLineIndex(sparseTimeline, 300), 2)
assert.equal(findActiveLyricLineIndex(sparseTimeline, 12), 0)
assert.equal(findActiveLyricLineIndex(sparseTimeline, Number.NaN), -1)

const generatedLyrics = '첫 줄\n둘째 줄\n셋째 줄'
assert.deepEqual(
  splitGeneratedLyricsText(
    '첫 줄\n[00:02.50] 둘째 줄\n[00:05.00] 셋째 줄\n[00:08.00]',
  ),
  ['첫 줄', '둘째 줄', '셋째 줄'],
)
const generatedTimeline = {
  trackId: 'a'.repeat(64),
  source: 'ai' as const,
  lineCount: 3,
  lyricsTextHash: generatedLyricsTextHash(generatedLyrics),
  lines: ['첫 줄', '둘째 줄', '셋째 줄'].map((text, lineIndex) => ({
    lineIndex,
    textHash: generatedLyricsLineHash(text),
    audioTimeMs: 1_000 + lineIndex * 2_000,
    confidence: 0.9,
  })),
  model: 'test-model',
  createdAt: 1,
}
assert.doesNotThrow(() =>
  validateGeneratedLyricsTimeline(generatedTimeline, generatedLyrics),
)
assert.throws(() =>
  validateGeneratedLyricsTimeline(generatedTimeline, '첫 줄\n바뀐 줄\n셋째 줄'),
)
assert.throws(() =>
  validateGeneratedLyricsTimeline(
    generatedTimeline,
    `${generatedLyrics}\n넷째 줄`,
  ),
)
assert.throws(() =>
  validateGeneratedLyricsTimeline(
    {
      ...generatedTimeline,
      lines: generatedTimeline.lines.map((line, index) =>
        index === 1 ? { ...line, confidence: 0.7 } : line,
      ),
    },
    generatedLyrics,
  ),
)
assert.throws(() =>
  validateGeneratedLyricsTimeline(
    {
      ...generatedTimeline,
      lines: generatedTimeline.lines.map((line, index) =>
        index === 1 ? { ...line, audioTimeMs: 500 } : line,
      ),
    },
    generatedLyrics,
  ),
)
assert.throws(() =>
  validateLyricsSyncProfile(
    syncProfile([
      { lyricTimeMs: 10, audioTimeMs: 200 },
      { lyricTimeMs: 20, audioTimeMs: 100 },
    ]),
  ),
)

await withFetch([], async () => {
  const result = await new LyricsService().lookup(
    track({ title: '', artist: '' }),
  )
  assert.equal(result.status, 'metadata-missing')
})
