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
 */
import { useCallback } from 'react'

import { useCanvasStore } from '@/store/canvas'
import type { AncestorRef } from '@/types/search'


/** How long to wait after the spine walk before looking up the hit
 *  node. State updates are batched, so we let one tick settle. */
const REVEAL_SETTLE_MS = 80

export interface UseRevealNodeDeps {
    /** Setter for the canvas's `expandedNodes` set. */
    setExpandedNodes: React.Dispatch<React.SetStateAction<Set<string>>>
    /** Hydrate a parent node's children. Throws on network failure. */
    loadChildren: (nodeId: string) => Promise<void>
}

/** The reveal callback signature consumed by SearchMapPanel and friends. */
export type RevealNode = (urn: string, ancestorPath: AncestorRef[]) => Promise<void>


export function useRevealNode({ setExpandedNodes, loadChildren }: UseRevealNodeDeps): RevealNode {
    const selectNode = useCanvasStore((s) => s.selectNode)

    return useCallback(async (urn: string, ancestorPath: AncestorRef[]) => {
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

        // Settle one tick before looking for the hit; state updates
        // are batched and the latest spine expansion may not have
        // produced its store rows yet.
        await new Promise((resolve) => setTimeout(resolve, REVEAL_SETTLE_MS))
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
                break
            }
        }
    }, [setExpandedNodes, loadChildren, selectNode])
}
