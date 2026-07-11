import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { IPC } from '../../src/types/ipc'
import { extractYouTubeVideoId } from '../../src/utils/youtube'
import type { MediaImportService } from '../import/mediaImportService'

const requestSchema = z.object({
  url: z.string().url().startsWith('https://').max(2048),
  source: z.literal('youtube'),
  replaceExisting: z.boolean().optional(),
})
const jobIdSchema = z.string().uuid()

export function registerMediaImportIpc(options: {
  service: MediaImportService
  assertMainSender: (event: IpcMainInvokeEvent) => void
  currentYouTubeUrl: () => string
}) {
  ipcMain.handle(IPC.mediaImportGetAvailability, (event) => {
    options.assertMainSender(event)
    return options.service.getAvailability()
  })
  ipcMain.handle(IPC.mediaImportGetJobs, (event) => {
    options.assertMainSender(event)
    return options.service.getJobs()
  })
  ipcMain.handle(IPC.mediaImportStart, (event, value: unknown) => {
    options.assertMainSender(event)
    const request = requestSchema.parse(value)
    if (request.source === 'youtube') {
      const currentUrl = options.currentYouTubeUrl()
      const currentId = extractYouTubeVideoId(currentUrl)
      const requestedId = extractYouTubeVideoId(request.url)
      if (!currentId || currentId !== requestedId)
        throw new Error('현재 YouTube 영상 주소가 변경되었습니다.')
      request.url = currentUrl
    }
    return options.service.start(request)
  })
  ipcMain.handle(IPC.mediaImportCancel, (event, value: unknown) => {
    options.assertMainSender(event)
    return options.service.cancel(jobIdSchema.parse(value))
  })
}
