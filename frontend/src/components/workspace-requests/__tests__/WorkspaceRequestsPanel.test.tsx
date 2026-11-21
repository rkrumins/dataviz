/**
 * The platform team's side: requests waiting for a workspace, and reviewing one. Approve says what
 * will happen and lets the name be tidied (a taken one comes back with a free one); Send back needs
 * a question; Decline takes an optional reason.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceRequest } from '@/services/workspaceRequestsService'

const api = vi.hoisted(() => ({ listToAnswer: vi.fn(), get: vi.fn(), approve: vi.fn(), sendBack: vi.fn(), decline: vi.fn(), linkIdpGroup: vi.fn() }))
vi.mock('@/services/ssoAdminService', () => ({
    ssoAdminService: { listProviders: vi.fn().mockResolvedValue([{ id: 'idp_entra', displayName: 'Entra ID' }]) },
}))
vi.mock('@/services/workspaceRequestsService', async (orig) => {
    const real = await orig<typeof import('@/services/workspaceRequestsService')>()
    return { ...real, workspaceRequestsService: { ...real.workspaceRequestsService, ...api } }
})

import { IdpLinksToConfirm, WorkspaceRequestsPanel } from '../WorkspaceRequestsPanel'
import { useAuthStore } from '@/store/auth'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'

const REQUEST = {
    id: 'wsr_1', requesterId: 'usr_ada', requesterName: 'Ada Okafor', name: 'ML lineage', purpose: 'poc',
    description: 'Lineage for the ML platform', teammateIds: ['usr_ben'], teammates: [{ id: 'usr_ben', displayName: 'Ben Hall' }],
    playgroundSourceIds: ['ds_1'], playgroundSources: [{ id: 'ds_1', label: 'Feature store', viewCount: 3 }],
    dataNeeds: 'Snowflake ML marts', status: 'pending', createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
} as unknown as WorkspaceRequest

function renderPanel() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter><WorkspaceRequestsPanel /></MemoryRouter>
        </QueryClientProvider>,
    )
}

async function openReview() {
    const user = userEvent.setup()
    renderPanel()
    await user.click(await screen.findByRole('button', { name: 'Review' }))
    return { user, drawer: screen.getByRole('dialog', { name: 'ML lineage' }) }
}

beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset()
    api.listToAnswer.mockResolvedValue([REQUEST])
    api.get.mockResolvedValue(REQUEST)
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, workspaceRequestsEnabled: true } })
    useAuthStore.setState({ permissions: { global: ['system:workspaces:create'], ws: {} } } as never)
})

describe('WorkspaceRequestsPanel', () => {
    it('lists who asked for what, and what comes with it', async () => {
        renderPanel()
        const row = (await screen.findByText('ML lineage')).closest('li')!
        expect(within(row).getByText(/From Ada Okafor/)).toBeInTheDocument()
        expect(within(row).getByText('1 teammate')).toBeInTheDocument()
        expect(within(row).getByText(/1 graph from the Playground/)).toBeInTheDocument()
        expect(within(row).getByText(/Waiting 2 days/)).toBeInTheDocument()
    })

    it('approves with a tidied name, after saying what will happen', async () => {
        api.approve.mockResolvedValue({ ...REQUEST, status: 'approved', workspaceId: 'ws_new', name: 'ML Lineage',
            outcome: { workspaceId: 'ws_new', movedSources: ['ds_1'], failedSources: [], membersAdded: ['usr_ben'] } })
        const { user, drawer } = await openReview()
        await user.click(within(drawer).getByRole('button', { name: /Approve…/ }))
        expect(within(drawer).getByText('Make Ada Okafor its admin')).toBeInTheDocument()
        expect(within(drawer).getByText('Add 1 teammate as a member')).toBeInTheDocument()
        expect(within(drawer).getByText('Move 1 graph (3 views) from the Playground')).toBeInTheDocument()
        const name = within(drawer).getByRole('textbox', { name: 'Name' })
        await user.clear(name)
        await user.type(name, 'ML Lineage')
        await user.click(within(drawer).getByRole('button', { name: /Approve and create/ }))
        expect(api.approve).toHaveBeenCalledWith('wsr_1', { name: 'ML Lineage', description: 'Lineage for the ML platform' })
        expect(await within(drawer).findByText('“ML Lineage” is ready')).toBeInTheDocument()
    })

    it('offers a free name when the one asked for is taken', async () => {
        api.approve.mockRejectedValue(Object.assign(new Error('taken'), { status: 409, detail: { type: 'name_taken', suggestion: 'ML lineage 2' } }))
        const { user, drawer } = await openReview()
        await user.click(within(drawer).getByRole('button', { name: /Approve…/ }))
        await user.click(within(drawer).getByRole('button', { name: /Approve and create/ }))
        await user.click(await within(drawer).findByRole('button', { name: 'Use “ML lineage 2”' }))
        expect(within(drawer).getByRole('textbox', { name: 'Name' })).toHaveValue('ML lineage 2')
    })

    it('sends it back only with a question', async () => {
        api.sendBack.mockResolvedValue({ ...REQUEST, status: 'changes_requested' })
        const { user, drawer } = await openReview()
        await user.click(within(drawer).getByRole('button', { name: /Send back/ }))
        const send = within(drawer).getAllByRole('button', { name: /Send back/ }).at(-1)!
        expect(send).toBeDisabled()
        await user.type(within(drawer).getByRole('textbox'), 'Who owns it later?')
        await user.click(send)
        expect(api.sendBack).toHaveBeenCalledWith('wsr_1', 'Who owns it later?')
    })

    it('declines, with a reason if one is given', async () => {
        api.decline.mockResolvedValue({ ...REQUEST, status: 'declined' })
        const { user, drawer } = await openReview()
        await user.click(within(drawer).getByRole('button', { name: /Decline/ }))
        await user.click(within(drawer).getAllByRole('button', { name: /Decline/ }).at(-1)!)
        expect(api.decline).toHaveBeenCalledWith('wsr_1', undefined)
    })
})

describe('Groups asked for with the workspace', () => {
    const WITH_GROUPS = {
        ...REQUEST,
        groups: [{ key: 'g1', name: 'Engineers', role: 'workspace_publisher', memberIds: ['usr_ben'],
            members: [{ id: 'usr_ben', displayName: 'Ben Hall' }], idpGroup: 'ML-Engineers' }],
    } as unknown as WorkspaceRequest

    it('lets a platform administrator rename them and link them to the identity provider', async () => {
        useAuthStore.setState({ permissions: { global: ['system:admin', 'system:workspaces:create'], ws: {} } } as never)
        api.get.mockResolvedValue(WITH_GROUPS)
        api.approve.mockResolvedValue({ ...WITH_GROUPS, status: 'approved', workspaceId: 'ws_new',
            outcome: { workspaceId: 'ws_new', movedSources: [], failedSources: [], membersAdded: [],
                groupsCreated: [{ key: 'g1', groupId: 'grp_1', name: 'ML Engineers' }], idpLinksCreated: [{ groupId: 'grp_1', idpGroup: 'ML-Engineers' }] } })
        const { user, drawer } = await openReview()
        expect(await within(drawer).findByText('ML lineage · Engineers')).toBeInTheDocument()
        expect(within(drawer).getByText('ML-Engineers')).toBeInTheDocument()
        await user.click(within(drawer).getByRole('button', { name: /Approve…/ }))
        expect(within(drawer).getByText('Link 1 group to the identity provider')).toBeInTheDocument()
        await user.selectOptions(await within(drawer).findByRole('combobox', { name: 'Identity-provider connection' }), 'idp_entra')
        const groupName = within(drawer).getByRole('textbox', { name: 'Name for Engineers' })
        await user.clear(groupName)
        await user.type(groupName, 'ML Engineers')
        await user.click(within(drawer).getByRole('button', { name: /Approve and create/ }))
        expect(api.approve).toHaveBeenCalledWith('wsr_1', expect.objectContaining({
            groupNames: { g1: 'ML Engineers' }, idpProviderId: 'idp_entra',
        }))
        expect(await within(drawer).findByText(/1 group linked to the identity provider/)).toBeInTheDocument()
    })

    it('tells an Org Admin the links will wait for a platform administrator', async () => {
        api.get.mockResolvedValue(WITH_GROUPS)
        const { user, drawer } = await openReview()
        await user.click(within(drawer).getByRole('button', { name: /Approve…/ }))
        expect(within(drawer).getByText(/1 link will wait for one to confirm/)).toBeInTheDocument()
        expect(within(drawer).queryByRole('combobox', { name: 'Identity-provider connection' })).not.toBeInTheDocument()
    })

    it('lists the links waiting for a platform administrator, and links one', async () => {
        useAuthStore.setState({ permissions: { global: ['system:admin', 'system:workspaces:create'], ws: {} } } as never)
        api.listToAnswer.mockImplementation((status: string) => Promise.resolve(status === 'approved' ? [{
            ...REQUEST, status: 'approved', workspaceId: 'ws_new',
            outcome: { workspaceId: 'ws_new', movedSources: [], failedSources: [], membersAdded: [],
                idpLinksPending: [{ groupId: 'grp_1', groupName: 'ML lineage · Engineers', idpGroup: 'ML-Engineers' }] },
        }] : []))
        api.linkIdpGroup.mockResolvedValue({ ...REQUEST, status: 'approved' })
        const user = userEvent.setup()
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(<QueryClientProvider client={qc}><MemoryRouter><IdpLinksToConfirm /></MemoryRouter></QueryClientProvider>)
        const row = (await screen.findByText('ML lineage · Engineers')).closest('li')!
        await user.click(within(row).getByRole('button', { name: /Link/ }))
        expect(api.linkIdpGroup).toHaveBeenCalledWith('wsr_1', 'grp_1', null)
    })

    it('shows no links to confirm to an Org Admin', async () => {
        api.listToAnswer.mockResolvedValue([{ ...REQUEST, status: 'approved',
            outcome: { movedSources: [], failedSources: [], membersAdded: [], idpLinksPending: [{ groupId: 'g', groupName: 'X', idpGroup: 'Y' }] } }])
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(<QueryClientProvider client={qc}><MemoryRouter><IdpLinksToConfirm /></MemoryRouter></QueryClientProvider>)
        await new Promise(r => setTimeout(r, 20))
        expect(screen.queryByText('Identity-provider links to confirm')).not.toBeInTheDocument()
    })
})

describe('A sandbox connection that names its workspaces', () => {
    const CLOSED = { ...REQUEST, sandboxAdmitsNew: false } as unknown as WorkspaceRequest

    it('lets a platform administrator let the new workspace in, on by default', async () => {
        useAuthStore.setState({ permissions: { global: ['system:admin', 'system:workspaces:create'], ws: {} } } as never)
        api.get.mockResolvedValue(CLOSED)
        api.approve.mockResolvedValue({ ...CLOSED, status: 'approved', workspaceId: 'ws_new',
            outcome: { workspaceId: 'ws_new', movedSources: ['ds_1'], failedSources: [], membersAdded: [] } })
        const { user, drawer } = await openReview()
        expect(await within(drawer).findByText(/only lets in workspaces it names/)).toBeInTheDocument()
        expect(within(drawer).getByRole('checkbox', { name: /Let the new workspace in/ })).toBeChecked()
        await user.click(within(drawer).getByRole('button', { name: /Approve…/ }))
        await user.click(within(drawer).getByRole('button', { name: /Approve and create/ }))
        expect(api.approve).toHaveBeenCalledWith('wsr_1', expect.objectContaining({ admitToSandbox: true }))
    })

    it('tells an Org Admin the graphs stay in the Playground until a platform administrator lets it in', async () => {
        api.get.mockResolvedValue(CLOSED)
        const { drawer } = await openReview()
        expect(await within(drawer).findByText(/stay in the Playground for now/)).toBeInTheDocument()
        expect(within(drawer).queryByRole('checkbox')).not.toBeInTheDocument()
    })
})
