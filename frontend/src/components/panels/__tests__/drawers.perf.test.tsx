/**
 * The drawers at scale. A canvas of thousands of entities writes to the store constantly — a
 * pulse, a pan, a page of children arriving, a hover flag. None of those is the drawer's business,
 * and none of them may re-render it: each drawer reads its own entity through the shared store
 * indexes, so an unrelated write leaves every value it reads identical. And View mode does no
 * whole-graph work: the "move to another parent" candidates are computed only when that picker
 * opens.
 *
 * The lineage section is stubbed here: it is its own section with its own data needs (the walk,
 * the canvas's edges), measured on its own.
 */
import { Profiler } from 'react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasStore, type DrawerEdgeTarget, type LineageEdge, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useFeaturesStore } from '@/store/features'
import { useSchemaStore } from '@/store/schema'
import { useBranchStore } from '@/store/branchStore'

const spy = vi.hoisted(() => ({ allowedChildTypeIds: 0 }))

vi.mock('@/services/ontologyPreflightService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ontologyPreflightService')>()
  return {
    ...actual,
    allowedChildTypeIds: (...args: Parameters<typeof actual.allowedChildTypeIds>) => {
      spy.allowedChildTypeIds++
      return actual.allowedChildTypeIds(...args)
    },
  }
})
vi.mock('../useDrawerHistoryScope', () => ({
  useDrawerHistoryScope: () => ({ wsId: undefined, graphId: null, mainBranchId: null, branchId: null }),
}))
vi.mock('@/features/versioning/hooks/useVersioning', () => ({
  useEntitySummary: () => ({ data: undefined, isLoading: false }),
  useProjectionWatermark: () => ({ data: undefined }),
  useBranches: () => ({ data: [] }),
}))
/** In a draft: the drawer's own `canEdit` decides. */
const editingNow = { offered: true, blocked: null }
vi.mock('@/features/versioning/hooks/useEntityEditing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/versioning/hooks/useEntityEditing')>()),
  useEntityEditing: () => editingNow,
}))
vi.mock('@/features/versioning/components/EntityHistory', () => ({ EntityHistory: () => null }))
vi.mock('@/components/panels/LineageNeighbors', () => ({ LineageNeighbors: () => null }))
vi.mock('@/components/canvas/context-view/useReparentNode', () => ({
  useReparentNode: () => ({ reparent: vi.fn(), retypeContainment: vi.fn() }),
}))
vi.mock('@/features/versioning/canvas/useRestoreGhost', () => ({ useRestoreGhost: () => vi.fn() }))
vi.mock('@/providers/ViewExecutionContext', () => ({ useViewExecutionContext: () => null }))
vi.mock('@/hooks/useRelationshipRecord', () => ({
  useRelationshipRecord: (ref: { id: string } | null) => ({
    record: { id: ref?.id, sourceUrn: 'n1', targetUrn: 'n2', edgeType: 'FLOWS_TO', properties: { owner: 'ana' } },
    entityId: ref?.id ?? null, unsaved: false, isLoading: false, isError: false, refetch: vi.fn(),
  }),
}))
vi.mock('@/hooks/useViewSchema', () => ({
  useViewRelationshipTypes: () => [],
  useViewContainmentEdgeTypes: () => ['CONTAINS'],
}))

import { EntityDrawer } from '../entity/EntityDrawer'
import { RelationshipDrawer } from '../RelationshipDrawer'

const N = 5000

const node = (i: number, type: string): LineageNode => ({
  id: `n${i}`, type: 'generic', position: { x: 0, y: 0 },
  data: { urn: `n${i}`, label: `Entity ${i}`, type, properties: { owner: 'ana' } },
} as unknown as LineageNode)

function seed() {
  // 50 domains, each containing 99 datasets.
  const nodes: LineageNode[] = []
  const edges: LineageEdge[] = []
  for (let i = 0; i < N; i++) {
    const isDomain = i % 100 === 0
    nodes.push(node(i, isDomain ? 'domain' : 'dataset'))
    if (!isDomain) edges.push({ id: `c${i}`, source: `n${i - (i % 100)}`, target: `n${i}`, data: { edgeType: 'CONTAINS' } } as LineageEdge)
  }
  edges.push({ id: 'f1', source: 'n1', target: 'n2', data: { edgeType: 'FLOWS_TO' } } as LineageEdge)
  useCanvasStore.setState({
    nodes, edges,
    _nodeIndex: new Set(nodes.map((n) => n.id)), _edgeIndex: new Set(edges.map((e) => e.id)),
    drawerNodeId: null, drawerEdge: null, drawerEdgeEditRequest: false,
    drawerHistory: { entries: [], cursor: -1 },
    selectedNodeIds: [], selectedEdgeIds: [], drawerDirty: false, pendingDrawerMove: null,
  } as never)
}

const entityType = (id: string, canContain: string[]) => ({
  id, name: id, pluralName: `${id}s`, visual: {} as never, behavior: {} as never,
  hierarchy: { level: 0, canContain, canBeContainedBy: [], defaultExpanded: false, rollUpFields: [] },
  fields: [],
})

beforeEach(() => {
  spy.allowedChildTypeIds = 0
  seed()
  useStagedChangesStore.setState({ changes: [], redoStack: [] })
  useFeaturesStore.setState({ values: { versioningEnabled: true, editModeEnabled: true } } as never)
  useBranchStore.setState({ currentBranchId: 'draft-1' } as never)
  useSchemaStore.setState({
    schema: {
      id: 'ws', name: 'T', version: '1', views: [], defaultViewId: '', globalVisuals: {} as never,
      relationshipTypes: [], containmentEdgeTypes: ['CONTAINS'], lineageEdgeTypes: ['FLOWS_TO'],
      rootEntityTypes: ['domain'],
      entityTypes: [entityType('domain', ['dataset']), entityType('dataset', ['column']), entityType('column', ['field'])],
    },
    activeViewId: null,
  } as never)
})

/** Store writes a busy canvas makes that have nothing to do with the drawer. */
function unrelatedWrites() {
  const s = useCanvasStore.getState()
  act(() => { s.pulseNode('n4321') })
  act(() => { s.setViewport({ x: 120, y: -40, zoom: 0.8 }) })
  act(() => { s.addNodes([node(N + 1, 'dataset')]) })
  act(() => { s.updateNode('n777', { label: 'Renamed elsewhere' }) })
  act(() => { s.addEdges([{ id: 'f2', source: 'n900', target: 'n901', data: { edgeType: 'FLOWS_TO' } } as LineageEdge]) })
}

function profiled(ui: React.ReactElement) {
  const commits = { count: 0 }
  const view = render(<Profiler id="drawer" onRender={() => { commits.count++ }}>{ui}</Profiler>)
  return { commits, ...view }
}

describe('the entity drawer at scale', () => {
  it(`is not re-rendered by unrelated store writes (${N.toLocaleString()} entities)`, () => {
    useCanvasStore.getState().openNodeDrawer('n150')
    const { commits } = profiled(<EntityDrawer canEdit />)
    expect(screen.getByRole('heading', { name: 'Entity 150' })).toBeInTheDocument()
    commits.count = 0
    unrelatedWrites()
    expect(commits.count).toBe(0)
  })

  it('in Edit, with the move picker closed, is not re-rendered by unrelated store writes either', async () => {
    const user = userEvent.setup()
    useCanvasStore.getState().openNodeDrawer('n150')
    const { commits } = profiled(<EntityDrawer canEdit />)
    await user.click(screen.getByRole('tab', { name: /^Edit/ }))
    expect(screen.getByRole('button', { name: /Choose a new parent/ })).toBeInTheDocument()
    commits.count = 0
    unrelatedWrites()
    expect(commits.count).toBe(0)
  })

  it('re-renders when its own entity changes', () => {
    useCanvasStore.getState().openNodeDrawer('n150')
    const { commits } = profiled(<EntityDrawer canEdit />)
    commits.count = 0
    act(() => { useCanvasStore.getState().updateNode('n150', { label: 'Orders' }) })
    expect(commits.count).toBeGreaterThan(0)
    expect(screen.getByRole('heading', { name: 'Orders' })).toBeInTheDocument()
  })

  it('does no move-target work until the "move to" picker opens', async () => {
    const user = userEvent.setup()
    useCanvasStore.getState().openNodeDrawer('n150')
    render(<EntityDrawer canEdit />)
    await user.click(screen.getByRole('tab', { name: /^Edit/ }))
    expect(spy.allowedChildTypeIds).toBe(0)
    await user.click(screen.getByRole('button', { name: /Choose a new parent/ }))
    expect(spy.allowedChildTypeIds).toBeGreaterThan(0)
    // Every domain but its own can take it: 49 of them.
    expect(screen.getByRole('combobox', { name: 'Search for a new parent' })).toHaveAttribute('placeholder', 'Search 49 possible parents…')
  })
})

describe('the relationship drawer at scale', () => {
  it(`is not re-rendered by unrelated store writes (${N.toLocaleString()} entities)`, () => {
    const target: DrawerEdgeTarget = { kind: 'relationship', id: 'f1', source: 'n1', target: 'n2', edgeType: 'FLOWS_TO' }
    useCanvasStore.getState().openEdgeDrawer(target)
    const { commits } = profiled(<RelationshipDrawer canEdit />)
    expect(screen.getByRole('button', { name: 'Open Entity 1' })).toBeInTheDocument()
    commits.count = 0
    unrelatedWrites()
    expect(commits.count).toBe(0)
  })
})
