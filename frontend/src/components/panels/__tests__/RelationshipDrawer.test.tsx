/**
 * RelationshipDrawer — the EntityDrawer for a relationship. Pins what a graph
 * owner relies on: it names both ends and walks to them on the shared trail,
 * says who created and last changed the relationship, lets a raw lineage
 * relationship be edited (staged) and deleted in a draft, keeps roll-ups,
 * hierarchy links and published relationships read-only with the reason, and
 * guards unsaved edits against a move away.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphEdge } from '@/providers/GraphDataProvider'
import { useCanvasStore, type DrawerEdgeTarget, type LineageEdge, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useFeaturesStore } from '@/store/features'

const h = vi.hoisted(() => ({
  record: undefined as GraphEdge | undefined,
  versions: [] as Array<Record<string, unknown>>,
  scope: { wsId: 'ws' as string | undefined, graphId: 'g' as string | null, mainBranchId: 'main' as string | null, branchId: 'd1' as string | null },
}))

vi.mock('@/hooks/useRelationshipRecord', () => ({
  useRelationshipRecord: (ref: { id: string } | null) => ({
    record: h.record,
    entityId: h.record?.id ?? ref?.id ?? null,
    unsaved: false,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}))
vi.mock('../useDrawerHistoryScope', () => ({ useDrawerHistoryScope: () => h.scope }))
vi.mock('@/features/versioning/hooks/useVersioning', () => ({
  useEntityHistory: (ws?: string, g?: string | null, id?: string | null) => ({
    data: ws && g && id ? { versions: h.versions, userNames: { usr_ana: 'Ana', usr_bo: 'Bo' } } : undefined,
    isLoading: false,
  }),
  useBranches: () => ({ data: [] }),
}))
vi.mock('@/features/versioning/components/EntityHistory', () => ({
  EntityHistory: ({ entityId }: { entityId: string }) => <div data-testid="entity-history">{entityId}</div>,
}))
vi.mock('@/hooks/useViewSchema', () => ({
  useViewRelationshipTypes: () => [],
  useViewContainmentEdgeTypes: () => ['CONTAINS'],
}))

import { RelationshipDrawer } from '../RelationshipDrawer'

const node = (id: string, label: string): LineageNode =>
  ({ id, type: 'generic', position: { x: 0, y: 0 }, data: { label, type: 'dataset', urn: id } }) as unknown as LineageNode
const edge = (id: string, source: string, target: string, edgeType = 'FLOWS_TO'): LineageEdge =>
  ({ id, source, target, data: { edgeType } }) as LineageEdge
const rel = (id: string, edgeType = 'FLOWS_TO'): DrawerEdgeTarget =>
  ({ kind: 'relationship', id, source: 'a', target: 'b', edgeType })

function setup(target: DrawerEdgeTarget, opts: { canvasEdges?: LineageEdge[] } = {}) {
  useCanvasStore.setState({
    nodes: [node('a', 'Orders'), node('b', 'Revenue')],
    edges: opts.canvasEdges ?? [edge('e1', 'a', 'b')],
    _nodeIndex: new Set(['a', 'b']),
    _edgeIndex: new Set((opts.canvasEdges ?? [edge('e1', 'a', 'b')]).map((e) => e.id)),
    drawerNodeId: null,
    drawerEdge: null,
    drawerEdgeEditRequest: false,
    drawerHistory: { entries: [], cursor: -1 },
    selectedNodeIds: [],
    selectedEdgeIds: [],
  })
  useCanvasStore.getState().openEdgeDrawer(target)
}

beforeEach(() => {
  h.record = { id: 'e1', sourceUrn: 'a', targetUrn: 'b', edgeType: 'FLOWS_TO', confidence: 0.9, properties: { owner: 'ana' } }
  h.versions = [
    { commit_id: 'c1', commit_seq: 2, branch_id: 'main', op: 'create', actor: 'usr_ana', created_at: '2026-01-01T00:00:00Z' },
    { commit_id: 'c2', commit_seq: 5, branch_id: 'main', op: 'update', actor: 'usr_bo', created_at: '2026-02-01T00:00:00Z' },
  ]
  h.scope = { wsId: 'ws', graphId: 'g', mainBranchId: 'main', branchId: 'd1' }
  useStagedChangesStore.setState({ changes: [], redoStack: [] })
  useFeaturesStore.setState({ values: { versioningEnabled: true, editModeEnabled: true } } as never)
})

describe('RelationshipDrawer — a relationship', () => {
  it('names both ends, the type, its properties, and who created and last changed it', () => {
    setup(rel('e1'))
    render(<RelationshipDrawer canEdit />)
    const bridge = screen.getByTestId('relationship-bridge')
    expect(within(bridge).getByText('Orders')).toBeInTheDocument()
    expect(within(bridge).getByText('Revenue')).toBeInTheDocument()
    expect(screen.getByText('owner')).toBeInTheDocument()
    const provenance = screen.getByText('Provenance').closest('.px-5') as HTMLElement
    expect(within(provenance).getByText('Created').closest('div')).toHaveTextContent('by Ana')
    expect(within(provenance).getByText('Last changed').closest('div')).toHaveTextContent('by Bo')
    expect(screen.getByTestId('entity-history')).toHaveTextContent('e1')
  })

  it('opens an end in the drawer on the same trail — Back returns to the relationship', async () => {
    const user = userEvent.setup()
    setup(rel('e1'))
    render(<RelationshipDrawer canEdit />)
    await user.click(screen.getByRole('button', { name: 'Open Orders' }))
    const s = useCanvasStore.getState()
    expect(s.drawerNodeId).toBe('a')
    expect(s.drawerHistory.entries.map((e) => e.kind)).toEqual(['edge', 'node'])
    s.drawerBack()
    expect(useCanvasStore.getState().drawerEdge?.id).toBe('e1')
  })

  it('stages a property edit as a diff base plus the new bag', async () => {
    const user = userEvent.setup()
    setup(rel('e1'))
    render(<RelationshipDrawer canEdit />)
    await user.click(screen.getByRole('button', { name: /Edit/ }))
    await user.click(screen.getByRole('button', { name: /Add property/i }))
    await user.type(screen.getByPlaceholderText('Property name'), 'tier')
    await user.type(screen.getByPlaceholderText('Enter a value…'), 'gold')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await user.click(screen.getByRole('button', { name: /Stage Changes/ }))

    const [change] = useStagedChangesStore.getState().changes
    expect(change).toMatchObject({
      type: 'edit_edge',
      targetId: 'e1',
      before: { properties: { owner: 'ana' } },
      after: { properties: { owner: 'ana', tier: 'gold' } },
    })
    // The drawer now shows the staged bag.
    expect(screen.getByText('tier')).toBeInTheDocument()
  })

  it('asks before an unsaved edit is left behind', async () => {
    const user = userEvent.setup()
    setup(rel('e1'))
    render(<RelationshipDrawer canEdit />)
    await user.click(screen.getByRole('button', { name: /Edit/ }))
    await user.click(screen.getByRole('button', { name: /Add property/i }))
    await user.type(screen.getByPlaceholderText('Property name'), 'tier')
    await user.type(screen.getByPlaceholderText('Enter a value…'), 'gold')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await user.click(screen.getByRole('button', { name: 'Open Orders' }))

    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    expect(useCanvasStore.getState().drawerEdge?.id).toBe('e1')
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(useCanvasStore.getState().drawerNodeId).toBe('a')
  })

  it('opens straight into Edit when asked from the Edge Explorer', () => {
    setup(rel('e1'))
    useCanvasStore.getState().openEdgeDrawer(rel('e1'), { edit: true })
    render(<RelationshipDrawer canEdit />)
    expect(screen.getByRole('button', { name: /Stage Changes/ })).toBeInTheDocument()
  })

  it.each([
    ['a roll-up', 'AGGREGATED', /aggregation job/],
    ['a hierarchy link', 'CONTAINS', /Move to/],
  ])('keeps %s read-only and says why', (_what, type, reason) => {
    h.record = { ...h.record!, edgeType: type }
    setup(rel('e1', type))
    render(<RelationshipDrawer canEdit onDeleteEdge={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument()
    expect(screen.queryByTitle('Delete relationship')).not.toBeInTheDocument()
    expect(screen.getByText(reason)).toBeInTheDocument()
  })

  it('on the published graph, offers a draft instead of Edit', async () => {
    const user = userEvent.setup()
    const onStartEditing = vi.fn()
    setup(rel('e1'))
    render(<RelationshipDrawer canEdit={false} onStartEditing={onStartEditing} />)
    expect(screen.queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open a draft' }))
    expect(onStartEditing).toHaveBeenCalled()
  })

  it('a relationship with no recorded history is not edited here', () => {
    h.versions = []
    setup(rel('e1'))
    render(<RelationshipDrawer canEdit />)
    expect(screen.queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument()
    expect(screen.getByText(/Not under version control/)).toBeInTheDocument()
  })

  it('a read-only viewer sees no provenance and no history', () => {
    h.scope = { wsId: undefined, graphId: null, mainBranchId: null, branchId: null }
    setup(rel('e1'))
    render(<RelationshipDrawer />)
    expect(screen.queryByText('Provenance')).not.toBeInTheDocument()
    expect(screen.queryByTestId('entity-history')).not.toBeInTheDocument()
  })

  it('deletes through the canvas and closes', async () => {
    const user = userEvent.setup()
    const onDeleteEdge = vi.fn()
    setup(rel('e1'))
    render(<RelationshipDrawer canEdit onDeleteEdge={onDeleteEdge} />)
    await user.click(screen.getByTitle('Delete relationship'))
    expect(onDeleteEdge).toHaveBeenCalledWith('e1')
    expect(useCanvasStore.getState().drawerEdge).toBeNull()
  })
})

describe('RelationshipDrawer — a connection', () => {
  const connection: DrawerEdgeTarget = {
    kind: 'connection', id: 'bundle-a->b', source: 'a', target: 'b', types: ['FLOWS_TO'], weight: 2,
    members: [
      { id: 'e1', source: 'a', target: 'b', edgeType: 'FLOWS_TO', rollup: false },
      { id: 'e2', source: 'a', target: 'b', edgeType: 'FLOWS_TO', rollup: false },
    ],
  }

  it('lists the relationships a line stands for, and opens one on the trail', async () => {
    const user = userEvent.setup()
    setup(connection)
    render(<RelationshipDrawer canEdit />)
    expect(screen.getByText(/relationships listed/)).toBeInTheDocument()
    const rows = within(screen.getByRole('list', { name: /Relationships this line stands for/ })).getAllByRole('button')
    expect(rows).toHaveLength(2)
    await user.click(rows[1])
    const s = useCanvasStore.getState()
    expect(s.drawerEdge).toMatchObject({ kind: 'relationship', id: 'e2', lineId: 'bundle-a->b' })
    expect(s.drawerHistory.entries).toHaveLength(2)
  })

  it('a summary line explains how to see what it summarises', () => {
    setup({ ...connection, summaryOnly: true, members: [], weight: 40 })
    render(<RelationshipDrawer />)
    expect(screen.getByText(/Expand either end/)).toBeInTheDocument()
  })
})
