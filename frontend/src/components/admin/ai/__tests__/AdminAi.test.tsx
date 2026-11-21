/**
 * The page: its tiles count from the same reads the tabs use, it says when
 * the assistant is not answering yet, and the vocabulary tab shows each
 * term's meaning as Advanced Search text and can share a personal one.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkspacesStore } from '@/store/workspaces'
import type { WorkspaceResponse } from '@/services/workspaceService'
import { AdminAi } from '../AdminAi'

const { svc, notify } = vi.hoisted(() => ({
    svc: {
        listConnections: vi.fn(), getSettings: vi.fn(), usage: vi.fn(), knowledge: vi.fn(),
        listConcepts: vi.fn(), promoteConcept: vi.fn(), deleteConcept: vi.fn(),
    },
    notify: vi.fn(),
}))
vi.mock('@/services/aiAdminService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/services/aiAdminService')>()
    return { ...actual, aiAdminService: svc }
})
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))

const WORKSPACE = {
    id: 'ws_1', name: 'Finance', isDefault: true, isActive: true, createdAt: '', updatedAt: '',
    dataSources: [{ id: 'ds_1', workspaceId: 'ws_1', label: 'Warehouse', accessLevel: 'read', isPrimary: true, isActive: true }],
} as WorkspaceResponse

const renderPage = () => render(
    <MemoryRouter>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <AdminAi />
        </QueryClientProvider>
    </MemoryRouter>,
)

beforeEach(() => {
    vi.clearAllMocks()
    useWorkspacesStore.setState({ workspaces: [WORKSPACE], activeWorkspaceId: 'ws_1', activeDataSourceId: 'ds_1' })
    svc.listConnections.mockResolvedValue([])
    svc.getSettings.mockResolvedValue({ chatConnectionId: null })
    svc.usage.mockResolvedValue({
        days: [{ day: '2026-11-20', requests: 7, inputTokens: 100, outputTokens: 50 }, { day: '2026-11-21', requests: 5, inputTokens: 0, outputTokens: 0 }],
        feedback: { up: 4, down: 2 }, recentDown: [],
    })
    svc.knowledge.mockResolvedValue({ store: 'pgvector', collections: [{ name: 'docs', status: 'ready' }, { name: 'views', status: 'building' }] })
    svc.listConcepts.mockResolvedValue([
        { id: 'cm_1', concept: 'PII', label: 'Personal data', scope: 'personal', uses: 3, updatedAt: '2026-11-20T00:00:00Z',
          predicate: { kind: 'tag', op: 'hasAny', values: ['pii'] } },
        { id: 'cm_2', concept: 'gold', label: 'gold', scope: 'workspace', uses: 9, updatedAt: '2026-11-19T00:00:00Z',
          predicate: { kind: 'tag', op: 'hasAny', values: ['gold'] } },
    ])
    svc.promoteConcept.mockResolvedValue({})
})

describe('Administration → AI', () => {
    it('counts on its tiles and says the assistant is not answering yet', async () => {
        renderPage()
        expect(screen.getByRole('heading', { level: 1, name: 'AI assistant' })).toBeInTheDocument()
        await waitFor(() => expect(screen.getByRole('button', { name: /^Questions \(30 days\): 12/ })).toBeInTheDocument())
        expect(screen.getByRole('button', { name: /^Marked unhelpful \(30 days\): 2/ })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /^Knowledge collections ready: 1/ })).toBeInTheDocument()
        expect(await screen.findByText('The assistant is not answering yet')).toBeInTheDocument()
        expect(await screen.findByText('No model is connected yet')).toBeInTheDocument()
    })

    it('shows the vocabulary of the open data source as search text, and shares a personal term', async () => {
        renderPage()
        await userEvent.click(screen.getByRole('button', { name: 'Business vocabulary' }))
        const table = await screen.findByRole('table', { name: 'Business vocabulary' })
        expect(svc.listConcepts).toHaveBeenCalledWith('ds_1')
        const pii = within(table).getByText('PII').closest('tr')!
        expect(pii).toHaveTextContent('Personal')
        expect(pii.textContent).toMatch(/tag.*pii/)
        expect(pii.textContent).not.toContain('{')
        const gold = within(table).getByText('gold').closest('tr')!
        expect(within(gold).queryByRole('button', { name: /share with workspace/i })).not.toBeInTheDocument()

        await userEvent.click(within(pii).getByRole('button', { name: /share with workspace/i }))
        await waitFor(() => expect(svc.promoteConcept).toHaveBeenCalledWith('cm_1'))
        expect(notify).toHaveBeenCalledWith('success', '“PII” now means the same for everyone in Finance')
    })
})
