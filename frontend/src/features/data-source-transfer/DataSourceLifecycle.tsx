/**
 * DataSourceLifecycle — where a data source has lived, in its drawer.
 *
 * The one thing that needs doing comes first: a request still waiting (with
 * Cancel), a move that can still be undone (with Undo, or the reason it no
 * longer can), or a request that was declined and why. Below it, the whole
 * history of moves as a timeline. A source that never moved shows nothing.
 *
 * `MovedFromChip` is the same history as a badge in the drawer's header: the
 * source's provenance, with who moved it, when and why on hover.
 */
import { useState } from 'react'
import { ArrowRightLeft, ChevronDown, Clock, History, Undo2, XCircle } from 'lucide-react'

import { HoverTip } from '@/components/ui/HoverTip'
import { useAppNotifications } from '@/components/ui/notifications'
import { timeAgo } from '@/lib/timeAgo'
import { cn } from '@/lib/utils'
import type { DataSourceTransferResponse } from '@/services/dataSourceTransferService'
import { UndoMoveDialog } from './UndoMoveDialog'
import { daysUntil, historyMoments, isWithinDays, plural, workspaceLabel } from './transferCopy'
import { useTransferActions, useTransferHistory } from './useDataSourceTransfers'

/** A decline stays worth mentioning for about as long as a request lives. */
const RECENT_DECLINE_DAYS = 14

/** The latest completed move INTO this workspace — how the source got here. */
function arrival(transfers: DataSourceTransferResponse[] | undefined, wsId: string) {
    return transfers?.find(t => t.status === 'completed' && t.toWorkspace.id === wsId) ?? null
}

export function DataSourceLifecycle({ wsId, dataSourceId, onChanged }: {
    wsId: string
    dataSourceId: string
    /** The source moved away (an undo) — the page refreshes. */
    onChanged?: () => void
}) {
    const { transfers } = useTransferHistory(wsId, dataSourceId)
    const { notify } = useAppNotifications()
    const { cancel } = useTransferActions()
    const [undoing, setUndoing] = useState<DataSourceTransferResponse | null>(null)
    const [showHistory, setShowHistory] = useState(false)

    if (!transfers?.length) return null
    const latest = transfers[0]
    const pending = latest.status === 'pending' ? latest : null
    const moved = !pending ? arrival(transfers, wsId) : null
    const declined = !pending && latest.status === 'declined' && isWithinDays(latest.resolvedAt, RECENT_DECLINE_DAYS)
        ? latest : null
    const moments = historyMoments(transfers)

    return (
        <div className="px-6 pt-3 shrink-0 space-y-2">
            {pending && (
                <Card tone="amber" icon={Clock}>
                    Waiting for <span className="font-semibold">{workspaceLabel(pending.toWorkspace.name)}</span>’s admins
                    <span className="text-ink-muted"> · asked by {pending.createdBy?.name ?? 'someone'} {timeAgo(pending.createdAt)} · expires in {plural(daysUntil(pending.expiresAt), 'day')}</span>
                    {pending.canCancel && (
                        <Action
                            busy={cancel.isPending}
                            onClick={() => cancel.mutate({ id: pending.id }, {
                                onSuccess: () => notify('info', `Cancelled the request to move it to ${workspaceLabel(pending.toWorkspace.name)}.`),
                                onError: (err) => notify('error', (err as Error).message),
                            })}
                        >
                            Cancel request
                        </Action>
                    )}
                </Card>
            )}
            {/* Only while the week to undo lasts; after it, the header's chip says where it came from. */}
            {moved && (moved.canUndo || (moved.undoBlockedBy && daysUntil(moved.undoUntil) > 0)) && (
                <Card tone="indigo" icon={ArrowRightLeft}>
                    Moved here from <span className="font-semibold">{workspaceLabel(moved.fromWorkspace.name)}</span>
                    {moved.completedAt && <span className="text-ink-muted"> by {(moved.kind === 'request' ? moved.resolvedBy : moved.createdBy)?.name ?? 'someone'}, {timeAgo(moved.completedAt)}</span>}
                    {moved.reason && <span className="text-ink-muted"> — “{moved.reason}”</span>}
                    {moved.canUndo ? (
                        <Action onClick={() => setUndoing(moved)}>
                            <Undo2 className="w-3 h-3" aria-hidden /> Undo
                        </Action>
                    ) : moved.undoBlockedBy && (
                        <span className="block text-[11px] text-ink-muted mt-0.5">{moved.undoBlockedBy}</span>
                    )}
                </Card>
            )}
            {declined && (
                <Card tone="rose" icon={XCircle}>
                    {workspaceLabel(declined.toWorkspace.name)} declined to take it
                    {declined.resolutionNote && <span className="text-ink-muted"> — “{declined.resolutionNote}”</span>}
                </Card>
            )}

            <button
                type="button"
                onClick={() => setShowHistory(v => !v)}
                aria-expanded={showHistory}
                className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-muted hover:text-ink"
            >
                <History className="w-3 h-3" aria-hidden />
                Where it has lived ({moments.length})
                <ChevronDown className={cn('w-3 h-3 transition-transform', showHistory && 'rotate-180')} />
            </button>
            {showHistory && (
                <ol className="relative ml-2 border-l border-black/[0.08] dark:border-white/[0.10] pl-4 pb-1 space-y-3">
                    {moments.map(m => {
                        const Icon = m.icon
                        return (
                            <li key={m.key} className="relative">
                                <span className={cn('absolute -left-[1.6rem] top-0 w-5 h-5 rounded-full border flex items-center justify-center bg-canvas', m.tint)}>
                                    <Icon className="w-2.5 h-2.5" aria-hidden />
                                </span>
                                <p className="text-xs font-semibold text-ink">{m.title}</p>
                                <p className="text-[11px] text-ink-muted">
                                    {m.by && <>{m.by} · </>}
                                    {timeAgo(m.at)}
                                </p>
                                {m.note && <p className="text-[11px] text-ink-secondary mt-0.5 break-words">“{m.note}”</p>}
                            </li>
                        )
                    })}
                </ol>
            )}

            {undoing && (
                <UndoMoveDialog transfer={undoing} onClose={() => setUndoing(null)} onUndone={() => onChanged?.()} />
            )}
        </div>
    )
}

const CARD_TONES = {
    amber: { box: 'border-amber-500/25 bg-amber-500/[0.06]', icon: 'text-amber-500' },
    indigo: { box: 'border-indigo-500/20 bg-indigo-500/[0.05]', icon: 'text-indigo-500' },
    rose: { box: 'border-rose-500/25 bg-rose-500/[0.06]', icon: 'text-rose-500' },
} as const

function Card({ tone, icon: Icon, children }: {
    tone: keyof typeof CARD_TONES
    icon: typeof Clock
    children: React.ReactNode
}) {
    const t = CARD_TONES[tone]
    return (
        <div className={cn('flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5', t.box)}>
            <Icon className={cn('w-4 h-4 mt-0.5 shrink-0', t.icon)} aria-hidden />
            <p className="flex-1 min-w-0 text-xs text-ink leading-relaxed">{children}</p>
        </div>
    )
}

function Action({ onClick, busy, children }: { onClick: () => void; busy?: boolean; children: React.ReactNode }) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={busy}
            className="ml-2 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10 disabled:opacity-50"
        >
            {children}
        </button>
    )
}

/** "Moved from Finance" — how this source came to be in this workspace. */
export function MovedFromChip({ wsId, dataSourceId }: { wsId: string; dataSourceId: string }) {
    const { transfers } = useTransferHistory(wsId, dataSourceId)
    const moved = arrival(transfers, wsId)
    if (!moved?.completedAt) return null
    const by = (moved.kind === 'request' ? moved.resolvedBy : moved.createdBy)?.name
    return (
        <HoverTip
            label={`Moved here ${timeAgo(moved.completedAt)}`}
            detail={[by && `By ${by}`, moved.reason && `“${moved.reason}”`].filter(Boolean).join(' — ') || undefined}
        >
            <span className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-full bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20">
                <ArrowRightLeft className="w-3 h-3" aria-hidden />
                Moved from {workspaceLabel(moved.fromWorkspace.name)}
            </span>
        </HoverTip>
    )
}
