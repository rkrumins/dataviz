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
    loginContext, resolveEmailDomain, runAuthenticateTrigger,
    runBrowserExchange, storeLoginWithBackchannel, navigate, lastDenialRef,
    errorRef,
} = vi.hoisted(() => ({
    loginContext: vi.fn(),
    resolveEmailDomain: vi.fn(),
    runAuthenticateTrigger: vi.fn(),
    runBrowserExchange: vi.fn(),
    storeLoginWithBackchannel: vi.fn(),
    navigate: vi.fn(),
    // What useAuthStore.getState().lastSsoDenial answers — the page
    // reads it after a refused sign-in to decide on the modal.
    lastDenialRef: { current: null as unknown },
    // The store's error, observable: a refused loginWithBackchannel
    // writes it in the real store, and the page must be seen NOT to
    // leave it on screen for an attempt nobody asked for.
    errorRef: { current: null as string | null },
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
        authService: {
            ...actual.authService, loginContext, resolveEmailDomain,
        },
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
                error: errorRef.current,
                clearError: () => { errorRef.current = null },
                isLoading: false,
                isAuthenticated: false, status: 'unauthenticated',
            }
            return selector ? selector(state) : state
        },
        {
            getState: () => ({
                error: null, lastSsoDenial: lastDenialRef.current,
            }),
        },
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
    lastDenialRef.current = null
    errorRef.current = null
    assign = vi.fn()
    Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...window.location, assign, search: '' },
    })
    loginContext.mockResolvedValue({
        allowLocalLogin: true, emailFirstLogin: false, providers: [GATEWAY],
    })
    resolveEmailDomain.mockResolvedValue({ provider: null })
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
        // Nothing ran before the exchange, so there is no token to
        // forward into it either.
        expect(runBrowserExchange.mock.calls[0][1]).toBeNull()
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
        runAuthenticateTrigger.mockResolvedValue('corp-handle')
        renderLogin()
        await waitFor(() => {
            expect(storeLoginWithBackchannel).toHaveBeenCalledWith(
                'corp-gateway', { assertion: 'assertion-jwt' },
            )
        })
        expect(runAuthenticateTrigger).toHaveBeenCalledTimes(1)
        expect(runAuthenticateTrigger.mock.invocationCallOrder[0])
            .toBeLessThan(runBrowserExchange.mock.invocationCallOrder[0])
        // The trigger's answer rides into the exchange — the forwarding
        // rows depend on exactly this hand-off.
        expect(runBrowserExchange).toHaveBeenCalledWith(
            expect.objectContaining({ slug: 'corp-gateway' }), 'corp-handle',
        )
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

    it('tries again once the cooldown lapses — a tab is not parked forever', async () => {
        // The old boolean sentinel meant the second corporate-session
        // expiry of the day left every long-lived tab sitting on the
        // form. The sentinel is a timestamp now.
        window.sessionStorage.setItem(
            'nx_portal_autologin_tried', String(Date.now() - 61_000),
        )
        renderLogin()
        await waitFor(() => expect(runAuthenticateTrigger).toHaveBeenCalledTimes(1))
    })

    it('stays quiet and explains while a silent recovery just failed', async () => {
        window.sessionStorage.setItem('nx_bc_reauth_failed', JSON.stringify({
            at: Date.now(), reason: 'The sign-in service answered 503.',
        }))
        renderLogin()
        expect(await screen.findByText(/could not be renewed automatically/i))
            .toBeInTheDocument()
        expect(await screen.findByText(/answered 503/i)).toBeInTheDocument()
        await new Promise(r => setTimeout(r, 20))
        expect(runAuthenticateTrigger).not.toHaveBeenCalled()
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

    it('does not fire when the connection says not to', async () => {
        // The operator's opt-out: autoSignIn: false is published only
        // when explicitly off. The button stays — the connection still
        // works, it just waits to be asked.
        loginContext.mockResolvedValue({
            allowLocalLogin: true, emailFirstLogin: false,
            providers: [{
                ...GATEWAY,
                config: { ...GATEWAY.config, autoSignIn: false },
            }],
        })
        renderLogin()
        expect(await screen.findByRole('button', {
            name: /corporate gateway/i,
        })).toBeInTheDocument()
        await new Promise((r) => setTimeout(r, 20))
        expect(runAuthenticateTrigger).not.toHaveBeenCalled()
    })

    it('a refused silent attempt explains itself outside the form', async () => {
        // The server said no (not a transport failure). The real store
        // writes its generic banner; the page must move that into an
        // attributed notice beside the retry, not leave an unexplained
        // red error over a form nobody touched.
        storeLoginWithBackchannel.mockImplementation(async () => {
            errorRef.current = 'Signing in with that session did not work.'
            return false
        })
        renderLogin()
        expect(await screen.findByText(
            /signing in with your corporate gateway session did not work/i,
        )).toBeInTheDocument()
        expect(screen.getByText(/try signing in again/i)).toBeInTheDocument()
        // The unattributed store banner was cleared, not left to stick.
        expect(errorRef.current).toBeNull()
        expect(
            screen.queryByText('Signing in with that session did not work.'),
        ).not.toBeInTheDocument()
        // And the ordinary form is still there.
        expect(screen.getByLabelText(/password/i)).toBeInTheDocument()
    })

    it('a failed recovery with nothing to press offers a retry', async () => {
        // Local login off, catalog empty (the connection was disabled or
        // the read failed): the old copy ended "Try again below." with
        // literally nothing below it.
        loginContext.mockResolvedValue({
            allowLocalLogin: false, emailFirstLogin: false, providers: [],
        })
        window.sessionStorage.setItem('nx_bc_reauth_failed', JSON.stringify({
            at: Date.now(), reason: 'Your session there has ended.',
        }))
        renderLogin()
        expect(await screen.findByText(/could not be renewed automatically/i))
            .toBeInTheDocument()
        expect(screen.queryByText(/try signing in again/i))
            .not.toBeInTheDocument()
        expect(
            await screen.findByRole('button', { name: /^retry$/i }),
        ).toBeInTheDocument()
    })
})

// ── email-first must not hide the only working door ──────────────────

describe('email-first with a gateway connection', () => {
    beforeEach(() => {
        loginContext.mockResolvedValue({
            allowLocalLogin: true, emailFirstLogin: true,
            providers: [GATEWAY],
        })
    })

    it('still offers the gateway button', async () => {
        // Its sign-in is a button on this very page — there is no
        // redirect for email-first to hide. After a failed silent
        // attempt this button is the recovery.
        window.sessionStorage.setItem(
            'nx_portal_autologin_tried', String(Date.now()),
        )
        renderLogin()
        expect(await screen.findByRole('button', {
            name: /corporate gateway/i,
        })).toBeInTheDocument()
        // Every provider is already visible, so there is nothing for
        // the disclosure to disclose.
        expect(screen.queryByText(/other ways to sign in/i))
            .not.toBeInTheDocument()
    })

    it('keeps redirect providers tucked away, with the disclosure', async () => {
        loginContext.mockResolvedValue({
            allowLocalLogin: true, emailFirstLogin: true,
            providers: [GATEWAY, OIDC],
        })
        window.sessionStorage.setItem(
            'nx_portal_autologin_tried', String(Date.now()),
        )
        renderLogin()
        expect(await screen.findByRole('button', {
            name: /corporate gateway/i,
        })).toBeInTheDocument()
        expect(screen.queryByText(/entra/i)).not.toBeInTheDocument()
        expect(screen.getByText(/other ways to sign in/i)).toBeInTheDocument()
    })

    it('a refused silent attempt leaves a button, not a dead page', async () => {
        // The reported incognito state: error text, no button, no
        // response. All three fixed at once.
        storeLoginWithBackchannel.mockImplementation(async () => {
            errorRef.current = 'Signing in with that session did not work.'
            return false
        })
        renderLogin()
        expect(await screen.findByText(
            /signing in with your corporate gateway session did not work/i,
        )).toBeInTheDocument()
        expect(await screen.findByRole('button', {
            name: /corporate gateway/i,
        })).toBeInTheDocument()
        expect(
            screen.queryByText('Signing in with that session did not work.'),
        ).not.toBeInTheDocument()
    })

    it('Enter runs the routed gateway sign-in instead of doing nothing', async () => {
        window.sessionStorage.setItem(
            'nx_portal_autologin_tried', String(Date.now()),
        )
        resolveEmailDomain.mockResolvedValue({ provider: GATEWAY })
        renderLogin()
        const emailInput = await screen.findByLabelText(/^email$/i)
        // {enter} submits before the 400 ms debounce has routed — the
        // handler resolves the address itself rather than swallowing
        // the keystroke.
        await userEvent.type(emailInput, 'ada@corp.example{enter}')
        await waitFor(() => {
            expect(storeLoginWithBackchannel).toHaveBeenCalled()
        })
        expect(navigate).not.toHaveBeenCalledWith(
            expect.stringContaining('login'), expect.anything(),
        )
    })

    it('a miss says so and reveals the ways in, instead of doing nothing', async () => {
        // The domain matches no connection (none configured, or a typo).
        // This used to be a silent return — with the password form and
        // the button row tucked behind disclosures, Enter did nothing
        // at all, which reads as a broken page.
        window.sessionStorage.setItem(
            'nx_portal_autologin_tried', String(Date.now()),
        )
        resolveEmailDomain.mockResolvedValue({ provider: null })
        renderLogin()
        const emailInput = await screen.findByLabelText(/^email$/i)
        await userEvent.type(emailInput, 'ada@personal.example{enter}')

        expect(await screen.findByText(
            /don't recognise that email's domain/i,
        )).toBeInTheDocument()
        // Every way in is on the table now: the password form opens…
        expect(await screen.findByLabelText(/password/i)).toBeInTheDocument()
        // …the gateway button stands, and nothing signed in silently.
        expect(screen.getByRole('button', { name: /corporate gateway/i }))
            .toBeInTheDocument()
        expect(storeLoginWithBackchannel).not.toHaveBeenCalled()
    })

    it('a failed resolve is a miss, not a crash', async () => {
        // The endpoint is rate-limited like /login; a 429 (or outage)
        // lands in the same spoken miss rather than a silent return.
        window.sessionStorage.setItem(
            'nx_portal_autologin_tried', String(Date.now()),
        )
        resolveEmailDomain.mockRejectedValue(new Error('429'))
        renderLogin()
        const emailInput = await screen.findByLabelText(/^email$/i)
        await userEvent.type(emailInput, 'ada@corp.example{enter}')

        expect(await screen.findByText(
            /don't recognise that email's domain/i,
        )).toBeInTheDocument()
        expect(storeLoginWithBackchannel).not.toHaveBeenCalled()
    })
})

// ── and when it is asked ─────────────────────────────────────────────

describe('the button', () => {
    beforeEach(() => {
        // Spend the silent attempt so the button is what is under test.
        window.sessionStorage.setItem(
            'nx_portal_autologin_tried', String(Date.now()),
        )
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
        window.sessionStorage.setItem(
            'nx_portal_autologin_tried', String(Date.now()),
        )
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

// ── the collision, explained ─────────────────────────────────────────

describe('a refused link', () => {
    beforeEach(() => {
        // Spend the silent attempt so the button is what is under test.
        window.sessionStorage.setItem(
            'nx_portal_autologin_tried', String(Date.now()),
        )
        storeLoginWithBackchannel.mockResolvedValue(false)
    })

    it('opens the collision modal with the rule the server named', async () => {
        lastDenialRef.current = {
            code: 'unsafe_auto_link', email: 'ada@corp.example',
            reasons: ['strict_existing_sso'],
        }
        renderLogin()
        await userEvent.click(
            await screen.findByRole('button', { name: /Corporate Gateway/i }),
        )

        expect(await screen.findByText(/already exists/i)).toBeInTheDocument()
        expect(screen.getByText(/already has another sign-in method linked/i))
            .toBeInTheDocument()
        // The modal carries the message alone — no competing banner.
        expect(screen.queryByText(/could not sign in with/i))
            .not.toBeInTheDocument()
        expect(navigate).not.toHaveBeenCalled()
    })

    it('points at the administrator when self-service cannot fix it', async () => {
        lastDenialRef.current = {
            code: 'unsafe_auto_link', email: 'ada@corp.example',
            reasons: ['existing_status:suspended'],
        }
        renderLogin()
        await userEvent.click(
            await screen.findByRole('button', { name: /Corporate Gateway/i }),
        )

        expect(await screen.findByText(/not active right now/i))
            .toBeInTheDocument()
        expect(screen.queryByRole('link', { name: /identities/i }))
            .not.toBeInTheDocument()
    })

    it('keeps the generic line for a refusal that is not a collision', async () => {
        lastDenialRef.current = { code: 'sso_disabled' }
        renderLogin()
        await userEvent.click(
            await screen.findByRole('button', { name: /Corporate Gateway/i }),
        )

        expect(await screen.findByText(/could not sign in with corporate gateway/i))
            .toBeInTheDocument()
        expect(screen.queryByText(/already exists/i)).not.toBeInTheDocument()
    })

    it('never opens the modal from the silent attempt', async () => {
        // Nobody asked; a modal about an account they did not try to use
        // is an ambush. The button tells them when they press it.
        window.sessionStorage.clear()
        lastDenialRef.current = {
            code: 'unsafe_auto_link', email: 'ada@corp.example', reasons: [],
        }
        renderLogin()
        await waitFor(() => expect(storeLoginWithBackchannel).toHaveBeenCalled())
        await new Promise((r) => setTimeout(r, 20))
        expect(screen.queryByText(/already exists/i)).not.toBeInTheDocument()
    })
})

// ── the email-first CTA ──────────────────────────────────────────────

describe('the routed CTA for a gateway provider', () => {
    it('is a button running the browser half, never a dead link', async () => {
        // The anchor the redirect kinds get navigates to
        // /auth/{slug}/login — a route a gateway provider cannot serve
        // without the browser's calls having run first.
        window.sessionStorage.setItem(
            'nx_portal_autologin_tried', String(Date.now()),
        )
        loginContext.mockResolvedValue({
            allowLocalLogin: true, emailFirstLogin: true,
            providers: [GATEWAY],
        })
        resolveEmailDomain.mockResolvedValue({ provider: GATEWAY })
        renderLogin()

        await userEvent.type(
            await screen.findByLabelText(/^email$/i), 'ada@corp.example',
        )
        const cta = await screen.findByText(/continue with corporate gateway/i)
        expect(cta.closest('a')).toBeNull()

        await userEvent.click(cta)
        await waitFor(() => {
            expect(storeLoginWithBackchannel)
                .toHaveBeenCalledWith('corp-gateway', {})
        })
        await waitFor(() => {
            expect(navigate).toHaveBeenCalledWith('/', { replace: true })
        })
    })
})
