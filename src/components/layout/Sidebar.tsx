import {
  Disc3,
  Heart,
  Home,
  Library,
  ListMusic,
  Settings,
  TimerReset,
  Youtube,
} from 'lucide-react'
import type { PageId } from '../../types/models'
import { useAppStore } from '../../stores/appStore'

const items: { id: PageId; label: string; icon: typeof Home }[] = [
  { id: 'home', label: '홈', icon: Home },
  { id: 'library', label: '라이브러리', icon: Library },
  { id: 'youtube', label: 'YouTube', icon: Youtube },
  { id: 'liked', label: '좋아요', icon: Heart },
  { id: 'playlists', label: '플레이리스트', icon: ListMusic },
  { id: 'focus', label: '집중 모드', icon: TimerReset },
  { id: 'settings', label: '설정', icon: Settings },
]

export function Sidebar() {
  const page = useAppStore((state) => state.page)
  const navigate = useAppStore((state) => state.navigate)

  return (
    <aside className="sidebar">
      <div className="brand" title="Pulse Shelf 2.0">
        <Disc3 aria-hidden="true" />
        <span>Pulse Shelf</span>
      </div>
      <nav aria-label="주 메뉴">
        {items.map(({ id, label, icon: Icon }) => (
          <button
            type="button"
            key={id}
            className={page === id ? 'is-active' : ''}
            aria-current={page === id ? 'page' : undefined}
            title={label}
            onClick={() => navigate(id)}
          >
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar__footer">
        <span>LOCAL PLAYER</span>
        <strong>2.0</strong>
      </div>
    </aside>
  )
}
