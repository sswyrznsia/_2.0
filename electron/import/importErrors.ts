export type MediaImportErrorCode =
  | 'unsupported-url'
  | 'metadata-unavailable'
  | 'content-unavailable'
  | 'network-error'
  | 'insufficient-space'
  | 'output-unavailable'
  | 'service-unavailable'
  | 'cancelled'
  | 'processing-failed'
  | 'registration-failed'
  | 'duplicate-content'

const messages: Record<MediaImportErrorCode, string> = {
  'unsupported-url': '지원하지 않는 미디어 주소입니다.',
  'metadata-unavailable': '영상 정보를 읽을 수 없습니다.',
  'content-unavailable': '현재 사용할 수 없는 콘텐츠입니다.',
  'network-error': '네트워크 연결을 확인해 주세요.',
  'insufficient-space': '저장 공간이 부족합니다.',
  'output-unavailable': '가져오기 폴더에 파일을 저장할 수 없습니다.',
  'service-unavailable': '가져오기 서비스를 사용할 수 없습니다.',
  cancelled: '가져오기를 취소했습니다.',
  'processing-failed': '다운로드한 미디어를 처리하지 못했습니다.',
  'registration-failed': '완료 파일을 음악 라이브러리에 등록하지 못했습니다.',
  'duplicate-content': '이미 가져온 콘텐츠입니다.',
}

export class MediaImportError extends Error {
  constructor(
    public readonly code: MediaImportErrorCode,
    message = messages[code],
  ) {
    super(message)
    this.name = 'MediaImportError'
  }
}

export function classifyToolError(stderr: string): MediaImportError {
  const value = stderr.toLowerCase()
  if (value.includes('private video') || value.includes('video unavailable'))
    return new MediaImportError('content-unavailable')
  if (
    value.includes('http error') ||
    value.includes('unable to download') ||
    value.includes('network')
  )
    return new MediaImportError('network-error')
  if (value.includes('no space left') || value.includes('disk full'))
    return new MediaImportError('insufficient-space')
  return new MediaImportError('processing-failed')
}
