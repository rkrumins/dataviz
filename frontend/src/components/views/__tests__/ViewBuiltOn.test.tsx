/**
 * ViewBuiltOn pins the FOUNDATION STACK a view rests on.
 *
 * The data layer is unchanged and still pinned here:
 *
 *   - the DATA SOURCE is free (the single-view read already resolved and
 *     named it) and must render with no request at all;
 *   - the GRAPH DATA PROVIDER and the SEMANTIC LAYER each cost one
 *     membership-gated read, so they must not fire when the caller can't
 *     have them, and must vanish silently — no "Unknown", no raw id —
 *     when they 404.
 *
 * What the presentation adds:
 *
 *   - the four layers are a CHAIN, rendered top-down from the workspace
 *     (your world) to the semantic layer (the machine), so the picture
 *     teaches the relationship the old paragraphs only asserted;
 *   - each rung carries only FACTS. The prose moved behind one disclosure,
 *     so nothing has to be read to be scanned;
 *   - a rung is a link ONLY where the destination exists AND would open
 *     for this caller. A rung without one must not look like a link;
 *   - enrichment is free-or-absent: provider health comes from the shared
 *     resolver and is omitted when it resolves to `unknown`, because
 *     "Status unknown" is exactly the non-fact this panel must never print.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const perms = new Set<string>()
let workspaces: unknown[] = []
/** Which sidebar sections this caller may reach — the same gate the routes use. */
let navAllowed = new Set<string>()
let providerStatus: { status: string; error?: string } | null = null

vi.mock('@/store/auth', () => ({
  useAnyWorkspacePermission: (p: string) => perms.has(p),
  useNavPermission: (spec: { section?: string }) => navAllowed.has(spec?.section ?? ''),
}))
vi.mock('@/store/navCatalogue', () => ({
  // The real hook returns a NavPermissionSpec; the mock only has to round-trip
  // the section key so `useNavPermission` above can answer for it.
  useSidebarSpec: (tab: string) => ({ section: tab }),
}))
vi.mock('@/store/providerStatus', () => ({
  useProviderStatus: () => providerStatus,
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
    workspaceName: 'Writes',
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
      <MemoryRouter>
        <ViewBuiltOn view={view} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** The rung whose small-caps label is `label`. Scoped to the chain: every
 *  label appears a SECOND time in the disclosure's glossary, which is the
 *  point of the disclosure. */
function rung(label: string): HTMLElement {
  const el = screen.getAllByTestId('rung-label')
    .find(n => n.textContent === label)?.closest('li')
  if (!el) throw new Error(`no rung for ${label}`)
  return el as HTMLElement
}

/** Is this layer on the chain at all? */
function hasRung(label: string): boolean {
  return screen.queryAllByTestId('rung-label').some(n => n.textContent === label)
}

beforeEach(() => {
  vi.clearAllMocks()
  perms.clear()
  workspaces = []
  navAllowed = new Set()
  providerStatus = null
})

describe('the data source — free, and always said', () => {
  it('names it without a single request', () => {
    renderBuiltOn()
    expect(within(rung('Data source')).getByText('Production Warehouse')).toBeTruthy()
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
    expect(within(rung('Graph data provider')).getByText('FalkorDB')).toBeTruthy()
  })

  it('fires nothing and shows nothing when the caller cannot read providers', () => {
    renderBuiltOn()
    expect(mockGetProvider).not.toHaveBeenCalled()
    expect(hasRung('Graph data provider')).toBe(false)
  })

  it('omits the row rather than inventing a name when the lookup 404s', async () => {
    perms.add('workspace:provider:read')
    mockGetProvider.mockRejectedValue(new Error('404'))
    const { container } = renderBuiltOn()
    await waitFor(() => expect(screen.queryByTestId('rung-skeleton-provider')).toBeNull())
    expect(hasRung('Graph data provider')).toBe(false)
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
    expect(hasRung('Semantic layer')).toBe(true)
    expect(mockGetOntology).toHaveBeenCalledWith('ont_1')
  })

  it('says nothing at all for a non-member, who has no id to look up', () => {
    perms.add('workspace:ontology:read')
    renderBuiltOn()
    expect(mockGetOntology).not.toHaveBeenCalled()
    expect(hasRung('Semantic layer')).toBe(false)
  })

  it('does not fire the lookup without the ontology read permission', () => {
    workspaces = MEMBER_WORKSPACES
    renderBuiltOn()
    expect(mockGetOntology).not.toHaveBeenCalled()
  })
})

describe('the stack reads as a stack', () => {
  it('runs workspace → data source → provider → semantic layer, in that order', async () => {
    perms.add('workspace:provider:read')
    perms.add('workspace:ontology:read')
    workspaces = MEMBER_WORKSPACES
    mockGetProvider.mockResolvedValue({
      id: 'prov_1', name: 'Prod Graph', providerType: 'falkordb',
    } as never)
    mockGetOntology.mockResolvedValue({ id: 'ont_1', name: 'Core Model', version: 3 } as never)
    renderBuiltOn()
    await screen.findByText('Core Model')

    const labels = screen.getAllByTestId('rung-label').map(n => n.textContent)
    expect(labels).toEqual([
      'Workspace', 'Data source', 'Graph data provider', 'Semantic layer',
    ])
  })

  it('omits the workspace rung rather than naming it by id', () => {
    renderBuiltOn(viewFixture({ workspaceName: undefined }))
    expect(hasRung('Workspace')).toBe(false)
    expect(screen.queryByText(/ws_1/)).toBeNull()
  })
})

describe('the prose is behind one disclosure, not in the rows', () => {
  it('keeps the rows to facts and puts every explanation under one summary', () => {
    renderBuiltOn()
    // The explanation exists…
    expect(screen.getByText('What do these mean?')).toBeTruthy()
    // …but not loose in the rung, which is what made this panel an essay.
    expect(within(rung('Data source')).queryByText(/the system this view reads/i)).toBeNull()
    expect(
      screen.getByText(/the system this view reads/i).closest('details'),
    ).toBeTruthy()
  })
})

describe('a rung navigates only where it can', () => {
  it('links the workspace for a member and leaves it plain for everyone else', () => {
    workspaces = MEMBER_WORKSPACES
    const { unmount } = renderBuiltOn()
    expect(within(rung('Workspace')).getByRole('link').getAttribute('href'))
      .toBe('/workspaces/ws_1')
    unmount()

    workspaces = []
    renderBuiltOn()
    expect(within(rung('Workspace')).queryByRole('link')).toBeNull()
  })

  it('links the data source to its own page when the caller may reach Ingestion', () => {
    workspaces = [{ id: 'ws_1', dataSources: [{ id: 'ds_1', catalogItemId: 'cat_9' }] }]
    navAllowed = new Set(['ingestion'])
    const { unmount } = renderBuiltOn()
    expect(within(rung('Data source')).getByRole('link').getAttribute('href'))
      .toBe('/datasources/cat_9')
    unmount()

    // Same source, same catalog item — but Ingestion is closed to this caller,
    // so the destination does not exist FOR THEM and must not be offered.
    navAllowed = new Set()
    renderBuiltOn()
    expect(within(rung('Data source')).queryByRole('link')).toBeNull()
  })

  it('links the semantic layer to its schema page when Schema is reachable', async () => {
    perms.add('workspace:ontology:read')
    workspaces = MEMBER_WORKSPACES
    navAllowed = new Set(['schema'])
    mockGetOntology.mockResolvedValue({ id: 'ont_1', name: 'Core Model', version: 3 } as never)
    renderBuiltOn()
    await screen.findByText('Core Model')
    expect(within(rung('Semantic layer')).getByRole('link').getAttribute('href'))
      .toBe('/schema/ont_1')
  })

  it('never links the provider — there is no page for one here', async () => {
    perms.add('workspace:provider:read')
    navAllowed = new Set(['ingestion', 'schema', 'workspaces'])
    mockGetProvider.mockResolvedValue({
      id: 'prov_1', name: 'Prod Graph', providerType: 'falkordb',
    } as never)
    renderBuiltOn()
    await screen.findByText('Prod Graph')
    expect(within(rung('Graph data provider')).queryByRole('link')).toBeNull()
  })
})

describe('enrichment: free, or absent', () => {
  it('shows provider health from the shared resolver', async () => {
    perms.add('workspace:provider:read')
    providerStatus = { status: 'ready' }
    mockGetProvider.mockResolvedValue({
      id: 'prov_1', name: 'Prod Graph', providerType: 'falkordb',
    } as never)
    renderBuiltOn()
    await screen.findByText('Prod Graph')
    expect(within(rung('Graph data provider')).getByText('Online')).toBeTruthy()
  })

  it('says nothing about health it cannot establish', async () => {
    perms.add('workspace:provider:read')
    providerStatus = null
    mockGetProvider.mockResolvedValue({
      id: 'prov_1', name: 'Prod Graph', providerType: 'falkordb',
    } as never)
    renderBuiltOn()
    await screen.findByText('Prod Graph')
    expect(within(rung('Graph data provider')).queryByText(/status unknown/i)).toBeNull()
    expect(within(rung('Graph data provider')).queryByText(/unknown/i)).toBeNull()
  })

  it('counts the semantic layer’s types, and says the version', async () => {
    perms.add('workspace:ontology:read')
    workspaces = MEMBER_WORKSPACES
    mockGetOntology.mockResolvedValue({
      id: 'ont_1',
      name: 'Core Model',
      version: 3,
      entityTypeDefinitions: { Table: {}, Column: {} },
      relationshipTypeDefinitions: { FLOWS_TO: {} },
    } as never)
    renderBuiltOn()
    await screen.findByText('Core Model')
    const semantic = rung('Semantic layer')
    expect(within(semantic).getByText('v3')).toBeTruthy()
    expect(within(semantic).getByText('2 entity types · 1 relationship')).toBeTruthy()
  })

  it('says how the data source is held, and when its data last changed', () => {
    workspaces = [{ id: 'ws_1', dataSources: [{ id: 'ds_1', sourceMode: 'managed' }] }]
    renderBuiltOn(viewFixture({ dataUpdatedAt: new Date(Date.now() - 2 * 3600_000).toISOString() }))
    expect(within(rung('Data source')).getByText(/Managed graph · Data updated 2h ago/)).toBeTruthy()
  })
})

describe('the provider rung holds its place while it resolves', () => {
  it('renders a labelled skeleton, not a gap that fills in later', async () => {
    perms.add('workspace:provider:read')
    let settle: (v: unknown) => void = () => {}
    mockGetProvider.mockReturnValue(new Promise(res => { settle = res }) as never)
    renderBuiltOn()

    // The rung is already there, already named — only the value is pending.
    expect(screen.getByTestId('rung-skeleton-provider')).toBeTruthy()
    expect(hasRung('Graph data provider')).toBe(true)

    settle({ id: 'prov_1', name: 'Prod Graph', providerType: 'falkordb' })
    expect(await screen.findByText('Prod Graph')).toBeTruthy()
    expect(screen.queryByTestId('rung-skeleton-provider')).toBeNull()
  })
})
