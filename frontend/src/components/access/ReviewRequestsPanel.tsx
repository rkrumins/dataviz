/**
 * ReviewRequestsPanel — the requests someone answers, in one list.
 *
 * On the Workspaces page's Requests tab it spans every workspace the
 * caller lets people into; on a workspace's Members tab it is that
 * workspace's, above the members. Open requests come first with Review
 * (the decisions in ``ApproveRequestDialog``) and Deny with a reason;
 * All shows how each was answered. A request waiting says for how long —
 * the platform reminds its approvers after three days and tells the Org
 * Admins after a week — and one to keep access says when that access ends.
 */
import { useState } from 'react'
import { Bot, Clock, Inbox, KeyRound, Loader2, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react'

import { ServiceAccountBadge } from '@/components/serviceAccounts/parts'
import { Segmented } from '@/components/ui/Segmented'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { useAppNotifications } from '@/components/ui/notifications'
import { useAnswerActions, useRequestsToAnswer } from '@/hooks/useWorkspaceAccess'
import { OPEN_STATUSES, type AccessRequestResponse } from '@/services/accessRequestsService'
import { timeAgo } from '@/lib/timeAgo'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { ApproveRequestDialog } from './ApproveRequestDialog'
import { ServiceAccountFacts } from './ServiceAccountFacts'
import { STATUS_META, roleLabel } from './accessRequestCopy'

export function ReviewRequestsPanel({ workspaceId, hideWhenEmpty = false }: {
    /** One workspace's requests (the Members tab); every one the caller answers otherwise. */
    workspaceId?: string
    /** Say nothing while nothing is waiting — the Members tab's choice. */
    hideWhenEmpty?: boolean
}) {
    const [filter, setFilter] = useState<'open' | 'all'>('open')
    const { requests, isLoading, error, refetch } = useRequestsToAnswer(filter, { workspaceId })
    const [reviewing, setReviewing] = useState<AccessRequestResponse | null>(null)
    const list = requests ?? []

    if (hideWhenEmpty && filter === 'open' && !isLoading && !error && list.length === 0) return null

    return (
        <section className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden" aria-labelledby="review-requests-title">
            <div className="px-5 py-3 border-b border-glass-border flex flex-wrap items-center gap-3">
                <Inbox className="w-4 h-4 text-emerald-500" aria-hidden />
                <h3 id="review-requests-title" className="text-sm font-bold text-ink">Access requests</h3>
                {filter === 'open' && list.length > 0 && (
                    <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                        {list.length} waiting
                    </span>
                )}
                <div className="ml-auto">
                    <Segmented
                        label="Show"
                        value={filter}
                        onChange={setFilter}
                        options={[{ value: 'open', label: 'Open' }, { value: 'all', label: 'All' }]}
                    />
                </div>
            </div>

            {isLoading ? (
                <div className="py-10 flex items-center justify-center text-ink-muted"><Loader2 className="w-5 h-5 animate-spin" /></div>
            ) : error ? (
                <div className="px-5 py-4 flex items-center gap-3 text-sm">
                    <p className="flex-1 text-rose-600 dark:text-rose-400">Couldn’t load requests: {error.message}</p>
                    <button type="button" onClick={() => void refetch()} className="text-xs font-semibold hover:underline">Retry</button>
                </div>
            ) : list.length === 0 ? (
                <div className="px-5 py-10 text-center">
                    <p className="text-sm font-semibold text-ink-secondary">{filter === 'open' ? 'Nothing waiting' : 'No requests yet'}</p>
                    <p className="text-xs text-ink-muted mt-1">
                        People ask to join from Find a workspace, or from a link to a workspace they can’t open.
                    </p>
                </div>
            ) : (
                <ul className="divide-y divide-glass-border">
                    {list.map(r => (
                        <RequestRow key={r.id} request={r} showWorkspace={!workspaceId} onReview={() => setReviewing(r)} />
                    ))}
                </ul>
            )}

            {reviewing && <ApproveRequestDialog request={reviewing} onClose={() => setReviewing(null)} />}
        </section>
    )
}

function RequestRow({ request: r, showWorkspace, onReview }: {
    request: AccessRequestResponse
    showWorkspace: boolean
    onReview: () => void
}) {
    const { notify } = useAppNotifications()
    const { deny } = useAnswerActions()
    const [denying, setDenying] = useState(false)
    const [reason, setReason] = useState('')
    const who = r.requester.displayName ?? r.requester.email ?? r.requester.id
    const open = OPEN_STATUSES.includes(r.status)
    const meta = STATUS_META[r.status]
    const StatusIcon = meta.icon
    const now = useNow()
    const waited = r.status === 'pending' ? Math.floor((now - new Date(r.createdAt).getTime()) / 86_400_000) : 0

    const confirmDeny = () => deny.mutate({ id: r.id, note: reason.trim() || null }, {
        onSuccess: () => {
            notify('success', `Declined ${who}’s request.`)
            setDenying(false)
        },
        onError: (err) => notify('error', (err as Error).message),
    })

    return (
        <li className="px-5 py-3.5 flex items-start gap-3">
            {r.serviceAccount ? (
                <span className="w-9 h-9 rounded-full bg-sky-500/10 border border-sky-500/20 text-sky-600 dark:text-sky-400 flex items-center justify-center shrink-0">
                    <Bot className="w-4 h-4" aria-hidden />
                </span>
            ) : (
                <UserAvatar userId={r.requester.id} name={who} shape="gradient" className="w-9 h-9 text-xs font-bold shrink-0" />
            )}
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="text-sm font-semibold text-ink truncate">{who}</p>
                    {r.serviceAccount && <ServiceAccountBadge />}
                    {!r.serviceAccount && r.requester.email && r.requester.email !== who && (
                        <p className="text-xs text-ink-muted truncate">{r.requester.email}</p>
                    )}
                    <span className="text-xs text-ink-muted">
                        {r.bindingId ? 'asks to keep' : 'asks for'} <span className="font-semibold text-ink">{roleLabel(r.requestedRole)}</span>
                        {showWorkspace && <> in <span className="font-semibold text-ink">{r.target.label ?? r.target.id}</span></>}
                        {r.bindingId && r.currentExpiresAt && open && <> — ends {new Date(r.currentExpiresAt).toLocaleDateString()}</>}
                    </span>
                    {waited >= 1 && (
                        <span className={cn(
                            'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold',
                            waited >= 7
                                ? 'border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-400'
                                : waited >= 3
                                    ? 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                                    : 'border-slate-500/20 bg-slate-500/10 text-ink-muted',
                        )}>
                            <Clock className="w-2.5 h-2.5" /> Waiting {waited} {waited === 1 ? 'day' : 'days'}
                        </span>
                    )}
                    {open && r.escalatedAt && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/20 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-rose-600 dark:text-rose-400">
                            <ShieldAlert className="w-2.5 h-2.5" /> Sent to the Org Admins
                        </span>
                    )}
                    {r.target.accessMode === 'idp' && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/20 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-sky-600 dark:text-sky-400">
                            <KeyRound className="w-2.5 h-2.5" /> Identity provider
                        </span>
                    )}
                </div>
                {r.justification && <p className="text-xs text-ink-secondary mt-1 break-words">“{r.justification}”</p>}
                <ServiceAccountFacts request={r} />
                <p className="text-[10px] text-ink-muted mt-1 flex flex-wrap items-center gap-1.5">
                    <span className={cn('inline-flex items-center gap-1 rounded-full border px-1.5 py-px font-semibold', meta.pill)}>
                        <StatusIcon className="w-2.5 h-2.5" /> {meta.label}
                    </span>
                    Asked {timeAgo(r.createdAt)}
                    {r.status === 'awaiting_idp' && r.idpGroup && <> · pointed to “{r.idpGroup}”</>}
                    {r.status === 'approved' && r.bindingId && (
                        <> · kept, {r.accessExpiresAt ? `until ${new Date(r.accessExpiresAt).toLocaleDateString()}` : 'with no end date'}</>
                    )}
                    {r.status === 'approved' && !r.bindingId && (
                        <> · {r.grantedGroup ? `added to ${r.grantedGroup.name ?? 'a team'}` : r.idpGroup && r.fulfilledAt ? `arrived through “${r.idpGroup}”` : `granted ${roleLabel(r.grantedRole ?? r.requestedRole)}`}
                            {r.idpException && ' as an exception'}</>
                    )}
                    {r.status === 'denied' && r.resolutionNote && <> · “{r.resolutionNote}”</>}
                </p>

                {denying && (
                    <div className="mt-2 flex flex-col sm:flex-row gap-2">
                        <input
                            autoFocus
                            value={reason}
                            maxLength={1000}
                            onChange={e => setReason(e.target.value)}
                            placeholder={`Why — ${who} sees this`}
                            aria-label="Reason for declining"
                            className="input flex-1 h-8 text-xs"
                        />
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={confirmDeny}
                                disabled={deny.isPending}
                                className="px-3 h-8 rounded-lg text-xs font-semibold bg-rose-500 text-white disabled:opacity-50"
                            >
                                {deny.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Decline'}
                            </button>
                            <button type="button" onClick={() => setDenying(false)} className="px-3 h-8 rounded-lg text-xs font-semibold text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5">
                                Cancel
                            </button>
                        </div>
                    </div>
                )}
            </div>
            {open && !denying && (
                <div className="flex items-center gap-1.5 shrink-0">
                    <button
                        type="button"
                        onClick={onReview}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20 hover:bg-emerald-500/15"
                    >
                        <ShieldCheck className="w-3.5 h-3.5" /> Review
                    </button>
                    <button
                        type="button"
                        onClick={() => setDenying(true)}
                        aria-label={`Decline ${who}’s request`}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-ink-muted hover:text-rose-600 hover:bg-rose-500/5"
                    >
                        <XCircle className="w-3.5 h-3.5" /> Deny
                    </button>
                </div>
            )}
        </li>
    )
}
