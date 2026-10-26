/**
 * RescueFixes — the way out of an empty answer: one chip per fix that
 * finds something, with how many it finds. Shown on the Sentence line
 * where the matches run out, and over an empty result.
 */
import { AlertCircle } from 'lucide-react'

import { Skeleton } from '@/components/ui/Skeleton'
import { cn } from '@/lib/utils'
import type { Predicate } from '@/types/search'


import type { RescueFix } from './rescueFixes'
import type { CountedFix, Rescue } from './useRescue'


function fixLabel(f: RescueFix, line: string | null): string {
    switch (f.kind) {
        case 'hops': return `Look up to ${f.hops} hops away`
        case 'anyRelative': return 'Any of them, not every one'
        case 'fewer': return 'At least one, not that many'
        case 'contains': return `Contains “${f.text}”, not exactly`
        case 'anyOf': return 'Match any condition, not all'
        case 'drop': return line ? `Without “${line}”` : 'Without this line'
        case 'wholeView': return 'Search the whole view'
    }
}


export function FixChips({ fixes, onApply, line, counting }: {
    fixes: CountedFix[]
    onApply: (p: Predicate) => void
    /** The words of the line where the matches run out. */
    line: string | null
    counting: boolean
}) {
    if (fixes.length === 0) {
        return counting
            ? <span className="inline-flex gap-1.5"><Skeleton className="h-6 w-32 rounded-full" /><Skeleton className="h-6 w-24 rounded-full" /></span>
            : <span className="text-xs text-ink-muted">Nothing close by finds anything either — try loosening another line.</span>
    }
    return (
        <span className="inline-flex flex-wrap items-center gap-1.5">
            {fixes.map((f) => (
                <button key={`${f.kind}:${'clause' in f ? f.clause : ''}`} type="button" onClick={() => onApply(f.predicate)}
                        className={cn(
                            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                            'border-accent-lineage/30 bg-accent-lineage/10 text-ink hover:bg-accent-lineage/15',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                        )}>
                    {fixLabel(f, line)}
                    <span className="font-semibold tabular-nums text-accent-lineage">
                        {f.count.count.toLocaleString()}{f.count.complete ? '' : '+'}
                    </span>
                </button>
            ))}
        </span>
    )
}


/** The Sentence's note under the line where the matches run out. */
export function RescueNote({ rescue, onApply }: { rescue: Rescue; onApply: (p: Predicate) => void }) {
    return (
        <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg bg-rose-500/[0.07] px-2.5 py-1.5 text-xs">
            <span className="inline-flex items-center gap-1 font-medium text-rose-700 dark:text-rose-300">
                <AlertCircle className="h-3.5 w-3.5" aria-hidden /> Nothing matches from here — try
            </span>
            <FixChips fixes={rescue.fixes} onApply={onApply} line={null} counting={rescue.status === 'counting'} />
        </div>
    )
}
