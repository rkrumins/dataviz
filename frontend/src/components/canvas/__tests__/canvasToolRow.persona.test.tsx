/**
 * The Graph and Hierarchy toolbars in the Business and Technical views — one row for both, built
 * from the Context View's own tools. The Business view reads with Lineage (the Graph's), Display,
 * the Focus Lens, Trace, Properties, Import / Export and More, then Edit on Published; Select waits
 * under More. The Technical view keeps Select on the row and adds what is its own: on the Graph,
 * LOD, the Explore chip, the layout direction and Edge Details. In a draft, Undo, Redo and Review &
 * Save take Edit's place.
 *
 * The REAL canvases, mounted on a stub provider.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'

import { GraphCanvas } from '../GraphCanvas'
import { HierarchyCanvas } from '../HierarchyCanvas'
import { ProviderOverride } from '@/providers/GraphProviderContext'
import { toCanvasNode } from '@/lib/canvasNodeMapper'
import { useCanvasStore, type LineageEdge } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { useBranchStore } from '@/store/branchStore'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useAuthStore } from '@/store/auth'
import { usePersonaStore } from '@/store/persona'
import { usePreferencesStore } from '@/store/preferences'
import { useVersioningPanelStore } from '@/store/versioningPanelStore'
import { installJsdomLayout } from '@/test/canvasHarness'
import type { GraphDataProvider, GraphNode } from '@/providers/GraphDataProvider'

const ROOTS = ['orders', 'customers']

function wire(urn: string): GraphNode {
  return { urn, displayName: urn, entityType: 'table', childCount: 0, properties: {} } as unknown as GraphNode
}

const provider = {
  scopeKey: 'tool-row',
  getChildren: async () => [],
  getChildrenWithEdges: async () => ({ children: [], containmentEdges: [], lineageEdges: [], totalChildren: 0, hasMore: false, nextCursor: null }),
  getNodes: async () => ROOTS.map(wire),
  getEdges: async () => [],
  getEdgesBetween: async () => [],
  getParent: async () => null,
  getAggregatedEdges: async () => ({ aggregatedEdges: [], totalSourceEdges: 0 }),
} as unknown as GraphDataProvider

let restoreFetch: () => void = () => {}
function stubFetch() {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.includes('/versioning/resolve')) return json({ graphId: 'g1', mainBranchId: 'main', mainHeadCommitSeq: 1 })
    if (url.includes('/branches')) return json([])
    if (url.includes('/versioning/')) return json({ detail: 'not found' }, 404)
    return json(url.includes('/library') ? { viewId: 'v1', displayRules: [], savedQueries: [], canEdit: true } : {})
  }) as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = original }
}

function seed(layout: 'graph' | 'hierarchy', persona: 'business' | 'technical', draft: boolean) {
  usePersonaStore.setState({ mode: persona })
  useSchemaStore.setState({
    activeViewId: 'v1',
    schema: {
      id: 's', name: 's', version: '1',
      entityTypes: [{
        id: 'table', name: 'Table', pluralName: 'Tables', description: '', fields: [],
        visual: { icon: 'Table', color: '#6366f1', shape: 'rounded', size: 'md', borderStyle: 'solid', showInMinimap: true },
        hierarchy: { level: 0, canContain: [], canBeContainedBy: [], defaultExpanded: false, rollUpFields: [] },
        behavior: { selectable: true, draggable: true, expandable: false, traceable: false, clickAction: 'select', doubleClickAction: 'expand' },
      }],
      relationshipTypes: [], globalVisuals: {},
      containmentEdgeTypes: ['CONTAINS'], lineageEdgeTypes: ['TRANSFORMS'],
      rootEntityTypes: [], defaultViewId: 'v1',
      views: [{
        id: 'v1', name: 'View', workspaceId: 'ws', dataSourceId: 'ds',
        content: { visibleEntityTypes: [], visibleRelationshipTypes: [], defaultDepth: 3, maxDepth: 10, rootEntityTypes: [] },
        layout: { type: layout }, filters: {}, entityOverrides: {}, isDefault: true,
      }],
    },
  } as never)
  // The data source is under version control; a draft is open, or Published is.
  useBranchStore.setState({
    workspaceId: 'ws', dataSourceId: 'ds', viewId: 'v1', graphId: 'g1', currentBranchId: draft ? 'b1' : null,
  } as never)
  useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, editModeEnabled: true, versioningEnabled: true } } as never)
  useStagedChangesStore.setState({ changes: [], past: [], redoStack: [], isReviewPanelOpen: false } as never)
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
  usePreferencesStore.setState({ showCanvasEntityIds: true, showCanvasTypeBadge: true })
  useVersioningPanelStore.setState({ draftsOpen: false })
  const store = useCanvasStore.getState()
  store.forceCloseDrawer()
  store.setGraph(ROOTS.map((u) => toCanvasNode(wire(u))), [] as LineageEdge[])
  store.setHydrationPhase('complete')
  store.clearSelection()
}

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  }
}

async function mount(
  Canvas: ComponentType, layout: 'graph' | 'hierarchy', persona: 'business' | 'technical', { draft = false } = {},
) {
  installJsdomLayout()
  stubFetch()
  seed(layout, persona, draft)
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ProviderOverride value={{
          provider, isLoading: false, error: null, scopeKind: 'ready',
          workspaceId: 'ws', dataSourceId: 'ds', providerReady: true, providerVersion: 1,
        } as never}>
          <ReactFlowProvider>
            <Canvas />
          </ReactFlowProvider>
        </ProviderOverride>
      </QueryClientProvider>
    </MemoryRouter>,
  )
  await settle()
}

const toolbar = () => document.querySelector<HTMLElement>('[data-canvas-toolbar]')!
const button = (name: string | RegExp) => within(toolbar()).queryByRole('button', { name })
const graphCard = (id: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)
const hierarchyRow = (id: string) =>
  document.querySelector<HTMLElement>(`#${CSS.escape(`hierarchy-node-${id}`)} .group\\/row`)
/** Radix opens its menus on pointer events, which only user-event sends. */
async function openMore() {
  await userEvent.setup().click(button('More tools')!)
  return screen.findByRole('menu')
}
async function openDisplay() {
  fireEvent.click(button('Display')!)
  return screen.findByRole('dialog', { name: 'Display' })
}

beforeEach(() => { useCanvasStore.getState().clearSelection() })
afterEach(() => { restoreFetch() })

describe('GraphCanvas toolbar — Business view', () => {
  async function mountGraph(opts?: { draft?: boolean }) {
    await mount(GraphCanvas, 'graph', 'business', opts)
    await waitFor(() => { if (!graphCard('orders')) throw new Error('no cards yet') }, { timeout: 4000 })
  }

  it('has the reading tools, Edit, and More — where Lineage replaces Flow On / Off', async () => {
    await mountGraph()
    for (const name of ['Lineage', 'Display', /Focus Lens/, /Trace Lineage/, 'Properties', 'Import / Export', 'More tools', 'Edit']) {
      expect(button(name)).toBeInTheDocument()
    }
    expect(within(toolbar()).queryByText(/Flow (On|Off)/)).toBeNull()
  }, 20000)

  it('leaves out LOD, the Explore chip, the layout direction and Edge Details', async () => {
    await mountGraph()
    expect(screen.queryByRole('button', { name: /LOD (On|Off)/ })).toBeNull()
    expect(screen.queryByText('Explore')).toBeNull()
    expect(screen.queryByRole('button', { name: /^(LR|TB)$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edge Details' })).toBeNull()
    expect(button('Select')).toBeNull()
  }, 20000)

  it('Display has zoom, the type badge, the minimap and the dot grid — no entity IDs switch', async () => {
    await mountGraph()
    const display = await openDisplay()
    for (const name of ['Zoom in', 'Zoom out', 'Fit the graph']) {
      expect(within(display).getByRole('button', { name })).toBeInTheDocument()
    }
    expect(within(display).getByRole('switch', { name: /Show entity type badge/ })).toBeInTheDocument()
    expect(within(display).getByRole('switch', { name: /Show minimap/ })).toBeInTheDocument()
    expect(within(display).getByRole('switch', { name: /Show dot grid/ })).toBeInTheDocument()
    expect(within(display).queryByRole('switch', { name: /Show entity IDs/ })).toBeNull()
  }, 20000)

  it('the type badge switch takes the type off every card, and puts it back', async () => {
    await mountGraph()
    expect(within(graphCard('orders')!).getByText('Table')).toBeInTheDocument()
    const display = await openDisplay()
    fireEvent.click(within(display).getByRole('switch', { name: /Show entity type badge/ }))
    expect(within(graphCard('orders')!).queryByText('Table')).toBeNull()
    fireEvent.click(within(display).getByRole('switch', { name: /Show entity type badge/ }))
    expect(within(graphCard('orders')!).getByText('Table')).toBeInTheDocument()
  }, 20000)

  it('the minimap switch shows and hides the minimap', async () => {
    await mountGraph()
    usePreferencesStore.setState({ showMinimap: true })
    await settle()
    expect(document.querySelector('.react-flow__minimap')).not.toBeNull()
    const display = await openDisplay()
    fireEvent.click(within(display).getByRole('switch', { name: /Show minimap/ }))
    expect(document.querySelector('.react-flow__minimap')).toBeNull()
  }, 20000)

  it('the Edge Legend sits clear above the minimap, and comes back down when the minimap is hidden', async () => {
    usePreferencesStore.setState({ showMinimap: true })
    await mountGraph()
    // The minimap's top is 183px up (1rem, its panel's 15px margin, 152px tall); the legend clears it.
    const legend = () => screen.getByText('Edge Legend').closest<HTMLElement>('.absolute')!
    expect(legend()).toHaveClass('bottom-[12.5rem]')
    act(() => usePreferencesStore.setState({ showMinimap: false }))
    expect(legend()).toHaveClass('bottom-40')
  }, 20000)

  it('Select several waits under More, and then a plain click adds to the selection', async () => {
    await mountGraph()
    fireEvent.click(within(await openMore()).getByRole('menuitem', { name: /Select several/ }))
    fireEvent.click(graphCard('orders')!)
    fireEvent.click(graphCard('customers')!)
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['orders', 'customers'])
    // On, it stays on the row, so it can be turned off.
    fireEvent.click(button('Selecting')!)
    fireEvent.click(graphCard('orders')!)
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['orders'])
  }, 20000)

  it('"Your drafts…" in More opens the drafts manager', async () => {
    await mountGraph()
    fireEvent.click(within(await openMore()).getByRole('menuitem', { name: /^Your drafts…/ }))
    expect(useVersioningPanelStore.getState().draftsOpen).toBe(true)
  }, 20000)

  it('Trace and the Focus Lens wait for one entity; the Lens then opens on it', async () => {
    await mountGraph()
    expect(button(/Trace Lineage/)).toBeDisabled()
    expect(button(/Focus Lens/)).toBeDisabled()
    fireEvent.click(graphCard('orders')!)
    expect(button(/Trace Lineage/)).toBeEnabled()
    fireEvent.click(button(/Focus Lens/)!)
    expect(await screen.findByRole('dialog', { name: /^Connections of / })).toBeInTheDocument()
  }, 20000)

  it('Edit opens Start editing', async () => {
    await mountGraph()
    fireEvent.click(button('Edit')!)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  }, 20000)

  it('in a draft, Undo, Redo and Review & Save take Edit’s place, and Import is offered', async () => {
    await mountGraph({ draft: true })
    expect(button('Edit')).toBeNull()
    expect(button('Undo')).toBeInTheDocument()
    expect(button(/Review & Save/)).toBeInTheDocument()
    fireEvent.click(button('Import / Export')!)
    expect(await screen.findByRole('menuitem', { name: /^Import…/ })).toBeEnabled()
  }, 20000)
})

describe('GraphCanvas toolbar — Technical view', () => {
  it('keeps Select on the row with its own extras, and has no More', async () => {
    await mount(GraphCanvas, 'graph', 'technical')
    await waitFor(() => { if (!graphCard('orders')) throw new Error('no cards yet') }, { timeout: 4000 })
    for (const name of ['Lineage', 'Display', /Focus Lens/, /Trace Lineage/, 'Properties', 'Import / Export', 'Select', 'Edit']) {
      expect(button(name)).toBeInTheDocument()
    }
    expect(button('More tools')).toBeNull()
    expect(button(/LOD (On|Off)/)).toBeInTheDocument()
    expect(within(toolbar()).getByText('Explore')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^(LR|TB)$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edge Details' })).toBeInTheDocument()
  }, 20000)

  it('Display adds the entity IDs switch, the one that hides each card’s ID', async () => {
    await mount(GraphCanvas, 'graph', 'technical')
    const ids = within(await openDisplay()).getByRole('switch', { name: /Show entity IDs/ })
    expect(ids).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(ids)
    expect(usePreferencesStore.getState().showCanvasEntityIds).toBe(false)
    expect(ids).toHaveAttribute('aria-checked', 'false')
  }, 20000)
})

describe('HierarchyCanvas toolbar — Business view', () => {
  async function mountHierarchy(opts?: { draft?: boolean }) {
    await mount(HierarchyCanvas, 'hierarchy', 'business', opts)
    await waitFor(() => { if (!hierarchyRow('orders')) throw new Error('no rows yet') }, { timeout: 4000 })
  }

  it('has the reading tools, Edit, and More — and no Lineage switch, as the rows draw no lines', async () => {
    await mountHierarchy()
    for (const name of ['Display', /Focus Lens/, /Trace Lineage/, 'Properties', 'Import / Export', 'More tools', 'Edit']) {
      expect(button(name)).toBeInTheDocument()
    }
    expect(button('Lineage')).toBeNull()
    expect(button('Select')).toBeNull()
  }, 20000)

  it('names Expand and Collapse all, which were icons with no name', async () => {
    await mountHierarchy()
    // Nothing here holds anything, so Expand has nothing to open.
    expect(button('Expand next level')).toBeDisabled()
    expect(within(toolbar()).getByRole('switch', { name: 'All levels' })).toBeInTheDocument()
    expect(button('Collapse all')).toBeInTheDocument()
  }, 20000)

  it('Display has the type badge only: no zoom, no minimap, no entity IDs', async () => {
    await mountHierarchy()
    const display = await openDisplay()
    expect(within(display).getByRole('switch', { name: /Show entity type badge/ })).toBeInTheDocument()
    expect(within(display).queryByRole('button', { name: 'Zoom in' })).toBeNull()
    expect(within(display).queryByRole('switch', { name: /Show minimap/ })).toBeNull()
    expect(within(display).queryByRole('switch', { name: /Show entity IDs/ })).toBeNull()
  }, 20000)

  it('the type badge switch takes the type off every row', async () => {
    await mountHierarchy()
    expect(within(hierarchyRow('orders')!).getByText('Table')).toBeInTheDocument()
    fireEvent.click(within(await openDisplay()).getByRole('switch', { name: /Show entity type badge/ }))
    expect(within(hierarchyRow('orders')!).queryByText('Table')).toBeNull()
  }, 20000)

  it('Select several under More arms plain clicks to add', async () => {
    await mountHierarchy()
    fireEvent.click(within(await openMore()).getByRole('menuitem', { name: /Select several/ }))
    fireEvent.click(hierarchyRow('orders')!)
    fireEvent.click(hierarchyRow('customers')!)
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['orders', 'customers'])
  }, 20000)

  it('Trace waits for one row, and the Lens opens on it', async () => {
    await mountHierarchy()
    expect(button(/Trace Lineage/)).toBeDisabled()
    fireEvent.click(hierarchyRow('orders')!)
    expect(button(/Trace Lineage/)).toBeEnabled()
    fireEvent.click(button(/Focus Lens/)!)
    expect(await screen.findByRole('dialog', { name: /^Connections of / })).toBeInTheDocument()
  }, 20000)

  it('in a draft, Review & Save takes Edit’s place', async () => {
    await mountHierarchy({ draft: true })
    expect(button('Edit')).toBeNull()
    expect(button(/Review & Save/)).toBeInTheDocument()
  }, 20000)
})

describe('HierarchyCanvas toolbar — Technical view', () => {
  it('keeps Select on the row, has no More, and Display adds the entity IDs switch', async () => {
    await mount(HierarchyCanvas, 'hierarchy', 'technical')
    await waitFor(() => { if (!hierarchyRow('orders')) throw new Error('no rows yet') }, { timeout: 4000 })
    expect(button('Select')).toBeInTheDocument()
    expect(button('More tools')).toBeNull()
    expect(button('Lineage')).toBeNull()
    expect(within(await openDisplay()).getByRole('switch', { name: /Show entity IDs/ })).toBeInTheDocument()
  }, 20000)
})
