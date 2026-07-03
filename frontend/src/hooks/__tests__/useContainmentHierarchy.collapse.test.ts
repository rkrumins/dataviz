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
 * browse-mode collapse branch. It composes the REAL store actions
 * (`removeEdgesByNodeIds`, `removeNodes`) and the REAL `useContainmentHierarchy`
 * root computation. Any change to the production collapse branch must mirror here.
 */
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore, type LineageNode, type LineageEdge } from '@/store/canvas'
import { useContainmentHierarchy } from '../useContainmentHierarchy'

const node = (id: string, type: string, pending?: 'create'): LineageNode => ({
  id, type: 'generic', position: { x: 0, y: 0 },
  data: { label: id, urn: id, type, ...(pending ? { isPending: pending } : {}) },
})
const edge = (id: string, source: string, target: string): LineageEdge => ({
  id, source, target, data: { edgeType: 'CONTAINS' },
})

const reset = (nodes: LineageNode[], edges: LineageEdge[]) =>
  useCanvasStore.setState({
    nodes, edges,
    _nodeIndex: new Set(nodes.map((n) => n.id)),
    _edgeIndex: new Set(edges.map((e) => e.id)),
  } as never)

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
 * cleanup. `removeNodes: false` reproduces the PRE-FIX behaviour (edges only).
 */
function collapseCleanup(
  nodeId: string,
  childMap: Map<string, string[]>,
  parentMap: Map<string, string>,
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
  // 2. Drop the subtree's containment edges (browse mode → no preserve set).
  useCanvasStore.getState().removeEdgesByNodeIds(subtreeIds)
  if (!removeNodes || subtreeIds.size === 0) return

  // 3. Remove the now edge-less descendant NODES, but never unsaved work.
  const pendingIds = new Set<string>()
  for (const n of useCanvasStore.getState().nodes) {
    if (n.data?.isPending === 'create') pendingIds.add(n.id)
  }
  const keep = new Set<string>()
  for (const id of subtreeIds) {
    if (!pendingIds.has(id)) continue
    let cur: string | undefined = id
    while (cur && subtreeIds.has(cur) && !keep.has(cur)) {
      keep.add(cur)
      cur = parentMap.get(cur)
    }
  }
  const removable = [...subtreeIds].filter((id) => !keep.has(id))
  if (removable.length) useCanvasStore.getState().removeNodes(removable)
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
    const { childMap, parentMap } = result.current

    act(() => collapseCleanup('abc', childMap, parentMap, { removeNodes: false }))

    // Edges abc→1 and 1→11 are gone but nodes 1 and 11 remain → both become
    // parent-less roots, interleaving with abc/def. This is the scramble.
    expect(rootIds(result)).toEqual(['1', '11', 'abc', 'def'])
  })

  it('removes orphaned saved descendants so roots stay exactly [abc, def]', () => {
    seedTwoTrees()
    const { result } = renderHierarchy()
    const { childMap, parentMap } = result.current

    act(() => collapseCleanup('abc', childMap, parentMap))

    // 11 did NOT become a root; 1 and 11 are gone from the store entirely
    // (clean level-by-level refetch on re-expand). def's subtree untouched.
    expect(rootIds(result)).toEqual(['abc', 'def'])
    expect(storeNodeIds()).toEqual(['22', '2', 'abc', 'def'].sort())
  })

  it('preserves unsaved descendants and their saved ancestors (no work lost)', () => {
    // abc(saved) → 1(saved) → 11(pending create); 11's containment edge is
    // preserved by removeEdgesByNodeIds because 11 is pending.
    reset(
      [node('abc', 'Layer'), node('1', 'Object'), node('11', 'Attribute', 'create')],
      [edge('abc-1', 'abc', '1'), edge('1-11', '1', '11')],
    )
    const { result } = renderHierarchy()
    const { childMap, parentMap } = result.current

    act(() => collapseCleanup('abc', childMap, parentMap))

    // Unsaved 11 stays, its containment edge survives, and its saved ancestor 1
    // is NOT removed (removing it would dangle the preserved pending edge).
    expect(storeNodeIds()).toContain('11')
    expect(storeNodeIds()).toContain('1')
    expect(storeEdgeIds()).toContain('1-11')
  })
})
