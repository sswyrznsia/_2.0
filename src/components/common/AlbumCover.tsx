import { Music2 } from 'lucide-react'

interface AlbumCoverProps {
  src?: string
  alt: string
  className?: string
}

export function AlbumCover({ src, alt, className = '' }: AlbumCoverProps) {
  return src ? (
    <img
      className={`album-cover ${className}`}
      src={src}
      alt={alt}
      loading="lazy"
    />
  ) : (
    <div
      className={`album-cover album-cover--empty ${className}`}
      role="img"
      aria-label={`${alt} 커버 없음`}
    >
      <Music2 aria-hidden="true" />
    </div>
  )
}
