/**
 * invariants — T26 R2's INVARIANT STAGE: the layout pipeline's ordered
 * spine is `buildFocusLayout` → `applyCondensation` → HERE, always last
 * (`LineageLens.tsx` wires the three in this order). T28 R3 removed the
 * sliding-window stage (`applyHopWindow`) that used to sit between
 * condensation and this module — the board just grows now — so this
 * module's own two-argument shape (a "wants to draw" graph and the
 * fallback stage before it) is unchanged, only what LineageLens.tsx now
 * passes for each has: `applyCondensation`'s own output, and the
 * pre-condensation `buildFocusLayout` output as the fallback.
 *
 * The one remaining earlier pass is licensed to remove exactly one
 * thing and nothing else: `applyCondensation` may fold pass-through
 * INTERIORS into a connector chip. It is not licensed to remove the
 * focal, orphan an edge, or orphan a frame reference — this module is
 * the enforcement that it didn't, checked globally, after every pass,
 * in ONE place, rather than trusted per-pass or re-derived by whichever
 * component happens to render the result.
 *
 * Four invariants, checked in order:
 *   (a) the focal card is drawn.
 *   (b) the rendered card set is non-empty while a fallback pass still
 *       has the focus (T17-A's own guarantee — `buildFocusLayout`'s
 *       `focusRecovered` — relocated to where a LATER pass cannot
 *       silently undo it; subsumes T25-C2's own inline `boardGraph`
 *       fallback, which lived in the component before this).
 *   (c) every edge endpoint resolves to a drawn card (T17-F).
 *   (d) cone/strata coherence: no card claims a frame that is not
 *       itself drawn — `isolationCone` (this module's neighbour) walks
 *       a card's `frameId` chain to find "the boxes it sits in", and a
 *       dangling link would silently truncate that walk rather than
 *       light what the reader is actually looking at.
 *
 * A violation is dev-asserted (never silent) and degraded HONESTLY:
 * (a)/(b) fall back a stage (condensed → pre-condensation layout) and,
 * if even the fallback cannot place the focus, flag `focusRecovered` so
 * the existing "Showing the focus on its own" whisper fires — the same
 * user-facing signal T17-A already ships, not a new one. (c) drops the
 * dangling edge. (d) promotes the orphaned card to top-level (clears
 * its `frameId`) rather than dropping it — the reader loses a nesting
 * fact, never a card.
 */
import type { FocusCard, FocusEdge, FocusGraph } from './focus-cards'

export type LensInvariantCode = 'focal-missing' | 'board-empty' | 'dangling-edge' | 'dangling-frame'

export interface LensInvariantViolation {
    code: LensInvariantCode
    detail: string
}

export interface LensInvariantResult {
    graph: FocusGraph
    violations: LensInvariantViolation[]
}

/**
 * `drawn` is what the pipeline WANTS to draw (the post-condensation
 * graph); `fallback` is the stage before it (the pre-condensation
 * layout) — the one place left to recover the focus from if `drawn`
 * lost it. Pure: logs through `console.error` in dev only, never
 * throws, always returns something drawable.
 */
export function enforceLensInvariants(drawn: FocusGraph, fallback: FocusGraph): LensInvariantResult {
    const violations: LensInvariantViolation[] = []
    const assert = (v: LensInvariantViolation) => {
        violations.push(v)
        if (import.meta.env.DEV) console.error(`[lens] invariant violation (${v.code}): ${v.detail}`)
    }

    // (a) + (b) — the focal card is drawn; the board is never empty while
    // an earlier pass still has it.
    let graph = drawn
    if (!graph.cards.some(c => c.kind === 'focal')) {
        if (fallback.cards.some(c => c.kind === 'focal')) {
            assert({ code: 'focal-missing', detail: 'the condensed board lost the focus — falling back to the pre-condensation layout' })
            graph = fallback
        } else {
            // Structurally shouldn't happen — `buildFocusLayout`'s own
            // `focusRecovered` guarantees `fallback` always has the focal
            // when the model does — but "couldn't reproduce" is not a
            // reason to leave this branch silent. Render whatever the
            // fallback has (honest — it is the widest data available) and
            // raise the SAME whisper `focusRecovered` already ships,
            // rather than inventing a second, parallel one.
            assert({ code: 'board-empty', detail: 'no pass could draw the focus — flagging focusRecovered so the whisper fires' })
            graph = { ...fallback, focusRecovered: true }
        }
    }

    // (c) — every edge endpoint resolves to a drawn card.
    const cardIds = new Set(graph.cards.map(c => c.id))
    const edges: FocusEdge[] = []
    for (const e of graph.edges) {
        if (cardIds.has(e.source) && cardIds.has(e.target)) { edges.push(e); continue }
        assert({ code: 'dangling-edge', detail: `edge ${e.id} (${e.source} → ${e.target}) has no drawn endpoint — dropped` })
    }

    // (d) — cone/strata coherence: no card claims a frame that is not
    // itself drawn.
    let cardsChanged = false
    const cards: FocusCard[] = graph.cards.map(c => {
        if (!c.frameId || cardIds.has(c.frameId)) return c
        assert({ code: 'dangling-frame', detail: `card ${c.id} claims frame ${c.frameId}, which is not drawn — promoted to top-level` })
        cardsChanged = true
        return { ...c, frameId: null }
    })

    if (edges.length === graph.edges.length && !cardsChanged) return { graph, violations }
    return { graph: { ...graph, cards, edges }, violations }
}
