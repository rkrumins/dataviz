/**
 * Self-service linking, for a provider the browser has to drive.
 *
 * The link flow used to be one navigation for every kind:
 * startIdentityLink sets the link-intent cookie, then the page walks to
 * the provider's /login URL. A gateway provider cannot serve that URL —
 * its sign-in starts with calls only this browser can make — so linking
 * one dead-ended on a route that never works. Now gateway rows run the
 * browser half in place and POST it; the link-intent cookie rides on
 * the POST, and the server links instead of signing in fresh. Redirect
 * kinds keep their navigation.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MyIdentitiesPage } from '../MyIdentitiesPage'

const {
    listProviders, startIdentityLink, loginWithBackchannel,
    runAuthenticateTrigger, runBrowserExchange, refresh, showToast,
    refreshPermissions,
} = vi.hoisted(() => ({
    listProviders: vi.fn(),
    startIdentityLink: vi.fn(),
    loginWithBackchannel: vi.fn(),
    runAuthenticateTrigger: vi.fn(),
    runBrowserExchange: vi.fn(),
    refresh: vi.fn(),
    showToast: vi.fn(),
    refreshPermissions: vi.fn(),
}))

vi.mock('@/services/authService', async () => {
    const actual = await vi.importActual<typeof import('@/services/authService')>(
        '@/services/authService',
    )
    return {
        ...actual,
        authService: {
            ...actual.authService, listProviders, startIdentityLink,
        },
        loginWithBackchannel,
        runAuthenticateTrigger,
        runBrowserExchange,
    }
})
vi.mock('@/components/account/AccountShell', () => ({
    AccountShell: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    AccountCard: ({ children, title }: { children?: React.ReactNode; title?: string }) => (
        <section aria-label={title}>{children}</section>
    ),
    EmptyState: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    useAccountIdentity: () => ({
        passwordSet: true, identities: [], refresh,
    }),
}))
vi.mock('@/components/ui/toast', () => ({
    useToast: () => ({ showToast }),
}))
vi.mock('@/store/auth', () => ({
    useAuthStore: { getState: () => ({ refreshPermissions }) },
}))
vi.mock('@/lib/useDocumentTitle', () => ({ useDocumentTitle: () => {} }))

const GATEWAY = {
    id: 'idp_1', slug: 'corp-gateway', displayName: 'Corporate Gateway',
    kind: 'backchannel', priority: 100,
    config: { authenticateUrl: 'https://sso.corporate.com/authenticate' },
}
const OIDC = {
    id: 'idp_2', slug: 'entra', displayName: 'Entra', kind: 'oidc',
    priority: 100,
}

const realLocation = window.location

beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...realLocation, href: 'http://localhost/me/identities' },
    })
    listProviders.mockResolvedValue([GATEWAY, OIDC])
    startIdentityLink.mockResolvedValue({
        loginUrl: '/api/v1/auth/corp-gateway/login?link=1',
    })
    runAuthenticateTrigger.mockResolvedValue(null)
    runBrowserExchange.mockResolvedValue('assertion-jwt')
    loginWithBackchannel.mockResolvedValue({ user: { id: 'u1' } })
    refresh.mockResolvedValue(undefined)
    refreshPermissions.mockResolvedValue(undefined)
})

async function clickLinkOn(name: RegExp) {
    render(<MyIdentitiesPage />)
    const row = (await screen.findByText(name)).closest('li')!
    await userEvent.click(row.querySelector('button')!)
}

describe('linking a gateway provider', () => {
    it('runs the browser half in place instead of a dead navigation', async () => {
        await clickLinkOn(/corporate gateway/i)

        await waitFor(() => {
            expect(loginWithBackchannel)
                .toHaveBeenCalledWith('corp-gateway', {})
        })
        // The intent cookie was set first, so the POST links.
        expect(startIdentityLink).toHaveBeenCalledWith('corp-gateway')
        expect(startIdentityLink.mock.invocationCallOrder[0])
            .toBeLessThan(loginWithBackchannel.mock.invocationCallOrder[0])
        // No navigation happened.
        expect(window.location.href).toBe('http://localhost/me/identities')
        await waitFor(() => expect(refresh).toHaveBeenCalled())
        expect(showToast)
            .toHaveBeenCalledWith('success', 'Corporate Gateway linked')
        await waitFor(() => expect(refreshPermissions).toHaveBeenCalled())
    })

    it('says what failed and stays on the page', async () => {
        loginWithBackchannel.mockRejectedValue(
            new Error('Signing in with that session did not work.'),
        )
        await clickLinkOn(/corporate gateway/i)

        expect(await screen.findByText(/did not work/i)).toBeInTheDocument()
        expect(window.location.href).toBe('http://localhost/me/identities')
        expect(showToast).not.toHaveBeenCalled()
    })
})

describe('linking a redirect provider', () => {
    it('keeps the navigation — the IdP round trip needs it', async () => {
        startIdentityLink.mockResolvedValue({
            loginUrl: '/api/v1/auth/entra/login?link=1',
        })
        await clickLinkOn(/entra/i)

        await waitFor(() => {
            expect(window.location.href).toBe('/api/v1/auth/entra/login?link=1')
        })
        expect(loginWithBackchannel).not.toHaveBeenCalled()
    })
})
