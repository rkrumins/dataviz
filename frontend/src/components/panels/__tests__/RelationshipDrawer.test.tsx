/**
 * RelationshipDrawer — the EntityDrawer for a relationship. Pins what a graph
 * owner relies on: it names both ends and walks to them on the shared trail,
 * says who created and last changed the relationship, lets a raw lineage
 * relationship be edited (staged), reversed — with what it holds — and deleted in a
 * draft, edits only the properties of a hierarchy link or another kind, gives one
 * not saved yet its properties, restores one deleted in the draft, keeps roll-ups
 * and published relationships read-only with the reason, and guards unsaved edits
 * against a move away.
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
  summary: undefined as Record<string, unknown> | undefined,
  /** The data source, for ends the canvas has not loaded. */
  provider: null as { getNodes: ReturnType<typeof vi.fn> } | null,
  scope: { wsId: 'ws' as string | undefined, graphId: 'g' as string | null, mainBranchId: 'main' as string | null, branchId: 'd1' as string | null },
  /** The relationships beneath a roll-up, as the data source answers. */
  beneath: { data: undefined, isLoading: false, isError: false } as { data?: { edges: GraphEdge[]; total: number; truncated: boolean }; isLoading: boolean; isError: boolean },
  beneathCalls: [] as unknown[][],
  /** The draft's change-list entry for it: what is published, and what the draft saved. */
  entry: undefined as Record<string, unknown> | undefined,
  /** The view's relationship types. */
  relTypes: [] as unknown[],
  /** Drawn or reversed, and not saved yet. */
  unsaved: false,
  /** Bringing back what the draft deleted and saved. */
  restore: vi.fn(),
  /** What the view's discovery sample says relationships of each type carry. */
  edgeKeys: {} as Record<string, string[]>,
  edgeSamples: {} as Record<string, unknown[]>,
}))

vi.mock('@/hooks/useRelationshipRecord', () => ({
  useRelationshipRecord: (ref: { id: string } | null) => ({
    record: h.record,
    entityId: h.record?.id ?? ref?.id ?? null,
    unsaved: h.unsaved,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}))
vi.mock('@/features/versioning/hooks/useEntityEditing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/versioning/hooks/useEntityEditing')>()),
  useEntityEditing: () => ({ offered: true, blocked: null }),
}))
vi.mock('@/hooks/useRelationshipRecords', () => ({
  useRelationshipRecords: () => ({ records: new Map(), deleted: new Set(), missing: new Set(), versioned: true, isLoading: true, isError: false, refetch: vi.fn() }),
}))
vi.mock('@/hooks/useRelationshipsBeneath', () => ({
  useRelationshipsBeneath: (...args: unknown[]) => {
    h.beneathCalls.push(args)
    return args[3] ? h.beneath : { data: undefined, isLoading: false, isError: false }
  },
}))
vi.mock('../useDrawerHistoryScope', () => ({ useDrawerHistoryScope: () => h.scope }))
vi.mock('@/features/versioning/hooks/useVersioning', () => ({
  useChangeEntry: () => ({ data: h.entry }),
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
  EntityHistory: ({ entityId, onRestore }: { entityId: string; onRestore?: () => void }) => (
    <div data-testid="entity-history">{entityId}{onRestore && <button type="button" onClick={onRestore}>Restore it</button>}</div>
  ),
}))
vi.mock('@/features/versioning/canvas/useRestoreGhost', () => ({ useRestoreGhost: () => h.restore }))
vi.mock('@/components/canvas/search/builder/useDiscovery', () => ({
  useDiscovery: () => ({ keysByEdgeType: h.edgeKeys, getEdgeValueSamples: (_type: string, key: string) => h.edgeSamples[key] ?? [] }),
}))
vi.mock('@/features/versioning/components/WatchButtons', () => ({
  RelationshipWatchButton: (p: { graphId: string; edgeId: string; name: string }) =>
    <button type="button">Watch {p.name} ({p.edgeId} in {p.graphId})</button>,
}))
vi.mock('@/hooks/useViewSchema', () => ({
  useViewRelationshipTypes: () => h.relTypes,
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
  h.beneath = { data: undefined, isLoading: false, isError: false }
  h.beneathCalls = []
  h.entry = undefined
  h.relTypes = []
  h.unsaved = false
  h.restore = vi.fn()
  h.edgeKeys = {}
  h.edgeSamples = {}
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

  it('edits a property where it is read: staged at once, and nothing left staged once it is put back', async () => {
    const user = userEvent.setup()
    setup(rel('e1'))
    render(<RelationshipDrawer canEdit />)
    await user.click(screen.getByRole('button', { name: 'Edit owner' }))
    const field = screen.getByRole('textbox', { name: 'owner' })
    await user.clear(field)
    await user.type(field, 'bo{Enter}')
    expect(useStagedChangesStore.getState().changes).toMatchObject([{
      type: 'edit_edge', targetId: 'e1',
      before: { properties: { owner: 'ana' }, version: 'v9' },
      after: { properties: { owner: 'bo' } },
    }])
    expect(screen.getByText('Edited')).toBeInTheDocument()
    expect(screen.getByText('1 not saved yet')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Revert owner' }))
    expect(useStagedChangesStore.getState().changes).toEqual([])
  })

  it('says what the draft changed against what is published, saved or not yet', () => {
    h.entry = { status: 'modified', before: { properties: { owner: 'ana', sla: '1h' } }, after: { properties: { owner: 'ana' } } }
    setup(rel('e1'))
    render(<RelationshipDrawer canEdit />)
    expect(screen.getByText('Removed')).toBeInTheDocument()
    expect(screen.getByText('In this draft')).toBeInTheDocument()
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

  it('keeps a roll-up read-only and says why', () => {
    h.record = { ...h.record!, edgeType: 'AGGREGATED' }
    setup(rel('e1', 'AGGREGATED'))
    render(<RelationshipDrawer canEdit onDeleteEdge={vi.fn()} onReverseEdge={vi.fn()} />)
    expect(screen.queryByRole('tab', { name: /^Edit/ })).not.toBeInTheDocument()
    expect(screen.queryByTitle('Delete relationship')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reverse direction' })).not.toBeInTheDocument()
    expect(screen.getByText(/aggregation job/)).toBeInTheDocument()
  })

  it.each([
    ['a hierarchy link', 'CONTAINS', /Move to/],
    ['a relationship not drawn on the canvas', 'OWNED_BY', /not drawn on the canvas/],
  ])('edits the properties of %s — only those — and says so', async (_what, type, note) => {
    const user = userEvent.setup()
    h.record = { ...h.record!, edgeType: type }
    h.relTypes = type === 'OWNED_BY' ? [{ id: 'OWNED_BY', name: 'Owned by', sourceTypes: [], targetTypes: [], isLineage: false }] : []
    setup(rel('e1', type), { canvasEdges: [edge('e1', 'a', 'b', type)] })
    render(<RelationshipDrawer canEdit onDeleteEdge={vi.fn()} onReverseEdge={vi.fn()} />)
    expect(screen.getByText(note)).toBeInTheDocument()
    expect(screen.queryByTitle('Delete relationship')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reverse direction' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Edit owner' }))
    const field = screen.getByRole('textbox', { name: 'owner' })
    await user.clear(field)
    await user.type(field, 'bo{Enter}')
    expect(useStagedChangesStore.getState().changes).toMatchObject([{ type: 'edit_edge', targetId: 'e1', after: { properties: { owner: 'bo' } } }])
    expect(screen.getByRole('tab', { name: /^Edit/ })).toBeInTheDocument()
  })

  it('on the published graph, offers a draft instead of Edit — in its top line, its tip saying why', async () => {
    const user = userEvent.setup()
    const onStartEditing = vi.fn()
    setup(rel('e1'))
    render(<RelationshipDrawer canEdit={false} onStartEditing={onStartEditing} onReverseEdge={vi.fn()} />)
    expect(screen.queryByRole('tab', { name: /^Edit/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reverse direction' })).not.toBeInTheDocument()
    const edit = screen.getByRole('button', { name: 'Edit in a draft' })
    expect(edit.closest('div')).toContainElement(screen.getByRole('button', { name: 'Close relationship details' }))
    expect(screen.queryByText(/^Published — open a draft/)).not.toBeInTheDocument()
    await user.hover(edit)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Published — open a draft to change this relationship')
    await user.click(edit)
    expect(onStartEditing).toHaveBeenCalled()
  })

  it('on the published graph with no draft to open here, says so in a notice', () => {
    setup(rel('e1'))
    render(<RelationshipDrawer canEdit={false} />)
    expect(screen.getByText('Published — open a draft to change this relationship.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit in a draft' })).not.toBeInTheDocument()
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
    expect(screen.queryByRole('button', { name: /^Watch/ })).not.toBeInTheDocument()
  })

  it('offers Watch among its actions, by its id and named by its ends', () => {
    setup(rel('e1'))
    render(<RelationshipDrawer />)
    expect(screen.getByRole('button', { name: 'Watch Orders → Revenue (e1 in g)' })).toBeInTheDocument()
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

  it('reverses through the canvas with what it holds, and closes', async () => {
    const user = userEvent.setup()
    const onReverseEdge = vi.fn()
    setup(rel('e1'))
    render(<RelationshipDrawer canEdit onReverseEdge={onReverseEdge} />)
    await user.click(screen.getByRole('button', { name: 'Reverse direction' }))
    // The canvas line carries no properties: the drawer hands over its own read.
    expect(onReverseEdge).toHaveBeenCalledWith('e1', { properties: { owner: 'ana' }, confidence: 0.9 })
    expect(useCanvasStore.getState().drawerEdge).toBeNull()
  })

  it('reversing it keeps its staged edit — what is shown is what goes', async () => {
    const user = userEvent.setup()
    const onReverseEdge = vi.fn()
    useStagedChangesStore.getState().stage({ type: 'edit_edge', targetId: 'e1', before: { properties: { owner: 'ana' } }, after: { properties: { owner: 'bo' } }, summary: 'Edit' })
    setup(rel('e1'))
    render(<RelationshipDrawer canEdit onReverseEdge={onReverseEdge} />)
    await user.click(screen.getByRole('button', { name: 'Reverse direction' }))
    expect(onReverseEdge).toHaveBeenCalledWith('e1', { properties: { owner: 'bo' }, confidence: 0.9 })
  })

  it('says where it is reversed that it is saved as a new relationship, its history starting over', async () => {
    const user = userEvent.setup()
    setup(rel('e1'))
    render(<RelationshipDrawer canEdit onReverseEdge={vi.fn()} />)
    await user.hover(screen.getByRole('button', { name: 'Reverse direction' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/new relationship.*properties go with it.*history starts over/)
  })
})

/** A relationship not saved yet — drawn on the canvas, or reversed — is given properties as a new
 *  entity is: they ride on the change that makes it, and are sent with its create. */
describe('RelationshipDrawer — a relationship not saved yet', () => {
  const steward = { id: 'steward', name: 'Steward', type: 'string', required: true, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 0 }
  const drawn = () => {
    h.unsaved = true
    h.record = undefined
    h.relTypes = [{ id: 'FLOWS_TO', name: 'Feeds', sourceTypes: [], targetTypes: [], isLineage: true, fields: [steward] }]
    useStagedChangesStore.getState().stage({ type: 'create_edge', targetId: 'tmp', after: { edgeType: 'FLOWS_TO', source: 'a', target: 'b' }, summary: 'Create FLOWS_TO edge a → b' })
    setup(rel('tmp'), { canvasEdges: [edge('tmp', 'a', 'b')] })
  }

  it('is given properties in the drawer — staged on its create — and still says what publishing needs', async () => {
    const user = userEvent.setup()
    drawn()
    render(<RelationshipDrawer canEdit />)
    expect(screen.getByText(/Not saved yet/)).toHaveTextContent('Feeds relationships need Steward before they can be published.')
    expect(screen.queryByText(/to add properties/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('entity-history')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add properties' }))
    await user.type(screen.getByPlaceholderText('Property name'), 'tier')
    await user.type(screen.getByPlaceholderText('Enter a value…'), 'gold')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(useStagedChangesStore.getState().changes).toMatchObject([
      { type: 'create_edge', targetId: 'tmp', after: { edgeType: 'FLOWS_TO', source: 'a', target: 'b', properties: { tier: 'gold' } } },
    ])
    expect(screen.getByText('tier')).toBeInTheDocument()
  })

  it('a required field it lacks is a row to add it, warned of — publishing refuses a new one without it', async () => {
    const user = userEvent.setup()
    drawn()
    render(<RelationshipDrawer canEdit />)
    const missing = screen.getByRole('list', { name: 'Required fields without a value' })
    expect(missing).toHaveTextContent(/publishing refuses a new one without it/)
    await user.click(within(missing).getByRole('button', { name: 'Edit Steward' }))
    await user.type(within(missing).getByRole('textbox'), 'ana{Enter}')
    expect((useStagedChangesStore.getState().changes[0]!.after as { properties?: unknown }).properties).toEqual({ steward: 'ana' })
  })

  it('is not reversed before it is saved', () => {
    drawn()
    render(<RelationshipDrawer canEdit onReverseEdge={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Reverse direction' })).not.toBeInTheDocument()
  })
})

/** Deleted in this draft and saved, it stands on the canvas as a ghost until the draft is published —
 *  and comes back, as a deleted entity does, through the draft's restore of its changes. */
describe('RelationshipDrawer — a relationship deleted in this draft', () => {
  const ghost = () => {
    h.record = undefined
    h.summary = { ...h.summary, value: { kind: 'edge', deleted: true } }
    setup(rel('e1'), { canvasEdges: [{ ...edge('e1', 'a', 'b'), data: { edgeType: 'FLOWS_TO', isGhost: true } } as LineageEdge] })
  }

  it('says so, and brings it back from its drawer', async () => {
    const user = userEvent.setup()
    ghost()
    render(<RelationshipDrawer canEdit onDeleteEdge={vi.fn()} onReverseEdge={vi.fn()} />)
    expect(screen.getByText(/Deleted in this draft/)).toBeInTheDocument()
    expect(screen.queryByText(/could not be found/)).not.toBeInTheDocument()
    expect(screen.queryByTitle('Delete relationship')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /^Edit/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Restore' }))
    expect(h.restore).toHaveBeenCalledWith('e1')
  })

  it('brings it back from its history', async () => {
    const user = userEvent.setup()
    ghost()
    render(<RelationshipDrawer canEdit />)
    await user.click(within(screen.getByTestId('entity-history')).getByRole('button', { name: 'Restore it' }))
    expect(h.restore).toHaveBeenCalledWith('e1')
  })

  it('offers no Restore on one still there', () => {
    setup(rel('e1'))
    render(<RelationshipDrawer canEdit />)
    expect(within(screen.getByTestId('entity-history')).queryByRole('button', { name: 'Restore it' })).toBeNull()
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

  it('compares and edits its relationships as one, on the trail', async () => {
    const user = userEvent.setup()
    setup(connection)
    render(<RelationshipDrawer canEdit />)
    await user.click(screen.getByRole('button', { name: 'Compare & edit 2' }))
    const s = useCanvasStore.getState()
    expect(s.drawerEdge).toMatchObject({ kind: 'relationships', lineId: 'bundle-a->b', members: connection.kind === 'connection' ? connection.members : [] })
    expect(s.drawerHistory.entries).toHaveLength(2)
  })

  it('says so when the relationships join entities inside the two cards', () => {
    setup({ ...connection, members: [{ id: 'e1', source: 'c1', target: 'b', edgeType: 'FLOWS_TO', rollup: false }] })
    render(<RelationshipDrawer />)
    expect(screen.getByText(/join entities inside Orders and Revenue/)).toBeInTheDocument()
  })

  it('lists roll-ups apart from the relationships, says what they are, and narrows to either kind', async () => {
    const user = userEvent.setup()
    h.beneath = { data: { edges: [], total: 0, truncated: false }, isLoading: false, isError: false }
    setup({
      ...connection,
      types: ['FLOWS_TO', 'AGGREGATED'],
      members: [
        { id: 'e1', source: 'a', target: 'b', edgeType: 'FLOWS_TO', rollup: false },
        { id: 'agg1', source: 'a', target: 'b', edgeType: 'AGGREGATED', rollup: true },
      ],
    })
    render(<RelationshipDrawer />)
    const relationships = () => screen.queryByRole('list', { name: /Relationships this line stands for/ })
    const rollups = () => screen.queryByRole('list', { name: /Roll-ups this line stands for/ })
    expect(screen.getByText(/Stands for/)).toHaveTextContent('1 relationship · 1 roll-up')
    expect(within(relationships()!).getAllByRole('button')).toHaveLength(1)
    expect(within(rollups()!).getAllByRole('button')).toHaveLength(1)
    expect(screen.getByText(/Summaries the aggregation job computes/)).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: /^Relationships/ }))
    expect(relationships()).toBeInTheDocument()
    expect(rollups()).not.toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: /^Roll-ups/ }))
    expect(relationships()).not.toBeInTheDocument()
    expect(rollups()).toBeInTheDocument()
  })

  it('offers no filter when a line holds only one kind', () => {
    setup(connection)
    render(<RelationshipDrawer />)
    expect(screen.queryByRole('radiogroup', { name: 'Show' })).not.toBeInTheDocument()
  })

  it('a summary line explains how to see what it summarises when they cannot be read', () => {
    h.beneath = { data: undefined, isLoading: false, isError: true }
    setup({ ...connection, summaryOnly: true, members: [], weight: 40 })
    render(<RelationshipDrawer />)
    expect(screen.getByText(/Expand either end/)).toBeInTheDocument()
  })

  it('a line of relationships alone reads nothing more', () => {
    setup(connection)
    render(<RelationshipDrawer />)
    expect(h.beneathCalls.every((args) => args[3] === false)).toBe(true)
  })

  describe('a roll-up — the real relationships beneath it', () => {
    const beneath = (id: string, source: string, target: string, edgeType = 'FLOWS_TO'): GraphEdge =>
      ({ id, sourceUrn: source, targetUrn: target, edgeType })
    const rollupLine: DrawerEdgeTarget = {
      ...connection, id: 'agg-a->b', types: ['AGGREGATED'], weight: 14,
      members: [{ id: 'agg1', source: 'a', target: 'b', edgeType: 'AGGREGATED', rollup: true }],
    }

    it('lists them by name with the roll-up apart, and opens one on the trail', async () => {
      const user = userEvent.setup()
      h.provider = { getNodes: vi.fn(async () => [
        { urn: 'c1', displayName: 'Board pack', entityType: 'dataset' },
        { urn: 'c2', displayName: 'Revenue tile', entityType: 'dataset' },
      ]) }
      h.beneath = { data: { edges: [beneath('r1', 'c1', 'c2')], total: 1, truncated: false }, isLoading: false, isError: false }
      setup(rollupLine)
      render(<RelationshipDrawer />)
      expect(h.beneathCalls.at(-1)).toEqual(['a', 'b', false, true])
      expect(screen.getByText(/Stands for/)).toHaveTextContent('Stands for 14 flows · 1 relationship · 1 roll-up')
      const list = screen.getByRole('list', { name: /Relationships this line stands for/ })
      expect(await within(list).findByText('Board pack')).toBeInTheDocument()
      expect(within(list).getByText('Revenue tile')).toBeInTheDocument()
      expect(screen.getByRole('list', { name: /Roll-ups this line stands for/ })).toBeInTheDocument()
      expect(screen.getByText(/join entities inside Orders and Revenue/)).toBeInTheDocument()

      await user.click(within(list).getByRole('button'))
      expect(useCanvasStore.getState().drawerEdge).toMatchObject({
        kind: 'relationship', id: 'r1', source: 'c1', target: 'c2', edgeType: 'FLOWS_TO', lineId: 'agg-a->b',
      })
    })

    it('lists a relationship once when the canvas already holds it', () => {
      h.beneath = { data: { edges: [beneath('db-e1', 'a', 'b'), beneath('r2', 'c1', 'b')], total: 2, truncated: false }, isLoading: false, isError: false }
      setup({ ...rollupLine, members: [...rollupLine.members, { id: 'e1', source: 'a', target: 'b', edgeType: 'FLOWS_TO', rollup: false }] })
      render(<RelationshipDrawer />)
      const rows = within(screen.getByRole('list', { name: /Relationships this line stands for/ })).getAllByRole('button')
      expect(rows).toHaveLength(2)
      expect(screen.getByText(/Stands for/)).toHaveTextContent('2 relationships · 1 roll-up')
    })

    it('shows rows loading, and no count until it is known', () => {
      h.beneath = { data: undefined, isLoading: true, isError: false }
      setup(rollupLine)
      render(<RelationshipDrawer />)
      expect(screen.getByLabelText(/Loading the relationships/)).toBeInTheDocument()
      expect(screen.getByText(/Stands for/)).toHaveTextContent('Stands for 14 flows · 1 roll-up')
    })

    it('says when not all of them are listed', () => {
      h.beneath = { data: { edges: [beneath('r1', 'c1', 'c2')], total: 1, truncated: true }, isLoading: false, isError: false }
      setup(rollupLine)
      render(<RelationshipDrawer />)
      expect(screen.getByText(/Stands for/)).toHaveTextContent('1+ relationships')
      expect(screen.getByText(/There may be others — expand either end to narrow down/)).toBeInTheDocument()
    })

    it('falls back to the guidance when they cannot be read', () => {
      h.beneath = { data: undefined, isLoading: false, isError: true }
      setup(rollupLine)
      render(<RelationshipDrawer />)
      expect(screen.getByText(/Expand either end — or double-click the line/)).toBeInTheDocument()
      expect(screen.getByRole('list', { name: /Roll-ups this line stands for/ })).toBeInTheDocument()
    })
  })
})

/**
 * The fields its type defines, edited as an entity's are: a required one it holds no value for is a
 * row to add it in — warned of while it is new in the draft, which publishing refuses until it has
 * one — and a value a field refuses is said where it is. Never a block.
 */
describe('RelationshipDrawer — the fields its type defines', () => {
  const field = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id, name, type: 'string', required: false, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 0, ...extra,
  })
  const flowsTo = {
    id: 'FLOWS_TO', name: 'Feeds', sourceTypes: [], targetTypes: [], bidirectional: false, showLabel: false, isLineage: true,
    visual: { strokeColor: '#6366f1', strokeWidth: 2, strokeStyle: 'solid', animated: true, animationSpeed: 'normal', arrowType: 'arrow', curveType: 'bezier' },
    fields: [field('steward', 'Steward', { required: true, allowedValues: ['ana', 'bo'] }), field('tier', 'Tier', { type: 'status', allowedValues: ['gold', 'silver'] })],
  }
  const newInDraft = (properties: Record<string, unknown>) => {
    h.relTypes = [flowsTo]
    h.record = { ...h.record!, properties }
    ;(h.summary!.value as { edge: { properties: unknown } }).edge.properties = properties
    h.entry = { status: 'added', before: null, after: { properties } }
  }

  it('new in the draft: a required field it lacks is a row to add it, its allowed values a click away', async () => {
    const user = userEvent.setup()
    newInDraft({ tier: 'bronze' })
    setup(rel('e1'))
    render(<RelationshipDrawer canEdit />)
    const missing = screen.getByRole('list', { name: 'Required fields without a value' })
    expect(missing).toHaveTextContent('steward')
    expect(missing).toHaveTextContent('Steward is required for Feeds relationships — publishing refuses a new one without it')
    // The value the draft gives it that its field refuses, said where it is.
    expect(screen.getByText(/Must be one of gold, silver — “bronze” isn’t\. Publishing will refuse it\./)).toBeInTheDocument()

    await user.click(within(missing).getByRole('button', { name: 'ana' }))
    expect(useStagedChangesStore.getState().changes).toMatchObject([{
      type: 'edit_edge', targetId: 'e1', after: { properties: { tier: 'bronze', steward: 'ana' } },
    }])
    expect(screen.queryByRole('list', { name: 'Required fields without a value' })).toBeNull()
  })

  it('on one that predates the rule, offers the value without a warning — publishing refuses it no more', () => {
    h.relTypes = [flowsTo]
    setup(rel('e1'))
    render(<RelationshipDrawer canEdit />)
    const missing = screen.getByRole('list', { name: 'Required fields without a value' })
    expect(within(missing).getByRole('button', { name: 'Edit Steward' })).toHaveTextContent('Add Steward…')
    expect(missing).not.toHaveTextContent(/publishing refuses/)
  })

  it('offers nothing to add where it can’t be edited', () => {
    newInDraft({})
    setup(rel('e1'))
    render(<RelationshipDrawer />)
    expect(screen.queryByRole('list', { name: 'Required fields without a value' })).toBeNull()
  })

  it('Edit types every field of its type — optional ones too — and keeps a number a number', async () => {
    const user = userEvent.setup()
    h.relTypes = [{ ...flowsTo, fields: [...flowsTo.fields, field('rows', 'Rows', { type: 'number' })] }]
    setup(rel('e1'))
    render(<RelationshipDrawer canEdit />)
    await user.click(screen.getByRole('tab', { name: /Edit/ }))
    expect(screen.getByRole('textbox', { name: 'Steward(required)' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Tier' })).toBeInTheDocument()
    // Published before the rule: a required field it lacks is offered, not warned of.
    expect(screen.queryByText(/publishing refuses/)).not.toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Rows' }), '1,200')
    await user.tab()
    await user.click(screen.getByRole('button', { name: 'silver' }))
    await user.click(screen.getByRole('button', { name: /Stage changes/ }))
    expect(useStagedChangesStore.getState().changes).toMatchObject([{
      type: 'edit_edge', targetId: 'e1', after: { properties: { owner: 'ana', rows: 1200, tier: 'silver' } },
    }])
  })

  it('Edit warns of a required field left without a value on one new in the draft', async () => {
    const user = userEvent.setup()
    newInDraft({ tier: 'gold' })
    setup(rel('e1'))
    render(<RelationshipDrawer canEdit />)
    await user.click(screen.getByRole('tab', { name: /Edit/ }))
    expect(screen.getByText('Steward is required for Feeds relationships — publishing refuses a new one without it, or one it is emptied on.')).toBeInTheDocument()
    // One row per field: the required one is not listed again.
    expect(screen.queryByRole('list', { name: 'Required fields without a value' })).toBeNull()
  })

  it('offers the names others of its type carry as a property is added, with a value they hold', async () => {
    const user = userEvent.setup()
    h.edgeKeys = { flows_to: ['confidence', 'frequency', 'owner'] }
    h.edgeSamples = { frequency: ['daily', 'hourly'] }
    setup(rel('e1'))
    render(<RelationshipDrawer canEdit />)
    await user.click(screen.getByRole('tab', { name: /Edit/ }))
    // What it holds already, and the relationship's own fields, are not offered.
    expect(screen.queryByRole('button', { name: 'Add owner' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add confidence' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Add frequency' }))
    expect(screen.getByPlaceholderText('e.g. daily')).toBeInTheDocument()
  })
})
