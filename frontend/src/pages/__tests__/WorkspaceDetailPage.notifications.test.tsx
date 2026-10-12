/**
 * Four writes on this page had no `try`/`catch` at all. A rejected request was
 * completely invisible: the header closed its edit form, the primary badge stayed
 * put, the drawer left edit mode — and nothing anywhere said the save had failed.
 * The aggregation save was worse: it DID have a success notification, but a throw
 * from either of its two writes jumped straight past it, so the user saw nothing
 * whichever way it went.
 *
 * Each test drives one handler through the component that owns its button, and
 * checks both directions: the success names the thing that changed, and the
 * failure names the action — with no success notification alongside it.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceDetailPage } from '../WorkspaceDetailPage'
import { useNotificationStore } from '@/components/ui/notifications'

const { update, setPrimaryDataSource, updateDataSource, setProjectionMode, reload } = vi.hoisted(() => ({
    update: vi.fn(),
    setPrimaryDataSource: vi.fn(),
    updateDataSource: vi.fn(),
    setProjectionMode: vi.fn(),
    reload: vi.fn(),
}))

vi.mock('@/services/workspaceService', () => ({
    workspaceService: { update, setPrimaryDataSource, updateDataSource, setProjectionMode },
}))
vi.mock('@/services/aggregationService', () => ({ aggregationService: {
    triggerAggregation: vi.fn(), purgeAggregation: vi.fn(),
} }))
vi.mock('@/services/accessRequestsService', () => ({ accessRequestsService: { create: vi.fn() } }))

const WORKSPACE = {
    id: 'ws1',
    name: 'Sales Analytics',
    description: 'Everything revenue touches',
    dataSources: [
        { id: 'ds1', label: 'Snowflake Prod', isPrimary: false, isActive: true, ontologyId: 'o1' },
        { id: 'ds2', label: 'Warehouse', isPrimary: true, isActive: true, ontologyId: 'o1' },
    ],
}

vi.mock('@/components/admin/workspace/useWorkspaceDetailData', () => ({
    useWorkspaceDetailData: () => ({
        workspace: WORKSPACE, catalogItems: [], providers: [], ontologies: [], ontologyMap: {},
        dsStatsMap: {}, dsProviderMap: {}, viewsByDs: {}, allWorkspaceViews: [], readinessMap: {},
        healthStatus: 'healthy', aggregateStats: { totalNodes: 0, totalEdges: 0, totalTypes: 0, totalViews: 0 },
        isLoading: false, isRefreshing: false, error: null, reload,
    }),
}))

vi.mock('@/store/auth', () => ({
    usePermission: () => true,
    usePermissionClaims: () => ({ ws: { ws1: {} } }),
}))
vi.mock('@/store/features', () => ({ useFeature: () => true }))
vi.mock('@/hooks/useProfilingAccess', () => ({ useCanReadProfiling: () => false }))

/** Everything below the page that has nothing to do with these four writes. */
vi.mock('@/features/reviews/components/WorkspaceReviewsInbox', () => ({ WorkspaceReviewsInbox: () => null }))
vi.mock('@/components/admin/workspace/DeletedDataSources', () => ({ DeletedDataSources: () => null }))
vi.mock('@/components/admin/workspace/AddDataSourceWizard', () => ({ AddDataSourceWizard: () => null }))
vi.mock('@/components/admin/workspace/DataSourceGridCard', () => ({ DataSourceGridCard: () => null }))
vi.mock('@/components/admin/workspace/WorkspaceNodeIdentityDefaults', () => ({ WorkspaceNodeIdentityDefaults: () => null }))
vi.mock('@/components/admin/workspace/WorkspaceViewsSection', () => ({ default: () => null }))
vi.mock('@/components/admin/workspace/WorkspaceAggregationDashboard', () => ({ WorkspaceAggregationDashboard: () => null }))
vi.mock('@/components/admin/workspace/WorkspaceOntologyTimeline', () => ({ WorkspaceOntologyTimeline: () => null }))
vi.mock('@/components/workspaces/WorkspaceMembers', () => ({ WorkspaceMembers: () => null }))
vi.mock('@/components/ingestion/profiling/ProfilingBoard', () => ({ ProfilingBoard: () => null }))
vi.mock('@/components/admin/workspace/useDataSourceDeletion', () => ({
    useDataSourceDeletion: () => ({ target: null, open: vi.fn(), openPermanent: vi.fn(), close: vi.fn(), confirm: vi.fn() }),
    impactSections: () => [],
    deleteCaveat: () => '',
}))

/** The header's Save button — the page owns the edit fields, so the stub echoes them back. */
vi.mock('@/components/admin/workspace/WorkspaceHeroHeader', () => ({
    WorkspaceHeroHeader: ({ isEditing, onStartEdit, onSave, onEditNameChange, onEditDescChange }: {
        isEditing: boolean
        onStartEdit: () => void
        onSave: () => void
        onEditNameChange: (v: string) => void
        onEditDescChange: (v: string) => void
    }) => isEditing ? (
        <>
            <button onClick={() => onEditNameChange('Revenue Analytics')}>Rename it</button>
            <button onClick={() => onEditDescChange('New words')}>Redescribe it</button>
            <button onClick={onSave}>Save header</button>
        </>
    ) : <button onClick={onStartEdit}>Edit header</button>,
}))

/** The drawer's three writes. */
vi.mock('@/components/admin/workspace/DataSourceDetailPanel', () => ({
    DataSourceDetailPanel: ({ ds, onSaveEdit, onSetPrimary, onSaveAggregationConfig }: {
        ds: { id: string; label: string } | null
        onSaveEdit: (label: string, ontologyId: string | undefined) => Promise<void> | void
        onSetPrimary: () => void
        onSaveAggregationConfig: (p: Record<string, string>, o: Record<string, string>) => Promise<void>
    }) => ds ? (
        <>
            <button onClick={() => { void Promise.resolve(onSaveEdit('Snowflake Staging', 'o1')).catch(() => {}) }}>
                Rename source
            </button>
            <button onClick={() => { void Promise.resolve(onSaveEdit(ds.label, 'o2')).catch(() => {}) }}>
                Change ontology
            </button>
            <button onClick={onSetPrimary}>Make primary</button>
            <button onClick={() => { void onSaveAggregationConfig(
                { projectionMode: 'dedicated', dedicatedGraphName: 'g', identityProperty: 'urn', nameProperty: 'name' },
                { projectionMode: 'in_source', dedicatedGraphName: 'g', identityProperty: 'urn', nameProperty: 'name' },
            ) }}>
                Save aggregation
            </button>
        </>
    ) : null,
}))

const raised = () => useNotificationStore.getState().notifications
const messages = () => raised().map(n => `${n.type}:${n.message}`)

function renderPage() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <MemoryRouter initialEntries={['/workspaces/ws1?ds=ds1']}>
            <QueryClientProvider client={qc}>
                {/* Routed for real: every handler here bails out on a missing
                    `:wsId`, so a bare render would test nothing at all. */}
                <Routes>
                    <Route path="/workspaces/:wsId" element={<WorkspaceDetailPage />} />
                </Routes>
            </QueryClientProvider>
        </MemoryRouter>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    useNotificationStore.setState({ notifications: [], history: [], _nextId: 1 })
})

describe('the workspace header', () => {
    it('says what it renamed the workspace to', async () => {
        update.mockResolvedValue(undefined)
        const user = userEvent.setup()
        renderPage()

        await user.click(await screen.findByRole('button', { name: 'Edit header' }))
        await user.click(screen.getByRole('button', { name: 'Rename it' }))
        await user.click(screen.getByRole('button', { name: 'Save header' }))

        await waitFor(() => expect(messages()).toEqual([
            'success:Workspace renamed to “Revenue Analytics”.']))
    })

    it('does not claim a rename when only the description moved', async () => {
        update.mockResolvedValue(undefined)
        const user = userEvent.setup()
        renderPage()

        await user.click(await screen.findByRole('button', { name: 'Edit header' }))
        await user.click(screen.getByRole('button', { name: 'Redescribe it' }))
        await user.click(screen.getByRole('button', { name: 'Save header' }))

        await waitFor(() => expect(messages()).toEqual([
            'success:Description updated for “Sales Analytics”.']))
    })

    it('reports a failed save and keeps the edit form open', async () => {
        update.mockRejectedValue(new Error('A workspace called that already exists'))
        const user = userEvent.setup()
        renderPage()

        await user.click(await screen.findByRole('button', { name: 'Edit header' }))
        await user.click(screen.getByRole('button', { name: 'Rename it' }))
        await user.click(screen.getByRole('button', { name: 'Save header' }))

        await waitFor(() => expect(messages()).toEqual([
            'error:A workspace called that already exists']))
        // Still editing — the typed name is not thrown away with the failure.
        expect(screen.getByRole('button', { name: 'Save header' })).toBeInTheDocument()
        expect(reload).not.toHaveBeenCalled()
    })

    it('names the action when the error carries no message', async () => {
        update.mockRejectedValue(new Error(''))
        const user = userEvent.setup()
        renderPage()

        await user.click(await screen.findByRole('button', { name: 'Edit header' }))
        await user.click(screen.getByRole('button', { name: 'Save header' }))

        await waitFor(() => expect(messages()).toEqual([
            'error:Could not save the changes to “Sales Analytics”.']))
    })
})

describe('the primary data source', () => {
    it('names the source that now leads the workspace', async () => {
        setPrimaryDataSource.mockResolvedValue(undefined)
        const user = userEvent.setup()
        renderPage()

        await user.click(await screen.findByRole('button', { name: 'Make primary' }))

        await waitFor(() => expect(messages()).toEqual([
            'success:“Snowflake Prod” is now the primary data source for this workspace.']))
    })

    it('reports the failure, and still refreshes so the badge matches the server', async () => {
        setPrimaryDataSource.mockRejectedValue(new Error('403'))
        const user = userEvent.setup()
        renderPage()

        await user.click(await screen.findByRole('button', { name: 'Make primary' }))

        await waitFor(() => expect(messages()).toEqual(['error:403']))
        expect(reload).toHaveBeenCalled()
    })
})

describe('the aggregation settings', () => {
    it('names the source it saved them for', async () => {
        setProjectionMode.mockResolvedValue(undefined)
        const user = userEvent.setup()
        renderPage()

        await user.click(await screen.findByRole('button', { name: 'Save aggregation' }))

        await waitFor(() => expect(messages()).toEqual([
            'success:Aggregation settings saved for “Snowflake Prod”.']))
    })

    it('reports a throw that used to skip the success message silently', async () => {
        setProjectionMode.mockRejectedValue(new Error('Projection mode is locked while a job runs'))
        const user = userEvent.setup()
        renderPage()

        await user.click(await screen.findByRole('button', { name: 'Save aggregation' }))

        await waitFor(() => expect(messages()).toEqual([
            'error:Projection mode is locked while a job runs']))
        // Two writes, one of which may have landed — the panel has to resync.
        expect(reload).toHaveBeenCalled()
    })
})

describe('the data source’s own details', () => {
    it('says what it renamed the source to', async () => {
        updateDataSource.mockResolvedValue(undefined)
        const user = userEvent.setup()
        renderPage()

        await user.click(await screen.findByRole('button', { name: 'Rename source' }))

        await waitFor(() => expect(messages()).toEqual([
            'success:Data source renamed to “Snowflake Staging”.']))
    })

    it('does not claim a rename when only the ontology moved', async () => {
        updateDataSource.mockResolvedValue(undefined)
        const user = userEvent.setup()
        renderPage()

        await user.click(await screen.findByRole('button', { name: 'Change ontology' }))

        await waitFor(() => expect(messages()).toEqual([
            'success:Ontology saved for “Snowflake Prod”.']))
    })

    it('reports the failure and does not reload over the unsaved edit', async () => {
        updateDataSource.mockRejectedValue(new Error('Label is already taken'))
        const user = userEvent.setup()
        renderPage()

        await user.click(await screen.findByRole('button', { name: 'Rename source' }))

        await waitFor(() => expect(messages()).toEqual(['error:Label is already taken']))
        expect(reload).not.toHaveBeenCalled()
    })
})
