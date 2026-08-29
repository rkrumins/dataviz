/**
 * What the "Top matches" list has to work out about a hit, as pure
 * functions.
 *
 * The dropdown is a presentational surface — it draws ten rows and calls
 * back. Everything it would otherwise have to decide mid-render lives
 * here: which ten, why each one is in the list, and how to say where it
 * lives without a path that wraps to three lines.
 *
 * The *why* chip is computed on this side deliberately. The backend does
 * send `highlights`, but it cannot tell the difference between "the name
 * IS the word you typed" and "the name has the word in it somewhere" —
 * that distinction is what makes a ranked list legible to someone who
 * did not write the query language, and it is one string comparison
 * against text the box already holds. No wire change buys it.
 */
import type { QuickQuery } from '@/components/canvas/search/session/quickPredicate'
import type { AncestorRef, SearchHit } from '@/types/search'


/** How many rows the dropdown offers before "See all" is the answer. */
export const TOP_MATCHES = 10


/**
 * The first `n` hits, in the order the server sent them.
 *
 * Never re-sorted. The ranking IS the backend's answer — relevance
 * weights, tie-breaks and all — and a list that quietly re-ordered it
 * would disagree with the panel showing the same query six inches away.
 */
export function topMatches(
    hits: SearchHit[] | null | undefined,
    n: number = TOP_MATCHES,
): SearchHit[] {
    return (hits ?? []).slice(0, n)
}


/** Anything that is not a letter or a digit separates two words. Data
 *  names are `_`-, `.`- and `-`-separated far more often than they are
 *  spaced, and `\b` treats `_` as a letter — so `\border\b` says no to
 *  `daily_order_v2`, which is exactly the case this tier exists for. */
const SEPARATOR = /[^a-z0-9]/


/** Whether `text` sits in `name` bounded by separators on both sides.
 *  Both arguments are already lower-cased. */
function containsWord(name: string, text: string): boolean {
    for (let from = 0; from <= name.length;) {
        const at = name.indexOf(text, from)
        if (at === -1) return false
        const before = at === 0 || SEPARATOR.test(name[at - 1])
        const end = at + text.length
        const after = end === name.length || SEPARATOR.test(name[end])
        if (before && after) return true
        from = at + 1
    }
    return false
}


/**
 * Why this hit is in the list, in one chip.
 *
 * The name is asked first and in tiers, because that is the ranking the
 * user can feel: an exact name outranks a prefix outranks a word
 * outranks a substring, and saying which one landed explains an order
 * that would otherwise look arbitrary. Only when the name did not match
 * at all does the answer come from the server's best highlight — the
 * word was found somewhere the row does not otherwise show.
 *
 * `field` is the wire spelling behind the label, so a caller can pair
 * the chip with the highlight it came from.
 */
export function whyLabel(
    hit: SearchHit, quick: QuickQuery,
): { label: string; field: string } {
    const text = quick.text.trim().toLowerCase()
    const name = (hit.node.displayName ?? '').toLowerCase()
    if (text && name) {
        if (name === text) return { label: 'Name is exactly', field: 'displayName' }
        if (name.startsWith(text)) return { label: 'Name starts with', field: 'displayName' }
        if (containsWord(name, text)) return { label: 'Name contains the word', field: 'displayName' }
        if (name.includes(text)) return { label: 'Name contains', field: 'displayName' }
    }

    const field = hit.highlights?.[0]?.field
    if (!field) return { label: 'Matched', field: '' }
    if (field === 'description') return { label: 'In description', field }
    if (field === 'tags') return { label: 'Tag', field }
    if (field.startsWith('property:')) {
        return { label: `Property ${field.slice('property:'.length)}`, field }
    }
    if (field === 'qualifiedName') return { label: 'In path', field }
    return { label: 'Matched', field }
}


/** One rendered crumb: an ancestor, or the gap where the middle of the
 *  path used to be. */
export type PathCrumb = AncestorRef | { ellipsis: true }

export interface FormattedPath {
    /** Head crumbs, the elision, then tail crumbs — ready to render. */
    crumbs: PathCrumb[]
    /** How deep the hit actually is, elision or not. */
    depth: number
    /** Every crumb, for the row's `title`: the elision hides names, and
     *  hovering has to be able to get them back. */
    full: string
}


/**
 * The path top-down, short enough to sit on one line.
 *
 * Middle-ellipsis rather than a truncated tail: the root says which
 * system the hit belongs to and the last two say which folder it sits
 * in, and those are the two ends a person navigates by. The levels
 * between them are the ones nobody reads.
 */
export function formatPath(
    ancestorPath: AncestorRef[],
    { head = 1, tail = 2 }: { head?: number; tail?: number } = {},
): FormattedPath {
    const depth = ancestorPath.length
    const full = ancestorPath.map((a) => a.displayName).join(' › ')
    // At or under the budget an ellipsis would stand in for nothing —
    // it would cost a crumb to hide none of them.
    const crumbs: PathCrumb[] = depth <= head + tail
        ? [...ancestorPath]
        : [
            ...ancestorPath.slice(0, head),
            { ellipsis: true },
            ...ancestorPath.slice(depth - tail),
        ]
    return { crumbs, depth, full }
}


/**
 * The quiet "how far in is this" note, or nothing.
 *
 * Two levels is a folder and its parent — the crumbs already say that
 * legibly. From three the path is elided, and the number is what tells
 * the user the reveal has real work to do.
 */
export function depthNote(depth: number): string | null {
    if (depth < 3) return null
    return `${depth} levels deep`
}
