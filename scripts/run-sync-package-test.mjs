import { build } from 'vite'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const outputRoot = path.join(process.cwd(), 'node_modules', '.tmp')
await mkdir(outputRoot, { recursive: true })
const output = await mkdtemp(path.join(outputRoot, 'pulse-shelf-sync-package-'))
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
