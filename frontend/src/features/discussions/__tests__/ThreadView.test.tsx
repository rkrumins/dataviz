/**
 * A thread reads as a conversation the reader can trust: the accepted answer is framed and says
 * who accepted it, a line marks what is new since they last looked, a reply that failed stays
 * with Retry (sent with the same key, so it is never written twice), a reply someone else posts
 * is spoken, and a change someone else made first says so, with Reload.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { PEOPLE, message, staleError, thread } from './fixtures'

const api = vi.hoisted(() => ({
    getThread: vi.fn(),
    postReply: vi.fn(),
    markThreadRead: vi.fn(),
    closeThread: vi.fn(),
    listMentionable: vi.fn(),
}))
vi.mock('@/services/discussionsService', async (orig) => ({
    ...(await orig<typeof import('@/services/discussionsService')>()),
    ...api,
}))
vi.mock('@/store/auth', () => ({
    useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'u_me', displayName: 'Me Myself' } }),
}))

import { ThreadView } from '../ThreadView'
import { useDiscussionsDrawer } from '../drawerStore'

function renderThread(props: Partial<React.ComponentProps<typeof ThreadView>> = {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <QueryClientProvider client={qc}>
            <MemoryRouter>
                <ThreadView threadId="th_1" {...props} />
            </MemoryRouter>
        </QueryClientProvider>,
    )
    return qc
}

beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset())
    api.markThreadRead.mockResolvedValue({ lastReadAt: new Date().toISOString() })
    api.listMentionable.mockResolvedValue({ people: [] })
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: true } })
})

describe('ThreadView', () => {
    it('frames the accepted answer and names who accepted it', async () => {
        api.getThread.mockResolvedValue(thread({ status: 'answered', answerMessageId: 'm_2', resolvedBy: 'u_ana' }))
        renderThread()
        const answer = await screen.findByRole('article', { name: 'Accepted answer from Bo Chen' })
        expect(within(answer).getByText('Accepted by Ana Silva')).toBeInTheDocument()
        expect(answer.className).toMatch(/emerald/)
        expect(screen.getByRole('article', { name: 'Reply from Ana Silva' }).className).not.toMatch(/emerald/)
        expect(screen.getAllByText('Answered').length).toBeGreaterThan(0)
    })

    it('says "Accepted answer" when the server does not say who accepted it', async () => {
        api.getThread.mockResolvedValue(thread({ status: 'answered', answerMessageId: 'm_1' }))
        renderThread()
        const answer = await screen.findByRole('article', { name: 'Accepted answer from Ana Silva' })
        expect(within(answer).getByText('Accepted answer')).toBeInTheDocument()
    })

    it('marks the first reply from someone else since the reader last looked, and marks the thread read', async () => {
        api.getThread.mockResolvedValue(thread({ lastReadAt: thread().messages[1].createdAt, unread: true }))
        renderThread()
        const line = await screen.findByRole('separator', { name: 'New since you last looked' })
        // The line sits right before Bo's reply, the first one after the reader's last look.
        expect(line.nextElementSibling).toHaveAccessibleName('Reply from Bo Chen')
        await waitFor(() => expect(api.markThreadRead).toHaveBeenCalledWith('th_1'))
    })

    it('draws no line when nothing new is from anyone else', async () => {
        const t = thread()
        api.getThread.mockResolvedValue(thread({
            messages: [...t.messages, message('m_3', 'u_me', 'Thanks!', 30)], lastReadAt: t.messages[2].createdAt,
        }))
        renderThread()
        await screen.findByText('Thanks!')
        expect(screen.queryByRole('separator', { name: 'New since you last looked' })).not.toBeInTheDocument()
    })

    it('shows a reply at once, keeps it with Retry when it fails, and resends it with the same key', async () => {
        const t = thread()
        api.getThread.mockResolvedValue(t)
        let fail!: (e: Error) => void
        api.postReply.mockReturnValueOnce(new Promise((_, reject) => { fail = reject }))
        renderThread()
        const box = await screen.findByRole('combobox', { name: 'Add to your question…' })
        fireEvent.change(box, { target: { value: 'One more thing' } })
        fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
        expect(await screen.findByText('Sending…')).toBeInTheDocument()
        expect(box).toHaveValue('')
        await act(async () => fail(new Error('The connection dropped.')))
        expect(await screen.findByText('The connection dropped.')).toBeInTheDocument()
        const key = api.postReply.mock.calls[0][1].clientKey
        expect(key).toEqual(expect.any(String))

        const reply = message('m_4', 'u_me', 'One more thing', 40, { roles: ['asker'] })
        api.postReply.mockResolvedValueOnce({ message: reply, thread: { ...t, messageCount: 4 }, people: PEOPLE })
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
        await waitFor(() => expect(api.postReply).toHaveBeenCalledTimes(2))
        expect(api.postReply.mock.calls[1]).toEqual(['th_1', { body: 'One more thing', mentions: [], clientKey: key }])
        // Folded into the thread from the server's answer, no refetch needed.
        expect(await screen.findByRole('article', { name: 'Reply from Me Myself' })).toHaveTextContent('One more thing')
        expect(screen.queryByText('The connection dropped.')).not.toBeInTheDocument()
    })

    it('speaks a reply someone else posts while the thread is open', async () => {
        const t = thread()
        api.getThread.mockResolvedValueOnce(t)
        const qc = renderThread()
        await screen.findByText('Computed nightly from trailing revenue.')
        expect(screen.getByRole('status')).toHaveTextContent('')
        // The next poll asks for what changed since the newest message, and gets Ana's reply.
        api.getThread.mockResolvedValueOnce({ ...t, messages: [message('m_9', 'u_ana', 'Also see the wiki.', 50)] })
        await act(() => qc.invalidateQueries({ queryKey: ['discussions', 'thread', 'th_1'] }))
        expect(api.getThread).toHaveBeenLastCalledWith('th_1', { since: t.messages[2].createdAt })
        expect(await screen.findByText('Also see the wiki.')).toBeInTheDocument()
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('New reply from Ana Silva'))
        // Merged: the earlier replies are still there.
        expect(screen.getByText('From dim_customer.')).toBeInTheDocument()
    })

    it('says when someone else changed it first, and reloads it', async () => {
        api.getThread.mockResolvedValue(thread())
        api.closeThread.mockRejectedValue(staleError())
        renderThread()
        fireEvent.click(await screen.findByRole('button', { name: 'Conversation actions' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Close question' }))
        await waitFor(() => expect(api.closeThread).toHaveBeenCalledWith('th_1', 3))
        const alert = await screen.findByRole('alert')
        expect(alert).toHaveTextContent(/This changed/)
        api.getThread.mockResolvedValue(thread({ status: 'closed', version: 4 }))
        fireEvent.click(within(alert).getByRole('button', { name: 'Reload' }))
        await waitFor(() => expect(screen.queryByText(/This changed/)).not.toBeInTheDocument())
        expect(api.getThread).toHaveBeenLastCalledWith('th_1')
        expect(await screen.findByText('This question is closed.')).toBeInTheDocument()
    })
})

describe('asking someone in a thread', () => {
    const withMentions = () => thread({
        messages: [
            message('m_q', 'u_me', 'Where does the tier column come from?', 0, { kind: 'question', roles: ['asker'] }),
            message('m_1', 'u_ana', '@Fay Liu or @Gone Person would know.', 10, { mentions: ['u_fay', 'u_gone'] }),
        ],
        people: { ...PEOPLE, u_gone: { id: 'u_gone', displayName: 'Gone Person', email: null, avatarId: null, hasImage: false, deleted: true } },
    })
    const card = async (name: string) => screen.findByRole('dialog', { name })

    beforeEach(() => useDiscussionsDrawer.setState({ target: null }))

    it('asks a message’s author about the thread’s subject, from their card', async () => {
        api.getThread.mockResolvedValue(withMentions())
        renderThread()
        const reply = await screen.findByRole('article', { name: 'Reply from Ana Silva' })
        fireEvent.mouseEnter(within(reply).getByText('AS'))
        fireEvent.click(within(await card('Ana Silva')).getByRole('button', { name: 'Ask a question' }))
        expect(useDiscussionsDrawer.getState().target).toMatchObject({
            subject: { type: 'view', id: 'v1', name: 'Revenue' }, compose: true, recipients: ['u_ana'], threadId: null,
        })
    })

    it('asks someone a message mentions, from the chip’s card', async () => {
        api.getThread.mockResolvedValue(withMentions())
        renderThread()
        fireEvent.mouseEnter(await screen.findByRole('link', { name: '@Fay Liu' }))
        fireEvent.click(within(await card('Fay Liu')).getByRole('button', { name: 'Ask a question' }))
        expect(useDiscussionsDrawer.getState().target).toMatchObject({ compose: true, recipients: ['u_fay'] })
    })

    it('never offers to ask yourself or someone whose account is gone', async () => {
        api.getThread.mockResolvedValue(withMentions())
        renderThread()
        const question = await screen.findByRole('article', { name: 'Question from Me Myself' })
        fireEvent.mouseEnter(within(question).getByText('MM'))
        expect(within(await card('Me Myself')).queryByRole('button', { name: 'Ask a question' })).not.toBeInTheDocument()
        fireEvent.mouseEnter(screen.getByRole('link', { name: '@Gone Person' }))
        const gone = await card('Former member')
        expect(within(gone).queryByRole('button', { name: 'Ask a question' })).not.toBeInTheDocument()
        expect(within(gone).getByRole('link', { name: /View profile/ })).toBeInTheDocument()
    })
})
