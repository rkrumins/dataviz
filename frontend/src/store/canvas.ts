import { create } from 'zustand'
import type { Node, Edge, Viewport } from '@xyflow/react'
import type { HydrationPhase, HydrationStatus } from '@/hooks/useGraphHydration'

export interface LineageNode extends Node {
  data: {
    label: string
    businessLabel?: string
    /** The entity's description (mapped from GraphNode.description in toCanvasNode). */
    description?: string
    urn: string
    type: string // Allow any entity type
    lensId?: string
    classifications?: string[]
    /** The entity's own persisted layer (Context View). Reload placement reads
     *  this; set on create and on a layer move. See toCanvasNode. */
    layerAssignment?: string
    confidence?: number
    metadata?: Record<string, unknown>
    /** Editable property bag (the canvas convention; see toCanvasNode). */
    properties?: Record<string, unknown>
    /** OCC token (content hash) the node was read at — echoed as baseVersion on an edit. */
    version?: string
    // Hierarchy
    childIds?: string[]
    parentId?: string
    isExpanded?: boolean
    childCount?: number
    // Roll-up data
    _collapsedChildCount?: number
    _rollupData?: Record<string, unknown>
    /** Pending change marker — drives the visual badge on the canvas. */
    isPending?: 'create' | 'delete' | 'modify'
    /** Reconstructed committed-deletion node (draft-vs-main). Read-only; rendered as a rose ghost
     *  until the draft is merged or the deletion is restored. See features/versioning/canvas/deletionGhosts. */
    isGhost?: boolean
    /** Primed out of band by a search reveal (`useRevealSearchHit`) rather than
     *  delivered by a child page. `loadChildren` excludes these from its page
     *  offset and clears the flag once a real page delivers the child. */
    viaReveal?: boolean
  }
}

export interface LineageEdge extends Edge {
  data?: {
    confidence?: number
    edgeType?: string
    relationship?: string
    animated?: boolean
    label?: string
    // For aggregated edges
    isAggregated?: boolean
    sourceEdgeCount?: number
    sourceEdges?: string[]
    /** OCC token (content hash) the edge was read at — echoed as baseVersion on an edit. */
    version?: string
    /** Pending change marker — an unsaved (optimistic) edge has no server re-fetch path. */
    isPending?: 'create' | 'delete' | 'modify'
  }
}

interface CanvasState {
  // Nodes and Edges
  nodes: LineageNode[]
  edges: LineageEdge[]
  _nodeIndex: Set<string>
  _edgeIndex: Set<string>
  /** Monotonic counter — incremented on every node/edge mutation. */
  _version: number
  setNodes: (nodes: LineageNode[]) => void
  setEdges: (edges: LineageEdge[]) => void
  addNodes: (nodes: LineageNode[]) => void
  addEdges: (edges: LineageEdge[]) => void
  /** Atomic set of both nodes and edges (1 re-render, prevents flash-of-no-edges) */
  setGraph: (nodes: LineageNode[], edges: LineageEdge[]) => void
  /** Atomic add of both nodes and edges with dedup (1 re-render) */
  addGraph: (nodes: LineageNode[], edges: LineageEdge[]) => void

  // Visible edges — the projected + aggregated lineage edge set currently
  // rendered on the canvas. Published by whichever canvas component owns
  // edge projection (ContextViewCanvas via useEdgeProjection; GraphCanvas via
  // its allVisibleEdges memo). Read by panels that need to mirror what the
  // user actually sees on canvas (e.g. EntityDrawer's Lineage section),
  // which raw `edges` alone cannot represent because raw edges live at
  // leaf level while the canvas shows them rolled up to visible ancestors
  // and merged with backend-aggregated edges. Empty when no canvas is
  // mounted — readers must fall back to `edges`.
  visibleEdges: LineageEdge[]
  setVisibleEdges: (edges: LineageEdge[]) => void

  // Edge-fetch integrity — records swallowed edge-fetch failures so the
  // canvas can tell the user the graph may be incomplete instead of
  // silently rendering nodes with missing edges. Cleared on retry /
  // successful rehydration.
  edgeFetchFailures: number
  lastEdgeError: string | null
  noteEdgeFetchFailure: (message?: string) => void
  clearEdgeFetchFailures: () => void
  /** True when a raw edge fetch returned exactly its request limit — the
   *  result was almost certainly truncated server-side. */
  edgesTruncated: boolean
  setEdgesTruncated: (edgesTruncated: boolean) => void

  // Node-fetch integrity — some batches of the initial load failed after
  // their retries while others succeeded. The canvas renders what arrived
  // and SAYS so (and keeps retrying), rather than a silently incomplete
  // view. `missingEntityCount` is the number of assigned entities in the
  // failed batches (0 when the failed batches were type-shaped, whose
  // size is unknown until they load).
  nodeFetchFailures: number
  missingEntityCount: number
  noteNodeFetchFailure: (batches: number, entities: number) => void
  clearNodeFetchFailures: () => void

  // One-shot pulse highlight — populated after a "jump to node" reveal so
  // the user sees a visible confirmation of where they landed. A Set
  // because multi-locate flows fire multiple pulses concurrently; using
  // a single id would let the latest call overwrite earlier ones and
  // only the last node would visibly pulse. Each entry auto-clears
  // after the animation duration (~900ms). Read by node components
  // (GenericNode, FlatTreeItem) via `pulseNodeIds.has(id)` to apply the
  // `lineage-pulse` class.
  pulseNodeIds: Set<string>
  pulseNode: (id: string) => void

  // Selection
  selectedNodeIds: string[]
  selectedEdgeIds: string[]
  selectNode: (id: string, multi?: boolean) => void
  /** Replace the whole node selection — what a shift-range and every bulk
   *  action need. Logical groupings are filtered out: a group is a visual
   *  container, not an entity, and bulk actions have nothing to walk from. */
  setSelection: (ids: string[]) => void
  /**
   * Multi-select armed from the UI. Cmd/Ctrl-click is the shortcut for it,
   * but a modifier nobody is told about is not a feature — with this on, a
   * plain click adds to the selection instead of replacing it.
   */
  multiSelectArmed: boolean
  setMultiSelectArmed: (armed: boolean) => void
  selectEdge: (id: string, multi?: boolean) => void
  clearSelection: () => void
  /** Last selectNode() call. `drawerNodeId` is sticky, so click observers (the
   * Hierarchy Builder's canvas navigation) need this monotonic seq to see a
   * fresh click on the SAME node. Bumped by every selectNode — never by
   * clearSelection (a background deselect is not a click). */
  lastNodeClick: { nodeId: string | null; seq: number }

  // Sticky entity drawer — which entity the drawer currently shows.
  // Decoupled from selection so background clicks / selection changes
  // don't close it; only an explicit close (X) does.
  drawerNodeId: string | null
  openNodeDrawer: (id: string) => void
  closeNodeDrawer: () => void
  /**
   * The drawer's own back/forward trail. Following lineage from the drawer —
   * a consumer, then its consumer, then back — is a WALK, and a walk you
   * cannot retrace is one people stop taking. `cursor` indexes `entries`;
   * -1 is an empty trail.
   */
  drawerHistory: { entries: string[]; cursor: number }
  drawerBack: () => void
  drawerForward: () => void

  // Viewport
  viewport: Viewport
  setViewport: (viewport: Viewport) => void

  // Loading State
  isLoading: boolean
  loadingRegions: Set<string>
  setLoading: (loading: boolean) => void
  addLoadingRegion: (region: string) => void
  removeLoadingRegion: (region: string) => void

  // Hydration phase — mirrored from useGraphHydration({hydrate:true}) in
  // CanvasRouter so downstream canvas components can drive ghost-loading UI
  // without each owning their own hydration hook.
  hydrationPhase: HydrationPhase
  setHydrationPhase: (phase: HydrationPhase) => void
  /** Authoritative hydration status, mirrored from CanvasRouter so downstream
   *  canvas components (empty-state, notifications, ghosts) derive their UI from ONE
   *  source and never render a failed/loading load as an empty graph. */
  hydrationStatus: HydrationStatus
  setHydrationStatus: (status: HydrationStatus) => void

  // Active Lens
  activeLensId: string | null
  setActiveLens: (lensId: string | null) => void

  // Trace State
  traceOrigin: string | null
  traceDirection: 'upstream' | 'downstream' | 'both'
  traceDepth: number
  setTraceOrigin: (nodeId: string | null) => void
  setTraceDirection: (direction: 'upstream' | 'downstream' | 'both') => void
  setTraceDepth: (depth: number) => void

  // Cache
  cachedRegions: Map<string, LineageNode[]>
  cacheRegion: (key: string, nodes: LineageNode[]) => void
  getCachedRegion: (key: string) => LineageNode[] | undefined
  clearCache: () => void

  // Editing Mode
  isEditing: boolean
  setEditing: (isEditing: boolean) => void

  // Node/Edge CRUD (Manual)
  updateNode: (id: string, data: Partial<LineageNode['data']>) => void
  removeNode: (id: string) => void
  removeEdge: (id: string) => void
  removeNodes: (ids: string[]) => void
  removeEdges: (ids: string[]) => void
  /**
   * Remove every edge whose source OR target is in the supplied set of
   * node ids. Used on subtree collapse to drop edges that only existed
   * because that subtree was expanded — without this, edges accumulate
   * monotonically across expand/collapse cycles.
   *
   * Note: this removes edges between the collapsed subtree and *visible*
   * peers too. That matches the intent — those edges represented the
   * subtree's relationships at its expanded granularity. Re-expanding
   * refetches them via loadChildren/drill paths.
   *
   * ``preserveEdgeIds`` (optional) — edges whose ids are in this set
   * survive the collapse even when their endpoint lies inside
   * ``nodeIds``. Used by the trace flow: trace lineage edges merged
   * via ``/trace/v2`` have no re-add path on re-expand
   * (``autoDrillOnExpand`` only drills aggregated edges, not the
   * original trace lineage). Passing the lineage subset of
   * ``useUnifiedTrace.addedEdgeIds`` keeps those edges in the store
   * across expand/collapse cycles so the user can drill in/out
   * without losing the lineage they were tracing.
   */
  removeEdgesByNodeIds: (
    nodeIds: Iterable<string>,
    preserveEdgeIds?: ReadonlySet<string>,
  ) => void
}

import { persist, createJSONStorage } from 'zustand/middleware'
import type { StateCreator } from 'zustand'

/**
 * Middleware: auto-increment `_version` whenever nodes or edges change.
 * Replaces brittle fingerprint sampling with a monotonic counter.
 */
const withVersion: (
  config: StateCreator<CanvasState, [], []>,
) => StateCreator<CanvasState, [], []> =
  (config) => (rawSet, get, api) => {
    const wrappedSet: typeof rawSet = (...args: any[]) => {
      const [partial, replace] = args
      const update: Record<string, unknown> =
        typeof partial === 'function' ? partial(get()) : partial
      const touchesGraph = 'nodes' in update || 'edges' in update
        || '_nodeIndex' in update || '_edgeIndex' in update
      if (touchesGraph) {
        return (rawSet as any)(
          { ...update, _version: get()._version + 1 } as Partial<CanvasState>,
          replace,
        )
      }
      return (rawSet as any)(partial, replace)
    }
    return config(wrappedSet, get, api)
  }

export const useCanvasStore = create<CanvasState>()(
  persist(
    withVersion(
    (set, get) => ({
      // Nodes and Edges
      nodes: [],
      edges: [],
      _nodeIndex: new Set(),
      _edgeIndex: new Set(),
      _version: 0,
      setNodes: (nodes) => set({ nodes, _nodeIndex: new Set(nodes.map((n) => n.id)) }),
      setEdges: (edges) => set({ edges, _edgeIndex: new Set(edges.map((e) => e.id)) }),
      visibleEdges: [],
      setVisibleEdges: (visibleEdges) => set({ visibleEdges }),

      edgeFetchFailures: 0,
      lastEdgeError: null,
      noteEdgeFetchFailure: (message) => set((state) => ({
        edgeFetchFailures: state.edgeFetchFailures + 1,
        lastEdgeError: message ?? state.lastEdgeError,
      })),
      clearEdgeFetchFailures: () => set({ edgeFetchFailures: 0, lastEdgeError: null }),
      edgesTruncated: false,
      setEdgesTruncated: (edgesTruncated) => set({ edgesTruncated }),
      nodeFetchFailures: 0,
      missingEntityCount: 0,
      noteNodeFetchFailure: (batches, entities) => set({
        nodeFetchFailures: batches,
        missingEntityCount: entities,
      }),
      clearNodeFetchFailures: () => set({ nodeFetchFailures: 0, missingEntityCount: 0 }),
      pulseNodeIds: new Set(),
      pulseNode: (id) => {
        // Add to the pulsing set; each id auto-clears after the
        // animation duration. Using a Set lets multi-locate fire many
        // pulses in parallel without overwriting each other.
        set((state) => {
          if (state.pulseNodeIds.has(id)) return state // already pulsing
          const next = new Set(state.pulseNodeIds)
          next.add(id)
          return { pulseNodeIds: next }
        })
        setTimeout(() => {
          set((state) => {
            if (!state.pulseNodeIds.has(id)) return state
            const next = new Set(state.pulseNodeIds)
            next.delete(id)
            return { pulseNodeIds: next }
          })
        }, 900)
      },
      addNodes: (newNodes) => set((state) => {
        const existingIds = state._nodeIndex
        const uniqueNodes: LineageNode[] = []
        const dupes = new Map<string, LineageNode>()
        for (const n of newNodes) {
          if (existingIds.has(n.id)) dupes.set(n.id, n)
          else uniqueNodes.push(n)
        }
        const enriched = dupes.size > 0 ? enrichAll(state.nodes, dupes) : null
        if (uniqueNodes.length === 0 && !enriched) return state
        const nextIndex = uniqueNodes.length > 0 ? new Set(existingIds) : existingIds
        uniqueNodes.forEach((n) => nextIndex.add(n.id))
        return { nodes: [...(enriched ?? state.nodes), ...uniqueNodes], _nodeIndex: nextIndex }
      }),
      addEdges: (newEdges) => set((state) => {
        const existingIds = state._edgeIndex
        const uniqueEdges = newEdges.filter((e) => !existingIds.has(e.id))
        if (uniqueEdges.length === 0) return state // No-op: prevent unnecessary re-render
        const nextIndex = new Set(existingIds)
        uniqueEdges.forEach((e) => nextIndex.add(e.id))
        return { edges: [...state.edges, ...uniqueEdges], _edgeIndex: nextIndex }
      }),
      setGraph: (nodes, edges) => set(() => {
        // Dedup by id to prevent React duplicate-key warnings when callers
        // pass arrays with overlapping entries (e.g. assigned + child nodes).
        const seenNodes = new Set<string>()
        const dedupedNodes: LineageNode[] = []
        for (const n of nodes) {
          if (!seenNodes.has(n.id)) {
            seenNodes.add(n.id)
            dedupedNodes.push(n)
          }
        }
        const seenEdges = new Set<string>()
        const dedupedEdges: LineageEdge[] = []
        for (const e of edges) {
          if (!seenEdges.has(e.id)) {
            seenEdges.add(e.id)
            dedupedEdges.push(e)
          }
        }
        return {
          nodes: dedupedNodes,
          edges: dedupedEdges,
          _nodeIndex: seenNodes,
          _edgeIndex: seenEdges,
        }
      }),
      addGraph: (newNodes, newEdges) => set((state) => {
        const uniqueNodes: LineageNode[] = []
        const dupes = new Map<string, LineageNode>()
        for (const n of newNodes) {
          if (state._nodeIndex.has(n.id)) dupes.set(n.id, n)
          else uniqueNodes.push(n)
        }
        const uniqueEdges = newEdges.filter((e) => !state._edgeIndex.has(e.id))
        const enriched = dupes.size > 0 ? enrichAll(state.nodes, dupes) : null
        if (uniqueNodes.length === 0 && uniqueEdges.length === 0 && !enriched) return state
        const nodeIndex = uniqueNodes.length > 0 ? new Set(state._nodeIndex) : state._nodeIndex
        const edgeIndex = uniqueEdges.length > 0 ? new Set(state._edgeIndex) : state._edgeIndex
        uniqueNodes.forEach((n) => nodeIndex.add(n.id))
        uniqueEdges.forEach((e) => edgeIndex.add(e.id))
        return {
          nodes: [...(enriched ?? state.nodes), ...uniqueNodes],
          edges: [...state.edges, ...uniqueEdges],
          _nodeIndex: nodeIndex,
          _edgeIndex: edgeIndex,
        }
      }),

      // Selection
      selectedNodeIds: [],
      selectedEdgeIds: [],
      selectNode: (id, multi = false) => set((state) => ({
        selectedNodeIds: multi
          // A logical grouping is a container, not an entity — it can be
          // clicked, but it never joins a selection a bulk action reads.
          ? isSelectableNode(id)
            ? state.selectedNodeIds.includes(id)
              ? state.selectedNodeIds.filter((nid) => nid !== id)
              : [...state.selectedNodeIds, id]
            : state.selectedNodeIds
          : state.selectedNodeIds.length === 1 && state.selectedNodeIds[0] === id
            ? [] // Toggle off: clicking the already-selected node deselects it
            : [id],
        selectedEdgeIds: multi ? state.selectedEdgeIds : [],
        // Every selectNode is a click — recorded even when the sticky drawer
        // id below doesn't change (same-node re-click).
        lastNodeClick: { nodeId: id, seq: state.lastNodeClick.seq + 1 },
        // Single-select of a real entity opens (or swaps) the sticky drawer.
        // Toggle-off keeps it open — only the X button closes it. Logical
        // groupings and multi-select never touch the drawer.
        // A single-select click opens the drawer on that entity, so it is a
        // move like any other — otherwise Back would skip the steps taken on
        // the canvas. A multi-selection never touches the drawer, so it is
        // not a move.
        ...(!multi && !id.startsWith('logical:')
          ? { drawerNodeId: id, drawerHistory: pushDrawerHistory(state.drawerHistory, id) }
          : {}),
      })),
      selectEdge: (id, multi = false) => set((state) => ({
        selectedEdgeIds: multi
          ? state.selectedEdgeIds.includes(id)
            ? state.selectedEdgeIds.filter((eid) => eid !== id)
            : [...state.selectedEdgeIds, id]
          : [id],
        selectedNodeIds: multi ? state.selectedNodeIds : [],
        // Mutual exclusion: selecting an edge swaps the right rail to the
        // edge drawer.
        drawerNodeId: null,
      })),
      setSelection: (ids) => set(() => {
        const next = [...new Set(ids.filter(isSelectableNode))]
        return {
          selectedNodeIds: next,
          // Node and edge selections are mutually exclusive, as in selectNode.
          selectedEdgeIds: [],
          // One node set this way reads as a plain click and opens the sticky
          // drawer; a set of several must not, because the drawer shows ONE
          // entity and a selection of five is not one entity.
          ...(next.length === 1 ? { drawerNodeId: next[0] } : {}),
        }
      }),
      multiSelectArmed: false,
      setMultiSelectArmed: (multiSelectArmed) => set({ multiSelectArmed }),
      clearSelection: () => set({ selectedNodeIds: [], selectedEdgeIds: [], multiSelectArmed: false }),
      lastNodeClick: { nodeId: null, seq: 0 },

      // Sticky entity drawer
      drawerNodeId: null,
      drawerHistory: { entries: [], cursor: -1 },
      openNodeDrawer: (id) => set((state) => ({
        drawerNodeId: id,
        drawerHistory: pushDrawerHistory(state.drawerHistory, id),
      })),
      closeNodeDrawer: () => set({ drawerNodeId: null, drawerHistory: { entries: [], cursor: -1 } }),
      drawerBack: () => set((state) => {
        const cursor = state.drawerHistory.cursor - 1
        if (cursor < 0) return {}
        return {
          drawerNodeId: state.drawerHistory.entries[cursor]!,
          drawerHistory: { ...state.drawerHistory, cursor },
        }
      }),
      drawerForward: () => set((state) => {
        const cursor = state.drawerHistory.cursor + 1
        if (cursor >= state.drawerHistory.entries.length) return {}
        return {
          drawerNodeId: state.drawerHistory.entries[cursor]!,
          drawerHistory: { ...state.drawerHistory, cursor },
        }
      }),

      // Viewport
      viewport: { x: 0, y: 0, zoom: 1 },
      setViewport: (viewport) => set({ viewport }),

      // Loading
      isLoading: false,
      loadingRegions: new Set(),
      hydrationPhase: 'idle',
      setHydrationPhase: (hydrationPhase) => set({ hydrationPhase }),
      hydrationStatus: 'loading',
      setHydrationStatus: (hydrationStatus) => set({ hydrationStatus }),
      setLoading: (isLoading) => set({ isLoading }),
      addLoadingRegion: (region) => set((state) => {
        const newRegions = new Set(state.loadingRegions)
        newRegions.add(region)
        return { loadingRegions: newRegions, isLoading: true }
      }),
      removeLoadingRegion: (region) => set((state) => {
        const newRegions = new Set(state.loadingRegions)
        newRegions.delete(region)
        return {
          loadingRegions: newRegions,
          isLoading: newRegions.size > 0
        }
      }),

      // Active Lens
      activeLensId: null,
      setActiveLens: (activeLensId) => set({ activeLensId }),

      // Trace
      traceOrigin: null,
      traceDirection: 'both',
      traceDepth: 10,
      setTraceOrigin: (traceOrigin) => set({ traceOrigin }),
      setTraceDirection: (traceDirection) => set({ traceDirection }),
      setTraceDepth: (traceDepth) => set({ traceDepth }),

      // Cache
      cachedRegions: new Map(),
      cacheRegion: (key, nodes) => set((state) => {
        const newCache = new Map(state.cachedRegions)
        newCache.set(key, nodes)
        return { cachedRegions: newCache }
      }),
      getCachedRegion: (key) => get().cachedRegions.get(key),
      clearCache: () => set({ cachedRegions: new Map() }),

      // Editing Mode
      isEditing: false,
      setEditing: (isEditing) => set({ isEditing }),

      // Node/Edge CRUD (Manual)
      updateNode: (id, data) => set((state) => ({
        nodes: state.nodes.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, ...data } } : n
        )
      })),
      removeNode: (id) => set((state) => {
        const nextNodeIndex = new Set(state._nodeIndex)
        nextNodeIndex.delete(id)
        const remainingEdges = state.edges.filter((e) => e.source !== id && e.target !== id)
        const nextEdgeIndex = new Set(remainingEdges.map((e) => e.id))
        return {
          nodes: state.nodes.filter((n) => n.id !== id),
          edges: remainingEdges,
          _nodeIndex: nextNodeIndex,
          _edgeIndex: nextEdgeIndex,
        }
      }),
      removeNodes: (ids) => set((state) => {
        if (ids.length === 0) return state
        const idSet = new Set(ids)
        const nextNodeIndex = new Set(state._nodeIndex)
        ids.forEach(id => nextNodeIndex.delete(id))
        const remainingEdges = state.edges.filter((e) => !idSet.has(e.source) && !idSet.has(e.target))
        const nextEdgeIndex = new Set(remainingEdges.map((e) => e.id))
        return {
          nodes: state.nodes.filter((n) => !idSet.has(n.id)),
          edges: remainingEdges,
          _nodeIndex: nextNodeIndex,
          _edgeIndex: nextEdgeIndex,
        }
      }),
      removeEdge: (id) => set((state) => {
        const nextEdgeIndex = new Set(state._edgeIndex)
        nextEdgeIndex.delete(id)
        return {
          edges: state.edges.filter((e) => e.id !== id),
          _edgeIndex: nextEdgeIndex,
        }
      }),
      removeEdges: (ids) => set((state) => {
        if (ids.length === 0) return state
        const idSet = new Set(ids)
        const nextEdgeIndex = new Set(state._edgeIndex)
        ids.forEach(id => nextEdgeIndex.delete(id))
        return {
          edges: state.edges.filter((e) => !idSet.has(e.id)),
          _edgeIndex: nextEdgeIndex,
        }
      }),
      removeEdgesByNodeIds: (nodeIds, preserveEdgeIds) => set((state) => {
        const nodeIdSet = nodeIds instanceof Set ? nodeIds : new Set(nodeIds)
        if (nodeIdSet.size === 0) return state
        // Unsaved (optimistic) nodes have no server record, so an edge attached to one
        // has NO re-fetch path. The collapse cleanup drops subtree edges expecting
        // `loadChildren` to re-fetch them on re-expand — true for saved data, but an
        // unsaved child's containment edge would be lost forever, flattening the
        // hierarchy. Collapse is a visibility op; it must never destroy unsaved work.
        const pendingNodeIds = new Set<string>()
        for (const n of state.nodes) {
          if (n.data?.isPending === 'create') pendingNodeIds.add(n.id)
        }
        const nextEdgeIndex = new Set(state._edgeIndex)
        const remainingEdges: LineageEdge[] = []
        for (const e of state.edges) {
          const touchesSubtree = nodeIdSet.has(e.source) || nodeIdSet.has(e.target)
          // Edges in `preserveEdgeIds` survive the collapse even when an
          // endpoint is inside the subtree — see the type definition
          // for the trace-mode rationale.
          const isPreserved = preserveEdgeIds?.has(e.id) === true
          // An optimistic edge — itself pending, or touching an unsaved node — can't
          // be re-fetched, so it is preserved unconditionally.
          const isUnsaved =
            e.data?.isPending === 'create' ||
            pendingNodeIds.has(e.source) ||
            pendingNodeIds.has(e.target)
          if (touchesSubtree && !isPreserved && !isUnsaved) {
            nextEdgeIndex.delete(e.id)
          } else {
            remainingEdges.push(e)
          }
        }
        if (remainingEdges.length === state.edges.length) return state
        return { edges: remainingEdges, _edgeIndex: nextEdgeIndex }
      }),
    })),
    {
      name: 'canvas-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        viewport: state.viewport,
        activeLensId: state.activeLensId,
      }),
    }
  )
)

/**
 * Fill in what the store is MISSING about a node it already holds.
 *
 * `addNodes`/`addGraph` keep the first version of an id they are given, which
 * is right for position and for anything the user has since edited — but it
 * also meant a node first seen in a LEAN shape could never be completed. The
 * ancestors `/ancestors` returns carry `childCount: null`, so a container
 * first met that way kept no child count for the rest of the session: no `+N`
 * badge, no chevron, no way to open it. That is a container losing its
 * containment tree, and no amount of re-fetching fixed it.
 *
 * Fill-only, never overwrite: a value the store already has wins, so a richer
 * earlier read, a live edit and a node's position are all safe. Returns the
 * SAME object when nothing was missing, so React sees no change.
 */
function enrichNode(existing: LineageNode, incoming: LineageNode): LineageNode {
  const from = incoming.data as Record<string, unknown> | undefined
  if (!from) return existing
  const have = existing.data as unknown as Record<string, unknown>
  let filled: Record<string, unknown> | null = null
  for (const key in from) {
    const v = from[key]
    if (v === undefined || v === null) continue
    if (have[key] !== undefined && have[key] !== null) continue
    filled ??= { ...have }
    filled[key] = v
  }
  return filled ? ({ ...existing, data: filled } as LineageNode) : existing
}

/**
 * One pass over the held nodes, filling whatever the incoming duplicates can
 * complete. Returns null when nothing changed — the caller then keeps the
 * existing array and React re-renders nothing. O(nodes + dupes), the same
 * order as the copy the caller was doing anyway.
 */
function enrichAll(
  nodes: LineageNode[],
  dupes: Map<string, LineageNode>,
): LineageNode[] | null {
  let changed = false
  const next = nodes.map((n) => {
    const incoming = dupes.get(n.id)
    if (!incoming) return n
    const merged = enrichNode(n, incoming)
    if (merged !== n) changed = true
    return merged
  })
  return changed ? next : null
}

/** Record a drawer move. A move from the middle of the trail drops whatever
 *  was ahead of it, the way every back/forward history does; re-opening the
 *  entity already shown is not a move. */
function pushDrawerHistory(
  history: { entries: string[]; cursor: number },
  id: string,
): { entries: string[]; cursor: number } {
  if (history.entries[history.cursor] === id) return history
  const entries = [...history.entries.slice(0, history.cursor + 1), id]
  return { entries, cursor: entries.length - 1 }
}

/** A logical grouping (`logical:<id>`) is a visual container the view config
 *  declares, not an entity in the graph. It has no urn to trace, expand or
 *  link, so it never belongs in a selection that bulk actions read. */
export const isSelectableNode = (id: string): boolean => !id.startsWith('logical:')

// Selector hooks
export const useNodes = () => useCanvasStore((s) => s.nodes)
export const useEdges = () => useCanvasStore((s) => s.edges)
export const useSelectedNodes = () => useCanvasStore((s) => s.selectedNodeIds)
export const useIsLoading = () => useCanvasStore((s) => s.isLoading)
export const useCanvasVersion = () => useCanvasStore((s) => s._version)

