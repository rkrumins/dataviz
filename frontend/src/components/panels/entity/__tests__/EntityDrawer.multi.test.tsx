/**
 * The entity drawer on several entities: it says what is held, and for each property whether
 * they hold it alike (Same), not alike (Differs, with every value and who holds it), or only
 * some do (On 1 of 3). In a draft a change is made for all of them — set, fill where missing,
 * rename, remove, add — kept pending until "Stage", which stages each entity's own edit at once
 * (and Undo takes it back); unstaged changes hold every move of the drawer. Outside a draft it
 * compares, read-only, and offers the way into one.
 */
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useFeaturesStore } from '@/store/features'
import { convertBackendEntityType, useSchemaStore } from '@/store/schema'
import type { EntityTypeDefinition } from '@/providers/GraphDataProvider'
import { useNotificationStore } from '@/components/ui/notifications'
import { stagedChangesToOps } from '@/features/versioning/model/stagedChangesToOps'

vi.mock('../../useDrawerHistoryScope', () => ({
  useDrawerHistoryScope: () => ({ wsId: undefined, graphId: null, mainBranchId: null, branchId: null }),
}))
vi.mock('@/features/versioning/hooks/useVersioning', () => ({
  useChangeEntry: () => ({ data: undefined }),
  useEntitySummary: () => ({ data: undefined, isLoading: false }),
  useProjectionWatermark: () => ({ data: undefined }),
  useBranches: () => ({ data: [] }),
}))
const editingNow: { offered: boolean; blocked: string | null } = { offered: true, blocked: null }
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

const node = (id: string, properties: Record<string, unknown>, extra: Record<string, unknown> = {}): LineageNode =>
  ({ id, type: 'generic', position: { x: 0, y: 0 }, data: { urn: id, label: id, type: 'dataset', version: 'v1', properties, ...extra } }) as unknown as LineageNode

const IDS = ['orders', 'returns', 'refunds']
const changes = () => useStagedChangesStore.getState().changes
const ops = () => stagedChangesToOps(changes()) as unknown as Array<{ id: string; payload: { properties?: Record<string, unknown> }; unsetProperties?: string[] }>
const rowOf = (key: string) => document.querySelector<HTMLElement>(`[data-row-key="${key}"]`)!

beforeEach(() => {
  editingNow.offered = true
  editingNow.blocked = null
  useCanvasStore.setState({
    nodes: [
      node('orders', { owner: 'ana', sla: '1h', tier: 'gold' }, { description: 'Sales' }),
      node('returns', { owner: 'ana', sla: '4h' }),
      node('refunds', { owner: 'ana', sla: '1h' }),
      node('tableau', { owner: 'bo' }),
    ],
    edges: [], _nodeIndex: new Set([...IDS, 'tableau']), _edgeIndex: new Set(),
    drawerNodeId: null, drawerNodeIds: null, drawerEdge: null, drawerHistory: { entries: [], cursor: -1 },
    selectedNodeIds: [], selectedEdgeIds: [], drawerDirty: false, pendingDrawerMove: null,
  } as never)
  useCanvasStore.getState().openNodesDrawer(IDS)
  useStagedChangesStore.setState({ changes: [], past: [], redoStack: [] } as never)
  useNotificationStore.setState({ notifications: [] } as never)
  useFeaturesStore.setState({ values: { versioningEnabled: true, editModeEnabled: true } } as never)
  // As the backend sends the type (`FieldSchema`) and the schema store loads it: what each field
  // asks of a value has to survive the load for the drawer to act on it.
  useSchemaStore.setState({
    schema: {
      entityTypes: [convertBackendEntityType(datasetType())],
    },
  } as never)
})

const field = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, type: 'string', required: false, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 0, ...extra,
})
const datasetType = (): EntityTypeDefinition => ({
  id: 'dataset', name: 'Dataset', pluralName: 'Datasets', description: '',
  visual: { icon: 'Box', color: '#6366f1', shape: 'rounded', size: 'md', borderStyle: 'solid', showInMinimap: true },
  fields: [
    field('code', 'Code', { unique: true }),
    field('tier', 'Tier', { type: 'status', allowedValues: ['gold', 'silver'] }),
    field('owner', 'Owner', { required: true }),
  ],
  hierarchy: { level: 0, canContain: [], canBeContainedBy: [], defaultExpanded: false },
  behavior: { selectable: true, draggable: true, expandable: true, traceable: true, clickAction: 'select', doubleClickAction: 'expand' },
})

describe('several entities in the drawer', () => {
  it('says what is held, and how each property reads across them', () => {
    render(<EntityDrawer canEdit />)
    expect(screen.getByRole('heading', { name: '3 entities' })).toBeInTheDocument()
    expect(screen.getByText('Datasets')).toBeInTheDocument()
    expect(within(rowOf('owner')).getByText('Same')).toBeInTheDocument()
    expect(within(rowOf('sla')).getByText('Differs · 2 values')).toBeInTheDocument()
    expect(within(rowOf('tier')).getByText('On 1 of 3')).toBeInTheDocument()
    // Narrowed to the ones that differ.
    act(() => screen.getByRole('radio', { name: /^Differs/ }).click())
    expect(rowOf('sla')).not.toBeNull()
    expect(rowOf('owner')).toBeNull()
  })

  it('opens a property to show every value and who holds it, and applies one to all', async () => {
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    await user.click(within(rowOf('sla')).getByRole('button', { name: 'sla' }))
    const values = screen.getByRole('list', { name: 'Values of sla' })
    expect(within(values).getByText('1h')).toBeInTheDocument()
    expect(within(values).getByText('4h')).toBeInTheDocument()
    await user.click(within(values).getByRole('button', { name: /Show the 1 entity with this value/ }))
    expect(within(values).getByText('returns')).toBeInTheDocument()

    await user.click(within(values).getAllByRole('button', { name: 'Apply this value to all' })[0])
    await user.click(screen.getByRole('button', { name: 'Stage for 1' }))
    expect(ops().map((o) => [o.id, o.payload.properties])).toEqual([['returns', { sla: '1h' }]])
  })

  it('sets a value for all of them, staged as each entity\'s own edit — and the drawer stays open', async () => {
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    await user.click(screen.getByRole('button', { name: 'Edit sla for all' }))
    await user.type(screen.getByRole('textbox', { name: 'sla for all' }), '2h{Enter}')
    expect(screen.getByText(/1 change · 3 entities · 3 replaced/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Stage for 3' }))
    expect(changes()).toHaveLength(3)
    for (const c of changes()) expect((c.after as { properties: Record<string, unknown> }).properties.sla).toBe('2h')
    expect(screen.getByRole('heading', { name: '3 entities' })).toBeInTheDocument()
    expect(within(rowOf('sla')).getByText('Same')).toBeInTheDocument()
  })

  it('Undo on the notice takes the whole edit back', async () => {
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    await user.click(within(rowOf('tier')).getByRole('button', { name: 'Remove tier from all' }))
    await user.click(screen.getByRole('button', { name: 'Stage for 1' }))
    expect(changes()).toHaveLength(1)
    const notice = useNotificationStore.getState().notifications.at(-1)!
    expect(notice.message).toMatch(/Staged 1 change on 1 entity/)
    act(() => notice.action!.onClick())
    expect(changes()).toEqual([])
  })

  it('removes a property from all — staging only the entities that had it', async () => {
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    await user.click(within(rowOf('tier')).getByRole('button', { name: 'Remove tier from all' }))
    expect(screen.getByText('Will be removed from the 1 that hold it.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Stage for 1' }))
    expect(ops().map((o) => [o.id, o.unsetProperties])).toEqual([['orders', ['tier']]])
  })

  it('fills a property only where it is missing', async () => {
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    await user.click(within(rowOf('tier')).getByRole('button', { name: 'Fill tier where missing' }))
    await user.click(screen.getByRole('button', { name: 'Edit tier where missing' }))
    await user.type(screen.getByRole('textbox', { name: 'tier where missing' }), 'silver{Enter}')
    await user.click(screen.getByRole('button', { name: 'Stage for 2' }))
    expect(ops().map((o) => [o.id, o.payload.properties]).sort()).toEqual([['refunds', { tier: 'silver' }], ['returns', { tier: 'silver' }]])
  })

  it('renames a property — leaving alone an entity that already holds the new name, unless told to replace it', async () => {
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    await user.click(within(rowOf('tier')).getByRole('button', { name: 'Rename tier' }))
    await user.type(screen.getByRole('textbox', { name: 'Rename tier to' }), 'owner')
    expect(screen.getByText(/holds/)).toBeInTheDocument()
    await user.click(within(rowOf('tier')).getByRole('button', { name: 'Rename' }))
    expect(screen.getByText(/1 left as they are/)).toBeInTheDocument()

    await user.click(within(rowOf('sla')).getByRole('button', { name: 'Rename sla' }))
    await user.type(screen.getByRole('textbox', { name: 'Rename sla to' }), 'target{Enter}')
    await user.click(screen.getByRole('button', { name: 'Stage for 3' }))
    expect(ops().find((o) => o.id === 'returns')).toMatchObject({ payload: { properties: { target: '4h' } }, unsetProperties: ['sla'] })
    // tier stayed: orders already holds an owner.
    expect(ops().find((o) => o.id === 'orders')!.unsetProperties).toEqual(['sla'])
  })

  it('adds a property to all of them', async () => {
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    await user.click(screen.getByRole('button', { name: 'Add to all' }))
    await user.type(screen.getByPlaceholderText('Property name'), 'steward')
    await user.type(screen.getByPlaceholderText('Enter a value…'), 'finance')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(within(rowOf('steward')).getByText('New · for all')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Stage for 3' }))
    expect(ops()).toHaveLength(3)
    expect(ops().every((o) => o.payload.properties?.steward === 'finance')).toBe(true)
  })

  it('Ctrl+S (⌘S on a Mac) stages; a value no two of a type may share is never set for all', async () => {
    const user = userEvent.setup()
    useCanvasStore.getState().updateNode('orders', { properties: { owner: 'ana', sla: '1h', tier: 'gold', code: 'A1' } } as never)
    render(<EntityDrawer canEdit />)
    expect(within(rowOf('code')).getByText(/No two Datasets may share a Code/)).toBeInTheDocument()
    expect(within(rowOf('code')).queryByRole('button', { name: 'Edit code for all' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Edit sla for all' }))
    await user.type(screen.getByRole('textbox', { name: 'sla for all' }), '2h{Enter}')
    within(rowOf('sla')).getByRole('button', { name: 'sla' }).focus()
    await user.keyboard('{Control>}s{/Control}')
    expect(changes()).toHaveLength(3)
  })

  it('holds a move of the drawer while a change is not staged', async () => {
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    await user.click(within(rowOf('tier')).getByRole('button', { name: 'Remove tier from all' }))
    act(() => useCanvasStore.getState().selectNode('tableau'))
    expect(useCanvasStore.getState().drawerNodeIds).toEqual(IDS)
    expect(useCanvasStore.getState().pendingDrawerMove).not.toBeNull()
    expect(screen.getByText(/your changes to/)).toBeInTheDocument()
  })

  it('moves J / K between rows, and → opens one', async () => {
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    const owner = within(rowOf('owner')).getByRole('button', { name: 'owner' })
    owner.focus()
    await user.keyboard('j')
    expect(within(rowOf('sla')).getByRole('button', { name: 'sla' })).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('list', { name: 'Values of sla' })).toBeInTheDocument()
    await user.keyboard('k')
    expect(owner).toHaveFocus()
  })

  it('offers to compare the canvas selection when it has moved on', async () => {
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    act(() => useCanvasStore.getState().setSelection(['orders', 'tableau']))
    await user.click(screen.getByRole('button', { name: 'Compare those 2' }))
    expect(useCanvasStore.getState().drawerNodeIds).toEqual(['orders', 'tableau'])
    expect(screen.getByRole('heading', { name: '2 entities' })).toBeInTheDocument()
  })

  it('outside a draft, compares read-only and offers a draft', async () => {
    const user = userEvent.setup()
    const onStartEditing = vi.fn()
    render(<EntityDrawer canEdit={false} onStartEditing={onStartEditing} />)
    expect(screen.queryByRole('button', { name: 'Edit sla for all' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Stage for/ })).toBeNull()
    expect(within(rowOf('owner')).getByText('Same')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit in a draft' }))
    expect(onStartEditing).toHaveBeenCalled()
  })
  it('in a draft this person can only view, says so — not that changes are kept in a draft', () => {
    editingNow.blocked = null
    render(<EntityDrawer canEdit={false} onStartEditing={vi.fn()} />)
    expect(screen.getByText(/You can view this draft but not change it/)).toBeInTheDocument()
    expect(screen.queryByText(/kept in a draft/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Edit in a draft' })).toBeInTheDocument()
  })
})

describe('several entities: what the fields of their type ask', () => {
  it('offers the allowed values, and warns of one publishing refuses — staged all the same', async () => {
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    const picker = within(rowOf('tier')).getByRole('group', { name: 'Allowed values of tier' })
    expect(within(rowOf('tier')).getByText('Must be one of')).toBeInTheDocument()
    await user.click(within(picker).getByRole('button', { name: 'silver' }))
    expect(within(rowOf('tier')).queryByRole('status')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Edit sla for all' }))
    await user.type(screen.getByRole('textbox', { name: 'sla for all' }), '2h{Enter}')
    // A value it doesn't allow: said, not blocked.
    await user.click(within(rowOf('tier')).getByRole('button', { name: 'Undo the change to tier' }))
    await user.click(within(rowOf('tier')).getByRole('button', { name: 'Fill tier where missing' }))
    await user.click(screen.getByRole('button', { name: 'Edit tier where missing' }))
    await user.type(screen.getByRole('textbox', { name: 'tier where missing' }), 'bronze{Enter}')
    expect(within(rowOf('tier')).getByRole('status')).toHaveTextContent(
      'Must be one of gold, silver — “bronze” isn’t. Publishing will refuse it.')
    await user.click(screen.getByRole('button', { name: 'Stage for 3' }))
    expect(ops().find((o) => o.id === 'returns')?.payload.properties).toMatchObject({ tier: 'bronze', sla: '2h' })
  })

  it('warns that removing a required field leaves them unpublishable', async () => {
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    await user.click(within(rowOf('owner')).getByRole('button', { name: 'Remove owner from all' }))
    expect(within(rowOf('owner')).getByRole('status')).toHaveTextContent(/Owner is required for Datasets/)
    expect(screen.getByRole('button', { name: 'Stage for 3' })).toBeEnabled()
  })
})

describe('one entity in the drawer, several selected', () => {
  it('offers to compare them', async () => {
    const user = userEvent.setup()
    act(() => useCanvasStore.getState().openNodeDrawer('orders'))
    render(<EntityDrawer canEdit />)
    expect(screen.getByRole('heading', { name: 'orders' })).toBeInTheDocument()
    act(() => useCanvasStore.getState().setSelection(['orders', 'returns']))
    await user.click(screen.getByRole('button', { name: 'Compare them' }))
    expect(screen.getByRole('heading', { name: '2 entities' })).toBeInTheDocument()
  })
})
