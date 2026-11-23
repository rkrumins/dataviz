/**
 * The People tab's counters: one for all bindings, one per role — the three every workspace has,
 * then any other role someone holds — each named by the role's own label, never twice the same.
 */
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { members } = vi.hoisted(() => ({
    members: {
        list: vi.fn(), listEffective: vi.fn(), create: vi.fn(), revoke: vi.fn(),
        previewRevoke: vi.fn(), grantOptions: vi.fn(),
    },
}))
vi.mock('@/services/workspaceMembersService', () => ({ workspaceMembersService: members }))
vi.mock('@/services/userDirectoryService', () => ({ searchDirectory: vi.fn() }))
vi.mock('@/services/adminUserService', () => ({ adminUserService: { listUsers: vi.fn() } }))
vi.mock('@/services/groupsService', () => ({ groupsService: { list: vi.fn(), listMembers: vi.fn() } }))
vi.mock('@/services/accessRequestsService', async (orig) => ({
    ...(await orig<typeof import('@/services/accessRequestsService')>()),
    accessRequestsService: { listToAnswer: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/services/workspaceService', () => ({ workspaceService: { get: vi.fn(), update: vi.fn() } }))

import { WorkspaceMembers } from '../WorkspaceMembers'
import { useAuthStore } from '@/store/auth'

const binding = (id: string, role: string) => ({
    bindingId: `bnd_${id}`, role, grantedAt: '2026-01-01T00:00:00Z', grantedBy: null, expiresAt: null,
    subject: { type: 'user', id: `usr_${id}`, displayName: id, secondary: null },
})

beforeEach(() => {
    vi.clearAllMocks()
    useAuthStore.setState({ permissions: { sid: 's', global: [], ws: {} } } as never)
    members.grantOptions.mockResolvedValue({ tier: 'admin', accessMode: 'app', groups: [], idpRoutes: [], roles: [] })
    members.list.mockResolvedValue([
        binding('Ada', 'workspace_admin'),
        binding('Ben', 'workspace_playground_member'),
        binding('Cy', 'workspace_playground_member'),
    ])
})

describe('the People tab’s counters', () => {
    it('counts every binding and each role by its name, a role held here getting its own', async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={client}>
                <WorkspaceMembers workspaceId="ws_play" canManage />
            </QueryClientProvider>,
        )
        await screen.findByText('Ada')
        const tiles = within(screen.getByRole('list', { name: 'Bindings by role' })).getAllByRole('listitem')
        expect(tiles.map((t) => t.textContent)).toEqual([
            '3Bindings', '1Workspace admin', '0Workspace member', '0Workspace viewer', '2Playground member',
        ])
        expect(screen.queryByText(/Admin, User, or Viewer/)).toBeNull()
    })
})
