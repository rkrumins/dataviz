/**
 * A data source's history, on its Activity tab: what happened to it — connected, renamed,
 * described, certified, its contacts named, moved — newest first, a day at a time, each
 * row who did it and when. Everyone who can open the source reads it; the server keeps it
 * to the events that are safe to show them, and history from before a move stays.
 */
import { useMemo } from 'react'
import {
    ArrowRightLeft, History, Inbox, Loader2, Pencil, PencilLine, Plus, RotateCcw, Settings2, ShieldCheck, Star, Trash2, Users,
    GitBranch,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { DateTime } from '@/components/ui/DateTime'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { groupEvents, type TimelineRow } from '@/components/activity/groupEvents'
import { actorName } from '@/components/activity/activityMeta'
import { useDataSourceActivity } from '@/hooks/useDataSourceMetadata'

type Glyph = React.ComponentType<{ className?: string }>

/** Each kind of change, by its icon and tint. */
const KIND: Record<string, { icon: Glyph; tint: string }> = {
    'workspace.data_source.added': { icon: Plus, tint: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400' },
    'workspace.data_source.updated': { icon: Pencil, tint: 'bg-indigo-500/12 text-indigo-600 dark:text-indigo-400' },
    'workspace.data_source.removed': { icon: Trash2, tint: 'bg-rose-500/12 text-rose-600 dark:text-rose-400' },
    'workspace.data_source.restored': { icon: RotateCcw, tint: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400' },
    'workspace.data_source.primary_set': { icon: Star, tint: 'bg-amber-500/12 text-amber-600 dark:text-amber-400' },
    'workspace.data_source.projection_changed': { icon: Settings2, tint: 'bg-slate-500/12 text-slate-600 dark:text-slate-300' },
    'workspace.data_source.contacts_changed': { icon: Users, tint: 'bg-violet-500/12 text-violet-600 dark:text-violet-400' },
    'workspace.data_source.moved': { icon: ArrowRightLeft, tint: 'bg-sky-500/12 text-sky-600 dark:text-sky-400' },
    'workspace.data_source.move_undone': { icon: ArrowRightLeft, tint: 'bg-sky-500/12 text-sky-600 dark:text-sky-400' },
    'workspace.datasource.moved': { icon: ArrowRightLeft, tint: 'bg-sky-500/12 text-sky-600 dark:text-sky-400' },
    'workspace.data_source.metadata_changed': { icon: PencilLine, tint: 'bg-indigo-500/12 text-indigo-600 dark:text-indigo-400' },
    'workspace.data_source.trust_changed': { icon: ShieldCheck, tint: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400' },
    'workspace.data_request.connected': { icon: Inbox, tint: 'bg-indigo-500/12 text-indigo-600 dark:text-indigo-400' },
    'workspace.versioning.enabled': { icon: GitBranch, tint: 'bg-violet-500/12 text-violet-600 dark:text-violet-400' },
}
const OTHER = { icon: History, tint: 'bg-slate-500/12 text-slate-600 dark:text-slate-300' }

export function DataSourceActivity({ wsId, dsId }: { wsId: string; dsId: string }) {
    const { data, isLoading, isError, error, hasNextPage, fetchNextPage, isFetchingNextPage } = useDataSourceActivity(wsId, dsId)
    const events = useMemo(() => (data?.pages ?? []).flatMap(p => p.events), [data])
    const days = useMemo(() => groupEvents(events), [events])

    return (
        <section aria-labelledby={`ds-activity-${dsId}`} className="space-y-3">
            <div>
                <h3 id={`ds-activity-${dsId}`} className="text-sm font-bold text-ink">What happened to this source</h3>
                <p className="mt-0.5 text-xs text-ink-muted">Newest first. A change can take a few seconds to appear here.</p>
            </div>

            {isError ? (
                <p role="alert" className="rounded-xl border border-rose-500/20 bg-rose-500/5 px-4 py-3 text-xs text-rose-700 dark:text-rose-300">
                    {error instanceof Error ? error.message : 'Couldn’t load the history.'}
                </p>
            ) : isLoading ? (
                <div aria-busy="true" aria-label="Loading the history" className="space-y-2">
                    {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-14 rounded-xl" />)}
                </div>
            ) : events.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-glass-border">
                    <EmptyState icon={History} title="Nothing recorded yet"
                        description="Changes to this source — its details, status, contacts and moves — will show here." />
                </div>
            ) : (
                <div className="rounded-2xl border border-glass-border bg-canvas-elevated p-2">
                    {days.map(day => (
                        <div key={day.key}>
                            <h4 className="px-3 pb-1 pt-3 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted">{day.label}</h4>
                            <ol className="relative">
                                {day.rows.map((row, i) => <Row key={row.event.id} row={row} last={i === day.rows.length - 1} />)}
                            </ol>
                        </div>
                    ))}
                    {hasNextPage && (
                        <div className="flex justify-center py-3">
                            <button type="button" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}
                                className="inline-flex items-center gap-2 rounded-xl border border-glass-border px-4 py-2 text-xs font-semibold text-ink-secondary transition-colors hover:bg-black/5 hover:text-ink disabled:opacity-50 dark:hover:bg-white/5">
                                {isFetchingNextPage && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                                Show more
                            </button>
                        </div>
                    )}
                </div>
            )}
        </section>
    )
}

function Row({ row, last }: { row: TimelineRow; last: boolean }) {
    const { event, count } = row
    const kind = KIND[event.eventType] ?? OTHER
    const Icon = kind.icon
    const who = actorName(event)
    const face = event.actorKind === 'user' && event.actor ? event.actor : null
    return (
        <li className="relative flex gap-3 px-3 py-2.5">
            {/* The day's spine, from this row's mark to the next. */}
            {!last && <span aria-hidden className="absolute bottom-0 left-[27px] top-[42px] w-px bg-black/10 dark:bg-white/10" />}
            <span aria-hidden className="relative mt-0.5 h-8 w-8 shrink-0">
                {face ? (
                    <>
                        <UserAvatar userId={face.id} name={who ?? face.id} avatarId={face.avatarId} hasImage={face.hasImage}
                            className={cn('h-8 w-8 text-[11px] font-bold', face.deleted && 'opacity-70 grayscale')} />
                        <span className="absolute -bottom-1 -right-1 rounded-md bg-canvas-elevated p-px">
                            <span className={cn('grid h-4 w-4 place-items-center rounded-[5px]', kind.tint)}><Icon className="h-2.5 w-2.5" /></span>
                        </span>
                    </>
                ) : (
                    <span className={cn('grid h-8 w-8 place-items-center rounded-lg', kind.tint)}><Icon className="h-4 w-4" /></span>
                )}
            </span>
            <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-3">
                    <span className="min-w-0 flex-1 break-words text-sm leading-snug text-ink">
                        {who && <span className="font-semibold">{who}</span>}
                        {who && <span className="text-ink-muted"> · </span>}
                        {event.summary || event.label}
                        {count > 1 && (
                            <span className="ml-1.5 rounded-md bg-black/[0.05] px-1.5 text-[10px] font-semibold tabular-nums text-ink-secondary dark:bg-white/[0.08]">×{count}</span>
                        )}
                    </span>
                    <DateTime at={event.occurredAt} variant="clock" className="text-[11px] text-ink-muted" />
                </span>
                {event.statedReason && <span className="mt-0.5 block truncate text-xs italic text-ink-secondary">“{event.statedReason}”</span>}
            </span>
        </li>
    )
}
