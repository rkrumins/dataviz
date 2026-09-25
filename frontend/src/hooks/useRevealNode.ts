/**
 * useRevealNode — orchestrates "jump to node" from the entity drawer.
 *
 * Given a target node id (URN), this hook:
 *   1. If the target isn't in `canvas.nodes`, calls `provider.getAncestors`
 *      to fetch the chain root→target.parent, adds those ancestor nodes to
 *      the store, then sequentially calls `loadChildren` for each ancestor
 *      (this populates containment edges and the next level's siblings —
 *      including, at the deepest call, the target itself).
 *   2. Walks `parentMap` from the target up, collecting every ancestor not
 *      already in `expandedNodes`, and adds them all in one setState so
 *      layout re-runs once.
 *   3. Waits for layout to settle (two requestAnimationFrames) so node
 *      positions are populated.
 *   4. Calls the canvas-specific `focus(id)` adapter (setCenter on
 *      ReactFlow, scrollIntoView on DOM-based canvases).
 *
 * Errors during getAncestors / loadChildren are logged but swallowed —
 * the drawer-swap already happened, and we don't want a partial reveal to
 * surface as an uncaught error. Out-of-store ids (e.g., synthetic
 * aggregated-edge endpoints) fall through gracefully.
 */

import { useCallback, useRef } from 'react'
import { useCanvasStore } from '@/store/canvas'
import { toCanvasNode } from '@/hooks/useGraphHydration'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'

/**
 * What a reveal actually achieved.
 *
 * Reported rather than thrown: every existing caller ignores the return
 * value, and turning a routine "this view does not hold that entity" into a
 * rejection would surface as an unhandled error in all of them. A caller that
 * cares — the drawer, which is about to open a panel on this id — checks it.
 */
export type RevealOutcome =
  /** On the canvas and focused (or focus deliberately skipped). */
  | 'revealed'
  /** The walk finished and it is still not there: a view that does not hold
   *  it, a chain that could not be completed, or a synthetic rollup endpoint. */
  | 'unavailable'

export interface UseRevealNodeOptions {
  /** Map of childId → parentId (containment). Built by useContainmentHierarchy. */
  parentMap: Map<string, string>
  /** Setter for the canvas's local `expandedNodes` state. */
  setExpandedNodes: React.Dispatch<React.SetStateAction<Set<string>>>
  /** Fetch a single parent's children + containment edges into the store. */
  /** Resolves when the page has landed; its summary (ContextViewCanvas's
   *  announced variant returns one) is not this walk's to report. */
  loadChildren: (parentId: string) => Promise<unknown>
  /** Canvas-specific pan/scroll adapter. */
  focus: (nodeId: string) => void
  /** Backend lookup for the deep-hidden case. */
  provider: GraphDataProvider
  /** Is this node drawn as a row? When given, a target the store holds but
   *  no column draws (above the view's roots, in no layer) is not revealed:
   *  it is 'unavailable', and nothing is focused or pulsed. */
  isRendered?: (nodeId: string) => boolean
}

export interface RevealOptions {
  /** Skip the canvas-specific focus call. Used by batch flows
   *  (multi-select "Locate on canvas") where the caller will do a single
   *  fitView/scroll at the end instead of N competing per-node scrolls. */
  skipFocus?: boolean
}

export function useRevealNode(
  opts: UseRevealNodeOptions,
): (nodeId: string, revealOpts?: RevealOptions) => Promise<RevealOutcome> {
  // Stash latest opts in a ref so the returned reveal function has a stable
  // identity yet always sees the current parentMap / setters. Without this
  // the callback would re-create every time the parent canvas re-runs the
  // memo that builds parentMap, churning every consumer that captured it.
  const optsRef = useRef(opts)
  optsRef.current = opts

  return useCallback(async (nodeId: string, revealOpts?: RevealOptions): Promise<RevealOutcome> => {
    const { setExpandedNodes, loadChildren, focus, provider } = optsRef.current

    // ── 1. Make sure the target node exists in the store ──────────────────
    const inStore = (id: string) =>
      useCanvasStore.getState().nodes.some((n) => n.id === id)

    if (!inStore(nodeId)) {
      try {
        const ancestors = await provider.getAncestors(nodeId)
        // Order-agnostic: the server answers NEAREST-FIRST, the name here once
        // promised root-first, and neither matters — `loadChildren` fetches a
        // level's page by urn and needs nothing above it to be settled first.
        // What DID matter was that an ancestor arrives with `childCount: null`
        // (the /ancestors read cannot count), which the hydrator used to read
        // as "childless" and skip. See useGraphHydration.
        for (const a of ancestors) {
          const node = toCanvasNode(a)
          if (!inStore(node.id)) useCanvasStore.getState().addNodes([node])
          try {
            await loadChildren(node.id)
          } catch (err) {
            console.warn('[useRevealNode] loadChildren failed for', node.id, err)
          }
        }
      } catch (err) {
        console.warn('[useRevealNode] getAncestors failed for', nodeId, err)
      }
    }

    // If the target STILL isn't in the store, the chain fetch failed or the
    // id is synthetic (an aggregated-edge endpoint). SAY SO rather than
    // returning quietly: the caller opens a panel on this id, and a panel
    // pointed at an entity nobody loaded renders nothing at all.
    if (!inStore(nodeId)) return 'unavailable'

    // ── 2. Expand every collapsed ancestor in one update ──────────────────
    // Re-read the freshly-updated parentMap from optsRef in case loadChildren
    // mutated it (it doesn't actually re-render this callback, but the next
    // render's parentMap is what we want anyway — defer to setExpandedNodes's
    // updater to read whatever's current).
    const liveParentMap = optsRef.current.parentMap
    const ancestorIds: string[] = []
    let cursor: string | undefined = liveParentMap.get(nodeId)
    while (cursor) {
      ancestorIds.push(cursor)
      cursor = liveParentMap.get(cursor)
    }

    if (ancestorIds.length > 0) {
      setExpandedNodes((prev) => {
        // Skip the setState if nothing new — avoids a redundant render +
        // layout pass when the chain is already fully expanded.
        let added = false
        const next = new Set(prev)
        for (const id of ancestorIds) {
          if (!next.has(id)) {
            next.add(id)
            added = true
          }
        }
        return added ? next : prev
      })
    }

    // ── 3. Wait for layout to settle ─────────────────────────────────────
    // GraphCanvas's `layoutSignature` effect (elk) and ContextView's edge
    // projection both fire on `expandedNodes` changes. Two rAFs gives them
    // a chance to commit new positions/projections before we pan.
    await new Promise<void>((r) => requestAnimationFrame(() => r()))
    await new Promise<void>((r) => requestAnimationFrame(() => r()))

    // In the store is not on the canvas: say so rather than focus nothing.
    const { isRendered } = optsRef.current
    if (isRendered && !isRendered(nodeId)) return 'unavailable'

    // ── 4. Hand off to the canvas-specific focus implementation ──────────
    // Skipped by batch flows ("Locate N on canvas") that prefer a single
    // fitView/scrollTo at the end over N competing per-node scrolls.
    if (!revealOpts?.skipFocus) {
      focus(nodeId)
    }

    // ── 5. Pulse the target so the user sees where they landed ──────────
    // Always fires — for single reveals it marks the freshly-centered
    // node; for batch reveals it marks each one in place so users can
    // spot them after the trailing fitView/scrollTo settles.
    useCanvasStore.getState().pulseNode(nodeId)
    return 'revealed'
  }, [])
}
