/**
 * Access reviews — a workspace admin goes through who holds access here and
 * keeps or removes each grant. On the Members tab, for admins.
 *
 * A review is a snapshot of the grants made here — people's and teams' —
 * when it began, due in 7, 14 or 30 days. People whose identity provider or
 * an organization-wide role lets them in are counted, not reviewed: removing
 * them here wouldn't hold. Keeping changes nothing; removing takes the grant
 * away at once and tells the person why. Nothing is removed unless a
 * reviewer removes it; a review past its due date is only flagged. It
 * completes once every grant is decided, and downloads as a CSV for the
 * record.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
    Check, ClipboardCheck, Download, Loader2, Play, Trash2, Users2, X,
} from 'lucide-react'

import { ProvenanceChip } from '@/components/access/ProvenanceChip'
import { ServiceAccountBadge } from '@/components/serviceAccounts/parts'
import { roleLabel } from '@/components/access/accessRequestCopy'
import { Segmented } from '@/components/ui/Segmented'
import { useAppNotifications } from '@/components/ui/notifications'
import {
    accessReviewsService,
    type AccessReview,
    type AccessReviewDecision,
    type AccessReviewItem,
} from '@/services/accessReviewsService'
import { isServiceAccountId } from '@/lib/serviceAccounts'
import { timeAgo } from '@/lib/timeAgo'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'

const DUE = [
    { value: '7', label: '7 days' },
    { value: '14', label: '14 days' },
    { value: '30', label: '30 days' },
] as const

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '')

export function AccessReviewPanel({ workspaceId, onChanged }: {
    workspaceId: string
    /** A grant was removed — the bindings table should refetch. */
    onChanged?: () => void
}) {
    const { notify } = useAppNotifications()
    const queryClient = useQueryClient()
    const key = ['access-reviews', workspaceId]
    const { data: reviews, isLoading } = useQuery({
        queryKey: key,
        queryFn: () => accessReviewsService.list(workspaceId),
    })
    const openId = reviews?.find(r => r.status === 'open')?.id ?? null
    const { data: review } = useQuery({
        queryKey: [...key, openId],
        queryFn: () => accessReviewsService.get(workspaceId, openId as string),
        enabled: !!openId,
    })
    const [due, setDue] = useState<(typeof DUE)[number]['value']>('14')

    // Every answer carries the whole review: show it, and refresh the list.
    const settle = (next: AccessReview) => {
        queryClient.setQueryData([...key, next.id], next)
        void queryClient.invalidateQueries({ queryKey: key, exact: true })
    }
    const onError = (err: unknown) => notify('error', (err as Error).message)
    const start = useMutation({
        mutationFn: () => accessReviewsService.start(workspaceId, Number(due) as 7 | 14 | 30),
        onSuccess: settle,
        onError,
    })
    const finish = useMutation({
        mutationFn: (how: 'complete' | 'cancel') => accessReviewsService[how](workspaceId, openId as string),
        onSuccess: (next, how) => {
            settle(next)
            notify('success', how === 'complete' ? 'Access review completed.' : 'Access review cancelled.')
        },
        onError,
    })

    const past = (reviews ?? []).filter(r => r.status !== 'open').slice(0, 5)

    return (
        <section className="rounded-2xl border border-glass-border bg-canvas-elevated p-5 space-y-4" aria-labelledby="access-review-title">
            <div className="flex flex-wrap items-center gap-2">
                <ClipboardCheck className="w-4 h-4 text-violet-500" aria-hidden />
                <h3 id="access-review-title" className="text-sm font-bold text-ink">Access reviews</h3>
                {review && <DueChip review={review} />}
            </div>

            {isLoading ? (
                <div className="h-16 rounded-xl bg-black/5 dark:bg-white/5 animate-pulse" />
            ) : review ? (
                <OpenReview
                    review={review}
                    workspaceId={workspaceId}
                    onDecided={(next, decision) => {
                        settle(next)
                        if (decision === 'remove') onChanged?.()
                    }}
                    finishing={finish.isPending ? finish.variables : null}
                    onFinish={how => finish.mutate(how)}
                />
            ) : (
                <div className="flex flex-wrap items-end justify-between gap-4">
                    <p className="text-xs text-ink-muted max-w-xl">
                        Go through the grants made here — people’s and teams’ — and keep or remove each.
                        Nothing is removed unless you remove it, and the people affected hear why.
                    </p>
                    <div className="flex items-center gap-2">
                        <Segmented label="Due in" value={due} onChange={setDue} options={DUE} />
                        <button
                            type="button"
                            onClick={() => start.mutate()}
                            disabled={start.isPending}
                            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-violet-500 to-indigo-600 shadow-sm disabled:opacity-50"
                        >
                            {start.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                            Start a review
                        </button>
                    </div>
                </div>
            )}

            {past.length > 0 && (
                <ul className="border-t border-glass-border pt-3 space-y-1" aria-label="Earlier reviews">
                    {past.map(r => (
                        <li key={r.id} className="text-xs text-ink-muted">
                            <span className="font-semibold text-ink-secondary">
                                {r.status === 'completed' ? 'Completed' : 'Cancelled'} {day(r.completedAt)}
                            </span>
                            {' · '}{r.counts.kept} kept, {r.counts.removed} removed
                            {r.status === 'cancelled' && r.counts.undecided > 0 && `, ${r.counts.undecided} not decided`}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    )
}

function DueChip({ review }: { review: AccessReview }) {
    const overdue = new Date(review.dueAt).getTime() < useNow()
    return (
        <span className={cn(
            'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold',
            overdue
                ? 'border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-400'
                : 'border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-400',
        )}>
            {overdue ? `Overdue — was due ${day(review.dueAt)}` : `Due ${day(review.dueAt)}`}
        </span>
    )
}

function OpenReview({ review, workspaceId, onDecided, finishing, onFinish }: {
    review: AccessReview
    workspaceId: string
    onDecided: (next: AccessReview, decision: AccessReviewDecision) => void
    finishing: 'complete' | 'cancel' | null | undefined
    onFinish: (how: 'complete' | 'cancel') => void
}) {
    const [show, setShow] = useState<'undecided' | 'all'>('undecided')
    const { total, undecided } = review.counts
    const items = (review.items ?? []).filter(i => show === 'all' || !i.decision)
    const idp = review.notReviewed?.identityProvider ?? 0
    const orgWide = review.notReviewed?.organizationWide ?? 0
    const pct = total ? Math.round(((total - undecided) / total) * 100) : 100

    return (
        <div className="space-y-3">
            <div>
                <div className="flex items-center justify-between text-xs mb-1.5">
                    <span className="text-ink-secondary">
                        {undecided === 0 ? 'Every grant is decided' : `${undecided} of ${total} still to decide`}
                    </span>
                    <span className="text-ink-muted">
                        {review.counts.kept} kept · {review.counts.removed} removed
                    </span>
                </div>
                <div className="h-1.5 rounded-full bg-canvas-overlay overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Review progress">
                    <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-indigo-500" style={{ width: `${pct}%` }} />
                </div>
                {(idp > 0 || orgWide > 0) && (
                    <p className="text-[11px] text-ink-muted mt-2">
                        Not reviewed here, because removing them here wouldn’t hold:{' '}
                        {[
                            idp > 0 && `${idp} through your identity provider`,
                            orgWide > 0 && `${orgWide} with an organization-wide role`,
                        ].filter(Boolean).join(' and ')}.
                    </p>
                )}
            </div>

            <div className="flex items-center justify-between gap-2">
                <Segmented
                    label="Show"
                    value={show}
                    onChange={setShow}
                    options={[{ value: 'undecided', label: 'To decide' }, { value: 'all', label: 'All' }]}
                />
                <button
                    type="button"
                    onClick={() => downloadCsv(review)}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-secondary hover:text-ink"
                >
                    <Download className="w-3.5 h-3.5" /> Download CSV
                </button>
            </div>

            {items.length === 0 ? (
                <p className="py-6 text-center text-xs text-ink-muted">
                    {show === 'undecided' ? 'Nothing left to decide — complete the review.' : 'Nothing was granted here when it began.'}
                </p>
            ) : (
                <ul className="divide-y divide-glass-border rounded-xl border border-glass-border">
                    {items.map(item => (
                        <ReviewItem
                            key={item.id}
                            item={item}
                            workspaceId={workspaceId}
                            reviewId={review.id}
                            onDecided={onDecided}
                        />
                    ))}
                </ul>
            )}

            <div className="flex items-center justify-end gap-2">
                <button
                    type="button"
                    onClick={() => onFinish('cancel')}
                    disabled={!!finishing}
                    className="px-3 py-2 rounded-xl text-xs font-semibold text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50"
                >
                    {finishing === 'cancel' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Cancel review'}
                </button>
                <button
                    type="button"
                    onClick={() => onFinish('complete')}
                    disabled={undecided > 0 || !!finishing}
                    title={undecided > 0 ? 'Decide every grant first' : undefined}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-violet-500 to-indigo-600 disabled:opacity-50"
                >
                    {finishing === 'complete' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    Complete review
                </button>
            </div>
        </div>
    )
}

function ReviewItem({ item, workspaceId, reviewId, onDecided }: {
    item: AccessReviewItem
    workspaceId: string
    reviewId: string
    onDecided: (next: AccessReview, decision: AccessReviewDecision) => void
}) {
    const { notify } = useAppNotifications()
    const [confirming, setConfirming] = useState(false)
    const name = item.subject.displayName ?? item.subject.id
    const decide = useMutation({
        mutationFn: (decision: AccessReviewDecision) =>
            accessReviewsService.decide(workspaceId, reviewId, item.id, { decision }),
        onSuccess: (next, decision) => {
            setConfirming(false)
            onDecided(next, decision)
            if (decision === 'remove') notify('success', `Removed ${name}’s ${roleLabel(item.role)} access.`)
        },
        onError: err => notify('error', (err as Error).message),
    })
    const removed = item.decision === 'remove'
    // An integration's account: nobody signs in as it, and its managers are
    // who hear of a removal.
    const account = isServiceAccountId(item.subject.id)

    return (
        <li className={cn('px-4 py-3 flex flex-wrap items-center gap-3', removed && 'opacity-60')}>
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    {item.subject.type === 'group' && <Users2 className="w-3.5 h-3.5 text-violet-500" aria-label="Team" />}
                    <p className={cn('text-sm font-semibold text-ink truncate', removed && 'line-through')}>{name}</p>
                    {account && <ServiceAccountBadge />}
                    <span className="text-xs text-ink-muted">{roleLabel(item.role)}</span>
                    {item.origin && (
                        <ProvenanceChip provenance={{
                            origin: item.origin, source: null, by: null, at: item.grantedAt,
                            requestId: null, idpGroups: [], idpProvider: null,
                        }} />
                    )}
                </div>
                <p className="text-[11px] text-ink-muted mt-0.5">
                    {item.subject.secondary && <>{item.subject.secondary} · </>}
                    {item.grantedAt && <>granted {day(item.grantedAt)}</>}
                    {item.expiresAt && <> · ends {day(item.expiresAt)}</>}
                    {item.subject.type === 'user' && !account && (
                        <> · {item.lastLoginAt ? `last signed in ${timeAgo(item.lastLoginAt)}` : 'never signed in'}</>
                    )}
                    {account && <> · an integration acts as it; nobody signs in as it</>}
                </p>
            </div>
            {removed ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/20 bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold text-rose-600 dark:text-rose-400">
                    <Trash2 className="w-2.5 h-2.5" /> Removed
                </span>
            ) : confirming ? (
                <div className="flex items-center gap-1.5">
                    <span className="text-xs text-ink-secondary">
                        Remove now? {account ? 'Its managers will hear why.' : item.subject.type === 'user' ? 'They’ll hear why.' : 'Its members lose it.'}
                    </span>
                    <button
                        type="button"
                        onClick={() => decide.mutate('remove')}
                        disabled={decide.isPending}
                        className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-rose-500 text-white disabled:opacity-50"
                    >
                        {decide.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Remove'}
                    </button>
                    <button type="button" onClick={() => setConfirming(false)} aria-label="Don’t remove" className="p-1 rounded-lg text-ink-muted hover:text-ink">
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            ) : (
                <div className="flex items-center gap-1.5">
                    <button
                        type="button"
                        onClick={() => decide.mutate('keep')}
                        disabled={decide.isPending || item.decision === 'keep'}
                        aria-pressed={item.decision === 'keep'}
                        aria-label={`Keep ${name}’s ${roleLabel(item.role)} access`}
                        className={cn(
                            'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold border',
                            item.decision === 'keep'
                                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                : 'border-glass-border text-ink-secondary hover:border-emerald-500/30 hover:text-emerald-700',
                        )}
                    >
                        <Check className="w-3.5 h-3.5" /> {item.decision === 'keep' ? 'Kept' : 'Keep'}
                    </button>
                    <button
                        type="button"
                        onClick={() => setConfirming(true)}
                        aria-label={`Remove ${name}’s ${roleLabel(item.role)} access`}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold border border-glass-border text-ink-secondary hover:border-rose-500/30 hover:text-rose-600"
                    >
                        <Trash2 className="w-3.5 h-3.5" /> Remove
                    </button>
                </div>
            )}
        </li>
    )
}

/** The review as it stands, for the record. */
function downloadCsv(review: AccessReview) {
    const cell = (v: string | null | undefined) => `"${(v ?? '').replace(/"/g, '""')}"`
    const rows = [
        ['Name', 'Type', 'Email or members', 'Role', 'How they got it', 'Granted', 'Ends', 'Last signed in', 'Decision', 'Decided', 'Note'],
        ...(review.items ?? []).map(i => [
            i.subject.displayName ?? i.subject.id, i.subject.type, i.subject.secondary, roleLabel(i.role), i.origin,
            i.grantedAt, i.expiresAt, i.lastLoginAt, i.decision ?? 'undecided', i.decidedAt, i.note,
        ]),
    ]
    const csv = rows.map(r => r.map(cell).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `access-review-${review.workspaceId}-${review.startedAt.slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
}
