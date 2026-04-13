/**
 * ExplorerStatsBar — catalog summary banner.
 *
 * Mirrors the RegistryWorkspaces summary-banner treatment: a rounded
 * card with a gradient accent strip at the top, followed by a row of
 * tiles that pair a big number with an uppercase label and a coloured
 * icon box. Three of the four tiles are clickable, applying the
 * corresponding category filter; the fourth is a passive last-activity
 * indicator.
 *
 * Data comes from the global facets query (shared cache via React
 * Query), so the bar adds zero new network cost.
 */
import type { ComponentType } from 'react'
import { Compass, Sparkles, AlertTriangle, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import type { ViewCatalogStats } from '@/services/viewApiService'

interface ExplorerStatsBarProps {
  stats: ViewCatalogStats
  isLoading?: boolean
  onShowAll: () => void
  onShowRecent: () => void
  onShowAttention: () => void
}

export function ExplorerStatsBar({
  stats,
  isLoading,
  onShowAll,
  onShowRecent,
  onShowAttention,
}: ExplorerStatsBarProps) {
  const lastActivity = stats.lastActivityAt ? timeAgo(stats.lastActivityAt) : '—'

  return (
    <div className="mb-5 rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden">
      {/* Gradient accent strip — matches the admin Workspaces summary banner. */}
      <div className="h-1 w-full bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-500" />

      <div className="p-5">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
          <StatTile
            icon={Compass}
            iconClass="bg-indigo-500/10 border-indigo-500/20 text-indigo-500"
            label="Total Views"
            value={stats.total}
            loading={isLoading}
            onClick={onShowAll}
          />

          <StatTile
            icon={Sparkles}
            iconClass="bg-emerald-500/10 border-emerald-500/20 text-emerald-500"
            label="New This Week"
            value={stats.recentlyAdded}
            loading={isLoading}
            onClick={onShowRecent}
          />

          <StatTile
            icon={AlertTriangle}
            iconClass={cn(
              stats.needsAttention > 0
                ? 'bg-amber-500/10 border-amber-500/20 text-amber-500'
                : 'bg-ink-muted/5 border-glass-border text-ink-muted/60',
            )}
            label="Need Attention"
            value={stats.needsAttention}
            loading={isLoading}
            onClick={onShowAttention}
            highlight={stats.needsAttention > 0}
          />

          {/* Separator + passive "last activity" indicator. */}
          <div className="w-px h-10 bg-glass-border hidden lg:block" />

          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center">
              <Clock className="w-5 h-5 text-sky-500" />
            </div>
            <div>
              <div className="text-lg font-bold text-ink">{lastActivity}</div>
              <div className="text-[10px] text-ink-muted uppercase tracking-wider">Last Activity</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

interface StatTileProps {
  icon: ComponentType<{ className?: string }>
  iconClass: string
  label: string
  value: number
  loading?: boolean
  onClick?: () => void
  highlight?: boolean
}

function StatTile({ icon: Icon, iconClass, label, value, loading, onClick, highlight }: StatTileProps) {
  const display = loading ? '—' : value.toLocaleString()
  const content = (
    <>
      <div
        className={cn(
          'w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 transition-transform duration-200',
          'group-hover:scale-105',
          iconClass,
        )}
      >
        <Icon className="w-5 h-5" />
      </div>
      <div className="text-left">
        <div className={cn(
          'text-lg font-bold tabular-nums leading-tight',
          highlight ? 'text-amber-600 dark:text-amber-400' : 'text-ink',
        )}>
          {display}
        </div>
        <div className="text-[10px] text-ink-muted uppercase tracking-wider">
          {label}
        </div>
      </div>
    </>
  )

  if (!onClick) {
    return <div className="flex items-center gap-3">{content}</div>
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex items-center gap-3 rounded-xl -mx-2 px-2 py-1',
        'transition-colors duration-150',
        'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
      )}
    >
      {content}
    </button>
  )
}
