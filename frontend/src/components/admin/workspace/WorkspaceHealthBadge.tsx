import { cn } from '@/lib/utils'

/**
 * Workspace health.
 *
 * The old scale was healthy | warning | critical | unknown, and it collapsed three
 * completely different situations into "unknown": a workspace with NO data sources,
 * a workspace whose sources have simply never been aggregated (status 'none'), and
 * a genuinely unrecognised state. In this instance that meant 44 of 56 sources and
 * 18 of 25 workspaces landed on "unknown" — so the health dot was permanently grey
 * and the Health filter (Healthy / In Progress / Needs Attention) could never match
 * anything. It looked broken because, in effect, it was.
 *
 * `empty` and `idle` are now first-class: they are not failures, they are the two
 * most common states of a young workspace, and each has an obvious next action.
 */
export type WorkspaceHealth = 'healthy' | 'warning' | 'critical' | 'idle' | 'empty' | 'unknown'

interface WorkspaceHealthBadgeProps {
  status: WorkspaceHealth
  size?: 'sm' | 'md'
  showLabel?: boolean
}

export const HEALTH_CONFIG = {
  healthy:  { dot: 'bg-emerald-400', label: 'Ready',           text: 'text-emerald-500' },
  warning:  { dot: 'bg-amber-400 animate-pulse', label: 'Syncing',  text: 'text-amber-500' },
  critical: { dot: 'bg-red-400',     label: 'Needs Attention', text: 'text-red-500' },
  // Sources are connected, aggregation just hasn't been run. Nothing is wrong.
  idle:     { dot: 'bg-slate-400',   label: 'Not aggregated',  text: 'text-ink-muted' },
  // No data sources at all — the workspace is waiting to be filled.
  empty:    { dot: 'bg-slate-300 dark:bg-slate-600', label: 'No data',  text: 'text-ink-muted' },
  unknown:  { dot: 'bg-gray-400',    label: 'Unknown',         text: 'text-ink-muted' },
} as const

const config = HEALTH_CONFIG

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
): WorkspaceHealth {
  // Not a health problem — an empty workspace is one that hasn't been filled yet.
  if (dataSources.length === 0) return 'empty'

  const statuses = dataSources.map((ds) => ds.aggregationStatus)
  if (statuses.some((s) => s === 'failed')) return 'critical'
  if (statuses.some((s) => s === 'pending' || s === 'running')) return 'warning'
  if (statuses.every((s) => s === 'ready' || s === 'skipped')) return 'healthy'

  // 'none' = aggregation has never run. It was falling through to "unknown", which
  // is how 44 of 56 sources ended up greyed out as if something were wrong.
  if (statuses.every((s) => s === 'none' || s === 'ready' || s === 'skipped')) return 'idle'

  return 'unknown'
}
