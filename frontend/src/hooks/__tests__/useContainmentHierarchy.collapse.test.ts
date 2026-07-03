/**
 * Regression: collapsing a saved containment subtree in a Context View must not
 * leave the descendant NODES orphaned in the store.
 *
 * `ContextViewCanvas.toggleNode`'s collapse branch drops the subtree's
 * containment EDGES (via `removeEdgesByNodeIds`) expecting `loadChildren` to
 * refetch them on re-expand. But it left the descendant nodes behind. In an
 * entity-type-scoped column those parent-less nodes are re-assigned a layer by
 * their type rule (`useLayerAssignment`) and surface as spurious ROOT-level
 * rows — the "collapse scramble". The fix also removes the now edge-less
 * descendant nodes (browse mode, never unsaved work), restoring the lazy-tree
 * invariant so re-expand is a clean level-by-level refetch.
 *
 * The real `toggleNode` lives inside the 2400-line canvas component and can't be
 * rendered in isolation, so `collapseCleanup` below is a faithful mirror of its
 * browse-mode collapse branch. It reproduces production's COARSE whole-subtree
 * gate: if the subtree carries ANY unsaved work — a pending NODE, a pending
 * incident EDGE (reparent/move), or a staged property edit in
 * `stagedChangesStore` — pruning is skipped entirely and only edges are dropped
 * (`removeEdgesByNodeIds`, which itself preserves unsaved edges); otherwise the
 * whole subtree of descendant NODES is removed. It composes the REAL store
 * actions (`removeEdgesByNodeIds`, `removeNodes`) and the REAL
 * `useContainmentHierarchy` root computation. Any change to the production
 * collapse guard must mirror here.
 */
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore, type LineageNode, type LineageEdge } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useContainmentHierarchy } from '../useContainmentHierarchy'

const node = (id: string, type: string, pending?: 'create'): LineageNode => ({
  id, type: 'generic', position: { x: 0, y: 0 },
  data: { label: id, urn: id, type, ...(pending ? { isPending: pending } : {}) },
})
const edge = (id: string, source: string, target: string, pending?: 'create'): LineageEdge => ({
  id, source, target, data: { edgeType: 'CONTAINS', ...(pending ? { isPending: pending } : {}) },
})

const reset = (nodes: LineageNode[], edges: LineageEdge[]) => {
  useCanvasStore.setState({
    nodes, edges,
    _nodeIndex: new Set(nodes.map((n) => n.id)),
    _edgeIndex: new Set(edges.map((e) => e.id)),
  } as never)
  useStagedChangesStore.setState({ changes: [] })
}

const isContainmentEdge = (t: string) => t === 'CONTAINS'

const renderHierarchy = () =>
  renderHook(() => {
    const nodes = useCanvasStore((s) => s.nodes)
    const edges = useCanvasStore((s) => s.edges)
    return useContainmentHierarchy({ nodes, edges, isContainmentEdge })
  })

const rootIds = (result: { current: { rootNodes: LineageNode[] } }) =>
  result.current.rootNodes.map((n) => n.id).sort()

const storeNodeIds = () => useCanvasStore.getState().nodes.map((n) => n.id).sort()
const storeEdgeIds = () => useCanvasStore.getState().edges.map((e) => e.id).sort()

/**
 * Faithful mirror of ContextViewCanvas.toggleNode's browse-mode collapse
 * cleanup — the COARSE whole-subtree gate. If the subtree carries ANY unsaved
 * work, pruning is skipped and only the subtree's containment edges are dropped;
 * otherwise the whole subtree of descendant NODES is removed. `removeNodes:
 * false` forces the PRE-FIX behaviour (edges only) for the bug-demonstrating test.
 */
function collapseCleanup(
  nodeId: string,
  childMap: Map<string, string[]>,
  { removeNodes = true }: { removeNodes?: boolean } = {},
) {
  // 1. Enumerate descendants (NOT nodeId itself).
  const subtreeIds = new Set<string>()
  const stack = [nodeId]
  while (stack.length) {
    const id = stack.pop()!
    for (const cid of childMap.get(id) ?? []) {
      if (!subtreeIds.has(cid)) { subtreeIds.add(cid); stack.push(cid) }
    }
  }

  // 2. Coarse unsaved-work gate — mirrors the production guard's three checks:
  //    a pending NODE, a pending incident EDGE (reparent/move), or a staged
  //    property edit in stagedChangesStore targeting a subtree node.
  const { nodes, edges } = useCanvasStore.getState()
  const subtreeUrns = new Set<string>()
  let pendingNode = false
  for (const n of nodes) {
    if (!subtreeIds.has(n.id)) continue
    subtreeUrns.add((n.data?.urn as string | undefined) ?? n.id)
    if (n.data?.isPending) pendingNode = true
  }
  const pendingEdge = edges.some(
    (e) => !!e.data?.isPending && (subtreeIds.has(e.source) || subtreeIds.has(e.target)),
  )
  const stagedEdit = useStagedChangesStore.getState().changes.some(
    (c) => subtreeIds.has(c.targetId) || (c.targetUrn ? subtreeUrns.has(c.targetUrn) : false),
  )
  const hasUnsavedWork = pendingNode || pendingEdge || stagedEdit

  // 3. Prune the whole subtree of descendant NODES (atomic node + incident-edge
  //    removal) unless the caller forced edge-only mode (pre-fix) or the subtree
  //    carries unsaved work — then drop only edges (unsaved edges preserved).
  if (removeNodes && !hasUnsavedWork && subtreeIds.size > 0) {
    useCanvasStore.getState().removeNodes([...subtreeIds])
  } else {
    useCanvasStore.getState().removeEdgesByNodeIds(subtreeIds)
  }
}

describe('Context View collapse cleanup — orphaned saved descendants', () => {
  // abc(Layer) → 1(Object) → 11(Attribute) ; def(Layer) → 2(Object) → 22(Attribute)
  const seedTwoTrees = () => reset(
    [
      node('abc', 'Layer'), node('1', 'Object'), node('11', 'Attribute'),
      node('def', 'Layer'), node('2', 'Object'), node('22', 'Attribute'),
    ],
    [
      edge('abc-1', 'abc', '1'), edge('1-11', '1', '11'),
      edge('def-2', 'def', '2'), edge('2-22', '2', '22'),
    ],
  )

  beforeEach(() => reset([], []))

  it('initially yields exactly the two Layer nodes as roots', () => {
    seedTwoTrees()
    const { result } = renderHierarchy()
    expect(rootIds(result)).toEqual(['abc', 'def'])
  })

  it('WITHOUT node removal, collapse orphans descendants as spurious roots (the bug)', () => {
    seedTwoTrees()
    const { result } = renderHierarchy()
    const { childMap } = result.current

    act(() => collapseCleanup('abc', childMap, { removeNodes: false }))

    // Edges abc→1 and 1→11 are gone but nodes 1 and 11 remain → both become
    // parent-less roots, interleaving with abc/def. This is the scramble.
    expect(rootIds(result)).toEqual(['1', '11', 'abc', 'def'])
  })

  it('removes orphaned saved descendants so roots stay exactly [abc, def]', () => {
    seedTwoTrees()
    const { result } = renderHierarchy()
    const { childMap } = result.current

    act(() => collapseCleanup('abc', childMap))

    // 11 did NOT become a root; 1 and 11 are gone from the store entirely
    // (clean level-by-level refetch on re-expand). def's subtree untouched.
    expect(rootIds(result)).toEqual(['abc', 'def'])
    expect(storeNodeIds()).toEqual(['22', '2', 'abc', 'def'].sort())
  })

  it('preserves unsaved descendants and their saved ancestors (no work lost)', () => {
    // abc(saved) → 1(saved) → 11(pending create); the subtree carries unsaved
    // work so the coarse gate skips pruning entirely and only drops edges.
    reset(
      [node('abc', 'Layer'), node('1', 'Object'), node('11', 'Attribute', 'create')],
      [edge('abc-1', 'abc', '1'), edge('1-11', '1', '11')],
    )
    const { result } = renderHierarchy()
    const { childMap } = result.current

    act(() => collapseCleanup('abc', childMap))

    // Unsaved 11 stays, its containment edge survives (removeEdgesByNodeIds
    // preserves it because 11 is pending), and its saved ancestor 1 is NOT
    // removed either (the whole subtree is spared).
    expect(storeNodeIds()).toContain('11')
    expect(storeNodeIds()).toContain('1')
    expect(storeEdgeIds()).toContain('1-11')
  })

  it('preserves a reparented (moved) node whose pending marker is on the EDGE', () => {
    // Reparent 11 under 1: 11 is a pre-existing SAVED, markerless node; the
    // pending marker lives on the NEW containment edge 1→11 (mirrors
    // useReparentNode.restageContainment). The staged create_edge targets the
    // EDGE id, so only the pending-EDGE guard can catch this — NOT node.isPending.
    reset(
      [node('abc', 'Layer'), node('1', 'Object'), node('11', 'Attribute')],
      [edge('abc-1', 'abc', '1'), edge('1-11', '1', '11', 'create')],
    )
    useStagedChangesStore.setState({
      changes: [{
        id: 'sc1', type: 'create_edge', targetId: '1-11',
        after: { edgeType: 'CONTAINS', source: '1', target: '11' },
        summary: 'Move under 1', timestamp: 1,
      }],
    })
    const { result } = renderHierarchy()
    const { childMap } = result.current

    act(() => collapseCleanup('abc', childMap))

    // The moved node must NOT vanish: collapse falls back to edge-only cleanup,
    // and removeEdgesByNodeIds preserves the pending 1→11 edge.
    expect(storeNodeIds()).toContain('11')
    expect(storeEdgeIds()).toContain('1-11')
  })

  it('preserves a node with a staged rename that has NO canvas marker', () => {
    // abc(saved) → 1(saved) with an unsaved rename_entity staged against 1. The
    // node carries NO isPending overlay and there is no pending edge — only the
    // stagedChangesStore guard can catch this.
    reset(
      [node('abc', 'Layer'), node('1', 'Object')],
      [edge('abc-1', 'abc', '1')],
    )
    useStagedChangesStore.setState({
      changes: [{
        id: 'sc1', type: 'rename_entity', targetId: '1', targetUrn: '1',
        before: { label: '1' }, after: { label: 'Renamed' },
        summary: "Rename '1' → 'Renamed'", timestamp: 1,
      }],
    })
    const { result } = renderHierarchy()
    const { childMap } = result.current

    act(() => collapseCleanup('abc', childMap))

    // The renamed node must survive so its staged edit isn't lost on collapse.
    expect(storeNodeIds()).toContain('1')
  })
})
