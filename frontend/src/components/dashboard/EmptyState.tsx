import React from 'react'
import { cn } from '@/lib/utils'

interface EmptyStateProps {
  icon: React.ComponentType<{ className?: string }>
  heading: string
  description: string
  actionLabel?: string
  onAction?: () => void
  secondaryLabel?: string
  onSecondary?: () => void
}

export function EmptyState({
  icon: Icon,
  heading,
  description,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center',
        'border-2 border-dashed border-glass-border rounded-3xl p-14'
      )}
    >
      <div
        className={cn(
          'flex items-center justify-center w-12 h-12 rounded-2xl',
          'bg-black/5 dark:bg-white/5 border border-glass-border'
        )}
      >
        <Icon className="w-6 h-6 text-ink-muted" />
      </div>

      <h3 className="mt-4 text-[14px] font-semibold text-ink">{heading}</h3>

      <p className="mt-1.5 text-sm text-ink-muted text-center max-w-xs">
        {description}
      </p>

      {actionLabel && onAction && (
        <button
          onClick={onAction}
          className={cn(
            'mt-5 px-4 py-2 rounded-xl text-sm font-semibold',
            'bg-accent-business/10 border border-accent-business/20 text-accent-business',
            'hover:bg-accent-business/20 transition-colors'
          )}
        >
          {actionLabel}
        </button>
      )}

      {secondaryLabel && onSecondary && (
        <button
          onClick={onSecondary}
          className="mt-3 text-accent-business text-sm"
        >
          {secondaryLabel}
        </button>
      )}
    </div>
  )
}
