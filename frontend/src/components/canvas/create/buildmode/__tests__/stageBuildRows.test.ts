/**
 * stageBuildRows — O(n) batch staging.
 *
 * (a) `planBuildStaging` is pure: a 3-level BuildRow[] (domain -> platform ->
 *     dataset) must thread each child's containment edge to its PARENT's temp
 *     urn (from the returned `rowUrn` map), not a re-derived/guessed urn.
 * (b) `stageMany` (stagedChangesStore) batches N changes into ONE state
 *     update: `changes.length === N` after a single call.
 * (c) `useStageBuildRows` commits the whole plan with exactly one
 *     `addNodes`/`addEdges`/`stageMany` call (the O(n) win over per-row
 *     staging) and fires `onRowStaged` once per row.
 */
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCanvasStore } from '@/store/canvas'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'
import { makeRow, type BuildRow } from '../buildRow'

vi.mock('@/hooks/useViewSchema', () => ({
  useViewRelationshipTypes: () => [
    { id: 'CONTAINS', name: 'CONTAINS', sourceTypes: [], targetTypes: [], isContainment: true },
  ],
  useViewContainmentEdgeTypes: () => ['CONTAINS'],
}))
vi.mock('@/features/versioning/model/ensureDraftOpen', () => ({
  ensureDraftOpen: async () => 'branch-1',
}))

import { planBuildStaging, useStageBuildRows } from '../stageBuildRows'

const resetStores = () => {
  useCanvasStore.setState({ nodes: [], edges: [], _nodeIndex: new Set(), _edgeIndex: new Set() } as never)
  useStagedChangesStore.setState({ changes: [] } as never)
}

// domain(d1, root) -> platform(p1) -> dataset(ds1)
const threeLevelRows = (): BuildRow[] => [
  { ...makeRow({ id: 'd1', name: 'Domain', typeId: 'domain', parentId: null }), depth: 0 },
  { ...makeRow({ id: 'p1', name: 'Platform', typeId: 'platform', parentId: 'd1' }), depth: 1 },
  { ...makeRow({ id: 'ds1', name: 'Dataset', typeId: 'dataset', parentId: 'p1' }), depth: 2 },
]

describe('planBuildStaging', () => {
  beforeEach(resetStores)

  const containmentEdgeTypeFor = () => 'CONTAINS'

  it('stages a 3-level tree: 3 nodes, 2 containment edges threaded to the PARENT temp urn, 3 create_entity changes, distinct rowUrn per row', () => {
    const rows = threeLevelRows()
    const plan = planBuildStaging(rows, { rootParentUrn: null, containmentEdgeTypeFor })

    expect(plan.nodes).toHaveLength(3)
    expect(plan.edges).toHaveLength(2)
    expect(plan.changes).toHaveLength(3)

    // Distinct temp urn per row, each in the urn:staged:<type>:<id> shape.
    expect(plan.rowUrn.size).toBe(3)
    const urns = [...plan.rowUrn.values()]
    expect(new Set(urns).size).toBe(3)
    expect(plan.rowUrn.get('d1')).toMatch(/^urn:staged:domain:/)
    expect(plan.rowUrn.get('p1')).toMatch(/^urn:staged:platform:/)
    expect(plan.rowUrn.get('ds1')).toMatch(/^urn:staged:dataset:/)

    // Nodes: id/urn === the row's temp urn, optimistic.
    const nodeByUrn = new Map(plan.nodes.map((n) => [n.id, n]))
    expect(nodeByUrn.get(plan.rowUrn.get('d1')!)?.data.isPending).toBe('create')
    expect(nodeByUrn.get(plan.rowUrn.get('p1')!)?.data.label).toBe('Platform')
    expect(nodeByUrn.get(plan.rowUrn.get('ds1')!)?.data.type).toBe('dataset')

    // Edges: child -> reference the PARENT's temp urn (threading), not a
    // fresh/guessed one — this is the O(n) parent resolution under test.
    const platformEdge = plan.edges.find((e) => e.target === plan.rowUrn.get('p1'))
    expect(platformEdge?.source).toBe(plan.rowUrn.get('d1'))
    expect(platformEdge?.type).toBe('containment')

    const datasetEdge = plan.edges.find((e) => e.target === plan.rowUrn.get('ds1'))
    expect(datasetEdge?.source).toBe(plan.rowUrn.get('p1'))

    // Changes: create_entity, targetUrn === rowUrn, after.parentUrn threaded.
    const changeByUrn = new Map(plan.changes.map((c) => [c.targetUrn, c]))
    expect(plan.changes.every((c) => c.type === 'create_entity')).toBe(true)
    const domainChange = changeByUrn.get(plan.rowUrn.get('d1')!)!
    const platformChange = changeByUrn.get(plan.rowUrn.get('p1')!)!
    const datasetChange = changeByUrn.get(plan.rowUrn.get('ds1')!)!
    expect((domainChange.after as { parentUrn?: string }).parentUrn).toBeUndefined()
    expect((platformChange.after as { parentUrn?: string }).parentUrn).toBe(plan.rowUrn.get('d1'))
    expect((datasetChange.after as { parentUrn?: string }).parentUrn).toBe(plan.rowUrn.get('p1'))
  })

  it('attaches a batch-root row to an external rootParentUrn when provided', () => {
    const rows = threeLevelRows()
    const plan = planBuildStaging(rows, { rootParentUrn: 'urn:real:existing-parent', containmentEdgeTypeFor })

    expect(plan.edges).toHaveLength(3) // 2 internal + 1 to the external root
    const rootEdge = plan.edges.find((e) => e.target === plan.rowUrn.get('d1'))
    expect(rootEdge?.source).toBe('urn:real:existing-parent')
  })
})

describe('stageMany', () => {
  beforeEach(resetStores)

  const change = (id: string): StagedChange => ({
    id,
    type: 'create_entity',
    targetId: id,
    after: {},
    summary: `Create ${id}`,
    timestamp: Date.now(),
  })

  it('stages N changes in a single batched update: changes.length === N', () => {
    const batch = [change('c1'), change('c2'), change('c3')]
    let renderCount = 0
    const unsub = useStagedChangesStore.subscribe(() => {
      renderCount++
    })

    useStagedChangesStore.getState().stageMany(batch)

    unsub()
    expect(useStagedChangesStore.getState().changes).toHaveLength(3)
    expect(renderCount).toBe(1) // one set() call, not one per change
  })
})

describe('useStageBuildRows', () => {
  beforeEach(resetStores)

  it('commits the whole plan with ONE addNodes + ONE addEdges + ONE stageMany, firing onRowStaged per row', async () => {
    // Count store notifications rather than spying on the action methods
    // directly (zustand rebuilds the state object on every `set`, so a
    // subscribe-count is the reliable way to prove "one batched update" per
    // store — one canvas notification each for addNodes/addEdges, one
    // stagedChanges notification for stageMany).
    let canvasNotifications = 0
    let stagedNotifications = 0
    const unsubCanvas = useCanvasStore.subscribe(() => {
      canvasNotifications++
    })
    const unsubStaged = useStagedChangesStore.subscribe(() => {
      stagedNotifications++
    })

    const { result } = renderHook(() => useStageBuildRows())
    const rows = threeLevelRows()
    const calls: Array<[string, string]> = []

    let rowUrn: Map<string, string> = new Map()
    await act(async () => {
      rowUrn = await result.current.stageBuildRows(rows, {
        rootParentUrn: null,
        onRowStaged: (rowId, urn) => calls.push([rowId, urn]),
      })
    })

    unsubCanvas()
    unsubStaged()

    expect(canvasNotifications).toBe(2) // ONE addNodes + ONE addEdges
    expect(stagedNotifications).toBe(1) // ONE stageMany

    expect(useCanvasStore.getState().nodes).toHaveLength(3)
    expect(useStagedChangesStore.getState().changes).toHaveLength(3)

    expect(calls).toHaveLength(3)
    expect(rowUrn.size).toBe(3)
    expect(calls.find(([rowId]) => rowId === 'd1')?.[1]).toBe(rowUrn.get('d1'))
  })
})
