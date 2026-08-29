/**
 * Reveal a search hit on the ContextView canvas.
 *
 * Walks the ancestor chain in the canvas store, opening each level in turn
 * so the deep hit becomes reachable; then selects + brings the hit into
 * view. Falls back to the deepest level it actually opened if a step on the
 * spine cannot be reached — partial reveal beats no reveal, and the caller
 * is told which of the two it got.
 *
 * PATH-ONLY: opening a level does NOT load that level's children. A hit
 * five levels down would otherwise cost five pages of siblings — four
 * columns of entities the reader never asked to see — for one row. The
 * spine's own nodes and containment edges are primed up front, so every
 * opened level already holds the one child that leads onward; the column's
 * existing "N more · load" row stays the way to pull the rest.
 *
 * Extracted from the inline lambda previously in ContextViewCanvas so
 * that pin clicks (SearchPinOverlay — W3) and bucket "Reveal subtree"
 * actions can drive the same flow.
 *
 * The `setExpandedNodes` setter is canvas-local React state and must
 * be passed in by the caller. `selectNode` is pulled directly from the
 * canvas store inside the hook because it has no per-instance state.
 *
 * Renamed from `useRevealNode` during the resilience-hardening + advanced-search
 * integration so it can coexist with the entity-drawer reveal hook of the same
 * original name.
 */
import { useCallback } from 'react'

import { useCanvasStore } from '@/store/canvas'
import { toCanvasNode, toCanvasEdge } from '@/hooks/useGraphHydration'
import { useViewContainmentEdgeTypes } from '@/hooks/useViewSchema'
import { usePreferencesStore } from '@/store/preferences'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import type { AncestorRef } from '@/types/search'


/** How long one level of the spine holds the screen before the next opens. */
const LEVEL_STAGGER_MS = 80

/**
 * Wait one animation frame so the just-fired ``setExpandedNodes`` React
 * state update commits before we attempt the hit lookup. Replaces the
 * previous ``setTimeout(80)`` hack which was both arbitrary AND lost
 * its race on slow networks / deep spines (the user then had to
 * re-click to actually land on the hit).
 *
 * One rAF is sufficient because the canvas store (Zustand) commits
 * synchronously; the only async wait we need is for React's scheduler to
 * flush the expansion state so the LayerColumn re-renders with the new
 * ``flatTree`` before its ``revealTarget`` effect re-runs.
 */
function nextFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

/** Has this reader asked for no motion — in the app, or in the OS? */
function motionIsReduced(): boolean {
    if (usePreferencesStore.getState().reducedMotion) return true
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    // Nothing to ask (jsdom, SSR) is read as "no motion to pace": a test
    // must not spend the stagger, and a server render has no screen.
    return query ? query.matches : true
}

/**
 * Pace between two levels of the reveal — or don't, and mean it. Reduced
 * motion returns an already-resolved promise rather than a zero-length
 * timer: under fake timers a zero-length one still needs a clock nobody
 * is advancing, which is exactly how a "no motion" path stays broken.
 */
function wait(ms: number): Promise<void> {
    if (motionIsReduced()) return Promise.resolve()
    return new Promise((resolve) => { window.setTimeout(resolve, ms) })
}

/** What the canvas calls a node, for a message about where the walk landed.
 *  Shared with the trace-aware wrapper in ContextViewCanvas, which lands on
 *  the overlay's chain rather than through the walk below. */
export function canvasDisplayName(urn: string): string {
    const node = useCanvasStore.getState().nodes.find((n) => n.id === urn)
    return (node?.data.label as string | undefined) || urn
}

export interface UseRevealSearchHitDeps {
    /** Setter for the canvas's `expandedNodes` set. */
    setExpandedNodes: React.Dispatch<React.SetStateAction<Set<string>>>
    /** Graph data provider — used to prime missing spine ancestors via
     *  `getNodes({ urns })` before the spine walk. Without this, the walk
     *  halts at the first ancestor that wasn't fetched on hydration
     *  (which, with lazy loading, is every non-top-level ancestor). */
    provider: GraphDataProvider
    /** Optional: after the hit is selected (or after we fall back to the
     *  deepest level that opened), bring that node into the viewport.
     *  Receives the canvas-node id (== URN for the ContextView layout).
     *  Implementations typically rAF-poll the DOM because the row may
     *  not have re-rendered yet after the spine expansion. */
    scrollIntoView?: (nodeId: string) => void
}

/**
 * Where a reveal actually put the reader.
 *
 * `'ancestor'` is the walk admitting it stopped short: the hit could not
 * be drawn and `urn`/`displayName` name the deepest level that DID open
 * (both empty when not one level of the spine was reachable). The header
 * box turns that into a line the reader can act on; the results panel's
 * rows ignore it, because "Reveal" there is already a round trip they
 * watched happen.
 */
export interface RevealOutcome {
    landedOn: 'hit' | 'ancestor'
    urn: string
    displayName: string
}

/** The reveal callback signature consumed by SearchMapPanel and friends. */
export type RevealSearchHit = (urn: string, ancestorPath: AncestorRef[]) => Promise<RevealOutcome>

/** Nothing on the spine could be opened — there is no level to name.
 *  Exported because the canvas's trace-aware wrapper reaches the same
 *  dead end (a walk still in flight has nothing on screen to land on),
 *  and two hand-written copies of one outcome drift. */
export const LANDED_NOWHERE: RevealOutcome = { landedOn: 'ancestor', urn: '', displayName: '' }


export function useRevealSearchHit({ setExpandedNodes, provider, scrollIntoView }: UseRevealSearchHitDeps): RevealSearchHit {
    const selectNode = useCanvasStore((s) => s.selectNode)
    const containmentEdgeTypes = useViewContainmentEdgeTypes()

    return useCallback(async (urn: string, ancestorPath: AncestorRef[]): Promise<RevealOutcome> => {
        // Prime the spine: with lazy children loading, only top-level
        // entities are in the canvas store after hydration. Each
        // subsequent ancestor (and the hit itself) must be materialized
        // before the spine walk can find them. One getNodes call covers
        // the whole chain regardless of depth. `viaReveal` marks these
        // out-of-band nodes so `loadChildren` doesn't count them as a
        // loaded page (see useGraphHydration).
        const spineUrns = [...ancestorPath.map((a) => a.urn), urn]
        const loadedUrns = useCanvasStore.getState()._nodeIndex
        const missingUrns = spineUrns.filter((u) => !loadedUrns.has(u))
        if (missingUrns.length > 0) {
            try {
                const fetched = await provider.getNodes({ urns: missingUrns as any[] })
                if (fetched.length > 0) {
                    const { addGraph } = useCanvasStore.getState()
                    addGraph(
                        fetched.map((n) => {
                            const node = toCanvasNode(n)
                            return { ...node, data: { ...node.data, viaReveal: true } }
                        }),
                        [],
                    )
                }
            } catch (e) {
                console.warn('[reveal] spine priming failed', e)
                // Continue — the walk will fall back to the deepest level
                // it can open.
            }
        }

        // The containment edges, on EVERY reveal: they are what makes the
        // path-only walk possible at all. Each opened level draws its spine
        // child through one of these, and a hit that is the 300th child of
        // its parent has no other way to arrive. The missing NODES are not
        // the condition — a spine whose nodes all arrived on an earlier
        // reveal that lost its edges would otherwise never get them, and no
        // amount of re-clicking would fix it. `addGraph` dedupes and
        // /edges/between is response-cached, so the repeat is cheap. A
        // failure costs the hit its attachment, not the reveal.
        // A top-level hit has no spine to attach to — asking for the edges
        // within a single URN can only ever answer nothing.
        if (spineUrns.length > 1) {
            try {
                const edges = await provider.getEdgesBetween(
                    spineUrns as any[],
                    containmentEdgeTypes.length > 0 ? containmentEdgeTypes : undefined,
                )
                if (edges.length > 0) {
                    useCanvasStore.getState().addGraph([], edges.map((e) => toCanvasEdge(e)))
                }
            } catch (e) {
                console.warn('[reveal] spine edge priming failed', e)
            }
        }

        // The walk: open each level, top-down, and NOTHING else. No child
        // page is fetched — the level already holds its spine child, and
        // the canvas's first-page auto-load skips a container that has one
        // (ContextViewCanvas: `childMap.get(nodeId)?.length > 0`).
        //
        // We re-read the index via getState() between steps because a
        // closure-captured one would be stale relative to in-flight
        // hydration. Canvas node id === URN (see canvasNodeMapper).
        //
        // `opened` is how far down the path we actually got. A node below
        // the break may well be in the store, but no row is drawn for it,
        // so neither the selection nor the outcome may claim it.
        let opened = 0
        for (const ancestor of ancestorPath) {
            if (!useCanvasStore.getState()._nodeIndex.has(ancestor.urn)) break
            // Between levels, not before the first: the reveal answers a
            // click, and the top of the path is the answer's first frame.
            if (opened > 0) await wait(LEVEL_STAGGER_MS)
            setExpandedNodes((prev) => {
                const next = new Set(prev)
                next.add(ancestor.urn)
                return next
            })
            opened += 1
        }

        // Settle one animation frame so React commits the latest
        // ``setExpandedNodes`` before we look up the hit row — the
        // LayerColumn's ``flatTree`` (and therefore its
        // ``nodeToFlatIndexMap``) only updates after the expansion
        // state propagates. The canvas store itself sees its writes
        // synchronously via ``getState()`` (Zustand commits outside React
        // batching), so a single frame is enough.
        await nextFrame()

        if (opened === ancestorPath.length && useCanvasStore.getState()._nodeIndex.has(urn)) {
            selectNode(urn)
            scrollIntoView?.(urn)
            return { landedOn: 'hit', urn, displayName: canvasDisplayName(urn) }
        }

        // The hit isn't drawable (a step failed, or it never arrived).
        // Land on the deepest level that DID open, so the reader gets
        // visual confirmation of how close we got — and say so, because a
        // silent near-miss reads as a broken click.
        const landed = ancestorPath[opened - 1]
        if (!landed) return LANDED_NOWHERE
        selectNode(landed.urn)
        scrollIntoView?.(landed.urn)
        return { landedOn: 'ancestor', urn: landed.urn, displayName: landed.displayName }
    }, [setExpandedNodes, provider, selectNode, scrollIntoView, containmentEdgeTypes])
}


/**
 * Warm the spine of a search hit without opening anything.
 *
 * Fired when the highlight rests on a row in the header's "Top matches"
 * list, so the ↵ that follows costs no round trip: the reveal walk finds
 * the whole spine already in the store and goes straight to opening it.
 *
 * It primes exactly what the reveal primes — the nodes, marked
 * `viaReveal`, AND the spine's containment edges — because a half-warmed
 * spine is worse than a cold one: an unflagged node is counted as a
 * loaded page and shifts the next page's offset past a real sibling
 * (`useGraphHydration`), and a node with no edge to its parent is drawn
 * nowhere.
 *
 * No-op once every spine node is present, so it is safe to call on every
 * rest of the highlight. Edges the store subsequently lost are the
 * reveal's problem, not the warm-up's — it re-fetches them unconditionally.
 */
export function usePrefetchSearchHitSpine(provider: GraphDataProvider) {
    const containmentEdgeTypes = useViewContainmentEdgeTypes()

    return useCallback(async (urn: string, ancestorPath: AncestorRef[]) => {
        const spineUrns = [...ancestorPath.map((a) => a.urn), urn]
        const nodeIndex = useCanvasStore.getState()._nodeIndex
        const missingUrns = spineUrns.filter((u) => !nodeIndex.has(u))
        if (missingUrns.length === 0) return
        try {
            const fetched = await provider.getNodes({ urns: missingUrns as any[] })
            if (fetched.length === 0) return
            const { addGraph } = useCanvasStore.getState()
            addGraph(
                fetched.map((n) => {
                    const node = toCanvasNode(n)
                    return { ...node, data: { ...node.data, viaReveal: true } }
                }),
                [],
            )
        } catch (e) {
            console.warn('[reveal] prefetch failed', e)
            // Non-fatal — the subsequent reveal walk retries the whole
            // spine, edges included, so there is nothing to salvage here.
            return
        }
        if (spineUrns.length <= 1) return
        try {
            const edges = await provider.getEdgesBetween(
                spineUrns as any[],
                containmentEdgeTypes.length > 0 ? containmentEdgeTypes : undefined,
            )
            if (edges.length > 0) {
                useCanvasStore.getState().addGraph([], edges.map((e) => toCanvasEdge(e)))
            }
        } catch (e) {
            console.warn('[reveal] prefetch edge priming failed', e)
        }
    }, [provider, containmentEdgeTypes])
}
