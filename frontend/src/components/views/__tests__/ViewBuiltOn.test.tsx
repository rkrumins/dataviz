/**
 * ViewBuiltOn pins the three facts a Context View rests on:
 *
 *   - the DATA SOURCE is free (the single-view read already resolved and
 *     named it) and must render with no request at all;
 *   - the GRAPH DATA PROVIDER and the SEMANTIC LAYER each cost one
 *     membership-gated read, so they must not fire when the caller can't
 *     have them, and must vanish silently — no "Unknown", no raw id —
 *     when they 404;
 *   - each row says in plain language WHAT the fact is, not just its name.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const perms = new Set<string>()
let workspaces: unknown[] = []

vi.mock('@/store/auth', () => ({
  useAnyWorkspacePermission: (p: string) => perms.has(p),
}))
vi.mock('@/store/workspaces', () => ({
  useWorkspacesStore: (selector: (s: unknown) => unknown) => selector({ workspaces }),
}))
vi.mock('@/services/providerService', () => ({ providerService: { get: vi.fn() } }))
vi.mock('@/services/ontologyDefinitionService', () => ({
  ontologyDefinitionService: { get: vi.fn() },
}))

import { ViewBuiltOn } from '../ViewBuiltOn'
import { providerService } from '@/services/providerService'
import { ontologyDefinitionService } from '@/services/ontologyDefinitionService'
import type { View } from '@/services/viewApiService'

const mockGetProvider = vi.mocked(providerService.get)
const mockGetOntology = vi.mocked(ontologyDefinitionService.get)

function viewFixture(overrides: Partial<View> = {}): View {
  return {
    id: 'view_1',
    name: 'Test View',
    workspaceId: 'ws_1',
    dataSourceId: 'ds_1',
    dataSourceName: 'Production Warehouse',
    providerId: 'prov_1',
    viewType: 'graph',
    config: {},
    visibility: 'workspace',
    isPinned: false,
    favouriteCount: 0,
    isFavourited: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

/** A member's workspace store row: the only place the ontology id lives. */
const MEMBER_WORKSPACES = [
  { id: 'ws_1', dataSources: [{ id: 'ds_1', ontologyId: 'ont_1' }] },
]

function renderBuiltOn(view: View = viewFixture()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ViewBuiltOn view={view} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  perms.clear()
  workspaces = []
})

describe('the data source — free, and always said', () => {
  it('names it and explains what it is, without a single request', () => {
    renderBuiltOn()
    expect(screen.getByText('Production Warehouse')).toBeTruthy()
    expect(screen.getByText(/the system this view reads/i)).toBeTruthy()
    expect(mockGetProvider).not.toHaveBeenCalled()
    expect(mockGetOntology).not.toHaveBeenCalled()
  })
})

describe('the graph data provider', () => {
  it('names it, with its engine, once the caller may read providers', async () => {
    perms.add('workspace:provider:read')
    mockGetProvider.mockResolvedValue({
      id: 'prov_1', name: 'Prod Graph', providerType: 'falkordb',
    } as never)
    renderBuiltOn()
    expect(await screen.findByText('Prod Graph')).toBeTruthy()
    expect(screen.getByText(/FalkorDB/)).toBeTruthy()
  })

  it('fires nothing and shows nothing when the caller cannot read providers', () => {
    renderBuiltOn()
    expect(mockGetProvider).not.toHaveBeenCalled()
    expect(screen.queryByText(/graph data provider/i)).toBeNull()
  })

  it('omits the row rather than inventing a name when the lookup 404s', async () => {
    perms.add('workspace:provider:read')
    mockGetProvider.mockRejectedValue(new Error('404'))
    const { container } = renderBuiltOn()
    await waitFor(() => expect(mockGetProvider).toHaveBeenCalled())
    expect(screen.queryByText(/graph data provider/i)).toBeNull()
    expect(container.textContent).not.toContain('prov_1')
    expect(container.textContent).not.toMatch(/unknown/i)
  })
})

describe('the semantic layer', () => {
  it('names it for a member, in the app’s own vocabulary', async () => {
    perms.add('workspace:ontology:read')
    workspaces = MEMBER_WORKSPACES
    mockGetOntology.mockResolvedValue({ id: 'ont_1', name: 'Core Model', version: 3 } as never)
    renderBuiltOn()
    expect(await screen.findByText('Core Model')).toBeTruthy()
    expect(screen.getByText(/semantic layer/i)).toBeTruthy()
    expect(mockGetOntology).toHaveBeenCalledWith('ont_1')
  })

  it('says nothing at all for a non-member, who has no id to look up', () => {
    perms.add('workspace:ontology:read')
    renderBuiltOn()
    expect(mockGetOntology).not.toHaveBeenCalled()
    expect(screen.queryByText(/semantic layer/i)).toBeNull()
  })

  it('does not fire the lookup without the ontology read permission', () => {
    workspaces = MEMBER_WORKSPACES
    renderBuiltOn()
    expect(mockGetOntology).not.toHaveBeenCalled()
  })
})
