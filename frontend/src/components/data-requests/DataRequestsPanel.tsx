/**
 * Every workspace's data requests, for the platform team (Org and Super Admins:
 * `system:workspaces:create`), on Workspaces → Requests: what was asked for, from
 * where, for which workspace, by whom, how urgent and how long it has waited — and
 * Review, which opens it to take on, connect or decline. Renders nothing while requests
 * are off, for anyone not on the platform team, or when nothing waits and
 * `hideWhenEmpty` is set.
 */
import { useState } from 'react'
import { Clock, Database, Hand } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { useFeature } from '@/store/features'
import type { DataRequest } from '@/services/dataRequestsService'
import { Segmented } from '@/components/ui/Segmented'
import { DATA_REQUESTS_FEATURE, useDataRequestsToAnswer, useIsPlatformTeam } from '@/hooks/useDataRequests'
import { ReviewDataRequestDrawer } from './ReviewDataRequestDrawer'
import { STATUS_LABEL, STATUS_PILL, URGENCY_BADGE, systemOf, urgencyOf } from './systems'
import { SystemTile } from './SystemTile'

const days = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function DataRequestsPanel({ hideWhenEmpty = false }: { hideWhenEmpty?: boolean }) {
    const on = useFeature(DATA_REQUESTS_FEATURE)
    const can = useIsPlatformTeam()
    const [filter, setFilter] = useState<'open' | 'all'>('open')
    const { data, isLoading } = useDataRequestsToAnswer(filter)
    const [reviewing, setReviewing] = useState<DataRequest | null>(null)
    if (!on || !can) return null
    const rows = data ?? []
    if (hideWhenEmpty && !isLoading && rows.length === 0 && filter === 'open') return null

    return (
        <section aria-labelledby="data-requests-title" className="overflow-hidden rounded-2xl border border-glass-border bg-canvas-elevated">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-glass-border px-5 py-3">
                <h2 id="data-requests-title" className="flex items-center gap-2 text-sm font-bold text-ink">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 text-white">
                        <Database className="h-3.5 w-3.5" aria-hidden />
                    </span>
                    Requests for data
                    {filter === 'open' && rows.length > 0 && (
                        <span className="rounded-full bg-indigo-500/10 px-2 py-0.5 text-[11px] font-semibold text-indigo-700 dark:text-indigo-300">{rows.length}</span>
                    )}
                </h2>
                <Segmented label="Show" value={filter} onChange={setFilter}
                    options={[{ value: 'open', label: 'Waiting' }, { value: 'all', label: 'All' }]} />
            </div>
            {isLoading ? (
                <p className="px-5 py-6 text-center text-sm text-ink-muted">Loading…</p>
            ) : rows.length === 0 ? (
                <p className="px-5 py-6 text-center text-sm text-ink-muted">
                    {filter === 'open' ? 'Nobody is waiting for data.' : 'No data requests yet.'}
                </p>
            ) : (
                <ul className="divide-y divide-glass-border">
                    {rows.map(r => {
                        const waited = days(r.createdAt)
                        const open = r.status === 'pending' || r.status === 'in_progress'
                        const urgent = open ? URGENCY_BADGE[r.urgency] : undefined
                        return (
                            <li key={r.id} className="flex items-center gap-3 px-5 py-3.5">
                                <SystemTile system={r.system} />
                                <span className="min-w-0 flex-1">
                                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                        <span className="truncate text-sm font-semibold text-ink">{r.title}</span>
                                        <span className="rounded-full bg-black/[0.04] dark:bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium text-ink-secondary">{systemOf(r.system).label}</span>
                                        {r.status !== 'pending' && (
                                            <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', STATUS_PILL[r.status])}>{STATUS_LABEL[r.status]}</span>
                                        )}
                                        {urgent && <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', urgent)}>{urgencyOf(r.urgency).label}</span>}
                                    </span>
                                    <span className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[11px] text-ink-muted">
                                        <span>For {r.workspaceName || 'a workspace'} · from {r.requesterName || 'someone'} · {timeAgo(r.createdAt)}</span>
                                        {r.status === 'in_progress' && (
                                            <span className="inline-flex items-center gap-1"><Hand className="h-3 w-3" aria-hidden />{r.assigneeName || 'Someone'} is on it</span>
                                        )}
                                    </span>
                                </span>
                                {r.status === 'pending' && waited >= 1 && (
                                    <span className={cn('hidden sm:inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold',
                                        waited >= 7 ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400' : waited >= 3 ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-secondary')}>
                                        <Clock className="h-2.5 w-2.5" aria-hidden /> Waiting {plural(waited, 'day')}
                                    </span>
                                )}
                                <button type="button" onClick={() => setReviewing(r)} aria-label={`Review ${r.title}`}
                                    className="shrink-0 rounded-xl border border-glass-border px-3 py-1.5 text-xs font-semibold text-ink hover:border-indigo-500/40 hover:bg-indigo-500/[0.05]">
                                    Review
                                </button>
                            </li>
                        )
                    })}
                </ul>
            )}
            {reviewing && <ReviewDataRequestDrawer request={reviewing} onClose={() => setReviewing(null)} />}
        </section>
    )
}
