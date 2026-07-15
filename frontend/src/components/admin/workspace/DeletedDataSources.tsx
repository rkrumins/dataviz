/**
 * "Recently deleted" — the trash, and the last place an undo can happen.
 *
 * It renders NOTHING when the trash is empty. A permanently-visible empty trash can is a standing
 * reminder of a thing that has not happened; this appears only when there is something to undo,
 * and disappears again the moment there isn't.
 *
 * The countdown is the honest part. A data source is restorable for a fixed window and then it is
 * genuinely gone, so each row says how long is left and turns amber when it runs low. And once
 * the purge has actually started, `restorable` goes false and Restore is not offered at all —
 * showing a button that would 409 is worse than showing none.
 */
import { useCallback, useEffect, useState } from 'react'
import { RotateCcw, Trash2, History, Loader2 } from 'lucide-react'
import { workspaceService, type DeletedDataSource } from '@/services/workspaceService'
import { cn } from '@/lib/utils'

interface Props {
    wsId: string
    canManage: boolean
    /** Bumping this refetches — the parent raises it after any delete or restore. */
    refreshKey?: number
    onRestore: (id: string, label: string) => void | Promise<void>
    onDeletePermanently: (id: string, label: string) => void
}

function ago(iso: string | null): string {
    if (!iso) return ''
    const secs = (Date.now() - new Date(iso).getTime()) / 1000
    if (secs < 60) return 'just now'
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
    return `${Math.floor(secs / 86400)}d ago`
}

export function DeletedDataSources({
    wsId, canManage, refreshKey, onRestore, onDeletePermanently,
}: Props) {
    const [rows, setRows] = useState<DeletedDataSource[]>([])
    const [busy, setBusy] = useState<string | null>(null)

    const load = useCallback(async () => {
        try {
            setRows(await workspaceService.listDeletedDataSources(wsId))
        } catch {
            setRows([])           // the trash failing to load must never block the page
        }
    }, [wsId])

    useEffect(() => { void load() }, [load, refreshKey])

    if (rows.length === 0) return null

    const restore = async (r: DeletedDataSource) => {
        setBusy(r.id)
        try { await onRestore(r.id, r.label) } finally { setBusy(null) }
    }

    return (
        <section className="mt-8">
            <div className="flex items-center gap-2 mb-3">
                <History className="w-4 h-4 text-ink-muted" />
                <h3 className="text-sm font-semibold text-ink">Recently deleted</h3>
                <span className="text-xs text-ink-muted">
                    {rows.length === 1 ? '1 data source' : `${rows.length} data sources`}
                </span>
            </div>

            <ul className="rounded-xl border border-glass-border divide-y divide-glass-border overflow-hidden">
                {rows.map(r => {
                    const soon = r.daysLeft <= 7
                    return (
                        <li
                            key={r.id}
                            className="flex items-center gap-3 px-4 py-3 bg-black/[0.015] dark:bg-white/[0.015]"
                        >
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium text-ink truncate">{r.label}</p>
                                <p className="text-xs text-ink-muted truncate">
                                    Deleted by {r.deletedBy} · {ago(r.deletedAt)}
                                </p>
                            </div>

                            {r.purging ? (
                                // Past the point of no return. Say so plainly rather than leaving
                                // a Restore button that would fail.
                                <span className="shrink-0 inline-flex items-center gap-1.5 text-xs font-medium
                                                 text-ink-muted rounded-full px-2.5 py-1
                                                 bg-black/5 dark:bg-white/5">
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                    Being deleted
                                </span>
                            ) : (
                                <span
                                    className={cn(
                                        'shrink-0 text-xs font-medium rounded-full px-2.5 py-1',
                                        soon
                                            ? 'text-amber-700 dark:text-amber-300 bg-amber-500/10'
                                            : 'text-ink-muted bg-black/5 dark:bg-white/5',
                                    )}
                                    title={`Permanently deleted after ${r.restoreWindowDays} days`}
                                >
                                    {r.daysLeft === 0
                                        ? 'Deleting today'
                                        : r.daysLeft === 1 ? '1 day left' : `${r.daysLeft} days left`}
                                </span>
                            )}

                            {canManage && (
                                <div className="shrink-0 flex items-center gap-1">
                                    {r.restorable && (
                                        <button
                                            onClick={() => void restore(r)}
                                            disabled={busy === r.id}
                                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs
                                                       font-semibold text-ink bg-canvas border border-glass-border
                                                       hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50
                                                       transition-colors"
                                        >
                                            {busy === r.id
                                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                : <RotateCcw className="w-3.5 h-3.5" />}
                                            Restore
                                        </button>
                                    )}
                                    {!r.purging && (
                                        <button
                                            onClick={() => onDeletePermanently(r.id, r.label)}
                                            title="Delete permanently"
                                            className="p-1.5 rounded-lg text-red-500 hover:bg-red-500/10
                                                       transition-colors"
                                        >
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                    )}
                                </div>
                            )}
                        </li>
                    )
                })}
            </ul>
        </section>
    )
}
