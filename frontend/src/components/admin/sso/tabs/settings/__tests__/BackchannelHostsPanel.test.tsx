/**
 * The allowlist panel is read by two people: the one adding a gateway,
 * and the one asking six months later why this deployment is allowed to
 * call an address inside the network.
 *
 * The second reader is the one these tests are mostly about. The whole
 * argument for editing this list from a browser rests on each entry
 * being attributable and individually revocable — so the port has to be
 * visible (an entry is a service, not a machine), the person who added
 * it has to be visible, and removing one has to be one click rather
 * than a support request.
 *
 * The other case worth pinning is the 403. This list has its own
 * permission, so an admin who can change everything else on the page may
 * legitimately not hold it, and an empty list would read as "nothing is
 * allowed" — the opposite of the truth.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { BackchannelHostsPanel } from '../BackchannelHostsPanel'
import {
    NotificationStack, useNotificationStore,
} from '@/components/ui/notifications'
import { ssoAdminService } from '@/services/ssoAdminService'

vi.mock('@/services/ssoAdminService', () => ({
    ssoAdminService: {
        listBackchannelHosts: vi.fn(),
        addBackchannelHost: vi.fn(),
        deleteBackchannelHost: vi.fn(),
    },
}))

const svc = ssoAdminService as unknown as {
    listBackchannelHosts: ReturnType<typeof vi.fn>
    addBackchannelHost: ReturnType<typeof vi.fn>
    deleteBackchannelHost: ReturnType<typeof vi.fn>
}

const ENTRY = {
    id: 'bch_1', host: 'sso-gateway.corp.internal', port: 443,
    note: 'primary', createdAt: '2026-08-24T00:00:00Z', createdBy: 'ada',
}

/** Changing where this deployment may send requests is an act, not a
 *  state — it reports through the app's one notification stack. The
 *  banner underneath keeps only what is still true while it is read: a
 *  list that could not be loaded. */
const raised = () => useNotificationStore.getState().notifications
const panel = () => render(<><BackchannelHostsPanel /><NotificationStack /></>)

beforeEach(() => {
    vi.clearAllMocks()
    useNotificationStore.setState({ notifications: [], history: [], _nextId: 1 })
    svc.listBackchannelHosts.mockResolvedValue([])
    svc.addBackchannelHost.mockResolvedValue(ENTRY)
    svc.deleteBackchannelHost.mockResolvedValue(undefined)
})

describe('reading the list', () => {
    it('shows the port, because an entry is a service not a machine', async () => {
        svc.listBackchannelHosts.mockResolvedValue([ENTRY])
        panel()
        expect(
            await screen.findByText('sso-gateway.corp.internal:443'),
        ).toBeInTheDocument()
    })

    it('names who allowed it', async () => {
        svc.listBackchannelHosts.mockResolvedValue([ENTRY])
        panel()
        expect(await screen.findByText(/added by ada/)).toBeInTheDocument()
    })

    it('says an empty list means gateways cannot be reached', async () => {
        // "Nothing listed" alone reads as "nothing to do here".
        panel()
        expect(
            await screen.findByText(/cannot reach anything internal/i),
        ).toBeInTheDocument()
    })

    it('states the floor no entry can lower', async () => {
        panel()
        expect(
            await screen.findByText(/cloud metadata addresses are\s+refused/i),
        ).toBeInTheDocument()
    })
})

describe('changing the list', () => {
    it('allows a host and reloads', async () => {
        panel()
        await screen.findByText(/nothing listed/i)

        await userEvent.type(
            screen.getByLabelText('Gateway host'), 'gw.corp.internal',
        )
        await userEvent.type(screen.getByLabelText('Note'), 'primary')
        await userEvent.click(screen.getByRole('button', { name: /allow/i }))

        await waitFor(() => {
            expect(svc.addBackchannelHost).toHaveBeenCalledWith({
                host: 'gw.corp.internal', port: 443, note: 'primary',
            })
        })
        expect(svc.listBackchannelHosts).toHaveBeenCalledTimes(2)
        // A re-rendered list is not a confirmation that an egress rule
        // was written.
        await waitFor(() => expect(raised()).toHaveLength(1))
        expect(raised()[0].type).toBe('success')
        expect(raised()[0].message)
            .toBe('gw.corp.internal:443 is allowed — sign-in can call it now.')
    })

    it('says what a withdrawal took away', async () => {
        svc.listBackchannelHosts.mockResolvedValue([ENTRY])
        panel()
        await screen.findByText('sso-gateway.corp.internal:443')

        await userEvent.click(
            screen.getByRole('button', { name: /remove sso-gateway/i }),
        )

        await waitFor(() => expect(raised()).toHaveLength(1))
        expect(raised()[0].message).toBe(
            'sso-gateway.corp.internal:443 is withdrawn — sign-in can no '
            + 'longer call it.',
        )
    })

    it('names the host when a withdrawal is refused with no message', async () => {
        svc.listBackchannelHosts.mockResolvedValue([ENTRY])
        svc.deleteBackchannelHost.mockRejectedValueOnce(new Error(''))
        panel()
        await screen.findByText('sso-gateway.corp.internal:443')

        await userEvent.click(
            screen.getByRole('button', { name: /remove sso-gateway/i }),
        )

        await waitFor(() => expect(raised()).toHaveLength(1))
        expect(raised()[0].type).toBe('error')
        expect(raised()[0].message)
            .toBe('Could not withdraw sso-gateway.corp.internal:443.')
    })

    it('will not submit an empty host', async () => {
        panel()
        await screen.findByText(/nothing listed/i)
        expect(screen.getByRole('button', { name: /allow/i })).toBeDisabled()
    })

    it('withdraws an entry in one click', async () => {
        svc.listBackchannelHosts.mockResolvedValue([ENTRY])
        panel()
        await screen.findByText('sso-gateway.corp.internal:443')

        await userEvent.click(
            screen.getByRole('button', { name: /remove sso-gateway/i }),
        )
        await waitFor(() => {
            expect(svc.deleteBackchannelHost).toHaveBeenCalledWith('bch_1')
        })
    })

    it('surfaces a rejected entry rather than swallowing it', async () => {
        svc.addBackchannelHost.mockRejectedValue(
            new Error("'*.corp' is not a plain hostname."),
        )
        panel()
        await screen.findByText(/nothing listed/i)

        await userEvent.type(screen.getByLabelText('Gateway host'), '*.corp')
        await userEvent.click(screen.getByRole('button', { name: /allow/i }))

        expect(
            await screen.findByText(/not a plain hostname/i),
        ).toBeInTheDocument()
    })
})

describe('when the caller lacks the permission', () => {
    it('explains rather than showing an empty list', async () => {
        // An empty list here would say "nothing is allowed", which is
        // the opposite of what a 403 means.
        svc.listBackchannelHosts.mockRejectedValue(new Error('Forbidden'))
        panel()
        expect(
            await screen.findByText(/don.t have permission/i),
        ).toBeInTheDocument()
        expect(screen.queryByText(/nothing listed/i)).not.toBeInTheDocument()
    })

    it('says the permission is separate from platform administration', async () => {
        svc.listBackchannelHosts.mockRejectedValue(new Error('403 Forbidden'))
        panel()
        expect(
            await screen.findByText(/granted separately/i),
        ).toBeInTheDocument()
    })

    it('does not offer an Allow button it cannot use', async () => {
        svc.listBackchannelHosts.mockRejectedValue(new Error('Forbidden'))
        panel()
        await screen.findByText(/don.t have permission/i)
        expect(
            screen.queryByRole('button', { name: /allow/i }),
        ).not.toBeInTheDocument()
    })

    it('still reports a real failure as an error', async () => {
        svc.listBackchannelHosts.mockRejectedValue(new Error('Network down'))
        panel()
        expect(await screen.findByText(/network down/i)).toBeInTheDocument()
    })
})
