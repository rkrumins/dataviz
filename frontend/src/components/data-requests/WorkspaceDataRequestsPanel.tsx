/**
 * A workspace's data requests, on Data → Sources: what has been asked for, by whom and
 * how long ago, and where each stands — Asked → In progress → Connected, or declined
 * with the reason. The person who asked may withdraw a request nobody has taken yet;
 * the platform team and the workspace's own data people open one to take it on or
 * connect it. Renders nothing while requests are off, or when nothing has been asked.
 */
import { useState } from 'react'
import { Database, Loader2, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { useFeature } from '@/store/features'
import { useAuthStore } from '@/store/auth'
import { useAppNotifications } from '@/components/ui/notifications'
import type { DataRequest } from '@/services/dataRequestsService'
import {
    DATA_REQUESTS_FEATURE, useCanFulfil, useDataRequestActions, useWorkspaceDataRequests,
} from '@/hooks/useDataRequests'
import { DataRequestProgress } from './DataRequestProgress'
import { ReviewDataRequestDrawer } from './ReviewDataRequestDrawer'
import { STATUS_LABEL, STATUS_PILL, URGENCY_BADGE, systemOf, urgencyOf } from './systems'
import { SystemTile } from './SystemTile'

export function WorkspaceDataRequestsPanel({ workspaceId }: { workspaceId: string }) {
    const on = useFeature(DATA_REQUESTS_FEATURE)
    const { data } = useWorkspaceDataRequests(workspaceId)
    const rows = data ?? []
    if (!on || rows.length === 0) return null
    return <RequestList workspaceId={workspaceId} rows={rows} />
}

function RequestList({ workspaceId, rows }: { workspaceId: string; rows: DataRequest[] }) {
    const meId = useAuthStore(s => s.user?.id)
    const canFulfil = useCanFulfil(workspaceId)
    const { withdraw } = useDataRequestActions()
    const { notify } = useAppNotifications()
    const [reviewing, setReviewing] = useState<DataRequest | null>(null)
    const open = rows.filter(r => r.status === 'pending' || r.status === 'in_progress').length

    return (
        <section aria-labelledby="ws-data-requests-title" className="mt-6 overflow-hidden rounded-2xl border border-glass-border bg-canvas-elevated">
            <div className="flex items-center gap-2 border-b border-glass-border px-5 py-3">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 text-white">
                    <Database className="h-3.5 w-3.5" aria-hidden />
                </span>
                <h2 id="ws-data-requests-title" className="text-sm font-bold text-ink">Data requests</h2>
                {open > 0 && (
                    <span className="rounded-full bg-indigo-500/10 px-2 py-0.5 text-[11px] font-semibold text-indigo-700 dark:text-indigo-300">{open} open</span>
                )}
            </div>
            <ul className="divide-y divide-glass-border">
                {rows.map(r => {
                    const mine = r.requestedBy === meId
                    const urgent = r.status === 'pending' || r.status === 'in_progress' ? URGENCY_BADGE[r.urgency] : undefined
                    return (
                        <li key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5 sm:flex-nowrap">
                            <SystemTile system={r.system} />
                            <span className="min-w-0 flex-1">
                                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                    <span className="truncate text-sm font-semibold text-ink">{r.title}</span>
                                    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', STATUS_PILL[r.status])}>{STATUS_LABEL[r.status]}</span>
                                    {urgent && <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', urgent)}>{urgencyOf(r.urgency).label}</span>}
                                </span>
                                <span className="mt-0.5 block text-[11px] text-ink-muted">
                                    {systemOf(r.system).label} · asked by {mine ? 'you' : r.requesterName || 'someone'} · {timeAgo(r.createdAt)}
                                    {r.status === 'in_progress' && ` · ${r.assigneeName || 'someone'} is on it`}
                                    {r.status === 'connected' && r.dataSourceLabel && ` · connected as ${r.dataSourceLabel}`}
                                </span>
                                {(r.status === 'declined' || r.status === 'connected') && r.resolutionNote && (
                                    <span className="mt-1 block text-xs text-ink-secondary">“{r.resolutionNote}”</span>
                                )}
                            </span>
                            {/* A column of its own, so the steppers line up whatever each row offers. */}
                            <div className="flex w-full shrink-0 items-center gap-2 sm:w-64">
                                <DataRequestProgress status={r.status} assigneeName={r.assigneeName} compact />
                                {mine && r.status === 'pending' && (
                                    <button type="button" disabled={withdraw.isPending}
                                        onClick={() => withdraw.mutate(r.id, {
                                            onSuccess: () => notify('success', `Withdrew “${r.title}”.`),
                                            onError: e => notify('error', e instanceof Error ? e.message : 'Couldn’t withdraw it.'),
                                        })}
                                        aria-label={`Withdraw ${r.title}`}
                                        className="inline-flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold text-ink-secondary hover:bg-black/[0.04] dark:hover:bg-white/[0.06] disabled:opacity-50">
                                        {withdraw.isPending && withdraw.variables === r.id
                                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Undo2 className="h-3.5 w-3.5" aria-hidden />}
                                        Withdraw
                                    </button>
                                )}
                                {canFulfil && (r.status === 'pending' || r.status === 'in_progress') && (
                                    <button type="button" onClick={() => setReviewing(r)} aria-label={`Review ${r.title}`}
                                        className="shrink-0 rounded-xl border border-glass-border px-3 py-1.5 text-xs font-semibold text-ink hover:border-indigo-500/40 hover:bg-indigo-500/[0.05]">
                                        Review
                                    </button>
                                )}
                            </div>
                        </li>
                    )
                })}
            </ul>
            {reviewing && <ReviewDataRequestDrawer request={reviewing} onClose={() => setReviewing(null)} />}
        </section>
    )
}
