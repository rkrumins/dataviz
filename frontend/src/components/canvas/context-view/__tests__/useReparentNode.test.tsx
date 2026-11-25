/**
 * useReparentNode — drag-to-reparent validation + staging:
 *   • self-drop is a no-op;
 *   • an ontology-illegal nesting is blocked with a notification (no staged change);
 *   • a valid reparent stages ONE `move_entity` (the server resolves the node's current parent) and
 *     shows it at once: every loaded parent link removed, the new one drawn as pending;
 *   • a cycle (dropping a node into its own descendant) is blocked.
 */
import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
import { useStageEntityCreation } from '@/components/canvas/create/useStageEntityCreation'
import type { NormalizedReferenceLayout } from '@/utils/referenceLayout'

const node = (id: string, type: string) => ({ id, type: 'generic', position: { x: 0, y: 0 }, data: { label: id, urn: id, type } })
const setCanvas = (nodes: unknown[], edges: unknown[] = []) =>
  useCanvasStore.setState({ nodes, edges, _nodeIndex: new Set(nodes.map((n: any) => n.id)), _edgeIndex: new Set(edges.map((e: any) => e.id)) } as never)
const resetStaged = () => useStagedChangesStore.setState({ changes: [], redoStack: [], _scopeKey: null, _byScope: {} })
const staged = () => useStagedChangesStore.getState().changes
const moves = () => staged().filter((c) => c.type === 'move_entity')
const parentLinks = (child: string) => useCanvasStore.getState().edges.filter((e) => e.target === child)

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

describe('useReparentNode — returning a PLACED entity to its parent (view only)', () => {
  // D sits inside S in the data; the view places it in another column (a layout pin).
  let layout: any
  let unregister: () => void
  beforeEach(async () => {
    notify.mockClear(); resetStaged()
    useBranchStore.setState({ currentBranchId: 'br_1' } as never)
    layout = { layers: [{ id: 'L1', name: 'L1' }, { id: 'L3', name: 'Layer 3' }], assignments: { D: { layerId: 'L3' } } }
    const { registerLayoutWriter } = await import('@/store/canvasLayoutBridge')
    unregister = registerLayoutWriter({ current: () => layout, persist: (next) => { layout = next } })
    setCanvas([node('S', 'system'), node('D', 'dataset')],
      [{ id: 'S-D', source: 'S', target: 'D', data: { edgeType: 'CONTAINS' } }])
  })
  afterEach(() => unregister())

  it('dropping it onto its own parent removes the placement — a layout change, undoable', () => {
    const { result } = renderHook(() => useReparentNode())
    result.current.reparent('D', 'S')
    expect(layout.assignments.D).toBeUndefined()                  // back under its parent
    expect(staged().map((c) => c.type)).toEqual(['assign_layer'])  // listed for review, no data op
    expect(parentLinks('D').map((e) => e.id)).toEqual(['S-D'])     // the data link is untouched
    useStagedChangesStore.getState().discard(staged()[0].id)
    expect(layout.assignments.D).toEqual({ layerId: 'L3' })        // undo restores the placement
  })

  it('a placement made in this session is simply cancelled', () => {
    const before = layout
    useStagedChangesStore.getState().stage({
      type: 'assign_layer', targetId: 'D', after: { layerId: 'L3' }, summary: 'place',
      discard: () => { layout = { ...before, assignments: {} } },
    })
    const { result } = renderHook(() => useReparentNode())
    expect(result.current.returnToParent('D', 'S')).toBe(true)
    expect(staged()).toHaveLength(0)
    expect(layout.assignments.D).toBeUndefined()
  })

  it('does nothing for an entity that is not placed', () => {
    layout = { ...layout, assignments: {} }
    const { result } = renderHook(() => useReparentNode())
    expect(result.current.returnToParent('D', 'S')).toBe(false)
    expect(staged()).toHaveLength(0)
  })
})

describe('useReparentNode — where a moved entity is shown, and what moves with it', () => {
  // S1 ⊃ D; S2 empty. Columns: `systems` holds systems, `datasets` holds datasets, `other` holds none.
  let layout: NormalizedReferenceLayout
  let unregister: () => void
  const nodeWith = (id: string, type: string, childCount?: number) =>
    ({ ...node(id, type), data: { ...node(id, type).data, ...(childCount != null ? { childCount } : {}) } })
  const count = (id: string) => useCanvasStore.getState().nodes.find((n) => n.id === id)?.data?.childCount
  beforeEach(async () => {
    notify.mockClear(); resetStaged()
    useBranchStore.setState({ currentBranchId: 'br_1' } as never)
    layout = {
      layers: [
        { id: 'systems', name: 'Systems', order: 0, entityTypes: ['system'] },
        { id: 'datasets', name: 'Datasets', order: 1, entityTypes: ['dataset'] },
        { id: 'other', name: 'Other', order: 2, entityTypes: [] },
      ],
      assignments: {},
    }
    const { registerLayoutWriter } = await import('@/store/canvasLayoutBridge')
    unregister = registerLayoutWriter({ current: () => layout, persist: (next) => { layout = next } })
    setCanvas([nodeWith('S1', 'system', 1), nodeWith('S2', 'system', 0), node('D', 'dataset')],
      [{ id: 'S1-D', source: 'S1', target: 'D', data: { edgeType: 'CONTAINS' } }])
  })
  afterEach(() => unregister())

  it('keeps a placement in a column that holds its type — the column it was put in by hand', () => {
    layout.assignments.D = { layerId: 'datasets', inheritsChildren: true }
    const { result } = renderHook(() => useReparentNode())
    result.current.reparent('D', 'S2')
    expect(layout.assignments.D).toEqual({ layerId: 'datasets', inheritsChildren: true })
    expect(notify).toHaveBeenCalledWith('success', 'Moved under S2. It stays in Datasets, the column that holds its type.')
  })

  it('clears any other placement, so the entity follows its new parent', () => {
    layout.assignments.D = { layerId: 'other', inheritsChildren: true }
    const { result } = renderHook(() => useReparentNode())
    result.current.reparent('D', 'S2')
    expect(layout.assignments.D).toBeUndefined()
  })

  it('moves the child counts with it, and discard puts them back', () => {
    const { result } = renderHook(() => useReparentNode())
    result.current.reparent('D', 'S2')
    expect([count('S1'), count('S2')]).toEqual([0, 1])
    useStagedChangesStore.getState().discard(moves()[0].id)
    expect([count('S1'), count('S2')]).toEqual([1, 0])
  })

  it('undoing a re-move steps the counts back one move at a time', () => {
    setCanvas([nodeWith('S1', 'system', 1), nodeWith('S2', 'system', 0), nodeWith('S3', 'system', 0), node('D', 'dataset')],
      [{ id: 'S1-D', source: 'S1', target: 'D', data: { edgeType: 'CONTAINS' } }])
    const { result } = renderHook(() => useReparentNode())
    result.current.reparent('D', 'S2')
    result.current.reparent('D', 'S3')
    expect(moves()).toHaveLength(1)
    expect([count('S1'), count('S2'), count('S3')]).toEqual([0, 0, 1])
    useStagedChangesStore.getState().undo()
    expect([count('S1'), count('S2'), count('S3')]).toEqual([0, 1, 0])
    expect(parentLinks('D').map((e) => e.source)).toEqual(['S2'])
    useStagedChangesStore.getState().undo()
    expect([count('S1'), count('S2'), count('S3')]).toEqual([1, 0, 0])
    expect(parentLinks('D').map((e) => e.id)).toEqual(['S1-D'])
  })

  it('discarding a move puts back only its own placement — a layout edit made since stays', () => {
    layout.assignments.D = { layerId: 'other', inheritsChildren: true }
    const { result } = renderHook(() => useReparentNode())
    result.current.reparent('D', 'S2')
    expect(layout.assignments.D).toBeUndefined()
    // A later, unrelated layout edit.
    layout = { ...layout, assignments: { ...layout.assignments, S2: { layerId: 'systems', inheritsChildren: true } } }
    useStagedChangesStore.getState().discard(moves()[0].id)
    expect(layout.assignments.D).toEqual({ layerId: 'other', inheritsChildren: true })
    expect(layout.assignments.S2).toEqual({ layerId: 'systems', inheritsChildren: true })
  })

  it('to the top level only where its type may stand alone, and not when it is there already', () => {
    const { result } = renderHook(() => useReparentNode())
    expect(result.current.topLevelVerdict('D')).toEqual({ kind: 'blocked', hint: 'A Dataset needs a parent', message: "A dataset can't stand on its own — it needs a parent.", tone: 'error' })
    expect(result.current.topLevelVerdict('S2')).toEqual({ kind: 'none' })
  })

  it('to the top level: one move with no parent, shown in the column that holds its type', () => {
    // A system (one of the ontology's roots) that sits inside another.
    setCanvas([nodeWith('S1', 'system', 1), node('S9', 'system')],
      [{ id: 'S1-S9', source: 'S1', target: 'S9', data: { edgeType: 'CONTAINS' } }])
    const { result } = renderHook(() => useReparentNode())
    expect(result.current.topLevelVerdict('S9')).toEqual({ kind: 'data', edgeType: null })
    result.current.moveToTopLevel('S9')
    expect(moves()).toHaveLength(1)
    expect(moves()[0].after).toMatchObject({ childId: 'S9', parentId: null, edgeId: null, edgeType: null })
    expect(moves()[0].summary).toBe("Move 'S9' from 'S1' to the top level")
    expect(parentLinks('S9')).toHaveLength(0)
    expect(count('S1')).toBe(0)
    expect(layout.assignments.S9).toMatchObject({ layerId: 'systems' })
    expect(notify).toHaveBeenCalledWith('success', 'Moved to the top level, shown in Systems.')
    useStagedChangesStore.getState().discard(moves()[0].id)
    expect(parentLinks('S9').map((e) => e.id)).toEqual(['S1-S9'])
    expect(layout.assignments.S9).toBeUndefined()
    expect(count('S1')).toBe(1)
  })
})

describe('useReparentNode — the canvas\'s gates', () => {
  let unregister: () => void
  beforeEach(() => {
    notify.mockClear(); resetStaged()
    useBranchStore.setState({ currentBranchId: 'br_1' } as never)
    setCanvas([node('S', 'system'), node('D', 'dataset')])
  })
  afterEach(() => unregister?.())

  it('a move the canvas refuses is said, and nothing is staged', async () => {
    const { registerMoveHost } = await import('@/store/canvasLayoutBridge')
    unregister = registerMoveHost({
      blocked: () => ({ hint: 'A trace is read-only', message: 'A trace is read-only — leave it to move an entity to a different parent.' }),
      columnOf: () => undefined, isDrawn: () => true, moved: vi.fn(),
    })
    const { result } = renderHook(() => useReparentNode())
    expect(result.current.verdict('D', 'S')).toMatchObject({ kind: 'blocked', hint: 'A trace is read-only' })
    result.current.reparent('D', 'S')
    expect(staged()).toHaveLength(0)
    expect(notify).toHaveBeenCalledWith('info', 'A trace is read-only — leave it to move an entity to a different parent.')
  })

  it('a move it takes opens the new parent', async () => {
    const moved = vi.fn()
    const { registerMoveHost } = await import('@/store/canvasLayoutBridge')
    unregister = registerMoveHost({ blocked: () => null, columnOf: () => undefined, isDrawn: () => true, moved })
    const { result } = renderHook(() => useReparentNode())
    expect(result.current.verdict('D', 'S')).toEqual({ kind: 'data', edgeType: 'CONTAINS' })
    result.current.reparent('D', 'S')
    expect(moved).toHaveBeenCalledWith('D', 'S')
  })
})

describe('useReparentNode — an entity created in this draft', () => {
  const both = () => renderHook(() => ({ move: useReparentNode(), create: useStageEntityCreation() }))
  const creates = () => staged().filter((c) => c.type === 'create_entity')
  beforeEach(() => {
    notify.mockClear(); resetStaged()
    useBranchStore.setState({ currentBranchId: 'br_1' } as never)
    setCanvas([node('S1', 'system'), node('S2', 'system')])
  })

  it('moves by pointing its create at the new parent — no move staged, one pending link', () => {
    const { result } = both()
    const temp = result.current.create.stageEntity({ entityType: 'dataset', displayName: 'New', parentUrn: 'S1', containmentEdgeType: 'CONTAINS' })
    result.current.move.reparent(temp, 'S2')
    expect(moves()).toHaveLength(0)
    expect(creates()).toHaveLength(1)
    expect(creates()[0].after).toMatchObject({ parentUrn: 'S2', containmentEdgeType: 'CONTAINS', parentLabel: 'S2' })
    expect(creates()[0].summary).toBe("Create dataset: 'New' · CONTAINS S2")
    expect(parentLinks(temp).map((e) => [e.id, e.source, e.data?.isPending])).toEqual([[`contains-S2-${temp}`, 'S2', 'create']])
  })

  it('Undo points it back under its first parent; discarding it still removes it', () => {
    const { result } = both()
    const temp = result.current.create.stageEntity({ entityType: 'dataset', displayName: 'New', parentUrn: 'S1', containmentEdgeType: 'CONTAINS' })
    result.current.move.reparent(temp, 'S2')
    useStagedChangesStore.getState().undo()
    expect(creates()[0].after).toMatchObject({ parentUrn: 'S1' })
    expect(parentLinks(temp).map((e) => e.source)).toEqual(['S1'])
    useStagedChangesStore.getState().redo()
    expect(parentLinks(temp).map((e) => e.source)).toEqual(['S2'])
    useStagedChangesStore.getState().discard(creates()[0].id)
    expect(staged()).toHaveLength(0)
    expect(useCanvasStore.getState().nodes.some((n) => n.id === temp)).toBe(false)
    expect(parentLinks(temp)).toHaveLength(0)
  })

  it('to the top level: its create loses its parent, and no link is left', () => {
    const { result } = both()
    const temp = result.current.create.stageEntity({ entityType: 'system', displayName: 'Inner', parentUrn: 'S1', containmentEdgeType: 'CONTAINS' })
    result.current.move.moveToTopLevel(temp)
    expect(moves()).toHaveLength(0)
    expect(creates()[0].after).toMatchObject({ parentUrn: undefined, containmentEdgeType: undefined })
    expect(creates()[0].summary).toBe("Create system: 'Inner'")
    expect(parentLinks(temp)).toHaveLength(0)
  })

  it('discarding a NEW parent sends a saved entity moved under it back where it was', () => {
    setCanvas([node('S1', 'system'), node('D', 'dataset')],
      [{ id: 'S1-D', source: 'S1', target: 'D', data: { edgeType: 'CONTAINS' } }])
    const { result } = both()
    const fresh = result.current.create.stageEntity({ entityType: 'system', displayName: 'Fresh' })
    result.current.move.reparent('D', fresh)
    expect(moves()).toHaveLength(1)
    useStagedChangesStore.getState().discard(creates()[0].id)
    expect(staged()).toHaveLength(0)                                    // the move went with it
    expect(parentLinks('D').map((e) => e.id)).toEqual(['S1-D'])          // back where it was
  })
})
