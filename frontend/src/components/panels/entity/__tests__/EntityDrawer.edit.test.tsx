/**
 * EntityDrawer editing — what a graph owner relies on when changing an entity:
 * editing happens in a draft only (the published graph offers to open one instead of
 * pretending to save), a removed property is removed on save, a schema field and the
 * business label are stored where the backend keeps them, and reserved names the
 * reader mirrors into the bag are never offered as properties.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useFeaturesStore } from '@/store/features'
import { usePreferencesStore } from '@/store/preferences'
import { useSchemaStore } from '@/store/schema'
import { useWorkspacesStore } from '@/store/workspaces'
import { stagedChangesToOps } from '@/features/versioning/model/stagedChangesToOps'

vi.mock('../../useDrawerHistoryScope', () => ({
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
vi.mock('@/components/canvas/context-view/useReparentNode', () => ({ useReparentNode: () => ({ reparent: vi.fn() }) }))
vi.mock('@/features/versioning/canvas/useRestoreGhost', () => ({ useRestoreGhost: () => vi.fn() }))
vi.mock('@/providers/ViewExecutionContext', () => ({ useViewExecutionContext: () => null }))

import { EntityDrawer } from '../EntityDrawer'

const orders: LineageNode = {
  id: 'urn:orders', type: 'generic', position: { x: 0, y: 0 },
  data: {
    urn: 'urn:orders', label: 'Orders', type: 'dataset', version: 'v1', childCount: 2,
    properties: { owner: 'ana', sla: '1h', childCount: 2, retention: '90' },
  },
} as unknown as LineageNode

beforeEach(() => {
  useCanvasStore.setState({
    nodes: [structuredClone(orders)], edges: [],
    _nodeIndex: new Set(['urn:orders']), _edgeIndex: new Set(),
    drawerNodeId: null, drawerEdge: null, drawerHistory: { entries: [], cursor: -1 },
    selectedNodeIds: [], selectedEdgeIds: [], drawerDirty: false, pendingDrawerMove: null,
  } as never)
  useCanvasStore.getState().openNodeDrawer('urn:orders')
  useStagedChangesStore.setState({ changes: [], redoStack: [] })
  useFeaturesStore.setState({ values: { versioningEnabled: true, editModeEnabled: true } } as never)
  useSchemaStore.setState({
    schema: {
      id: 'ws', name: 'T', version: '1', views: [], defaultViewId: '', globalVisuals: {} as never,
      relationshipTypes: [], containmentEdgeTypes: [], lineageEdgeTypes: [], rootEntityTypes: ['dataset'],
      entityTypes: [{
        id: 'dataset', name: 'Dataset', pluralName: 'Datasets', visual: {} as never, behavior: {} as never,
        hierarchy: { level: 0, canContain: [], canBeContainedBy: [], defaultExpanded: false, rollUpFields: [] },
        fields: [{ id: 'retention', name: 'Retention', type: 'text' }] as never,
      }],
    },
    activeViewId: null,
  } as never)
})

const ops = () => stagedChangesToOps(useStagedChangesStore.getState().changes)

describe('EntityDrawer — where editing happens', () => {
  it('is read-only without canEdit, and offers to open a draft instead', async () => {
    const onStartEditing = vi.fn()
    render(<EntityDrawer onStartEditing={onStartEditing} />)
    expect(screen.queryByRole('tab', { name: /^Edit$/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Edit in a draft/ }))
    expect(onStartEditing).toHaveBeenCalledTimes(1)
  })

  it('shows the JSON read-only', async () => {
    render(<EntityDrawer canEdit />)
    await userEvent.click(screen.getByRole('tab', { name: /JSON/ }))
    const json = screen.getByRole('group', { name: 'Entity data as JSON' })
    expect(json.textContent).toContain('"urn:orders"')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})

describe('EntityDrawer — an edit in a draft', () => {
  it('a deleted property is removed on save — named in unsetProperties', async () => {
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    await user.click(screen.getByRole('tab', { name: /^Edit/ }))
    const slaRow = screen.getByText('sla').closest('.group') as HTMLElement
    await user.click(within(slaRow).getByTitle('Delete'))
    await user.click(screen.getByRole('button', { name: /Stage changes/ }))

    expect(ops()).toEqual([{
      op: 'update', kind: 'node', id: 'urn:orders', baseVersion: 'v1', payload: {}, unsetProperties: ['sla'],
    }])
  })

  it('never offers a reserved name the reader mirrored into the bag', async () => {
    render(<EntityDrawer canEdit />)
    await userEvent.click(screen.getByRole('tab', { name: /^Edit/ }))
    expect(screen.getByText('owner')).toBeInTheDocument()
    expect(screen.queryByText('childCount')).not.toBeInTheDocument()
  })

  it('stores a schema field and the business label as properties', async () => {
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    await user.click(screen.getByRole('tab', { name: /^Edit/ }))
    const retention = screen.getByLabelText('Retention')
    expect(retention).toHaveValue('90')
    await user.clear(retention)
    await user.type(retention, '30')
    await user.type(screen.getByPlaceholderText('Business-friendly name…'), 'Customer orders')
    await user.click(screen.getByRole('button', { name: /Stage changes/ }))

    const [op] = ops()
    expect(op.payload).toEqual({ properties: { retention: '30', businessLabel: 'Customer orders' } })
    expect(op.unsetProperties).toBeUndefined()
  })
})

describe("EntityDrawer — the source's own name and identity properties", () => {
  /** The canvas's data source (no view names one here: the workspace's primary) keys entities by
   *  `id`, set on its provider, and names them under `title`, set on the source itself. */
  const withProperties = (props: Record<string, unknown>) => useCanvasStore.setState((s) => ({
    nodes: s.nodes.map((n) => (n.id === 'urn:orders'
      ? { ...n, data: { ...n.data, properties: { ...(n.data.properties as object), ...props } } } : n)),
  }) as never)

  beforeEach(() => {
    const schema = useSchemaStore.getState().schema!
    useSchemaStore.setState({
      schema: { ...schema, entityTypes: [{ ...schema.entityTypes[0], fields: [
        { id: 'retention', name: 'Retention', type: 'text' },
        { id: 'title', name: 'Title', type: 'text' },
        { id: 'id', name: 'Native id', type: 'text' },
      ] as never }] },
    } as never)
    useWorkspacesStore.setState({
      activeWorkspaceId: 'ws1',
      workspaces: [{ id: 'ws1', dataSources: [{
        id: 'ds1', isPrimary: true, nameProperty: 'title', namePropertySource: 'data_source',
        identityProperty: 'id', identityPropertySource: 'provider',
      }] }],
    } as never)
    withProperties({ title: 'Orders', id: 'native-42' })
    // Open, as a reader who asked for the details sees them; the closed default has its own test.
    usePreferencesStore.setState({ drawerIdentityDetailsOpen: true })
  })
  afterEach(() => {
    useWorkspacesStore.setState({ activeWorkspaceId: null, workspaces: [] } as never)
    usePreferencesStore.setState({ drawerIdentityDetailsOpen: false })
  })

  it('show only the URN and one line naming them until asked, and remember being asked', async () => {
    expect(usePreferencesStore.getInitialState().drawerIdentityDetailsOpen).toBe(false)
    usePreferencesStore.setState({ drawerIdentityDetailsOpen: false })
    const user = userEvent.setup()
    const { unmount } = render(<EntityDrawer canEdit />)
    const line = screen.getByRole('button', { name: 'Identified by id · named by title' })
    expect(line).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByLabelText('How this data source identifies and names entities')).not.toBeInTheDocument()

    await user.click(line)
    expect(line).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText('How this data source identifies and names entities')).toBeInTheDocument()
    unmount()

    render(<EntityDrawer canEdit />)
    expect(screen.getByLabelText('How this data source identifies and names entities')).toBeInTheDocument()
  })

  it('the details say which property identifies the entity and which names it, and where each is set', () => {
    render(<EntityDrawer canEdit />)
    const facts = screen.getByLabelText('How this data source identifies and names entities')
    expect(within(facts).getByText('id')).toBeInTheDocument()
    expect(within(facts).getByText('From the provider')).toBeInTheDocument()
    expect(within(facts).getByText('native-42')).toBeInTheDocument()
    expect(within(facts).getByRole('button', { name: 'Copy id' })).toBeInTheDocument()
    expect(within(facts).getByText('title')).toBeInTheDocument()
    expect(within(facts).getByText('Set on this data source')).toBeInTheDocument()
    expect(within(facts).getByText('In step with the name — a rename carries it along')).toBeInTheDocument()
  })

  it('a setting\'s pill walks the lookup: what came before it set nothing, what follows was not needed', async () => {
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    const facts = screen.getByLabelText('How this data source identifies and names entities')
    await user.hover(within(facts).getByText('From the provider'))
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('Looked up in this order — the first that sets it wins')
    expect(tip).toHaveTextContent('This data sourcenot set')
    expect(tip).toHaveTextContent('Its providerid')
    expect(tip).toHaveTextContent('Its workspacenot needed')
  })

  it('a rename says the name property changes with it', async () => {
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    await user.click(screen.getByRole('tab', { name: /^Edit/ }))
    expect(screen.getByText(/Also saved as/)).toBeInTheDocument()
    const name = screen.getByPlaceholderText('Entity name…')
    await user.clear(name)
    await user.type(name, 'Sales')
    expect(screen.getByText(/changes to “Sales” too/)).toBeInTheDocument()
  })

  it('a rename says it leaves a name property kept apart from the name', async () => {
    withProperties({ title: 'customer_orders' })
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    await user.click(screen.getByRole('tab', { name: /^Edit/ }))
    expect(screen.getByText(/is “customer_orders”, kept apart from the name/)).toBeInTheDocument()
    const name = screen.getByPlaceholderText('Entity name…')
    await user.clear(name)
    await user.type(name, 'Sales')
    expect(screen.getByText(/stays “customer_orders”/)).toBeInTheDocument()
  })

  it('are not offered as fields of their own: the server keeps them in step with the Name and the urn', async () => {
    render(<EntityDrawer canEdit />)
    await userEvent.click(screen.getByRole('tab', { name: /^Edit/ }))
    expect(screen.getByLabelText('Retention')).toBeInTheDocument()
    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Native id')).not.toBeInTheDocument()
  })

  /** Rename Orders to Sales, stage it, and read the View tab's details. */
  const stageRename = async () => {
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    await user.click(screen.getByRole('tab', { name: /^Edit/ }))
    const name = screen.getByPlaceholderText('Entity name…')
    await user.clear(name)
    await user.type(name, 'Sales')
    await user.click(screen.getByRole('button', { name: /Stage changes/ }))
    await user.click(screen.getByRole('tab', { name: /^View/ }))
    return screen.getByLabelText('How this data source identifies and names entities')
  }

  it('a staged rename: the details say what saving stores, not that the two differ', async () => {
    const facts = await stageRename()
    expect(within(facts).getByText('Orders')).toBeInTheDocument()
    expect(within(facts).getByText('Becomes “Sales” when saved')).toBeInTheDocument()
    expect(facts).not.toHaveTextContent('Kept apart')
  })

  it('a staged rename leaves a name property kept apart as it is', async () => {
    withProperties({ title: 'customer_orders' })
    const facts = await stageRename()
    expect(within(facts).getByText('customer_orders')).toBeInTheDocument()
    expect(within(facts).getByText('Kept apart from the name — a rename leaves it')).toBeInTheDocument()
    expect(facts).not.toHaveTextContent('when saved')
  })

  it('a saved entity without them gets them on its next save', () => {
    useCanvasStore.setState((s) => ({ nodes: s.nodes.map((n) => ({ ...n, data: { ...n.data, properties: {} } })) }) as never)
    render(<EntityDrawer canEdit />)
    const facts = screen.getByLabelText('How this data source identifies and names entities')
    expect(within(facts).getAllByText('Not set')).toHaveLength(2)
    expect(within(facts).getByText('Set to its URN on its next save')).toBeInTheDocument()
    expect(within(facts).getByText('Set from the name on its next save')).toBeInTheDocument()
  })

  it('an entity not saved yet is promised only what the server fills in', () => {
    useCanvasStore.setState((s) => ({
      nodes: s.nodes.map((n) => ({ ...n, data: { ...n.data, isPending: 'create', properties: {} } })),
    }) as never)
    const mapped = (nameProperty: string, identityProperty: string) => useWorkspacesStore.setState({
      workspaces: [{ id: 'ws1', dataSources: [{ id: 'ds1', isPrimary: true, nameProperty, identityProperty }] }],
    } as never)
    const facts = () => screen.getByLabelText('How this data source identifies and names entities')

    // A name property the platform owns is never written.
    mapped('description', 'id')
    const { unmount } = render(<EntityDrawer canEdit />)
    expect(facts()).toHaveTextContent('Set to its URN when saved')
    expect(facts()).not.toHaveTextContent('Set from the name when saved')
    unmount()

    // An identifier that is also the name property is written as the name, not the urn.
    mapped('title', 'title')
    render(<EntityDrawer canEdit />)
    expect(facts()).not.toHaveTextContent('Set to its URN when saved')
    expect(within(facts()).getAllByText('Set from the name when saved')).toHaveLength(2)
  })
})
