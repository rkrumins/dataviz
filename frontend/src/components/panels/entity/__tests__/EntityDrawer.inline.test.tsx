/**
 * Properties are edited where they are read: a click on a value edits it in place on the View tab,
 * Enter (or leaving it) stages it at once — there is no Stage step — and Esc puts it back. Each row
 * says what its edit did (Edited, with Revert; Removed, with Restore), the footer says how many
 * fields are staged on the entity, and Undo steps back one edit at a time.
 */
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useFeaturesStore } from '@/store/features'
import { useSchemaStore } from '@/store/schema'
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


const owner = () => ((useCanvasStore.getState().nodes[0].data.properties as Record<string, unknown>).owner)
const rowOf = (key: string) => screen.getByText(key).closest('.group') as HTMLElement

describe('EntityDrawer — properties edited in place', () => {
  it('Enter stages the edit at once, and the row and footer say so', async () => {
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    await user.click(within(rowOf('owner')).getByRole('button', { name: 'Edit owner' }))
    const field = screen.getByRole('textbox', { name: 'owner' })
    await user.clear(field)
    await user.type(field, 'bea{Enter}')

    expect(ops()).toEqual([expect.objectContaining({ op: 'update', id: 'urn:orders', payload: { properties: { owner: 'bea' } } })])
    expect(owner()).toBe('bea')
    expect(within(rowOf('owner')).getByText('Edited')).toBeInTheDocument()
    expect(screen.getByText('1 change staged')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review & Save' })).toBeInTheDocument()
  })

  it('Esc puts the value back and stages nothing', async () => {
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    await user.click(within(rowOf('owner')).getByRole('button', { name: 'Edit owner' }))
    await user.type(screen.getByRole('textbox', { name: 'owner' }), 'zzz{Escape}')
    expect(useStagedChangesStore.getState().changes).toEqual([])
    expect(screen.queryByRole('textbox', { name: 'owner' })).not.toBeInTheDocument()
  })

  it('a removed property stays listed, struck through, until Restore puts it back', async () => {
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    await user.click(within(rowOf('sla')).getByRole('button', { name: /^Delete / }))
    expect(ops()).toEqual([expect.objectContaining({ unsetProperties: ['sla'] })])
    expect(screen.getByText('Removed')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Restore/ }))
    expect(useStagedChangesStore.getState().changes).toEqual([])
    expect(screen.queryByText('Removed')).not.toBeInTheDocument()
  })

  it('Revert puts the whole entity back as it was read', async () => {
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    await user.click(within(rowOf('owner')).getByRole('button', { name: 'Edit owner' }))
    await user.type(screen.getByRole('textbox', { name: 'owner' }), '!{Enter}')
    await user.click(screen.getByRole('button', { name: 'Revert' }))
    expect(useStagedChangesStore.getState().changes).toEqual([])
    expect(owner()).toBe('ana')
  })

  it('Undo steps back one edit at a time', async () => {
    const user = userEvent.setup()
    render(<EntityDrawer canEdit />)
    for (const v of ['bea', 'cat']) {
      await user.click(within(rowOf('owner')).getByRole('button', { name: 'Edit owner' }))
      const field = screen.getByRole('textbox', { name: 'owner' })
      await user.clear(field)
      await user.type(field, `${v}{Enter}`)
    }
    act(() => { useStagedChangesStore.getState().undo() })
    expect(owner()).toBe('bea')
    expect(within(rowOf('owner')).getByText('bea')).toBeInTheDocument()
    act(() => { useStagedChangesStore.getState().undo() })
    expect(owner()).toBe('ana')
    expect(useStagedChangesStore.getState().changes).toEqual([])
  })
})
