/**
 * The bell is the surface that ends the silence: until it existed, a
 * view could be shared with you, or your publication request answered,
 * and the only record was a timeline nobody opens. These tests pin the
 * behaviour that makes it worth having — the badge tells the truth,
 * opening an item takes you to the thing that happened and stops
 * nagging, and re-reading costs nothing.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'

const navigate = vi.fn()
vi.mock('react-router-dom', async () => {
    const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
    return { ...actual, useNavigate: () => navigate }
})
vi.mock('@/services/inboxService', () => ({
    listInbox: vi.fn(),
    markInboxRead: vi.fn(),
}))

import {
    listInbox,
    markInboxRead,
    type InboxItem,
} from '@/services/inboxService'
import { InboxBell } from '../InboxBell'

const mockList = vi.mocked(listInbox)
const mockMarkRead = vi.mocked(markInboxRead)

function message(overrides: Partial<InboxItem> = {}): InboxItem {
    return {
        id: 'ntf_1',
        kind: 'view.shared',
        title: '"Quarterly lineage" was shared with you',
        body: 'You can open it as a viewer.',
        link: '/views/view_abc',
        actorId: 'usr_alice',
        actorName: 'Alice Doe',
        resourceType: 'view',
        resourceId: 'view_abc',
        readAt: null,
        createdAt: new Date().toISOString(),
        ...overrides,
    }
}

function renderBell() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <InboxBell />
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    mockList.mockResolvedValue({ items: [message()], unread: 1 })
    mockMarkRead.mockResolvedValue({ items: [], unread: 0 })
})

describe('the badge', () => {
    it('counts unread messages', async () => {
        mockList.mockResolvedValue({
            items: [message(), message({ id: 'ntf_2' })],
            unread: 2,
        })
        renderBell()
        expect(await screen.findByLabelText('Inbox, 2 unread')).toBeTruthy()
    })

    it('is absent when nothing is unread', async () => {
        mockList.mockResolvedValue({
            items: [message({ readAt: new Date().toISOString() })],
            unread: 0,
        })
        renderBell()
        expect(await screen.findByLabelText('Inbox')).toBeTruthy()
    })
})

describe('opening an item', () => {
    it('marks it read and navigates to what happened', async () => {
        renderBell()
        fireEvent.click(await screen.findByLabelText('Inbox, 1 unread'))
        fireEvent.click(await screen.findByText(/was shared with you/))
        await waitFor(() => expect(mockMarkRead).toHaveBeenCalledWith(['ntf_1']))
        expect(navigate).toHaveBeenCalledWith('/views/view_abc')
    })

    it('does not re-mark an already-read item', async () => {
        mockList.mockResolvedValue({
            items: [message({ readAt: new Date().toISOString() })],
            unread: 0,
        })
        renderBell()
        fireEvent.click(await screen.findByLabelText('Inbox'))
        fireEvent.click(await screen.findByText(/was shared with you/))
        await waitFor(() => expect(navigate).toHaveBeenCalled())
        expect(mockMarkRead).not.toHaveBeenCalled()
    })
})

describe('mark all read', () => {
    it('clears the badge in one request', async () => {
        renderBell()
        fireEvent.click(await screen.findByLabelText('Inbox, 1 unread'))
        fireEvent.click(await screen.findByText('Mark all read'))
        // The backend's "omit ids" case means every message.
        await waitFor(() => expect(mockMarkRead).toHaveBeenCalledWith(undefined))
    })
})

describe('empty state', () => {
    it('says so calmly instead of rendering a blank panel', async () => {
        mockList.mockResolvedValue({ items: [], unread: 0 })
        renderBell()
        fireEvent.click(await screen.findByLabelText('Inbox'))
        expect(await screen.findByText(/all caught up/i)).toBeTruthy()
    })
})

describe('what became of a draft', () => {
    // Each with a glyph of its own, not the plain bell an unknown kind falls back to.
    it.each([
        ['draft.sent_for_review', 'lucide-git-pull-request-arrow'],
        ['draft.published', 'lucide-git-merge'],
        ['draft.discarded', 'lucide-trash-2'],
        ['draft.made_private', 'lucide-lock'],
        ['draft.transferred', 'lucide-arrow-right-left'],
    ])('shows %s with its own icon', async (kind, icon) => {
        mockList.mockResolvedValue({
            items: [message({ kind, title: '"Q3 pricing"', resourceType: 'branch', resourceId: 'br_1' })],
            unread: 1,
        })
        renderBell()
        fireEvent.click(await screen.findByLabelText('Inbox, 1 unread'))
        const row = (await screen.findByText('"Q3 pricing"')).closest('[role="button"]')!
        expect(row.querySelector(`.${icon}`)).not.toBeNull()
        expect(row.querySelector('.lucide-bell')).toBeNull()
    })
})

describe('what happened to a review you are part of', () => {
    it.each([
        ['review.requested', 'lucide-git-pull-request-arrow', 'bg-sky-500/10'],
        ['review.approved', 'lucide-circle-check', 'bg-emerald-500/10'],
        ['review.changes_requested', 'lucide-rotate-ccw', 'bg-amber-500/10'],
        ['review.commented', 'lucide-message-square', 'bg-sky-500/10'],
        ['review.merged', 'lucide-git-merge', 'bg-emerald-500/10'],
        ['review.closed', 'lucide-circle-x', 'bg-slate-500/10'],
    ])('shows %s with its own icon and tone', async (kind, icon, tile) => {
        mockList.mockResolvedValue({
            items: [message({ kind, title: '"Tidy owners"', link: '/workspaces/ws1/reviews/pr_1', resourceType: 'review', resourceId: 'pr_1' })],
            unread: 1,
        })
        renderBell()
        fireEvent.click(await screen.findByLabelText('Inbox, 1 unread'))
        const row = (await screen.findByText('"Tidy owners"')).closest('[role="button"]')!
        expect(row.querySelector(`.${icon}`)).not.toBeNull()
        expect(row.querySelector('.lucide-bell')).toBeNull()
        expect(row.firstElementChild?.className).toContain(tile)
    })

    it('opens the review’s page', async () => {
        mockList.mockResolvedValue({
            items: [message({ kind: 'review.requested', title: 'You were asked to review "Tidy owners"', link: '/workspaces/ws1/reviews/pr_1' })],
            unread: 1,
        })
        renderBell()
        fireEvent.click(await screen.findByLabelText('Inbox, 1 unread'))
        fireEvent.click(await screen.findByText(/asked to review/))
        expect(navigate).toHaveBeenCalledWith('/workspaces/ws1/reviews/pr_1')
    })
})

describe('review discussions, partial publishes and publishing to everyone', () => {
    it.each([
        ['review.mention', 'lucide-at-sign', 'review'],
        ['review.reply', 'lucide-reply', 'review'],
        ['review.comment', 'lucide-message-square', 'review'],
        ['draft.returned', 'lucide-git-merge', 'branch'],
        ['view.published', 'lucide-globe', 'view'],
    ])('shows %s with its own icon', async (kind, icon, resourceType) => {
        mockList.mockResolvedValue({ items: [message({ kind, title: 'Something happened', resourceType })], unread: 1 })
        renderBell()
        fireEvent.click(await screen.findByLabelText('Inbox, 1 unread'))
        const row = (await screen.findByText('Something happened')).closest('[role="button"]')!
        expect(row.querySelector(`.${icon}`)).not.toBeNull()
        expect(row.querySelector('.lucide-bell')).toBeNull()
    })
})

describe('questions and conversations', () => {
    afterEach(() => useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } }))

    it.each([
        ['discussion.asked', 'lucide-message-circle-question'],
        ['discussion.mentioned', 'lucide-at-sign'],
        ['discussion.replied', 'lucide-message-square'],
        ['discussion.answered', 'lucide-circle-check'],
        ['discussion.closed', 'lucide-circle-x'],
        ['discussion.reminder', 'lucide-clock'],
        ['discussion.escalated', 'lucide-shield-alert'],
        ['discussion.watched', 'lucide-eye'],
    ])('shows %s as the person who did it, with its own badge', async (kind, icon) => {
        mockList.mockResolvedValue({
            items: [message({
                kind, title: 'Ana Silva replied', resourceType: 'discussion', resourceId: 'dis_1',
                link: '/views/v1?discussion=dis_1&message=dmsg_2', actorName: 'Ana Silva',
            })],
            unread: 1,
        })
        renderBell()
        fireEvent.click(await screen.findByLabelText('Inbox, 1 unread'))
        const row = (await screen.findByText('Ana Silva replied')).closest('[role="button"]')!
        const face = row.querySelector('[data-testid="inbox-actor-avatar"]')
        expect(face).not.toBeNull()
        expect(face!.textContent).toContain('AS')
        expect(face!.querySelector(`.${icon}`)).not.toBeNull()
        expect(row.querySelector('.lucide-bell')).toBeNull()
        // A click opens the exact thread and message.
        fireEvent.click(row)
        expect(navigate).toHaveBeenCalledWith('/views/v1?discussion=dis_1&message=dmsg_2')
    })

    it('names a new data contact with its own icon, not a face', async () => {
        mockList.mockResolvedValue({
            items: [message({ kind: 'data_source.contact_added', title: 'You’re a data steward', resourceType: 'data_source' })],
            unread: 1,
        })
        renderBell()
        fireEvent.click(await screen.findByLabelText('Inbox, 1 unread'))
        const row = (await screen.findByText('You’re a data steward')).closest('[role="button"]')!
        expect(row.querySelector('.lucide-user-check')).not.toBeNull()
        expect(row.querySelector('[data-testid="inbox-actor-avatar"]')).toBeNull()
    })

    it('leads to all conversations while the switch is on', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: true } })
        renderBell()
        fireEvent.click(await screen.findByLabelText('Inbox, 1 unread'))
        fireEvent.click(await screen.findByRole('button', { name: 'All conversations' }))
        expect(navigate).toHaveBeenCalledWith('/conversations')
    })

    it('has no conversations link while the switch is off', async () => {
        renderBell()
        fireEvent.click(await screen.findByLabelText('Inbox, 1 unread'))
        await screen.findByText(/was shared with you/)
        expect(screen.queryByRole('button', { name: 'All conversations' })).not.toBeInTheDocument()
    })
})
