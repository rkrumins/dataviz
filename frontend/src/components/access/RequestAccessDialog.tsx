/**
 * Request access — ask to join a workspace, in three short steps.
 *
 * 1. **What do you need?** The levels the workspace lets people ask for,
 *    in plain language. One you already have can't be asked for again.
 * 2. **Why?** The workspace's own note for people asking comes first —
 *    "say which team you're on" — then yours, which is all an approver has
 *    to decide on.
 * 3. **What happens next.** Who answers, and how the answer reaches you.
 *    Where the identity provider decides who is in, that is said up front:
 *    the answer may be a group for IT to add you to.
 *
 * Opened from Find a workspace, the access-denied card, and a workspace
 * page you can't open — where the workspace may have no name to show, so
 * the dialog never needs one.
 */
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
    ArrowRight, Check, CheckCircle2, Inbox, KeyRound, Loader2, MessageSquareQuote, Send, ShieldCheck, Users, X,
} from 'lucide-react'

import { Backdrop } from '@/components/ui/Backdrop'
import { useModalA11y } from '@/hooks/useModalA11y'
import { useAccessRequestActions, useRequestableRoles } from '@/hooks/useWorkspaceAccess'
import type { AccessRequestResponse, WorkspaceAccessMode } from '@/services/accessRequestsService'
import { cn } from '@/lib/utils'
import { accessLevel, idpInstruction, roleLabel } from './accessRequestCopy'

export interface RequestAccessDialogProps {
    workspaceId: string
    /** Unknown when the person can't see the workspace yet. */
    workspaceName?: string | null
    accessMode?: WorkspaceAccessMode | null
    /** The workspace's note for people asking. */
    accessNote?: string | null
    /** Roles they already hold there — shown, not offered. */
    heldRoles?: string[]
    /** Preselected level, when the moment says which (an edit that was refused). */
    defaultRole?: string
    onClose: () => void
    onSent?: (request: AccessRequestResponse) => void
}

export function RequestAccessDialog({
    workspaceId, workspaceName, accessMode, accessNote, heldRoles = [], defaultRole, onClose, onSent,
}: RequestAccessDialogProps) {
    const ref = useModalA11y(true, onClose)
    const { roles, isLoading, error: rolesError } = useRequestableRoles(workspaceId)
    const { submit } = useAccessRequestActions()
    const [picked, setPicked] = useState<string | null>(null)
    const [why, setWhy] = useState('')
    const [sent, setSent] = useState<AccessRequestResponse | null>(null)

    const offered = roles ?? []
    const choice = picked
        ?? (defaultRole && offered.some(r => r.name === defaultRole && !heldRoles.includes(r.name)) ? defaultRole : null)
        ?? offered.find(r => !heldRoles.includes(r.name))?.name
        ?? null
    const where = workspaceName ? `“${workspaceName}”` : 'this workspace'
    const idp = accessMode === 'idp'

    const send = async () => {
        if (!choice) return
        try {
            const request = await submit.mutateAsync({
                targetType: 'workspace',
                targetId: workspaceId,
                requestedRole: choice,
                justification: why.trim() || null,
            })
            setSent(request)
            onSent?.(request)
        } catch {
            // Shown below from the mutation's own error.
        }
    }

    return (
        <>
            <Backdrop open onClick={onClose} zClassName="z-[80]" className="bg-black/50" />
            <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 pointer-events-none">
                <div
                    ref={ref}
                    role="dialog"
                    aria-modal="true"
                    aria-label={workspaceName ? `Ask to join ${workspaceName}` : 'Ask to join this workspace'}
                    tabIndex={-1}
                    className="pointer-events-auto w-full max-w-xl max-h-[calc(100vh-2rem)] overflow-y-auto rounded-2xl bg-canvas-elevated border border-slate-200 dark:border-slate-700 shadow-2xl focus:outline-none animate-in fade-in zoom-in-95 duration-200"
                >
                    <div className="h-1 rounded-t-2xl bg-gradient-to-r from-emerald-500 via-teal-500 to-sky-500" />
                    <header className="flex items-start gap-3 px-6 pt-5 pb-3">
                        <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                            {sent ? <CheckCircle2 className="w-5 h-5" aria-hidden /> : <Users className="w-5 h-5" aria-hidden />}
                        </div>
                        <div className="flex-1 min-w-0">
                            <h2 className="text-lg font-bold text-ink">
                                {sent ? 'Request sent' : `Ask to join ${where}`}
                            </h2>
                            <p className="text-xs text-ink-muted mt-0.5">
                                {sent
                                    ? 'The people who look after it have it now.'
                                    : 'Choose what you need and say why. The people who look after it decide.'}
                            </p>
                        </div>
                        <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5">
                            <X className="w-4 h-4" />
                        </button>
                    </header>

                    {sent ? (
                        <SentState request={sent} where={where} idp={idp} onClose={onClose} />
                    ) : (
                        <>
                            <div className="px-6 pb-2 space-y-5">
                                <section aria-labelledby="request-level">
                                    <StepTitle n={1} id="request-level">What do you need?</StepTitle>
                                    {isLoading ? (
                                        <div className="grid gap-2 mt-2">
                                            {[0, 1, 2].map(i => <div key={i} className="h-14 rounded-xl bg-black/5 dark:bg-white/5 animate-pulse" />)}
                                        </div>
                                    ) : rolesError ? (
                                        <p role="alert" className="mt-2 text-sm text-rose-600 dark:text-rose-400">
                                            This workspace doesn’t exist any more, or can’t take requests right now.
                                        </p>
                                    ) : (
                                        <div role="radiogroup" aria-labelledby="request-level" className="grid gap-2 mt-2">
                                            {offered.map(role => {
                                                const held = heldRoles.includes(role.name)
                                                const level = accessLevel(role)
                                                const selected = choice === role.name
                                                return (
                                                    <button
                                                        key={role.name}
                                                        type="button"
                                                        role="radio"
                                                        aria-checked={selected}
                                                        disabled={held}
                                                        onClick={() => setPicked(role.name)}
                                                        className={cn(
                                                            'flex items-start gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors',
                                                            selected
                                                                ? 'border-emerald-500/50 bg-emerald-500/[0.06] ring-1 ring-emerald-500/30'
                                                                : 'border-glass-border hover:border-emerald-500/30 hover:bg-black/[0.02] dark:hover:bg-white/[0.03]',
                                                            held && 'opacity-55 cursor-not-allowed hover:border-glass-border',
                                                        )}
                                                    >
                                                        <span className={cn(
                                                            'mt-0.5 w-4 h-4 rounded-full border flex items-center justify-center shrink-0',
                                                            selected ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-300 dark:border-slate-600',
                                                        )}>
                                                            {selected && <Check className="w-2.5 h-2.5" strokeWidth={3} />}
                                                        </span>
                                                        <span className="min-w-0">
                                                            <span className="block text-sm font-semibold text-ink">
                                                                {level.title}
                                                                <span className="ml-1.5 text-[11px] font-medium text-ink-muted">{roleLabel(role.name)}</span>
                                                            </span>
                                                            <span className="block text-xs text-ink-secondary mt-0.5">
                                                                {held ? 'You already have this.' : level.blurb}
                                                            </span>
                                                        </span>
                                                    </button>
                                                )
                                            })}
                                        </div>
                                    )}
                                </section>

                                <section aria-labelledby="request-why">
                                    <StepTitle n={2} id="request-why">Why?</StepTitle>
                                    {accessNote && (
                                        <div className="mt-2 flex items-start gap-2 rounded-xl border border-sky-500/20 bg-sky-500/[0.05] px-3 py-2">
                                            <MessageSquareQuote className="w-3.5 h-3.5 mt-0.5 text-sky-500 shrink-0" aria-hidden />
                                            <p className="text-xs text-ink-secondary">
                                                <span className="font-semibold text-ink">From the workspace: </span>{accessNote}
                                            </p>
                                        </div>
                                    )}
                                    <textarea
                                        aria-labelledby="request-why"
                                        value={why}
                                        maxLength={1000}
                                        rows={3}
                                        onChange={e => setWhy(e.target.value)}
                                        placeholder="The team you’re on and what you need it for — it’s what the approver decides on"
                                        className="input border-slate-200 dark:border-slate-700 mt-2 w-full py-2 bg-glass-base/40 resize-none text-sm"
                                    />
                                </section>

                                <section aria-labelledby="request-next">
                                    <StepTitle n={3} id="request-next">What happens next</StepTitle>
                                    <ol className="mt-2 space-y-2">
                                        <TimelineStep icon={Inbox} title="The people who look after it hear about it">
                                            Its admins and stewards get your request in their Inbox.
                                        </TimelineStep>
                                        {idp ? (
                                            <TimelineStep icon={KeyRound} title="Your identity provider decides who is in">
                                                They’ll point you to the group that grants it — or, rarely, let you in here as an exception.
                                            </TimelineStep>
                                        ) : (
                                            <TimelineStep icon={ShieldCheck} title="They approve it, or say why not">
                                                They may grant a different level, or for a while.
                                            </TimelineStep>
                                        )}
                                        <TimelineStep icon={CheckCircle2} title="You hear back in your Inbox">
                                            {idp
                                                ? 'Once IT adds you to the group, access arrives the next time you sign in.'
                                                : 'Approved, the workspace appears in your list straight away.'}
                                        </TimelineStep>
                                    </ol>
                                </section>

                                {submit.error && (
                                    <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
                                        {(submit.error as Error).message}
                                    </p>
                                )}
                            </div>
                            <footer className="flex items-center justify-end gap-3 px-6 py-4">
                                <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5">
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    disabled={!choice || submit.isPending}
                                    onClick={() => void send()}
                                    className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold bg-gradient-to-r from-emerald-500 to-teal-600 text-white shadow-md disabled:opacity-50"
                                >
                                    {submit.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                                    Send request
                                </button>
                            </footer>
                        </>
                    )}
                </div>
            </div>
        </>
    )
}

function StepTitle({ n, id, children }: { n: number; id: string; children: string }) {
    return (
        <h3 id={id} className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
            <span className="w-4.5 h-4.5 min-w-[18px] rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[10px] font-bold flex items-center justify-center">
                {n}
            </span>
            {children}
        </h3>
    )
}

function TimelineStep({ icon: Icon, title, children }: { icon: typeof Inbox; title: string; children: ReactNode }) {
    return (
        <li className="flex items-start gap-2.5">
            <span className="mt-0.5 w-6 h-6 rounded-lg bg-black/5 dark:bg-white/5 text-ink-secondary flex items-center justify-center shrink-0">
                <Icon className="w-3.5 h-3.5" aria-hidden />
            </span>
            <span className="min-w-0">
                <span className="block text-xs font-semibold text-ink">{title}</span>
                <span className="block text-xs text-ink-muted">{children}</span>
            </span>
        </li>
    )
}

function SentState({ request, where, idp, onClose }: {
    request: AccessRequestResponse
    where: string
    idp: boolean
    onClose: () => void
}) {
    // Asking again returns the open request, so "sent" may be the earlier one.
    const earlier = Date.now() - new Date(request.createdAt).getTime() > 60_000
    return (
        <div className="px-6 pb-5">
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.05] px-4 py-3">
                <p className="text-sm text-ink">
                    {earlier
                        ? <>You’d already asked to join {where} on {new Date(request.createdAt).toLocaleDateString()} — it’s still open.</>
                        : <>You asked to join {where} as <span className="font-semibold">{roleLabel(request.requestedRole)}</span>.</>}
                </p>
                <p className="text-xs text-ink-muted mt-1">
                    {request.status === 'awaiting_idp' && request.idpGroup
                        ? idpInstruction(request.idpGroup, request.idpProvider)
                        : idp
                            ? 'You’ll hear in your Inbox — perhaps with a group for IT to add you to.'
                            : 'You’ll hear in your Inbox when someone answers.'}
                </p>
            </div>
            <div className="mt-4 flex items-center justify-end gap-3">
                <Link
                    to="/my/access"
                    onClick={onClose}
                    className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-600 dark:text-emerald-400 hover:underline"
                >
                    Follow it on My access <ArrowRight className="w-3.5 h-3.5" />
                </Link>
                <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-semibold bg-black/5 dark:bg-white/10 text-ink hover:bg-black/10 dark:hover:bg-white/15">
                    Done
                </button>
            </div>
        </div>
    )
}
