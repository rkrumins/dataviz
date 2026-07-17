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

vi.mock('@/features/ontology/lib/useSemanticLayerAccess', () => ({
  useSemanticLayerAccess: () => ({
    canEdit: true, canImport: true, canExport: true, canSuggest: true,
    canSeeHistory: true, canPublish: true, editingBlockedBy: null,
  }),
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

vi.mock('@/services/workspaceService', () => ({
  workspaceService: { updateDataSource: vi.fn() },
}))

// ─── Heavy children → prop-driven stubs ────────────────────────────────

vi.mock('@/features/ontology/components/OntologySidebar', () => ({
  OntologySidebar: () => <div data-testid="sidebar" />,
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
vi.mock('@/features/ontology/components/panels/DeploymentDashboardPanel', () => ({ DeploymentDashboardPanel: () => null }))
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
})
