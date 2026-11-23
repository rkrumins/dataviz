/**
 * In the Playground a thing's identifier (`id`) is its urn's own, kept equal to it by every save:
 * the drawer shows it read-only, with a copy button, and never offers it among the properties to
 * edit — an edit of the others keeps it as it is. Anywhere else, a property named `id` is one like
 * any other.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useFeaturesStore } from '@/store/features'
import { useSchemaStore } from '@/store/schema'
import { useWorkspacesStore } from '@/store/workspaces'
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
vi.mock('@/features/versioning/hooks/useEntityEditing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/versioning/hooks/useEntityEditing')>()),
  useEntityEditing: () => ({ offered: true, blocked: null }),
}))
vi.mock('@/features/versioning/components/EntityHistory', () => ({ EntityHistory: () => null }))
vi.mock('@/components/panels/LineageNeighbors', () => ({ LineageNeighbors: () => null }))
vi.mock('@/components/canvas/context-view/useReparentNode', () => ({ useReparentNode: () => ({ reparent: vi.fn() }) }))
vi.mock('@/features/versioning/canvas/useRestoreGhost', () => ({ useRestoreGhost: () => vi.fn() }))
vi.mock('@/providers/ViewExecutionContext', () => ({ useViewExecutionContext: () => null }))

import { EntityDrawer } from '../EntityDrawer'

const URN = 'urn:playground:orders'
const orders: LineageNode = {
  id: URN, type: 'generic', position: { x: 0, y: 0 },
  data: { urn: URN, label: 'Orders', type: 'dataset', version: 'v1', properties: { id: URN, owner: 'ana' } },
} as unknown as LineageNode

function inWorkspace(kind: 'playground' | 'standard') {
  useWorkspacesStore.setState({
    activeWorkspaceId: 'ws1',
    workspaces: [{ id: 'ws1', name: 'W', kind, dataSources: [{
      id: 'ds1', workspaceId: 'ws1', isPrimary: true, identityProperty: 'id', identityPropertySource: 'data_source',
      nameProperty: 'name', namePropertySource: 'default',
    }] }],
  } as never)
}

beforeEach(() => {
  useCanvasStore.setState({
    nodes: [structuredClone(orders)], edges: [], _nodeIndex: new Set([URN]), _edgeIndex: new Set(),
    drawerNodeId: null, drawerEdge: null, drawerHistory: { entries: [], cursor: -1 },
    selectedNodeIds: [], selectedEdgeIds: [], drawerDirty: false, pendingDrawerMove: null,
  } as never)
  useCanvasStore.getState().openNodeDrawer(URN)
  useStagedChangesStore.setState({ changes: [], redoStack: [] })
  useFeaturesStore.setState({ values: { versioningEnabled: true, editModeEnabled: true } } as never)
  useSchemaStore.setState({
    schema: {
      id: 'ws', name: 'T', version: '1', views: [], defaultViewId: '', globalVisuals: {} as never,
      relationshipTypes: [], containmentEdgeTypes: [], lineageEdgeTypes: [], rootEntityTypes: ['dataset'],
      entityTypes: [{
        id: 'dataset', name: 'Dataset', pluralName: 'Datasets', visual: {} as never, behavior: {} as never,
        hierarchy: { level: 0, canContain: [], canBeContainedBy: [], defaultExpanded: false, rollUpFields: [] },
        fields: [],
      }],
    },
    activeViewId: null,
  } as never)
})

const rowOf = (key: string) => screen.getByText(key).closest('.group') as HTMLElement

describe('a Playground thing’s identifier, in its drawer', () => {
  it('is shown read-only with a copy button, and never offered among the properties to edit', async () => {
    inWorkspace('playground')
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    // Its Identifier: the urn it equals, with a copy button, and the property that holds it.
    expect(screen.getAllByText(URN).some(el => el.tagName === 'CODE')).toBe(true)
    expect(screen.getAllByRole('button', { name: 'Copy URN' }).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /Identified by id/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit id' })).toBeNull()

    // Editing another property keeps it as it is.
    await user.click(within(rowOf('owner')).getByRole('button', { name: 'Edit owner' }))
    const field = screen.getByRole('textbox', { name: 'owner' })
    await user.clear(field)
    await user.type(field, 'bea{Enter}')
    expect(stagedChangesToOps(useStagedChangesStore.getState().changes)).toEqual([
      expect.objectContaining({ op: 'update', id: URN, payload: { properties: { owner: 'bea' } } })])
    expect(useCanvasStore.getState().nodes[0].data.properties).toEqual({ id: URN, owner: 'bea' })
  })

  it('outside the Playground, is a property like any other', () => {
    inWorkspace('standard')
    render(<EntityDrawer canEdit />)
    expect(screen.getByRole('button', { name: 'Edit id' })).toBeInTheDocument()
  })
})
