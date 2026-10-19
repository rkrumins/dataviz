/**
 * An admin moves a time-limited grant's end from the Members tab — from
 * today, or to none. A steward can't.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { members } = vi.hoisted(() => ({
    members: {
        list: vi.fn(), listEffective: vi.fn(), create: vi.fn(), revoke: vi.fn(),
        previewRevoke: vi.fn(), grantOptions: vi.fn(), updateExpiry: vi.fn(),
    },
}))
vi.mock('@/services/workspaceMembersService', () => ({ workspaceMembersService: members }))
vi.mock('@/services/accessRequestsService', async (orig) => ({
    ...(await orig<typeof import('@/services/accessRequestsService')>()),
    accessRequestsService: { listToAnswer: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/services/accessReviewsService', () => ({ accessReviewsService: { list: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/services/workspaceService', () => ({ workspaceService: { get: vi.fn(), update: vi.fn() } }))

import { WorkspaceMembers } from '../WorkspaceMembers'

function renderTab(canManage: boolean) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <QueryClientProvider client={client}>
            <WorkspaceMembers workspaceId="ws_fin" canManage={canManage} />
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    members.list.mockResolvedValue([{
        bindingId: 'bnd_1', role: 'workspace_member', grantedAt: '2026-01-01T00:00:00Z', grantedBy: null,
        expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        subject: { type: 'user', id: 'usr_max', displayName: 'Max', secondary: 'max@x.io' },
    }])
    members.grantOptions.mockResolvedValue({ tier: 'admin', accessMode: 'app', groups: [], idpRoutes: [], roles: [] })
    members.updateExpiry.mockResolvedValue({})
})

describe('WorkspaceMembers — when access ends', () => {
    it('lets an admin move it', async () => {
        const user = userEvent.setup()
        renderTab(true)
        await user.click(await screen.findByRole('button', { name: 'Change when Max’s access ends' }))
        await user.click(screen.getByRole('button', { name: 'End in 30 days' }))
        await waitFor(() => expect(members.updateExpiry).toHaveBeenCalledWith('ws_fin', 'bnd_1', { expiresIn: '30d' }))

        await user.click(screen.getByRole('button', { name: 'Change when Max’s access ends' }))
        await user.click(screen.getByRole('button', { name: 'No end date' }))
        await waitFor(() => expect(members.updateExpiry).toHaveBeenLastCalledWith('ws_fin', 'bnd_1', {}))
    })

    it('is the admins’ alone', async () => {
        renderTab(false)
        expect(await screen.findByText('Max')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Change when/ })).not.toBeInTheDocument()
    })
})
