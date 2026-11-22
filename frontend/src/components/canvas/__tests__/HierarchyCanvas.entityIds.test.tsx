/**
 * The Business/Technical toggle, seen from a Hierarchy row — as on Context View rows and Graph
 * cards. Each row's name follows the persona (a curated business name in Business, the source's
 * own name in Technical), and Technical adds the entity's ID on a line under the name, unless
 * Display settings hide the IDs.
 *
 * The REAL canvas, mounted on a stub provider.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'

import { HierarchyCanvas } from '../HierarchyCanvas'
import { ProviderOverride } from '@/providers/GraphProviderContext'
import { toCanvasNode } from '@/lib/canvasNodeMapper'
import { useCanvasStore, type LineageEdge } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { usePersonaStore } from '@/store/persona'
import { usePreferencesStore } from '@/store/preferences'
import { useWorkspacesStore } from '@/store/workspaces'
import { installJsdomLayout } from '@/test/canvasHarness'
import type { GraphDataProvider, GraphNode } from '@/providers/GraphDataProvider'

const URN = 'urn:li:dataset:orders'
/** A curated business name over the source's own. */
const ORDERS = {
  urn: URN, displayName: 'orders_v2', entityType: 'table', childCount: 0,
  properties: { businessLabel: 'Customer orders', id: 'ORD-17' },
} as unknown as GraphNode

const provider = {
  scopeKey: 'hierarchy-ids',
  getChildren: async () => [],
  getChildrenWithEdges: async () => ({ children: [], containmentEdges: [], lineageEdges: [], totalChildren: 0, hasMore: false, nextCursor: null }),
  getNodes: async () => [ORDERS],
  getEdges: async () => [],
  getEdgesBetween: async () => [],
  getParent: async () => null,
  getAggregatedEdges: async () => ({ aggregatedEdges: [], totalSourceEdges: 0 }),
} as unknown as GraphDataProvider

function seed() {
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
        layout: { type: 'hierarchy' }, filters: {}, entityOverrides: {}, isDefault: true,
      }],
    },
  } as never)
  const store = useCanvasStore.getState()
  store.setGraph([toCanvasNode(ORDERS)], [] as LineageEdge[])
  store.setHydrationPhase('complete')
}

async function mount() {
  installJsdomLayout()
  seed()
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ProviderOverride value={{
          provider, isLoading: false, error: null, scopeKind: 'ready',
          workspaceId: 'ws', dataSourceId: 'ds', providerReady: true, providerVersion: 1,
        } as never}>
          <HierarchyCanvas />
        </ProviderOverride>
      </QueryClientProvider>
    </MemoryRouter>,
  )
  await waitFor(() => { if (!row()) throw new Error('no row yet') }, { timeout: 4000 })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

/** The row's header: its type, its name and what sits under the name. */
const row = () => document.querySelector<HTMLElement>(`#${CSS.escape(`hierarchy-node-${URN}`)} .group\\/row`)
const name = () => row()!.querySelector('h4')!.textContent

afterEach(() => {
  usePersonaStore.setState({ mode: 'technical' })
  usePreferencesStore.setState({ showCanvasEntityIds: true })
  useWorkspacesStore.setState({ activeWorkspaceId: null, workspaces: [] } as never)
})

describe('HierarchyCanvas — names and IDs follow the persona', () => {
  it('Business: the business name, and no ID', async () => {
    usePersonaStore.setState({ mode: 'business' })
    await mount()
    expect(name()).toBe('Customer orders')
    expect(row()!.textContent).not.toContain(URN)
  }, 20000)

  it('Technical: the source’s own name, with its ID under it, head-truncated and named on hover', async () => {
    usePersonaStore.setState({ mode: 'technical' })
    await mount()
    expect(name()).toBe('orders_v2')
    const id = Array.from(row()!.querySelectorAll<HTMLElement>('span')).find((s) => s.textContent === URN && s.style.direction)!
    expect(id).toBeTruthy()
    expect(id.style.direction).toBe('rtl')
    await userEvent.setup().hover(id)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(`urn: ${URN}`)
  }, 20000)

  it("Technical: the data source's own identifier when it maps one", async () => {
    useWorkspacesStore.setState({
      activeWorkspaceId: 'ws',
      workspaces: [{ id: 'ws', dataSources: [{ id: 'ds', isPrimary: true, identityProperty: 'id' }] }],
    } as never)
    usePersonaStore.setState({ mode: 'technical' })
    await mount()
    expect(row()!.textContent).toContain('ORD-17')
    expect(row()!.textContent).not.toContain(URN)
  }, 20000)

  it('Technical with IDs hidden in Display settings: the name alone', async () => {
    usePersonaStore.setState({ mode: 'technical' })
    usePreferencesStore.setState({ showCanvasEntityIds: false })
    await mount()
    expect(name()).toBe('orders_v2')
    expect(row()!.textContent).not.toContain(URN)
  }, 20000)

  it('a persona flip renames the row in place', async () => {
    usePersonaStore.setState({ mode: 'technical' })
    await mount()
    expect(name()).toBe('orders_v2')
    act(() => usePersonaStore.setState({ mode: 'business' }))
    expect(name()).toBe('Customer orders')
    expect(row()!.textContent).not.toContain(URN)
  }, 20000)
})
