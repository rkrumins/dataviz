/**
 * Announcements loses its private pop-up.
 *
 * The other half of the report: "when I make changes to Announcements it isn't
 * quite the same consistent one." It wasn't — the page carried its own toast in
 * the same bottom-right corner as the app's notification stack, with its own
 * timings (3000/4000 ms against 4500), its own AnimatePresence with an `exit`
 * that keeps the slot in the flow, and z-[200] against the stack's z-[80], so a
 * page pop-up could paint straight over a real notification. Exactly the pop-up
 * that AdminFeatures lost in 2c461134.
 *
 * Its error paths also passed `err.message` through unguarded: an Error with an
 * empty message painted an empty coloured box.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/announcementService', () => ({
    announcementService: {
        listAll: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
        getAdminConfig: vi.fn(),
        updateConfig: vi.fn(),
    },
}))
vi.mock('@/store/announcements', () => ({
    useAnnouncementStore: { getState: () => ({ fetchActive: vi.fn(), fetchConfig: vi.fn() }) },
}))
vi.mock('@/store/auth', () => ({ useAuthStore: (sel: (s: unknown) => unknown) => sel({ isAuthenticated: true }) }))

import { AdminAnnouncements } from '../index'
import { announcementService, type AnnouncementResponse } from '@/services/announcementService'
import { useNotificationStore } from '@/components/ui/notifications'

function ann(over: Partial<AnnouncementResponse> = {}): AnnouncementResponse {
    return {
        id: 'ann_1',
        title: 'Planned maintenance',
        message: 'We are upgrading the graph store on Saturday.',
        bannerType: 'info',
        isActive: true,
        snoozeDurationMinutes: 0,
        ctaText: null,
        ctaUrl: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...over,
    }
}

const raised = () => useNotificationStore.getState().notifications
const messages = () => raised().map(n => n.message)

function renderPage() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={client}><AdminAnnouncements /></QueryClientProvider>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    useNotificationStore.setState({ notifications: [], history: [], _nextId: 1 })
    vi.mocked(announcementService.listAll).mockResolvedValue([ann()])
    vi.mocked(announcementService.getAdminConfig).mockResolvedValue({
        pollIntervalSeconds: 15, defaultSnoozeMinutes: 30,
    })
    vi.mocked(announcementService.update).mockResolvedValue(ann())
    vi.mocked(announcementService.create).mockResolvedValue(ann())
    vi.mocked(announcementService.remove).mockResolvedValue(undefined)
    vi.mocked(announcementService.updateConfig).mockResolvedValue({
        pollIntervalSeconds: 20, defaultSnoozeMinutes: 30,
    })
})

describe('AdminAnnouncements — the private pop-up is gone', () => {
    it('renders nothing of its own in the corner the notification stack owns', async () => {
        const user = userEvent.setup()
        const { container } = renderPage()
        await user.click(await screen.findByLabelText('Deactivate'))
        await waitFor(() => expect(messages()).toHaveLength(1))

        // z-[200] over the stack's z-[80] was the whole defect.
        expect(container.querySelector('.z-\\[200\\]')).toBeNull()
        expect(container.querySelector('.fixed.bottom-6.right-6')).toBeNull()
    })
})

describe('AdminAnnouncements — publishing and pausing', () => {
    it('pausing names the banner and says who stops seeing it', async () => {
        const user = userEvent.setup()
        renderPage()
        await user.click(await screen.findByLabelText('Deactivate'))

        await waitFor(() => expect(messages()).toEqual([
            '“Planned maintenance” is paused — nobody sees the banner now.',
        ]))
        expect(raised()[0].type).toBe('success')
    })

    it('publishing says everyone sees it now', async () => {
        vi.mocked(announcementService.listAll).mockResolvedValue([ann({ isActive: false })])
        const user = userEvent.setup()
        renderPage()
        await user.click(await screen.findByLabelText('Activate'))

        await waitFor(() => expect(messages()).toEqual([
            '“Planned maintenance” is live — everyone sees the banner now.',
        ]))
    })

    it('a failure that carries no words still names the action', async () => {
        vi.mocked(announcementService.update).mockRejectedValue(new Error(''))
        const user = userEvent.setup()
        renderPage()
        await user.click(await screen.findByLabelText('Deactivate'))

        await waitFor(() => expect(messages()).toEqual([
            'Could not pause “Planned maintenance”.',
        ]))
        expect(raised()[0].type).toBe('error')
    })
})

describe('AdminAnnouncements — deleting', () => {
    it('names what it deleted', async () => {
        const user = userEvent.setup()
        renderPage()
        await user.click(await screen.findByLabelText('Delete'))
        const dialog = await screen.findByRole('dialog')
        await user.click(within(dialog).getByRole('button', { name: /^Delete$/ }))

        await waitFor(() => expect(messages()).toEqual([
            '“Planned maintenance” deleted — the banner is gone for everyone.',
        ]))
    })

    it('a failed delete names the announcement rather than showing an empty box', async () => {
        vi.mocked(announcementService.remove).mockRejectedValue(new Error(''))
        const user = userEvent.setup()
        renderPage()
        await user.click(await screen.findByLabelText('Delete'))
        const dialog = await screen.findByRole('dialog')
        await user.click(within(dialog).getByRole('button', { name: /^Delete$/ }))

        await waitFor(() => expect(messages()).toEqual([
            'Could not delete “Planned maintenance”.',
        ]))
    })
})

describe('AdminAnnouncements — banner settings', () => {
    it('confirms the settings save through the one stack', async () => {
        const user = userEvent.setup()
        renderPage()
        await user.click(await screen.findByLabelText('Banner Settings'))
        await user.click(await screen.findByRole('button', { name: /Save Settings/i }))

        await waitFor(() => expect(messages()).toEqual([
            'Banner settings saved — every browser picks them up on its next check.',
        ]))
    })
})
