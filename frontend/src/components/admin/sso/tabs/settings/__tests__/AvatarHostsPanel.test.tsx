/**
 * The avatar-hosts panel exists as much for its copy as its form.
 *
 * The list is the on-switch for external avatar sources, and the person
 * configuring it needs three facts stated where they type: only raster
 * image URLs get through (with a plain-words line on what raster
 * means), an empty list means external avatars are OFF, and a private
 * host belongs on the internal-gateways list instead. These tests pin
 * that guidance alongside the mechanics — purpose-scoped reads and
 * writes, one-click removal, and the separately-granted permission
 * being named rather than rendered as an empty list.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AvatarHostsPanel } from '../AvatarHostsPanel'
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
    id: 'bch_9', purpose: 'avatar', host: 'avatars.example.com', port: 443,
    note: 'public CDN', createdAt: '2026-08-26T00:00:00Z', createdBy: 'ada',
}

/** Changing where this deployment may fetch images from is an act, not a
 *  state — it reports through the app's one notification stack. */
const raised = () => useNotificationStore.getState().notifications
const panel = () => render(<><AvatarHostsPanel /><NotificationStack /></>)

beforeEach(() => {
    vi.clearAllMocks()
    useNotificationStore.setState({ notifications: [], history: [], _nextId: 1 })
    svc.listBackchannelHosts.mockResolvedValue([])
    svc.addBackchannelHost.mockResolvedValue(ENTRY)
    svc.deleteBackchannelHost.mockResolvedValue(undefined)
})

describe('the guidance', () => {
    it('explains what a raster image URL is, in words', async () => {
        panel()
        expect(
            await screen.findByText(/raster image urls only/i),
        ).toBeInTheDocument()
        expect(screen.getByText(/grid of pixels/i)).toBeInTheDocument()
        expect(screen.getByText(/svg files/i)).toBeInTheDocument()
    })

    it('says an empty list means external avatars are off', async () => {
        panel()
        expect(
            await screen.findByText(/external avatars are off/i),
        ).toBeInTheDocument()
    })

    it('points private hosts at the other list', async () => {
        panel()
        expect(
            await screen.findByText(/internal-gateways list/i),
        ).toBeInTheDocument()
    })
})

describe('the mechanics', () => {
    it('reads and writes the avatar-purpose list, not the gateway one', async () => {
        const user = userEvent.setup()
        panel()
        await waitFor(() => {
            expect(svc.listBackchannelHosts).toHaveBeenCalledWith('avatar')
        })

        await user.type(
            screen.getByLabelText(/avatar image host/i),
            'avatars.example.com',
        )
        await user.click(screen.getByRole('button', { name: /allow/i }))
        await waitFor(() => {
            expect(svc.addBackchannelHost).toHaveBeenCalledWith(
                { host: 'avatars.example.com', port: 443, note: undefined },
                'avatar',
            )
        })
    })

    it('shows an entry with its port and removes it in one click', async () => {
        svc.listBackchannelHosts.mockResolvedValue([ENTRY])
        const user = userEvent.setup()
        panel()
        expect(
            await screen.findByText('avatars.example.com:443'),
        ).toBeInTheDocument()

        await user.click(screen.getByRole('button', {
            name: /remove avatars\.example\.com:443/i,
        }))
        await waitFor(() => {
            expect(svc.deleteBackchannelHost).toHaveBeenCalledWith('bch_9')
        })
        // A shorter list is not a confirmation that the source was closed.
        await waitFor(() => expect(raised()).toHaveLength(1))
        expect(raised()[0].message).toBe(
            'avatars.example.com:443 is withdrawn — no avatar is fetched '
            + 'from it now.',
        )
    })

    it('confirms a newly allowed source, naming it', async () => {
        const user = userEvent.setup()
        panel()
        await waitFor(() => expect(svc.listBackchannelHosts).toHaveBeenCalled())

        await user.type(
            screen.getByLabelText(/avatar image host/i), 'avatars.example.com',
        )
        await user.click(screen.getByRole('button', { name: /allow/i }))

        await waitFor(() => expect(raised()).toHaveLength(1))
        expect(raised()[0].type).toBe('success')
        expect(raised()[0].message).toBe(
            'avatars.example.com:443 is allowed — avatars can be fetched '
            + 'from it now.',
        )
    })

    it('names the host when the write is refused with no message', async () => {
        svc.addBackchannelHost.mockRejectedValueOnce(new Error(''))
        const user = userEvent.setup()
        panel()
        await waitFor(() => expect(svc.listBackchannelHosts).toHaveBeenCalled())

        await user.type(
            screen.getByLabelText(/avatar image host/i), 'avatars.example.com',
        )
        await user.click(screen.getByRole('button', { name: /allow/i }))

        await waitFor(() => expect(raised()).toHaveLength(1))
        expect(raised()[0].type).toBe('error')
        expect(raised()[0].message)
            .toBe('Could not allow avatars.example.com:443.')
    })

    it('names the missing permission instead of rendering an empty list', async () => {
        svc.listBackchannelHosts.mockRejectedValue(new Error('403 Forbidden'))
        panel()
        expect(
            await screen.findByText(/don.t have permission/i),
        ).toBeInTheDocument()
    })
})
