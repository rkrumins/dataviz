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
import { beforeEach, describe, expect, it, vi } from 'vitest'

const navigate = vi.fn()
vi.mock('react-router-dom', async () => {
    const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
    return { ...actual, useNavigate: () => navigate }
})
vi.mock('@/services/notificationsService', () => ({
    listNotifications: vi.fn(),
    markNotificationsRead: vi.fn(),
}))

import {
    listNotifications,
    markNotificationsRead,
    type Notification,
} from '@/services/notificationsService'
import { NotificationBell } from '../NotificationBell'

const mockList = vi.mocked(listNotifications)
const mockMarkRead = vi.mocked(markNotificationsRead)

function notification(overrides: Partial<Notification> = {}): Notification {
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
            <NotificationBell />
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    mockList.mockResolvedValue({ items: [notification()], unread: 1 })
    mockMarkRead.mockResolvedValue({ items: [], unread: 0 })
})

describe('the badge', () => {
    it('counts unread notifications', async () => {
        mockList.mockResolvedValue({
            items: [notification(), notification({ id: 'ntf_2' })],
            unread: 2,
        })
        renderBell()
        expect(await screen.findByLabelText('Notifications, 2 unread')).toBeTruthy()
    })

    it('is absent when nothing is unread', async () => {
        mockList.mockResolvedValue({
            items: [notification({ readAt: new Date().toISOString() })],
            unread: 0,
        })
        renderBell()
        expect(await screen.findByLabelText('Notifications')).toBeTruthy()
    })
})

describe('opening an item', () => {
    it('marks it read and navigates to what happened', async () => {
        renderBell()
        fireEvent.click(await screen.findByLabelText('Notifications, 1 unread'))
        fireEvent.click(await screen.findByText(/was shared with you/))
        await waitFor(() => expect(mockMarkRead).toHaveBeenCalledWith(['ntf_1']))
        expect(navigate).toHaveBeenCalledWith('/views/view_abc')
    })

    it('does not re-mark an already-read item', async () => {
        mockList.mockResolvedValue({
            items: [notification({ readAt: new Date().toISOString() })],
            unread: 0,
        })
        renderBell()
        fireEvent.click(await screen.findByLabelText('Notifications'))
        fireEvent.click(await screen.findByText(/was shared with you/))
        await waitFor(() => expect(navigate).toHaveBeenCalled())
        expect(mockMarkRead).not.toHaveBeenCalled()
    })
})

describe('mark all read', () => {
    it('clears the badge in one request', async () => {
        renderBell()
        fireEvent.click(await screen.findByLabelText('Notifications, 1 unread'))
        fireEvent.click(await screen.findByText('Mark all read'))
        // The backend's "omit ids" case means every notification.
        await waitFor(() => expect(mockMarkRead).toHaveBeenCalledWith(undefined))
    })
})

describe('empty state', () => {
    it('says so calmly instead of rendering a blank panel', async () => {
        mockList.mockResolvedValue({ items: [], unread: 0 })
        renderBell()
        fireEvent.click(await screen.findByLabelText('Notifications'))
        expect(await screen.findByText(/all caught up/i)).toBeTruthy()
    })
})
