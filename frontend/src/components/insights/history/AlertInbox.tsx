/**
 * AlertInbox — open anomalies across the fleet, grouped by provider.
 *
 * The per-source band answers "what happened here". This answers the question
 * you actually have at the platform altitude: *which data source, under which
 * provider, is broken right now* — without opening each source in turn to find
 * out.
 *
 * Grouped by provider rather than sorted flat, because that is the unit an
 * operator triages in. A provider with four affected sources is a provider
 * problem — a rotated cluster, a broken loader, an expired credential — and a
 * flat list ordered by severity scatters that signal across the page instead of
 * making it the first thing you see.
 *
 * Within a group, worst first: severity, then how recent.
 */
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowUpRight, ServerCog, ShieldCheck } from 'lucide-react'

import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { useCanReadHistory } from '@/hooks/useHistoryAccess'
import { insightsHistoryService } from '@/services/insightsHistoryService'
import type { CountAlert } from '@/types/insights'
import { ALERTS_QUERY_KEY } from './AlertBand'
import { compactNum, severityMeta, signedNum } from './shared'

interface ProviderGroup {
    providerId: string
    providerName: string
    alerts: CountAlert[]
    worstRank: number
}

/** Group by provider, worst-first within and between groups. */
function groupByProvider(alerts: CountAlert[]): ProviderGroup[] {
    const groups = new Map<string, ProviderGroup>()
    for (const alert of alerts) {
        const providerId = alert.provider_id ?? 'unassigned'
        const existing = groups.get(providerId)
        const rank = severityMeta(alert.severity).rank
        if (existing) {
            existing.alerts.push(alert)
            existing.worstRank = Math.max(existing.worstRank, rank)
        } else {
            groups.set(providerId, {
                providerId,
                // The frozen name, falling back to the id — a provider deleted
                // since the alert was raised still has to be nameable.
                providerName: alert.provider_name ?? providerId,
                alerts: [alert],
                worstRank: rank,
            })
        }
    }
    for (const group of groups.values()) {
        group.alerts.sort((a, b) =>
            severityMeta(b.severity).rank - severityMeta(a.severity).rank
            || (b.observed_at > a.observed_at ? 1 : -1),
        )
    }
    return [...groups.values()].sort((a, b) =>
        b.worstRank - a.worstRank
        || b.alerts.length - a.alerts.length
        || a.providerName.localeCompare(b.providerName),
    )
}

export function AlertInbox({ providerId, className }: {
    /** Scope to one provider; omit for the whole platform. */
    providerId?: string
    className?: string
}) {
    const canRead = useCanReadHistory()

    const { data, isLoading } = useQuery({
        // Deliberately NOT keyed on providerId: the request does not vary
        // with it (scoping happens below, client-side), so keying on it would
        // split one result across two cache entries and blink the inbox out
        // of existence every time the scope toggles.
        queryKey: [ALERTS_QUERY_KEY, 'inbox'],
        queryFn: ({ signal }) => insightsHistoryService.listAlerts(
            { openOnly: true, limit: 200 }, signal,
        ),
        enabled: canRead,
        staleTime: 60_000,
        retry: 1,
    })

    const groups = useMemo(() => {
        const all = data?.alerts ?? []
        // Provider scope filters client-side: the fleet read is already
        // bounded and one request serves both altitudes, so scoping it would
        // cost a round trip to save nothing.
        const scoped = providerId
            ? all.filter((a) => a.provider_id === providerId)
            : all
        return groupByProvider(scoped)
    }, [data, providerId])

    if (!canRead || isLoading) return null

    if (groups.length === 0) {
        return (
            <div className={cn(
                'rounded-2xl border border-glass-border bg-canvas-elevated',
                'px-4 py-3 flex items-center gap-2.5',
                className,
            )}>
                <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
                <p className="text-xs text-ink-secondary">
                    <strong className="text-ink font-semibold">Nothing outstanding.</strong>
                    {' '}No unacknowledged anomalies
                    {providerId ? ' on this provider' : ' across any provider'}.
                </p>
            </div>
        )
    }

    const total = groups.reduce((n, g) => n + g.alerts.length, 0)

    return (
        <section
            aria-label="Open anomalies by provider"
            className={cn('space-y-3', className)}
        >
            <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
                <h2 className="text-sm font-bold text-ink">
                    {total} open {total === 1 ? 'anomaly' : 'anomalies'} across{' '}
                    {groups.length} {groups.length === 1 ? 'provider' : 'providers'}
                </h2>
            </div>

            {groups.map((group) => (
                <div
                    key={group.providerId}
                    className={cn(
                        'rounded-2xl border overflow-hidden',
                        severityMeta(
                            group.worstRank === 3 ? 'critical'
                            : group.worstRank === 2 ? 'severe' : 'notable',
                        ).surface,
                    )}
                >
                    <div className="flex items-center gap-2 px-4 pt-3 pb-2 min-w-0">
                        <ServerCog className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                        <span className="text-xs font-bold text-ink truncate">
                            {group.providerName}
                        </span>
                        <span className="text-[10px] font-semibold text-ink-muted shrink-0">
                            {group.alerts.length} affected
                        </span>
                    </div>

                    <div className="divide-y divide-black/5 dark:divide-white/5">
                        {group.alerts.map((alert) => {
                            const meta = severityMeta(alert.severity)
                            const name = alert.data_source_label
                                || alert.graph_name
                                || alert.data_source_id
                            return (
                                <div
                                    key={alert.id}
                                    className="flex items-center gap-3 px-4 py-2 min-w-0"
                                >
                                    <span className={cn(
                                        'px-1.5 py-0.5 rounded-md shrink-0 w-16 text-center',
                                        'text-[10px] font-bold uppercase tracking-wide',
                                        meta.chip,
                                    )}>
                                        {alert.severity}
                                    </span>

                                    <span className="min-w-0 flex-1">
                                        <span className="block text-xs font-semibold text-ink truncate">
                                            {name}
                                        </span>
                                        {alert.graph_name && alert.data_source_label
                                            && alert.graph_name !== alert.data_source_label && (
                                            <span className="block text-[10px] text-ink-muted truncate">
                                                graph {alert.graph_name}
                                            </span>
                                        )}
                                    </span>

                                    <span className="text-right tabular-nums shrink-0">
                                        <span className={cn(
                                            'block text-xs font-bold',
                                            alert.node_delta < 0
                                                ? 'text-red-600 dark:text-red-400'
                                                : 'text-amber-600 dark:text-amber-400',
                                        )}>
                                            {signedNum(alert.node_delta)}
                                        </span>
                                        <span className="block text-[10px] text-ink-muted">
                                            {compactNum(alert.node_count)} left · {timeAgo(alert.observed_at)}
                                        </span>
                                    </span>

                                    {alert.catalog_item_id && (
                                        <Link
                                            to={`/datasources/${alert.catalog_item_id}/history?ds=${encodeURIComponent(alert.data_source_id)}`}
                                            aria-label={`Open history for ${name}`}
                                            className={cn(
                                                'p-1.5 rounded-lg shrink-0 text-ink-muted',
                                                'hover:bg-black/5 dark:hover:bg-white/5 transition-colors',
                                            )}
                                        >
                                            <ArrowUpRight className="w-3.5 h-3.5" />
                                        </Link>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                </div>
            ))}
        </section>
    )
}
