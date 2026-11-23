/**
 * Asking reads like a message: who it goes to (the view's owners and the data's owners, both on
 * by default, each with a count; anyone else by name), who can see it (in plain words), then the
 * question. Someone who can't open the view is named before it is sent.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { PEOPLE, SUBJECT_PEOPLE, thread } from './fixtures'

const api = vi.hoisted(() => ({
    getSubjectPeople: vi.fn(),
    listMentionable: vi.fn(),
    askQuestion: vi.fn(),
}))
vi.mock('@/services/discussionsService', async (orig) => ({
    ...(await orig<typeof import('@/services/discussionsService')>()),
    ...api,
}))
const views = vi.hoisted(() => ({ getView: vi.fn() }))
vi.mock('@/services/viewApiService', async (orig) => ({
    ...(await orig<typeof import('@/services/viewApiService')>()),
    ...views,
}))
vi.mock('@/services/viewGrantsService', () => ({
    viewGrantsService: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn(), setSourceQuery: vi.fn(), delete: vi.fn() },
}))
vi.mock('@/store/auth', () => ({
    useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'u_me', displayName: 'Me Myself' } }),
    usePermission: () => false,
}))

import { AskComposer } from '../AskComposer'
import type { ViewAccess } from '@/services/viewApiService'

const MANAGES_SHARING: ViewAccess = {
    canEdit: true, canManageGrants: true, canChangeVisibility: true, canPublish: false, accessVia: 'owner', dataAccess: 'full',
}
const READS_ONLY: ViewAccess = {
    canEdit: false, canManageGrants: false, canChangeVisibility: false, canPublish: false, accessVia: 'workspace', dataAccess: 'readonly',
}
const theView = (access: ViewAccess) => ({
    id: 'v1', name: 'Revenue', workspaceId: 'ws1', viewType: 'graph', config: {}, visibility: 'workspace',
    isPinned: false, favouriteCount: 0, isFavourited: false, createdAt: 'x', updatedAt: 'x', access,
})

const subject = { type: 'view' as const, id: 'v1', name: 'Revenue' }

function renderAsk(props: Partial<React.ComponentProps<typeof AskComposer>> = {}) {
    const onAsked = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <QueryClientProvider client={qc}>
            <MemoryRouter>
                <AskComposer subject={subject} onAsked={onAsked} {...props} />
            </MemoryRouter>
        </QueryClientProvider>,
    )
    return { onAsked }
}

beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset())
    api.getSubjectPeople.mockResolvedValue(SUBJECT_PEOPLE)
    api.listMentionable.mockResolvedValue({ people: [{ ...PEOPLE.u_fay, hint: null }, { ...PEOPLE.u_bo, hint: 'Data owner' }] })
    api.askQuestion.mockResolvedValue({ thread: thread({ id: 'th_new' }), reached: ['u_ana', 'u_bo'], notReached: [], usedFallback: false })
    views.getView.mockReset()
    views.getView.mockResolvedValue(theView(READS_ONLY))
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: true } })
})

describe('AskComposer', () => {
    it('sends to the view’s owners and the data’s owners by default, counting each', async () => {
        renderAsk()
        // The asker is never one of the people they ask.
        const owners = await screen.findByRole('switch', { name: /View’s owners \(1\)/ })
        const data = screen.getByRole('switch', { name: /Data owners \(2\)/ })
        expect(owners).toHaveAttribute('aria-checked', 'true')
        expect(data).toHaveAttribute('aria-checked', 'true')
        expect(owners).toHaveAccessibleName(/Ana Silva/)
        expect(data).toHaveAccessibleName(/Bo Chen and Fay Liu/)
    })

    it('names someone it can’t reach before it is sent', async () => {
        renderAsk()
        expect(await screen.findByText(/Fay Liu can’t open this view, so won’t be asked/)).toBeInTheDocument()
        // Not asking the data's owners takes the warning away with them.
        fireEvent.click(screen.getByRole('switch', { name: /Data owners/ }))
        expect(screen.queryByText(/Fay Liu can’t open this view/)).not.toBeInTheDocument()
    })

    it('offers to share the view with whoever can’t open it, to someone who manages its sharing', async () => {
        views.getView.mockResolvedValue(theView(MANAGES_SHARING))
        renderAsk()
        await screen.findByText(/Fay Liu can’t open this view/)
        fireEvent.click(await screen.findByRole('button', { name: 'Share this view' }))
        expect(await screen.findByRole('heading', { name: 'Share View' })).toBeInTheDocument()
        // Shared: closing the dialog asks again who can open it, and Fay can now be asked.
        api.getSubjectPeople.mockResolvedValue({
            ...SUBJECT_PEOPLE,
            dataContacts: { ...SUBJECT_PEOPLE.dataContacts, stewards: [{ ...SUBJECT_PEOPLE.dataContacts.stewards[0], canRead: true }] },
        })
        const calls = api.getSubjectPeople.mock.calls.length
        fireEvent.keyDown(window, { key: 'Escape' })
        await waitFor(() => expect(screen.queryByRole('heading', { name: 'Share View' })).not.toBeInTheDocument())
        await waitFor(() => expect(api.getSubjectPeople.mock.calls.length).toBeGreaterThan(calls))
        await waitFor(() => expect(screen.queryByText(/Fay Liu can’t open this view/)).not.toBeInTheDocument())
    })

    it('offers no Share to someone who can’t change who sees the view', async () => {
        renderAsk()
        await screen.findByText(/Fay Liu can’t open this view/)
        await waitFor(() => expect(views.getView).toHaveBeenCalledWith('v1', undefined, { silent403: true }))
        expect(screen.queryByRole('button', { name: 'Share this view' })).not.toBeInTheDocument()
    })

    it('says in plain words who can see a private question', async () => {
        renderAsk()
        expect(await screen.findByText(/Anyone who can open this view can read it and reply/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('radio', { name: 'Only the people involved' }))
        expect(screen.getByText(/Only you, the people you ask or mention, anyone who replies, this view’s owners and the workspace’s admins will see it/))
            .toBeInTheDocument()
    })

    it('asks with the routes, the people added, who can see it, the node and a key — on ⌘↵', async () => {
        const { onAsked } = renderAsk({ entity: { id: 'urn:t1', label: 'gl_balances' } })
        await screen.findByRole('switch', { name: /View’s owners/ })
        fireEvent.click(screen.getByRole('switch', { name: /View’s owners/ }))
        fireEvent.click(screen.getByRole('button', { name: 'Add people' }))
        fireEvent.change(screen.getByRole('combobox', { name: 'Find someone to ask' }), { target: { value: 'fa' } })
        fireEvent.mouseDown(await screen.findByRole('option', { name: /Fay Liu/ }))
        expect(screen.getByRole('button', { name: 'Don’t ask Fay Liu' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('radio', { name: 'Only the people involved' }))
        const box = screen.getByRole('combobox', { name: 'What would you like to know about gl_balances?' })
        fireEvent.change(box, { target: { value: 'Why two rows per account?' } })
        fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
        await waitFor(() => expect(api.askQuestion).toHaveBeenCalledTimes(1))
        expect(api.askQuestion).toHaveBeenCalledWith({ type: 'view', id: 'v1', name: 'Revenue' }, {
            body: 'Why two rows per account?', visibility: 'private', mentions: [], clientKey: expect.any(String),
            route: { viewOwners: false, dataContacts: true }, recipientIds: ['u_fay'],
            entityId: 'urn:t1', entityLabel: 'gl_balances',
        })
        await waitFor(() => expect(onAsked).toHaveBeenCalledWith(expect.objectContaining({ reached: ['u_ana', 'u_bo'] })))
    })

    it('asks a data source’s data owners only', async () => {
        renderAsk({ subject: { type: 'data_source', id: 'ds1', name: 'Finance marts' } })
        expect(await screen.findByRole('switch', { name: /Data owners/ })).toBeInTheDocument()
        expect(screen.queryByRole('switch', { name: /View’s owners/ })).not.toBeInTheDocument()
    })
})
