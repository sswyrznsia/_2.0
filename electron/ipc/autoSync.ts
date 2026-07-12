import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { IPC } from '../../src/types/ipc'
import type { AutoSyncAvailability, AutoSyncJob } from '../../src/types/models'

const trackIdSchema = z.string().regex(/^[a-f0-9]{64}$/)
const jobIdSchema = z.string().uuid()

export interface AutoSyncIpcService {
  getAvailability: (
    trackId: string,
  ) => AutoSyncAvailability | Promise<AutoSyncAvailability>
  start: (trackId: string) => AutoSyncJob | Promise<AutoSyncJob>
  cancel: (jobId: string) => boolean | Promise<boolean>
  getJob: (trackId: string) => AutoSyncJob | null | Promise<AutoSyncJob | null>
  discard: (jobId: string) => boolean | Promise<boolean>
}

export function registerAutoSyncIpc(options: {
  service: AutoSyncIpcService
  assertMainSender: (event: IpcMainInvokeEvent) => void
}) {
  ipcMain.handle(
    IPC.lyricsAutoSyncGetAvailability,
    (event, trackId: unknown) => {
      options.assertMainSender(event)
      return options.service.getAvailability(trackIdSchema.parse(trackId))
    },
  )
  ipcMain.handle(IPC.lyricsAutoSyncStart, (event, trackId: unknown) => {
    options.assertMainSender(event)
    return options.service.start(trackIdSchema.parse(trackId))
  })
  ipcMain.handle(IPC.lyricsAutoSyncCancel, (event, jobId: unknown) => {
    options.assertMainSender(event)
    return options.service.cancel(jobIdSchema.parse(jobId))
  })
  ipcMain.handle(IPC.lyricsAutoSyncGetActiveJob, (event, trackId: unknown) => {
    options.assertMainSender(event)
    return options.service.getJob(trackIdSchema.parse(trackId))
  })
  ipcMain.handle(IPC.lyricsAutoSyncDiscard, (event, jobId: unknown) => {
    options.assertMainSender(event)
    return options.service.discard(jobIdSchema.parse(jobId))
  })
}
