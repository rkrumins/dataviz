/**
 * useTraceFilteredHierarchy — produce a trace-filtered view of the canvas
 * hierarchy.
 *
 * When a trace is active, the canvas should hide everything that isn't part
 * of the trace context. Without this hook the canvas renders all nodes and
 * dims non-trace ones to 40% opacity ([FlatTreeItem.tsx:91, :157]) — which
 * leaves a 5-level-deep trace visually buried under hundreds of unrelated
 * datasets / columns.
 *
 * Behaviour:
 *  - !isTracing → returns the inputs unchanged (reference equality, no
 *    allocation). The hook is a pass-through outside trace mode.
 *  - isTracing  → returns a NEW Map / arrays containing only nodes in the
 *    trace `contextSet` (traced URNs ∪ drill-down URNs ∪ all containment
 *    ancestors). Children that aren't in the context are pruned, recursively
 *    to any depth.
 *
 * Drill-down support: `trace.drilldowns` (Map<key, TraceV2Result>) is a
 * direct input. Each drill-down's `nodes[].urn` is added to the context set
 * so deeper levels reveal automatically when the user double-clicks an
 * AGGREGATED edge — no extra wiring needed.
 *
 * Ancestors are kept so containers that host traced descendants stay visible
 * even when they themselves aren't part of the lineage (e.g. a Schema with
 * no direct lineage but Datasets underneath it that do).
 *
 * Pass-through fallback for explicitly-expanded leaves: if the user expands
 * a node that's IN the trace context (so they're navigating through traced
 * lineage) but NONE of its descendants are in the context (typically because
 * the underlying graph doesn't have AGGREGATED edges materialised at that
 * finer level — e.g. column-level lineage isn't pre-computed), then ALL
 * descendants of that node are kept verbatim. Without this fallback the
 * canvas would show the parent expanded with zero visible children but a
 * misleading "X more" pill (driven by `node.data.childCount` which doesn't
 * know about the trace filter). The fallback degrades gracefully: precise
 * trace subset when the data supports it, full subtree otherwise. The user
 * always sees something when they explicitly drill into a traced node.
 */

import { useMemo } from 'react'
import type { HierarchyNode } from '@/types/hierarchy'
import type { TraceV2Result } from '@/providers/GraphDataProvider'

export interface UseTraceFilteredHierarchyOptions {
  /** Per-layer hierarchy from useLayerAssignment. */
  nodesByLayer: Map<string, HierarchyNode[]>
  /** Flat list of all hierarchy nodes (for downstream consumers). */
  displayFlat: HierarchyNode[]
  /** id → HierarchyNode lookup. */
  displayMap: Map<string, HierarchyNode>
  /** True when a trace is active. When false, hook is a no-op. */
  isTracing: boolean
  /** Strict trace membership — URNs returned by /trace/v2 (focus + upstream + downstream). */
  traceNodes: Set<string>
  /** Drill-down results from /trace/expand keyed by `${s}->${t}@${level}`. */
  drilldowns: Map<string, TraceV2Result>
  /** Canvas containment hierarchy: child id → parent id. From useContainmentHierarchy. */
  parentMap: Map<string, string>
  /** Nodes the user has explicitly expanded — drives the pass-through fallback. */
  expandedNodes: Set<string>
}

export interface UseTraceFilteredHierarchyResult {
  filteredByLayer: Map<string, HierarchyNode[]>
  filteredFlat: HierarchyNode[]
  filteredMap: Map<string, HierarchyNode>
  /** Trace context = traced URNs + drilldown URNs + ancestors. Empty when !isTracing. */
  contextSet: Set<string>
}

const EMPTY_CONTEXT = new Set<string>()

export function useTraceFilteredHierarchy(
  opts: UseTraceFilteredHierarchyOptions,
): UseTraceFilteredHierarchyResult {
  const { nodesByLayer, displayFlat, displayMap, isTracing, traceNodes, drilldowns, parentMap, expandedNodes } = opts

  return useMemo(() => {
    if (!isTracing || (traceNodes.size === 0 && drilldowns.size === 0)) {
      return {
        filteredByLayer: nodesByLayer,
        filteredFlat: displayFlat,
        filteredMap: displayMap,
        contextSet: EMPTY_CONTEXT,
      }
    }

    // 1. Build the context set: trace URNs + drill-down URNs + all ancestors.
    //    Ancestors keep host containers visible even if the container itself
    //    has no direct lineage edges.
    const contextSet = new Set<string>()
    const addWithAncestors = (id: string | undefined | null) => {
      if (!id || contextSet.has(id)) return
      contextSet.add(id)
      let parent = parentMap.get(id)
      while (parent) {
        if (contextSet.has(parent)) break
        contextSet.add(parent)
        parent = parentMap.get(parent)
      }
    }
    traceNodes.forEach(addWithAncestors)
    drilldowns.forEach(d => d.nodes.forEach(n => addWithAncestors(n.urn)))

    // 2. Recursively prune the hierarchy tree.
    //    Keep a node iff its id/urn is in the context OR any descendant is.
    //    Returns the rebuilt subtree, or null when the entire subtree is pruned.
    //
    //    `passThrough` propagates down from a relaxed ancestor: under such an
    //    ancestor, every node is kept verbatim (no further filtering).
    const filteredFlat: HierarchyNode[] = []
    const filteredMap = new Map<string, HierarchyNode>()

    const recordKept = (node: HierarchyNode) => {
      filteredFlat.push(node)
      filteredMap.set(node.id, node)
    }

    const collectSubtree = (node: HierarchyNode) => {
      // Used by pass-through: emit every descendant unchanged into the flat
      // map so search/edge-projection see them.
      recordKept(node)
      for (const c of node.children) collectSubtree(c)
    }

    const pruneTree = (node: HierarchyNode, passThrough: boolean): HierarchyNode | null => {
      if (passThrough) {
        collectSubtree(node)
        return node
      }

      const filteredChildren: HierarchyNode[] = []
      for (const child of node.children) {
        const kept = pruneTree(child, false)
        if (kept) filteredChildren.push(kept)
      }

      const inContext = contextSet.has(node.id) || contextSet.has(node.urn)

      // PASS-THROUGH FALLBACK: traced node, user-expanded, has children but
      // none of them passed the normal filter. Show everything inside —
      // descendants inherit pass-through so we don't double-walk.
      const shouldRelax =
        inContext
        && expandedNodes.has(node.id)
        && filteredChildren.length === 0
        && node.children.length > 0

      if (shouldRelax) {
        for (const c of node.children) collectSubtree(c)
        recordKept(node)
        return node  // original node with its original children — no rebuild
      }

      if (!inContext && filteredChildren.length === 0) return null

      const rebuilt: HierarchyNode = filteredChildren.length === node.children.length
        && filteredChildren.every((c, i) => c === node.children[i])
        ? node
        : { ...node, children: filteredChildren }

      recordKept(rebuilt)
      return rebuilt
    }

    const filteredByLayer = new Map<string, HierarchyNode[]>()
    nodesByLayer.forEach((layerNodes, layerId) => {
      const kept: HierarchyNode[] = []
      for (const root of layerNodes) {
        const subtree = pruneTree(root, false)
        if (subtree) kept.push(subtree)
      }
      filteredByLayer.set(layerId, kept)
    })

    return { filteredByLayer, filteredFlat, filteredMap, contextSet }
  }, [nodesByLayer, displayFlat, displayMap, isTracing, traceNodes, drilldowns, parentMap, expandedNodes])
}
