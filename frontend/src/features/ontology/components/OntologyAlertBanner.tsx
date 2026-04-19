/**
 * OntologyAlertBanner — contextual alerts rendered between the detail
 * header and tab bar. Each alert is session-dismissible (React state).
 */
import { useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface OntologyAlert {
  id: string
  severity: 'info' | 'warning' | 'error'
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
  action?: { label: string; onClick: () => void }
}

interface OntologyAlertBannerProps {
  alerts: OntologyAlert[]
}

const SEVERITY_STYLES = {
  info: {
    bg: 'bg-blue-50/60 dark:bg-blue-950/15',
    border: 'border-blue-200/50 dark:border-blue-800/30',
    text: 'text-blue-700 dark:text-blue-300',
    subtext: 'text-blue-600/70 dark:text-blue-400/70',
    iconColor: 'text-blue-500',
    actionBg: 'bg-blue-500/10 hover:bg-blue-500/20 text-blue-600 dark:text-blue-400',
  },
  warning: {
    bg: 'bg-amber-50/60 dark:bg-amber-950/15',
    border: 'border-amber-200/50 dark:border-amber-800/30',
    text: 'text-amber-700 dark:text-amber-300',
    subtext: 'text-amber-600/70 dark:text-amber-400/70',
    iconColor: 'text-amber-500',
    actionBg: 'bg-amber-500/10 hover:bg-amber-500/20 text-amber-600 dark:text-amber-400',
  },
  error: {
    bg: 'bg-red-50/60 dark:bg-red-950/15',
    border: 'border-red-200/50 dark:border-red-800/30',
    text: 'text-red-700 dark:text-red-300',
    subtext: 'text-red-600/70 dark:text-red-400/70',
    iconColor: 'text-red-500',
    actionBg: 'bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400',
  },
} as const

export function OntologyAlertBanner({ alerts }: OntologyAlertBannerProps) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  const visible = alerts.filter(a => !dismissed.has(a.id))
  if (visible.length === 0) return null

  function dismiss(id: string) {
    setDismissed(prev => new Set(prev).add(id))
  }

  return (
    <div className="flex-shrink-0 px-8 pt-2 space-y-1.5">
      {visible.map(alert => {
        const s = SEVERITY_STYLES[alert.severity]
        const Icon = alert.icon
        return (
          <div
            key={alert.id}
            className={cn('flex items-center gap-3 px-4 py-2.5 rounded-xl border', s.bg, s.border)}
          >
            <Icon className={cn('w-4 h-4 flex-shrink-0', s.iconColor)} />
            <div className="flex-1 min-w-0">
              <span className={cn('text-xs font-semibold', s.text)}>{alert.title}</span>
              {alert.description && (
                <span className={cn('text-xs ml-1.5', s.subtext)}>{alert.description}</span>
              )}
            </div>
            {alert.action && (
              <button
                onClick={alert.action.onClick}
                className={cn('px-3 py-1 rounded-lg text-[10px] font-semibold transition-colors flex-shrink-0', s.actionBg)}
              >
                {alert.action.label}
              </button>
            )}
            <button
              onClick={() => dismiss(alert.id)}
              className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted transition-colors flex-shrink-0"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

export type { OntologyAlert }
