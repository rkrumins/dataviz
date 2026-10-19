/**
 * The Workspaces page offers Find a workspace as a tab while its switch is
 * on, and opens on it for someone who has no workspace and can't create
 * one. With the switch off there is no tab, and the empty state says whom
 * to ask instead of offering to create a workspace they can't.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listWorkspaces, auth } = vi.hoisted(() => ({
    listWorkspaces: vi.fn(),
    auth: { canCreate: false },
}))

vi.mock('@/services/workspaceService', () => ({
    workspaceService: { list: listWorkspaces, summary: vi.fn().mockResolvedValue({ coverage: 'all', totals: { workspaces: 0, dataSources: 0, activeDataSources: 0, pendingDataSources: 0, nodes: 0, edges: 0, entityTypes: [], views: 0, sharedGraphs: 0 }, workspaces: [] }), setDefault: vi.fn(), getImpact: vi.fn(), delete: vi.fn() },
}))
vi.mock('@/services/catalogService', () => ({
    catalogService: { list: vi.fn().mockResolvedValue([]), listWithBindings: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/services/providerService', () => ({ providerService: { list: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/services/ontologyDefinitionService', () => ({
    ontologyDefinitionService: { list: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/services/viewApiService', () => ({ listViews: vi.fn().mockResolvedValue({ items: [], total: 0 }) }))
vi.mock('@/services/cacheEnvelope', () => ({ fetchEnveloped: vi.fn().mockResolvedValue({}) }))
vi.mock('@/hooks/useContentInsights', () => ({ useWorkspaceUsage: () => ({ data: undefined }) }))
vi.mock('@/components/admin/workspace/useWorkspaceDetailData', () => ({ prefetchWorkspaceDetail: vi.fn() }))
vi.mock('@/components/admin/CreateWorkspaceWizard', () => ({ CreateWorkspaceWizard: () => null }))
vi.mock('@/features/tour/TourLaunchButton', () => ({ TourLaunchButton: () => null }))
vi.mock('@/components/workspaces/WorkspaceDirectory', () => ({
    WorkspaceDirectory: () => <div>the directory</div>,
}))
vi.mock('@/store/auth', () => ({
    useAuthStore: (selector: (s: unknown) => unknown) =>
        selector({ can: (p: string) => p !== 'system:workspaces:create' || auth.canCreate, permissions: { ws: {} } }),
}))
vi.mock('@/components/admin/WorkspaceCard', () => ({
    WorkspaceCard: ({ ws }: { ws: { id: string; name: string } }) => <div>{ws.name}</div>,
}))

import { WorkspacesPage } from '../WorkspacesPage'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'

function renderPage(path = '/workspaces') {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <MemoryRouter initialEntries={[path]}>
            <QueryClientProvider client={qc}>
                <WorkspacesPage />
            </QueryClientProvider>
        </MemoryRouter>,
    )
}

const SALES = {
    id: 'w1', name: 'Sales Analytics', description: '', dataSources: [], isDefault: false,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
}

beforeEach(() => {
    vi.clearAllMocks()
    auth.canCreate = false
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, workspaceDirectoryEnabled: true } })
})

describe('WorkspacesPage — Find a workspace', () => {
    it('opens on Find a workspace for someone with nowhere to go', async () => {
        listWorkspaces.mockResolvedValue([])
        renderPage()
        expect(await screen.findByText('the directory')).toBeInTheDocument()
        expect(screen.getByRole('tab', { name: /Find a workspace/ })).toHaveAttribute('aria-selected', 'true')
    })

    it('stays on your workspaces when you have some, and switches on the tab', async () => {
        const user = userEvent.setup()
        listWorkspaces.mockResolvedValue([SALES])
        renderPage()
        expect(await screen.findByText('Sales Analytics')).toBeInTheDocument()
        expect(screen.queryByText('the directory')).not.toBeInTheDocument()

        await user.click(screen.getByRole('tab', { name: /Find a workspace/ }))
        expect(await screen.findByText('the directory')).toBeInTheDocument()
        expect(screen.queryByText('Sales Analytics')).not.toBeInTheDocument()
    })

    it('has no tab while the switch is off, and says whom to ask', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } })
        listWorkspaces.mockResolvedValue([])
        renderPage('/workspaces?tab=discover')
        expect(await screen.findByText('No workspaces yet')).toBeInTheDocument()
        expect(screen.getByText(/Ask an administrator to add you/)).toBeInTheDocument()
        expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
        expect(screen.queryByText('the directory')).not.toBeInTheDocument()
    })

    it('keeps offering to create a workspace to those who can', async () => {
        auth.canCreate = true
        listWorkspaces.mockResolvedValue([])
        renderPage()
        expect(await screen.findByText('Create a workspace to get started')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Find a workspace' })).toBeInTheDocument()
    })
})
