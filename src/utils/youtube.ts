const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/

export function extractYouTubeVideoId(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '')

    if (
      hostname === 'youtube.com' ||
      hostname === 'music.youtube.com' ||
      hostname === 'm.youtube.com'
    ) {
      if (url.pathname === '/watch') {
        const videoId = url.searchParams.get('v')
        return videoId && VIDEO_ID_PATTERN.test(videoId) ? videoId : null
      }

      const shortsMatch = url.pathname.match(
        /^\/shorts\/([A-Za-z0-9_-]{11})(?:\/|$)/,
      )
      if (shortsMatch) return shortsMatch[1]
    }

    if (hostname === 'youtu.be') {
      const videoId = url.pathname.split('/').filter(Boolean)[0]
      return videoId && VIDEO_ID_PATTERN.test(videoId) ? videoId : null
    }

    return null
  } catch {
    return null
  }
}

export function isYouTubeVideoUrl(url: string): boolean {
  return extractYouTubeVideoId(url) !== null
}
