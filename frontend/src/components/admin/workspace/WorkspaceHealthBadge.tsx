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
export type WorkspaceHealth = 'healthy' | 'warning' | 'critical' | 'no-data' | 'empty' | 'unknown'

interface WorkspaceHealthBadgeProps {
  status: WorkspaceHealth
  size?: 'sm' | 'md'
  showLabel?: boolean
}

export const HEALTH_CONFIG = {
  healthy:  { dot: 'bg-emerald-400', label: 'Ready',           text: 'text-emerald-500' },
  warning:  { dot: 'bg-amber-400 animate-pulse', label: 'Syncing',  text: 'text-amber-500' },
  critical: { dot: 'bg-red-400',     label: 'Needs attention', text: 'text-red-500' },
  // Sources are connected but we can't see any data in them yet.
  'no-data': { dot: 'bg-slate-400',  label: 'No data yet',     text: 'text-ink-muted' },
  // No data sources at all — the workspace is waiting to be filled.
  empty:    { dot: 'bg-slate-300 dark:bg-slate-600', label: 'No sources', text: 'text-ink-muted' },
  // Stats haven't arrived. "We don't know" is not "nothing there".
  unknown:  { dot: 'bg-gray-400',    label: 'Checking…',       text: 'text-ink-muted' },
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

/**
 * Workspace health = "can I use this?", not "has the rollup run?".
 *
 * It used to be derived SOLELY from aggregationStatus, which is an optional
 * rollup: a workspace holding 2.1M nodes across 8 sources reported "Not
 * aggregated" in grey simply because some of its sources had never had
 * :AGGREGATED edges computed. Aggregation is an optimisation, not a
 * precondition — views read those graphs perfectly well without it. So the
 * question the dot answers is now whether the workspace has DATA, and
 * aggregation only contributes the two states that genuinely mean something is
 * wrong or in flight.
 *
 * `nodeCount` undefined means "stats haven't landed yet" and yields `unknown`,
 * NOT `no-data`. Reporting an unmeasured workspace as empty is a lie that reads
 * exactly like a real one.
 *
 * `projectorCurrent` is the one signal here that aggregationStatus cannot see.
 * A version-controlled source whose projector has stalled has a perfectly
 * successful last batch job and a stored status of `ready`, while the rolled-up
 * connections it serves are missing — an analyst opening that workspace finds
 * lineage gone. So an affirmative `false` is critical. `null`/absent is
 * UNKNOWN, never healthy AND never a fault: it is what every unversioned source
 * reports, and treating it as a wedge would paint the whole estate red.
 */
export function deriveWorkspaceHealth(
  dataSources: { aggregationStatus: string; projectorCurrent?: boolean | null }[],
  opts?: { nodeCount?: number },
): WorkspaceHealth {
  if (dataSources.length === 0) return 'empty'

  const statuses = dataSources.map((ds) => ds.aggregationStatus)
  // Something broke, or is mid-flight. These DO belong in health.
  if (statuses.some((s) => s === 'failed')) return 'critical'
  if (dataSources.some((ds) => ds.projectorCurrent === false)) return 'critical'
  if (statuses.some((s) => s === 'pending' || s === 'running')) return 'warning'

  const nodes = opts?.nodeCount
  if (nodes === undefined) return 'unknown'
  return nodes > 0 ? 'healthy' : 'no-data'
}
