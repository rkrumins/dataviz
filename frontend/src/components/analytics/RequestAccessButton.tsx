/**
 * A locked row is the best moment to ask for access.
 *
 * Someone has just found a workspace they want and cannot open. Without this
 * the discovery is a dead end and they go and find somebody on Slack; with it,
 * the request lands in the queue an administrator already watches — the same
 * queue the access-friction metrics on the Health tab measure.
 *
 * Requests `workspace_viewer`, the read-only workspace role. Deliberately not a
 * role picker: someone who cannot see the workspace cannot reason about which
 * role they need, and asking them to guess produces requests an approver then
 * has to correct. Read access is the right thing to ask for by default and the
 * approver can grant more.
 *
 * IT ASKS BEFORE IT SENDS, and that is not politeness. The row this sits on is
 * anonymous by design — the reader is looking at "Restricted workspace" and
 * cannot tell one from another — so a button that fired immediately sent a
 * request nobody could describe afterwards, to a queue they had no idea
 * existed. The confirmation says what is being asked for, why the name is
 * missing, who will see it, and what happens next, and takes a note so an
 * approver has something to decide on. That note is the only thing the
 * requester can actually offer, since they cannot name the place.
 *
 * The submit endpoint already de-duplicates — a second request for the same
 * target and role returns the existing one rather than creating a duplicate —
 * so a double click costs nothing.
 */
import { useState } from 'react'
import { Check, KeyRound, Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { accessRequestsService } from '@/services/accessRequestsService'

type Phase = 'idle' | 'asking' | 'sending' | 'sent' | 'failed'

export function RequestAccessButton({
    workspaceId, className,
}: {
    workspaceId: string
    className?: string
}) {
    const [phase, setPhase] = useState<Phase>('idle')
    const [note, setNote] = useState('')
    const [error, setError] = useState<string | null>(null)

    async function send() {
        setPhase('sending')
        setError(null)
        try {
            await accessRequestsService.submit({
                targetType: 'workspace',
                targetId: workspaceId,
                requestedRole: 'workspace_viewer',
                justification: note.trim() || null,
            })
            setPhase('sent')
        } catch (err) {
            setError(err instanceof Error ? err.message : 'That could not be sent.')
            setPhase('failed')
        }
    }

    if (phase === 'sent') {
        return (
            <span className={cn('inline-flex flex-col gap-0.5', className)}>
                <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                    <Check className="h-3 w-3" /> Request sent
                </span>
                {/* What happens next, said once. Otherwise "sent" is the end of
                    the story as far as the requester can tell, and they ask
                    somebody on chat anyway — which is the thing this replaces. */}
                <span className="text-[10px] leading-snug text-ink-muted">
                    An administrator of that workspace will review it. You will see the
                    workspace here once it is granted.
                </span>
            </span>
        )
    }

    if (phase === 'asking' || phase === 'sending' || phase === 'failed') {
        return (
            <span
                className={cn(
                    'block w-64 rounded-xl border border-glass-border bg-canvas-elevated p-3 text-left shadow-md',
                    className,
                )}
                onClick={(e) => e.stopPropagation()}
            >
                <span className="flex items-start gap-2">
                    <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />
                    <span className="min-w-0">
                        <span className="block text-[11px] font-bold text-ink">
                            Ask for read access
                        </span>
                        <span className="mt-1 block text-[10px] leading-relaxed text-ink-muted">
                            You are asking to open one workspace you are not a member of.
                            Its name is hidden because you cannot see it yet — an
                            administrator of that workspace will see which one you mean,
                            and can grant more than read access if you need it.
                        </span>
                    </span>
                </span>

                <label className="mt-2.5 block">
                    <span className="sr-only">Why you need access</span>
                    <textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        rows={2}
                        maxLength={280}
                        disabled={phase === 'sending'}
                        placeholder="Why you need it — the approver cannot see what you were looking at"
                        className="w-full resize-none rounded-lg border border-glass-border bg-canvas-base px-2 py-1.5 text-[11px] text-ink outline-none placeholder:text-ink-muted/70 focus-visible:ring-2 focus-visible:ring-indigo-500/40"
                    />
                </label>

                <span className="mt-2 flex items-center gap-2">
                    <button
                        type="button"
                        onClick={send}
                        disabled={phase === 'sending'}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white shadow-sm transition-colors outline-none hover:bg-indigo-500 focus-visible:ring-2 focus-visible:ring-indigo-500/50 disabled:opacity-60"
                    >
                        {phase === 'sending' && <Loader2 className="h-3 w-3 animate-spin" />}
                        {phase === 'sending' ? 'Sending' : 'Send request'}
                    </button>
                    <button
                        type="button"
                        onClick={() => { setPhase('idle'); setError(null) }}
                        disabled={phase === 'sending'}
                        className="rounded-lg px-2 py-1 text-[11px] font-medium text-ink-muted outline-none transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                    >
                        Cancel
                    </button>
                </span>

                {error && (
                    <span role="alert" className="mt-1.5 block text-[10px] text-rose-600 dark:text-rose-400">
                        {error}
                    </span>
                )}
            </span>
        )
    }

    return (
        <span className={cn('inline-flex flex-col items-center gap-1', className)}>
            <button
                type="button"
                // The row behind this may be clickable; asking for access is
                // not the same gesture as opening the thing.
                onClick={(e) => { e.stopPropagation(); setPhase('asking') }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border bg-canvas-elevated px-2.5 py-1 text-[11px] font-semibold text-ink-secondary shadow-sm transition-colors outline-none hover:border-indigo-500/30 hover:text-ink focus-visible:ring-2 focus-visible:ring-indigo-500/50 disabled:opacity-60"
            >
                <KeyRound className="h-3 w-3" />
                Request access
            </button>
        </span>
    )
}
