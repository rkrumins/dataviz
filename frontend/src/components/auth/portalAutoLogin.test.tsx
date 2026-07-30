/**
 * Silent portal sign-in on the login page.
 *
 * The risk this guards is a loop: the page auto-posts a stored profile,
 * the server rejects it, the page re-renders and posts again. The
 * sentinel is per-tab, so a rejection must leave the user on the normal
 * form with exactly one attempt spent.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginPage } from './LoginPage'
import { clearSignedOut, markSignedOut } from '@/store/signedOut'

const { listProviders, loginContext, loginWithBrowserProfile, navigate } = vi.hoisted(() => ({
    listProviders: vi.fn(),
    loginContext: vi.fn(),
    loginWithBrowserProfile: vi.fn(),
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
    return { ...actual, authService: { ...actual.authService, listProviders, loginContext } }
})

vi.mock('@/store/auth', () => ({
    useAuthStore: Object.assign(
        (selector?: (s: unknown) => unknown) => {
            const state = {
                login: vi.fn(),
                loginWithBrowserProfile,
                error: null,
                clearError: vi.fn(),
                isLoading: false,
                isAuthenticated: false,
                status: 'unauthenticated',
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

const PORTAL = {
    id: 'idp_1', slug: 'corp-portal', displayName: 'Corporate Portal',
    kind: 'custom_profile', priority: 100,
    config: { source: 'local_storage', sourceKey: 'corp.user' },
}

function renderLogin() {
    return render(<MemoryRouter><LoginPage /></MemoryRouter>)
}

describe('portal auto sign-in', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        window.localStorage.clear()
        window.sessionStorage.clear()
        listProviders.mockResolvedValue([PORTAL])
        // The page reads catalog + posture in one call now. Deriving the
        // context from ``listProviders`` keeps each test's existing
        // provider setup — and every assertion — exactly as it was.
        loginContext.mockImplementation(async () => ({
            allowLocalLogin: true,
            emailFirstLogin: false,
            providers: await listProviders(),
        }))
        loginWithBrowserProfile.mockResolvedValue(true)
    })

    afterEach(() => {
        window.localStorage.clear()
        window.sessionStorage.clear()
    })

    it('signs in automatically when the profile is already in storage', async () => {
        window.localStorage.setItem('corp.user', 'the-signed-payload')
        renderLogin()

        await waitFor(() => expect(loginWithBrowserProfile)
            .toHaveBeenCalledWith('corp-portal', 'the-signed-payload'))
        await waitFor(() => expect(navigate)
            .toHaveBeenCalledWith('/', { replace: true }))
    })

    it('does nothing when the storage key is absent', async () => {
        renderLogin()

        expect(await screen.findByText(/Continue with Corporate Portal/)).toBeInTheDocument()
        expect(loginWithBrowserProfile).not.toHaveBeenCalled()
    })

    it('attempts exactly once and does not loop after a rejection', async () => {
        window.localStorage.setItem('corp.user', 'a-rejected-payload')
        loginWithBrowserProfile.mockResolvedValue(false)

        const { unmount } = renderLogin()
        await waitFor(() => expect(loginWithBrowserProfile).toHaveBeenCalledTimes(1))
        expect(navigate).not.toHaveBeenCalled()

        // Re-mounting in the same tab (a bounce back to /login) must not
        // re-fire — that's the loop this guards against.
        unmount()
        renderLogin()
        await screen.findByText(/Continue with Corporate Portal/)
        expect(loginWithBrowserProfile).toHaveBeenCalledTimes(1)
    })

    it('refuses to sign in again after an explicit sign-out', async () => {
        // THE "IT LOGGED ME BACK IN WITHOUT CREDENTIALS" CASE. Server-side
        // revocation cannot stop this one: the payload is not a condemned
        // credential being replayed, it is a request for a brand-new
        // session. And the per-tab sentinel does not cover it either —
        // open a fresh tab and it is clear. Only the signed-out marker
        // makes "sign out" mean anything here.
        window.localStorage.setItem('corp.user', 'the-signed-payload')
        markSignedOut()

        renderLogin()

        expect(await screen.findByText(/Continue with Corporate Portal/)).toBeInTheDocument()
        expect(loginWithBrowserProfile).not.toHaveBeenCalled()
    })

    it('resumes auto sign-in once the user signs back in', async () => {
        // The marker has to lift, or one sign-out permanently disables the
        // portal convenience for that browser.
        window.localStorage.setItem('corp.user', 'the-signed-payload')
        markSignedOut()
        clearSignedOut()

        renderLogin()

        await waitFor(() => expect(loginWithBrowserProfile)
            .toHaveBeenCalledWith('corp-portal', 'the-signed-payload'))
    })

    it('stays out of the way when more than one portal provider exists', async () => {
        window.localStorage.setItem('corp.user', 'payload')
        listProviders.mockResolvedValue([
            PORTAL,
            { ...PORTAL, id: 'idp_2', slug: 'other-portal', displayName: 'Other Portal' },
        ])
        renderLogin()

        expect(await screen.findByText(/Continue with Other Portal/)).toBeInTheDocument()
        // Ambiguous which one the operator meant — let the user choose.
        expect(loginWithBrowserProfile).not.toHaveBeenCalled()
    })

    it('renders a redirect link, not a button, for a cookie-sourced provider', async () => {
        listProviders.mockResolvedValue([
            { ...PORTAL, config: { source: 'cookie' } },
        ])
        renderLogin()

        const el = await screen.findByText(/Continue with Corporate Portal/)
        expect(el.closest('a')).toHaveAttribute(
            'href', '/api/v1/auth/corp-portal/login?next=%2Fdashboard',
        )
        expect(loginWithBrowserProfile).not.toHaveBeenCalled()
    })

    it('explains a missing profile when the button is clicked', async () => {
        const user = userEvent.setup()
        renderLogin()

        await user.click(await screen.findByText(/Continue with Corporate Portal/))

        expect(await screen.findByText(/No Corporate Portal session found/))
            .toBeInTheDocument()
        expect(loginWithBrowserProfile).not.toHaveBeenCalled()
    })
})
