import assert from 'node:assert/strict'
import type { LyricsCandidate, Track } from '../src/types/models'
import {
  extractCoverHints,
  LyricsService,
  normalizeLyricsTitle,
} from '../electron/lyricsService'
import { adjustLyricTimeMs, validateLyricsSyncProfile } from '../src/utils/lyricsSync'

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

const candidate = (overrides: Partial<LyricsCandidate> = {}): LyricsCandidate => ({
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
    if (typeof response === 'number') return new Response('', { status: response })
    return new Response(JSON.stringify(response), { status: 200 })
  }) as typeof fetch
  try {
    new LyricsService().clearCache()
    await callback()
  } finally {
    globalThis.fetch = original
  }
}

assert.equal(
  normalizeLyricsTitle('【Official MV】Song Title (Lyrics Video) 🎵'),
  'Song Title',
)
assert.deepEqual(extractCoverHints('夜に駆ける / YOASOBI covered by A'), {
  title: '夜に駆ける',
  originalArtist: 'YOASOBI',
})
assert.equal(extractCoverHints('Original Song - 歌ってみた').title, 'Original Song')

await withFetch([candidate()], async () => {
  const result = await new LyricsService().lookup(track())
  assert.equal(result.status, 'found')
  assert.equal(result.autoMatch?.id, 1)
})

await withFetch(
  [candidate({ trackName: '夜に駆ける', artistName: 'YOASOBI', albumName: '' })],
  async () => {
    const result = await new LyricsService().lookup(
      track({
        title: '【歌ってみた】夜に駆ける / YOASOBI covered by A',
        artist: 'A',
        album: '',
      }),
    )
    assert.equal(result.originalArtist, 'YOASOBI')
    assert.equal(result.status, 'low-confidence')
    assert.equal(result.candidates[0]?.trackName, '夜に駆ける')
  },
)

await withFetch([candidate({ trackName: 'Song', artistName: 'Singer' })], async () => {
  const result = await new LyricsService().lookup(
    track({ title: 'Song - cover', artist: 'Cover Artist', album: '' }),
  )
  assert.equal(result.status, 'low-confidence')
  assert.equal(result.candidates.length, 1)
})

await withFetch([candidate({ trackName: 'Smile', artistName: 'Artist' })], async () => {
  const result = await new LyricsService().lookup(
    track({ title: '✨ Smile (Official Music Video)', artist: 'Artist', album: '' }),
  )
  assert.equal(result.autoMatch?.trackName, 'Smile')
})

await withFetch([candidate()], async () => {
  const result = await new LyricsService().lookup(track({ duration: 3600 }))
  assert.equal(result.status, 'low-confidence')
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
  assert.equal(result.status, 'low-confidence')
  assert.equal(result.autoMatch, undefined)
})

await withFetch(429, async () => {
  const result = await new LyricsService().lookup(track({ title: 'Rate Limit Test' }))
  assert.equal(result.status, 'rate-limited')
})

await withFetch(new Error('offline'), async () => {
  const result = await new LyricsService().lookup(track({ title: 'Offline Test' }))
  assert.equal(result.status, 'network-error')
})

await withFetch([], async () => {
  const result = await new LyricsService().lookup(
    track({ title: 'No Lyrics Here', artist: 'Nobody' }),
  )
  assert.equal(result.status, 'not-found')
})

const syncProfile = (anchors: Array<{ lyricTimeMs: number; audioTimeMs: number }>, offsetMs = 0) => ({
  trackId: 'a'.repeat(64),
  offsetMs,
  anchors,
  updatedAt: 1,
})

assert.equal(adjustLyricTimeMs(10_000, syncProfile([], 3_000)), 13_000)
assert.equal(
  adjustLyricTimeMs(10_000, syncProfile([{ lyricTimeMs: 5_000, audioTimeMs: 8_000 }])),
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
assert.throws(() =>
  validateLyricsSyncProfile(
    syncProfile([
      { lyricTimeMs: 10, audioTimeMs: 200 },
      { lyricTimeMs: 20, audioTimeMs: 100 },
    ]),
  ),
)

await withFetch([], async () => {
  const result = await new LyricsService().lookup(track({ title: '', artist: '' }))
  assert.equal(result.status, 'metadata-missing')
})
