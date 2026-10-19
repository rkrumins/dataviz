/**
 * The "How people get in" card shows the workspace's saved settings, keeps
 * Save off until something changes, and saves all three together.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, update } = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }))
vi.mock('@/services/workspaceService', () => ({ workspaceService: { get, update } }))

import { WorkspaceAccessSettings } from '../WorkspaceAccessSettings'

function renderCard() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <QueryClientProvider client={client}>
            <WorkspaceAccessSettings workspaceId="ws_fin" />
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    get.mockResolvedValue({ id: 'ws_fin', directoryListed: false, accessMode: 'idp', accessNote: 'Say which team' })
    update.mockResolvedValue({})
})

describe('WorkspaceAccessSettings', () => {
    it('shows the saved settings and saves only once something changes', async () => {
        const user = userEvent.setup()
        renderCard()

        expect(await screen.findByDisplayValue('Say which team')).toBeInTheDocument()
        expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
        expect(screen.getByRole('radio', { name: /Through your identity provider/ })).toHaveAttribute('aria-checked', 'true')
        const save = screen.getByRole('button', { name: 'Save' })
        expect(save).toBeDisabled()

        await user.click(screen.getByRole('switch'))
        await user.click(screen.getByRole('radio', { name: /Approved in the app/ }))
        expect(save).toBeEnabled()
        await user.click(save)

        await waitFor(() => expect(update).toHaveBeenCalledWith('ws_fin', {
            directoryListed: true, accessMode: 'app', accessNote: 'Say which team',
        }))
    })
})
