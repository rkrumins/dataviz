/**
 * Publishing asks first, the way disabling always has.
 *
 * Publish used to be the one consequential action on the card that fired
 * on a single unguarded click — and it is the click with an audience: the
 * connection lands in front of everyone on the sign-in page. The confirm
 * also carries the one fact worth weighing at that moment: whether a
 * rehearsal has ever completed against this configuration.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ProvidersTab } from '../ProvidersTab'
import {
    NotificationStack, useNotificationStore,
} from '@/components/ui/notifications'
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
// the publish request back to the tab.
vi.mock('../../IdpProviderCard', () => ({
    IdpProviderCard: ({ provider, onPublish }: {
        provider: { slug: string }
        onPublish: () => void
    }) => <button onClick={onPublish}>publish {provider.slug}</button>,
}))
vi.mock('../../IdpConnectionWizard', () => ({ IdpConnectionWizard: () => null }))
vi.mock('../../ProviderEditorDrawer', () => ({ ProviderEditorDrawer: () => null }))
vi.mock('../../SsoFirstRunHero', () => ({ SsoFirstRunHero: () => null }))

const svc = ssoAdminService as unknown as Record<string, ReturnType<typeof vi.fn>>

function draft(over: Partial<IdpProvider> = {}): IdpProvider {
    return {
        id: 'idp_1', slug: 'corp', displayName: 'Corp Gateway',
        kind: 'backchannel', enabled: true, priority: 100, settings: {},
        claimMapping: {}, linkingPolicy: 'strict',
        assurance: 'asserted', assuranceReason: '',
        emailDomains: [], lifecycle: 'draft',
        createdAt: '', updatedAt: '',
        ...over,
    } as IdpProvider
}

const raised = () => useNotificationStore.getState().notifications

beforeEach(() => {
    vi.clearAllMocks()
    useNotificationStore.setState({ notifications: [], history: [], _nextId: 1 })
    svc.listProviders.mockResolvedValue([draft()])
    svc.providerStatus.mockResolvedValue({ providers: [] })
    svc.publishProvider.mockResolvedValue(draft({ lifecycle: 'live' }))
})

async function askToPublish() {
    const user = userEvent.setup()
    render(<><ProvidersTab /><NotificationStack /></>)
    await user.click(await screen.findByRole('button', { name: 'publish corp' }))
    return user
}

describe('publishing a draft', () => {
    it('asks first, naming who will see it', async () => {
        await askToPublish()

        const dialog = await screen.findByRole('alertdialog')
        expect(dialog).toHaveTextContent('Corp Gateway')
        expect(dialog).toHaveTextContent(/in front of everyone on the sign-in page/i)
        // The question is still open — nothing went live.
        expect(svc.publishProvider).not.toHaveBeenCalled()
    })

    it('says when nothing has ever rehearsed this configuration', async () => {
        await askToPublish()

        expect(await screen.findByRole('alertdialog'))
            .toHaveTextContent(/never been rehearsed/i)
    })

    it('notes a completed rehearsal when there was one', async () => {
        svc.listProviders.mockResolvedValue([
            draft({ lastAssertionAt: new Date().toISOString() }),
        ])
        await askToPublish()

        const dialog = await screen.findByRole('alertdialog')
        expect(dialog).toHaveTextContent(/has been rehearsed/i)
        expect(dialog).not.toHaveTextContent(/never been rehearsed/i)
    })

    it('walks away on "Not yet"', async () => {
        const user = await askToPublish()
        await screen.findByRole('alertdialog')

        await user.click(screen.getByRole('button', { name: /not yet/i }))
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
        expect(svc.publishProvider).not.toHaveBeenCalled()
    })

    it('publishes on "Publish it"', async () => {
        const user = await askToPublish()
        await screen.findByRole('alertdialog')

        await user.click(screen.getByRole('button', { name: /publish it/i }))
        await waitFor(() => {
            expect(svc.publishProvider).toHaveBeenCalledWith('idp_1')
        })
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })

    // The click with an audience has to say it landed. The dialog closing
    // is the same thing "Not yet" does, so on its own it confirms nothing.
    it('says it went live, and to whom', async () => {
        const user = await askToPublish()
        await screen.findByRole('alertdialog')

        await user.click(screen.getByRole('button', { name: /publish it/i }))

        await waitFor(() => expect(raised()).toHaveLength(1))
        expect(raised()[0].type).toBe('success')
        expect(raised()[0].message).toBe(
            'Corp Gateway is published — everyone sees it on the sign-in '
            + 'screen now.',
        )
    })

    it('names the connection when publishing is refused', async () => {
        svc.publishProvider.mockRejectedValueOnce(new Error(''))
        const user = await askToPublish()
        await screen.findByRole('alertdialog')

        await user.click(screen.getByRole('button', { name: /publish it/i }))

        await waitFor(() => expect(raised()).toHaveLength(1))
        expect(raised()[0].type).toBe('error')
        expect(raised()[0].message).toBe('Could not publish Corp Gateway.')
    })
})
