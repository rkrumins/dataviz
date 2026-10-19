/**
 * UndoMoveDialog — put a moved data source back where it was.
 *
 * Undo replays the move's own record in reverse, so it can promise exactly
 * what comes back: the source and the views that moved, and no trace of the
 * view-only access the move handed out.
 * Above the drawer and the wizard (z-[80]), because both offer it.
 */
import { Loader2, Undo2, X } from 'lucide-react'

import { Backdrop } from '@/components/ui/Backdrop'
import { useAppNotifications } from '@/components/ui/notifications'
import { ReasonField } from '@/components/activity/ReasonField'
import { useReasonDraft } from '@/components/activity/useReasonDraft'
import { useModalA11y } from '@/hooks/useModalA11y'
import type { DataSourceTransferResponse } from '@/services/dataSourceTransferService'
import { useTransferActions } from './useDataSourceTransfers'
import { plural, workspaceLabel } from './transferCopy'

export function UndoMoveDialog({ transfer, onClose, onUndone }: {
    transfer: DataSourceTransferResponse
    onClose: () => void
    onUndone?: (transfer: DataSourceTransferResponse) => void
}) {
    const ref = useModalA11y(true, onClose)
    const { notify } = useAppNotifications()
    const { undo } = useTransferActions()
    const draft = useReasonDraft('move-undo')
    const from = workspaceLabel(transfer.fromWorkspace.name)
    const to = workspaceLabel(transfer.toWorkspace.name)
    const label = transfer.dataSource.name

    const confirm = () => undo.mutate({ id: transfer.id, reason: draft.take() }, {
        onSuccess: (result) => {
            notify('success', `“${label}” is back in ${from}.`)
            onUndone?.(result)
            onClose()
        },
    })

    return (
        <>
            <Backdrop open onClick={() => !undo.isPending && onClose()} zClassName="z-[80]" className="bg-black/50" />
            <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 pointer-events-none">
                <div
                    ref={ref}
                    role="dialog"
                    aria-modal="true"
                    aria-label={`Undo the move of ${label}`}
                    tabIndex={-1}
                    className="pointer-events-auto w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto rounded-2xl bg-canvas-elevated border border-black/[0.08] dark:border-white/[0.10] shadow-2xl focus:outline-none animate-in fade-in zoom-in-95 duration-200"
                >
                    <div className="h-1 rounded-t-2xl bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500" />
                    <header className="flex items-start gap-3 px-6 pt-5 pb-3">
                        <span className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-500 flex items-center justify-center shrink-0">
                            <Undo2 className="w-5 h-5" aria-hidden />
                        </span>
                        <div className="flex-1 min-w-0">
                            <h2 className="text-lg font-bold text-ink">Move it back to {from}?</h2>
                            <p className="text-xs text-ink-muted mt-0.5">Everything the move changed is put back as it was.</p>
                        </div>
                        <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5">
                            <X className="w-4 h-4" />
                        </button>
                    </header>

                    <div className="px-6 pb-2 space-y-4">
                        <ul className="space-y-1.5 text-sm text-ink-secondary">
                            <li>“{label}” leaves {to} and goes back to {from}, with {plural(transfer.viewCount, 'view')}.</li>
                            {transfer.keptAccess > 0 && (
                                <li>The view-only access the move gave {plural(transfer.keptAccess, 'person or team', 'people and teams')} is removed.</li>
                            )}
                        </ul>
                        <ReasonField draft={draft} audience="workspace" onSubmit={confirm} onEscape={onClose} />
                        {undo.error && (
                            <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{(undo.error as Error).message}</p>
                        )}
                    </div>

                    <footer className="flex items-center justify-end gap-3 px-6 py-4">
                        <button type="button" onClick={onClose} disabled={undo.isPending} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50">
                            Keep it in {to}
                        </button>
                        <button
                            type="button"
                            onClick={confirm}
                            disabled={undo.isPending}
                            className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold bg-gradient-to-r from-amber-500 to-orange-600 text-white shadow-md disabled:opacity-50"
                        >
                            {undo.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Undo2 className="w-4 h-4" />}
                            Move it back
                        </button>
                    </footer>
                </div>
            </div>
        </>
    )
}
