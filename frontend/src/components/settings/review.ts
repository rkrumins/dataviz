/**
 * The staged changes, as the review lists them: each value from → to in words, how it is set
 * (this scope's own value, or inheriting again), when it takes effect, and what it changes. On the
 * platform, a change to what workspaces and graphs may choose is listed the same way.
 */
import { changeImpacts, type Impact } from './impacts'
import { formatValue, hasLimits, inheritedAt, SCOPE_HERE, SCOPE_LABEL } from './format'
import type { Limits, ResolvedValues, Scope, Setting } from './types'
import type { StagedChange, StagedLimitChange } from './useStagedChanges'

export interface ReviewItem {
    key: string
    /** Unique among the items: a value's change and its limits' change share a key. */
    id?: string
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

/** What limits leave lower levels free to choose, in words: "Same for everyone", "1 day to 90 days". */
export function describeLimits(s: Setting, limits: Limits | null | undefined): string {
    if (limits?.lock) return 'Same for everyone'
    if (!hasLimits(limits)) return s.kind === 'choice' ? 'Any choice' : 'Any value'
    const parts: string[] = []
    if (limits.allowed?.length) parts.push(limits.allowed.map((v) => formatValue(s, v)).join(', '))
    if (limits.range) parts.push(`${formatValue(s, limits.range[0])} to ${formatValue(s, limits.range[1])}`)
    return parts.join('; ')
}

/** Staged limits, as the review lists them: what workspaces and graphs may choose, from → to. */
export function limitReviewItems(changes: StagedLimitChange[], settings: Record<string, Setting>): ReviewItem[] {
    return changes.flatMap((c) => {
        const s = settings[c.key]
        if (!s) return []
        const after = c.ownAfter ?? s.defaultLimits
        const locking = Boolean(after?.lock) !== Boolean(c.before?.lock)
        return [{
            key: c.key,
            id: `${c.key}:limits`,
            label: `${s.label}: what workspaces and graphs may choose`,
            from: describeLimits(s, c.before),
            to: describeLimits(s, after),
            how: c.ownAfter === null ? 'Back to the default limits' : 'Limits for workspaces and graphs',
            takesEffect: locking
                ? after?.lock
                    ? 'At once: workspaces and graphs use the platform’s value. Values they chose are kept, and apply again when it is unlocked.'
                    : 'At once: values workspaces and graphs chose apply again.'
                : 'The next time a workspace or graph admin chooses. Values chosen already stay; any outside the limits are kept as exceptions.',
            impacts: [],
        }]
    })
}
