/**
 * Reveal a search hit on the ContextView canvas.
 *
 * Walks the ancestor chain in the canvas store, expanding each
 * ancestor in turn (lazy-loading its children via `loadChildren`) so
 * the deep hit becomes reachable; then selects + brings the hit into
 * view. Falls back to the deepest reachable ancestor if a step on the
 * spine cannot be loaded — partial reveal beats no reveal.
 *
 * Extracted from the inline lambda previously in ContextViewCanvas so
 * that pin clicks (SearchPinOverlay — W3) and bucket "Reveal subtree"
 * actions can drive the same flow.
 *
 * The `setExpandedNodes` setter is canvas-local React state and must
 * be passed in by the caller; `loadChildren` comes from
 * `useGraphHydration`. `selectNode` is pulled directly from the
 * canvas store inside the hook because it has no per-instance state.
 *
 * Renamed from `useRevealNode` during the resilience-hardening + advanced-search
 * integration so it can coexist with the entity-drawer reveal hook of the same
 * original name. Behavior is identical to the original Advanced Search version.
 */
import { useCallback } from 'react'

import { useCanvasStore } from '@/store/canvas'
import { toCanvasNode } from '@/hooks/useGraphHydration'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import type { AncestorRef } from '@/types/search'


/**
 * Wait one animation frame so the just-fired ``setExpandedNodes`` React
 * state update commits before we attempt the hit lookup. Replaces the
 * previous ``setTimeout(80)`` hack which was both arbitrary AND lost
 * its race on slow networks / deep spines (the user then had to
 * re-click to actually land on the hit).
 *
 * One rAF is sufficient because the canvas store (Zustand) commits
 * synchronously on ``loadChildren`` resolution; the only async wait we
 * need is for React's scheduler to flush the expansion state so the
 * LayerColumn re-renders with the new ``flatTree`` before its
 * ``revealTarget`` effect re-runs.
 */
function nextFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

export interface UseRevealSearchHitDeps {
    /** Setter for the canvas's `expandedNodes` set. */
    setExpandedNodes: React.Dispatch<React.SetStateAction<Set<string>>>
    /** Hydrate a parent node's children. Throws on network failure. */
    loadChildren: (nodeId: string) => Promise<void>
    /** Graph data provider — used to prime missing spine ancestors via
     *  `getNodes({ urns })` before the spine walk. Without this, the walk
     *  halts at the first ancestor that wasn't fetched on hydration
     *  (which, with lazy loading, is every non-top-level ancestor). */
    provider: GraphDataProvider
    /** Optional: after the hit is selected (or after we fall back to the
     *  deepest reachable ancestor), bring that node into the viewport.
     *  Receives the canvas-node id (== URN for the ContextView layout).
     *  Implementations typically rAF-poll the DOM because the row may
     *  not have re-rendered yet after the spine expansion. */
    scrollIntoView?: (nodeId: string) => void
}

/** The reveal callback signature consumed by SearchMapPanel and friends. */
export type RevealSearchHit = (urn: string, ancestorPath: AncestorRef[]) => Promise<void>


export function useRevealSearchHit({ setExpandedNodes, loadChildren, provider, scrollIntoView }: UseRevealSearchHitDeps): RevealSearchHit {
    const selectNode = useCanvasStore((s) => s.selectNode)

    return useCallback(async (urn: string, ancestorPath: AncestorRef[]) => {
        // Prime the spine: with lazy children loading, only top-level
        // entities are in the canvas store after hydration. Each
        // subsequent ancestor (and the hit itself) must be materialized
        // before the spine walk can find them. One getNodes call covers
        // the whole chain regardless of depth; containment edges are
        // committed by the per-ancestor loadChildren calls below.
        const spineUrns = [...ancestorPath.map((a) => a.urn), urn]
        const existingNodes = useCanvasStore.getState().nodes
        const existingUrns = new Set(
            existingNodes.flatMap((n) => {
                const u = n.data?.urn as string | undefined
                return u ? [n.id, u] : [n.id]
            }),
        )
        const missingUrns = spineUrns.filter((u) => !existingUrns.has(u))
        if (missingUrns.length > 0) {
            try {
                const fetched = await provider.getNodes({ urns: missingUrns as any[] })
                if (fetched.length > 0) {
                    const { addGraph } = useCanvasStore.getState()
                    addGraph(fetched.map((n) => toCanvasNode(n)), [])
                }
            } catch (e) {
                console.warn('[reveal] spine priming failed', e)
                // Continue — the spine walk will fall back to the
                // deepest reachable ancestor.
            }
        }

        // Spine walk: expand each ancestor in turn so the deep hit
        // becomes reachable. Each `loadChildren` is awaited so the
        // canvas store settles before the next ancestor lookup.
        // We re-read `nodes` via getState() between steps because the
        // closure-captured `nodes` would be stale relative to
        // in-flight hydration.
        for (const ancestor of ancestorPath) {
            const currentNodes = useCanvasStore.getState().nodes
            const ancNode = currentNodes.find(
                (n) =>
                    (n.data?.urn as string) === ancestor.urn ||
                    n.id === ancestor.urn,
            )
            if (!ancNode) {
                // Ancestor isn't in the canvas yet — the previous
                // loadChildren didn't produce it. Stop walking; we'll
                // select the deepest reachable node below.
                break
            }
            setExpandedNodes((prev) => {
                const next = new Set(prev)
                next.add(ancNode.id)
                return next
            })
            try {
                await loadChildren(ancNode.id)
            } catch (e) {
                console.warn('[reveal] loadChildren failed for', ancestor.urn, e)
                // Keep walking — partial reveal beats no reveal.
            }
        }

        // Settle one animation frame so React commits the latest
        // ``setExpandedNodes`` before we look up the hit row — the
        // LayerColumn's ``flatTree`` (and therefore its
        // ``nodeToFlatIndexMap``) only updates after the expansion
        // state propagates. The canvas store itself sees loaded
        // children synchronously via ``getState()`` (Zustand commits
        // outside React batching), so a single frame is enough.
        await nextFrame()
        const allNodes = useCanvasStore.getState().nodes
        const hitNode = allNodes.find(
            (n) => (n.data?.urn as string) === urn || n.id === urn,
        )

        if (hitNode) {
            selectNode(hitNode.id)
            // Also expand the hit's immediate parent so the hit row
            // itself renders (containers don't render their children
            // until expanded).
            const parent = ancestorPath[ancestorPath.length - 1]
            if (parent) {
                const parentNode = allNodes.find(
                    (n) => (n.data?.urn as string) === parent.urn,
                )
                if (parentNode) {
                    setExpandedNodes((prev) => new Set([...prev, parentNode.id]))
                }
            }
            scrollIntoView?.(hitNode.id)
            return
        }

        // Hit isn't loaded (deep leaf, or a step failed). Fall back to
        // selecting the deepest reachable ancestor so the user gets
        // visual confirmation that we landed near the target.
        for (let i = ancestorPath.length - 1; i >= 0; i--) {
            const ancNode = allNodes.find(
                (n) => (n.data?.urn as string) === ancestorPath[i].urn,
            )
            if (ancNode) {
                selectNode(ancNode.id)
                scrollIntoView?.(ancNode.id)
                break
            }
        }
    }, [setExpandedNodes, loadChildren, provider, selectNode, scrollIntoView])
}


/**
 * Warm the spine cache for a search hit without expanding the canvas.
 *
 * Intended to be fired when the user focuses a match in the MatchBar
 * (via the stepper or J/K keys) so the SUBSEQUENT click on "Reveal in
 * canvas" — or an auto-reveal triggered by ``focusedMatchIndex`` — does
 * not pay the spine-fetch round-trip. The actual ``selectNode`` /
 * scroll happens via ``useRevealSearchHit``; this hook only seeds the
 * canvas store with the ancestor + hit nodes so the reveal walk skips
 * its priming step entirely.
 *
 * No-op for spines already present in the store, so it's safe to call
 * eagerly on every focus change.
 */
export function usePrefetchSearchHitSpine(provider: GraphDataProvider) {
    return useCallback(async (urn: string, ancestorPath: AncestorRef[]) => {
        const spineUrns = [...ancestorPath.map((a) => a.urn), urn]
        const existingNodes = useCanvasStore.getState().nodes
        const existingUrns = new Set(
            existingNodes.flatMap((n) => {
                const u = n.data?.urn as string | undefined
                return u ? [n.id, u] : [n.id]
            }),
        )
        const missingUrns = spineUrns.filter((u) => !existingUrns.has(u))
        if (missingUrns.length === 0) return
        try {
            const fetched = await provider.getNodes({ urns: missingUrns as any[] })
            if (fetched.length === 0) return
            const { addGraph } = useCanvasStore.getState()
            addGraph(fetched.map((n) => toCanvasNode(n)), [])
        } catch (e) {
            console.warn('[reveal] prefetch failed', e)
            // Non-fatal — the subsequent reveal walk will retry the
            // missing URNs anyway.
        }
    }, [provider])
}
