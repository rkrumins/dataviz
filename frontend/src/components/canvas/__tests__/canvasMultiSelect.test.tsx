/**
 * Several entities at once on the Graph and Hierarchy canvases — selected the way a reader selects
 * them, compared and edited in the entity drawer, and saved from Review & Save.
 *
 * The REAL canvases, mounted on a stub provider: the store is the one selection (the rings, the
 * selection bar and every bulk action read it), ⌘A selects what is on screen in one write, a
 * right-click offers the several together, Esc closes the drawer comparing them, and Backspace
 * stages a delete rather than taking the entity out of the canvas.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import { useFeaturesStore } from '@/store/features'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useAuthStore } from '@/store/auth'
import { useNotificationStore } from '@/components/ui/notifications'
import { installJsdomLayout } from '@/test/canvasHarness'
import type { GraphDataProvider, GraphNode } from '@/providers/GraphDataProvider'

const ROOTS = ['orders', 'customers', 'returns', 'invoices']

function wire(urn: string): GraphNode {
  return { urn, displayName: urn, entityType: 'table', childCount: 0, properties: {} } as unknown as GraphNode
}

const provider = {
  scopeKey: 'multi-select',
  getChildren: async () => [],
  getChildrenWithEdges: async () => ({ children: [], containmentEdges: [], lineageEdges: [], totalChildren: 0, hasMore: false, nextCursor: null }),
  getNodes: async () => ROOTS.map(wire),
  getEdges: async () => [],
  getEdgesBetween: async () => [],
  getParent: async () => null,
  getAggregatedEdges: async () => ({ aggregatedEdges: [], totalSourceEdges: 0 }),
} as unknown as GraphDataProvider

let restoreFetch: () => void = () => {}
/** Every URL the canvas asked for — a save that sent nothing is the defect. */
const requests: string[] = []

function stubFetch() {
  const original = globalThis.fetch
  requests.length = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    requests.push(url)
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    // Version control: the graph resolves; nothing else in it exists yet (drafts, history, policy).
    if (url.includes('/versioning/')) {
      return url.includes('/versioning/resolve')
        ? json({ graphId: 'g1', mainBranchId: 'main', mainHeadCommitSeq: 1 })
        : json({ detail: 'not found' }, 404)
    }
    return json(url.includes('/library') ? { viewId: 'v1', displayRules: [], savedQueries: [], canEdit: true } : {})
  }) as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = original }
}

function seed(layout: 'graph' | 'hierarchy', { draft = false } = {}) {
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
  useBranchStore.setState({
    workspaceId: draft ? 'ws' : null, dataSourceId: draft ? 'ds' : null, viewId: draft ? 'v1' : null,
    currentBranchId: draft ? 'b1' : null, graphId: draft ? 'g1' : null,
  } as never)
  useFeaturesStore.setState({ values: { ...useFeaturesStore.getState().values, editModeEnabled: draft, versioningEnabled: draft } } as never)
  useStagedChangesStore.setState({ changes: [], past: [], redoStack: [], isReviewPanelOpen: false } as never)
  useNotificationStore.setState({ notifications: [], history: [] } as never)
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
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

async function mount(Canvas: ComponentType, layout: 'graph' | 'hierarchy', opts?: { draft?: boolean }) {
  installJsdomLayout()
  stubFetch()
  seed(layout, opts)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
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

/** A card on the Graph canvas, or a row on the Hierarchy. */
const graphCard = (id: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)
const hierarchyRow = (id: string) =>
  document.querySelector<HTMLElement>(`#${CSS.escape(`hierarchy-node-${id}`)} .group\\/row`)
const selected = () => useCanvasStore.getState().selectedNodeIds
const messages = () => useNotificationStore.getState().notifications.map((n) => `${n.type}: ${n.message}`)

/** Stage one edit, open the canvas's own Review & Save, and press Save. */
async function saveOneFromTheCanvas() {
  act(() => {
    useStagedChangesStore.getState().stage({
      type: 'update_entity', targetId: 'orders', targetUrn: 'orders',
      before: { description: '' }, after: { description: 'the order book' }, summary: 'Edit orders',
    } as never)
  })
  await settle()
  fireEvent.click(screen.getByRole('button', { name: /review & save/i }))
  await settle()
  const save = await screen.findByRole('button', { name: /save 1 change/i })
  await act(async () => { fireEvent.click(save) })
  await settle()
}
const bar = () => screen.queryByRole('region', { name: /selected entities/i })

/** Count writes of the selection — ⌘A must be one, however many it selects. */
function countSelectionWrites() {
  const tally = { n: 0 }
  const off = useCanvasStore.subscribe((s, prev) => { if (s.selectedNodeIds !== prev.selectedNodeIds) tally.n += 1 })
  return { tally, off }
}

beforeEach(() => { useCanvasStore.getState().clearSelection() })
afterEach(() => { restoreFetch() })

describe('GraphCanvas — several at once', () => {
  async function mountGraph(opts?: { draft?: boolean }) {
    await mount(GraphCanvas, 'graph', opts)
    await waitFor(() => { if (!graphCard('orders')) throw new Error('no cards yet') }, { timeout: 4000 })
  }

  it('Cmd/Ctrl- and Shift-click add to the selection; a plain click selects one alone', async () => {
    await mountGraph()
    fireEvent.click(graphCard('orders')!)
    expect(selected()).toEqual(['orders'])
    fireEvent.click(graphCard('customers')!, { ctrlKey: true })
    fireEvent.click(graphCard('returns')!, { shiftKey: true })
    expect(selected()).toEqual(['orders', 'customers', 'returns'])
    fireEvent.click(graphCard('customers')!, { metaKey: true })
    expect(selected()).toEqual(['orders', 'returns'])
    fireEvent.click(graphCard('invoices')!)
    expect(selected()).toEqual(['invoices'])
  }, 20000)

  it('rings exactly what the store holds — the store is the one selection', async () => {
    await mountGraph()
    act(() => { useCanvasStore.getState().setSelection(['orders', 'returns']) })
    await settle()
    expect(graphCard('orders')!.className).toContain('selected')
    expect(graphCard('returns')!.className).toContain('selected')
    expect(graphCard('customers')!.className).not.toContain('selected')
  }, 20000)

  it('⇧-drag draws a box: what it holds becomes the selection, written once when it is let go', async () => {
    await mountGraph()
    act(() => { useCanvasStore.getState().setSelection(['orders']) })
    await settle()
    // React Flow's selection key, held: a drag on the pane draws a box instead of panning.
    await act(async () => { fireEvent.keyDown(window, { key: 'Shift' }) })
    const pane = document.querySelector<HTMLElement>('.react-flow__pane')!
    const at = (clientX: number) => ({ button: 0, isPrimary: true, pointerId: 1, clientX, clientY: 20, shiftKey: true })
    const { tally, off } = countSelectionWrites()
    await act(async () => { fireEvent.pointerDown(pane, at(5)) })
    await act(async () => { fireEvent.pointerMove(pane, at(200)) })
    await act(async () => { fireEvent.pointerMove(pane, at(400)) })
    // Nothing is written while the box is drawn.
    expect(tally.n).toBe(0)
    expect(selected()).toEqual(['orders'])
    await act(async () => { fireEvent.pointerUp(pane, at(400)) })
    await act(async () => { fireEvent.keyUp(window, { key: 'Shift' }) })
    off()
    // jsdom measures no card, so React Flow counts every card as inside the box.
    expect(new Set(selected())).toEqual(new Set(ROOTS))
    expect(tally.n).toBe(1)
  }, 20000)

  it('a click never rewrites the graph', async () => {
    await mountGraph()
    const nodes = useCanvasStore.getState().nodes
    fireEvent.click(graphCard('orders')!)
    fireEvent.click(graphCard('customers')!, { ctrlKey: true })
    await settle()
    expect(useCanvasStore.getState().nodes).toBe(nodes)
  }, 20000)

  it('names the selection in a bar that offers it to the drawer, says its gestures, and takes one out', async () => {
    await mountGraph()
    act(() => { useCanvasStore.getState().setSelection(['orders', 'customers']) })
    await settle()
    const region = bar()!
    expect(region.textContent).toContain('drag selects a box')
    // Outside a draft, the drawer reads them: "Details", not an edit it could not keep.
    fireEvent.click(within(region).getByRole('button', { name: 'Details' }))
    expect(useCanvasStore.getState().drawerNodeIds).toEqual(['orders', 'customers'])
    fireEvent.click(within(region).getByRole('button', { name: /remove customers/i }))
    expect(selected()).toEqual(['orders'])
  }, 20000)

  it('⌘A selects the cards on the canvas in ONE write', async () => {
    await mountGraph()
    const { tally, off } = countSelectionWrites()
    await act(async () => { fireEvent.keyDown(document, { key: 'a', ctrlKey: true }) })
    off()
    expect(new Set(selected())).toEqual(new Set(ROOTS))
    expect(tally.n).toBe(1)
  }, 20000)

  it('a right-click on one of several offers to compare and edit them together', async () => {
    await mountGraph()
    act(() => { useCanvasStore.getState().setSelection(['orders', 'customers', 'returns']) })
    await settle()
    fireEvent.contextMenu(graphCard('customers')!)
    fireEvent.click(await screen.findByText('Compare & edit 3…'))
    expect(useCanvasStore.getState().drawerNodeIds).toEqual(['orders', 'customers', 'returns'])
  }, 20000)

  it('Esc closes the drawer comparing several, and the selection with it', async () => {
    await mountGraph()
    act(() => {
      useCanvasStore.getState().setSelection(['orders', 'customers'])
      useCanvasStore.getState().openNodesDrawer(['orders', 'customers'])
    })
    await settle()
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(useCanvasStore.getState().drawerNodeIds).toBeNull()
    expect(selected()).toEqual([])
  }, 20000)

  it('Backspace stages the delete — the entity stays on the canvas, marked, until it is saved', async () => {
    await mountGraph({ draft: true })
    fireEvent.click(graphCard('orders')!)
    await act(async () => { fireEvent.keyDown(document, { key: 'Backspace' }) })
    await settle()
    const orders = useCanvasStore.getState().nodes.find((n) => n.id === 'orders')
    expect(orders?.data.isPending).toBe('delete')
    expect(useStagedChangesStore.getState().changes.map((c) => c.type)).toEqual(['delete_entity'])
  }, 20000)

  it('Backspace typed in the drawer deletes nothing — React Flow\'s own delete key is off', async () => {
    // The drawer owns its keys (keyboard scope), so the canvas's staged delete does not run. React
    // Flow's default Backspace did: it removed the selected entities from the canvas outright.
    await mountGraph({ draft: true })
    act(() => {
      useCanvasStore.getState().setSelection(['orders', 'customers'])
      useCanvasStore.getState().openNodesDrawer(['orders', 'customers'])
    })
    await settle()
    const inDrawer = (await screen.findAllByRole('button', { name: 'orders' }))[0]
    expect(inDrawer.closest('[data-keyboard-scope]')).not.toBeNull()
    await act(async () => { fireEvent.keyDown(inDrawer, { key: 'Backspace' }) })
    await settle()
    expect(useCanvasStore.getState().nodes.map((n) => n.id)).toEqual(ROOTS)
    expect(useStagedChangesStore.getState().changes).toEqual([])
  }, 20000)

  it('in a draft: the drawer edits them for all, and the canvas saves what was staged to the draft', async () => {
    await mountGraph({ draft: true })
    act(() => { useCanvasStore.getState().setSelection(['orders', 'customers']) })
    await settle()
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Edit 2…' }))
    expect(useCanvasStore.getState().drawerNodeIds).toEqual(['orders', 'customers'])
    // The drawer edits here — it stages for both, nothing yet changed.
    expect(await screen.findByRole('button', { name: 'Stage for 2' })).toBeDisabled()
    await saveOneFromTheCanvas()
    expect(requests.some((u) => u.includes('/graph/changes'))).toBe(true)
    expect(messages()).toContain('success: Saved to draft.')
    expect(useStagedChangesStore.getState().changes).toEqual([])
  }, 20000)

  it('in a draft with edit mode off, it reads them — and offers no edit it could not keep', async () => {
    await mountGraph({ draft: true })
    useFeaturesStore.setState({ values: { ...useFeaturesStore.getState().values, editModeEnabled: false } } as never)
    act(() => { useCanvasStore.getState().setSelection(['orders', 'customers']) })
    await settle()
    expect(within(bar()!).queryByRole('button', { name: 'Edit 2…' })).toBeNull()
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Details' }))
    await settle()
    expect(screen.queryByRole('button', { name: 'Stage for 2' })).toBeNull()
  }, 20000)
})

describe('HierarchyCanvas — several at once', () => {
  async function mountHierarchy(opts?: { draft?: boolean }) {
    await mount(HierarchyCanvas, 'hierarchy', opts)
    await waitFor(() => { if (!hierarchyRow('orders')) throw new Error('no rows yet') }, { timeout: 4000 })
  }

  // The tree sorts its roots by name: customers, invoices, orders, returns.
  it('Cmd/Ctrl-click toggles a row; Shift-click adds the rows between, as drawn', async () => {
    await mountHierarchy()
    fireEvent.click(hierarchyRow('customers')!)
    fireEvent.click(hierarchyRow('orders')!, { shiftKey: true })
    expect(selected()).toEqual(['customers', 'invoices', 'orders'])
    fireEvent.click(hierarchyRow('invoices')!, { ctrlKey: true })
    expect(selected()).toEqual(['customers', 'orders'])
    fireEvent.click(hierarchyRow('returns')!)
    expect(selected()).toEqual(['returns'])
  }, 20000)

  it('rings every selected row, and offers the several in a bar', async () => {
    await mountHierarchy()
    act(() => { useCanvasStore.getState().setSelection(['orders', 'returns']) })
    await settle()
    const ringed = (id: string) => hierarchyRow(id)!.parentElement!.className.includes('ring-offset-2')
    expect(ringed('orders')).toBe(true)
    expect(ringed('returns')).toBe(true)
    expect(ringed('customers')).toBe(false)
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Details' }))
    expect(useCanvasStore.getState().drawerNodeIds).toEqual(['orders', 'returns'])
  }, 20000)

  it('⌘A selects the rows on screen in ONE write', async () => {
    await mountHierarchy()
    const { tally, off } = countSelectionWrites()
    await act(async () => { fireEvent.keyDown(document, { key: 'a', metaKey: true }) })
    off()
    expect(selected()).toEqual(['customers', 'invoices', 'orders', 'returns'])
    expect(tally.n).toBe(1)
  }, 20000)

  it('a right-click on one of several offers to compare and edit them together', async () => {
    await mountHierarchy()
    act(() => { useCanvasStore.getState().setSelection(['orders', 'returns']) })
    await settle()
    fireEvent.contextMenu(hierarchyRow('orders')!)
    fireEvent.click(await screen.findByText('Compare & edit 2…'))
    expect(useCanvasStore.getState().drawerNodeIds).toEqual(['orders', 'returns'])
  }, 20000)

  it('locating one of several from the drawer leaves the drawer on all of them', async () => {
    await mountHierarchy()
    act(() => {
      useCanvasStore.getState().setSelection(['orders', 'returns'])
      useCanvasStore.getState().openNodesDrawer(['orders', 'returns'])
    })
    await settle()
    // The drawer's header names each one, and a click shows it on the canvas.
    const locate = (await screen.findAllByRole('button', { name: 'orders' }))[0]
    fireEvent.click(locate)
    await settle()
    expect(useCanvasStore.getState().drawerNodeIds).toEqual(['orders', 'returns'])
    expect(selected()).toEqual(['orders', 'returns'])
  }, 20000)

  it('Esc closes the drawer comparing several', async () => {
    await mountHierarchy()
    act(() => {
      useCanvasStore.getState().setSelection(['orders', 'returns'])
      useCanvasStore.getState().openNodesDrawer(['orders', 'returns'])
    })
    await settle()
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(useCanvasStore.getState().drawerNodeIds).toBeNull()
  }, 20000)

  it('in a draft: "Edit N…" edits them in the drawer, and the canvas saves what was staged', async () => {
    await mountHierarchy({ draft: true })
    act(() => { useCanvasStore.getState().setSelection(['orders', 'returns']) })
    await settle()
    // Nothing staged yet: nothing to review.
    expect(screen.getByRole('button', { name: /review & save/i })).toBeDisabled()
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Edit 2…' }))
    expect(await screen.findByRole('button', { name: 'Stage for 2' })).toBeInTheDocument()
    await saveOneFromTheCanvas()
    expect(requests.some((u) => u.includes('/graph/changes'))).toBe(true)
    expect(messages()).toContain('success: Saved to draft.')
  }, 20000)
})
