/**
 * The way back in when single sign-on is not there.
 *
 * Turning passwords off is now refused without a ready break-glass
 * account, and warns — with names — about Super Admins who could not sign
 * in at all. Both answers arrive as a 409, and both are answered where the
 * switch is: the list with a "Make break-glass" per row and a "Turn off
 * anyway", or what to do first. Beside the switch, three cards say whether
 * an outage is happening, open passwords to everyone for a few hours, and
 * list the accounts that can always get in.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SettingsTab } from '../SettingsTab'
import {
    NotificationStack, useNotificationStore,
} from '@/components/ui/notifications'
import { ssoAdminService, type AuthConfig } from '@/services/ssoAdminService'
import { adminUserService } from '@/services/adminUserService'

vi.mock('@/services/ssoAdminService', () => ({
    ssoAdminService: {
        getAuthConfig: vi.fn(),
        listProviders: vi.fn(),
        updateAuthConfig: vi.fn(),
        endSsoSessions: vi.fn(),
        endAllSessions: vi.fn(),
        openPasswordFallback: vi.fn(),
        closePasswordFallback: vi.fn(),
    },
}))
vi.mock('@/services/adminUserService', () => ({
    adminUserService: { setSystemAccount: vi.fn() },
}))
// Both make their own service calls and have their own tests.
vi.mock('../settings/BackchannelHostsPanel', () => ({
    BackchannelHostsPanel: () => null,
}))
vi.mock('../settings/AvatarHostsPanel', () => ({
    AvatarHostsPanel: () => null,
}))

const svc = ssoAdminService as unknown as Record<string, ReturnType<typeof vi.fn>>
const users = adminUserService as unknown as Record<string, ReturnType<typeof vi.fn>>
const raised = () => useNotificationStore.getState().notifications
const page = () => render(<><SettingsTab /><NotificationStack /></>)

const ops = {
    id: 'u_ops', email: 'ops@corp.example', status: 'active',
    passwordSet: true, superAdmin: true, ready: true,
}

function cfg(over: Partial<AuthConfig> = {}): AuthConfig {
    return {
        ssoEnabled: true, allowLocalLogin: true,
        allowJitProvisioning: true, emailFirstLogin: false,
        version: 3, updatedAt: new Date().toISOString(),
        passwordFallbackUntil: null, passwordFallbackBy: null,
        passwordFallbackReason: null,
        breakGlass: { ready: true, accounts: [ops] },
        ssoStatus: {
            checkedAt: new Date().toISOString(), stale: false, outage: null,
        },
        ...over,
    }
}

/** What the service rejects with on a structured refusal. */
function refused(detail: unknown): Error {
    return Object.assign(new Error('refused'), { status: 409, detail })
}

const ana = { id: 'u_ana', email: 'ana@corp.example' }
const bo = { id: 'u_bo', email: 'bo@corp.example' }

const entra = {
    id: 'idp_1', slug: 'entra', displayName: 'Corporate Entra',
    kind: 'oidc', enabled: true, priority: 100, settings: {},
    claimMapping: {}, linkingPolicy: 'strict',
    assurance: 'verified', assuranceReason: '',
    emailDomains: [], lifecycle: 'live',
    createdAt: '', updatedAt: '',
}

beforeEach(() => {
    vi.clearAllMocks()
    useNotificationStore.setState({ notifications: [], history: [], _nextId: 1 })
    svc.getAuthConfig.mockResolvedValue(cfg())
    svc.listProviders.mockResolvedValue([])
    svc.endAllSessions.mockResolvedValue({
        usersAffected: 3, tokensRevoked: 7, systemAccountsSkipped: 1,
        dryRun: true,
    })
    users.setSystemAccount.mockResolvedValue({})
})

async function askToTurnPasswordsOff() {
    const user = userEvent.setup()
    page()
    await user.click(await screen.findByRole('switch', { name: 'Passwords' }))
    await user.click(await screen.findByRole('button', { name: /turn it off/i }))
    return user
}

describe('Super Admins who could not sign in', () => {
    it('lists them in the confirm, not in a toast, each with their role', async () => {
        svc.updateAuthConfig.mockRejectedValueOnce(refused({
            error: 'would_lock_out_admin',
            adminsWithoutSso: [
                { ...ana, role: 'super_admin' }, { ...bo, role: 'org_admin' },
            ],
            message: 'These administrators have no linked SSO identity.',
        }))
        await askToTurnPasswordsOff()

        expect(await screen.findByText('ana@corp.example')).toBeInTheDocument()
        expect(screen.getByText('bo@corp.example')).toBeInTheDocument()
        expect(screen.getByText(/these 2 administrators have no single sign-on identity/i))
            .toBeInTheDocument()
        // Org admins lose their password too, so they are named beside the
        // Super Admins rather than discovered after the switch.
        expect(screen.getByText('ana@corp.example').closest('li')).toHaveTextContent('Super Admin')
        expect(screen.getByText('bo@corp.example').closest('li')).toHaveTextContent('Org admin')
        expect(screen.getByRole('button', { name: 'Turn off anyway' }))
            .toBeInTheDocument()
        expect(raised()).toHaveLength(0)
    })

    it('makes each break-glass on the spot, then carries on once none are left', async () => {
        svc.updateAuthConfig
            .mockRejectedValueOnce(refused({
                error: 'would_lock_out_admin', adminsWithoutSso: [ana, bo],
            }))
            .mockResolvedValueOnce(cfg({ allowLocalLogin: false, version: 4 }))
        const user = await askToTurnPasswordsOff()

        await user.click(await screen.findByRole('button', {
            name: 'Make ana@corp.example a break-glass account',
        }))
        expect(users.setSystemAccount).toHaveBeenCalledWith('u_ana', true)
        await waitFor(() => {
            expect(screen.queryByText('ana@corp.example')).not.toBeInTheDocument()
        })
        // One still on the list: nothing is retried yet.
        expect(svc.updateAuthConfig).toHaveBeenCalledTimes(1)

        await user.click(screen.getByRole('button', {
            name: 'Make bo@corp.example a break-glass account',
        }))
        await waitFor(() => expect(svc.updateAuthConfig).toHaveBeenCalledTimes(2))
        // Nobody left to acknowledge, so no acknowledgement is sent.
        expect(svc.updateAuthConfig).toHaveBeenLastCalledWith({
            allowLocalLogin: false, expectedVersion: 3,
        })
        expect(await screen.findByText(/passwords are off — break-glass accounts only/i))
            .toBeInTheDocument()
    })

    it('resends with the acknowledgement on "Turn off anyway", sign-out choice intact', async () => {
        svc.updateAuthConfig
            .mockRejectedValueOnce(refused({
                error: 'would_lock_out_admin', adminsWithoutSso: [ana],
            }))
            .mockResolvedValueOnce(cfg({ allowLocalLogin: false, version: 4 }))
        svc.endAllSessions
            .mockResolvedValueOnce({
                usersAffected: 3, tokensRevoked: 7,
                systemAccountsSkipped: 1, dryRun: true,
            })
            .mockResolvedValueOnce({
                usersAffected: 2, tokensRevoked: 5,
                systemAccountsSkipped: 1, dryRun: false,
            })
        const user = await askToTurnPasswordsOff()

        await user.click(await screen.findByRole('checkbox'))
        await user.click(await screen.findByRole('button', { name: 'Turn off anyway' }))

        await waitFor(() => {
            expect(svc.updateAuthConfig).toHaveBeenLastCalledWith({
                allowLocalLogin: false, expectedVersion: 3,
                acknowledgeAdminsWithoutSso: true,
            })
        })
        expect(await screen.findByText(/signed out 2 people/i)).toBeInTheDocument()
        expect(users.setSystemAccount).not.toHaveBeenCalled()
    })
})

describe('no break-glass account ready', () => {
    it('says what to do first, with nothing to press but "Keep it on"', async () => {
        svc.updateAuthConfig.mockRejectedValueOnce(refused({
            error: 'no_break_glass_account',
            message: 'No break-glass account is ready.',
        }))
        const user = await askToTurnPasswordsOff()

        expect(await screen.findByText(
            /no break-glass account is ready, so an idp outage would leave nobody/i,
        )).toBeInTheDocument()
        expect(screen.getByText(/reset_admin_password --email … --break-glass/))
            .toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /turn it off|turn off anyway/i }))
            .not.toBeInTheDocument()
        expect(raised()).toHaveLength(0)

        await user.click(screen.getByRole('button', { name: /keep it on/i }))
        expect(screen.queryByText(/reset_admin_password/)).not.toBeInTheDocument()
    })
})

describe('emergency password access', () => {
    it('opens for the chosen hours with the reason, then shows until when and by whom', async () => {
        svc.getAuthConfig.mockResolvedValue(cfg({ allowLocalLogin: false }))
        svc.listProviders.mockResolvedValue([entra])
        svc.openPasswordFallback.mockResolvedValue(cfg({
            allowLocalLogin: false,
            // Half a minute of slack: the countdown reads the shared
            // clock, which this test does not pin.
            passwordFallbackUntil: new Date(Date.now() + 4 * 3600_000 + 30_000).toISOString(),
            passwordFallbackBy: 'admin@corp.example',
            passwordFallbackReason: 'Entra outage',
        }))
        svc.closePasswordFallback.mockResolvedValue(cfg({ allowLocalLogin: false }))
        const user = userEvent.setup()
        page()

        await user.click(await screen.findByRole('radio', { name: '4 hours' }))
        await user.type(screen.getByRole('textbox', { name: 'Reason' }), 'Entra outage')
        await user.click(screen.getByRole('button', { name: 'Open for everyone' }))

        expect(svc.openPasswordFallback).toHaveBeenCalledWith(4, 'Entra outage')
        expect(await screen.findByText(/^Open until /)).toBeInTheDocument()
        expect(screen.getByText('4 h left')).toBeInTheDocument()
        expect(screen.getByText('Opened by admin@corp.example — “Entra outage”'))
            .toBeInTheDocument()
        // The posture beside it follows.
        expect(screen.getByText(/anyone can use a password while emergency access is open/i))
            .toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: 'Close now' }))
        expect(svc.closePasswordFallback).toHaveBeenCalled()
        expect(await screen.findByRole('button', { name: 'Open for everyone' }))
            .toBeInTheDocument()
    })

    it('counts down by the minute while it is open', async () => {
        // Only the clock and the shared ticker are faked: the page still
        // loads on real timers.
        const t0 = Date.parse('2026-10-13T09:00:00Z')
        vi.useFakeTimers({ now: t0, toFake: ['Date', 'setInterval', 'clearInterval'] })
        try {
            svc.getAuthConfig.mockResolvedValue(cfg({
                allowLocalLogin: false,
                passwordFallbackUntil: new Date(t0 + 10 * 60_000).toISOString(),
                passwordFallbackBy: 'admin@corp.example',
            }))
            page()
            expect(await screen.findByText('10 min left')).toBeInTheDocument()

            act(() => { vi.advanceTimersByTime(60_000) })
            expect(screen.getByText('9 min left')).toBeInTheDocument()
        } finally {
            vi.useRealTimers()
        }
    })

    it('extends an open window, offering only the times that end later', async () => {
        // An outage longer than the window: it is extended before it
        // lapses, so nobody signed in through it is sent back to a dead IdP.
        const t0 = Date.now()
        svc.getAuthConfig.mockResolvedValue(cfg({
            allowLocalLogin: false,
            passwordFallbackUntil: new Date(t0 + 3 * 3600_000).toISOString(),
            passwordFallbackBy: 'admin@corp.example',
        }))
        svc.openPasswordFallback.mockResolvedValue(cfg({
            allowLocalLogin: false,
            passwordFallbackUntil: new Date(t0 + 8 * 3600_000).toISOString(),
            passwordFallbackBy: 'admin@corp.example',
        }))
        const user = userEvent.setup()
        page()

        // Three hours left: one more hour from now would shorten it.
        expect(await screen.findByRole('radio', { name: '1 hour' })).toBeDisabled()
        await user.click(screen.getByRole('radio', { name: '8 hours' }))
        await user.type(screen.getByRole('textbox', { name: 'Reason for extending' }), 'Still down')
        await user.click(screen.getByRole('button', { name: 'Extend' }))

        expect(svc.openPasswordFallback).toHaveBeenCalledWith(8, 'Still down')
        await waitFor(() => expect(raised().map(n => n.message).join(' '))
            .toMatch(/^Extended: anyone can sign in with a password until /))
        // Still open, and still says who opened it.
        expect(screen.getByText('Opened by admin@corp.example')).toBeInTheDocument()
    })

    it('has nothing to open while passwords are on for everyone', async () => {
        page()
        expect(await screen.findByText(
            /passwords are on for everyone, so there is nothing to open/i,
        )).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Open for everyone' }))
            .not.toBeInTheDocument()
    })
})

describe('single sign-on status', () => {
    it('names what is down, what that means now, and leads to the door', async () => {
        const since = new Date(Date.now() - 10 * 60_000).toISOString()
        svc.getAuthConfig.mockResolvedValue(cfg({
            allowLocalLogin: false,
            ssoStatus: {
                checkedAt: new Date().toISOString(), stale: false,
                outage: {
                    since,
                    providers: [{
                        slug: 'entra', displayName: 'Corporate Entra', since,
                        detail: 'discovery: connection timed out',
                    }],
                },
            },
        }))
        const user = userEvent.setup()
        page()

        expect(await screen.findByText(/corporate entra can't be reached right now/i))
            .toBeInTheDocument()
        expect(screen.getByText('discovery: connection timed out')).toBeInTheDocument()
        expect(screen.getByText(
            /super admins and break-glass accounts can sign in with a password/i,
        )).toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: /open emergency access/i }))
        expect(screen.getByRole('radio', { name: '1 hour' })).toHaveFocus()
    })

    it('is one quiet line while every connection answers', async () => {
        page()
        expect(await screen.findByText(/all connections reachable · checked /i))
            .toBeInTheDocument()
    })

    it('explains, without alarm, when nothing is watching', async () => {
        svc.getAuthConfig.mockResolvedValue(cfg({
            ssoStatus: { checkedAt: null, stale: true, outage: null },
        }))
        page()
        expect(await screen.findByText(/automatic outage detection isn.t running/i))
            .toBeInTheDocument()
        expect(screen.queryByText(/can't be reached/i)).not.toBeInTheDocument()
    })
})

describe('break-glass accounts', () => {
    it('lists who can always get in', async () => {
        page()
        expect(await screen.findByText('ops@corp.example')).toBeInTheDocument()
        expect(screen.getByText('Ready')).toBeInTheDocument()
        expect(screen.queryByText(/no break-glass account is ready/i))
            .not.toBeInTheDocument()
    })

    it('says in red that nobody is ready once passwords are off, and why each is not', async () => {
        svc.getAuthConfig.mockResolvedValue(cfg({
            allowLocalLogin: false,
            breakGlass: {
                ready: false,
                accounts: [{
                    id: 'u_old', email: 'old@corp.example', status: 'suspended',
                    passwordSet: false, superAdmin: true, ready: false,
                }],
            },
        }))
        page()
        expect(await screen.findByText(
            'No break-glass account is ready — an IdP outage could lock everyone out.',
        )).toBeInTheDocument()
        expect(screen.getByText('Not ready')).toBeInTheDocument()
        expect(screen.getByText('Suspended')).toBeInTheDocument()
        expect(screen.getByText('no password')).toBeInTheDocument()
    })
})
