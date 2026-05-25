/**
 * useSearchHighlight — shared per-row search-decoration hook (W2.1).
 *
 * Hosts the row-level integration that was inlined in
 * ``context-view/FlatTreeItem.tsx`` (the ContextViewCanvas tree-row
 * renderer). Extracting it means ``GraphCanvas`` node renderers and
 * ``HierarchyCanvas`` layer-column rows can light up identically
 * with a single hook call — no per-canvas re-implementation of the
 * spotlight-dim / glow-pulse / chevron-badge logic.
 *
 * Returns a small decoration bundle the caller composes into its
 * existing class soup:
 *
 *   isDirectMatch       — this row's URN is in matchUrnSet
 *   ancestorMatchCount  — N-level descendant matches under this row
 *   ancestorBreakdown   — per-entityType breakdown of those matches
 *   isSpotlightDim      — spotlight is on AND this row should fade
 *                         (not a direct match, no descendant matches,
 *                          not selected). The selected row stays
 *                          bright so the user never loses their focus
 *                          during search.
 *   pulseClass          — apply when ``isDirectMatch`` to attach the
 *                          ``search-match-pulse`` ring + glow
 *
 * Callers must decide:
 *   * Where to render the badge — typically next to the row's title
 *     when the row is collapsed AND ``ancestorMatchCount > 0``.
 *   * Whether to apply ``isSpotlightDim`` (typically via
 *     ``opacity-40``). Some surfaces may have stronger rules
 *     (e.g. trace mode) that should win.
 */
import {
    useAncestorMatchBreakdown,
    useAncestorMatchCount,
    useIsMatch,
    useIsSearchSpotlightActive,
} from '@/store/searchStore'


export interface SearchHighlight {
    isDirectMatch: boolean
    ancestorMatchCount: number
    ancestorBreakdown: ReadonlyMap<string, number>
    isSpotlightDim: boolean
    pulseClass: string
}


/** CSS class applied to a direct-match row. Defined here so callers
 *  don't have to duplicate the string. Backed by the existing
 *  ``search-match-pulse`` keyframes already shipped in the global
 *  stylesheet (see ContextViewCanvas usage). */
export const SEARCH_MATCH_PULSE_CLASS = 'search-match-pulse'


export function useSearchHighlight(
    urn: string | undefined,
    options: { isSelected?: boolean } = {},
): SearchHighlight {
    const isDirectMatch = useIsMatch(urn)
    const ancestorMatchCount = useAncestorMatchCount(urn)
    const ancestorBreakdown = useAncestorMatchBreakdown(urn)
    const spotlightActive = useIsSearchSpotlightActive()
    const { isSelected = false } = options

    // Spotlight-dim: when any search has matches, fade everything
    // that's neither a direct match nor an ancestor of one. Selected
    // rows stay bright regardless so the user never loses their
    // focus while searching.
    const isSpotlightDim =
        spotlightActive
        && !isDirectMatch
        && ancestorMatchCount === 0
        && !isSelected

    return {
        isDirectMatch,
        ancestorMatchCount,
        ancestorBreakdown,
        isSpotlightDim,
        pulseClass: isDirectMatch ? SEARCH_MATCH_PULSE_CLASS : '',
    }
}
