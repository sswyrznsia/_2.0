import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'vite'

const resultPath = process.argv[2]
if (!resultPath) throw new Error('Usage: node verify-profile.mjs <result.json>')

const result = JSON.parse(await readFile(resolve(resultPath), 'utf8'))
const profiles = result.lyricsSyncProfile
  ? [result.lyricsSyncProfile]
  : (result.variants ?? []).map((variant) => variant.pipeline.lyricsSyncProfile)
if (!profiles.length) throw new Error('No lyricsSyncProfile found in result')
const server = await createServer({ server: { middlewareMode: true } })
try {
  const { validateLyricsSyncProfile } = await server.ssrLoadModule(
    '/src/utils/lyricsSync.ts',
  )
  const validated = profiles.map((profile) => validateLyricsSyncProfile(profile))
  console.log(
    JSON.stringify({
      compatible: true,
      profileCount: validated.length,
      profiles: validated.map((profile) => ({
        trackId: profile.trackId,
        offsetMs: profile.offsetMs,
        anchorCount: profile.anchors.length,
      })),
    }),
  )
} finally {
  await server.close()
}
