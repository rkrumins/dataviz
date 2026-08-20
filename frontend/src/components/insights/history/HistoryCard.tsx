/**
 * HistoryCard — the counts-history summary inside `DataSourceProfile`.
 *
 * This renders at three very different widths (full page, the ~672px
 * Ingestion drawer, the ~440px workspace drawer) and the app has no
 * container-query plugin, so it is single-column and overflow-proof by
 * construction — the same constraint the profile's own header documents.
 * Everything rich lives on the full History view this links to.
 *
 * Only mounts when a workspace-scoped `dataSourceId` is available: history is
 * keyed on the data source, and the catalog-only frames (a provider asset
 * nobody has onboarded yet) have nothing to show.
 */
import { Link } from 'react-router-dom'
import { ArrowUpRight, History, Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Sparkline } from '@/components/ui/Sparkline'
import { timeAgo } from '@/lib/timeAgo'
import { useAnyPermission } from '@/store/auth'
import { useCountHistory, resolveWindow } from '@/hooks/useCountHistory'
import { compactNum, formatPct } from './shared'
import { DeltaChip } from './DeltaChip'

export function HistoryCard({ dataSourceId, catalogId, className }: {
    dataSourceId: string
    /** Deep-link target. Absent in frames that have no catalog identity — the
     *  card then shows the summary without the link rather than a dead one. */
    catalogId?: string | null
    className?: string
}) {
    // The history API is system:admin. Checking here means a non-admin never
    // makes the request at all, rather than making it, being refused, and
    // being shown an empty card explaining nothing.
    const canRead = useAnyPermission(['system:admin'])

    // Fixed 30-day window here. The card is a glance, not a control surface:
    // a second window selector inside a 440px drawer would compete with the
    // real one on the History view for no gain.
    const range = resolveWindow('30d')
    const { data, isLoading } = useCountHistory(dataSourceId, range, {
        enabled: canRead,
    })

    if (!canRead) return null

    const payload = data?.data
    const summary = payload?.summary
    const points = payload?.points ?? []
    const nodeSeries = points.map((p) => p.node_count)
    const lastChange = [...points].reverse().find((p) => p.capture_reason === 'changed')

    const body = (() => {
        if (isLoading) {
            return (
                <div className="flex items-center gap-2 px-5 pb-5 text-sm text-ink-muted">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading history…
                </div>
            )
        }

        // Sparkline needs three points to describe a trend, and below that
        // there is genuinely no trend to describe. Say so plainly rather than
        // drawing a two-point line that implies one.
        if (points.length < 3) {
            return (
                <div className="px-5 pb-5">
                    <p className="text-sm text-ink">
                        {points.length === 0
                            ? 'History starts with the next snapshot.'
                            : 'History starts here.'}
                    </p>
                    <p className="text-xs text-ink-muted mt-1">
                        {points.length === 0
                            ? 'Counts are captured whenever they change, plus an hourly checkpoint.'
                            : `First snapshot ${timeAgo(points[0].at)} · ${compactNum(points[0].node_count)} entities.`}
                    </p>
                </div>
            )
        }

        return (
            <div className="px-5 pb-5">
                <div className="flex items-end justify-between gap-3 mb-3">
                    <div className="min-w-0">
                        <p className="text-2xl font-black text-ink leading-none tabular-nums">
                            {compactNum(summary?.node_last)}
                        </p>
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted mt-1.5">
                            Entities now
                        </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                        <DeltaChip value={summary?.node_delta} />
                        {formatPct(summary?.node_pct_change) && (
                            <span className="text-[11px] font-semibold text-ink-muted tabular-nums">
                                {formatPct(summary?.node_pct_change)}
                            </span>
                        )}
                    </div>
                </div>

                <Sparkline
                    points={nodeSeries}
                    width={280}
                    height={40}
                    className="w-full"
                    tone={(summary?.node_delta ?? 0) < 0 ? 'red' : 'indigo'}
                    label="Entities over 30 days"
                />

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-muted">
                    <span className="tabular-nums">
                        <strong className="text-ink font-semibold">
                            {summary?.changed_snapshots ?? 0}
                        </strong>{' '}
                        change{summary?.changed_snapshots === 1 ? '' : 's'} recorded
                    </span>
                    {lastChange && <span>last {timeAgo(lastChange.at)}</span>}
                    {!!summary?.labels_removed?.length && (
                        <span className="text-red-600 dark:text-red-400 font-semibold">
                            {summary.labels_removed.length} label
                            {summary.labels_removed.length > 1 ? 's' : ''} disappeared
                        </span>
                    )}
                    {!!summary?.labels_added?.length && (
                        <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                            {summary.labels_added.length} new
                        </span>
                    )}
                </div>
            </div>
        )
    })()

    return (
        <div className={cn(
            'rounded-2xl border border-glass-border bg-canvas-elevated',
            className,
        )}>
            <div className="flex items-center justify-between gap-2 px-5 pt-5 pb-3">
                <div className="flex items-center gap-2 min-w-0">
                    <History className="w-4 h-4 text-ink-muted shrink-0" />
                    <h3 className="text-sm font-bold text-ink truncate">Last 30 days</h3>
                </div>
                {catalogId && (
                    <Link
                        to={`/datasources/${catalogId}/history?ds=${encodeURIComponent(dataSourceId)}`}
                        className={cn(
                            'inline-flex items-center gap-1 text-xs font-semibold shrink-0',
                            'text-indigo-600 dark:text-indigo-400 hover:underline',
                        )}
                    >
                        Full history <ArrowUpRight className="w-3 h-3" />
                    </Link>
                )}
            </div>
            {body}
        </div>
    )
}
