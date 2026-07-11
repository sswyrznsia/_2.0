import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const screenshots = [
  'taskbar-mode-windows-taskbar.png',
  'taskbar-toggle-windows-taskbar.png',
].map((name) => path.join(root, 'artifacts', 'home-layout', name))
const before = await Promise.all(
  screenshots.map((screenshot) => stat(screenshot).catch(() => undefined)),
)
const startedAt = Date.now()

const code = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/run-ui-test.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      PULSE_SHELF_CAPTURE_DESKTOP: '1',
      PULSE_SHELF_TASKBAR_TEST: '1',
    },
    stdio: 'inherit',
  })
  child.once('error', reject)
  child.once('exit', resolve)
})

if (code !== 0) throw new Error(`Taskbar capture UI test exited with ${code}`)
const captured = await Promise.all(
  screenshots.map((screenshot) => stat(screenshot).catch(() => undefined)),
)
for (const [index, result] of captured.entries()) {
  if (
    !result ||
    result.size < 10_000 ||
    result.mtimeMs < startedAt ||
    (before[index] && result.mtimeMs === before[index].mtimeMs)
  )
    throw new Error(
      `A fresh taskbar screenshot was not captured: ${screenshots[index]}`,
    )
}

process.stdout.write(
  `PULSE_SHELF_TASKBAR_CAPTURE_OK=${screenshots.join(',')}\n`,
)
