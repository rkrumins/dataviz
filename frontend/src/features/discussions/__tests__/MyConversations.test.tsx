/**
 * Your conversations on your profile: the boxes with their unread counts, a row per thread
 * saying what it is about, the thread opening beside the list (kept in the address), and what
 * you watch, with a way to stop.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { thread } from './fixtures'

const api = vi.hoisted(() => ({
    listMyDiscussions: vi.fn(),
    getMyDiscussionSummary: vi.fn(),
    listMyWatches: vi.fn(),
    unwatchSubject: vi.fn(),
    getThread: vi.fn(),
    markThreadRead: vi.fn(),
    listMentionable: vi.fn(),
}))
vi.mock('@/services/discussionsService', async (orig) => ({
    ...(await orig<typeof import('@/services/discussionsService')>()),
    ...api,
}))
vi.mock('@/store/auth', () => ({
    useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'u_me', displayName: 'Me Myself' } }),
}))

import { ConversationsTab, WatchingTab } from '../MyConversations'

function Where() { const l = useLocation(); return <p data-testid="where">{l.search}</p> }

function renderAt(url: string, ui: React.ReactNode) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={[url]}>{ui}<Where /></MemoryRouter>
        </QueryClientProvider>,
    )
}

const SUMMARY = { toMe: { unread: 2, waiting: 1 }, mine: { unread: 0, open: 1 }, mentions: { unread: 1 }, watching: { unread: 0 }, totalUnread: 3 }

beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset())
    const t = thread({ unread: true })
    api.listMyDiscussions.mockResolvedValue({ threads: [t], nextCursor: null, people: t.people })
    api.getMyDiscussionSummary.mockResolvedValue(SUMMARY)
    api.getThread.mockResolvedValue(thread())
    api.markThreadRead.mockResolvedValue({ lastReadAt: new Date().toISOString() })
    api.listMentionable.mockResolvedValue({ people: [] })
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: true } })
})

describe('ConversationsTab', () => {
    it('shows each box with its unread count and a row saying what each thread is about', async () => {
        renderAt('/me/profile?tab=conversations', <ConversationsTab />)
        const boxes = screen.getByRole('radiogroup', { name: 'Which conversations' })
        expect(await within(boxes).findByRole('radio', { name: /To me.*2/ })).toBeChecked()
        expect(within(boxes).getByRole('radio', { name: /Mentions.*1/ })).toBeInTheDocument()
        const row = await screen.findByRole('button', { name: /Unread\. Me Myself asked about Revenue: Where does the tier column/ })
        expect(row).toHaveTextContent('Finance')
        expect(api.listMyDiscussions).toHaveBeenCalledWith('to-me', 'all', expect.anything())
    })

    it('opens a thread beside the list, kept in the address, with the way to its view', async () => {
        renderAt('/me/profile?tab=conversations', <ConversationsTab />)
        await userEvent.click(await screen.findByRole('button', { name: /asked about Revenue/ }))
        expect(screen.getByTestId('where')).toHaveTextContent('thread=th_1')
        expect(await screen.findByRole('article', { name: 'Reply from Ana Silva' })).toBeInTheDocument()
        expect(screen.getByRole('link', { name: /Open the view/ })).toHaveAttribute('href', '/views/v1?discussion=th_1')
        expect(screen.getByRole('button', { name: /asked about Revenue/ })).toHaveAttribute('aria-current', 'true')
    })

    it('changing box asks for that box and closes the open thread', async () => {
        renderAt('/me/profile?tab=conversations&thread=th_1', <ConversationsTab />)
        await userEvent.click(await screen.findByRole('radio', { name: /Mine/ }))
        await waitFor(() => expect(api.listMyDiscussions).toHaveBeenCalledWith('mine', 'all', expect.anything()))
        expect(screen.getByTestId('where')).toHaveTextContent('box=mine')
        expect(screen.getByTestId('where')).not.toHaveTextContent('thread=')
    })

    it('says what lands in an empty box', async () => {
        api.listMyDiscussions.mockResolvedValue({ threads: [], nextCursor: null, people: {} })
        renderAt('/me/profile?tab=conversations&box=mentions', <ConversationsTab />)
        expect(await screen.findByText('No mentions')).toBeInTheDocument()
    })
})

describe('WatchingTab', () => {
    it('lists what you watch and stops watching one', async () => {
        const subject = { type: 'data_source' as const, id: 'ds_gl', name: 'General Ledger', workspaceId: 'ws1', workspaceName: 'Finance', link: '/workspaces/ws1?tab=data&section=sources&ds=ds_gl' }
        api.listMyWatches.mockResolvedValue({ items: [{ subject, createdAt: new Date().toISOString(), open: 2 }], nextCursor: null })
        api.unwatchSubject.mockResolvedValue({ watching: false })
        renderAt('/me/profile?tab=watching', <WatchingTab />)
        expect(await screen.findByRole('link', { name: /General Ledger/ })).toHaveAttribute('href', subject.link)
        expect(screen.getByText('2 open')).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: 'Stop watching General Ledger' }))
        await waitFor(() => expect(api.unwatchSubject).toHaveBeenCalledWith(subject))
    })
})
