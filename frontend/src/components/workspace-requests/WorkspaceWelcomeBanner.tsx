/**
 * "Your workspace is ready" — what a requester sees on landing in the workspace their
 * request became (`?welcome=1`, the approval notice's link): what was done for them
 * (graphs moved over, teammates added) and the next things worth doing.
 */
import { ArrowRight, PartyPopper, Plus, UserPlus, X } from 'lucide-react'
import type { WorkspaceRequest } from '@/services/workspaceRequestsService'

export function WorkspaceWelcomeBanner({ name, request, onNewView, onInvite, onDismiss }: {
    name: string
    /** The request it came from, when the reader can see it: says what moved and who joined. */
    request?: WorkspaceRequest | null
    onNewView?: () => void
    onInvite?: () => void
    onDismiss: () => void
}) {
    const moved = request?.outcome?.movedSources.length ?? 0
    const joined = request?.outcome?.membersAdded.length ?? 0
    const failed = request?.outcome?.failedSources.length ?? 0
    const done = [
        'you’re its admin',
        joined > 0 && `${joined} teammate${joined === 1 ? '' : 's'} joined`,
        moved > 0 && `${moved} graph${moved === 1 ? '' : 's'} came over from the Playground with ${moved === 1 ? 'its' : 'their'} views`,
        !!request?.outcome?.dataRequestIds?.length && 'the data you need was asked for — follow it under Data → Sources',
    ].filter(Boolean) as string[]

    return (
        <section aria-labelledby="ws-welcome-title" className="relative mt-5 overflow-hidden rounded-3xl border border-emerald-500/25 bg-canvas-elevated p-5 sm:p-6">
            <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-r from-emerald-500/[0.10] via-teal-500/[0.05] to-violet-500/[0.06]" />
            <div aria-hidden className="pointer-events-none absolute -right-12 -top-16 h-48 w-48 rounded-full bg-emerald-400/20 blur-3xl" />
            <button type="button" onClick={onDismiss} aria-label="Dismiss"
                className="absolute right-3 top-3 rounded-lg p-1.5 text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
                <X className="h-4 w-4" />
            </button>
            <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-lg shadow-emerald-500/25">
                    <PartyPopper className="h-6 w-6" aria-hidden />
                </span>
                <div className="min-w-0 flex-1 pr-6">
                    <h2 id="ws-welcome-title" className="font-display text-xl font-bold text-ink">“{name}” is ready</h2>
                    <p className="mt-0.5 text-sm text-ink-secondary">
                        {done.join(' · ').replace(/^./, c => c.toUpperCase())}.
                        {failed > 0 && ` ${failed} graph${failed === 1 ? '' : 's'} couldn’t be moved — ${failed === 1 ? 'it is' : 'they are'} still in the Playground.`}
                    </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {onInvite && (
                        <button type="button" onClick={onInvite}
                            className="inline-flex h-9 items-center gap-2 rounded-xl border border-glass-border bg-canvas-elevated px-3.5 text-sm font-semibold text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
                            <UserPlus className="h-4 w-4" aria-hidden /> Invite people
                        </button>
                    )}
                    {onNewView && (
                        <button type="button" onClick={onNewView}
                            className="inline-flex h-9 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-white bg-gradient-to-r from-emerald-500 to-teal-500 shadow-md shadow-emerald-500/25 hover:brightness-110">
                            <Plus className="h-4 w-4" aria-hidden /> Create a view <ArrowRight className="h-4 w-4" aria-hidden />
                        </button>
                    )}
                </div>
            </div>
        </section>
    )
}
