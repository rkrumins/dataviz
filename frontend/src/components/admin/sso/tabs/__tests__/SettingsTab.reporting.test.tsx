/**
 * What this page says back.
 *
 * Two of its four switches change what a colleague sees on the sign-in
 * page without any confirm at all, and they used to change it in
 * silence: the toggle slid, and nothing else happened. The switch
 * position is the state; it is not an answer to "did that land, and what
 * does it mean". So every flip now says what the sign-in page does now,
 * in the app's one notification stack.
 *
 * The banner underneath is left holding exactly one thing — a posture
 * that could not be read — because that is the only message here still
 * true while it is being read.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SettingsTab } from '../SettingsTab'
import {
    NotificationStack, useNotificationStore,
} from '@/components/ui/notifications'
import { ssoAdminService, type AuthConfig } from '@/services/ssoAdminService'

vi.mock('@/services/ssoAdminService', () => ({
    ssoAdminService: {
        getAuthConfig: vi.fn(),
        listProviders: vi.fn(),
        updateAuthConfig: vi.fn(),
        endSsoSessions: vi.fn(),
        endAllSessions: vi.fn(),
    },
}))
// Both make their own service calls and have their own tests.
vi.mock('../settings/BackchannelHostsPanel', () => ({
    BackchannelHostsPanel: () => null,
}))
vi.mock('../settings/AvatarHostsPanel', () => ({
    AvatarHostsPanel: () => null,
}))

const svc = ssoAdminService as unknown as Record<string, ReturnType<typeof vi.fn>>
const raised = () => useNotificationStore.getState().notifications
const page = () => render(<><SettingsTab /><NotificationStack /></>)

function cfg(over: Partial<AuthConfig> = {}): AuthConfig {
    return {
        ssoEnabled: true, allowLocalLogin: true,
        allowJitProvisioning: true, emailFirstLogin: false,
        version: 3, updatedAt: new Date().toISOString(),
        ...over,
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    useNotificationStore.setState({ notifications: [], history: [], _nextId: 1 })
    svc.getAuthConfig.mockResolvedValue(cfg())
    svc.listProviders.mockResolvedValue([])
    svc.updateAuthConfig.mockResolvedValue(cfg({ emailFirstLogin: true, version: 4 }))
})

describe('a plain flip — the one with no confirm in front of it', () => {
    it('says what the sign-in page does now, not that something saved', async () => {
        const user = userEvent.setup()
        page()

        await user.click(
            await screen.findByRole('switch', { name: 'Ask for an email first' }),
        )

        await waitFor(() => expect(raised()).toHaveLength(1))
        expect(raised()[0].type).toBe('success')
        expect(raised()[0].message)
            .toBe('The sign-in page asks for an email address first.')
    })

    it('names the switch and the direction when the write is refused', async () => {
        // An error with no message at all — the case that used to render
        // an empty red banner.
        svc.updateAuthConfig.mockRejectedValueOnce(new Error(''))
        const user = userEvent.setup()
        page()

        await user.click(
            await screen.findByRole('switch', { name: 'Ask for an email first' }),
        )

        await waitFor(() => expect(raised()).toHaveLength(1))
        expect(raised()[0].type).toBe('error')
        expect(raised()[0].message)
            .toBe('Could not turn Ask for an email first on.')
    })

    it('hands on the server’s own words when it gave any', async () => {
        svc.updateAuthConfig.mockRejectedValueOnce(
            new Error('Someone else changed this first.'),
        )
        const user = userEvent.setup()
        page()

        await user.click(
            await screen.findByRole('switch', { name: 'Ask for an email first' }),
        )

        expect(await screen.findByText(/someone else changed this first/i))
            .toBeInTheDocument()
    })
})

describe('the banner underneath', () => {
    it('holds the unreadable posture, and does not also pop it up', async () => {
        svc.getAuthConfig.mockRejectedValue(new Error('the auth service is down'))
        page()

        expect(await screen.findByText(/the auth service is down/i))
            .toBeInTheDocument()
        expect(raised()).toHaveLength(0)
    })

    it('never renders an empty box when the failure carried no words', async () => {
        svc.getAuthConfig.mockRejectedValue(new Error(''))
        page()

        expect(await screen.findByText(
            /current sign-in posture could not be read/i,
        )).toBeInTheDocument()
    })
})
