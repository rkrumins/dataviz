/**
 * Turning a connection off is two decisions, not one.
 *
 * The switch stops new sign-ins; it says nothing about the sessions the
 * connection already minted, which keep rotating until they expire. The
 * old toggle flipped silently and left that second decision unmade — and
 * invisible. Now disabling asks first, says how many people are signed
 * in through the connection, and offers to sign them out in the same
 * breath. Enabling stays ceremony-free: it strands nobody.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ProvidersTab } from '../ProvidersTab'
import { ssoAdminService, type IdpProvider } from '@/services/ssoAdminService'

vi.mock('@/services/ssoAdminService', () => ({
    ssoAdminService: {
        listProviders: vi.fn(),
        providerStatus: vi.fn(),
        updateProvider: vi.fn(),
        endProviderSessions: vi.fn(),
        publishProvider: vi.fn(),
        startDryRun: vi.fn(),
        rehearseBackchannel: vi.fn(),
    },
}))
vi.mock('@/services/authService', () => ({
    runAuthenticateCall: vi.fn(),
    runBrowserExchangeCall: vi.fn(),
}))
// The card's own behavior has its own tests; here it only needs to hand
// the toggle back to the tab.
vi.mock('../../IdpProviderCard', () => ({
    IdpProviderCard: ({ provider, onToggleEnabled }: {
        provider: { slug: string }
        onToggleEnabled: () => void
    }) => <button onClick={onToggleEnabled}>power {provider.slug}</button>,
}))
vi.mock('../../IdpConnectionWizard', () => ({ IdpConnectionWizard: () => null }))
vi.mock('../../ProviderEditorDrawer', () => ({ ProviderEditorDrawer: () => null }))
vi.mock('../../SsoFirstRunHero', () => ({ SsoFirstRunHero: () => null }))

const svc = ssoAdminService as unknown as Record<string, ReturnType<typeof vi.fn>>

function provider(over: Partial<IdpProvider> = {}): IdpProvider {
    return {
        id: 'idp_1', slug: 'corp', displayName: 'Corp Gateway',
        kind: 'backchannel', enabled: true, priority: 100, settings: {},
        claimMapping: {}, linkingPolicy: 'strict',
        assurance: 'asserted', assuranceReason: '',
        emailDomains: [], lifecycle: 'live',
        createdAt: '', updatedAt: '',
    ...over,
    } as IdpProvider
}

beforeEach(() => {
    vi.clearAllMocks()
    svc.listProviders.mockResolvedValue([provider()])
    svc.providerStatus.mockResolvedValue({ providers: [] })
    svc.updateProvider.mockResolvedValue(provider({ enabled: false }))
    svc.endProviderSessions.mockResolvedValue({
        providerId: 'idp_1', usersAffected: 3, tokensRevoked: 4, dryRun: true,
    })
})

async function openTab() {
    render(<ProvidersTab />)
    return await screen.findByRole('button', { name: 'power corp' })
}

describe('enabling', () => {
    it('needs no ceremony — it strands nobody', async () => {
        svc.listProviders.mockResolvedValue([provider({ enabled: false })])
        const user = userEvent.setup()
        await user.click(await openTab())

        await waitFor(() => {
            expect(svc.updateProvider)
                .toHaveBeenCalledWith('idp_1', { enabled: true })
        })
        expect(svc.endProviderSessions).not.toHaveBeenCalled()
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
})

describe('disabling', () => {
    it('asks first, with the number of people it strands', async () => {
        const user = userEvent.setup()
        await user.click(await openTab())

        const dialog = await screen.findByRole('alertdialog')
        expect(dialog).toHaveTextContent(/turn off/i)
        expect(dialog).toHaveTextContent('Corp Gateway')
        expect(dialog).toHaveTextContent(/3 people keep their sessions/i)
        expect(svc.endProviderSessions)
            .toHaveBeenCalledWith('idp_1', { dryRun: true })
        // Nothing flipped yet — the question is still open.
        expect(svc.updateProvider).not.toHaveBeenCalled()
    })

    it('walks away when the operator keeps it on', async () => {
        const user = userEvent.setup()
        await user.click(await openTab())
        await screen.findByRole('alertdialog')

        await user.click(screen.getByRole('button', { name: /keep it on/i }))
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
        expect(svc.updateProvider).not.toHaveBeenCalled()
    })

    it('flips only the switch when the checkbox stays unticked', async () => {
        const user = userEvent.setup()
        await user.click(await openTab())
        await screen.findByRole('alertdialog')

        await user.click(screen.getByRole('button', { name: /turn it off/i }))

        await waitFor(() => {
            expect(svc.updateProvider)
                .toHaveBeenCalledWith('idp_1', { enabled: false })
        })
        // Only the dry-run count — nobody was signed out.
        expect(svc.endProviderSessions).toHaveBeenCalledTimes(1)
        expect(await screen.findByText(
            /keep their sessions until those expire/i,
        )).toBeInTheDocument()
    })

    it('signs them out too when asked, and reports the real number', async () => {
        // The count can drift between the question and the act — the
        // notice reports what actually happened, not what was predicted.
        svc.endProviderSessions
            .mockResolvedValueOnce({
                providerId: 'idp_1', usersAffected: 3, tokensRevoked: 4,
                dryRun: true,
            })
            .mockResolvedValueOnce({
                providerId: 'idp_1', usersAffected: 2, tokensRevoked: 3,
                dryRun: false,
            })
        const user = userEvent.setup()
        await user.click(await openTab())
        await screen.findByRole('alertdialog')

        await user.click(screen.getByRole('checkbox'))
        await user.click(screen.getByRole('button', { name: /turn it off/i }))

        await waitFor(() => {
            expect(svc.updateProvider)
                .toHaveBeenCalledWith('idp_1', { enabled: false })
        })
        expect(svc.endProviderSessions).toHaveBeenLastCalledWith('idp_1')
        expect(await screen.findByText(/signed out 2 people/i))
            .toBeInTheDocument()
    })

    it('still asks when the count cannot be read — just numberless', async () => {
        svc.endProviderSessions.mockRejectedValueOnce(new Error('boom'))
        const user = userEvent.setup()
        await user.click(await openTab())

        const dialog = await screen.findByRole('alertdialog')
        expect(dialog).toHaveTextContent(
            /people already signed in through it keep their sessions/i,
        )
        expect(screen.getByLabelText(/also sign those people out now/i))
            .toBeInTheDocument()
    })

    it('offers no checkbox when nobody is signed in through it', async () => {
        svc.endProviderSessions.mockResolvedValueOnce({
            providerId: 'idp_1', usersAffected: 0, tokensRevoked: 0,
            dryRun: true,
        })
        const user = userEvent.setup()
        await user.click(await openTab())

        const dialog = await screen.findByRole('alertdialog')
        expect(dialog).toHaveTextContent(/nobody is currently signed in/i)
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    })

    it('says the switch flipped even when the sign-out after it failed', async () => {
        svc.endProviderSessions
            .mockResolvedValueOnce({
                providerId: 'idp_1', usersAffected: 3, tokensRevoked: 4,
                dryRun: true,
            })
            .mockRejectedValueOnce(new Error('the sweep timed out'))
        const user = userEvent.setup()
        await user.click(await openTab())
        await screen.findByRole('alertdialog')

        await user.click(screen.getByRole('checkbox'))
        await user.click(screen.getByRole('button', { name: /turn it off/i }))

        expect(await screen.findByText(
            /is off, but signing its users out failed/i,
        )).toBeInTheDocument()
    })
})
