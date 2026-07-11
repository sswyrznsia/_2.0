import { readFile, writeFile } from 'node:fs/promises'
import { dialog } from 'electron'
import type { DataTransferResult } from '../../src/types/models'
import {
  appDataSchema,
  getPublicData,
  migratePublicData,
  setPublicData,
} from '../data'

export async function exportAppData(): Promise<DataTransferResult> {
  const result = await dialog.showSaveDialog({
    title: 'Pulse Shelf 데이터 내보내기',
    defaultPath: `pulse-shelf-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON 백업', extensions: ['json'] }],
  })
  if (result.canceled || !result.filePath)
    return { success: false, cancelled: true, message: '' }
  await writeFile(
    result.filePath,
    JSON.stringify(getPublicData(), null, 2),
    'utf8',
  )
  return { success: true, cancelled: false, message: '데이터를 내보냈습니다.' }
}

export async function importAppData(): Promise<DataTransferResult> {
  const result = await dialog.showOpenDialog({
    title: 'Pulse Shelf 데이터 가져오기',
    properties: ['openFile'],
    filters: [{ name: 'JSON 백업', extensions: ['json'] }],
  })
  if (result.canceled || !result.filePaths[0])
    return { success: false, cancelled: true, message: '' }
  try {
    const raw = await readFile(result.filePaths[0], 'utf8')
    const parsed: unknown = JSON.parse(raw)
    const validation = appDataSchema.safeParse(migratePublicData(parsed))
    if (!validation.success) {
      return {
        success: false,
        cancelled: false,
        message: '백업 파일 형식이 올바르지 않습니다.',
      }
    }
    const data = setPublicData(validation.data, { preserveLyrics: false })
    return {
      success: true,
      cancelled: false,
      message: '데이터를 가져왔습니다.',
      data,
    }
  } catch {
    return {
      success: false,
      cancelled: false,
      message: '백업 파일을 읽지 못했습니다.',
    }
  }
}
