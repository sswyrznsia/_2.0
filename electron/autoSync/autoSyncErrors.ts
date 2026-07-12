import type { AutoSyncErrorCode } from '../../src/types/models'

const messages: Record<AutoSyncErrorCode, string> = {
  'python-missing': '자동 싱크용 Python 실행 환경을 찾지 못했습니다.',
  'package-missing': '자동 싱크에 필요한 Python 패키지가 준비되지 않았습니다.',
  'separator-model-missing': '보컬 분리 모델을 찾지 못했습니다.',
  'whisper-model-missing': 'Whisper large-v3 모델 캐시를 찾지 못했습니다.',
  'cuda-unavailable': 'CUDA를 사용할 수 있는 NVIDIA GPU가 필요합니다.',
  'gpu-out-of-memory': 'GPU 메모리가 부족해 자동 싱크를 완료하지 못했습니다.',
  'ffmpeg-missing': 'FFmpeg 실행 파일을 찾지 못했습니다.',
  'audio-missing': '원본 오디오 파일을 찾지 못했습니다.',
  'plain-lyrics-missing': '두 줄 이상의 일반 가사가 필요합니다.',
  'synced-lyrics-missing':
    '현재 PoC에는 원본 타임스탬프가 있는 동기화 가사가 필요합니다.',
  'separation-failed': '보컬 분리에 실패했습니다.',
  'transcription-failed': 'Whisper 음성 분석에 실패했습니다.',
  'matching-failed': '가사 줄을 음성과 연결하지 못했습니다.',
  'profile-invalid': '생성된 싱크 기준점을 안전하게 사용할 수 없습니다.',
  'duplicate-job': '다른 자동 싱크 작업이 이미 진행 중입니다.',
  cancelled: '자동 싱크를 취소했습니다.',
  'process-failed': '자동 싱크 프로세스가 비정상적으로 종료되었습니다.',
  'service-unavailable': '자동 싱크 실행 환경이 준비되지 않았습니다.',
}

export class AutoSyncError extends Error {
  constructor(
    public readonly code: AutoSyncErrorCode,
    message = messages[code],
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AutoSyncError'
  }
}

export function autoSyncErrorMessage(code: AutoSyncErrorCode): string {
  return messages[code]
}

const knownCodes = new Set<AutoSyncErrorCode>(
  Object.keys(messages) as AutoSyncErrorCode[],
)

export function normalizeAutoSyncErrorCode(value: string): AutoSyncErrorCode {
  const normalized = value.trim().toLowerCase().replaceAll('_', '-')
  const aliases: Record<string, AutoSyncErrorCode> = {
    python: 'python-missing',
    package: 'package-missing',
    model: 'separator-model-missing',
    cuda: 'cuda-unavailable',
    oom: 'gpu-out-of-memory',
    ffmpeg: 'ffmpeg-missing',
    audio: 'audio-missing',
    separation: 'separation-failed',
    transcription: 'transcription-failed',
    matching: 'matching-failed',
    profile: 'profile-invalid',
    process: 'process-failed',
    'cuda-oom': 'gpu-out-of-memory',
    'gpu-oom': 'gpu-out-of-memory',
    'audio-not-found': 'audio-missing',
    'model-missing': 'separator-model-missing',
    'separator-model': 'separator-model-missing',
    'whisper-model': 'whisper-model-missing',
    'separating-failed': 'separation-failed',
    'whisper-failed': 'transcription-failed',
    'validation-failed': 'profile-invalid',
    'user-cancelled': 'cancelled',
  }
  const code = aliases[normalized] ?? normalized
  return knownCodes.has(code as AutoSyncErrorCode)
    ? (code as AutoSyncErrorCode)
    : 'process-failed'
}

export function classifyAutoSyncFailure(details: string): AutoSyncError {
  const value = details.toLowerCase()
  if (
    value.includes('out of memory') ||
    value.includes('cuda_error_out_of_memory') ||
    value.includes('cublas_status_alloc_failed')
  )
    return new AutoSyncError('gpu-out-of-memory')
  if (
    value.includes('no module named') ||
    value.includes('modulenotfounderror')
  )
    return new AutoSyncError('package-missing')
  if (
    value.includes('ffmpeg') &&
    (value.includes('not found') || value.includes('missing'))
  )
    return new AutoSyncError('ffmpeg-missing')
  if (value.includes('cuda') && value.includes('not available'))
    return new AutoSyncError('cuda-unavailable')
  if (value.includes('bs-roformer') || value.includes('audio_separator'))
    return new AutoSyncError('separation-failed')
  if (value.includes('whisper') || value.includes('ctranslate2'))
    return new AutoSyncError('transcription-failed')
  return new AutoSyncError('process-failed')
}

export function toAutoSyncError(error: unknown): AutoSyncError {
  if (error instanceof AutoSyncError) return error
  if (error instanceof Error)
    return new AutoSyncError('process-failed', undefined, { cause: error })
  return new AutoSyncError('process-failed')
}
