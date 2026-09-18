/**
 * What the panel is reporting on, in one line of English.
 *
 *     Anything where any text field contains "customer"   [inside CRM]
 *
 * The results-first panel opens on results, not on the builder — so the
 * only statement of what was actually asked is this line. It reads the
 * committed draft (the session commits the very predicate it dispatches),
 * which is also what Refine opens on, so the sentence and the rows can
 * never describe different queries.
 *
 * The container clamp is lifted OUT of the sentence and shown as a chip.
 * ``formatPredicateAsSentence`` would render it as "… and is inside CRM",
 * buried at the end of the clause it most changes the meaning of; a chip
 * beside the sentence is the thing the user scans for when the result
 * count looks too small.
 */
import { type FC, useMemo } from 'react'

import { formatUrnLabel } from '@/lib/urnLabels'
import { cn } from '@/lib/utils'
import type { Predicate } from '@/types/search'

import { findScopeCondition, rootGroupOp, topLevelConditions } from './predicateComposition'
import { formatPredicateAsSentence } from './predicateSentence'


/**
 * The draft minus its container clamp — a NOT-rooted draft passes
 * through untouched, because ``topLevelConditions`` doesn't unwrap one
 * and a scope row can't legally live inside one anyway (the compiler
 * only accepts DescendantOf in the top-level AND).
 */
export function withoutScope(draft: Predicate | null): Predicate | null {
    const rest = topLevelConditions(draft).filter((c) => c.kind !== 'descendantOf')
    if (rest.length === 0) return null
    if (rest.length === 1) return rest[0]
    return { kind: 'group', op: rootGroupOp(draft), children: rest }
}


export const QuerySentence: FC<{ draftPredicate: Predicate | null }> = ({
    draftPredicate,
}) => {
    const scope = findScopeCondition(draftPredicate)
    const sentence = useMemo(
        () => formatPredicateAsSentence(withoutScope(draftPredicate), { leadIn: 'Anything' }),
        [draftPredicate],
    )

    return (
        <div className={cn(
            'px-1 flex flex-wrap items-baseline gap-x-2 gap-y-1',
            'text-[12px] leading-snug text-ink/90',
        )}>
            {sentence}
            {scope && scope.urns.length > 0 && (
                <span className={cn(
                    'inline-flex items-center px-1.5 py-0.5 rounded-md shrink-0',
                    'text-[10.5px] font-medium',
                    'bg-accent-lineage/10 text-accent-lineage border border-accent-lineage/25',
                )}>
                    inside {scope.urns.length === 1
                        ? formatUrnLabel(scope.urns[0])
                        : `${scope.urns.length} containers`}
                </span>
            )}
        </div>
    )
}
