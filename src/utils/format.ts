export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0')}`
}

export function formatRelativeDate(timestamp: number): string {
  const days = Math.floor((Date.now() - timestamp) / 86_400_000)
  if (days <= 0) return '오늘 수정'
  if (days === 1) return '어제 수정'
  if (days < 7) return `${days}일 전 수정`
  return new Intl.DateTimeFormat('ko', {
    month: 'short',
    day: 'numeric',
  }).format(timestamp)
}
