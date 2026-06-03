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
 *   isHidden            — canvas filter mode says this row should not
 *                          render at all. Driven by ``canvasFilterMode``
 *                          in the search store; see the table below.
 *                          Selected rows are NEVER hidden so the user
 *                          can always see what they were inspecting.
 *   pulseClass          — apply when ``isDirectMatch`` to attach the
 *                          ``search-match-pulse`` ring + glow
 *
 * Canvas filter mode semantics (set via the MatchBar's 3-segment
 * toggle, persisted per-view in localStorage):
 *
 *   mode='highlight'  → isHidden always false; dim others (today's
 *                       behavior, unchanged)
 *   mode='isolate'    → isHidden=true when (not direct match AND not
 *                       ancestor of any match); only matches + their
 *                       containment spine render
 *   mode='hide'       → isHidden=true when isDirectMatch; the matched
 *                       nodes vanish, everything else renders normally
 *                       (the "find tables WITHOUT owners" inverse case)
 *
 * Callers must decide:
 *   * Where to render the badge — typically next to the row's title
 *     when the row is collapsed AND ``ancestorMatchCount > 0``.
 *   * Whether to apply ``isSpotlightDim`` (typically via
 *     ``opacity-40``). Some surfaces may have stronger rules
 *     (e.g. trace mode) that should win.
 *   * Whether to skip rendering entirely when ``isHidden`` is true.
 *     Renderers should early-return BEFORE measuring or running
 *     layout work to keep the isolate-mode path cheap.
 */
import {
    useAncestorMatchBreakdown,
    useAncestorMatchCount,
    useCanvasFilterMode,
    useIsMatch,
    useIsSearchSpotlightActive,
} from '@/store/searchStore'


export interface SearchHighlight {
    isDirectMatch: boolean
    ancestorMatchCount: number
    ancestorBreakdown: ReadonlyMap<string, number>
    isSpotlightDim: boolean
    isHidden: boolean
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
    const canvasFilterMode = useCanvasFilterMode()
    const { isSelected = false } = options

    // Spotlight-dim: when any search has matches, fade everything
    // that's neither a direct match nor an ancestor of one. Selected
    // rows stay bright regardless so the user never loses their
    // focus while searching. Only applies in ``highlight`` mode —
    // ``isolate`` and ``hide`` use ``isHidden`` instead.
    const isSpotlightDim =
        spotlightActive
        && canvasFilterMode === 'highlight'
        && !isDirectMatch
        && ancestorMatchCount === 0
        && !isSelected

    // Hide semantics — see the table in the module doc above. The
    // ``spotlightActive`` guard prevents hide/isolate modes from
    // affecting the canvas when there's no active search (e.g. on
    // first page load before the user has run anything).
    let isHidden = false
    if (spotlightActive && !isSelected) {
        if (canvasFilterMode === 'isolate') {
            // Render only matches + their ancestor spine. A row is
            // "in the spine" when it's an ancestor of at least one
            // match (ancestorMatchCount > 0).
            isHidden = !isDirectMatch && ancestorMatchCount === 0
        } else if (canvasFilterMode === 'hide') {
            // Inverse: drop direct matches, keep everything else.
            // Ancestor rows stay visible (the user still wants to
            // see structural context).
            isHidden = isDirectMatch
        }
    }

    return {
        isDirectMatch,
        ancestorMatchCount,
        ancestorBreakdown,
        isSpotlightDim,
        isHidden,
        pulseClass: isDirectMatch ? SEARCH_MATCH_PULSE_CLASS : '',
    }
}
