/**
 * AlertBand — anomalies this source raised that nobody has looked at yet.
 *
 * Sits above the chart because it is the answer to the question the chart is
 * usually opened to ask. Someone arriving from a notification should not have
 * to find the incident on a timeline; it should already be named, quantified,
 * and explained.
 *
 * Only UNACKNOWLEDGED alerts appear. An acknowledged one is not hidden — it is
 * in the ledger and the API — but a band that never empties stops being read,
 * and the whole point of acknowledgement is to make the band mean "there is
 * something outstanding".
 *
 * Every alert states what it was judged against. "Unusual" on its own is a
 * claim; "12,400 against a usual movement of 40" is an argument the reader can
 * check against the chart directly below it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
    AlertTriangle, Check, Loader2, ServerCog, TrendingDown, TrendingUp,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { formatUtc, timeAgo } from '@/lib/timeAgo'
import { useAnyPermission } from '@/store/auth'
import { insightsHistoryService } from '@/services/insightsHistoryService'
import type { CountAlert } from '@/types/insights'
import { compactNum, severityMeta, signedNum } from './shared'

export const ALERTS_QUERY_KEY = 'insights-history-alerts' as const

/** The labels that moved most, for the one-line explanation. */
function topLabels(alert: CountAlert): string[] {
    const nodes = alert.evidence?.nodes
    if (!nodes) return []
    const moved: Array<[string, number]> = [
        ...Object.entries(nodes.removed ?? {}).map(
            ([label, n]) => [label, -Math.abs(Number(n) || 0)] as [string, number],
        ),
        ...Object.entries(nodes.added ?? {}).map(
            ([label, n]) => [label, Math.abs(Number(n) || 0)] as [string, number],
        ),
        ...Object.entries(nodes.changed ?? {}).map(
            ([label, pair]) => [label, (pair?.[1] ?? 0) - (pair?.[0] ?? 0)] as [string, number],
        ),
    ]
    return moved
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, 3)
        .map(([label, delta]) => `${label} ${signedNum(delta)}`)
}

export function AlertBand({ scopeId, onSelect, className }: {
    /** Data source or catalog id — the API resolves either. */
    scopeId: string
    /** Reveal the matching moment on the chart and in the ledger. */
    onSelect?: (at: string) => void
    className?: string
}) {
    const canRead = useAnyPermission(['system:admin'])
    const queryClient = useQueryClient()

    const { data } = useQuery({
        queryKey: [ALERTS_QUERY_KEY, scopeId],
        queryFn: ({ signal }) => insightsHistoryService.listAlerts(
            { dataSourceId: scopeId, openOnly: true, limit: 20 }, signal,
        ),
        enabled: canRead && Boolean(scopeId),
        staleTime: 60_000,
        retry: 1,
    })

    const acknowledge = useMutation({
        mutationFn: (alertId: string) =>
            insightsHistoryService.acknowledgeAlert(alertId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: [ALERTS_QUERY_KEY] })
        },
    })

    const alerts = data?.alerts ?? []
    if (!canRead || alerts.length === 0) return null

    // The band takes the tone of the WORST thing in it. A critical alert
    // sitting under a band styled for a notable one is a design that buries
    // its own headline.
    const worst = alerts.reduce(
        (acc, a) => (severityMeta(a.severity).rank > severityMeta(acc).rank
            ? a.severity : acc),
        'notable',
    )
    const tone = severityMeta(worst)

    return (
        <section
            aria-label="Open anomalies"
            className={cn(
                'rounded-2xl border overflow-hidden', tone.surface, className,
            )}
        >
            <div className="flex items-center gap-2 px-4 pt-3.5 pb-2">
                <AlertTriangle className={cn(
                    'w-4 h-4 shrink-0',
                    worst === 'critical' ? 'text-red-600' : 'text-red-500',
                )} />
                <h2 className="text-sm font-bold text-ink">
                    {alerts.length === 1
                        ? 'One movement needs a look'
                        : `${alerts.length} movements need a look`}
                </h2>
            </div>

            <div className="divide-y divide-red-500/10">
                {alerts.map((alert) => {
                    const dropped = alert.direction === 'drop'
                    const Trend = dropped ? TrendingDown : TrendingUp
                    const labels = topLabels(alert)
                    return (
                        <div
                            key={alert.id}
                            className="flex items-start gap-3 px-4 py-3 min-w-0"
                        >
                            <span className={cn(
                                'mt-0.5 w-8 h-8 rounded-xl flex items-center justify-center shrink-0',
                                dropped
                                    ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                                    : 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
                            )}>
                                <Trend className="w-4 h-4" />
                            </span>

                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-bold text-ink tabular-nums">
                                    {signedNum(alert.node_delta)} entities
                                    <span className="font-semibold text-ink-muted">
                                        {' '}· now {compactNum(alert.node_count)}
                                    </span>
                                    <span
                                        className={cn(
                                            'ml-2 px-1.5 py-0.5 rounded-md align-middle',
                                            'text-[10px] font-bold uppercase tracking-wide',
                                            severityMeta(alert.severity).chip,
                                        )}
                                        title={severityMeta(alert.severity).blurb}
                                    >
                                        {alert.severity}
                                    </span>
                                </p>

                                {/* WHICH source, under WHICH provider. On a
                                    deployment running several providers this is
                                    the difference between an alert you can act
                                    on and one you have to go and identify. */}
                                <p className="text-[11px] text-ink-secondary mt-0.5 flex items-center gap-1 min-w-0">
                                    <ServerCog className="w-3 h-3 text-ink-muted shrink-0" />
                                    <span className="truncate">
                                        {alert.provider_name && (
                                            <>
                                                <strong className="text-ink font-semibold">
                                                    {alert.provider_name}
                                                </strong>
                                                <span className="text-ink-muted"> / </span>
                                            </>
                                        )}
                                        <strong className="text-ink font-semibold">
                                            {alert.data_source_label
                                                || alert.graph_name
                                                || alert.data_source_id}
                                        </strong>
                                        {/* The physical graph too when it differs
                                            from the label — one names what the
                                            product calls it, the other what to
                                            look for on the server. */}
                                        {alert.graph_name
                                            && alert.data_source_label
                                            && alert.graph_name !== alert.data_source_label && (
                                            <span className="text-ink-muted">
                                                {' '}· graph {alert.graph_name}
                                            </span>
                                        )}
                                    </span>
                                </p>

                                {/* The argument, not just the claim. */}
                                <p className="text-[11px] text-ink-secondary mt-0.5">
                                    Usual movement for this source is about{' '}
                                    <strong className="text-ink font-semibold tabular-nums">
                                        {compactNum(alert.baseline)}
                                    </strong>
                                    {labels.length > 0 && <> · {labels.join(' · ')}</>}
                                </p>

                                <p className="text-[10px] text-ink-muted mt-1">
                                    <button
                                        type="button"
                                        onClick={() => onSelect?.(alert.observed_at)}
                                        className="underline underline-offset-2 hover:text-ink transition-colors"
                                        title={formatUtc(alert.observed_at)}
                                    >
                                        Happened {timeAgo(alert.observed_at)}
                                    </button>
                                    {/* Detection trails observation by up to one sweep
                                        interval; saying only one of them invites the
                                        wrong conclusion about how fast this noticed. */}
                                    {' · noticed '}{timeAgo(alert.detected_at)}
                                </p>
                            </div>

                            <button
                                type="button"
                                onClick={() => acknowledge.mutate(alert.id)}
                                disabled={acknowledge.isPending}
                                className={cn(
                                    'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg shrink-0',
                                    'text-[11px] font-semibold text-ink-secondary',
                                    'hover:bg-black/5 dark:hover:bg-white/5 transition-colors',
                                    'outline-none focus-visible:ring-2 focus-visible:ring-red-500/40',
                                    'disabled:opacity-50 disabled:pointer-events-none',
                                )}
                            >
                                {acknowledge.isPending && acknowledge.variables === alert.id
                                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    : <Check className="w-3.5 h-3.5" />}
                                Acknowledge
                            </button>
                        </div>
                    )
                })}
            </div>
        </section>
    )
}
