import { Heart } from 'lucide-react'
import { EmptyState } from '../components/common/EmptyState'
import { TrackList } from '../components/library/TrackList'
import { useAppStore } from '../stores/appStore'

export function LikedPage() {
  const data = useAppStore((state) => state.data)
  const tracks = data?.tracks.filter((track) => track.liked) ?? []
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>좋아요</h1>
          <p>{tracks.length}곡</p>
        </div>
      </header>
      {tracks.length ? (
        <TrackList tracks={tracks} />
      ) : (
        <EmptyState
          icon={Heart}
          title="좋아요한 곡이 없습니다"
          description="마음에 드는 곡의 하트 버튼을 눌러 여기에 모아 보세요."
        />
      )}
    </div>
  )
}
