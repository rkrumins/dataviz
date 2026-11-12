/**
 * The entity drawer in the Business view: it opens on the entity at a glance —
 * its ID, how much sits inside it, its owner — and leaves the identifier block,
 * the raw details, placement, history, Copy URN and the JSON tab to the
 * Technical view. Customize shows, hides and reorders sections and features
 * properties per type; the Technical view keeps every section in the order it
 * always had. Either leads with What changed for an entity the canvas's changes hold.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useFeaturesStore } from '@/store/features'
import { usePersonaStore } from '@/store/persona'
import { usePreferencesStore } from '@/store/preferences'
import { useSchemaStore } from '@/store/schema'
import { buildChangeSet } from '@/features/versioning/model/changeModel'

vi.mock('../../useDrawerHistoryScope', () => ({
  useDrawerHistoryScope: () => ({ wsId: undefined, graphId: null, mainBranchId: null, branchId: null }),
}))
vi.mock('@/features/versioning/hooks/useVersioning', () => ({
  useEntitySummary: () => ({ data: undefined, isLoading: false }),
  useProjectionWatermark: () => ({ data: undefined }),
  useBranches: () => ({ data: [] }),
  useChangeEntry: () => ({ isLoading: true }),
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


/** The drawer's section headings, in order — the Customize panel's own title aside. */
const headings = () => screen.getAllByRole('heading', { level: 3 })
  .map((h) => h.textContent)
  .filter((t) => t !== 'Customize details')
/** The header's Copy URN action (the ID tile's copy button shares its name). */
const copyUrnAction = () => screen.queryByText('Copy URN')

beforeEach(() => {
  usePreferencesStore.setState({ drawerLayout: { business: null, technical: null }, drawerPinnedProperties: {} })
})
afterEach(() => usePersonaStore.setState({ mode: 'technical' }))

describe('EntityDrawer — the Business view', () => {
  beforeEach(() => usePersonaStore.setState({ mode: 'business' }))

  it('opens on the entity at a glance: its ID, what is inside, and its owner', () => {
    render(<EntityDrawer />)
    expect(headings()[0]).toBe('At a glance')
    expect(screen.getByText('URN')).toBeInTheDocument()
    expect(screen.getAllByText('urn:orders').length).toBeGreaterThan(0)
    expect(screen.getByText('2 entities')).toBeInTheDocument()
    expect(screen.getByText('Owner')).toBeInTheDocument()
  })

  it('leaves the identifier block, placement, history, Copy URN and JSON to the Technical view', () => {
    render(<EntityDrawer />)
    expect(headings()).not.toContain('Identifier')
    expect(headings()).toContain('Properties')
    expect(screen.queryByRole('tab', { name: /JSON/ })).not.toBeInTheDocument()
    expect(copyUrnAction()).not.toBeInTheDocument()
  })

  it('Customize shows and reorders sections, features a property for the type, and resets', async () => {
    const user = userEvent.setup()
    render(<EntityDrawer />)
    await user.click(screen.getByRole('button', { name: 'Customize' }))
    const panel = screen.getByRole('region', { name: 'Customize details' })

    await user.click(within(panel).getByRole('button', { name: 'Show Identifier' }))
    expect(headings()).toContain('Identifier')
    await user.click(within(panel).getByRole('button', { name: 'Move At a glance down' }))
    expect(headings().slice(0, 2)).toEqual(['Properties', 'At a glance'])

    await user.selectOptions(within(panel).getByRole('combobox', { name: 'Property to feature' }), 'sla')
    await user.click(within(panel).getByRole('button', { name: 'Feature' }))
    expect(usePreferencesStore.getState().drawerPinnedProperties.dataset).toEqual(['owner', 'sla'])
    // Listed in the panel, and shown at a glance.
    expect(screen.getAllByText('Sla')).toHaveLength(2)

    await user.click(within(panel).getByRole('button', { name: 'Reset' }))
    expect(usePreferencesStore.getState().drawerLayout.business).toBeNull()
    expect(usePreferencesStore.getState().drawerPinnedProperties.dataset).toBeUndefined()
    expect(headings()[0]).toBe('At a glance')
  })
})

describe('EntityDrawer — the Technical view', () => {
  it('keeps every section in the order it always had, with Copy URN and JSON', () => {
    render(<EntityDrawer />)
    const shown = headings()
    expect(shown[0]).toBe('Identifier')
    expect(shown).not.toContain('At a glance')
    expect(shown.indexOf('Properties')).toBeGreaterThan(shown.indexOf('Identifier'))
    expect(screen.getByRole('tab', { name: /JSON/ })).toBeInTheDocument()
    expect(copyUrnAction()).toBeInTheDocument()
  })
})

describe('EntityDrawer — a changed entity', () => {
  beforeEach(() => useBranchStore.setState({ workspaceId: 'ws', graphId: 'g', activeChangeSet: buildChangeSet([{
    entityId: 'urn:orders', kind: 'node', status: 'modified', label: 'Orders', origin: { source: 'branch', branchId: 'd1' },
  }]) }))
  afterEach(() => useBranchStore.getState().reset())

  it('leads with What changed, in either view', () => {
    for (const mode of ['business', 'technical'] as const) {
      usePersonaStore.setState({ mode })
      const { unmount } = render(<EntityDrawer />)
      expect(headings()[0]).toBe('What changed')
      unmount()
    }
  })
})
