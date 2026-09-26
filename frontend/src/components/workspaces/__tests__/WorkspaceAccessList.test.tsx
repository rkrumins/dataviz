/**
 * The flattened access list resolves who can actually get into a
 * workspace — across direct bindings and every group — and shows, per
 * person, the route(s) that got them there.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/workspaceMembersService', () => ({
    workspaceMembersService: { listEffective: vi.fn() },
}))

import { WorkspaceAccessList } from '../WorkspaceAccessList'
import {
    workspaceMembersService,
    type WorkspaceAccessResponse,
} from '@/services/workspaceMembersService'

const listEffective = workspaceMembersService.listEffective as unknown as ReturnType<typeof vi.fn>

const PAGE: WorkspaceAccessResponse = {
    totalUsers: 2,
    directUsers: 1,
    viaGroupUsers: 1,
    users: [
        {
            userId: 'usr_ada', displayName: 'Ada Lovelace', email: 'ada@example.com',
            avatarId: null, status: 'active', deleted: false,
            roles: ['workspace_member', 'workspace_viewer'],
            effectiveRole: 'workspace_member',
            grants: [
                { role: 'workspace_viewer', via: 'group', bindingId: 'b1', groupId: 'grp_a', groupName: 'Alpha', expiresAt: null },
                { role: 'workspace_member', via: 'group', bindingId: 'b2', groupId: 'grp_b', groupName: 'Beta', expiresAt: null },
            ],
        },
        {
            userId: 'usr_bob', displayName: 'Bob Bell', email: 'bob@example.com',
            avatarId: null, status: 'active', deleted: false,
            roles: ['workspace_admin'], effectiveRole: 'workspace_admin',
            grants: [
                { role: 'workspace_admin', via: 'direct', bindingId: 'b3', groupId: null, groupName: null, expiresAt: null },
            ],
        },
    ],
}

beforeEach(() => {
    vi.clearAllMocks()
})

describe('WorkspaceAccessList', () => {
    it('lists everyone, summarising how they got access, and expands to the routes', async () => {
        listEffective.mockResolvedValue(PAGE)
        render(<WorkspaceAccessList workspaceId="ws_1" />)

        // Both people show up, one inherited via multiple groups, one direct.
        expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument()
        expect(screen.getByText('Bob Bell')).toBeInTheDocument()
        // Ada's pre-expand summary names the count of groups; Bob is direct.
        expect(screen.getByText(/via 2 groups/i)).toBeInTheDocument()
        expect(screen.getByText('Direct')).toBeInTheDocument()

        // The provenance is hidden until you expand.
        expect(screen.queryByText('How they have access')).not.toBeInTheDocument()

        await userEvent.click(screen.getByText('Ada Lovelace'))

        // Expanded: the exact groups she inherits through.
        expect(await screen.findByText('How they have access')).toBeInTheDocument()
        expect(screen.getByText('Alpha')).toBeInTheDocument()
        expect(screen.getByText('Beta')).toBeInTheDocument()
    })

    it('shows an empty state when no one has access', async () => {
        listEffective.mockResolvedValue({ users: [], totalUsers: 0, directUsers: 0, viaGroupUsers: 0 })
        render(<WorkspaceAccessList workspaceId="ws_1" />)

        expect(await screen.findByText(/no one has access yet/i)).toBeInTheDocument()
    })

    it('requests the effective list for the given workspace', async () => {
        listEffective.mockResolvedValue(PAGE)
        render(<WorkspaceAccessList workspaceId="ws_target" />)
        await waitFor(() => expect(listEffective).toHaveBeenCalledWith('ws_target'))
    })
})

describe('WorkspaceAccessList — thousands of people', () => {
    // 30 people, direct, named Person 1..30 (zero-padded so they sort as listed).
    const MANY: WorkspaceAccessResponse = {
        totalUsers: 30, directUsers: 30, viaGroupUsers: 0,
        users: Array.from({ length: 30 }, (_, i) => {
            const n = String(i + 1).padStart(2, '0')
            return {
                userId: `usr_${n}`, displayName: `Person ${n}`, email: `p${n}@example.com`,
                avatarId: null, status: 'active', deleted: false,
                roles: ['workspace_member'], effectiveRole: 'workspace_member',
                grants: [{ role: 'workspace_member', via: 'direct' as const, bindingId: `b${n}`, groupId: null, groupName: null, expiresAt: null }],
            }
        }),
    }

    it('mounts one page of rows at a time, and pages through the rest', async () => {
        listEffective.mockResolvedValue(MANY)
        const u = userEvent.setup()
        render(<WorkspaceAccessList workspaceId="ws_1" />)

        expect(await screen.findByText('Person 01')).toBeInTheDocument()
        expect(screen.getByText('Person 25')).toBeInTheDocument()
        expect(screen.queryByText('Person 26')).not.toBeInTheDocument()
        expect(screen.getByText('Page 1 / 2')).toBeInTheDocument()

        await u.click(screen.getByRole('button', { name: 'Next page' }))
        expect(screen.getByText('Person 26')).toBeInTheDocument()
        expect(screen.getByText('Person 30')).toBeInTheDocument()
        expect(screen.queryByText('Person 01')).not.toBeInTheDocument()
    })

    it('searches everyone, not just the page, and starts results at page one', async () => {
        listEffective.mockResolvedValue(MANY)
        const u = userEvent.setup()
        render(<WorkspaceAccessList workspaceId="ws_1" />)
        await screen.findByText('Person 01')
        await u.click(screen.getByRole('button', { name: 'Next page' }))

        // Person 03 lives on page 1; the search finds them from page 2.
        await u.type(screen.getByPlaceholderText(/search people/i), 'p03@')
        expect(screen.getByText('Person 03')).toBeInTheDocument()
        expect(screen.queryByText('Person 26')).not.toBeInTheDocument()
        expect(screen.queryByText(/Page \d \/ \d/)).not.toBeInTheDocument()
    })
})
