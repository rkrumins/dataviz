/**
 * FreshnessGroupHeader — one provider group's header row. Collapsed, it is a
 * self-contained rollup ("«provider» · N sources · n ready · n rebuilding ·
 * n not built · n attention") with a compact cache-coverage chip; expanded, it
 * names the provider and its size and adds a small typographic stat strip
 * (ready · rebuilding · attention · cached%). Either way it carries the
 * collapse affordance (``aria-expanded``) and the admin-gated Refresh-provider
 * action.
 *
 * All state + coverage figures come from one resolver — the server
 * ``ProviderFreshnessSummary`` (provider-wide, so a filtered page never
 * understates them), falling back to a client count over this group's fetched
 * rows when the fleet is too large to summarise (``summary`` null). Because
 * collapsed and expanded read from the same resolver, toggling a group never
 * changes a number. "Attention" is the server-aligned marker-OR-failed set;
 * a rebuilding source is healthy in-progress, counted on its own.
 */
import { ChevronDown, ChevronRight, Unplug, Waves, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FreshnessRow, ProviderFreshnessSummary } from '@/services/freshnessService'
import { isDrifting, isNeverBuilt, isProjectionStalled, isRebuilding, needsAttention } from './freshnessTriage'

interface Props {
    providerId: string
    name: string
    rows: FreshnessRow[]
    /** Provider-wide counts; null when the fleet is too large to summarise
     *  (chip + strip fall back to a client count over ``rows``). */
    summary?: ProviderFreshnessSummary | null
    expanded: boolean
    onToggle: () => void
    isSystemAdmin: boolean
    onRefreshProvider: (providerId: string, name: string) => void
    colSpan: number
}

export function FreshnessGroupHeader({
    providerId, name, rows, summary, expanded, onToggle, isSystemAdmin, onRefreshProvider, colSpan,
}: Props) {
    const total = rows.length
    const Chevron = expanded ? ChevronDown : ChevronRight

    // One resolver for every count the header shows, so collapsed and expanded
    // agree. Provider-wide summary when present, else a client count over this
    // group's rows; each fallback mirrors the summary field it stands in for.
    // "attention" = marker-OR-failed (never rebuilding, which stands alone).
    const cov = summary
        ? {
            total: summary.total,
            cached: summary.cacheStamped,
            ready: summary.ready,
            rebuilding: summary.pending,
            notBuilt: summary.notBuilt,
            attention: summary.needsAttention,
            drifting: summary.drifting ?? rows.filter(isDrifting).length,
            stalled: summary.projectionStalled ?? rows.filter(isProjectionStalled).length,
        }
        : {
            total,
            cached: rows.filter(r => r.cacheAsOf != null).length,
            ready: rows.filter(r => r.aggregationStatus === 'ready').length,
            rebuilding: rows.filter(isRebuilding).length,
            notBuilt: rows.filter(isNeverBuilt).length,
            attention: rows.filter(needsAttention).length,
            drifting: rows.filter(isDrifting).length,
            stalled: rows.filter(isProjectionStalled).length,
        }
    const coverage = cov.total > 0 ? Math.round((cov.cached / cov.total) * 100) : 0

    return (
        <tr className={cn(
            'border-t border-glass-border',
            // Red outranks the amber attention wash: one source in this
            // group is serving no rolled-up connections at all.
            cov.stalled > 0
                ? 'bg-red-500/[0.06]'
                : cov.attention > 0
                    ? 'bg-amber-500/[0.04]'
                    : 'bg-black/[0.02] dark:bg-white/[0.02]',
        )}>
            <td colSpan={colSpan} className="px-2 py-1.5">
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={onToggle}
                        aria-expanded={expanded}
                        className="flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-left outline-none hover:bg-black/[0.03] dark:hover:bg-white/[0.03] focus-visible:ring-2 focus-visible:ring-indigo-500/50 transition-colors"
                    >
                        <Chevron className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                        <span className="text-xs font-semibold text-ink-secondary">{name}</span>
                        <span className="text-[11px] text-ink-muted">
                            · {total} {total === 1 ? 'source' : 'sources'}
                            {!expanded ? (
                                <>
                                    {cov.ready > 0 && <> · {cov.ready} ready</>}
                                    {cov.rebuilding > 0 && <> · {cov.rebuilding} rebuilding</>}
                                    {cov.notBuilt > 0 && <> · {cov.notBuilt} not built</>}
                                </>
                            ) : (
                                <>
                                    {' · '}{cov.ready} ready
                                    {cov.rebuilding > 0 && <> · {cov.rebuilding} rebuilding</>}
                                    {' · '}{coverage}% cached
                                </>
                            )}
                        </span>
                        {/* Drifting is called out separately from "attention",
                            which it is also part of: a collapsed healthy-looking
                            group must not hide the one source whose rollups no
                            longer match its data. Icon + word, never colour
                            alone — this sits right beside the amber count. */}
                        {/* Called out ahead of drifting and separately from
                            it: these sources are serving NO rolled-up
                            connections, and the rebuild that answers drifting
                            does not answer this. */}
                        {cov.stalled > 0 && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-600 dark:text-red-400">
                                <Unplug className="w-3 h-3 shrink-0" />
                                {cov.stalled} not serving connections
                            </span>
                        )}
                        {cov.drifting > 0 && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-600 dark:text-rose-400">
                                <Waves className="w-3 h-3 shrink-0" />
                                {cov.drifting} drifting
                            </span>
                        )}
                        {cov.attention > 0 && (
                            <span className="text-[11px] font-semibold text-amber-600 dark:text-amber-400">
                                · {cov.attention} attention
                            </span>
                        )}
                    </button>

                    {/* Cache-coverage chip: the collapsed group's at-a-glance
                        coverage. Shows the raw counts too, not only the aria
                        label, so a sighted admin sees the cached-source count.
                        Expanded, the strip above carries the %, so the chip
                        stands down to keep the row quiet. */}
                    {!expanded && (
                        <span
                            className="ml-auto inline-flex items-center gap-1.5 shrink-0"
                            aria-label={`Cache coverage: ${cov.cached} of ${cov.total} sources cached, ${coverage} percent`}
                        >
                            <span aria-hidden className="hidden sm:block h-1 w-10 rounded-full bg-violet-500/15 overflow-hidden">
                                <span className="block h-full rounded-full bg-violet-500" style={{ width: `${coverage}%` }} />
                            </span>
                            <span className="text-[11px] tabular-nums text-ink-muted">
                                {cov.cached}/{cov.total} cached (
                                <span className="font-semibold text-violet-600 dark:text-violet-400">{coverage}%</span>)
                            </span>
                        </span>
                    )}

                    {isSystemAdmin && providerId !== '—' && (
                        <button
                            type="button"
                            onClick={() => onRefreshProvider(providerId, name)}
                            className={cn(
                                'inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10 transition-colors',
                                expanded && 'ml-auto',
                            )}
                        >
                            <Zap className="w-3.5 h-3.5" /> Refresh provider…
                        </button>
                    )}
                </div>
            </td>
        </tr>
    )
}
