/**
 * A person's profile: who they are, the workspaces they run, their views and the data
 * they look after; your own id at /people/… lands on your profile; an unknown person
 * says so.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { people, views } = vi.hoisted(() => ({ people: { profile: vi.fn() }, views: vi.fn() }))
vi.mock('@/services/peopleService', () => ({ peopleService: people }))
vi.mock('@/services/viewApiService', async (orig) => ({
    ...(await orig<typeof import('@/services/viewApiService')>()), listViews: views,
}))
const talk = vi.hoisted(() => ({ getMyDiscussionSummary: vi.fn(), listMyDiscussions: vi.fn() }))
vi.mock('@/services/discussionsService', async (orig) => ({
    ...(await orig<typeof import('@/services/discussionsService')>()), ...talk,
}))
vi.mock('@/components/admin/workspace/overview/OverviewViewGrid', () => ({
    OverviewViewGrid: ({ views: vs }: { views: { id: string; name: string }[] }) => <ul>{vs.map(v => <li key={v.id}>{v.name}</li>)}</ul>,
}))

import { PersonProfilePage } from '../PersonProfilePage'
import { useAuthStore } from '@/store/auth'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { useDiscussionsDrawer } from '@/features/discussions/drawerStore'

const ada = { id: 'usr_ada', displayName: 'Ada Okafor', email: 'ada@x.io', avatarId: null, hasImage: false, deleted: false }
const profile = (over: Record<string, unknown> = {}) => ({
    person: ada, isMe: false,
    workspacesTheyRun: [{ id: 'ws_fin', name: 'Finance Risk' }],
    dataContacts: [{ dataSourceId: 'ds_gl', dataSourceName: 'General Ledger', workspaceId: 'ws_fin', workspaceName: 'Finance Risk', role: 'owner', via: 'direct' }],
    ...over,
})

function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname}{l.search}</p> }

function renderAt(path: string) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <QueryClientProvider client={client}>
            <MemoryRouter initialEntries={[path]}>
                <Routes>
                    <Route path="/people/:userId" element={<PersonProfilePage />} />
                    <Route path="/me/profile" element={<><PersonProfilePage /><Where /></>} />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    useAuthStore.setState({ user: { id: 'usr_me', firstName: 'Sam', lastName: 'Reader', email: 'sam@x.io' }, permissions: { sid: 's', global: [], ws: {} } } as never)
    views.mockResolvedValue({ items: [{ id: 'v1', name: 'Counterparty exposure', workspaceId: 'ws_fin' }], total: 1, hasMore: false })
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } })
    useDiscussionsDrawer.setState({ target: null })
    talk.getMyDiscussionSummary.mockResolvedValue({ toMe: { unread: 2, waiting: 1 }, mine: { unread: 0, open: 0 }, mentions: { unread: 0 }, watching: { unread: 0 }, totalUnread: 2 })
    talk.listMyDiscussions.mockResolvedValue({ threads: [], nextCursor: null, people: {} })
})

describe('PersonProfilePage', () => {
    it('shows who they are, what they run and the data they look after', async () => {
        people.profile.mockResolvedValue(profile())
        renderAt('/people/usr_ada')
        expect(await screen.findByRole('heading', { name: 'Ada Okafor' })).toBeInTheDocument()
        expect(screen.getByRole('link', { name: /ada@x\.io/ })).toHaveAttribute('href', 'mailto:ada@x.io')
        expect(within(screen.getByRole('list', { name: 'Workspaces they run' })).getByRole('link', { name: /Finance Risk/ })).toHaveAttribute('href', '/workspaces/ws_fin')
        expect(await screen.findByText('Counterparty exposure')).toBeInTheDocument()
        expect(screen.getByRole('link', { name: /General Ledger/ })).toHaveAttribute('href', '/workspaces/ws_fin?tab=data&section=sources&ds=ds_gl')
        expect(views).toHaveBeenCalledWith(expect.objectContaining({ createdBy: 'usr_ada' }))

        await userEvent.click(screen.getByRole('tab', { name: /Data/ }))
        expect(screen.getAllByText('Owner').length).toBeGreaterThan(0)
    })

    it('sends your own id to your profile, and offers to edit it', async () => {
        people.profile.mockResolvedValue(profile({ person: { ...ada, id: 'usr_me', displayName: 'Sam Reader' }, isMe: true }))
        renderAt('/people/usr_me?tab=views')
        expect(await screen.findByTestId('where')).toHaveTextContent('/me/profile?tab=views')
        expect(await screen.findByRole('link', { name: /Edit profile/ })).toHaveAttribute('href', '/me/account')
        expect(people.profile).toHaveBeenCalledWith('usr_me')
    })

    it('with conversations on, your own profile has your conversations and what is waiting on you', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: true } })
        people.profile.mockResolvedValue(profile({ person: { ...ada, id: 'usr_me', displayName: 'Sam Reader' }, isMe: true }))
        renderAt('/me/profile')
        expect(await screen.findByRole('tab', { name: /Conversations/ })).toHaveTextContent('2')
        expect(screen.getByRole('tab', { name: /Watching/ })).toBeInTheDocument()
        expect(await screen.findByRole('heading', { name: /Waiting on you/ })).toBeInTheDocument()
        expect(await screen.findByText('Nobody is waiting on an answer from you.')).toBeInTheDocument()
    })

    it('someone else’s profile has no conversations tab, and asks them about one of their things', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: true } })
        people.profile.mockResolvedValue(profile())
        renderAt('/people/usr_ada?tab=conversations')
        expect(await screen.findByRole('heading', { name: 'Ada Okafor' })).toBeInTheDocument()
        expect(screen.queryByRole('tab', { name: /Conversations/ })).not.toBeInTheDocument()
        expect(screen.getByRole('tab', { name: /Overview/ })).toHaveAttribute('aria-selected', 'true')

        await screen.findByText('Counterparty exposure')
        await userEvent.click(screen.getByRole('button', { name: /Ask a question/ }))
        await userEvent.click(await screen.findByRole('menuitem', { name: /General Ledger/ }))
        expect(useDiscussionsDrawer.getState().target).toMatchObject({
            subject: { type: 'data_source', id: 'ds_gl', name: 'General Ledger' }, compose: true, recipients: ['usr_ada'],
        })
    })

    it('says so when the person can’t be found', async () => {
        people.profile.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }))
        renderAt('/people/usr_nobody')
        expect(await screen.findByText('We couldn’t find that person')).toBeInTheDocument()
    })
})
