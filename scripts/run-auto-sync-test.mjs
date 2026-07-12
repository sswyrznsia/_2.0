import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'

const output = await mkdtemp(path.join(os.tmpdir(), 'pulse-shelf-auto-sync-'))
try {
  await build({
    configFile: false,
    logLevel: 'error',
    ssr: { noExternal: ['zod'] },
    build: {
      ssr: path.resolve('scripts/auto-sync-service.test.ts'),
      outDir: output,
      emptyOutDir: true,
    },
  })
  await import(
    pathToFileURL(path.join(output, 'auto-sync-service.test.js')).href
  )
  process.stdout.write('PULSE_SHELF_AUTO_SYNC_TEST_OK\n')
} finally {
  await rm(output, { recursive: true, force: true })
}
