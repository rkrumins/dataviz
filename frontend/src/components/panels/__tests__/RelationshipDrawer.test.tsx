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
import { usePreferencesStore } from '@/store/preferences'

const h = vi.hoisted(() => ({
  record: undefined as GraphEdge | undefined,
  summary: undefined as Record<string, unknown> | undefined,
  /** The data source, for ends the canvas has not loaded. */
  provider: null as { getNodes: ReturnType<typeof vi.fn> } | null,
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
  useEntitySummary: (ws?: string, g?: string | null, id?: string | null) => ({
    data: ws && g && id ? h.summary : undefined,
    isLoading: false,
  }),
  useBranches: () => ({ data: [] }),
  useProjectionWatermark: () => ({ data: { committed: 3, projected: 3, fresh: true, status: 'idle', lastProjectedAt: '2026-02-02T00:00:00Z' } }),
}))
vi.mock('@/providers/GraphProviderContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/providers/GraphProviderContext')>()),
  useGraphProviderIfAvailable: () => h.provider,
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
    drawerDirty: false,
    pendingDrawerMove: null,
  })
  useCanvasStore.getState().openEdgeDrawer(target)
}

beforeEach(() => {
  h.record = { id: 'e1', sourceUrn: 'a', targetUrn: 'b', edgeType: 'FLOWS_TO', confidence: 0.9, properties: { owner: 'ana' } }
  h.summary = {
    entityId: 'e1', kind: 'edge', exists: true, version: 'v9', inherited: false,
    created: { at: '2026-01-01T00:00:00Z', actor: 'usr_ana', op: 'create', commitId: 'c1', inDraft: false },
    updated: { at: '2026-02-01T00:00:00Z', actor: 'usr_bo', op: 'update', commitId: 'c2', inDraft: false },
    revisions: { published: 2, draft: 0 }, changedOnMainSinceBranch: false, baseCommitSeq: null,
    value: { kind: 'edge', version: 'v9', edge: { id: 'e1', sourceUrn: 'a', targetUrn: 'b', edgeType: 'FLOWS_TO', properties: { owner: 'ana' } } },
    userNames: { usr_ana: 'Ana', usr_bo: 'Bo' },
  }
  h.scope = { wsId: 'ws', graphId: 'g', mainBranchId: 'main', branchId: 'd1' }
  h.provider = null
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
    // Updated (who, when) and Synced, as in the entity drawer.
    expect(screen.getByText('Updated').closest('div')).toHaveTextContent(/Bo/)
    expect(screen.getByText('Synced')).toBeInTheDocument()
    expect(screen.getByTestId('entity-history')).toHaveTextContent('e1')
  })

  it('details say what the relationship means, and name each end and its type first, with the ids as the detail', () => {
    setup(rel('e1'))
    render(<RelationshipDrawer canEdit />)
    const details = screen.getByText('Details').closest('.px-5') as HTMLElement
    // No description in the ontology: its kind explains it.
    expect(within(details).getByText('Meaning').closest('div')).toHaveTextContent('Data moves from the first entity to the second.')
    expect(within(details).queryByText('Confidence')).not.toBeInTheDocument()
    const from = within(details).getByText('From').closest('div') as HTMLElement
    expect(within(from).getByRole('button', { name: 'Orders' })).toBeInTheDocument()
    expect(within(from).getByText('dataset')).toBeInTheDocument()
    expect(within(from).getByText('a')).toBeInTheDocument()
    expect(within(within(details).getByText('ID').closest('div') as HTMLElement).getByText('e1')).toBeInTheDocument()
  })

  it('an end the canvas has not loaded is named by the data source', async () => {
    h.provider = { getNodes: vi.fn().mockResolvedValue([{ urn: 'urn:li:dataset:deep', displayName: 'Deep Orders', entityType: 'dataset', properties: {} }]) }
    setup({ kind: 'relationship', id: 'e1', source: 'a', target: 'urn:li:dataset:deep', edgeType: 'FLOWS_TO' })
    render(<RelationshipDrawer canEdit />)
    expect(await within(screen.getByTestId('relationship-bridge')).findByText('Deep Orders')).toBeInTheDocument()
    expect(h.provider.getNodes).toHaveBeenCalledWith({ urns: ['urn:li:dataset:deep'], limit: 1 })
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
    await user.click(screen.getByRole('tab', { name: /Edit/ }))
    await user.click(screen.getByRole('button', { name: /Add property/i }))
    await user.type(screen.getByPlaceholderText('Property name'), 'tier')
    await user.type(screen.getByPlaceholderText('Enter a value…'), 'gold')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await user.click(screen.getByRole('button', { name: /Stage changes/ }))

    const [change] = useStagedChangesStore.getState().changes
    expect(change).toMatchObject({
      type: 'edit_edge',
      targetId: 'e1',
      before: { properties: { owner: 'ana' }, version: 'v9' },
      after: { properties: { owner: 'ana', tier: 'gold' } },
    })
    // The drawer now shows the staged bag.
    expect(screen.getByText('tier')).toBeInTheDocument()
  })

  it('asks before an unsaved edit is left behind', async () => {
    const user = userEvent.setup()
    setup(rel('e1'))
    render(<RelationshipDrawer canEdit />)
    await user.click(screen.getByRole('tab', { name: /Edit/ }))
    await user.click(screen.getByRole('button', { name: /Add property/i }))
    await user.type(screen.getByPlaceholderText('Property name'), 'tier')
    await user.type(screen.getByPlaceholderText('Enter a value…'), 'gold')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await user.click(screen.getByRole('button', { name: 'Open Orders' }))

    expect(screen.getByRole('alertdialog', { name: 'Unsaved changes' })).toBeInTheDocument()
    expect(useCanvasStore.getState().drawerEdge?.id).toBe('e1')
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(useCanvasStore.getState().drawerNodeId).toBe('a')
  })

  it('opens straight into Edit when asked from the Edge Explorer', () => {
    setup(rel('e1'))
    useCanvasStore.getState().openEdgeDrawer(rel('e1'), { edit: true })
    render(<RelationshipDrawer canEdit />)
    expect(screen.getByRole('button', { name: /Stage changes/ })).toBeInTheDocument()
  })

  it.each([
    ['a roll-up', 'AGGREGATED', /aggregation job/],
    ['a hierarchy link', 'CONTAINS', /Move to/],
  ])('keeps %s read-only and says why', (_what, type, reason) => {
    h.record = { ...h.record!, edgeType: type }
    setup(rel('e1', type))
    render(<RelationshipDrawer canEdit onDeleteEdge={vi.fn()} />)
    expect(screen.queryByRole('tab', { name: /^Edit/ })).not.toBeInTheDocument()
    expect(screen.queryByTitle('Delete relationship')).not.toBeInTheDocument()
    expect(screen.getByText(reason)).toBeInTheDocument()
  })

  it('on the published graph, offers a draft instead of Edit', async () => {
    const user = userEvent.setup()
    const onStartEditing = vi.fn()
    setup(rel('e1'))
    render(<RelationshipDrawer canEdit={false} onStartEditing={onStartEditing} />)
    expect(screen.queryByRole('tab', { name: /^Edit/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open a draft' }))
    expect(onStartEditing).toHaveBeenCalled()
  })

  it('a relationship with no recorded history is not edited here', () => {
    h.summary = { ...h.summary, exists: false, version: null, created: null, updated: null, value: null }
    setup(rel('e1'))
    render(<RelationshipDrawer canEdit />)
    expect(screen.queryByRole('tab', { name: /^Edit/ })).not.toBeInTheDocument()
    expect(screen.getByText(/Not under version control/)).toBeInTheDocument()
  })

  it('without version control there is no created / updated and no history', () => {
    h.scope = { wsId: undefined, graphId: null, mainBranchId: null, branchId: null }
    setup(rel('e1'))
    render(<RelationshipDrawer />)
    expect(screen.queryByText('Updated')).not.toBeInTheDocument()
    expect(screen.getByText('History is available with version control.')).toBeInTheDocument()
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
    expect(screen.getByText(/Stands for/)).toHaveTextContent('Stands for 2 flows · 2 relationships')
    expect(screen.queryByText(/join entities inside/)).not.toBeInTheDocument()
    const rows = within(screen.getByRole('list', { name: /Relationships this line stands for/ })).getAllByRole('button')
    expect(rows).toHaveLength(2)
    await user.click(rows[1])
    const s = useCanvasStore.getState()
    expect(s.drawerEdge).toMatchObject({ kind: 'relationship', id: 'e2', lineId: 'bundle-a->b' })
    expect(s.drawerHistory.entries).toHaveLength(2)
  })

  it('says so when the relationships join entities inside the two cards', () => {
    setup({ ...connection, members: [{ id: 'e1', source: 'c1', target: 'b', edgeType: 'FLOWS_TO', rollup: false }] })
    render(<RelationshipDrawer />)
    expect(screen.getByText(/join entities inside Orders and Revenue/)).toBeInTheDocument()
  })

  it('lists roll-ups apart from the relationships, says what they are, and offers relationships only', async () => {
    const user = userEvent.setup()
    usePreferencesStore.setState({ showLineageRollups: true })
    setup({
      ...connection,
      types: ['FLOWS_TO', 'AGGREGATED'],
      members: [
        { id: 'e1', source: 'a', target: 'b', edgeType: 'FLOWS_TO', rollup: false },
        { id: 'agg1', source: 'a', target: 'b', edgeType: 'AGGREGATED', rollup: true },
      ],
    })
    render(<RelationshipDrawer />)
    expect(screen.getByText(/Stands for/)).toHaveTextContent('1 relationship · 1 roll-up')
    expect(within(screen.getByRole('list', { name: /Relationships this line stands for/ })).getAllByRole('button')).toHaveLength(1)
    expect(within(screen.getByRole('list', { name: /Roll-ups this line stands for/ })).getAllByRole('button')).toHaveLength(1)
    expect(screen.getByText(/Summaries the aggregation job computes/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Relationships only' }))
    expect(usePreferencesStore.getState().showLineageRollups).toBe(false)
  })

  it('a summary line explains how to see what it summarises', () => {
    setup({ ...connection, summaryOnly: true, members: [], weight: 40 })
    render(<RelationshipDrawer />)
    expect(screen.getByText(/Expand either end/)).toBeInTheDocument()
  })
})
