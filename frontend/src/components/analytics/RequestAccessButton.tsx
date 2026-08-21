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
 * The submit endpoint already de-duplicates — a second request for the same
 * target and role returns the existing one rather than creating a duplicate —
 * so a double click costs nothing.
 */
import { useState } from 'react'
import { Check, KeyRound, Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { accessRequestsService } from '@/services/accessRequestsService'

type Phase = 'idle' | 'sending' | 'sent' | 'failed'

export function RequestAccessButton({
    workspaceId, className,
}: {
    workspaceId: string
    className?: string
}) {
    const [phase, setPhase] = useState<Phase>('idle')
    const [error, setError] = useState<string | null>(null)

    async function submit(e: React.MouseEvent) {
        // The row behind this may be clickable; asking for access is not the
        // same gesture as opening the thing.
        e.stopPropagation()
        setPhase('sending')
        setError(null)
        try {
            await accessRequestsService.submit({
                targetType: 'workspace',
                targetId: workspaceId,
                requestedRole: 'workspace_viewer',
            })
            setPhase('sent')
        } catch (err) {
            setError(err instanceof Error ? err.message : 'That could not be sent.')
            setPhase('failed')
        }
    }

    if (phase === 'sent') {
        return (
            <span
                className={cn(
                    'inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400',
                    className,
                )}
            >
                <Check className="h-3 w-3" /> Request sent
            </span>
        )
    }

    return (
        <span className={cn('inline-flex flex-col items-center gap-1', className)}>
            <button
                type="button"
                onClick={submit}
                disabled={phase === 'sending'}
                className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border bg-canvas-elevated px-2.5 py-1 text-[11px] font-semibold text-ink-secondary shadow-sm transition-colors outline-none hover:border-indigo-500/30 hover:text-ink focus-visible:ring-2 focus-visible:ring-indigo-500/50 disabled:opacity-60"
            >
                {phase === 'sending'
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : <KeyRound className="h-3 w-3" />}
                Request access
            </button>
            {error && (
                <span role="alert" className="text-[10px] text-rose-600 dark:text-rose-400">
                    {error}
                </span>
            )}
        </span>
    )
}
