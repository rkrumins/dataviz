/**
 * "Make default" had no `try`/`catch` at all: a rejected request was completely
 * invisible — no message, no console line — and the page reloaded as if it had
 * worked, so the only clue was the badge not moving.
 *
 * These pin both directions, and the reload that has to happen either way: after a
 * failure the list must still be refreshed, or the screen keeps whatever the click
 * half-implied.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspacesPage } from '../WorkspacesPage'
import { useNotificationStore } from '@/components/ui/notifications'

const { listWorkspaces, setDefault } = vi.hoisted(() => ({
    listWorkspaces: vi.fn(),
    setDefault: vi.fn(),
}))

vi.mock('@/services/workspaceService', () => ({
    workspaceService: { list: listWorkspaces, setDefault, getImpact: vi.fn(), delete: vi.fn() },
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

/** The one control under test: the card's "Make default" action. */
vi.mock('@/components/admin/WorkspaceCard', () => ({
    WorkspaceCard: ({ ws, onSetDefault }: {
        ws: { id: string; name: string }
        onSetDefault: () => void
    }) => (
        <button onClick={onSetDefault}>Make {ws.name} default</button>
    ),
}))

const WORKSPACES = [
    { id: 'w1', name: 'Sales Analytics', description: '', dataSources: [], isDefault: false,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
]

const raised = () => useNotificationStore.getState().notifications

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

describe('WorkspacesPage — making a workspace the default', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        listWorkspaces.mockResolvedValue(WORKSPACES)
        useNotificationStore.setState({ notifications: [], history: [], _nextId: 1 })
    })

    it('names the workspace, and says what being default means', async () => {
        setDefault.mockResolvedValue(undefined)
        const user = userEvent.setup()
        renderPage()

        await user.click(await screen.findByRole('button', { name: /Make Sales Analytics default/i }))

        await waitFor(() => expect(raised()).toHaveLength(1))
        expect(raised()[0].type).toBe('success')
        expect(raised()[0].message).toBe(
            '“Sales Analytics” is now the default workspace — it opens first for everyone.')
    })

    it('reports the failure that used to be silent, and refreshes anyway', async () => {
        setDefault.mockRejectedValue(new Error('Only an org admin can set the default workspace'))
        const user = userEvent.setup()
        renderPage()

        await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(1))
        await user.click(await screen.findByRole('button', { name: /Make Sales Analytics default/i }))

        await waitFor(() => expect(raised()).toHaveLength(1))
        expect(raised()[0].type).toBe('error')
        expect(raised()[0].message).toBe('Only an org admin can set the default workspace')
        // Nothing claimed it worked...
        expect(raised().some(n => n.type === 'success')).toBe(false)
        // ...and the list was still reloaded, so the badge matches the server again.
        await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(2))
    })

    it('falls back to a sentence that names the action when the error carries no message', async () => {
        setDefault.mockRejectedValue(new Error(''))
        const user = userEvent.setup()
        renderPage()

        await user.click(await screen.findByRole('button', { name: /Make Sales Analytics default/i }))

        await waitFor(() => expect(raised()).toHaveLength(1))
        expect(raised()[0].message).toBe(
            'Could not make “Sales Analytics” the default workspace.')
    })
})
