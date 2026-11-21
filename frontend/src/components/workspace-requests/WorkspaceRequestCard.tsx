/**
 * Where the reader's workspace request stands — or, when they have none, the way to
 * ask for one.
 *
 * `WorkspaceRequestStatus` follows one request through Sent → Reviewed → Ready: how
 * long it has waited, the platform team's question when they sent it back (with
 * Answer & resend), what they said when they declined, and the new workspace once it
 * is ready. `WorkspaceRequestPrompt` shows the latest request if there is one, else a
 * "Ready for your own workspace?" invitation to the wizard. Both render nothing while
 * workspace requests are off, and the prompt nothing for someone who may create
 * workspaces themselves.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, Building2, Clock, MessageCircleQuestion, Rocket, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { useFeature } from '@/store/features'
import { OPEN_REQUEST_STATUSES, type WorkspaceRequest } from '@/services/workspaceRequestsService'
import {
    WORKSPACE_REQUESTS_FEATURE, useCanAnswerWorkspaceRequests, useMyWorkspaceRequests, useRequestWorkspaceWizard,
    useWorkspaceRequestActions,
} from '@/hooks/useWorkspaceRequests'
import { useAppNotifications } from '@/components/ui/notifications'
import { NextSteps } from './NextSteps'
import { purposeLabel } from './RequestSteps'

const RECENT_MS = 14 * 24 * 3_600_000

/** The request worth showing: an open one, else one answered in the last fortnight. */
export function latestRequest(requests: WorkspaceRequest[] | undefined): WorkspaceRequest | null {
    const all = requests ?? []
    const open = all.find(r => OPEN_REQUEST_STATUSES.includes(r.status))
    if (open) return open
    const recent = all
        .filter(r => r.status === 'approved' || r.status === 'declined')
        .filter(r => Date.now() - Date.parse(r.resolvedAt ?? r.updatedAt ?? r.createdAt) < RECENT_MS)
        .sort((a, b) => Date.parse(b.resolvedAt ?? b.createdAt) - Date.parse(a.resolvedAt ?? a.createdAt))
    return recent[0] ?? null
}

const days = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)

export function WorkspaceRequestStatus({ request, className }: { request: WorkspaceRequest; className?: string }) {
    const navigate = useNavigate()
    const { notify } = useAppNotifications()
    const openWizard = useRequestWorkspaceWizard(s => s.openWizard)
    const { withdraw } = useWorkspaceRequestActions()
    const [confirming, setConfirming] = useState(false)

    const asked = request.status === 'changes_requested'
    const reached = request.status === 'approved' ? 3 : 1
    const waited = days(request.updatedAt ?? request.createdAt)

    return (
        <section aria-label={`Workspace request: ${request.name}`} data-tour="workspace-request"
            className={cn('relative overflow-hidden rounded-3xl border bg-canvas-elevated p-5',
                request.status === 'approved' ? 'border-emerald-500/30' : asked ? 'border-amber-500/30'
                    : request.status === 'declined' ? 'border-glass-border' : 'border-violet-500/25', className)}>
            <div aria-hidden className={cn('pointer-events-none absolute inset-0 bg-gradient-to-br',
                request.status === 'approved' ? 'from-emerald-500/[0.08] to-transparent'
                    : asked ? 'from-amber-500/[0.08] to-transparent' : 'from-violet-500/[0.07] via-transparent to-fuchsia-500/[0.05]')} />
            <div className="relative flex flex-col gap-4 sm:flex-row sm:items-start">
                <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-white shadow-md',
                    request.status === 'approved' ? 'bg-gradient-to-br from-emerald-500 to-teal-500 shadow-emerald-500/20'
                        : request.status === 'declined' ? 'bg-slate-400 dark:bg-slate-600 shadow-none'
                            : 'bg-gradient-to-br from-violet-500 to-fuchsia-500 shadow-violet-500/20')}>
                    {request.status === 'approved' ? <Rocket className="h-5 w-5" aria-hidden />
                        : request.status === 'declined' ? <XCircle className="h-5 w-5" aria-hidden />
                            : <Building2 className="h-5 w-5" aria-hidden />}
                </span>
                <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Your workspace request</p>
                    <h3 className="font-display text-lg font-bold text-ink truncate">{request.name}</h3>
                    <p className="text-xs text-ink-muted">
                        {purposeLabel(request.purpose)} · sent {timeAgo(request.createdAt)}
                        {request.status === 'pending' && waited >= 1 && (
                            <span className={cn('ml-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium',
                                waited >= 7 ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
                                    : waited >= 3 ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'bg-black/[0.04] dark:bg-white/[0.06]')}>
                                <Clock className="h-3 w-3" aria-hidden /> Waiting {waited} day{waited === 1 ? '' : 's'}
                            </span>
                        )}
                    </p>

                    {request.status !== 'declined' && (
                        <div className="mt-4 max-w-md"><NextSteps reached={reached} attention={asked} compact /></div>
                    )}

                    {asked && request.question && (
                        <div className="mt-4 flex items-start gap-2.5 rounded-2xl border border-amber-500/25 bg-canvas-elevated/80 p-3">
                            <MessageCircleQuestion className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                            <p className="text-sm text-ink"><span className="font-semibold">The platform team asks: </span>{request.question}</p>
                        </div>
                    )}
                    {request.status === 'declined' && (
                        <p className="mt-3 text-sm text-ink-secondary">
                            Declined{request.resolutionNote ? `: “${request.resolutionNote}”` : '.'} You can ask again with the details they need.
                        </p>
                    )}
                    {request.status === 'approved' && (
                        <p className="mt-3 text-sm text-ink-secondary">It’s ready — you’re its admin.</p>
                    )}
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-col sm:items-end">
                    {request.status === 'approved' && request.workspaceId && (
                        <button type="button" onClick={() => navigate(`/workspaces/${request.workspaceId}`)} className={PRIMARY}>
                            Open it <ArrowRight className="h-4 w-4" aria-hidden />
                        </button>
                    )}
                    {asked && (
                        <button type="button" onClick={() => openWizard({ editing: request })} className={PRIMARY}>
                            Answer &amp; resend <ArrowRight className="h-4 w-4" aria-hidden />
                        </button>
                    )}
                    {request.status === 'declined' && (
                        <button type="button" onClick={() => openWizard()} className={SECONDARY}>Ask again</button>
                    )}
                    {OPEN_REQUEST_STATUSES.includes(request.status) && (confirming ? (
                        <span className="flex items-center gap-1.5 text-xs">
                            <span className="text-ink-secondary">Withdraw it?</span>
                            <button type="button" disabled={withdraw.isPending}
                                onClick={() => withdraw.mutate(request.id, {
                                    onSuccess: () => notify('success', 'Request withdrawn.'),
                                    onError: e => notify('error', e instanceof Error ? e.message : 'Couldn’t withdraw it.'),
                                })}
                                className="rounded-lg px-2 py-1 font-semibold text-rose-600 hover:bg-rose-500/10">Withdraw</button>
                            <button type="button" onClick={() => setConfirming(false)} className="rounded-lg px-2 py-1 text-ink-muted hover:bg-black/[0.04]">Keep it</button>
                        </span>
                    ) : (
                        <button type="button" onClick={() => setConfirming(true)} className="text-xs font-medium text-ink-muted hover:text-ink">Withdraw</button>
                    ))}
                </div>
            </div>
        </section>
    )
}

/** The latest request, or an invitation to ask for a workspace. */
export function WorkspaceRequestPrompt({ preselectedSourceIds, className }: { preselectedSourceIds?: string[]; className?: string }) {
    const on = useFeature(WORKSPACE_REQUESTS_FEATURE)
    const canCreate = useCanAnswerWorkspaceRequests()
    const mine = useMyWorkspaceRequests()
    const openWizard = useRequestWorkspaceWizard(s => s.openWizard)
    if (!on || canCreate || mine.isLoading) return null
    const latest = latestRequest(mine.data)
    if (latest) return <WorkspaceRequestStatus request={latest} className={className} />
    return (
        <section aria-labelledby="ws-request-prompt-title" data-tour="workspace-request"
            className={cn('relative overflow-hidden rounded-3xl border border-violet-500/25 bg-canvas-elevated p-5', className)}>
            <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-r from-violet-600/[0.10] via-fuchsia-500/[0.06] to-amber-400/[0.06]" />
            <div aria-hidden className="pointer-events-none absolute -right-10 -top-16 h-44 w-44 rounded-full bg-fuchsia-500/20 blur-3xl" />
            <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-md shadow-violet-500/25">
                    <Rocket className="h-5 w-5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                    <h3 id="ws-request-prompt-title" className="font-display text-lg font-bold text-ink">Ready for a workspace of your own?</h3>
                    <p className="text-sm text-ink-secondary">
                        Ask the platform team for one. Bring what you built here, name your teammates — you’ll be its admin.
                    </p>
                </div>
                <button type="button" onClick={() => openWizard({ preselectedSourceIds })} className={cn(PRIMARY, 'shrink-0')}>
                    Request a workspace <ArrowRight className="h-4 w-4" aria-hidden />
                </button>
            </div>
        </section>
    )
}

const PRIMARY = 'inline-flex h-9 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-white bg-gradient-to-r from-violet-500 to-fuchsia-500 shadow-md shadow-violet-500/25 hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50'
const SECONDARY = 'inline-flex h-9 items-center gap-2 rounded-xl px-3.5 text-sm font-semibold border border-glass-border bg-canvas-elevated text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'
