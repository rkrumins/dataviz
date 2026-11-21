/**
 * Groups on the People tab: what each can do, who's in it, whether it follows the
 * identity provider — and, for the workspace's admins, making one, changing its role
 * and asking for its link. Platform groups bound here stay read-only.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { groupsApi, idpApi } = vi.hoisted(() => ({
    groupsApi: {
        list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), members: vi.fn(),
        addMember: vi.fn(), removeMember: vi.fn(), linkIdp: vi.fn(), unlinkIdp: vi.fn(),
    },
    idpApi: { suggestions: vi.fn(), preview: vi.fn() },
}))
vi.mock('@/services/workspaceGroupsService', () => ({
    workspaceGroupsService: groupsApi,
    idpGroupsService: idpApi,
    idpLinkRequestsService: { list: vi.fn().mockResolvedValue([]), link: vi.fn(), decline: vi.fn() },
}))
vi.mock('@/components/serviceAccounts/SubjectPicker', () => ({
    subjectKey: (s: { type: string; id: string }) => `${s.type}:${s.id}`,
    SubjectPicker: ({ onPick }: { onPick: (s: { type: string; id: string; name: string; detail: string }) => void }) => (
        <button type="button" onClick={() => onPick({ type: 'user', id: 'usr_ada', name: 'Ada Okafor', detail: 'ada@example.com' })}>
            pick Ada
        </button>
    ),
}))

import { WorkspaceGroupsPanel } from '../WorkspaceGroupsPanel'
import { useAuthStore } from '@/store/auth'
import { useWorkspacesStore } from '@/store/workspaces'

const group = (over: Record<string, unknown> = {}) => ({
    id: 'grp_eng', name: 'Finance Data · Engineers', shortName: 'Engineers', description: null, owned: true,
    role: 'workspace_member', roleLabel: 'Member', memberCount: 2,
    memberPreview: [{ id: 'usr_ada', displayName: 'Ada Okafor' }, { id: 'usr_bo', displayName: 'Bo Li' }],
    source: 'local', idpLinks: [], pendingIdpLink: null, createdAt: '2026-11-20T09:00:00Z', ...over,
})

function renderPanel(canManage = true) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onChanged = vi.fn()
    render(
        <QueryClientProvider client={client}>
            <WorkspaceGroupsPanel workspaceId="ws_fin" canManage={canManage} onChanged={onChanged} />
        </QueryClientProvider>,
    )
    return { onChanged }
}

beforeEach(() => {
    vi.clearAllMocks()
    useAuthStore.setState({
        permissions: { sid: 's', global: [], ws: { ws_fin: ['workspace:admin', 'workspace:members:add'] } },
    } as never)
    useWorkspacesStore.setState({ workspaces: [{ id: 'ws_fin', name: 'Finance Data' }] } as never)
    idpApi.suggestions.mockResolvedValue([])
    groupsApi.members.mockResolvedValue([
        { id: 'usr_ada', displayName: 'Ada Okafor', email: 'ada@x.io', source: 'local', addedAt: '2026-11-20T09:00:00Z' },
        { id: 'usr_bo', displayName: 'Bo Li', email: 'bo@x.io', source: 'sso', addedAt: '2026-11-20T09:00:00Z' },
    ])
})

describe('WorkspaceGroupsPanel', () => {
    it('shows each group’s access, people and identity-provider link', async () => {
        groupsApi.list.mockResolvedValue([
            group(),
            group({ id: 'grp_v', shortName: 'Viewers', name: 'Finance Data · Viewers', role: 'workspace_viewer',
                idpLinks: [{ mappingId: 'm1', idpGroup: 'AD-Finance' }] }),
            group({ id: 'grp_p', shortName: 'Publishers', name: 'Finance Data · Publishers', role: 'workspace_publisher',
                pendingIdpLink: { requestId: 'ilr_1', idpGroup: 'AD-Pub', requestedBy: 'usr_ada', requestedAt: '2026-11-20T09:00:00Z' } }),
        ])
        renderPanel()
        const eng = await screen.findByRole('button', { name: 'Open Engineers' })
        expect(within(eng).getByText('Can edit')).toBeInTheDocument()
        expect(within(eng).getByText('2 people')).toBeInTheDocument()
        expect(within(screen.getByRole('button', { name: 'Open Viewers' })).getByText('Follows AD-Finance')).toBeInTheDocument()
        expect(within(screen.getByRole('button', { name: 'Open Publishers' })).getByText('Link to AD-Pub waiting')).toBeInTheDocument()
    })

    it('makes a group from a starter, carrying the workspace’s name', async () => {
        groupsApi.list.mockResolvedValue([])
        groupsApi.create.mockResolvedValue(group({ id: 'grp_new', shortName: 'Viewers', role: 'workspace_viewer' }))
        const { onChanged } = renderPanel()
        await userEvent.click(await screen.findByRole('button', { name: /Viewers · Can view/ }))
        const dialog = screen.getByRole('dialog', { name: 'New group' })
        expect(within(dialog).getByLabelText('Group name')).toHaveValue('Viewers')
        expect(within(dialog).getByText('Made as “Finance Data · Viewers”')).toBeInTheDocument()
        await userEvent.click(within(dialog).getByRole('button', { name: 'pick Ada' }))
        await userEvent.click(within(dialog).getByRole('button', { name: 'Create group' }))
        await waitFor(() => expect(groupsApi.create).toHaveBeenCalledWith('ws_fin', {
            name: 'Viewers', description: undefined, role: 'workspace_viewer', memberIds: ['usr_ada'], idpGroup: undefined,
        }))
        expect(onChanged).toHaveBeenCalled()
    })

    it('offers a free name when the one asked for is taken', async () => {
        groupsApi.list.mockResolvedValue([])
        groupsApi.create.mockRejectedValue(Object.assign(new Error('taken'), {
            status: 409, detail: { type: 'group_name_taken', suggestion: 'Editors 2' },
        }))
        renderPanel()
        await userEvent.click(await screen.findByRole('button', { name: /Editors · Can edit/ }))
        const dialog = screen.getByRole('dialog', { name: 'New group' })
        await userEvent.click(within(dialog).getByRole('button', { name: 'Create group' }))
        await userEvent.click(await within(dialog).findByRole('button', { name: 'Use “Editors 2”' }))
        expect(within(dialog).getByLabelText('Group name')).toHaveValue('Editors 2')
    })

    it('changes an owned group’s role and asks for its identity-provider link', async () => {
        groupsApi.list.mockResolvedValue([group()])
        groupsApi.update.mockResolvedValue(group({ role: 'workspace_viewer' }))
        groupsApi.linkIdp.mockResolvedValue(group())
        renderPanel()
        await userEvent.click(await screen.findByRole('button', { name: 'Open Engineers' }))
        const drawer = screen.getByRole('dialog', { name: 'Engineers' })
        await userEvent.click(within(drawer).getByRole('radio', { name: /Can view/ }))
        await waitFor(() => expect(groupsApi.update).toHaveBeenCalledWith('ws_fin', 'grp_eng', { role: 'workspace_viewer' }))

        // Someone the identity provider added leaves through it; someone added here can go.
        expect(await within(drawer).findByText('From the directory')).toBeInTheDocument()
        expect(within(drawer).queryByRole('button', { name: 'Remove Bo Li' })).not.toBeInTheDocument()
        expect(within(drawer).getByRole('button', { name: 'Remove Ada Okafor' })).toBeInTheDocument()

        await userEvent.type(within(drawer).getByRole('combobox', { name: 'Identity-provider group' }), 'AD-Eng')
        await userEvent.click(within(drawer).getByRole('button', { name: 'Ask to link' }))
        await waitFor(() => expect(groupsApi.linkIdp).toHaveBeenCalledWith('ws_fin', 'grp_eng', 'AD-Eng', undefined))
    })

    it('keeps platform groups read-only, and stewards can’t make groups', async () => {
        groupsApi.list.mockResolvedValue([group({ id: 'grp_all', owned: false, shortName: 'All analysts', name: 'All analysts' })])
        renderPanel(false)
        await userEvent.click(await screen.findByRole('button', { name: 'Open All analysts' }))
        const drawer = screen.getByRole('dialog', { name: 'All analysts' })
        expect(within(drawer).getByText(/managed on Admin → Groups/)).toBeInTheDocument()
        expect(within(drawer).queryByRole('radio')).not.toBeInTheDocument()
        expect(within(drawer).queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'New group' })).not.toBeInTheDocument()
    })
})
