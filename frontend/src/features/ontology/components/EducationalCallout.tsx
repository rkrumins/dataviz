import { useState, useCallback, type ComponentType } from 'react'
import { BookOpen, ChevronDown, ChevronUp, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface EducationalCalloutProps {
  id: string
  title: string
  description: string
  icon?: ComponentType<{ className?: string }>
  variant?: 'info' | 'tip' | 'concept'
}

const DISMISS_PREFIX = 'synodic-edu-dismissed-'
const COLLAPSE_PREFIX = 'synodic-edu-collapsed-'

function getPersistedBoolean(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'true'
  } catch {
    return false
  }
}

function setPersistedBoolean(key: string, value: boolean) {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // localStorage may be unavailable
  }
}

const borderGradients: Record<string, string> = {
  concept: 'from-indigo-500 to-purple-500',
  tip: 'from-emerald-500 to-emerald-400',
  info: 'from-blue-500 to-blue-400',
}

export function EducationalCallout({
  id,
  title,
  description,
  icon: Icon = BookOpen,
  variant = 'info',
}: EducationalCalloutProps) {
  const dismissKey = `${DISMISS_PREFIX}${id}`
  const collapseKey = `${COLLAPSE_PREFIX}${id}`

  const [dismissed, setDismissed] = useState(() => getPersistedBoolean(dismissKey))
  const [collapsed, setCollapsed] = useState(() => getPersistedBoolean(collapseKey))

  const handleDismiss = useCallback(() => {
    setDismissed(true)
    setPersistedBoolean(dismissKey, true)
  }, [dismissKey])

  const handleToggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      setPersistedBoolean(collapseKey, next)
      return next
    })
  }, [collapseKey])

  if (dismissed) return null

  const gradientClass = borderGradients[variant]

  return (
    <div className="mb-4 relative">
      {/* Gradient left border */}
      <div
        className={cn(
          'absolute left-0 top-0 bottom-0 w-[3px] rounded-l-xl bg-gradient-to-b',
          gradientClass,
        )}
      />

      <div className="p-4 rounded-xl border border-glass-border bg-canvas-elevated/30 pl-5">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-ink-secondary shrink-0" />
          <span className="text-xs font-semibold text-ink flex-1">{title}</span>

          <button
            type="button"
            onClick={handleToggle}
            className="p-0.5 rounded hover:bg-canvas-elevated/60 text-ink-muted transition-colors"
            aria-label={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronUp className="w-3.5 h-3.5" />
            )}
          </button>

          <button
            type="button"
            onClick={handleDismiss}
            className="p-0.5 rounded hover:bg-canvas-elevated/60 text-ink-muted transition-colors"
            aria-label="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Body with animated collapse */}
        <div
          className={cn(
            'grid transition-[grid-template-rows] duration-200 ease-in-out',
            collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
          )}
        >
          <div className="overflow-hidden">
            <p className="text-xs text-ink-muted leading-relaxed mt-2">
              {description}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
