/**
 * useReparentNode — drag-to-reparent validation + staging:
 *   • self-drop is a no-op;
 *   • an ontology-illegal nesting is blocked with a toast (no staged change);
 *   • a valid reparent stages a containment create_edge (parent→child) + success toast;
 *   • a cycle (dropping a node into its own descendant) is blocked.
 */
import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const showToast = vi.fn()

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

vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ showToast }) }))
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

describe('useReparentNode', () => {
  beforeEach(() => {
    showToast.mockClear(); resetStaged()
    useBranchStore.setState({ currentBranchId: 'br_1' } as never)   // default: on a draft
  })

  it('no-ops on a self drop', () => {
    setCanvas([node('S', 'system')])
    const { result } = renderHook(() => useReparentNode())
    result.current.reparent('S', 'S')
    expect(staged()).toHaveLength(0)
  })

  it('stages a containment create_edge for a valid nesting', () => {
    setCanvas([node('S', 'system'), node('D', 'dataset')])
    const { result } = renderHook(() => useReparentNode())
    result.current.reparent('D', 'S')   // nest dataset D under system S
    const ce = staged().find((c) => c.type === 'create_edge')
    expect(ce).toBeTruthy()
    expect((ce!.after as any).source).toBe('S')
    expect((ce!.after as any).target).toBe('D')
    expect((ce!.after as any).edgeType).toBe('CONTAINS')
    expect(showToast).toHaveBeenCalledWith('success', expect.any(String))
  })

  it('stages a valid nesting when the dragged node is a differently-cased (discovered graph) type', () => {
    // Discovered-graph nodes can carry a differently-cased type id (e.g. 'DATASET' vs the
    // ontology's 'dataset'); allowedChildTypeIds' Set is ontology-cased, so the membership
    // check against childType must be case-insensitive too.
    setCanvas([node('S', 'system'), node('D', 'DATASET')])
    const { result } = renderHook(() => useReparentNode())
    result.current.reparent('D', 'S')
    const ce = staged().find((c) => c.type === 'create_edge')
    expect(ce).toBeTruthy()
    expect(showToast).toHaveBeenCalledWith('success', expect.any(String))
  })

  it('blocks an ontology-illegal nesting with a toast', () => {
    setCanvas([node('S', 'system'), node('D', 'dataset')])
    const { result } = renderHook(() => useReparentNode())
    result.current.reparent('S', 'D')   // a dataset can't contain a system
    expect(staged()).toHaveLength(0)
    expect(showToast).toHaveBeenCalledWith('error', expect.stringContaining("can't contain"))
  })

  it('blocks un-nesting (moving from an existing parent) outside a draft', () => {
    useBranchStore.setState({ currentBranchId: null } as never)   // on main
    setCanvas(
      [node('S', 'system'), node('S2', 'system'), node('D', 'dataset')],
      [{ id: 'S2-D', source: 'S2', target: 'D', data: { edgeType: 'CONTAINS' } }],   // D currently under S2
    )
    const { result } = renderHook(() => useReparentNode())
    result.current.reparent('D', 'S')   // move D from S2 → S
    expect(staged().some((c) => c.type === 'create_edge')).toBe(false)
    expect(showToast).toHaveBeenCalledWith('info', expect.stringContaining('draft'))
  })

  it('allows un-nesting in a draft (stages delete of old + create of new)', () => {
    setCanvas(
      [node('S', 'system'), node('S2', 'system'), node('D', 'dataset')],
      [{ id: 'S2-D', source: 'S2', target: 'D', data: { edgeType: 'CONTAINS' } }],
    )
    const { result } = renderHook(() => useReparentNode())
    result.current.reparent('D', 'S')
    expect(staged().some((c) => c.type === 'delete_edge')).toBe(true)
    expect(staged().some((c) => c.type === 'create_edge')).toBe(true)
  })

  it('blocks a cycle (dropping a node into its own descendant)', () => {
    // S contains D (edge S→D). Dropping S onto D would nest the ancestor under its descendant.
    setCanvas(
      [node('S', 'system'), node('D', 'dataset')],
      [{ id: 'S-D', source: 'S', target: 'D', data: { edgeType: 'CONTAINS' } }],
    )
    const { result } = renderHook(() => useReparentNode())
    result.current.reparent('S', 'D')
    expect(staged().some((c) => c.type === 'create_edge')).toBe(false)
    expect(showToast).toHaveBeenCalledWith('error', expect.stringMatching(/descendant|contain/i))
  })

  it('retypeContainment switches the relationship (delete real old + create new, same parent)', () => {
    setCanvas(
      [node('S', 'system'), node('D', 'dataset')],
      [{ id: 'E0', source: 'S', target: 'D', data: { edgeType: 'CONTAINS' } }],   // real saved edge
    )
    const { result } = renderHook(() => useReparentNode())
    result.current.retypeContainment('D', 'HOLDS')
    const del = staged().find((c) => c.type === 'delete_edge')
    const create = staged().find((c) => c.type === 'create_edge')
    expect(del?.targetId).toBe('E0')                       // deletes the REAL old edge
    expect((create!.after as any).edgeType).toBe('HOLDS')
    expect((create!.after as any).source).toBe('S')        // same parent
  })

  it('collapses repeated retypes — never a temp-id delete, never a double parent', () => {
    setCanvas(
      [node('S', 'system'), node('D', 'dataset')],
      [{ id: 'E0', source: 'S', target: 'D', data: { edgeType: 'CONTAINS' } }],
    )
    const { result } = renderHook(() => useReparentNode())
    result.current.retypeContainment('D', 'HOLDS')     // E0(real) deleted + temp create(HOLDS)
    result.current.retypeContainment('D', 'CONTAINS')  // must collapse the temp create, not delete a temp id

    const deletes = staged().filter((c) => c.type === 'delete_edge')
    const creates = staged().filter((c) => c.type === 'create_edge')
    expect(deletes).toHaveLength(1)                     // only the ONE real edge delete
    expect(deletes[0].targetId).toBe('E0')             // a REAL id, never a temp 'staged-edge-…'
    expect(creates).toHaveLength(1)                     // exactly one surviving parent edge (no double parent)
    expect((creates[0].after as any).edgeType).toBe('CONTAINS')
  })
})
