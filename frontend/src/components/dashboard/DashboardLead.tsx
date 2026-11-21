/**
 * DashboardLead — what the Dashboard opens with, below the search, chosen by the
 * Business / Technical toggle.
 *
 *   * Business: what is the reader's to do — reviews, requests, the Playground —
 *     with their views just below (the Work hub, which follows in both).
 *   * Technical: how the data behind their workspaces is doing, and the profiling
 *     findings beside it.
 *
 * A line above says which it is and switches it — the same switch as the toggle
 * at the top. Someone with no data source to read has no data health to lead
 * with: the page is the same in either view, so the line isn't shown.
 */
import { Briefcase, Code2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePersonaStore } from '@/store/persona'
import { Kbd } from '@/components/ui/Kbd'
import { DashboardDataHealth } from './DashboardDataHealth'
import { useHasDataHealth } from './dataHealth'
import { DashboardForYou } from './DashboardForYou'
import { NeedsAttention } from './NeedsAttention'

export function DashboardLead() {
    const mode = usePersonaStore(s => s.mode)
    const setMode = usePersonaStore(s => s.setMode)
    const hasData = useHasDataHealth()
    const technical = mode === 'technical' && hasData

    return (
        <>
            {hasData && (
                <p className="mb-4 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-4 text-xs md:px-0">
                    <span className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-semibold',
                        technical
                            ? 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                            : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
                    )}>
                        {technical ? <Code2 className="h-3.5 w-3.5" aria-hidden /> : <Briefcase className="h-3.5 w-3.5" aria-hidden />}
                        {technical ? 'Technical view' : 'Business view'}
                    </span>
                    <span className="text-ink-secondary">
                        {technical
                            ? 'Data health comes first — what failed, what’s building, what changed.'
                            : 'Your work comes first — reviews, requests and the views you use.'}
                    </span>
                    <button
                        type="button"
                        onClick={() => setMode(technical ? 'business' : 'technical')}
                        className="font-semibold text-accent-lineage hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 rounded"
                    >
                        {technical ? 'Switch to Business' : 'Switch to Technical'}
                    </button>
                    <span className="hidden items-center gap-1 text-ink-muted sm:inline-flex">
                        — or the toggle at the top, from anywhere <Kbd shortcut="mod+/" />
                    </span>
                </p>
            )}
            {technical ? (
                <>
                    <DashboardDataHealth />
                    <NeedsAttention />
                </>
            ) : (
                <DashboardForYou />
            )}
        </>
    )
}
