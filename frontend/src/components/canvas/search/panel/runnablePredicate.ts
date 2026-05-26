/**
 * Pure helper that transforms the editor's ``draftPredicate`` into the
 * predicate the runtime actually executes. The transform:
 *
 *   1. Drops top-level conditions that are incomplete (empty value,
 *      missing required field, etc.) — there's no Cypher we can run
 *      for an unfinished row, and including it produces a server-side
 *      422.
 *   2. Returns ``null`` when nothing's left to run.
 *   3. Single condition → return un-wrapped.
 *   4. Multiple conditions → wrap them in a group, **preserving the
 *      draft's root op**. The old implementation hard-coded
 *      ``op: 'and'`` regardless of what the user typed, which silently
 *      rewrote ``A OR B OR C`` queries into AND at execution time
 *      while the explain panel kept showing OR. The executed Cypher
 *      and the displayed Cypher diverged, producing 0-result
 *      regressions for any complex query whose top-level structure
 *      was OR.
 *
 * Lives in its own module so the spec can import it without dragging
 * the whole QueryCard React tree (which has top-level side-effects).
 */
import type { Predicate } from '@/types/search'

import { isRowIncomplete } from './ConditionRow'
import { topLevelConditions } from './predicateComposition'


export function buildRunnablePredicate(
    draft: Predicate | null,
): { predicate: Predicate; hash: string } | null {
    if (!draft) return null
    const conditions = topLevelConditions(draft).filter(
        (c) => !isRowIncomplete(c),
    )
    if (conditions.length === 0) return null
    if (conditions.length === 1) {
        return {
            predicate: conditions[0],
            hash: JSON.stringify(conditions[0]),
        }
    }
    // Preserve the draft's root op when wrapping. Only AND/OR are
    // reachable here (topLevelConditions for a NOT-rooted draft
    // returns [draft], i.e. one item, which exits via the length-1
    // branch above).
    const rootOp: 'and' | 'or' =
        draft.kind === 'group' && draft.op === 'or' ? 'or' : 'and'
    const predicate: Predicate = {
        kind: 'group', op: rootOp, children: conditions,
    }
    return { predicate, hash: JSON.stringify(predicate) }
}
