import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import electron from 'electron'

const harnessRoot = await mkdtemp(
  path.join(os.tmpdir(), 'pulse-shelf-extension-test-'),
)
const child = spawn(electron, ['--no-sandbox', '--disable-gpu', '.'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PULSE_SHELF_YOUTUBE_EXTENSION_TEST: '1',
    PULSE_SHELF_TEST_USER_DATA: path.join(harnessRoot, 'user-data'),
    ELECTRON_DISABLE_GPU: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
child.stdout.on('data', (chunk) => {
  output += chunk.toString()
  process.stdout.write(chunk)
})
child.stderr.on('data', (chunk) => process.stderr.write(chunk))
await once(child, 'exit')
await rm(harnessRoot, { recursive: true, force: true }).catch(() => undefined)
if (!output.includes('PULSE_SHELF_YOUTUBE_EXTENSION_TEST_OK')) process.exitCode = 1
