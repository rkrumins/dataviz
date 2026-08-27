/**
 * Requiring everyone to sign in again.
 *
 * Turning passwords off changes what the next sign-in must be; the
 * sessions already out there stay valid under the old policy until they
 * expire. So the enforcement confirm asks the everyone-question in the
 * same breath — with the counts, and with the "including you" warning —
 * and a standalone card covers the admin who reaches for the sweep on
 * its own (a posture changed earlier, a suspected leak, an IdP
 * migration). System accounts are the carve-out both surfaces report.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SettingsTab } from '../SettingsTab'
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
    svc.getAuthConfig.mockResolvedValue(cfg())
    svc.listProviders.mockResolvedValue([])
    svc.updateAuthConfig.mockResolvedValue(
        cfg({ allowLocalLogin: false, version: 4 }),
    )
    svc.endAllSessions.mockResolvedValue({
        usersAffected: 3, tokensRevoked: 7, systemAccountsSkipped: 1,
        dryRun: true,
    })
})

describe('turning passwords off', () => {
    it('asks the everyone-question in the confirm, counts and carve-out included', async () => {
        const user = userEvent.setup()
        render(<SettingsTab />)
        await user.click(
            await screen.findByRole('switch', { name: 'Passwords' }),
        )

        expect(await screen.findByText(
            /also require the 3 people signed in right now to sign in again/i,
        )).toBeInTheDocument()
        expect(screen.getByText(/that includes you/i)).toBeInTheDocument()
        expect(screen.getByText(/1 system account stays signed in/i))
            .toBeInTheDocument()
        expect(svc.endAllSessions).toHaveBeenCalledWith({ dryRun: true })
        expect(svc.updateAuthConfig).not.toHaveBeenCalled()
    })

    it('flips only the switch when the checkbox stays unticked', async () => {
        const user = userEvent.setup()
        render(<SettingsTab />)
        await user.click(
            await screen.findByRole('switch', { name: 'Passwords' }),
        )
        await screen.findByRole('checkbox')

        await user.click(screen.getByRole('button', { name: /turn it off/i }))

        await waitFor(() => {
            expect(svc.updateAuthConfig).toHaveBeenCalledWith({
                allowLocalLogin: false, expectedVersion: 3,
            })
        })
        // Only the dry-run counts — nobody was signed out.
        expect(svc.endAllSessions).toHaveBeenCalledTimes(1)
    })

    it('sweeps when asked, and reports the real number', async () => {
        svc.endAllSessions
            .mockResolvedValueOnce({
                usersAffected: 3, tokensRevoked: 7,
                systemAccountsSkipped: 1, dryRun: true,
            })
            .mockResolvedValueOnce({
                usersAffected: 2, tokensRevoked: 5,
                systemAccountsSkipped: 1, dryRun: false,
            })
        const user = userEvent.setup()
        render(<SettingsTab />)
        await user.click(
            await screen.findByRole('switch', { name: 'Passwords' }),
        )

        await user.click(await screen.findByRole('checkbox'))
        await user.click(screen.getByRole('button', { name: /turn it off/i }))

        expect(await screen.findByText(/signed out 2 people/i))
            .toBeInTheDocument()
        expect(svc.endAllSessions).toHaveBeenLastCalledWith()
    })

    it('states, rather than offers, when nobody is signed in', async () => {
        svc.endAllSessions.mockResolvedValueOnce({
            usersAffected: 0, tokensRevoked: 0, systemAccountsSkipped: 0,
            dryRun: true,
        })
        const user = userEvent.setup()
        render(<SettingsTab />)
        await user.click(
            await screen.findByRole('switch', { name: 'Passwords' }),
        )

        expect(await screen.findByText(
            /nobody is signed in right now, so there is nothing to end/i,
        )).toBeInTheDocument()
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    })
})

describe('the standalone everyone-sweep', () => {
    it('is always present — the moment it is needed is rarely a switch flip', async () => {
        render(<SettingsTab />)
        expect(await screen.findByText(/require everyone to sign in again/i))
            .toBeInTheDocument()
    })

    it('counts first, then sweeps behind a second click carrying the numbers', async () => {
        svc.endAllSessions
            .mockResolvedValueOnce({
                usersAffected: 3, tokensRevoked: 7,
                systemAccountsSkipped: 1, dryRun: true,
            })
            .mockResolvedValueOnce({
                usersAffected: 3, tokensRevoked: 7,
                systemAccountsSkipped: 1, dryRun: false,
            })
        const user = userEvent.setup()
        render(<SettingsTab />)

        await user.click(
            await screen.findByRole('button', { name: /sign everyone out now/i }),
        )
        expect(svc.endAllSessions).toHaveBeenCalledWith({ dryRun: true })
        expect(await screen.findByText(/1 system account stays signed in/i))
            .toBeInTheDocument()

        await user.click(
            await screen.findByRole('button', { name: /sign out 3 people/i }),
        )
        expect(await screen.findByText(/signed out 3 people/i))
            .toBeInTheDocument()
        expect(svc.endAllSessions).toHaveBeenLastCalledWith()
    })

    it('reports an empty sweep as a fact, not a button', async () => {
        svc.endAllSessions.mockResolvedValueOnce({
            usersAffected: 0, tokensRevoked: 0, systemAccountsSkipped: 0,
            dryRun: true,
        })
        const user = userEvent.setup()
        render(<SettingsTab />)

        await user.click(
            await screen.findByRole('button', { name: /sign everyone out now/i }),
        )
        expect(await screen.findByText(/nobody is signed in right now\./i))
            .toBeInTheDocument()
        expect(
            screen.queryByRole('button', { name: /sign out 0/i }),
        ).not.toBeInTheDocument()
    })
})
