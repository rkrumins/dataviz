import { cn } from '@/lib/utils'

interface WorkspaceHealthBadgeProps {
  status: 'healthy' | 'warning' | 'critical' | 'unknown'
  size?: 'sm' | 'md'
  showLabel?: boolean
}

const config = {
  healthy:  { dot: 'bg-emerald-400', label: 'Healthy',         text: 'text-emerald-500' },
  warning:  { dot: 'bg-amber-400 animate-pulse', label: 'In Progress',    text: 'text-amber-500' },
  critical: { dot: 'bg-red-400',     label: 'Needs Attention', text: 'text-red-500' },
  unknown:  { dot: 'bg-gray-400',    label: 'No Data',         text: 'text-ink-muted' },
} as const

const sizes = {
  sm: { dot: 'w-2 h-2',     text: 'text-[10px]' },
  md: { dot: 'w-2.5 h-2.5', text: 'text-xs' },
} as const

export function WorkspaceHealthBadge({
  status,
  size = 'sm',
  showLabel = false,
}: WorkspaceHealthBadgeProps) {
  const { dot, label, text } = config[status]
  const s = sizes[size]

  return (
    <span className="flex items-center gap-1.5">
      <span className={cn('rounded-full shrink-0', dot, s.dot)} />
      {showLabel && (
        <span className={cn('font-medium leading-none', text, s.text)}>{label}</span>
      )}
    </span>
  )
}

export function deriveWorkspaceHealth(
  dataSources: { aggregationStatus: string }[],
): 'healthy' | 'warning' | 'critical' | 'unknown' {
  if (dataSources.length === 0) return 'unknown'
  const statuses = dataSources.map((ds) => ds.aggregationStatus)
  if (statuses.some((s) => s === 'failed')) return 'critical'
  if (statuses.some((s) => s === 'pending' || s === 'running')) return 'warning'
  if (statuses.every((s) => s === 'ready' || s === 'skipped')) return 'healthy'
  return 'unknown'
}
