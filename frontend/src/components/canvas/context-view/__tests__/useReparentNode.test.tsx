/**
 * useReparentNode — drag-to-reparent validation + staging:
 *   • self-drop is a no-op;
 *   • an ontology-illegal nesting is blocked with a notification (no staged change);
 *   • a valid reparent stages ONE `move_entity` (the server resolves the node's current parent) and
 *     shows it at once: every loaded parent link removed, the new one drawn as pending;
 *   • a cycle (dropping a node into its own descendant) is blocked.
 */
import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const notify = vi.fn()

// Ontology: a `system` may contain a `dataset` via CONTAINS (forward parent→child).
// `dataset` may only contain `column` (non-empty → restricted, so it canNOT contain a system).
const ENTITY_TYPES = [
  { id: 'system', name: 'System', hierarchy: { canContain: ['dataset'], canBeContainedBy: [] } },
  { id: 'dataset', name: 'Dataset', hierarchy: { canContain: ['column'], canBeContainedBy: ['system'] } },
  { id: 'column', name: 'Column', hierarchy: { canContain: [], canBeContainedBy: ['dataset'] } },
]
// Two valid containment types between system→dataset, so a dataset's relationship can be re-typed.
const REL_TYPES = [
  { id: 'CONTAINS', name: 'Contains', sourceTypes: ['system'], targetTypes: ['dataset'], isContainment: true },
  { id: 'HOLDS', name: 'Holds', sourceTypes: ['system'], targetTypes: ['dataset'], isContainment: true },
]

vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/store/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/store/schema')>()
  return {
    ...actual,
    useEntityTypes: () => ENTITY_TYPES,
    useRootEntityTypes: () => ['system'],
    useEntityTypeHierarchyMap: () => ({ system: { canContain: ['dataset'] }, dataset: { canContain: ['column'] }, column: { canContain: [] } }),
    useRelationshipTypes: () => REL_TYPES,
    useContainmentEdgeTypes: () => ['CONTAINS', 'HOLDS'],
  }
})

import { useReparentNode } from '../useReparentNode'
import { useCanvasStore } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useBranchStore } from '@/store/branchStore'

const node = (id: string, type: string) => ({ id, type: 'generic', position: { x: 0, y: 0 }, data: { label: id, urn: id, type } })
const setCanvas = (nodes: unknown[], edges: unknown[] = []) =>
  useCanvasStore.setState({ nodes, edges, _nodeIndex: new Set(nodes.map((n: any) => n.id)), _edgeIndex: new Set(edges.map((e: any) => e.id)) } as never)
const resetStaged = () => useStagedChangesStore.setState({ changes: [], redoStack: [], _scopeKey: null, _byScope: {} })
const staged = () => useStagedChangesStore.getState().changes
const moves = () => staged().filter((c) => c.type === 'move_entity')
const parentLinks = (child: string) => useCanvasStore.getState().edges.filter((e) => e.target === child)

describe('useReparentNode — a drop on a layer COLUMN follows the ontology', () => {
  beforeEach(() => {
    notify.mockClear(); resetStaged()
    useBranchStore.setState({ currentBranchId: 'br_1' } as never)
  })
  const layer3 = { id: 'L3', name: 'Layer 3' }

  it('refuses to leave a non-top-level type without a parent, and says where it can go', () => {
    setCanvas([node('S', 'system'), node('D', 'dataset')],
      [{ id: 'S-D', source: 'S', target: 'D', data: { edgeType: 'CONTAINS' } }])
    const { result } = renderHook(() => useReparentNode())
    expect(result.current.moveToColumn('D', layer3)).toBe(true)          // handled: refused
    expect(staged()).toHaveLength(0)
    expect(notify).toHaveBeenCalledWith('error', expect.stringMatching(/can't be at the top level.*System.*Layer 3/))
    expect(parentLinks('D').map((e) => e.id)).toEqual(['S-D'])          // untouched
  })

  it('moves a top-level type out of its parent to the top level of the column', () => {
    // a `system` may be top-level (root type); here one sits inside another system's CONTAINS
    setCanvas([node('S', 'system'), node('S2', 'system')],
      [{ id: 'S-S2', source: 'S', target: 'S2', data: { edgeType: 'CONTAINS' } }])
    const { result } = renderHook(() => useReparentNode())
    expect(result.current.moveToColumn('S2', layer3)).toBe(true)
    expect(moves()).toHaveLength(1)
    const m = moves()[0].after as any
    expect([m.parentId, m.edgeId, m.layerId]).toEqual([null, null, 'L3'])
    expect(parentLinks('S2')).toHaveLength(0)
    expect(moves()[0].summary).toMatch(/to the top level of Layer 3/)
  })

  it('leaves a top-level entity to the ordinary column placement', () => {
    setCanvas([node('S', 'system')])
    const { result } = renderHook(() => useReparentNode())
    expect(result.current.moveToColumn('S', layer3)).toBe(false)
    expect(staged()).toHaveLength(0)
  })
})

describe('useReparentNode', () => {
  beforeEach(() => {
    notify.mockClear(); resetStaged()
    useBranchStore.setState({ currentBranchId: 'br_1' } as never)   // default: on a draft
  })

  it('no-ops on a self drop', () => {
    setCanvas([node('S', 'system')])
    const { result } = renderHook(() => useReparentNode())
    result.current.reparent('S', 'S')
    expect(staged()).toHaveLength(0)
  })

  it('stages ONE move for a valid nesting and shows the new parent link', () => {
    setCanvas([node('S', 'system'), node('D', 'dataset')])
    const { result } = renderHook(() => useReparentNode())
    result.current.reparent('D', 'S')   // nest dataset D under system S
    expect(moves()).toHaveLength(1)
    expect(staged()).toHaveLength(1)
    const m = moves()[0].after as any
    expect([m.childId, m.parentId, m.edgeType]).toEqual(['D', 'S', 'CONTAINS'])
    expect(parentLinks('D').map((e) => [e.source, e.data?.isPending])).toEqual([['S', 'create']])
    expect(notify).toHaveBeenCalledWith('success', expect.any(String))
  })

  it('moves a node whose current parent link the canvas never loaded — the server resolves it', () => {
    // D sits under S2 on the server, but that link is not on this canvas. A move is still exactly
    // one `move`; the backend deletes whatever parent link D actually has (the double-parent bug).
    setCanvas([node('S', 'system'), node('D', 'dataset')])
    const { result } = renderHook(() => useReparentNode())
    result.current.reparent('D', 'S')
    expect(moves()).toHaveLength(1)
    expect(staged().some((c) => c.type === 'delete_edge' || c.type === 'create_edge')).toBe(false)
  })

  it('stages a valid nesting when the dragged node is a differently-cased (discovered graph) type', () => {
    // Discovered-graph nodes can carry a differently-cased type id (e.g. 'DATASET' vs the
    // ontology's 'dataset'); allowedChildTypeIds' Set is ontology-cased, so the membership
    // check against childType must be case-insensitive too.
    setCanvas([node('S', 'system'), node('D', 'DATASET')])
    const { result } = renderHook(() => useReparentNode())
    result.current.reparent('D', 'S')
    expect(moves()).toHaveLength(1)
    expect(notify).toHaveBeenCalledWith('success', expect.any(String))
  })

  it('blocks an ontology-illegal nesting with a notification', () => {
    setCanvas([node('S', 'system'), node('D', 'dataset')])
    const { result } = renderHook(() => useReparentNode())
    result.current.reparent('S', 'D')   // a dataset can't contain a system
    expect(staged()).toHaveLength(0)
    expect(notify).toHaveBeenCalledWith('error', expect.stringContaining("can't contain"))
  })

  it('blocks a move outside a draft (a move is a draft-save op)', () => {
    useBranchStore.setState({ currentBranchId: null } as never)   // on main
    setCanvas(
      [node('S', 'system'), node('S2', 'system'), node('D', 'dataset')],
      [{ id: 'S2-D', source: 'S2', target: 'D', data: { edgeType: 'CONTAINS' } }],   // D currently under S2
    )
    const { result } = renderHook(() => useReparentNode())
    result.current.reparent('D', 'S')   // move D from S2 → S
    expect(staged()).toHaveLength(0)
    expect(notify).toHaveBeenCalledWith('info', expect.stringContaining('draft'))
  })

  it('moves in a draft: the old link leaves the canvas, and discard brings it back', () => {
    const old = { id: 'S2-D', source: 'S2', target: 'D', data: { edgeType: 'CONTAINS' } }
    setCanvas([node('S', 'system'), node('S2', 'system'), node('D', 'dataset')], [old])
    const { result } = renderHook(() => useReparentNode())
    result.current.reparent('D', 'S')
    expect(moves()).toHaveLength(1)
    expect(parentLinks('D').map((e) => e.source)).toEqual(['S'])          // never two parents
    useStagedChangesStore.getState().discard(moves()[0].id)
    expect(parentLinks('D').map((e) => e.id)).toEqual(['S2-D'])           // back where it was
  })

  it('blocks a cycle (dropping a node into its own descendant)', () => {
    // S contains D (edge S→D). Dropping S onto D would nest the ancestor under its descendant.
    setCanvas(
      [node('S', 'system'), node('D', 'dataset')],
      [{ id: 'S-D', source: 'S', target: 'D', data: { edgeType: 'CONTAINS' } }],
    )
    const { result } = renderHook(() => useReparentNode())
    result.current.reparent('S', 'D')
    expect(staged()).toHaveLength(0)
    expect(notify).toHaveBeenCalledWith('error', expect.stringMatching(/descendant|contain/i))
  })

  it('retypeContainment switches the relationship (delete real old + create new, same parent)', () => {
    setCanvas(
      [node('S', 'system'), node('D', 'dataset')],
      [{ id: 'E0', source: 'S', target: 'D', data: { edgeType: 'CONTAINS' } }],   // real saved edge
    )
    const { result } = renderHook(() => useReparentNode())
    result.current.retypeContainment('D', 'HOLDS')
    expect(moves()).toHaveLength(1)
    const m = moves()[0].after as any
    expect([m.parentId, m.edgeType]).toEqual(['S', 'HOLDS'])           // same parent, new type
    expect(parentLinks('D').map((e) => e.data?.edgeType)).toEqual(['HOLDS'])
  })

  it('collapses repeated retypes — never a temp-id delete, never a double parent', () => {
    setCanvas(
      [node('S', 'system'), node('D', 'dataset')],
      [{ id: 'E0', source: 'S', target: 'D', data: { edgeType: 'CONTAINS' } }],
    )
    const { result } = renderHook(() => useReparentNode())
    result.current.retypeContainment('D', 'HOLDS')     // E0(real) deleted + temp create(HOLDS)
    result.current.retypeContainment('D', 'CONTAINS')  // must collapse the temp create, not delete a temp id

    expect(staged()).toHaveLength(1)                    // one move, the latest intent
    expect((moves()[0].after as any).edgeType).toBe('CONTAINS')
    expect(parentLinks('D')).toHaveLength(1)            // exactly one parent link on the canvas
    useStagedChangesStore.getState().discard(moves()[0].id)
    expect(parentLinks('D').map((e) => e.id)).toEqual(['E0'])   // discard restores the ORIGINAL
  })
})
