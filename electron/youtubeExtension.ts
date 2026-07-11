import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Session } from 'electron'
import ElectronStore from 'electron-store'
import log from 'electron-log/main'
import { z } from 'zod'

export const YOUTUBE_PARTITION = 'persist:pulse-shelf-youtube'

export type YouTubeExtensionLoadState =
  | 'not-configured'
  | 'loaded'
  | 'disabled'
  | 'missing'
  | 'manifest-error'
  | 'load-error'

export interface YouTubeExtensionSettings {
  enabled: boolean
  extensionPath?: string
  extensionId?: string
}

export interface YouTubeExtensionStatus extends YouTubeExtensionSettings {
  name?: string
  version?: string
  loadState: YouTubeExtensionLoadState
  error?: string
}

const manifestSchema = z.object({
  manifest_version: z.number().int().min(2).max(3),
  name: z.string().trim().min(1).max(200),
  version: z.string().trim().min(1).max(100),
})

const persistedSchema = z.object({
  enabled: z.boolean().default(false),
  extensionPath: z.string().min(1).max(32_767).optional(),
  extensionId: z.string().min(1).max(500).optional(),
})

interface ExtensionMetadata {
  path: string
  name: string
  version: string
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 500)
}

function userLoadError(error: unknown) {
  const message = safeError(error).toLowerCase()
  if (message.includes('manifest'))
    return 'Electron이 이 확장 프로그램의 manifest를 지원하지 않습니다.'
  if (message.includes('permission'))
    return '확장 프로그램 권한을 Electron에서 처리할 수 없습니다.'
  return 'Electron이 이 확장 프로그램을 로드하지 못했습니다. 지원되지 않는 API 또는 확장 구조일 수 있습니다.'
}

export class YouTubeExtensionManager {
  private readonly store = new ElectronStore<YouTubeExtensionSettings>({
    name: 'youtube-extension',
    defaults: { enabled: false },
  })
  private status: YouTubeExtensionStatus = {
    enabled: false,
    loadState: 'not-configured',
  }

  constructor(
    private readonly getSession: () => Session,
    private readonly onExtensionChanged: () => void,
  ) {
    const settings = persistedSchema.safeParse(this.store.store)
    if (settings.success) this.store.store = settings.data
    else this.store.store = { enabled: false }
    this.status = this.statusFromSettings(this.store.store)
  }

  getStatus(): YouTubeExtensionStatus {
    return { ...this.status }
  }

  async restore(): Promise<YouTubeExtensionStatus> {
    const settings = this.store.store
    if (!settings.enabled || !settings.extensionPath) {
      this.status = this.statusFromSettings(settings)
      return this.getStatus()
    }
    return this.load(settings.extensionPath, false)
  }

  async select(pathname: string): Promise<YouTubeExtensionStatus> {
    const manifest = await this.validate(pathname)
    this.store.store = {
      enabled: false,
      extensionPath: manifest.path,
      extensionId: undefined,
    }
    this.status = {
      enabled: false,
      extensionPath: manifest.path,
      name: manifest.name,
      version: manifest.version,
      loadState: 'disabled',
    }
    return this.getStatus()
  }

  async load(
    pathname = this.store.get('extensionPath'),
    refreshView = true,
  ): Promise<YouTubeExtensionStatus> {
    if (!pathname) {
      this.status = { enabled: false, loadState: 'not-configured' }
      return this.getStatus()
    }

    let manifest: ExtensionMetadata
    try {
      manifest = await this.validate(pathname)
    } catch (error) {
      this.status = {
        enabled: false,
        extensionPath: pathname,
        loadState: this.isMissing(pathname) ? 'missing' : 'manifest-error',
        error: safeError(error),
      }
      this.store.set('enabled', false)
      return this.getStatus()
    }

    const youtubeSession = this.getSession()
    try {
      const existing = youtubeSession.extensions
        .getAllExtensions()
        .find((extension) => extension.path === manifest.path)
      const extension = existing ??
        (await youtubeSession.extensions.loadExtension(manifest.path))
      this.store.store = {
        enabled: true,
        extensionPath: manifest.path,
        extensionId: extension.id,
      }
      this.status = {
        enabled: true,
        extensionPath: manifest.path,
        extensionId: extension.id,
        name: extension.name || manifest.name,
        version: extension.version || manifest.version,
        loadState: 'loaded',
      }
      log.info('YouTube extension loaded', {
        name: this.status.name,
        version: this.status.version,
        id: this.status.extensionId,
        partition: YOUTUBE_PARTITION,
      })
      if (refreshView) this.onExtensionChanged()
    } catch (error) {
      this.store.set('enabled', false)
      this.status = {
        enabled: false,
        extensionPath: manifest.path,
        name: manifest.name,
        version: manifest.version,
        loadState: 'load-error',
        error: userLoadError(error),
      }
      log.warn('YouTube extension failed to load', {
        name: manifest.name,
        partition: YOUTUBE_PARTITION,
        error: safeError(error),
      })
    }
    return this.getStatus()
  }

  async reload(): Promise<YouTubeExtensionStatus> {
    const settings = this.store.store
    if (!settings.extensionPath) return this.load()
    await this.unload(settings.extensionId)
    return this.load(settings.extensionPath)
  }

  async disable(): Promise<YouTubeExtensionStatus> {
    const settings = this.store.store
    await this.unload(settings.extensionId)
    this.store.store = { ...settings, enabled: false, extensionId: undefined }
    this.status = {
      ...this.statusFromSettings(this.store.store),
      loadState: this.store.get('extensionPath') ? 'disabled' : 'not-configured',
    }
    this.onExtensionChanged()
    return this.getStatus()
  }

  async remove(): Promise<YouTubeExtensionStatus> {
    await this.unload(this.store.get('extensionId'))
    this.store.store = { enabled: false }
    this.status = { enabled: false, loadState: 'not-configured' }
    this.onExtensionChanged()
    return this.getStatus()
  }

  private async unload(extensionId?: string) {
    if (!extensionId) return
    const youtubeSession = this.getSession()
    if (youtubeSession.extensions.getAllExtensions().some((item) => item.id === extensionId))
      await youtubeSession.extensions.removeExtension(extensionId)
  }

  private statusFromSettings(
    settings: YouTubeExtensionSettings,
  ): YouTubeExtensionStatus {
    if (!settings.extensionPath)
      return { enabled: false, loadState: 'not-configured' }
    return {
      ...settings,
      loadState: settings.enabled ? 'load-error' : 'disabled',
    }
  }

  private isMissing(pathname: string) {
    return !existsSync(pathname) || !existsSync(path.join(pathname, 'manifest.json'))
  }

  private async validate(pathname: string): Promise<ExtensionMetadata> {
    const resolved = path.resolve(pathname)
    const folder = await stat(resolved)
    if (!folder.isDirectory()) throw new Error('확장 프로그램 폴더가 아닙니다.')
    const manifestPath = path.join(resolved, 'manifest.json')
    const manifestFile = await stat(manifestPath)
    if (!manifestFile.isFile()) throw new Error('manifest.json 파일이 없습니다.')
    if (manifestFile.size > 2 * 1024 * 1024)
      throw new Error('manifest.json 파일이 너무 큽니다.')
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch {
      throw new Error('manifest.json을 읽거나 JSON으로 해석할 수 없습니다.')
    }
    const result = manifestSchema.safeParse(parsed)
    if (!result.success)
      throw new Error('manifest.json에 name, version 또는 manifest_version이 올바르지 않습니다.')
    return { path: resolved, name: result.data.name, version: result.data.version }
  }
}
