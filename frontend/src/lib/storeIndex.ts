/**
 * Lookups over the canvas store's node and edge arrays, built once per array.
 *
 * A panel that needs one node used to subscribe to ALL nodes and `find` it: every store write
 * that touched `nodes` (a pulse, a hover flag, an unrelated page of children) re-rendered it and
 * re-scanned the array. Keyed by the array itself in a `WeakMap` — the store replaces the array
 * on every change — these indexes are built at most once per version and shared by every reader,
 * and a selector that returns `nodeIndexOf(s.nodes).get(id)` returns the SAME object until that
 * node changes, so its component re-renders only then. (The `lens/model-cache.ts` pattern: no
 * invalidation to get wrong, a different array is a different key.)
 */
import type { LineageEdge, LineageNode } from '@/store/canvas'
import { isContainmentEdgeType, normalizeEdgeType } from '@/store/schema'

const NODE_INDEX = new WeakMap<readonly LineageNode[], Map<string, LineageNode>>()
const EDGE_INDEX = new WeakMap<readonly LineageEdge[], Map<string, LineageEdge>>()
const CONTAINMENT_INDEX = new WeakMap<readonly LineageEdge[], Map<string, ContainmentIndex>>()

/** id → node; a node whose urn differs from its id answers to both. */
export function nodeIndexOf(nodes: readonly LineageNode[]): Map<string, LineageNode> {
  let index = NODE_INDEX.get(nodes)
  if (!index) {
    index = new Map()
    for (const n of nodes) {
      index.set(n.id, n)
      const urn = n.data?.urn as string | undefined
      if (urn && urn !== n.id && !index.has(urn)) index.set(urn, n)
    }
    NODE_INDEX.set(nodes, index)
  }
  return index
}

/** id → edge. */
export function edgeIndexOf(edges: readonly LineageEdge[]): Map<string, LineageEdge> {
  let index = EDGE_INDEX.get(edges)
  if (!index) {
    index = new Map(edges.map((e) => [e.id, e]))
    EDGE_INDEX.set(edges, index)
  }
  return index
}

export interface ContainmentIndex {
  /** child id → the containment edge that places it. */
  parentEdgeOf: Map<string, LineageEdge>
  /** parent id → its loaded children's ids. */
  childrenOf: Map<string, string[]>
}

const EMPTY_CHILDREN: readonly string[] = []

/** The loaded containment tree, for one set of containment edge types. */
export function containmentIndexOf(edges: readonly LineageEdge[], containmentTypes: readonly string[]): ContainmentIndex {
  const key = [...containmentTypes].map((t) => t.toUpperCase()).sort().join('|')
  let byTypes = CONTAINMENT_INDEX.get(edges)
  if (!byTypes) {
    byTypes = new Map()
    CONTAINMENT_INDEX.set(edges, byTypes)
  }
  let index = byTypes.get(key)
  if (!index) {
    index = { parentEdgeOf: new Map(), childrenOf: new Map() }
    const types = [...containmentTypes]
    for (const e of edges) {
      if (!e.source || !e.target || !isContainmentEdgeType(normalizeEdgeType(e), types)) continue
      if (!index.parentEdgeOf.has(e.target)) index.parentEdgeOf.set(e.target, e)
      const kids = index.childrenOf.get(e.source)
      if (kids) kids.push(e.target)
      else index.childrenOf.set(e.source, [e.target])
    }
    byTypes.set(key, index)
  }
  return index
}

/** A node's loaded children (empty when none are loaded). */
export function childrenOf(index: ContainmentIndex, id: string): readonly string[] {
  return index.childrenOf.get(id) ?? EMPTY_CHILDREN
}
