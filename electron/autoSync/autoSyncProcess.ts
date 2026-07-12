import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import readline from 'node:readline'
import {
  AutoSyncError,
  classifyAutoSyncFailure,
  normalizeAutoSyncErrorCode,
} from './autoSyncErrors'
import {
  parseAutoSyncWorkerEvent,
  type AutoSyncLogger,
  type AutoSyncWorkerEvent,
} from './autoSyncTypes'

const MAX_STDERR_BYTES = 2 * 1024 * 1024
const MAX_LOGGED_STDOUT_BYTES = 2 * 1024 * 1024
const KILL_TIMEOUT_MS = 8_000

export interface AutoSyncProcessOptions {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  logger: AutoSyncLogger
}

export interface AutoSyncProcessResult {
  exitCode: number
  stderr: string
}

export class AutoSyncProcess {
  private child: ChildProcess | null = null
  private cancelled = false
  private closePromise: Promise<void> | null = null

  constructor(private readonly options: AutoSyncProcessOptions) {}

  async run(
    onEvent: (event: AutoSyncWorkerEvent) => void,
  ): Promise<AutoSyncProcessResult> {
    if (this.child) throw new AutoSyncError('duplicate-job')
    let stderr = ''
    let loggedStdoutBytes = 0
    const state: {
      failedEvent?: Extract<AutoSyncWorkerEvent, { event: 'failed' }>
    } = {}
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    this.closePromise = once(child, 'close')
      .then(() => undefined)
      .catch(() => undefined)
    const output = readline.createInterface({ input: child.stdout })
    output.on('line', (line) => {
      const event = parseAutoSyncWorkerEvent(line)
      if (!event) {
        const bytes = Buffer.byteLength(line)
        if (line.trim() && loggedStdoutBytes < MAX_LOGGED_STDOUT_BYTES)
          this.options.logger.info('Auto-sync worker output', line)
        loggedStdoutBytes += bytes
        return
      }
      if (event.event === 'failed') state.failedEvent = event
      onEvent(event)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length >= MAX_STDERR_BYTES) return
      stderr += chunk.slice(0, MAX_STDERR_BYTES - stderr.length)
    })

    let exitCode: number
    try {
      exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code) => resolve(code ?? -1))
      })
    } catch (error) {
      if (this.cancelled) throw new AutoSyncError('cancelled')
      throw new AutoSyncError('process-failed', undefined, { cause: error })
    } finally {
      output.close()
      this.child = null
    }

    if (this.cancelled) throw new AutoSyncError('cancelled')
    if (state.failedEvent) {
      if (stderr.trim())
        this.options.logger.error('Auto-sync worker failure details', stderr)
      throw new AutoSyncError(
        normalizeAutoSyncErrorCode(state.failedEvent.code),
        undefined,
        { cause: new Error(state.failedEvent.message) },
      )
    }
    if (exitCode !== 0) {
      if (stderr.trim())
        this.options.logger.error('Auto-sync worker failure details', stderr)
      throw classifyAutoSyncFailure(stderr)
    }
    return { exitCode, stderr }
  }

  async cancel(): Promise<void> {
    this.cancelled = true
    const child = this.child
    if (!child?.pid) return
    child.kill()
    if (process.platform === 'win32') {
      const killer = spawn(
        'taskkill.exe',
        ['/PID', String(child.pid), '/T', '/F'],
        {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        },
      )
      await Promise.race([
        once(killer, 'close').catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ])
    }
    if (this.closePromise)
      await Promise.race([
        this.closePromise.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, KILL_TIMEOUT_MS)),
      ])
  }
}
