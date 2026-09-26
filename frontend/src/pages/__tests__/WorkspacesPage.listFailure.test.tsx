/**
 * "No workspaces yet" must mean there are none — not that we failed to ask.
 *
 * loadData took `settled[0]` and fell back to `[]` on rejection, then set that
 * as the list unconditionally. `degraded` was computed from `settled.slice(1)`,
 * deliberately skipping index 0 — so the one failure that erases the whole page
 * was the one failure that raised no banner. With ADMIN_LIST_MS at 8s a timeout
 * here is routine, and the page then told the user their estate was empty and
 * offered them a "Create a workspace to get started" nudge.
 *
 * The rule the file already states for its three secondary probes: stale-but-true
 * beats blank-and-false. These pin it for the primary one — and pin that a
 * genuinely empty estate still reads as empty.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspacesPage } from '../WorkspacesPage'

const { listWorkspaces } = vi.hoisted(() => ({ listWorkspaces: vi.fn() }))

vi.mock('@/services/workspaceService', () => ({
    workspaceService: { list: listWorkspaces, setDefault: vi.fn(), getImpact: vi.fn(), delete: vi.fn() },
}))
vi.mock('@/services/catalogService', () => ({
    catalogService: { list: vi.fn().mockResolvedValue([]), listWithBindings: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/services/providerService', () => ({
    providerService: { list: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/services/ontologyDefinitionService', () => ({
    ontologyDefinitionService: { list: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/services/viewApiService', () => ({
    listViews: vi.fn().mockResolvedValue({ items: [], total: 0 }),
}))
vi.mock('@/services/cacheEnvelope', () => ({ fetchEnveloped: vi.fn().mockResolvedValue({}) }))
vi.mock('@/hooks/useContentInsights', () => ({ useWorkspaceUsage: () => ({ data: undefined }) }))
vi.mock('@/components/admin/workspace/useWorkspaceDetailData', () => ({
    prefetchWorkspaceDetail: vi.fn(),
}))
vi.mock('@/components/admin/CreateWorkspaceWizard', () => ({ CreateWorkspaceWizard: () => null }))
vi.mock('@/features/tour/TourLaunchButton', () => ({ TourLaunchButton: () => null }))

vi.mock('@/store/auth', () => ({
    useAuthStore: (selector: (s: unknown) => unknown) =>
        selector({ can: () => true, permissions: { ws: {} } }),
}))

vi.mock('@/components/admin/WorkspaceCard', () => ({
    WorkspaceCard: ({ ws }: { ws: { id: string; name: string } }) => <div>{ws.name}</div>,
}))

const WORKSPACES = [
    { id: 'w1', name: 'Sales Analytics', description: '', dataSources: [], isDefault: false,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'w2', name: 'Finance Core', description: '', dataSources: [], isDefault: false,
      createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
]

function renderPage() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <MemoryRouter>
            <QueryClientProvider client={qc}>
                <WorkspacesPage />
            </QueryClientProvider>
        </MemoryRouter>,
    )
}

/** The page's own refresh trigger — the permissions bus, same as a silent refresh. */
async function refresh() {
    await act(async () => { window.dispatchEvent(new Event('permissions:changed')) })
}

describe('WorkspacesPage — when the workspace list itself fails', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('keeps the workspaces it already had, and says the list may be stale', async () => {
        listWorkspaces.mockResolvedValueOnce(WORKSPACES)
        renderPage()
        expect(await screen.findByText('Sales Analytics')).toBeInTheDocument()

        listWorkspaces.mockRejectedValueOnce(new Error('timed out after 8000ms'))
        await refresh()
        await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(2))

        // Stale-but-true: both cards survive the failed refresh...
        expect(screen.getByText('Sales Analytics')).toBeInTheDocument()
        expect(screen.getByText('Finance Core')).toBeInTheDocument()
        // ...and nothing claims the estate is empty.
        expect(screen.queryByText('No workspaces yet')).not.toBeInTheDocument()
        // ...and the page admits what it is showing might be out of date.
        expect(screen.getByText(/workspace list/i)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    })

    it('never announces an empty estate when the very first load fails', async () => {
        listWorkspaces.mockRejectedValueOnce(new Error('timed out after 8000ms'))
        renderPage()

        await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(1))
        await waitFor(() => expect(screen.queryByText('No workspaces yet')).not.toBeInTheDocument())
        expect(screen.queryByText('Create a workspace to get started')).not.toBeInTheDocument()
        expect(await screen.findByText(/couldn't load/i)).toBeInTheDocument()
    })

    it('still shows the real empty state for a genuinely empty estate', async () => {
        listWorkspaces.mockResolvedValueOnce([])
        renderPage()

        expect(await screen.findByText('No workspaces yet')).toBeInTheDocument()
        expect(screen.getByText('Create a workspace to get started')).toBeInTheDocument()
        expect(screen.queryByText(/workspace list/i)).not.toBeInTheDocument()
    })

    it('drops the stale warning once a later refresh succeeds', async () => {
        listWorkspaces.mockRejectedValueOnce(new Error('timed out after 8000ms'))
        renderPage()
        expect(await screen.findByText(/couldn't load/i)).toBeInTheDocument()

        listWorkspaces.mockResolvedValueOnce(WORKSPACES)
        await refresh()

        expect(await screen.findByText('Sales Analytics')).toBeInTheDocument()
        expect(screen.queryByText(/workspace list/i)).not.toBeInTheDocument()
    })
})
