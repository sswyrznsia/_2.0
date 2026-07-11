import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import electron from 'electron'

for (const scale of [undefined, 1, 1.25, 1.5]) {
  const label = scale ?? 'native'
  const userData = await mkdtemp(
    path.join(os.tmpdir(), `pulse-shelf-taskbar-${label}-`),
  )
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        electron,
        [
          '.',
          '--no-sandbox',
          '--disable-gpu',
          ...(scale ? [`--force-device-scale-factor=${scale}`] : []),
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PULSE_SHELF_TASKBAR_GEOMETRY_TEST: '1',
            ...(scale
              ? { PULSE_SHELF_TASKBAR_EXPECTED_SCALE: String(scale) }
              : {}),
            PULSE_SHELF_TEST_USER_DATA: userData,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let output = ''
      child.stdout.on('data', (chunk) => {
        output += chunk.toString()
        process.stdout.write(chunk)
      })
      child.stderr.on('data', (chunk) => process.stderr.write(chunk))
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0 && output.includes('PULSE_SHELF_TASKBAR_DISPLAY_OK='))
          resolve()
        else reject(new Error(`Taskbar scale ${label} test failed`))
      })
    })
  } finally {
    await rm(userData, { recursive: true, force: true }).catch(() => undefined)
  }
}

process.stdout.write('PULSE_SHELF_TASKBAR_GEOMETRY_TEST_OK\n')
