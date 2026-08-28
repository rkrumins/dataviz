/**
 * Say what the search actually did — not what we hoped it did.
 *
 * The zero-state used to assert, unconditionally:
 *
 *   "Searched names, descriptions, tags, and property values across every
 *    entity in this view, including containers you haven't opened."
 *
 * That sentence was false in at least four situations, and a user who
 * read it had no way to tell. It is false when the view's entity-type
 * filter excluded the thing they were looking for; when the client's
 * root hints didn't survive the resolver; when the data source has no
 * containment edges so "inside this view" can't be evaluated at all; and
 * — every single time — when there is no live backend and only the rows
 * already loaded in the browser were searched.
 *
 * Every one of those is reported by `ScopeDiagnostics`, which the backend
 * attaches to EVERY response and the panel simply never read.
 *
 * Pure: no React, no store. The whole point is that "what did this
 * search cover" is a question with one answer, computed once.
 */
import type { ScopeDiagnostics } from '@/types/search'


export interface ScopeSummary {
    /** What was searched. Always present. */
    sentence: string
    /** Why the answer may be incomplete. Absent when it isn't. */
    caveat?: string
    /** True when `caveat` names something the user can act on — the
     *  panel offers the widen action next to it. */
    canWiden?: boolean
}


/**
 * @param fieldsPhrase  what the scope chips are searching, already
 *                      lowercased ("names, descriptions, tags and
 *                      property values").
 * @param diag          the backend's account of the search it ran.
 *                      `null` when the server never answered.
 * @param localOnly     no live backend — only rows already on the canvas
 *                      were searched, whatever `diag` says.
 */
export function summariseScope(
    fieldsPhrase: string,
    diag: ScopeDiagnostics | null,
    localOnly: boolean,
): ScopeSummary {
    if (localOnly) {
        return {
            sentence: `Searched ${fieldsPhrase} in the entities already `
                + 'loaded on this canvas.',
            caveat: 'There is no live connection to the backend, so '
                + 'containers you haven’t opened were not searched.',
        }
    }

    if (!diag) {
        // No server answer yet, or it failed. The failure itself is
        // reported separately; don't claim coverage we can't vouch for.
        return { sentence: `Searched ${fieldsPhrase}.` }
    }

    const types = diag.effectiveEntityTypes ?? null
    const roots = diag.effectiveRootUrns ?? []
    const dropped = diag.droppedRootUrns ?? []
    const containment = diag.containmentEdgeTypes ?? []

    // Ordered by how badly each one undermines the headline claim.
    if (roots.length === 0 && dropped.length > 0) {
        return {
            sentence: `Searched ${fieldsPhrase}.`,
            caveat: 'This view’s boundary couldn’t be resolved, so '
                + 'nothing inside it was actually searched.',
        }
    }

    if (roots.length > 0 && containment.length === 0) {
        return {
            sentence: `Searched ${fieldsPhrase}.`,
            caveat: 'This data source has no containment relationships '
                + 'configured, so “inside this view” couldn’t be '
                + 'evaluated — nested entities were not reached.',
        }
    }

    if (types && types.length > 0) {
        // Find-in-view opts out of the view's display-type filter, so
        // this should not fire for the header box. If it does, the
        // opt-out didn't reach the server — which is exactly the bug
        // worth showing rather than hiding.
        return {
            sentence: `Searched ${fieldsPhrase} across this view.`,
            caveat: `Only ${formatList(types)} were searched — this view `
                + 'hides other entity types.',
            canWiden: true,
        }
    }

    const base = `Searched ${fieldsPhrase} across every entity in this view, `
        + 'including containers you haven’t opened.'

    if (dropped.length > 0) {
        return {
            sentence: base,
            caveat: `${dropped.length} container${dropped.length === 1 ? '' : 's'} `
                + 'you asked to narrow to couldn’t be matched to this view '
                + 'and were ignored.',
        }
    }

    return { sentence: base }
}


function formatList(items: readonly string[]): string {
    if (items.length === 1) return items[0]
    if (items.length === 2) return `${items[0]} and ${items[1]}`
    const head = items.slice(0, 3).join(', ')
    return items.length > 3 ? `${head} and ${items.length - 3} more` : head
}
