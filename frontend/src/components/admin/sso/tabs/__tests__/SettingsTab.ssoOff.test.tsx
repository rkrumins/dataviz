/**
 * The master switch's second half.
 *
 * Turning ``ssoEnabled`` off stops new SSO sign-ins; the sessions those
 * connections already minted keep rotating until they expire. So the
 * confirm asks the session question in the same breath — with the
 * count — and a standalone action covers the operator who declined it
 * (or turned SSO off before the offer existed) and reaches for it once
 * the switch is already off, which is the usual moment.
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
    },
}))
// Makes its own service calls and has its own tests.
vi.mock('../settings/BackchannelHostsPanel', () => ({
    BackchannelHostsPanel: () => null,
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
    svc.updateAuthConfig.mockResolvedValue(cfg({ ssoEnabled: false, version: 4 }))
    svc.endSsoSessions.mockResolvedValue({
        usersAffected: 3, tokensRevoked: 5, dryRun: true,
    })
})

describe('turning the master switch off', () => {
    it('asks the session question in the same confirm, with the count', async () => {
        const user = userEvent.setup()
        render(<SettingsTab />)
        await user.click(
            await screen.findByRole('switch', { name: 'Single sign-on' }),
        )

        expect(await screen.findByText(
            /also sign out the 3 people signed in through a connection/i,
        )).toBeInTheDocument()
        expect(svc.endSsoSessions).toHaveBeenCalledWith({ dryRun: true })
        expect(svc.updateAuthConfig).not.toHaveBeenCalled()
    })

    it('flips only the switch when the checkbox stays unticked', async () => {
        const user = userEvent.setup()
        render(<SettingsTab />)
        await user.click(
            await screen.findByRole('switch', { name: 'Single sign-on' }),
        )
        await screen.findByRole('checkbox')

        await user.click(screen.getByRole('button', { name: /turn it off/i }))

        await waitFor(() => {
            expect(svc.updateAuthConfig).toHaveBeenCalledWith({
                ssoEnabled: false, expectedVersion: 3,
            })
        })
        // Only the dry-run count — nobody was signed out.
        expect(svc.endSsoSessions).toHaveBeenCalledTimes(1)
    })

    it('signs everyone out too when asked, and reports the real number', async () => {
        svc.endSsoSessions
            .mockResolvedValueOnce({ usersAffected: 3, tokensRevoked: 5, dryRun: true })
            .mockResolvedValueOnce({ usersAffected: 2, tokensRevoked: 4, dryRun: false })
        const user = userEvent.setup()
        render(<SettingsTab />)
        await user.click(
            await screen.findByRole('switch', { name: 'Single sign-on' }),
        )

        await user.click(await screen.findByRole('checkbox'))
        await user.click(screen.getByRole('button', { name: /turn it off/i }))

        expect(await screen.findByText(/signed out 2 people/i))
            .toBeInTheDocument()
        expect(svc.endSsoSessions).toHaveBeenLastCalledWith()
    })

    it('states, rather than offers, when nobody is signed in through SSO', async () => {
        svc.endSsoSessions.mockResolvedValueOnce({
            usersAffected: 0, tokensRevoked: 0, dryRun: true,
        })
        const user = userEvent.setup()
        render(<SettingsTab />)
        await user.click(
            await screen.findByRole('switch', { name: 'Single sign-on' }),
        )

        expect(await screen.findByText(
            /nobody is signed in through a connection right now/i,
        )).toBeInTheDocument()
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    })

    it('gives the other confirmable switches no session checkbox', async () => {
        const user = userEvent.setup()
        render(<SettingsTab />)
        await user.click(
            await screen.findByRole('switch', { name: 'Passwords' }),
        )

        // The confirm block opened…
        expect(await screen.findByRole('button', { name: /turn it off/i }))
            .toBeInTheDocument()
        // …but with no session checkbox and no count fetched.
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
        expect(svc.endSsoSessions).not.toHaveBeenCalled()
    })
})

describe('the standalone sign-out, once the switch is already off', () => {
    it('is absent while single sign-on is on', async () => {
        render(<SettingsTab />)
        await screen.findByRole('switch', { name: 'Single sign-on' })
        expect(
            screen.queryByText(/sessions that outlived the switch/i),
        ).not.toBeInTheDocument()
    })

    it('counts first, then ends sessions behind a second click', async () => {
        svc.getAuthConfig.mockResolvedValue(cfg({ ssoEnabled: false }))
        svc.endSsoSessions
            .mockResolvedValueOnce({ usersAffected: 3, tokensRevoked: 5, dryRun: true })
            .mockResolvedValueOnce({ usersAffected: 3, tokensRevoked: 5, dryRun: false })
        const user = userEvent.setup()
        render(<SettingsTab />)

        await screen.findByText(/sessions that outlived the switch/i)
        await user.click(screen.getByRole('button', { name: /sign them out now/i }))

        // The first click only asked. The act carries the number.
        expect(svc.endSsoSessions).toHaveBeenCalledWith({ dryRun: true })
        await user.click(
            await screen.findByRole('button', { name: /sign out 3 people/i }),
        )

        expect(await screen.findByText(/signed out 3 people/i))
            .toBeInTheDocument()
        expect(svc.endSsoSessions).toHaveBeenLastCalledWith()
    })

    it('reports an empty sweep as a fact, not a button', async () => {
        svc.getAuthConfig.mockResolvedValue(cfg({ ssoEnabled: false }))
        svc.endSsoSessions.mockResolvedValueOnce({
            usersAffected: 0, tokensRevoked: 0, dryRun: true,
        })
        const user = userEvent.setup()
        render(<SettingsTab />)

        await screen.findByText(/sessions that outlived the switch/i)
        await user.click(screen.getByRole('button', { name: /sign them out now/i }))

        expect(await screen.findByText(
            /nobody is still signed in through a connection/i,
        )).toBeInTheDocument()
        expect(
            screen.queryByRole('button', { name: /sign out 0/i }),
        ).not.toBeInTheDocument()
    })
})
