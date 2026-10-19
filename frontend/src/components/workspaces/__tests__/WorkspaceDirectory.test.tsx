/**
 * Find a workspace: a card per workspace with what it is for, who is in it,
 * who answers and how people get in — and the one thing to do: Open it, see
 * where your request is, or Request access. The banner counts double as
 * filters, and search reads names and descriptions.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { directory, requestableRoles } = vi.hoisted(() => ({
    directory: vi.fn(),
    requestableRoles: vi.fn(),
}))
vi.mock('@/services/workspaceService', () => ({ workspaceService: { directory } }))
vi.mock('@/services/accessRequestsService', () => ({
    accessRequestsService: { requestableRoles, submit: vi.fn() },
}))
vi.mock('@/components/ui/PersonChip', () => ({
    PersonChip: ({ id }: { id: string }) => <span>{`person:${id}`}</span>,
}))

import { WorkspaceDirectory } from '../WorkspaceDirectory'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import type { WorkspaceDirectoryEntry } from '@/services/workspaceService'

function entry(over: Partial<WorkspaceDirectoryEntry>): WorkspaceDirectoryEntry {
    return {
        id: 'ws_x', name: 'X', description: null, dataSourceCount: 0, peopleCount: 0,
        approverIds: [], approverCount: 0, accessMode: 'app', accessNote: null,
        directoryListed: true, canOpen: false, yourRoles: [], openRequest: null,
        ...over,
    }
}

const ENTRIES = [
    entry({
        id: 'ws_fin', name: 'Finance', description: 'Month-end close', dataSourceCount: 2, peopleCount: 14,
        approverIds: ['usr_bob', 'usr_wanda'], approverCount: 5, accessNote: 'Say which team you’re on',
    }),
    entry({ id: 'ws_ops', name: 'Operations', canOpen: true, yourRoles: ['workspace_member'], directoryListed: false }),
    entry({
        id: 'ws_risk', name: 'Risk', accessMode: 'idp',
        openRequest: { id: 'ar_1', status: 'awaiting_idp', requestedRole: 'workspace_viewer', createdAt: '2026-10-18T00:00:00Z', idpGroup: 'risk-analysts' },
    }),
]

function renderDirectory() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <MemoryRouter>
            <QueryClientProvider client={client}>
                <WorkspaceDirectory />
            </QueryClientProvider>
        </MemoryRouter>,
    )
}

const card = (name: string) => screen.getByRole('heading', { name }).closest('article') as HTMLElement

beforeEach(() => {
    vi.clearAllMocks()
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, workspaceDirectoryEnabled: true } })
    directory.mockResolvedValue(ENTRIES)
    requestableRoles.mockResolvedValue([{ name: 'workspace_viewer', description: null, isSystem: true }])
})

describe('WorkspaceDirectory', () => {
    it('says what each workspace is, who answers and how people get in', async () => {
        renderDirectory()
        const fin = within(await waitFor(() => card('Finance')))
        expect(fin.getByText('Month-end close')).toBeInTheDocument()
        expect(fin.getByText('14')).toBeInTheDocument()
        expect(fin.getByText('Approved in the app')).toBeInTheDocument()
        expect(fin.getByText('person:usr_bob')).toBeInTheDocument()
        expect(fin.getByText('+3 more')).toBeInTheDocument()
        expect(fin.getByText('Say which team you’re on')).toBeInTheDocument()
        expect(fin.getByRole('button', { name: /Request access/ })).toBeInTheDocument()

        const ops = within(card('Operations'))
        expect(ops.getByRole('link', { name: /Open/ })).toHaveAttribute('href', '/workspaces/ws_ops')
        expect(ops.getByText('You’re Member')).toBeInTheDocument()
        expect(ops.getByText('Hidden from this list')).toBeInTheDocument()

        const risk = within(card('Risk'))
        expect(risk.getByText('Through your identity provider')).toBeInTheDocument()
        expect(risk.getByText('Waiting on your identity provider')).toBeInTheDocument()
        expect(risk.getByText(/add you to “risk-analysts”/)).toBeInTheDocument()
    })

    it('filters from the banner and the search', async () => {
        const user = userEvent.setup()
        renderDirectory()
        await screen.findByRole('heading', { name: 'Finance' })

        await user.click(screen.getByRole('radio', { name: /Yours/ }))
        expect(screen.queryByRole('heading', { name: 'Finance' })).not.toBeInTheDocument()
        expect(screen.getByRole('heading', { name: 'Operations' })).toBeInTheDocument()

        await user.click(screen.getByRole('radio', { name: /All/ }))
        await user.type(screen.getByRole('searchbox', { name: 'Search workspaces' }), 'month-end')
        expect(screen.getByRole('heading', { name: 'Finance' })).toBeInTheDocument()
        expect(screen.queryByRole('heading', { name: 'Risk' })).not.toBeInTheDocument()
    })

    it('opens Request access for a workspace you are not in', async () => {
        const user = userEvent.setup()
        renderDirectory()
        await user.click(await waitFor(() => within(card('Finance')).getByRole('button', { name: /Request access/ })))
        expect(await screen.findByRole('dialog', { name: 'Ask to join Finance' })).toBeInTheDocument()
        expect(requestableRoles).toHaveBeenCalledWith('ws_fin')
    })

    it('asks nothing while the switch is off', () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } })
        renderDirectory()
        expect(directory).not.toHaveBeenCalled()
    })
})
