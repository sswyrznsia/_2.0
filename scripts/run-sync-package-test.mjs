import { build } from 'vite'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const output = await mkdtemp(
  path.join(os.tmpdir(), 'pulse-shelf-sync-package-'),
)
try {
  await build({
    configFile: false,
    logLevel: 'error',
    ssr: { noExternal: ['zod', 'electron-store'] },
    build: {
      ssr: path.resolve('scripts/sync-package.test.ts'),
      outDir: output,
      emptyOutDir: true,
    },
  })
  await import(pathToFileURL(path.join(output, 'sync-package.test.js')).href)
} finally {
  await rm(output, { recursive: true, force: true })
}
