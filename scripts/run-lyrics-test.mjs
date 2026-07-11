import { build } from 'vite'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const output = await mkdtemp(path.join(os.tmpdir(), 'pulse-shelf-lyrics-'))
try {
  await build({
    configFile: false,
    logLevel: 'error',
    build: {
      ssr: path.resolve('scripts/lyrics-service.test.ts'),
      outDir: output,
      emptyOutDir: true,
    },
  })
  await import(pathToFileURL(path.join(output, 'lyrics-service.test.js')).href)
  process.stdout.write('PULSE_SHELF_LYRICS_TEST_OK\n')
} finally {
  await rm(output, { recursive: true, force: true })
}
