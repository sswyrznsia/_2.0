import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type {
  LyricsCandidate,
  LyricsResult,
  LyricsSearchQuery,
  LyricsSearchResult,
  LyricsSyncProfile,
} from '../../src/types/models'
import { getStoredData, setStoredData } from '../data'
import { LyricsService } from '../lyricsService'
import { validateLyricsSyncProfile } from '../../src/utils/lyricsSync'

const MAX_LYRICS_BYTES = 2 * 1024 * 1024
const lyricsService = new LyricsService()

export async function loadTrackLyrics(trackId: string): Promise<LyricsResult> {
  if (!/^[a-f0-9]{64}$/.test(trackId))
    throw new Error('올바르지 않은 곡 ID입니다.')
  const data = getStoredData()
  const track = data.tracks.find((item) => item.id === trackId)
  if (!track) return { kind: 'none', content: '' }
  const cached = data.lyrics[trackId]
  if (cached?.instrumental)
    return { kind: 'none', content: '', status: 'instrumental' }
  if (cached?.syncedLyrics)
    return { kind: 'lrc', content: cached.syncedLyrics, status: 'found' }
  if (cached?.plainLyrics)
    return { kind: 'text', content: cached.plainLyrics, status: 'found' }

  const basePath = track.filePath.slice(0, -path.extname(track.filePath).length)
  for (const [extension, kind] of [
    ['.lrc', 'lrc'],
    ['.txt', 'text'],
  ] as const) {
    const lyricsPath = `${basePath}${extension}`
    try {
      const fileStats = await stat(lyricsPath)
      if (!fileStats.isFile() || fileStats.size > MAX_LYRICS_BYTES) continue
      const content = (await readFile(lyricsPath, 'utf8'))
        .replace(/^\uFEFF/, '')
        .trim()
      if (content) return { kind, content, status: 'found' }
    } catch {
      // A missing sidecar is the normal no-lyrics case.
    }
  }
  if (!data.settings.autoFetchLyricsOnPlay) return { kind: 'none', content: '' }
  try {
    const lookup = await lyricsService.lookup(
      track,
      data.settings.lyricsAutoMatchThreshold,
    )
    const match = lookup.autoMatch
    if (!match) return { kind: 'none', content: '', status: lookup.status }
    data.lyrics[trackId] = {
      trackId,
      source: 'lrclib',
      syncedLyrics: match.syncedLyrics,
      plainLyrics: match.plainLyrics,
      instrumental: match.instrumental,
      providerTrackId: match.id,
      fetchedAt: Date.now(),
      matchedTitle: match.trackName,
      matchedArtist: match.artistName,
      userSelected: false,
    }
    setStoredData(data)
    if (match.syncedLyrics)
      return { kind: 'lrc', content: match.syncedLyrics, status: 'found' }
    if (match.plainLyrics)
      return { kind: 'text', content: match.plainLyrics, status: 'found' }
    return { kind: 'none', content: '', status: 'instrumental' }
  } catch {
    return { kind: 'none', content: '', status: 'network-error' }
  }
  return { kind: 'none', content: '' }
}

export async function searchTrackLyrics(
  trackId: string,
  query?: LyricsSearchQuery,
): Promise<LyricsSearchResult> {
  const track = getStoredData().tracks.find((item) => item.id === trackId)
  if (!track)
    return { status: 'metadata-missing', candidates: [], normalizedTitle: '' }
  return lyricsService.lookup(track, 1.1, query)
}

export function saveLyricsSelection(
  trackId: string,
  candidate: LyricsCandidate,
): LyricsResult {
  const data = getStoredData()
  if (!data.tracks.some((track) => track.id === trackId))
    return { kind: 'none', content: '' }
  data.lyrics[trackId] = {
    trackId,
    source: 'lrclib',
    syncedLyrics: candidate.syncedLyrics,
    plainLyrics: candidate.plainLyrics,
    instrumental: candidate.instrumental,
    providerTrackId: candidate.id,
    fetchedAt: Date.now(),
    matchedTitle: candidate.trackName,
    matchedArtist: candidate.artistName,
    userSelected: true,
  }
  delete data.lyricsSyncProfiles[trackId]
  setStoredData(data)
  if (candidate.syncedLyrics)
    return { kind: 'lrc', content: candidate.syncedLyrics }
  if (candidate.plainLyrics)
    return { kind: 'text', content: candidate.plainLyrics }
  return { kind: 'none', content: '' }
}

export function removeTrackLyrics(trackId: string) {
  const data = getStoredData()
  delete data.lyrics[trackId]
  delete data.lyricsSyncProfiles[trackId]
  setStoredData(data)
}

export function markTrackInstrumental(trackId: string) {
  const data = getStoredData()
  if (!data.tracks.some((track) => track.id === trackId)) return
  data.lyrics[trackId] = {
    trackId,
    source: 'manual',
    instrumental: true,
    fetchedAt: Date.now(),
    userSelected: true,
  }
  delete data.lyricsSyncProfiles[trackId]
  setStoredData(data)
}

export async function autoFetchImportedTrackLyrics(trackId: string) {
  const data = getStoredData()
  if (!data.settings.autoFetchLyricsOnImport || data.lyrics[trackId]) return
  const track = data.tracks.find((item) => item.id === trackId)
  if (!track) return
  const lookup = await lyricsService.lookup(
    track,
    data.settings.lyricsAutoMatchThreshold,
  )
  const match = lookup.autoMatch
  if (!match) return
  data.lyrics[trackId] = {
    trackId,
    source: 'lrclib',
    syncedLyrics: match.syncedLyrics,
    plainLyrics: match.plainLyrics,
    instrumental: match.instrumental,
    providerTrackId: match.id,
    fetchedAt: Date.now(),
    matchedTitle: match.trackName,
    matchedArtist: match.artistName,
    userSelected: false,
  }
  setStoredData(data)
}

export function clearLyricsCache() {
  lyricsService.clearCache()
}

export async function reloadTrackLyrics(
  trackId: string,
): Promise<LyricsResult> {
  const data = getStoredData()
  delete data.lyrics[trackId]
  delete data.lyricsSyncProfiles[trackId]
  setStoredData(data)
  return loadTrackLyrics(trackId)
}

export function getLyricsSyncProfile(trackId: string) {
  return getStoredData().lyricsSyncProfiles[trackId] ?? null
}

export function saveLyricsSyncProfile(profile: LyricsSyncProfile) {
  const validated = validateLyricsSyncProfile(profile)
  const data = getStoredData()
  if (!data.tracks.some((track) => track.id === validated.trackId))
    throw new Error('Track not found')
  data.lyricsSyncProfiles[validated.trackId] = validated
  setStoredData(data)
  return validated
}

export function clearLyricsSyncProfile(trackId: string) {
  const data = getStoredData()
  delete data.lyricsSyncProfiles[trackId]
  setStoredData(data)
}
