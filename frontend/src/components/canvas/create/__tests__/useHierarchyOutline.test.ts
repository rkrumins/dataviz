/**
 * useHierarchyOutline is the outliner model behind the Hierarchy Builder panel:
 * committed rows ARE the staged `create_entity` changes, and exactly one
 * uncommitted "active row" lives in local hook state. These tests exercise the
 * ontology-gated Enter/Tab/Shift+Tab semantics end to end (staged change +
 * optimistic canvas node), not just the pure derivations.
 *
 * Also covers `useHierarchyBuilderStore.open()`'s ensureDraftOpen contract.
 */
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import type { EntityTypeSchema, RelationshipTypeSchema } from '@/types/schema'
import type { ParsedOutlineRow } from '../outlineParser'
import { useHierarchyOutline } from '../useHierarchyOutline'

vi.mock('@/features/versioning/model/ensureDraftOpen', () => ({
  ensureDraftOpen: vi.fn().mockResolvedValue(null),
}))
import { ensureDraftOpen } from '@/features/versioning/model/ensureDraftOpen'
import { useHierarchyBuilderStore } from '../hierarchyBuilderStore'

// useViewSchema falls back to the global schema store whenever there's no
// ViewExecutionContext in the render tree (exactly the case outside a
// mounted view) — which is what these hook tests want. Mocking this out
// avoids pulling in ViewExecutionContext's unrelated transitive chain
// (-> store/workspaces -> workspaceSwitchCleanup -> '@/main', which calls
// ReactDOM.createRoot at module load and crashes in jsdom with no #root).
vi.mock('@/providers/ViewExecutionContext', () => ({
  useViewExecutionContext: () => null,
}))

// ---------------------------------------------------------------------------
// Fixture ontology — domain -> dataPlatform -> container -> dataset -> column,
// with container able to self-nest or hold a dataset (multi-allowed-children
// case) plus a 'secretRoom' type that IS a listed child of container but has
// NO valid containment edge (zero-edge case). Two containment relationship
// types (BELONGS_TO listed first, CONTAINS second) so CONTAINS-preference
// tests actually prove literal-id matching, not array order.
// ---------------------------------------------------------------------------
const et = (
  id: string,
  name: string,
  canContain: string[],
  canBeContainedBy: string[] = [],
  level = 0,
): EntityTypeSchema => ({
  id, name, pluralName: `${name}s`, visual: {} as never, fields: [], behavior: {} as never,
  hierarchy: { level, canContain, canBeContainedBy, defaultExpanded: false, rollUpFields: [] },
})

const rt = (
  id: string,
  sourceTypes: string[],
  targetTypes: string[],
  extra: Partial<RelationshipTypeSchema> = {},
): RelationshipTypeSchema => ({ id, name: id, sourceTypes, targetTypes, ...extra } as RelationshipTypeSchema)

const entityTypes: EntityTypeSchema[] = [
  et('domain', 'Domain', ['dataPlatform'], [], 0),
  et('dataPlatform', 'Data Platform', ['container'], ['domain'], 1),
  et('container', 'Container', ['container', 'dataset', 'secretRoom'], ['dataPlatform', 'container'], 2),
  et('dataset', 'Dataset', ['column'], ['container'], 3),
  et('column', 'Column', [], ['dataset'], 4),
  et('secretRoom', 'Secret Room', [], ['container'], 3),
]
const rootEntityTypes = ['domain']
const relationshipTypes: RelationshipTypeSchema[] = [
  rt('BELONGS_TO', ['domain', 'dataPlatform', 'container', 'dataset'], ['dataPlatform', 'container', 'dataset', 'column'], { isContainment: true }),
  rt('CONTAINS', ['domain', 'dataPlatform', 'container', 'dataset'], ['dataPlatform', 'container', 'dataset', 'column'], { isContainment: true }),
]
const containmentEdgeTypes = ['CONTAINS', 'BELONGS_TO']

function seedSchema() {
  useSchemaStore.setState({
    schema: {
      id: 'ws1', name: 'Test', version: '1',
      entityTypes, relationshipTypes,
      views: [], defaultViewId: '',
      globalVisuals: {} as never,
      containmentEdgeTypes, lineageEdgeTypes: [],
      rootEntityTypes,
    },
    activeViewId: null,
  } as never)
}

function seedNode(urn: string, type: string, label: string) {
  useCanvasStore.getState().addNodes([{ id: urn, type: 'generic', position: { x: 0, y: 0 }, data: { label, type, urn } }])
}

const resetStores = () => {
  useCanvasStore.setState({ nodes: [], edges: [], _nodeIndex: new Set(), _edgeIndex: new Set() } as never)
  useStagedChangesStore.setState({ changes: [], redoStack: [], _scopeKey: null, _byScope: {} })
  seedSchema()
}

const staged = () => useStagedChangesStore.getState().changes
const findByTempUrn = (tempUrn: string) => staged().find((c) => c.targetUrn === tempUrn)
const canvasNode = (id: string) => useCanvasStore.getState().nodes.find((n) => n.id === id)
const afterOf = (c: ReturnType<typeof findByTempUrn>) =>
  c!.after as { displayName?: string; entityType?: string; parentUrn?: string; containmentEdgeType?: string; properties?: Record<string, unknown> }

describe('useHierarchyOutline', () => {
  beforeEach(resetStores)

  it('1. commitSibling stages with auto-inferred type + CONTAINS edge; canvas node + staged change exist; onEntityStaged fired', () => {
    seedNode('urn:real:domain1', 'domain', 'Sales Domain')
    const onEntityStaged = vi.fn()
    const { result } = renderHook(() =>
      useHierarchyOutline({ scopeParentUrn: 'urn:real:domain1', layerId: null, initialTypeId: null, onEntityStaged }),
    )

    // Single allowed child of 'domain' -> auto-inferred silently.
    expect(result.current.active.typeId).toBe('dataPlatform')
    // 2 valid containment edges (BELONGS_TO, CONTAINS) -> literal CONTAINS wins.
    expect(result.current.active.edgeType).toBe('CONTAINS')

    act(() => result.current.setName('Analytics'))
    let tempUrn: string | null = null
    act(() => { tempUrn = result.current.commitSibling() })

    expect(tempUrn).toBeTruthy()
    const node = canvasNode(tempUrn!)
    expect(node?.data.label).toBe('Analytics')
    expect(node?.data.type).toBe('dataPlatform')

    const change = findByTempUrn(tempUrn!)
    expect(change).toBeTruthy()
    expect(change!.type).toBe('create_entity')
    const after = afterOf(change)
    expect(after.parentUrn).toBe('urn:real:domain1')
    expect(after.containmentEdgeType).toBe('CONTAINS')

    expect(onEntityStaged).toHaveBeenCalledWith(tempUrn, 'urn:real:domain1')
  })

  it('2. commitAndNest sets the next active parent to the new tempUrn; committing again nests under it', () => {
    seedNode('urn:real:domain1', 'domain', 'Sales Domain')
    const { result } = renderHook(() =>
      useHierarchyOutline({ scopeParentUrn: 'urn:real:domain1', layerId: null, initialTypeId: null }),
    )

    act(() => result.current.setName('Analytics'))
    let tempUrn1: string | null = null
    act(() => { tempUrn1 = result.current.commitAndNest() })
    expect(tempUrn1).toBeTruthy()
    expect(result.current.active.parentUrn).toBe(tempUrn1)
    // dataPlatform's only child is 'container' -> re-inferred silently.
    expect(result.current.active.typeId).toBe('container')

    act(() => result.current.setName('Raw'))
    let tempUrn2: string | null = null
    act(() => { tempUrn2 = result.current.commitSibling() })
    expect(tempUrn2).toBeTruthy()

    const change2 = findByTempUrn(tempUrn2!)
    expect(afterOf(change2).parentUrn).toBe(tempUrn1)
  })

  it('3. indent on an empty row targets the last committed row; indent under a leaf type is blocked with a plain-language reason', () => {
    seedNode('urn:real:container1', 'container', 'Raw Container')
    const { result } = renderHook(() =>
      useHierarchyOutline({ scopeParentUrn: 'urn:real:container1', layerId: null, initialTypeId: null }),
    )

    // Commit a 'dataset' child of the container, then indent onto it.
    act(() => result.current.setType('dataset'))
    act(() => result.current.setName('DS'))
    let dsUrn: string | null = null
    act(() => { dsUrn = result.current.commitSibling() })
    expect(dsUrn).toBeTruthy()

    let ok = false
    act(() => { ok = result.current.indent() })
    expect(ok).toBe(true)
    expect(result.current.active.parentUrn).toBe(dsUrn)
    expect(result.current.active.typeId).toBe('column') // dataset's only child

    // Commit the column (a leaf type: canContain === []).
    act(() => result.current.setName('Col1'))
    let colUrn: string | null = null
    act(() => { colUrn = result.current.commitSibling() })
    expect(colUrn).toBeTruthy()

    let blocked = true
    act(() => { blocked = result.current.indent() })
    expect(blocked).toBe(false)
    expect(result.current.blockedReason).toBe('Nothing can be added inside a Column.')
    // The active row must NOT have been reparented onto the leaf.
    expect(result.current.active.parentUrn).toBe(dsUrn)
  })

  it('4. outdent walks up one level at a time and refuses to go above scopeParentUrn', () => {
    seedNode('urn:real:domain1', 'domain', 'Sales Domain')
    const { result } = renderHook(() =>
      useHierarchyOutline({ scopeParentUrn: 'urn:real:domain1', layerId: null, initialTypeId: null }),
    )

    act(() => result.current.setName('Platform'))
    let platformUrn: string | null = null
    act(() => { platformUrn = result.current.commitAndNest() })
    act(() => result.current.setName('Cont'))
    let containerUrn: string | null = null
    act(() => { containerUrn = result.current.commitAndNest() })
    expect(result.current.active.parentUrn).toBe(containerUrn)

    let ok = false
    act(() => { ok = result.current.outdent() })
    expect(ok).toBe(true)
    expect(result.current.active.parentUrn).toBe(platformUrn)

    act(() => { ok = result.current.outdent() })
    expect(ok).toBe(true)
    expect(result.current.active.parentUrn).toBe('urn:real:domain1')

    act(() => { ok = result.current.outdent() })
    expect(ok).toBe(false)
    expect(result.current.active.parentUrn).toBe('urn:real:domain1')
  })

  it('5. type inference: single-allowed auto; multi-allowed honors lastUsedTypeAtDepth after a manual setType + commit at that depth', () => {
    seedNode('urn:real:container1', 'container', 'Container One')
    seedNode('urn:real:container2', 'container', 'Container Two')
    const { result } = renderHook(() =>
      useHierarchyOutline({ scopeParentUrn: 'urn:real:container1', layerId: null, initialTypeId: null }),
    )

    // Multi-allowed (container, dataset both valid); no history yet -> sorted default.
    expect(result.current.allowedTypes.map((t) => t.id)).toEqual(['container', 'dataset'])
    expect(result.current.active.typeId).toBe('container')

    act(() => result.current.setType('dataset'))
    act(() => result.current.setName('DS1'))
    act(() => { result.current.commitSibling() })

    // Retarget to a DIFFERENT depth-0 multi-allowed parent -> should honor session memory.
    act(() => result.current.retarget('urn:real:container2'))
    expect(result.current.active.typeId).toBe('dataset')
  })

  it('6. edge auto-pick prefers literal CONTAINS among 2+ allowed options', () => {
    seedNode('urn:real:container1', 'container', 'Raw Container')
    const { result } = renderHook(() =>
      useHierarchyOutline({ scopeParentUrn: 'urn:real:container1', layerId: null, initialTypeId: null }),
    )

    expect(result.current.edgeOptions.map((o) => o.edgeType).sort()).toEqual(['BELONGS_TO', 'CONTAINS'])
    expect(result.current.active.edgeType).toBe('CONTAINS')
  })

  it('7. blockedReason + canCommit=false when the chosen type has zero allowed containment edges', () => {
    seedNode('urn:real:container1', 'container', 'Raw Container')
    const { result } = renderHook(() =>
      useHierarchyOutline({ scopeParentUrn: 'urn:real:container1', layerId: null, initialTypeId: null }),
    )

    // secretRoom IS listed in container.canContain but has no valid containment edge.
    act(() => result.current.setType('secretRoom'))
    act(() => result.current.setName('Vault'))

    expect(result.current.edgeOptions).toEqual([])
    expect(result.current.blockedReason).toBe("A Container can't contain a Secret Room.")
    expect(result.current.canCommit).toBe(false)
  })

  it('8. stageRows threads parents depth-first, skips issue rows + their descendants, returns the staged count, and stamps layerAssignment', () => {
    const { result } = renderHook(() =>
      useHierarchyOutline({ scopeParentUrn: null, layerId: 'layer1', initialTypeId: null }),
    )

    const rows: ParsedOutlineRow[] = [
      { name: 'Sales', typeId: 'domain', explicitType: true, depth: 0, issues: [] },
      { name: 'Analytics', typeId: 'dataPlatform', explicitType: true, depth: 1, issues: [] },
      { name: 'Raw', typeId: 'container', explicitType: true, depth: 2, issues: [] },
      { name: 'BadRow', typeId: null, explicitType: false, depth: 1, issues: ['Nothing can be added inside a Column.'] },
      { name: 'SkippedChild', typeId: 'container', explicitType: true, depth: 2, issues: [] },
    ]

    let count = 0
    act(() => { count = result.current.stageRows(rows, null) })
    expect(count).toBe(3)

    const changes = staged().filter((c) => c.type === 'create_entity')
    expect(changes).toHaveLength(3)
    expect(changes.some((c) => afterOf(c).displayName === 'BadRow')).toBe(false)
    expect(changes.some((c) => afterOf(c).displayName === 'SkippedChild')).toBe(false)

    const salesChange = changes.find((c) => afterOf(c).displayName === 'Sales')!
    const analyticsChange = changes.find((c) => afterOf(c).displayName === 'Analytics')!
    const rawChange = changes.find((c) => afterOf(c).displayName === 'Raw')!

    expect(afterOf(analyticsChange).parentUrn).toBe(salesChange.targetUrn)
    expect(afterOf(rawChange).parentUrn).toBe(analyticsChange.targetUrn)
    expect(afterOf(salesChange).properties?.layerAssignment).toBe('layer1')
  })

  it('9. removeRow cascades: discarding a staged parent also removes its staged child from staged changes + canvas', () => {
    const { result } = renderHook(() =>
      useHierarchyOutline({ scopeParentUrn: null, layerId: null, initialTypeId: null }),
    )

    act(() => result.current.setName('Sales'))
    let parentUrn: string | null = null
    let parentChangeId: string | null = null
    act(() => { parentUrn = result.current.commitAndNest() })
    parentChangeId = findByTempUrn(parentUrn!)!.id

    act(() => result.current.setName('Analytics'))
    let childUrn: string | null = null
    act(() => { childUrn = result.current.commitSibling() })

    act(() => result.current.removeRow(parentChangeId!))

    expect(findByTempUrn(parentUrn!)).toBeUndefined()
    expect(findByTempUrn(childUrn!)).toBeUndefined()
    expect(canvasNode(parentUrn!)).toBeUndefined()
    expect(canvasNode(childUrn!)).toBeUndefined()
  })

  it('10. vanished-parent fallback resets active.parentUrn to scopeParentUrn when the retargeted row is removed', () => {
    const { result } = renderHook(() =>
      useHierarchyOutline({ scopeParentUrn: null, layerId: null, initialTypeId: null }),
    )

    act(() => result.current.setName('Sales'))
    let tempUrn: string | null = null
    let changeId: string | null = null
    act(() => { tempUrn = result.current.commitSibling() })
    changeId = findByTempUrn(tempUrn!)!.id

    act(() => result.current.retarget(tempUrn))
    expect(result.current.active.parentUrn).toBe(tempUrn)

    act(() => result.current.removeRow(changeId!))

    expect(result.current.active.parentUrn).toBeNull()
  })

  it('11. a blocked indent does not gate a later valid sibling commit: typing a name clears the stale reason', () => {
    seedNode('urn:real:container1', 'container', 'Raw Container')
    const { result } = renderHook(() =>
      useHierarchyOutline({ scopeParentUrn: 'urn:real:container1', layerId: null, initialTypeId: null }),
    )

    // Stage a dataset, nest under it, stage a leaf column — then a blocked indent.
    act(() => result.current.setType('dataset'))
    act(() => result.current.setName('DS'))
    let dsUrn: string | null = null
    act(() => { dsUrn = result.current.commitAndNest() })
    act(() => result.current.setName('Col1'))
    act(() => { result.current.commitSibling() })

    let blocked = true
    act(() => { blocked = result.current.indent() })
    expect(blocked).toBe(false)
    expect(result.current.blockedReason).toBe('Nothing can be added inside a Column.')

    // The active row still sits under its perfectly valid dataset parent —
    // typing a name (acting) must clear the stale indent message so Enter works.
    act(() => result.current.setName('Col2'))
    expect(result.current.blockedReason).toBeNull()
    expect(result.current.canCommit).toBe(true)

    let tempUrn: string | null = null
    act(() => { tempUrn = result.current.commitSibling() })
    expect(tempUrn).toBeTruthy()
    expect(afterOf(findByTempUrn(tempUrn!)).parentUrn).toBe(dsUrn)
  })

  it('12. descendantCount counts staged descendants transitively (2 / 1 / 0 for a 3-level chain)', () => {
    const { result } = renderHook(() =>
      useHierarchyOutline({ scopeParentUrn: null, layerId: null, initialTypeId: null }),
    )

    act(() => result.current.setName('Sales'))
    let domainUrn: string | null = null
    act(() => { domainUrn = result.current.commitAndNest() })
    act(() => result.current.setName('Analytics'))
    let platformUrn: string | null = null
    act(() => { platformUrn = result.current.commitAndNest() })
    act(() => result.current.setName('Raw'))
    let containerUrn: string | null = null
    act(() => { containerUrn = result.current.commitSibling() })

    expect(result.current.descendantCount(domainUrn!)).toBe(2)
    expect(result.current.descendantCount(platformUrn!)).toBe(1)
    expect(result.current.descendantCount(containerUrn!)).toBe(0)
  })

  it('13. renameRow updates the staged change after.displayName and the optimistic canvas label', () => {
    const { result } = renderHook(() =>
      useHierarchyOutline({ scopeParentUrn: null, layerId: null, initialTypeId: null }),
    )

    act(() => result.current.setName('Sales'))
    let tempUrn: string | null = null
    act(() => { tempUrn = result.current.commitSibling() })

    act(() => result.current.renameRow(tempUrn!, 'Sales EMEA'))

    expect(afterOf(findByTempUrn(tempUrn!)).displayName).toBe('Sales EMEA')
    expect(canvasNode(tempUrn!)?.data.label).toBe('Sales EMEA')
  })
})

describe('useHierarchyBuilderStore', () => {
  beforeEach(() => {
    useHierarchyBuilderStore.setState({
      isOpen: false, parentUrn: null, layerId: null, initialTypeId: null, initialMode: 'outline', initialTemplate: null,
    })
    vi.mocked(ensureDraftOpen).mockClear()
  })

  it('open() calls ensureDraftOpen and sets isOpen + the given opts', () => {
    useHierarchyBuilderStore.getState().open({
      parentUrn: 'p1', layerId: 'l1', initialTypeId: 't1', mode: 'paste', template: ['a', 'b'],
    })

    expect(ensureDraftOpen).toHaveBeenCalledTimes(1)
    const s = useHierarchyBuilderStore.getState()
    expect(s.isOpen).toBe(true)
    expect(s.parentUrn).toBe('p1')
    expect(s.layerId).toBe('l1')
    expect(s.initialTypeId).toBe('t1')
    expect(s.initialMode).toBe('paste')
    expect(s.initialTemplate).toEqual(['a', 'b'])
  })

  it('open() with no opts resets fields to null / outline', () => {
    useHierarchyBuilderStore.getState().open()
    const s = useHierarchyBuilderStore.getState()
    expect(s.isOpen).toBe(true)
    expect(s.parentUrn).toBeNull()
    expect(s.layerId).toBeNull()
    expect(s.initialTypeId).toBeNull()
    expect(s.initialMode).toBe('outline')
    expect(s.initialTemplate).toBeNull()
  })

  it('close() resets isOpen and all opts fields', () => {
    useHierarchyBuilderStore.getState().open({ parentUrn: 'p1', mode: 'paste' })
    useHierarchyBuilderStore.getState().close()
    const s = useHierarchyBuilderStore.getState()
    expect(s.isOpen).toBe(false)
    expect(s.parentUrn).toBeNull()
    expect(s.initialMode).toBe('outline')
  })

  it('calls ensureDraftOpen before flipping isOpen (order guard)', () => {
    const order: string[] = []
    vi.mocked(ensureDraftOpen).mockImplementation(() => {
      order.push('ensureDraftOpen')
      return Promise.resolve(null)
    })
    const unsub = useHierarchyBuilderStore.subscribe((s) => {
      if (s.isOpen) order.push('isOpen')
    })
    useHierarchyBuilderStore.getState().open()
    unsub()
    expect(order).toEqual(['ensureDraftOpen', 'isOpen'])
  })
})
