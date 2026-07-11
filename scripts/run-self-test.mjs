import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import electron from 'electron'

const harnessRoot = await mkdtemp(
  path.join(os.tmpdir(), 'pulse-shelf-harness-'),
)
const child = spawn(electron, ['--no-sandbox', '--disable-gpu', '.'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PULSE_SHELF_SELF_TEST: '1',
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
child.on('error', (error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
child.on('exit', async (code) => {
  const tempMatch = output.match(/PULSE_SHELF_SELF_TEST_TEMP=([^\r\n]+)/)
  if (tempMatch && process.env.PULSE_SHELF_KEEP_TEST_DATA !== '1') {
    const tempPath = Buffer.from(tempMatch[1], 'base64').toString('utf8')
    await rm(tempPath, { recursive: true, force: true }).catch(() => undefined)
  }
  await rm(harnessRoot, { recursive: true, force: true }).catch(() => undefined)
  if (code !== 0 || !output.includes('PULSE_SHELF_SELF_TEST_OK'))
    process.exitCode = 1
})
