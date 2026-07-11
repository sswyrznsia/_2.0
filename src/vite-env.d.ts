/// <reference types="vite/client" />

import type { ElectronApi } from './types/ipc'

declare global {
  interface Window {
    electronAPI: ElectronApi
  }
}

export {}
