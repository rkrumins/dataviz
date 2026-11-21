/**
 * The reader's workspace requests, on My access: where each open one stands (with
 * its tracker and what they can do about it), then the ones already answered.
 * `?tab=workspaces` (an inbox link) brings it into view. Renders nothing while
 * workspace requests are off, or when the reader has never asked.
 */
import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Building2, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { useFeature } from '@/store/features'
import { OPEN_REQUEST_STATUSES, type WorkspaceRequestStatus } from '@/services/workspaceRequestsService'
import {
    WORKSPACE_REQUESTS_FEATURE, useCanAnswerWorkspaceRequests, useMyWorkspaceRequests, useRequestWorkspaceWizard,
} from '@/hooks/useWorkspaceRequests'
import { WorkspaceRequestStatus as StatusCard } from './WorkspaceRequestCard'

const PAST: Partial<Record<WorkspaceRequestStatus, { label: string; tone: string }>> = {
    approved: { label: 'Approved', tone: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
    declined: { label: 'Declined', tone: 'bg-rose-500/10 text-rose-700 dark:text-rose-300' },
    withdrawn: { label: 'Withdrawn', tone: 'bg-black/[0.05] dark:bg-white/[0.06] text-ink-secondary' },
}

export function MyWorkspaceRequestsPanel() {
    const on = useFeature(WORKSPACE_REQUESTS_FEATURE)
    const canCreate = useCanAnswerWorkspaceRequests()
    const { data } = useMyWorkspaceRequests()
    const openWizard = useRequestWorkspaceWizard(s => s.openWizard)
    const [params] = useSearchParams()
    const ref = useRef<HTMLElement>(null)
    const wanted = params.get('tab') === 'workspaces'

    useEffect(() => {
        if (wanted && data) ref.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
    }, [wanted, data])

    if (!on || (!data?.length && canCreate)) return null
    const open = (data ?? []).filter(r => OPEN_REQUEST_STATUSES.includes(r.status))
    const past = (data ?? []).filter(r => !OPEN_REQUEST_STATUSES.includes(r.status))

    return (
        <section ref={ref} id="workspace-requests" aria-labelledby="my-ws-requests-title" className="space-y-3">
            <div className="flex items-center justify-between gap-3">
                <h2 id="my-ws-requests-title" className="flex items-center gap-2 text-sm font-bold text-ink">
                    <Building2 className="h-4 w-4 text-violet-500" aria-hidden /> Your workspace requests
                </h2>
                {!canCreate && open.length === 0 && (
                    <button type="button" onClick={() => openWizard()}
                        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-violet-700 dark:text-violet-300 hover:bg-violet-500/10">
                        <Plus className="h-3.5 w-3.5" aria-hidden /> Request a workspace
                    </button>
                )}
            </div>
            {open.map(r => <StatusCard key={r.id} request={r} />)}
            {!data?.length && (
                <p className="rounded-2xl border border-dashed border-glass-border px-4 py-5 text-center text-sm text-ink-muted">
                    You haven’t asked for a workspace of your own. When you’re ready, the platform team can set one up for you.
                </p>
            )}
            {past.length > 0 && (
                <ul aria-label="Answered workspace requests" className="divide-y divide-glass-border overflow-hidden rounded-2xl border border-glass-border bg-canvas-elevated">
                    {past.map(r => {
                        const meta = PAST[r.status]
                        return (
                            <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm font-medium text-ink">{r.name}</span>
                                    <span className="block text-[11px] text-ink-muted">
                                        Sent {timeAgo(r.createdAt)}{r.resolutionNote ? ` · “${r.resolutionNote}”` : ''}
                                    </span>
                                </span>
                                {meta && <span className={cn('shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold', meta.tone)}>{meta.label}</span>}
                            </li>
                        )
                    })}
                </ul>
            )}
        </section>
    )
}
