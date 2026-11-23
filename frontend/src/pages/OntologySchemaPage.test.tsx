/**
 * OntologySchemaPage — edit-model regression tests.
 *
 * Covers the four historic edit-loss/staleness bugs:
 *  D1 — a FAILED save from the navigation blocker must NOT navigate away
 *  D2 — blocker "Discard" proceeds once, with working copies cleared
 *  D3 — clearing the description round-trips (empty string is sent)
 *  D4 — reverting a staged change back to identical clears the dirty state
 *
 * Heavy child panels are mocked to tiny prop-driven stubs so the tests drive
 * the PAGE's staging/saving/navigation logic, not the panels' internals.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Service / hook mocks ───────────────────────────────────────────────

const updateMock = vi.fn()

const ONTOLOGY = {
  id: 'bp_1',
  schemaId: 'bp_1',
  name: 'Test Layer',
  description: 'Original description',
  version: 1,
  revision: 0,
  evolutionPolicy: 'reject',
  isPublished: false,
  isSystem: false,
  scope: 'universal',
  deletedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  containmentEdgeTypes: [],
  lineageEdgeTypes: [],
  edgeTypeMetadata: {},
  entityTypeHierarchy: {},
  rootEntityTypes: [],
  entityTypeDefinitions: { Server: { name: 'Server' }, Rack: { name: 'Rack' } },
  relationshipTypeDefinitions: { HOSTS: { name: 'Hosts', is_containment: false, is_lineage: true } },
}

const OTHER = { ...ONTOLOGY, id: 'bp_2', schemaId: 'bp_2', name: 'Other Layer' }

vi.mock('@/features/ontology/hooks/useOntologies', () => ({
  ONTOLOGY_KEYS: { all: ['ontologies'] },
  useOntologies: () => ({ data: [ONTOLOGY, OTHER], isLoading: false }),
  useOntology: (id?: string) => ({ data: id === 'bp_2' ? OTHER : id === 'bp_1' ? ONTOLOGY : undefined }),
  useOntologyAssignments: () => ({ data: [], isLoading: false, refetch: vi.fn() }),
}))

vi.mock('@/features/ontology/hooks/useOntologyMutations', () => ({
  useOntologyMutations: () => ({
    update: { mutateAsync: updateMock },
    create: { mutateAsync: vi.fn() },
    remove: { mutateAsync: vi.fn() },
    publish: { mutateAsync: vi.fn() },
    clone: { mutateAsync: vi.fn() },
    createNewVersion: { mutateAsync: vi.fn() },
    validate: { mutateAsync: vi.fn() },
    invalidateAll: vi.fn(),
  }),
}))

const ACCESS = {
  canEdit: true, canImport: true, canExport: true, canSuggest: true,
  canSeeHistory: true, canPublish: true, editingBlockedBy: null,
  canCreate: true, canImportNew: true, createBlockedBy: null as string | null, cloneBlockedBy: null as string | null,
}
let access = { ...ACCESS }
vi.mock('@/features/ontology/lib/useSemanticLayerAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/ontology/lib/useSemanticLayerAccess')>()),
  useSemanticLayerAccess: () => access,
}))

vi.mock('@/hooks/useGraphSchema', () => ({
  useInvalidateGraphSchema: () => vi.fn(),
}))

vi.mock('@/store/workspaces', () => {
  const state = {
    workspaces: [],
    activeWorkspaceId: null,
    activeDataSourceId: null,
    setActiveWorkspace: vi.fn(),
    setActiveDataSource: vi.fn(),
    loadWorkspaces: vi.fn().mockResolvedValue(undefined),
  }
  return { useWorkspacesStore: (sel: (s: typeof state) => unknown) => sel(state) }
})

vi.mock('@/features/ontology/lib/ontology-utils', () => ({
  fetchSchemaStats: vi.fn().mockResolvedValue({ entityTypeStats: [], edgeTypeStats: [], tagStats: [] }),
  fetchSchemaStatsWithMeta: vi.fn().mockResolvedValue({ stats: { entityTypeStats: [], edgeTypeStats: [], tagStats: [] }, meta: {} }),
  generateSuggestedName: () => 'Suggested',
  triggerIntrospectionRefresh: vi.fn(),
}))

vi.mock('@/services/ontologyDefinitionService', () => ({
  ontologyDefinitionService: {
    restore: vi.fn(), suggest: vi.fn(), exportJson: vi.fn(),
    importNew: vi.fn(), importInto: vi.fn(), impact: vi.fn(),
    getAssignments: vi.fn().mockResolvedValue([]),
  },
}))

const updateDataSourceMock = vi.fn()
vi.mock('@/services/workspaceService', () => ({
  workspaceService: { updateDataSource: (...a: unknown[]) => updateDataSourceMock(...a) },
}))

// ─── Heavy children → prop-driven stubs ────────────────────────────────

vi.mock('@/features/ontology/components/OntologySidebar', () => ({
  OntologySidebar: (props: { canManage?: boolean; createBlockedReason?: string | null }) => (
    <div data-testid="sidebar">
      {props.canManage && <span data-testid="sidebar-create">{props.createBlockedReason ?? 'create offered'}</span>}
    </div>
  ),
}))

vi.mock('@/features/ontology/components/OntologyDetailHeader', () => ({
  OntologyDetailHeader: (props: {
    hasPendingChanges: boolean
    onSave: () => void
    onDiscard: () => void
  }) => (
    <div>
      {props.hasPendingChanges && <span data-testid="dirty-marker">dirty</span>}
      <button onClick={props.onSave}>header-save</button>
      <button onClick={props.onDiscard}>header-discard</button>
    </div>
  ),
}))

vi.mock('@/features/ontology/components/panels/SchemaPanel', () => ({
  SchemaPanel: (props: {
    onDeleteEntity: (id: string, name: string) => void
    onRestoreEntity?: (id: string) => void
    removedEntityTypes?: Array<{ id: string }>
  }) => (
    <div>
      <button onClick={() => props.onDeleteEntity('Server', 'Server')}>stage-delete-server</button>
      <button onClick={() => props.onRestoreEntity?.('Server')}>restore-server</button>
      <span data-testid="removed-count">{props.removedEntityTypes?.length ?? 0}</span>
    </div>
  ),
}))

vi.mock('@/features/ontology/components/panels/SettingsPanel', () => ({
  SettingsPanel: (props: {
    onUpdateDetails: (d: { name: string; description: string; evolutionPolicy: string }) => void
  }) => (
    <button onClick={() => props.onUpdateDetails({ name: 'Test Layer', description: '', evolutionPolicy: 'reject' })}>
      clear-description
    </button>
  ),
}))

// Panels/dialogs that are irrelevant to the edit model → render nothing.
vi.mock('@/features/ontology/components/panels/OverviewPanel', () => ({ OverviewPanel: () => null }))
vi.mock('@/features/ontology/components/panels/HierarchyPanel', () => ({ HierarchyPanel: () => null }))
vi.mock('@/features/ontology/components/panels/CoveragePanel', () => ({ CoveragePanel: () => null }))
vi.mock('@/features/ontology/components/panels/UsagePanel', () => ({ UsagePanel: () => null }))
vi.mock('@/features/ontology/components/panels/VersionHistoryPanel', () => ({ VersionHistoryPanel: () => null }))
vi.mock('@/features/ontology/components/panels/DeploymentDashboardPanel', () => ({
  DeploymentDashboardPanel: (props: {
    onBulkUnassign?: (entries: Array<{ workspaceId: string; dataSourceId: string; dataSourceLabel: string }>) => void
    onCreateDraft?: () => void
    createBlockedReason?: string | null
  }) => (
    <>
      <button onClick={() => props.onBulkUnassign?.([
        { workspaceId: 'ws1', dataSourceId: 'ds1', dataSourceLabel: 'Source A' },
        { workspaceId: 'ws1', dataSourceId: 'ds2', dataSourceLabel: 'Source B' },
      ])}>
        bulk-unassign-two
      </button>
      {props.onCreateDraft && <span data-testid="hero-create">{props.createBlockedReason ?? 'create offered'}</span>}
    </>
  ),
}))
vi.mock('@/features/ontology/components/panels/AdoptionMatchSection', () => ({ AdoptionMatchSection: () => null }))
vi.mock('@/features/ontology/components/dialogs/SuggestConfirmDialog', () => ({ SuggestConfirmDialog: () => null }))
vi.mock('@/features/ontology/components/dialogs/ImportDialog', () => ({ ImportDialog: () => null }))
vi.mock('@/features/ontology/components/dialogs/AssignmentManagerDialog', () => ({ AssignmentManagerDialog: () => null }))
vi.mock('@/features/ontology/components/dialogs/CreateOntologyDialog', () => ({ CreateOntologyDialog: () => null }))
vi.mock('@/features/ontology/components/dialogs/DeleteConfirmDialog', () => ({ DeleteConfirmDialog: () => null }))
vi.mock('@/features/ontology/components/dialogs/UnassignConfirmDialog', () => ({ UnassignConfirmDialog: () => null }))
vi.mock('@/features/ontology/components/dialogs/PublishConfirmDialog', () => ({ PublishConfirmDialog: () => null }))
vi.mock('@/features/ontology/components/dialogs/ChangesReviewDialog', () => ({ ChangesReviewDialog: () => null }))
vi.mock('@/components/schema/EntityTypeEditor', () => ({ EntityTypeEditor: () => null }))
vi.mock('@/components/schema/RelationshipTypeEditor', () => ({ RelationshipTypeEditor: () => null }))
vi.mock('@/features/ontology/components/EvalContextBar', () => ({ EvalContextBar: () => null }))
vi.mock('@/features/ontology/components/DataSourcePicker', () => ({ DataSourcePicker: () => null }))

import { OntologySchemaPage } from './OntologySchemaPage'

// ─── Harness ────────────────────────────────────────────────────────────

function renderPage(initialPath = '/schema/bp_1?tab=schema') {
  const router = createMemoryRouter(
    [
      { path: '/schema/:ontologyId?', element: <OntologySchemaPage /> },
      { path: '/elsewhere', element: <div>elsewhere page</div> },
    ],
    { initialEntries: [initialPath] },
  )
  render(<RouterProvider router={router} />)
  return router
}

async function stageDelete(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText('stage-delete-server'))
  await screen.findByTestId('dirty-marker')
}

beforeEach(() => {
  updateMock.mockReset()
  access = { ...ACCESS }
})

// ─── Tests ──────────────────────────────────────────────────────────────

describe('OntologySchemaPage edit model', () => {
  it('D4: reverting a staged change back to identical clears the dirty state', async () => {
    const user = userEvent.setup()
    renderPage()

    expect(screen.queryByTestId('dirty-marker')).toBeNull()
    await stageDelete(user)
    expect(screen.getByTestId('removed-count').textContent).toBe('1')

    await user.click(screen.getByText('restore-server'))
    await waitFor(() => expect(screen.queryByTestId('dirty-marker')).toBeNull())
    expect(screen.getByTestId('removed-count').textContent).toBe('0')
  })

  it('D3: clearing the description sends an empty string on save', async () => {
    const user = userEvent.setup()
    updateMock.mockResolvedValue(ONTOLOGY)
    renderPage('/schema/bp_1?tab=settings')

    await user.click(screen.getByText('clear-description'))
    await screen.findByTestId('dirty-marker')

    await user.click(screen.getByText('header-save'))
    await waitFor(() => expect(updateMock).toHaveBeenCalled())
    const req = updateMock.mock.calls[0][0].req as Record<string, unknown>
    expect(req.description).toBe('')
  })

  it('D1: a failed save from the navigation blocker does not navigate away', async () => {
    const user = userEvent.setup()
    updateMock.mockRejectedValue(new Error('server exploded'))
    const router = renderPage()

    await stageDelete(user)
    router.navigate('/schema/bp_2')
    await screen.findByText('Unsaved changes')

    await user.click(screen.getByText('Save Changes'))
    await waitFor(() => expect(updateMock).toHaveBeenCalled())

    // Still on the original ontology, still dirty — nothing was lost.
    await waitFor(() => expect(router.state.location.pathname).toBe('/schema/bp_1'))
    expect(screen.getByTestId('dirty-marker')).toBeInTheDocument()
  })

  it('D1 (success): a successful save from the blocker proceeds with navigation', async () => {
    const user = userEvent.setup()
    updateMock.mockResolvedValue(ONTOLOGY)
    const router = renderPage()

    await stageDelete(user)
    router.navigate('/schema/bp_2')
    await screen.findByText('Unsaved changes')

    await user.click(screen.getByText('Save Changes'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/schema/bp_2'))
  })

  it('D2: blocker Discard clears working copies and navigates once, no second dialog', async () => {
    const user = userEvent.setup()
    const router = renderPage()

    await stageDelete(user)
    router.navigate('/schema/bp_2')
    await screen.findByText('Unsaved changes')

    await user.click(screen.getByText('Discard'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/schema/bp_2'))

    // No stray "Discard all changes?" confirm and no dirty state on arrival.
    expect(screen.queryByText(/Discard all changes/i)).toBeNull()
    expect(screen.queryByTestId('dirty-marker')).toBeNull()
  })

  it('C1: bulk unassign confirms once with the count, then processes EVERY selected source', async () => {
    // Regression: forEach into single-target dialog state meant only the LAST
    // selected source ever got unassigned.
    const user = userEvent.setup()
    updateDataSourceMock.mockReset()
      .mockResolvedValueOnce({})                       // ds1 succeeds
      .mockRejectedValueOnce(new Error('boom'))        // ds2 fails — batch must survive
    renderPage('/schema?view=dashboard')

    await user.click(await screen.findByText('bulk-unassign-two'))
    expect(await screen.findByText(/Unassign 2 data sources\?/)).toBeInTheDocument()
    expect(screen.getByText(/Source A/)).toBeInTheDocument()
    expect(screen.getByText(/Source B/)).toBeInTheDocument()

    await user.click(screen.getByText('Unassign All'))
    await waitFor(() => expect(updateDataSourceMock).toHaveBeenCalledTimes(2))
    expect(updateDataSourceMock).toHaveBeenCalledWith('ws1', 'ds1', { ontologyId: '' })
    expect(updateDataSourceMock).toHaveBeenCalledWith('ws1', 'ds2', { ontologyId: '' })
  })
})

describe('OntologySchemaPage, creating a layer', () => {
  it('offers New semantic layer to someone who may create one', async () => {
    renderPage('/schema?view=dashboard')
    expect(await screen.findByTestId('sidebar-create')).toHaveTextContent('create offered')
    expect(screen.getByTestId('hero-create')).toHaveTextContent('create offered')
  })

  it('switches it off, saying why, for someone who looks after layers but may not start one', async () => {
    access = { ...ACCESS, canCreate: false, createBlockedBy: 'create-permission' }
    renderPage('/schema?view=dashboard')
    expect(await screen.findByTestId('sidebar-create')).toHaveTextContent(/can’t start new ones.*workspace:ontology:create/)
    expect(screen.getByTestId('hero-create')).toHaveTextContent(/can’t start new ones/)
  })

  it('names the switch when creating is turned off for everyone', async () => {
    access = { ...ACCESS, canCreate: false, createBlockedBy: 'creation-off' }
    renderPage('/schema?view=dashboard')
    expect(await screen.findByTestId('sidebar-create')).toHaveTextContent('“Create semantic layers” under Admin → Features')
  })

  it('offers a reader no create at all', async () => {
    access = { ...ACCESS, canEdit: false, canCreate: false, createBlockedBy: 'permission' }
    renderPage('/schema?view=dashboard')
    await screen.findByTestId('sidebar')
    expect(screen.queryByTestId('sidebar-create')).toBeNull()
    expect(screen.queryByTestId('hero-create')).toBeNull()
  })
})
