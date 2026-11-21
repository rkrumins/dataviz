/**
 * A link to a message — from the Inbox, or Copy link — opens the questions drawer on its thread,
 * scrolled to the message and focused on it. Esc steps back: to the list, then closed; the
 * address follows, and closing the drawer takes the link away.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { SUBJECT_PEOPLE, thread } from './fixtures'

const api = vi.hoisted(() => ({
    getThread: vi.fn(),
    markThreadRead: vi.fn(),
    getSubjectSummary: vi.fn(),
    getSubjectPeople: vi.fn(),
    listSubjectThreads: vi.fn(),
    listMentionable: vi.fn(),
}))
vi.mock('@/services/discussionsService', async (orig) => ({
    ...(await orig<typeof import('@/services/discussionsService')>()),
    ...api,
}))
vi.mock('@/store/auth', () => ({
    useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'u_me', displayName: 'Me Myself' } }),
}))

import { DiscussionsDrawerHost } from '../DiscussionsDrawer'
import { useDiscussionDeepLink } from '../useDiscussionDeepLink'
import { useDiscussionsDrawer } from '../drawerStore'

function ViewPageStandIn() {
    useDiscussionDeepLink({ type: 'view', id: 'v1', name: 'Revenue' })
    const loc = useLocation()
    return <p data-testid="address">{loc.search}</p>
}

function renderAt(url: string) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={[url]}>
                <button type="button">Somewhere on the page</button>
                <ViewPageStandIn />
                <DiscussionsDrawerHost />
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset())
    api.getThread.mockResolvedValue(thread())
    api.markThreadRead.mockResolvedValue({ lastReadAt: new Date().toISOString() })
    api.getSubjectSummary.mockResolvedValue({ open: 1, answered: 0, closed: 0, total: 1, unread: 0, watching: false, latest: 'x', byEntity: {} })
    api.getSubjectPeople.mockResolvedValue(SUBJECT_PEOPLE)
    api.listSubjectThreads.mockResolvedValue({ threads: [thread()], nextCursor: null, latest: 'x', people: thread().people })
    api.listMentionable.mockResolvedValue({ people: [] })
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: true } })
    useDiscussionsDrawer.setState({ target: null })
})

describe('DiscussionsDrawer', () => {
    it('opens on the linked thread and focuses the linked message', async () => {
        renderAt('/views/v1?discussion=th_1&message=m_1')
        expect(await screen.findByRole('dialog', { name: 'Questions' })).toBeInTheDocument()
        const target = await screen.findByRole('article', { name: 'Reply from Ana Silva' })
        await waitFor(() => expect(document.activeElement).toBe(target))
        expect(target.className).toMatch(/ring-accent-lineage/)
        expect(api.getThread).toHaveBeenCalledWith('th_1')
    })

    it('steps back with Esc — to the list, then closed — and takes the link away', async () => {
        renderAt('/views/v1?discussion=th_1&message=m_1')
        await screen.findByRole('article', { name: 'Reply from Ana Silva' })
        fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
        expect(await screen.findByRole('button', { name: 'Ask a question' })).toBeInTheDocument()
        await waitFor(() => expect(screen.getByTestId('address')).toHaveTextContent(/^$/))
        fireEvent.keyDown(document.body, { key: 'Escape' })
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })

    it('follows the thread the drawer shows in the address', async () => {
        renderAt('/views/v1')
        act(() => useDiscussionsDrawer.getState().open({ subject: { type: 'view', id: 'v1' } }))
        fireEvent.click(await screen.findByRole('button', { name: /Me Myself asked/ }))
        await waitFor(() => expect(screen.getByTestId('address')).toHaveTextContent('?discussion=th_1'))
        fireEvent.click(screen.getByRole('button', { name: 'Close questions' }))
        await waitFor(() => expect(screen.getByTestId('address')).toHaveTextContent(/^$/))
    })
})
