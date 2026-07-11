import type { ChildProcess } from 'node:child_process'
import type { MediaImportJob, MediaImportRequest } from '../../src/types/models'

export interface QueuedImport {
  job: MediaImportJob
  request: MediaImportRequest
  controller: AbortController
  process?: ChildProcess
}

export interface ImportMetadata {
  id?: string
  title: string
  artist?: string
  album?: string
  duration?: number
  thumbnail?: string
  fileSize?: number
}
