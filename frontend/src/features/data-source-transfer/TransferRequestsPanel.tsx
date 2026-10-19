/**
 * TransferRequestsPanel — data sources waiting to move.
 *
 * On the Workspaces page's Requests tab it lists every request to move a
 * source INTO a workspace the reader administers, above the access requests,
 * so everything waiting on them is in one place. `?transfer=<id>` (the Inbox
 * link) opens that request, answered or not. As a banner on one workspace's
 * Data Sources tab it shows both directions: what is waiting for this
 * workspace to accept, and what this workspace has asked another to take.
 * Either way it says nothing while nothing is waiting.
 */
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ArrowRight, ArrowRightLeft, Clock, Database, Loader2, ShieldCheck, XCircle } from 'lucide-react'

import { useAppNotifications } from '@/components/ui/notifications'
import { timeAgo } from '@/lib/timeAgo'
import type { DataSourceTransferResponse } from '@/services/dataSourceTransferService'
import { ReviewTransferDialog } from './ReviewTransferDialog'
import { WorkspaceTile } from './TransferRoute'
import { daysUntil, plural, workspaceLabel } from './transferCopy'
import { useIncomingTransfers, useTransferActions, useWorkspaceTransfers } from './useDataSourceTransfers'

export function TransferRequestsPanel({ variant = 'tab', workspaceId }: {
    variant?: 'tab' | 'banner'
    /** The workspace a banner belongs to. */
    workspaceId?: string
}) {
    return variant === 'banner' && workspaceId
        ? <WorkspaceBanner workspaceId={workspaceId} />
        : <IncomingList />
}

function IncomingList() {
    const [searchParams, setSearchParams] = useSearchParams()
    const linked = searchParams.get('transfer')
    const { transfers, error, refetch } = useIncomingTransfers('open')
    const [reviewing, setReviewing] = useState<string | null>(null)
    const list = transfers ?? []
    const openId = reviewing ?? linked

    const close = () => {
        setReviewing(null)
        if (linked) {
            const next = new URLSearchParams(searchParams)
            next.delete('transfer')
            setSearchParams(next, { replace: true })
        }
    }

    const dialog = openId ? <ReviewTransferDialog transferId={openId} onClose={close} /> : null
    if (error) {
        return (
            <>
                <div className="rounded-2xl border border-rose-500/25 bg-rose-500/[0.06] px-5 py-3 flex items-center gap-3 text-sm">
                    <p className="flex-1 text-rose-600 dark:text-rose-400">Couldn’t load data source requests: {error.message}</p>
                    <button type="button" onClick={() => void refetch()} className="text-xs font-semibold hover:underline">Retry</button>
                </div>
                {dialog}
            </>
        )
    }
    if (list.length === 0) return dialog

    return (
        <>
            <section className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden" aria-labelledby="transfer-requests-title">
                <div className="h-1 bg-gradient-to-r from-sky-500 via-indigo-500 to-violet-500" />
                <div className="px-5 py-3 border-b border-glass-border flex items-center gap-3">
                    <ArrowRightLeft className="w-4 h-4 text-sky-500" aria-hidden />
                    <h3 id="transfer-requests-title" className="text-sm font-bold text-ink">Data sources waiting to move in</h3>
                    <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-sky-500/15 text-sky-700 dark:text-sky-300">
                        {list.length} waiting
                    </span>
                </div>
                <ul className="divide-y divide-glass-border">
                    {list.map(t => <IncomingRow key={t.id} transfer={t} onReview={() => setReviewing(t.id)} />)}
                </ul>
            </section>
            {dialog}
        </>
    )
}

function IncomingRow({ transfer: t, onReview }: { transfer: DataSourceTransferResponse; onReview: () => void }) {
    const { notify } = useAppNotifications()
    const { decline } = useTransferActions()
    const [declining, setDeclining] = useState(false)
    const [note, setNote] = useState('')
    const who = t.createdBy?.name ?? 'Someone'
    const days = daysUntil(t.expiresAt)

    const confirmDecline = () => decline.mutate({ id: t.id, note: note.trim() || undefined }, {
        onSuccess: () => {
            notify('success', `Declined “${t.dataSource.name}”. ${who} will hear why.`)
            setDeclining(false)
        },
        onError: (err) => notify('error', (err as Error).message),
    })

    return (
        <li className="px-5 py-3.5 flex items-start gap-3">
            <span className="w-9 h-9 rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 text-white flex items-center justify-center shadow-md shadow-sky-500/20 shrink-0">
                <Database className="w-4 h-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink truncate">{t.dataSource.name}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-secondary">
                    <WorkspaceTile workspace={t.fromWorkspace} size="sm" />
                    {workspaceLabel(t.fromWorkspace.name)}
                    <ArrowRight className="w-3 h-3 text-ink-muted" aria-hidden />
                    <WorkspaceTile workspace={t.toWorkspace} size="sm" />
                    {workspaceLabel(t.toWorkspace.name)}
                </p>
                <p className="text-[11px] text-ink-muted mt-1">
                    {plural(t.viewCount, 'view')} · asked by {who} {timeAgo(t.createdAt)} · {plural(days, 'day')} left
                </p>
                {t.reason && <p className="text-xs text-ink-secondary mt-1 break-words">“{t.reason}”</p>}
                {declining && (
                    <div className="mt-2 flex flex-col sm:flex-row gap-2">
                        <input
                            autoFocus
                            value={note}
                            maxLength={500}
                            onChange={e => setNote(e.target.value)}
                            placeholder={`Why — ${who} sees this`}
                            aria-label="Reason for declining"
                            className="input flex-1 h-8 text-xs"
                        />
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={confirmDecline}
                                disabled={decline.isPending}
                                className="px-3 h-8 rounded-lg text-xs font-semibold bg-rose-500 text-white disabled:opacity-50"
                            >
                                {decline.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Decline'}
                            </button>
                            <button type="button" onClick={() => setDeclining(false)} className="px-3 h-8 rounded-lg text-xs font-semibold text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5">
                                Cancel
                            </button>
                        </div>
                    </div>
                )}
            </div>
            {!declining && (
                <div className="flex items-center gap-1.5 shrink-0">
                    <button
                        type="button"
                        onClick={onReview}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-sky-500/10 text-sky-700 dark:text-sky-300 border border-sky-500/20 hover:bg-sky-500/15"
                    >
                        <ShieldCheck className="w-3.5 h-3.5" /> Review
                    </button>
                    {t.canDecline && (
                        <button
                            type="button"
                            onClick={() => setDeclining(true)}
                            aria-label={`Decline moving ${t.dataSource.name} here`}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-ink-muted hover:text-rose-600 hover:bg-rose-500/5"
                        >
                            <XCircle className="w-3.5 h-3.5" /> Decline
                        </button>
                    )}
                </div>
            )}
        </li>
    )
}

function WorkspaceBanner({ workspaceId }: { workspaceId: string }) {
    const { notify } = useAppNotifications()
    const { transfers } = useWorkspaceTransfers(workspaceId, 'open')
    const { cancel } = useTransferActions()
    const [reviewing, setReviewing] = useState<string | null>(null)
    const list = transfers ?? []
    if (list.length === 0) return null

    return (
        <div className="space-y-2 mb-4">
            {list.map(t => {
                const incoming = t.toWorkspace.id === workspaceId
                return incoming ? (
                    <div key={t.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-sky-500/25 bg-sky-500/[0.06] px-4 py-3">
                        <ArrowRightLeft className="w-4 h-4 text-sky-500 shrink-0" aria-hidden />
                        <p className="flex-1 min-w-[14rem] text-sm text-ink">
                            <span className="font-semibold">“{t.dataSource.name}”</span> from {workspaceLabel(t.fromWorkspace.name)} is
                            waiting for you to accept it
                            <span className="text-ink-muted"> · {plural(t.viewCount, 'view')} · asked by {t.createdBy?.name ?? 'someone'} {timeAgo(t.createdAt)}</span>
                        </p>
                        <button
                            type="button"
                            onClick={() => setReviewing(t.id)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-sky-500/10 text-sky-700 dark:text-sky-300 border border-sky-500/20 hover:bg-sky-500/15"
                        >
                            <ShieldCheck className="w-3.5 h-3.5" /> Review
                        </button>
                    </div>
                ) : (
                    <div key={t.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3">
                        <Clock className="w-4 h-4 text-amber-500 shrink-0" aria-hidden />
                        <p className="flex-1 min-w-[14rem] text-sm text-ink">
                            <span className="font-semibold">“{t.dataSource.name}”</span> is waiting for {workspaceLabel(t.toWorkspace.name)}’s admins
                            <span className="text-ink-muted"> · {plural(daysUntil(t.expiresAt), 'day')} left</span>
                        </p>
                        {t.canCancel && (
                            <button
                                type="button"
                                disabled={cancel.isPending}
                                onClick={() => cancel.mutate({ id: t.id }, {
                                    onSuccess: () => notify('info', `Cancelled the request to move “${t.dataSource.name}”.`),
                                    onError: (err) => notify('error', (err as Error).message),
                                })}
                                className="px-3 py-1.5 rounded-lg text-xs font-semibold text-amber-700 dark:text-amber-300 bg-amber-500/10 hover:bg-amber-500/15 disabled:opacity-50"
                            >
                                Cancel request
                            </button>
                        )}
                    </div>
                )
            })}
            {reviewing && <ReviewTransferDialog transferId={reviewing} onClose={() => setReviewing(null)} />}
        </div>
    )
}
