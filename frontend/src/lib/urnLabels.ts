/**
 * urnLabels — a tiny process-wide "what is this URN called?" cache.
 *
 * Predicates carry URNs, not display names. That's correct on the wire
 * but unreadable in the UI: a scope row rendered from the raw predicate
 * says ``inside urn:synodic:container:a41f…`` where the user expects
 * ``inside GOLD``. The canvas store can answer for nodes it has loaded,
 * but a container the user scoped to from a search result often ISN'T
 * loaded — that's frequently the whole point of scoping to it.
 *
 * Search responses already carry the answer: every ``AncestorRef`` and
 * every aggregate bucket ships a ``displayName`` alongside the URN. So
 * we remember them as they stream past and let the pure formatters
 * (``QueryChips.describePredicate``, ``predicateSentence.leafSentence``)
 * read them back synchronously.
 *
 * Deliberately a module-level Map rather than store state: the readers
 * are pure functions several frames deep in a render, not components,
 * and threading a resolver through all of them would touch a lot of
 * signatures for a lookup that is append-only and never invalidated
 * (a URN's display name doesn't change under us mid-session; a rename
 * arrives as a fresh response and overwrites). Because it's outside
 * React, writes don't trigger a re-render — so always ``remember`` the
 * labels BEFORE committing the predicate that references them, which
 * is the natural order anyway (you learn the name from the thing you
 * clicked).
 */

const labels = new Map<string, string>()


/** Record display names for later lookup. Blank names are ignored so a
 *  placeholder can never overwrite a real one. */
export function rememberUrnLabels(
    entries: Iterable<{ urn?: string | null; displayName?: string | null }>,
): void {
    for (const entry of entries) {
        const urn = entry.urn
        const name = entry.displayName
        if (!urn || !name) continue
        labels.set(urn, name)
    }
}


/** The remembered display name, or undefined if we've never seen it. */
export function urnDisplayName(urn: string): string | undefined {
    return labels.get(urn)
}


/**
 * Best available human label for a URN: the remembered display name,
 * else the URN's last segment (the distinguishing part), truncated.
 * Never returns an empty string — callers render this directly.
 */
export function formatUrnLabel(urn: string, maxLen = 24): string {
    if (!urn) return '∅'
    const known = labels.get(urn)
    const text = known ?? (urn.split(':').pop() || urn)
    return text.length <= maxLen ? text : `${text.slice(0, maxLen - 1)}…`
}


/** Test seam — drops every remembered label. */
export function __resetUrnLabels(): void {
    labels.clear()
}
