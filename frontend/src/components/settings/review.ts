/**
 * The staged changes, as the review lists them: each value from → to in words, how it is set
 * (this scope's own value, or inheriting again), when it takes effect, and what it changes.
 */
import { changeImpacts, type Impact } from './impacts'
import { formatValue, inheritedAt, SCOPE_HERE, SCOPE_LABEL } from './format'
import type { ResolvedValues, Scope, Setting } from './types'
import type { StagedChange } from './useStagedChanges'

export interface ReviewItem {
    key: string
    label: string
    /** In force now. */
    from: string
    /** In force once saved. */
    to: string
    /** "Set for this graph", "Use the platform's value". */
    how: string
    takesEffect: string
    impacts: Impact[]
}

export function reviewItems(changes: StagedChange[], settings: Record<string, Setting>, values: ResolvedValues, scope: Scope): ReviewItem[] {
    return changes.flatMap((c) => {
        const s = settings[c.key]
        const r = values[c.key]
        if (!s || !r) return []
        const inherit = inheritedAt(r, scope)
        return [{
            key: c.key,
            label: s.label,
            from: formatValue(s, c.before),
            to: formatValue(s, c.after),
            how: c.ownAfter === null
                ? inherit.scope === 'default' ? 'Back to the default' : `Use the ${SCOPE_LABEL[inherit.scope].toLowerCase()}’s value`
                : `Set for ${SCOPE_HERE[scope]}`,
            takesEffect: s.takesEffect.text,
            impacts: changeImpacts(s, c.before, c.after),
        }]
    })
}
