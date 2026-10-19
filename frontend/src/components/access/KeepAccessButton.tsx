/**
 * Ask to keep time-limited access before it ends — on My access, beside each
 * grant made here that has an end date ahead.
 *
 * The workspace's admins and stewards answer it like any request and choose
 * how much longer. While one is open the grant says so instead; grants the
 * identity provider makes don't end this way, so they never offer it.
 */
import { useState } from 'react'
import { CalendarClock, Clock, Loader2, Send, X } from 'lucide-react'

import { Backdrop } from '@/components/ui/Backdrop'
import { useAppNotifications } from '@/components/ui/notifications'
import { useModalA11y } from '@/hooks/useModalA11y'
import { useAccessRequestActions } from '@/hooks/useWorkspaceAccess'
import { useNow } from '@/lib/useNow'
import { OPEN_STATUSES, type AccessRequestResponse } from '@/services/accessRequestsService'
import type { AccessBinding } from '@/services/permissionsService'
import { roleLabel } from './accessRequestCopy'

/** Whether a grant can be kept: in a workspace, made here, ending ahead. */
function canKeep(b: AccessBinding, now: number): boolean {
    return b.scope.type === 'workspace'
        && !b.viaGroup
        && !!b.expiresAt
        && new Date(b.expiresAt).getTime() > now
        && b.provenance?.origin !== 'idp'
}

export function KeepAccessButton({ binding, requests }: {
    binding: AccessBinding
    /** The caller's own requests — one open for this grant is shown instead. */
    requests: AccessRequestResponse[]
}) {
    const [asking, setAsking] = useState(false)
    const now = useNow()
    if (!canKeep(binding, now)) return null
    const open = requests.find(r => r.bindingId === binding.bindingId && OPEN_STATUSES.includes(r.status))
    if (open) {
        return (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400 shrink-0">
                <Clock className="w-2.5 h-2.5" aria-hidden /> Asked to keep it
            </span>
        )
    }
    return (
        <>
            <button
                type="button"
                onClick={() => setAsking(true)}
                className="inline-flex items-center gap-1 rounded-lg border border-indigo-500/20 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-semibold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/15 shrink-0"
            >
                <CalendarClock className="w-3 h-3" aria-hidden /> Ask to keep it
            </button>
            {asking && <KeepAccessDialog binding={binding} onClose={() => setAsking(false)} />}
        </>
    )
}

function KeepAccessDialog({ binding, onClose }: { binding: AccessBinding; onClose: () => void }) {
    const ref = useModalA11y(true, onClose)
    const { notify } = useAppNotifications()
    const { extend } = useAccessRequestActions()
    const [why, setWhy] = useState('')
    const where = binding.scope.label ?? 'this workspace'

    const send = () => extend.mutate(
        { bindingId: binding.bindingId, justification: why.trim() || null },
        {
            onSuccess: () => {
                notify('success', `Asked to keep your access to ${where}.`)
                onClose()
            },
        },
    )

    return (
        <>
            <Backdrop open onClick={onClose} zClassName="z-[80]" className="bg-black/50" />
            <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 pointer-events-none">
                <div
                    ref={ref}
                    role="dialog"
                    aria-modal="true"
                    aria-label={`Keep your access to ${where}`}
                    tabIndex={-1}
                    className="pointer-events-auto w-full max-w-md rounded-2xl bg-canvas-elevated border border-slate-200 dark:border-slate-700 shadow-2xl focus:outline-none animate-in fade-in zoom-in-95 duration-200"
                >
                    <div className="h-1 rounded-t-2xl bg-gradient-to-r from-indigo-500 via-violet-500 to-sky-500" />
                    <header className="flex items-start gap-3 px-6 pt-5 pb-3">
                        <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
                            <CalendarClock className="w-5 h-5" aria-hidden />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h2 className="text-lg font-bold text-ink">Keep your access to {where}?</h2>
                            <p className="text-xs text-ink-muted mt-0.5">
                                Your {roleLabel(binding.role)} access ends on{' '}
                                {new Date(binding.expiresAt as string).toLocaleDateString()}. Its admins and stewards
                                decide how much longer.
                            </p>
                        </div>
                        <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5">
                            <X className="w-4 h-4" />
                        </button>
                    </header>
                    <div className="px-6 pb-2">
                        <label className="block">
                            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Why you still need it (optional)</span>
                            <textarea
                                value={why}
                                maxLength={1000}
                                rows={3}
                                onChange={e => setWhy(e.target.value)}
                                placeholder="The audit runs into next month"
                                className="input border-slate-200 dark:border-slate-700 mt-1.5 w-full py-2 bg-glass-base/40 resize-none text-sm"
                            />
                        </label>
                        {extend.error && (
                            <p role="alert" className="mt-2 text-sm text-rose-600 dark:text-rose-400">{(extend.error as Error).message}</p>
                        )}
                    </div>
                    <footer className="flex items-center justify-end gap-3 px-6 py-4">
                        <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5">
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={send}
                            disabled={extend.isPending}
                            className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold bg-gradient-to-r from-indigo-500 to-violet-600 text-white shadow-md disabled:opacity-50"
                        >
                            {extend.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                            Ask to keep it
                        </button>
                    </footer>
                </div>
            </div>
        </>
    )
}
