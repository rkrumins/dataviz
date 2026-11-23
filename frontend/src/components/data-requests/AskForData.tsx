/**
 * The ways into Ask for data, on a workspace: a button beside Add source (the primary
 * action for someone who can't add sources themselves, secondary for someone who can),
 * and a card for a workspace with no data yet. Each renders nothing where data can't be
 * asked for (`useAskForData`).
 */
import { ArrowRight, MessageSquarePlus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAskForData, type AskTarget } from '@/hooks/useDataRequests'
import { SYSTEMS } from './systems'
import { SystemTile } from './SystemTile'

export function AskForDataButton({ workspace, primary = false }: { workspace: AskTarget | null | undefined; primary?: boolean }) {
    const ask = useAskForData(workspace)
    if (!ask) return null
    return (
        <button type="button" onClick={ask}
            className={cn('flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors',
                primary
                    ? 'bg-gradient-to-r from-indigo-500 to-violet-500 text-white shadow-md shadow-indigo-500/25 hover:brightness-110'
                    : 'border border-glass-border text-ink-secondary hover:border-indigo-500/40 hover:text-indigo-600 dark:hover:text-indigo-400')}>
            <MessageSquarePlus className="h-4 w-4" aria-hidden /> Ask for data
        </button>
    )
}

/** For a workspace with no data connected yet: what can be asked for, and the way to. */
export function AskForDataPrompt({ workspace, canAddSources = false, className }: {
    workspace: AskTarget | null | undefined
    /** The reader can add sources themselves: this is for the data they can't. */
    canAddSources?: boolean
    className?: string
}) {
    const ask = useAskForData(workspace)
    if (!ask) return null
    return (
        <section aria-label="Ask for data" className={cn('relative overflow-hidden rounded-3xl border border-indigo-500/20 bg-canvas-elevated p-5', className)}>
            <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-indigo-500/[0.07] via-transparent to-violet-500/[0.05]" />
            <div className="relative flex flex-wrap items-center gap-4">
                <div className="min-w-0 flex-1">
                    <h3 className="font-display text-base font-bold text-ink">
                        {canAddSources ? 'Need data you can’t add yourself?' : 'Need data that isn’t here yet?'}
                    </h3>
                    <p className="mt-0.5 text-sm text-ink-secondary">
                        Tell the platform team what you need and where it lives — they connect it, and you’ll hear when it’s in.
                    </p>
                    <div aria-hidden className="mt-3 flex -space-x-1.5">
                        {SYSTEMS.slice(0, 7).map(s => (
                            <span key={s.value} className="rounded-lg bg-canvas-elevated ring-2 ring-canvas-elevated"><SystemTile system={s.value} size="sm" /></span>
                        ))}
                    </div>
                </div>
                <button type="button" onClick={ask}
                    className="inline-flex h-10 shrink-0 items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-4 text-sm font-semibold text-white shadow-md shadow-indigo-500/25 hover:brightness-110">
                    Ask for data <ArrowRight className="h-4 w-4" aria-hidden />
                </button>
            </div>
        </section>
    )
}
