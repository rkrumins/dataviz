/**
 * EmptyState — what an empty place says: what would be here, why it is not, and the one thing to
 * do about it. Never a bare "No data".
 */
import type { ComponentType, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button } from './Button'

type Icon = ComponentType<{ className?: string }>

interface Action {
  label: string
  onClick: () => void
  icon?: Icon
}

export function EmptyState({ icon: Glyph, title, description, action, secondaryAction, compact = false, className }: {
  icon?: Icon
  title: ReactNode
  description?: ReactNode
  action?: Action
  secondaryAction?: Action
  /** Inline, inside a drawer section — less padding, smaller type. */
  compact?: boolean
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center text-center', compact ? 'py-4 px-3 gap-1.5' : 'py-10 px-6 gap-2.5', className)}>
      {Glyph && (
        <span className={cn('flex items-center justify-center rounded-2xl bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted',
          compact ? 'w-8 h-8 mb-0.5' : 'w-11 h-11 mb-1')}>
          <Glyph className={compact ? 'w-4 h-4' : 'w-5 h-5'} aria-hidden />
        </span>
      )}
      <p className={cn('font-semibold text-ink', compact ? 'text-xs' : 'text-sm')}>{title}</p>
      {description && <p className={cn('text-ink-secondary max-w-sm', compact ? 'text-[11px]' : 'text-xs')}>{description}</p>}
      {(action || secondaryAction) && (
        <div className={cn('flex items-center gap-2', compact ? 'mt-1' : 'mt-2')}>
          {/* White on the accent is 4.47:1; on indigo-600 it is 6.3:1, AA in both themes. */}
          {action && (
            <Button size="sm" variant="primary" className="bg-indigo-600 hover:bg-indigo-700 hover:brightness-100" leftIcon={action.icon} onClick={action.onClick}>
              {action.label}
            </Button>
          )}
          {secondaryAction && (
            <Button size="sm" variant="ghost" className="text-ink-secondary" leftIcon={secondaryAction.icon} onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
