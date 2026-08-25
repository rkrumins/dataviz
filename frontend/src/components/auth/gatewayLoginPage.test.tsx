/**
 * The sign-in page, for a provider whose first call the browser has to
 * make.
 *
 * Two properties matter here and neither is cosmetic.
 *
 * **It runs for every client of the app, not only for someone who
 * clicks.** The whole promise of workstation SSO is that a session the
 * machine already holds is a session the app can use; making people
 * press a button to spend it defeats the point. So the page attempts it
 * silently, once per tab.
 *
 * **A failure has to be a dead stop with a reason.** A machine outside
 * the domain, or one whose browser has not been told to answer Negotiate
 * for that host, must not be navigated into a sign-in that cannot work,
 * and must not be re-attempted on every render.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginPage } from './LoginPage'

const {
    loginContext, runAuthenticateTrigger, runBrowserExchange,
    storeLoginWithBackchannel, navigate,
} = vi.hoisted(() => ({
    loginContext: vi.fn(),
    runAuthenticateTrigger: vi.fn(),
    runBrowserExchange: vi.fn(),
    storeLoginWithBackchannel: vi.fn(),
    navigate: vi.fn(),
}))

vi.mock('react-router-dom', async () => {
    const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
    return { ...actual, useNavigate: () => navigate }
})

vi.mock('@/services/authService', async () => {
    const actual = await vi.importActual<typeof import('@/services/authService')>(
        '@/services/authService',
    )
    return {
        ...actual,
        authService: { ...actual.authService, loginContext },
        runAuthenticateTrigger,
        runBrowserExchange,
    }
})

vi.mock('@/store/auth', () => ({
    useAuthStore: Object.assign(
        (selector?: (s: unknown) => unknown) => {
            const state = {
                login: vi.fn(), loginWithBrowserProfile: vi.fn(),
                loginWithBackchannel: storeLoginWithBackchannel,
                error: null, clearError: vi.fn(), isLoading: false,
                isAuthenticated: false, status: 'unauthenticated',
            }
            return selector ? selector(state) : state
        },
        { getState: () => ({ error: null }) },
    ),
}))
vi.mock('@/store/branding', () => ({
    useBrand: () => ({ appName: 'Test', loginTagline: '', copyrightText: '' }),
}))
vi.mock('@/store/features', () => ({ useFeature: () => false }))
vi.mock('@/lib/useDocumentTitle', () => ({ useDocumentTitle: () => {} }))

const GATEWAY = {
    id: 'idp_1', slug: 'corp-gateway', displayName: 'Corporate Gateway',
    kind: 'backchannel', priority: 100,
    config: {
        authenticateUrl: 'https://sso.corporate.com/authenticate',
        authenticateMethod: 'POST',
        authenticateHeaders: { 'X-App-ID': 'app-1' },
    },
}

const OIDC = {
    id: 'idp_2', slug: 'entra', displayName: 'Entra',
    kind: 'oidc', priority: 100,
}

let assign: ReturnType<typeof vi.fn>

beforeEach(() => {
    vi.clearAllMocks()
    window.sessionStorage.clear()
    assign = vi.fn()
    Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...window.location, assign, search: '' },
    })
    loginContext.mockResolvedValue({
        allowLocalLogin: true, emailFirstLogin: false, providers: [GATEWAY],
    })
    runAuthenticateTrigger.mockResolvedValue(null)
    runBrowserExchange.mockResolvedValue('assertion-jwt')
    storeLoginWithBackchannel.mockResolvedValue(true)
})

afterEach(() => { vi.restoreAllMocks() })

const renderLogin = () => render(<MemoryRouter><LoginPage /></MemoryRouter>)

// ── it happens without being asked ───────────────────────────────────

describe('silent sign-in', () => {
    it('makes the call for anyone opening the app', async () => {
        renderLogin()
        await waitFor(() => expect(runAuthenticateTrigger).toHaveBeenCalledTimes(1))
    })

    it('completes in-page when the provider set a cookie', async () => {
        // The trigger minted the corporate cookie on a shared domain; an
        // empty body tells the server to read it off the POST itself. No
        // full-page navigation — the recovery path depends on this leg
        // staying silent.
        renderLogin()
        await waitFor(() => {
            expect(storeLoginWithBackchannel)
                .toHaveBeenCalledWith('corp-gateway', {})
        })
        await waitFor(() => expect(navigate).toHaveBeenCalledWith('/', { replace: true }))
        expect(assign).not.toHaveBeenCalled()
    })

    it('completes in-page when the provider answered with a handle', async () => {
        runAuthenticateTrigger.mockResolvedValue('handle-abc')
        renderLogin()
        await waitFor(() => {
            expect(storeLoginWithBackchannel)
                .toHaveBeenCalledWith('corp-gateway', { handle: 'handle-abc' })
        })
        await waitFor(() => expect(navigate).toHaveBeenCalledWith('/', { replace: true }))
    })

    it('runs the exchange itself when the cookie never reaches us', async () => {
        // Browser-mode row: the page calls the translate endpoint (the
        // browser's cookie jar carries the corporate session) and posts
        // the signed answer. With no trigger configured, none runs.
        loginContext.mockResolvedValue({
            allowLocalLogin: true, emailFirstLogin: false,
            providers: [{
                ...GATEWAY,
                config: { browserExchangeUrl: 'https://sso.corporate.com/translate' },
            }],
        })
        renderLogin()
        await waitFor(() => {
            expect(storeLoginWithBackchannel).toHaveBeenCalledWith(
                'corp-gateway', { assertion: 'assertion-jwt' },
            )
        })
        expect(runAuthenticateTrigger).not.toHaveBeenCalled()
        await waitFor(() => expect(navigate).toHaveBeenCalledWith('/', { replace: true }))
    })

    it('runs the trigger before the exchange when both are configured', async () => {
        loginContext.mockResolvedValue({
            allowLocalLogin: true, emailFirstLogin: false,
            providers: [{
                ...GATEWAY,
                config: {
                    ...GATEWAY.config,
                    browserExchangeUrl: 'https://sso.corporate.com/translate',
                },
            }],
        })
        renderLogin()
        await waitFor(() => {
            expect(storeLoginWithBackchannel).toHaveBeenCalledWith(
                'corp-gateway', { assertion: 'assertion-jwt' },
            )
        })
        expect(runAuthenticateTrigger).toHaveBeenCalledTimes(1)
        expect(runAuthenticateTrigger.mock.invocationCallOrder[0])
            .toBeLessThan(runBrowserExchange.mock.invocationCallOrder[0])
    })

    it('tries once per tab, however many times the page renders', async () => {
        // The loop this guards is real: attempt, fail, re-render,
        // attempt. The sentinel is per-tab so a fresh tab still retries.
        runAuthenticateTrigger.mockRejectedValue(new Error('no ticket'))
        const { rerender } = renderLogin()
        await waitFor(() => expect(runAuthenticateTrigger).toHaveBeenCalledTimes(1))
        rerender(<MemoryRouter><LoginPage /></MemoryRouter>)
        await new Promise(r => setTimeout(r, 20))
        expect(runAuthenticateTrigger).toHaveBeenCalledTimes(1)
    })

    it('leaves a working form behind when it fails', async () => {
        // Off-domain machines and browsers with no Negotiate policy for
        // this host are ordinary, not exceptional.
        runAuthenticateTrigger.mockRejectedValue(new Error('no ticket'))
        renderLogin()
        await waitFor(() => expect(runAuthenticateTrigger).toHaveBeenCalled())
        expect(navigate).not.toHaveBeenCalled()
        expect(assign).not.toHaveBeenCalled()
        expect(await screen.findByLabelText(/password/i)).toBeInTheDocument()
    })

    it('stays silent about a failure nobody asked for', async () => {
        runAuthenticateTrigger.mockRejectedValue(new Error('no ticket'))
        renderLogin()
        await waitFor(() => expect(runAuthenticateTrigger).toHaveBeenCalled())
        expect(screen.queryByText(/could not reach/i)).not.toBeInTheDocument()
    })

    it('does not fire when two providers could both claim it', async () => {
        // Which one would it pick? Guessing on a user's behalf is worse
        // than showing them the buttons.
        loginContext.mockResolvedValue({
            allowLocalLogin: true, emailFirstLogin: false,
            providers: [GATEWAY, { ...GATEWAY, id: 'idp_3', slug: 'other' }],
        })
        renderLogin()
        await screen.findByLabelText(/password/i)
        expect(runAuthenticateTrigger).not.toHaveBeenCalled()
    })
})

// ── and when it is asked ─────────────────────────────────────────────

describe('the button', () => {
    beforeEach(() => {
        // Spend the silent attempt so the button is what is under test.
        window.sessionStorage.setItem('nx_portal_autologin_tried', '1')
    })

    it('says what went wrong rather than navigating anyway', async () => {
        runAuthenticateTrigger.mockRejectedValue(
            new Error('The sign-in service answered 401.'),
        )
        renderLogin()
        await userEvent.click(await screen.findByRole('button', { name: /Corporate Gateway/i }))

        expect(await screen.findByText(/could not reach/i)).toBeInTheDocument()
        expect(await screen.findByText(/answered 401/i)).toBeInTheDocument()
        expect(navigate).not.toHaveBeenCalled()
        expect(assign).not.toHaveBeenCalled()
    })

    it('runs the call when pressed', async () => {
        renderLogin()
        await userEvent.click(await screen.findByRole('button', { name: /Corporate Gateway/i }))
        await waitFor(() => expect(runAuthenticateTrigger).toHaveBeenCalled())
    })
})

// ── the affordance ───────────────────────────────────────────────────

describe('the glyph', () => {
    beforeEach(() => {
        window.sessionStorage.setItem('nx_portal_autologin_tried', '1')
    })

    it('promises a hand-off only where one happens', async () => {
        loginContext.mockResolvedValue({
            allowLocalLogin: true, emailFirstLogin: false, providers: [OIDC],
        })
        const { container } = renderLogin()
        await screen.findByRole('link', { name: /Entra/i })
        expect(container.querySelector('.lucide-external-link')).not.toBeNull()
    })

    it('does not promise one for a back-channel provider', async () => {
        // It resolves server-side and lands the user straight back.
        const { container } = renderLogin()
        await screen.findByRole('button', { name: /Corporate Gateway/i })
        expect(container.querySelector('.lucide-external-link')).toBeNull()
    })
})
