/**
 * Rehearsing a browser-mode row runs the very calls the sign-in page
 * would make — from this browser, which holds the corporate session.
 *
 * The part worth pinning is the hand-off: a row that forwards the
 * trigger's token into the translate body must forward it during a
 * rehearsal too, or the rehearsal would fail against a gateway the
 * real sign-in works on — the exact blind spot rehearsals exist to
 * close.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ProvidersTab } from '../ProvidersTab'
import {
    NotificationStack, useNotificationStore,
} from '@/components/ui/notifications'
import { ssoAdminService, type IdpProvider } from '@/services/ssoAdminService'
import {
    runAuthenticateCall, runBrowserExchangeCall,
} from '@/services/authService'

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
    summarizeRehearsalOutcome: vi.fn(() => []),
}))
vi.mock('@/services/authService', () => ({
    runAuthenticateCall: vi.fn(),
    runBrowserExchangeCall: vi.fn(),
}))
vi.mock('../../IdpProviderCard', () => ({
    IdpProviderCard: ({ provider, onRehearse }: {
        provider: { slug: string }
        onRehearse: () => void
    }) => <button onClick={onRehearse}>rehearse {provider.slug}</button>,
}))
vi.mock('../../IdpConnectionWizard', () => ({ IdpConnectionWizard: () => null }))
vi.mock('../../ProviderEditorDrawer', () => ({ ProviderEditorDrawer: () => null }))
vi.mock('../../SsoFirstRunHero', () => ({ SsoFirstRunHero: () => null }))

const svc = ssoAdminService as unknown as Record<string, ReturnType<typeof vi.fn>>
const trigger = runAuthenticateCall as ReturnType<typeof vi.fn>
const exchange = runBrowserExchangeCall as ReturnType<typeof vi.fn>

function forwardingRow(): IdpProvider {
    return {
        id: 'idp_1', slug: 'corp', displayName: 'Corp Gateway',
        kind: 'backchannel', enabled: true, priority: 100,
        settings: {
            exchange_mode: 'browser',
            browser_exchange_url: 'https://sso.corporate.com/translate',
            browser_exchange_method: 'POST',
            browser_exchange_body_field: 'token',
            authenticate_url: 'https://sso.corporate.com/authenticate',
            authenticate_token_path: 'token',
        },
        claimMapping: {}, linkingPolicy: 'strict',
        assurance: 'verified', assuranceReason: '',
        emailDomains: [], lifecycle: 'live',
        createdAt: '', updatedAt: '',
    } as IdpProvider
}

beforeEach(() => {
    vi.clearAllMocks()
    useNotificationStore.setState({ notifications: [], history: [], _nextId: 1 })
    svc.listProviders.mockResolvedValue([forwardingRow()])
    svc.providerStatus.mockResolvedValue({ providers: [] })
    svc.startDryRun.mockResolvedValue({ loginUrl: 'https://app/login?dry=1' })
    svc.rehearseBackchannel.mockResolvedValue({
        ok: true, line: 'Would sign in as ada@corp.example.',
    })
    trigger.mockResolvedValue('corp-handle')
    exchange.mockResolvedValue('assertion-jwt')
})

describe('rehearsing a forwarding browser-mode row', () => {
    it('hands the trigger token into the translate call it makes', async () => {
        const user = userEvent.setup()
        render(<><ProvidersTab /><NotificationStack /></>)
        await user.click(
            await screen.findByRole('button', { name: 'rehearse corp' }),
        )

        // The ask now happens in the tab's own confirm idiom, not a
        // browser confirm() — same dialog family as disable and publish.
        const dialog = await screen.findByRole('alertdialog')
        expect(dialog).toHaveTextContent(/nothing will be written/i)
        expect(svc.startDryRun).not.toHaveBeenCalled()
        await user.click(screen.getByRole('button', { name: /^rehearse$/i }))

        await waitFor(() => {
            expect(svc.rehearseBackchannel)
                .toHaveBeenCalledWith('corp', { assertion: 'assertion-jwt' })
        })
        expect(trigger).toHaveBeenCalledWith(expect.objectContaining({
            url: 'https://sso.corporate.com/authenticate',
            tokenPath: 'token',
        }))
        expect(exchange).toHaveBeenCalledWith(expect.objectContaining({
            url: 'https://sso.corporate.com/translate',
            method: 'POST',
            bodyField: 'token',
            token: 'corp-handle',
        }))
        expect(await screen.findByText(/would sign in as/i)).toBeInTheDocument()
    })

    it('walks away on Cancel without touching the IdP', async () => {
        const user = userEvent.setup()
        render(<><ProvidersTab /><NotificationStack /></>)
        await user.click(
            await screen.findByRole('button', { name: 'rehearse corp' }),
        )
        await screen.findByRole('alertdialog')

        await user.click(screen.getByRole('button', { name: /cancel/i }))
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
        expect(svc.startDryRun).not.toHaveBeenCalled()
        expect(trigger).not.toHaveBeenCalled()
    })
})
