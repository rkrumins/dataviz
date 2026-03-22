/**
 * ViewHealthBadge — Small indicator overlay on cards for views with
 * data integrity issues.
 */
import { AlertTriangle, AlertCircle, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { HealthStatus } from '@/hooks/useViewHealth'

interface ViewHealthBadgeProps {
  status: HealthStatus
  reason?: string
  className?: string
}

const CONFIG: Record<Exclude<HealthStatus, 'healthy'>, {
  icon: typeof AlertCircle
  bg: string
  text: string
  label: string
}> = {
  broken: {
    icon: AlertCircle,
    bg: 'bg-red-500',
    text: 'text-red-500',
    label: 'Broken',
  },
  warning: {
    icon: AlertTriangle,
    bg: 'bg-amber-500',
    text: 'text-amber-500',
    label: 'Warning',
  },
  stale: {
    icon: Clock,
    bg: 'bg-slate-400',
    text: 'text-slate-400',
    label: 'Stale',
  },
}

export function ViewHealthBadge({ status, reason, className }: ViewHealthBadgeProps) {
  if (status === 'healthy') return null

  const config = CONFIG[status]
  const Icon = config.icon

  return (
    <div className={cn('group/health relative', className)}>
      <div className={cn('w-2.5 h-2.5 rounded-full', config.bg)} />

      {/* Tooltip on hover */}
      <div className="absolute bottom-full right-0 mb-1.5 hidden group-hover/health:block z-50">
        <div className="glass-panel rounded-lg px-3 py-2 shadow-lg min-w-[180px]">
          <div className={cn('flex items-center gap-1.5 text-xs font-medium mb-0.5', config.text)}>
            <Icon className="w-3 h-3" />
            {config.label}
          </div>
          {reason && (
            <p className="text-[10px] text-ink-secondary">{reason}</p>
          )}
        </div>
      </div>
    </div>
  )
}
