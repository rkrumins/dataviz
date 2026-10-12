/**
 * The timeline: what happened, newest first, a day at a time.
 *
 * Each row is a sentence — who, what, to what — with the reason they gave
 * under it, because "why" is the column every other log leaves out. A change
 * that warrants a reason and has none says so in words; silence there would
 * read the same as a row that needs no reason at all.
 *
 * Identical events in a row fold into one ("×12"): twelve sign-ins by the same
 * person are one fact about them, and the twelve rows would bury the change
 * that matters between them. The drawer behind each row has the rest.
 */
import { useMemo } from 'react'
import { History, Loader2, Radio, RefreshCw } from 'lucide-react'

import { cn } from '@/lib/utils'
import { exact } from '@/lib/formatMetric'
import { useChartTheme } from '@/components/analytics/charts/chartTheme'
import { DateTime } from '@/components/ui/DateTime'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { UserAvatar } from '@/components/ui/UserAvatar'
import type { ActivityEvent, LedgerHealth } from '@/services/activityService'

import { CATEGORY_META, actorName, reasonExpected } from './activityMeta'
import { groupEvents, type TimelineRow } from './groupEvents'

function LedgerBanner({ ledger }: { ledger: LedgerHealth | null }) {
    if (!ledger) return null
    if (ledger.backfilling) {
        return (
            <div role="status" className="flex items-start gap-2 rounded-xl border border-indigo-500/20 bg-indigo-500/[0.05] px-4 py-3 text-xs text-ink-secondary">
                <RefreshCw className="w-3.5 h-3.5 mt-0.5 shrink-0 animate-spin text-indigo-500" aria-hidden />
                <span>
                    <span className="font-semibold text-ink">Importing earlier activity.</span>{' '}
                    {exact(ledger.pending)}{ledger.pendingCapped ? '+' : ''} events are still to be added,
                    oldest last — counts here will grow until the import finishes.
                </span>
            </div>
        )
    }
    if (ledger.lagSeconds !== null && ledger.lagSeconds > 120) {
        const minutes = Math.round(ledger.lagSeconds / 60)
        return (
            <div role="status" className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3 text-xs text-ink-secondary">
                <span className="font-semibold text-ink">The log is running about {minutes} minute{minutes === 1 ? '' : 's'} behind.</span>{' '}
                The most recent changes may not show yet.
            </div>
        )
    }
    return null
}

function TimelineRowView({ row, onOpen }: { row: TimelineRow; onOpen: (id: string) => void }) {
    const theme = useChartTheme()
    const { event, count } = row
    const meta = CATEGORY_META[event.category] ?? CATEGORY_META.platform
    const Icon = meta.icon
    const color = theme.series[meta.slot]
    const who = actorName(event)
    const unnamed = !!event.actor && !event.actor.name && !event.actor.email
    // A person who acted is shown by their face, the kind of act pinned to
    // it; the platform, a service or an id that names nobody, by the act.
    const face = event.actorKind === 'user' && event.actor && !unnamed ? event.actor : null

    return (
        <li>
            <button
                type="button"
                onClick={() => onOpen(event.id)}
                className="group flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04] outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
            >
                {face ? (
                    <span aria-hidden className="relative mt-0.5 h-8 w-8 shrink-0">
                        <UserAvatar
                            userId={face.id} name={who ?? face.id} avatarId={face.avatarId} hasImage={face.hasImage}
                            className={cn('h-8 w-8 text-[11px] font-bold', face.deleted && 'grayscale opacity-70')}
                        />
                        <span className="absolute -bottom-1 -right-1 rounded-md bg-canvas-elevated p-px">
                            <span
                                className="grid h-4 w-4 place-items-center rounded-[5px] border"
                                style={{ color, borderColor: `${color}55`, backgroundColor: `${color}1f` }}
                            >
                                <Icon className="h-2.5 w-2.5" />
                            </span>
                        </span>
                    </span>
                ) : (
                    <span
                        aria-hidden
                        className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border"
                        style={{ color, borderColor: `${color}40`, backgroundColor: `${color}14` }}
                    >
                        <Icon className="h-4 w-4" />
                    </span>
                )}
                <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-3">
                        <span className="min-w-0 flex-1 break-words text-sm leading-snug text-ink">
                            {who && (
                                <span className={cn('font-semibold', unnamed && 'font-mono text-[12px] font-normal')}>
                                    {who}
                                </span>
                            )}
                            {who && <span className="text-ink-muted"> · </span>}
                            <span>{event.summary || event.label}</span>
                            {count > 1 && (
                                <span className="ml-1.5 rounded-md bg-black/[0.05] dark:bg-white/[0.08] px-1.5 text-[10px] font-semibold tabular-nums text-ink-secondary">
                                    ×{count}
                                </span>
                            )}
                        </span>
                        {/* Right-aligned, so a day's rows read as a column of
                            times — the day is the heading's, so not repeated. */}
                        <DateTime at={event.occurredAt} variant="clock" className="text-[11px] text-ink-muted" />
                    </span>
                    {event.statedReason ? (
                        <span className="mt-0.5 block truncate text-xs italic text-ink-secondary">“{event.statedReason}”</span>
                    ) : reasonExpected(event) ? (
                        <span className="mt-0.5 block text-[11px] text-ink-muted">No reason given</span>
                    ) : null}
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-muted">
                        <span style={{ color }} className="font-semibold">{meta.label}</span>
                        {event.workspaceId && (
                            <span className={cn('truncate max-w-[16rem]', !event.workspaceName && 'font-mono')}>
                                {event.workspaceName || event.workspaceId}
                            </span>
                        )}
                        {event.outcome !== 'success' && (
                            <span className={cn(
                                'rounded-full px-1.5 font-semibold',
                                event.outcome === 'denied'
                                    ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                                    : 'bg-red-500/10 text-red-700 dark:text-red-400',
                            )}>
                                {event.outcome === 'denied' ? 'Refused' : 'Failed'}
                            </span>
                        )}
                    </span>
                </span>
            </button>
        </li>
    )
}

export function ActivityTimeline({
    events, ledger, isLoading, isStale, error, hasNextPage, isFetchingNextPage,
    onLoadMore, onOpen, newer, onShowNewer, onClearFilters,
}: {
    events: ActivityEvent[]
    ledger: LedgerHealth | null
    isLoading: boolean
    isStale: boolean
    error: Error | null
    hasNextPage: boolean
    isFetchingNextPage: boolean
    onLoadMore: () => void
    onOpen: (id: string) => void
    /** Events recorded since the page loaded; `null` while not counting. */
    newer: { count: number; capped: boolean } | null
    onShowNewer: () => void
    /** Offered on an empty result when filters are set. */
    onClearFilters?: () => void
}) {
    const days = useMemo(() => groupEvents(events), [events])

    return (
        <section aria-label="Activity timeline" className="space-y-3">
            <LedgerBanner ledger={ledger} />

            {newer && newer.count > 0 && (
                <div className="sticky top-2 z-10 flex justify-center">
                    <button
                        type="button"
                        onClick={onShowNewer}
                        className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-indigo-500 to-violet-600 px-4 py-1.5 text-xs font-semibold text-white shadow-md hover:shadow-lg transition-shadow"
                    >
                        <Radio className="h-3.5 w-3.5" aria-hidden />
                        {newer.count}{newer.capped ? '+' : ''} new event{newer.count === 1 && !newer.capped ? '' : 's'} — show
                    </button>
                </div>
            )}

            {error && events.length === 0 ? (
                <p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-xs text-red-700 dark:text-red-300">
                    {error.message}
                </p>
            ) : isLoading ? (
                <div aria-busy className="space-y-2">
                    {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-14 rounded-xl" />)}
                </div>
            ) : events.length === 0 ? (
                <div className="rounded-2xl border border-glass-border bg-canvas-elevated">
                    <EmptyState
                        icon={History}
                        title="Nothing matches"
                        description="No recorded activity matches this selection. Widen the range or remove a filter."
                        action={onClearFilters ? { label: 'Clear filters', onClick: onClearFilters } : undefined}
                    />
                </div>
            ) : (
                <div className={cn('rounded-2xl border border-glass-border bg-canvas-elevated p-2 transition-opacity', isStale && 'opacity-60')}>
                    {days.map((day) => (
                        <div key={day.key}>
                            <h3 className="sticky top-0 z-[1] bg-canvas-elevated px-3 pb-1 pt-3 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted">
                                {day.label}
                            </h3>
                            <ul>
                                {day.rows.map((row) => (
                                    <TimelineRowView key={row.event.id} row={row} onOpen={onOpen} />
                                ))}
                            </ul>
                        </div>
                    ))}
                    {hasNextPage && (
                        <div className="flex justify-center py-3">
                            <button
                                type="button"
                                onClick={onLoadMore}
                                disabled={isFetchingNextPage}
                                className="inline-flex items-center gap-2 rounded-lg border border-glass-border px-4 py-2 text-xs font-semibold text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50 transition-colors"
                            >
                                {isFetchingNextPage && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                                Show older events
                            </button>
                        </div>
                    )}
                </div>
            )}
        </section>
    )
}
