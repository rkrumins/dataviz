/**
 * EntityDrawer editing — what a graph owner relies on when changing an entity:
 * editing happens in a draft only (the published graph offers to open one instead of
 * pretending to save), a removed property is removed on save, a schema field and the
 * business label are stored where the backend keeps them, and reserved names the
 * reader mirrors into the bag are never offered as properties.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useFeaturesStore } from '@/store/features'
import { useSchemaStore } from '@/store/schema'
import { stagedChangesToOps } from '@/features/versioning/model/stagedChangesToOps'

vi.mock('../useDrawerHistoryScope', () => ({
  useDrawerHistoryScope: () => ({ wsId: undefined, graphId: null, mainBranchId: null, branchId: null }),
}))
vi.mock('@/features/versioning/hooks/useVersioning', () => ({
  useResolveGraph: () => ({ data: undefined, isError: false }),
  useEntityHistory: () => ({ data: undefined, isLoading: false }),
  useProjectionWatermark: () => ({ data: undefined }),
  useBranches: () => ({ data: [] }),
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
    selectedNodeIds: [], selectedEdgeIds: [],
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
    expect(screen.queryByRole('button', { name: /^Edit$/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Edit in a draft/ }))
    expect(onStartEditing).toHaveBeenCalledTimes(1)
  })

  it('shows the JSON read-only', async () => {
    render(<EntityDrawer canEdit />)
    await userEvent.click(screen.getByRole('button', { name: /JSON/ }))
    const json = screen.getByLabelText('Entity data as JSON')
    expect(json.tagName).toBe('PRE')
    expect(json.textContent).toContain('"urn:orders"')
  })
})

describe('EntityDrawer — an edit in a draft', () => {
  it('a deleted property is removed on save — named in unsetProperties', async () => {
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    await user.click(screen.getByRole('button', { name: /^Edit/ }))
    const slaRow = screen.getByText('sla').closest('.group') as HTMLElement
    await user.click(within(slaRow).getByTitle('Delete'))
    await user.click(screen.getByRole('button', { name: /Stage Changes/ }))

    expect(ops()).toEqual([{
      op: 'update', kind: 'node', id: 'urn:orders', baseVersion: 'v1', payload: {}, unsetProperties: ['sla'],
    }])
  })

  it('never offers a reserved name the reader mirrored into the bag', async () => {
    render(<EntityDrawer canEdit />)
    await userEvent.click(screen.getByRole('button', { name: /^Edit/ }))
    expect(screen.getByText('owner')).toBeInTheDocument()
    expect(screen.queryByText('childCount')).not.toBeInTheDocument()
  })

  it('stores a schema field and the business label as properties', async () => {
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    await user.click(screen.getByRole('button', { name: /^Edit/ }))
    const retention = screen.getByText('Retention').parentElement!.querySelector('input')!
    expect(retention).toHaveValue('90')
    await user.clear(retention)
    await user.type(retention, '30')
    await user.type(screen.getByPlaceholderText('Business-friendly name...'), 'Customer orders')
    await user.click(screen.getByRole('button', { name: /Stage Changes/ }))

    const [op] = ops()
    expect(op.payload).toEqual({ properties: { retention: '30', businessLabel: 'Customer orders' } })
    expect(op.unsetProperties).toBeUndefined()
  })
})
