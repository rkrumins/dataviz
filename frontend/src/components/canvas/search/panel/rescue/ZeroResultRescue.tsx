/**
 * ZeroResultRescue — an empty answer, led by where it went empty: the
 * line whose matches run out, and the fixes that would find something.
 * Falls back to the plain statement while there is nothing to point at.
 */
import type { ReactNode } from 'react'

import type { Predicate } from '@/types/search'

import { useClauseCounts } from '../counts/useClauseCounts'

import { FixChips } from './RescueFixes'
import { useRescue } from './useRescue'


export function ZeroResultRescue({ viewId, draft, onApply, fallback }: {
    viewId: string
    draft: Predicate
    onApply: (p: Predicate) => void
    /** Shown until — or unless — the counts name the line. */
    fallback: ReactNode
}) {
    const counts = useClauseCounts(viewId, draft)
    const rescue = useRescue(viewId, draft, counts)
    if (rescue.clause === null) return <>{fallback}</>
    return (
        <div className="rounded-xl border border-l-4 border-rose-400/45 border-l-rose-400 bg-rose-500/[0.08] px-3.5 py-3">
            <p className="text-sm font-semibold leading-snug text-ink">
                Nothing matches — the matches run out at{' '}
                {rescue.line ? <span className="text-rose-700 dark:text-rose-300">“{rescue.line}”</span> : 'one of the lines'}.
            </p>
            <div className="mt-2">
                <FixChips fixes={rescue.fixes} onApply={onApply} line={rescue.line}
                          counting={rescue.status === 'counting'} />
            </div>
        </div>
    )
}
