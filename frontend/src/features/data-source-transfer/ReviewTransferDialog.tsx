/**
 * ReviewTransferDialog — answering a request to move a data source here.
 *
 * The reviewer reads what the proposer read, fresh: what moves, what stands
 * in the way, and who loses access when the views become this workspace's.
 * Anything that changed since they asked is said up front, because consent to
 * last week's preview is not consent to today's. Accepting is pinned to the preview on
 * screen: if it changes before the click lands, nothing moves and the
 * dialog shows the latest. Declining says why, to the person who asked.
 */
import { useState } from 'react'
import {
    AlertTriangle, ArrowRightLeft, Loader2, MessageSquareQuote, RefreshCw, ShieldCheck, X, XCircle,
} from 'lucide-react'

import { Backdrop } from '@/components/ui/Backdrop'
import { Skeleton } from '@/components/ui/Skeleton'
import { useAppNotifications } from '@/components/ui/notifications'
import { ReasonField } from '@/components/activity/ReasonField'
import { useReasonDraft } from '@/components/activity/useReasonDraft'
import { useModalA11y } from '@/hooks/useModalA11y'
import { formatUtc, timeAgo } from '@/lib/timeAgo'
import { cn } from '@/lib/utils'
import { httpStatusOf } from '@/services/graphRequestFailure'
import type { DataSourceTransferResponse, TransferChanges } from '@/services/dataSourceTransferService'
import { AccessPlanList } from './AccessPlanList'
import { TransferPreviewSummary } from './TransferPreviewSummary'
import { STATUS_META, daysUntil, plural, workspaceLabel } from './transferCopy'
import { useTransferActions, useTransferDetail } from './useDataSourceTransfers'

export function ReviewTransferDialog({ transferId, onClose }: { transferId: string; onClose: () => void }) {
    const ref = useModalA11y(true, onClose)
    const { notify } = useAppNotifications()
    const { detail, isLoading, isFetching, error, refetch } = useTransferDetail(transferId)
    const { accept, decline } = useTransferActions()
    const draft = useReasonDraft('move')
    const [addReason, setAddReason] = useState(false)
    const [declining, setDeclining] = useState(false)
    const [note, setNote] = useState('')
    const [stale, setStale] = useState<string | null>(null)
    const [failure, setFailure] = useState<string | null>(null)

    const t = detail?.transfer
    const preview = detail?.preview ?? null
    const from = workspaceLabel(t?.fromWorkspace.name)
    const to = workspaceLabel(t?.toWorkspace.name)
    const label = t?.dataSource.name ?? 'this data source'
    const who = t?.createdBy?.name ?? 'Someone'
    const open = t?.status === 'pending'
    const blocked = !preview || preview.blockers.length > 0
    const busy = accept.isPending || decline.isPending

    const onAccept = () => {
        if (!t || !preview) return
        setFailure(null)
        setStale(null)
        accept.mutate({ id: t.id, previewToken: preview.token, reason: draft.take() }, {
            onSuccess: () => {
                notify('success', `“${label}” now lives in ${to}.`)
                onClose()
            },
            onError: (err) => {
                const message = (err as Error).message
                if (httpStatusOf(err) === 409) {
                    setStale(message)
                    void refetch()
                } else {
                    setFailure(message)
                }
            },
        })
    }

    const onDecline = () => {
        if (!t) return
        setFailure(null)
        decline.mutate({ id: t.id, note: note.trim() || undefined }, {
            onSuccess: () => {
                notify('success', `Declined. ${who} will hear why.`)
                onClose()
            },
            onError: (err) => setFailure((err as Error).message),
        })
    }

    return (
        <>
            <Backdrop open onClick={() => !busy && onClose()} zClassName="z-[80]" className="bg-black/50" />
            <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 pointer-events-none">
                <div
                    ref={ref}
                    role="dialog"
                    aria-modal="true"
                    aria-label={t ? `Review moving ${label} to ${to}` : 'Review a data source transfer'}
                    tabIndex={-1}
                    className="pointer-events-auto w-full max-w-4xl max-h-[calc(100vh-2rem)] flex flex-col rounded-2xl bg-canvas-elevated border border-black/[0.08] dark:border-white/[0.10] shadow-2xl focus:outline-none animate-in fade-in zoom-in-95 duration-200"
                >
                    <div className="h-1 rounded-t-2xl bg-gradient-to-r from-sky-500 via-indigo-500 to-violet-500 shrink-0" />
                    <header className="flex items-start gap-3 px-6 pt-5 pb-4 border-b border-black/[0.08] dark:border-white/[0.10] shrink-0">
                        <span className="w-10 h-10 rounded-xl bg-sky-500/10 border border-sky-500/20 text-sky-500 flex items-center justify-center shrink-0">
                            <ArrowRightLeft className="w-5 h-5" aria-hidden />
                        </span>
                        <div className="flex-1 min-w-0">
                            <h2 className="text-lg font-bold text-ink">
                                {t ? <>{from} wants to move “{label}” to {to}</> : 'A data source transfer'}
                            </h2>
                            {t && (
                                <p className="text-xs text-ink-muted mt-0.5">
                                    Asked by <span className="font-semibold text-ink-secondary">{who}</span> {timeAgo(t.createdAt)}
                                    {open && t.expiresAt && <> · {plural(daysUntil(t.expiresAt), 'day')} left to answer</>}
                                </p>
                            )}
                        </div>
                        <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5">
                            <X className="w-4 h-4" />
                        </button>
                    </header>

                    <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
                        {isLoading ? (
                            <div className="space-y-4" aria-busy="true">
                                <Skeleton className="h-20 w-full rounded-2xl" />
                                <div className="grid grid-cols-3 gap-3">
                                    {[0, 1, 2].map(i => <Skeleton key={i} className="h-28 rounded-2xl" />)}
                                </div>
                            </div>
                        ) : error ? (
                            <div role="alert" className="flex items-center gap-3 rounded-2xl border border-rose-500/25 bg-rose-500/[0.06] px-4 py-3">
                                <p className="flex-1 text-sm text-rose-600 dark:text-rose-400">Couldn’t load this request: {error.message}</p>
                                <button type="button" onClick={() => void refetch()} className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-secondary hover:text-ink">
                                    <RefreshCw className="w-3.5 h-3.5" /> Retry
                                </button>
                            </div>
                        ) : t && !open ? (
                            <Answered transfer={t} />
                        ) : t ? (
                            <>
                                {t.reason && (
                                    <div className="flex items-start gap-2 rounded-xl border border-sky-500/20 bg-sky-500/[0.05] px-3.5 py-2.5">
                                        <MessageSquareQuote className="w-4 h-4 mt-0.5 text-sky-500 shrink-0" aria-hidden />
                                        <p className="text-sm text-ink-secondary">
                                            <span className="font-semibold text-ink">{who}: </span>“{t.reason}”
                                        </p>
                                    </div>
                                )}
                                {detail?.changesSinceRequest && <ChangesSince who={who} changes={detail.changesSinceRequest} />}
                                {stale && (
                                    <div role="status" className="flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-2.5">
                                        <RefreshCw className={cn('w-4 h-4 mt-0.5 text-amber-500 shrink-0', isFetching && 'animate-spin')} aria-hidden />
                                        <p className="text-sm text-ink">
                                            Something changed — here’s the latest. Nothing has moved.
                                            <span className="block text-xs text-ink-muted mt-0.5">{stale}</span>
                                        </p>
                                    </div>
                                )}
                                {preview && (
                                    <>
                                        <TransferPreviewSummary preview={preview} />
                                        <section aria-label="Who can see it afterwards" className="space-y-3">
                                            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                                                Who can see it afterwards
                                            </h3>
                                            <AccessPlanList access={preview.access} fromName={from} toName={to} />
                                        </section>
                                    </>
                                )}
                                {addReason && <ReasonField draft={draft} audience="workspace" note="Both workspaces’ admins see it." />}
                            </>
                        ) : null}
                        {failure && (
                            <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{failure}</p>
                        )}
                    </div>

                    {t && open && (
                        <footer className="px-6 py-4 border-t border-black/[0.08] dark:border-white/[0.10] shrink-0">
                            {declining ? (
                                <div className="flex flex-col sm:flex-row gap-2">
                                    <textarea
                                        autoFocus
                                        value={note}
                                        maxLength={500}
                                        rows={2}
                                        onChange={e => setNote(e.target.value)}
                                        placeholder={`Tell ${who} why (optional) — they see this`}
                                        aria-label="Why you're declining"
                                        className="input flex-1 py-2 text-sm resize-none"
                                    />
                                    <div className="flex sm:flex-col gap-2">
                                        <button
                                            type="button"
                                            onClick={onDecline}
                                            disabled={busy}
                                            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-rose-500 text-white disabled:opacity-50"
                                        >
                                            {decline.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                                            Decline
                                        </button>
                                        <button type="button" onClick={() => setDeclining(false)} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5">
                                            Back
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <div className="flex flex-wrap items-center gap-3">
                                    <button
                                        type="button"
                                        onClick={() => setDeclining(true)}
                                        disabled={busy || !t.canDecline}
                                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-ink-secondary hover:text-rose-600 hover:bg-rose-500/5 disabled:opacity-50"
                                    >
                                        <XCircle className="w-4 h-4" /> Decline
                                    </button>
                                    <div className="ml-auto flex items-center gap-3">
                                        {!addReason && (
                                            <button type="button" onClick={() => setAddReason(true)} className="text-xs font-semibold text-ink-muted hover:text-ink">
                                                Add a reason
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            onClick={onAccept}
                                            disabled={busy || blocked || !t.canAccept || isFetching}
                                            className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold bg-gradient-to-r from-emerald-500 to-teal-600 text-white shadow-md disabled:opacity-50"
                                        >
                                            {accept.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                                            Accept and move
                                        </button>
                                    </div>
                                </div>
                            )}
                            {!declining && blocked && preview && (
                                <p className="mt-2 text-[11px] text-ink-muted text-right">
                                    Accept once nothing stands in the way.
                                </p>
                            )}
                        </footer>
                    )}
                </div>
            </div>
        </>
    )
}

function ChangesSince({ who, changes }: { who: string; changes: TransferChanges }) {
    const parts = [
        changes.viewsAdded ? `${plural(changes.viewsAdded, 'new view')} will move too` : null,
        changes.viewsRemoved ? `${plural(changes.viewsRemoved, 'view')} no longer will` : null,
        changes.newPeople
            ? `${plural(changes.newPeople, 'more person or group', 'more people and groups')} will lose access`
            : null,
    ].filter((p): p is string => !!p)
    if (!parts.length) return null
    return (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-2.5">
            <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-500 shrink-0" aria-hidden />
            <p className="text-sm text-ink">
                <span className="font-semibold">Changed since {who} asked: </span>
                {parts.join(' · ')}
            </p>
        </div>
    )
}

function Answered({ transfer: t }: { transfer: DataSourceTransferResponse }) {
    const meta = STATUS_META[t.status]
    const Icon = meta.icon
    const by = t.resolvedBy?.name ?? t.undoneBy?.name
    const when = t.completedAt ?? t.resolvedAt
    return (
        <div className="rounded-2xl border border-black/[0.08] dark:border-white/[0.10] bg-black/[0.02] dark:bg-white/[0.03] px-5 py-6 text-center">
            <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold', meta.pill)}>
                <Icon className="w-3.5 h-3.5" aria-hidden /> {t.status === 'completed' ? 'Accepted' : meta.label}
            </span>
            <p className="mt-3 text-sm text-ink">
                {t.status === 'expired'
                    ? 'Nobody answered in time, so it expired. Nothing moved.'
                    : `${by ? `${by}, ` : ''}${when ? formatUtc(when) : ''}`}
            </p>
            {t.resolutionNote && <p className="mt-1 text-sm text-ink-secondary">“{t.resolutionNote}”</p>}
        </div>
    )
}
