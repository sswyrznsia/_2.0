import type { LucideIcon } from 'lucide-react'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  action?: { label: string; onClick: () => void }
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <div className="empty-state">
      <Icon aria-hidden="true" />
      <h3>{title}</h3>
      <p>{description}</p>
      {action && (
        <button
          type="button"
          className="button button--primary"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
