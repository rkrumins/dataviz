/**
 * Landing on /login with a live session.
 *
 * The page used to resolve this for you: an effect bounced you straight
 * into the app. Combined with the silent refresh-on-401, even an EXPIRED
 * access cookie was quietly rotated and you were signed back in without
 * typing anything. Both behaviours made one ordinary thing impossible —
 * signing in as somebody else. A shared machine, a second tenant, an
 * admin account alongside a normal one: there was no way to get there.
 *
 * So /login now says what it found and lets the user choose.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginPage } from './LoginPage'

const { authState, logout, navigate, loginContext } = vi.hoisted(() => {
    const logout = vi.fn()
    return {
        logout,
        navigate: vi.fn(),
        loginContext: vi.fn(),
        authState: {
            login: vi.fn(),
            loginWithBrowserProfile: vi.fn(),
            logout,
            error: null,
            clearError: vi.fn(),
            isLoading: false,
            isAuthenticated: true,
            status: 'authenticated',
            user: { email: 'alice@example.com' },
        } as Record<string, unknown>,
    }
})

vi.mock('react-router-dom', async () => {
    const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
    return { ...actual, useNavigate: () => navigate }
})

vi.mock('@/services/authService', async () => {
    const actual = await vi.importActual<typeof import('@/services/authService')>(
        '@/services/authService',
    )
    return { ...actual, authService: { ...actual.authService, loginContext } }
})

vi.mock('@/store/auth', () => ({
    useAuthStore: Object.assign(
        (selector?: (s: unknown) => unknown) =>
            selector ? selector(authState) : authState,
        { getState: () => authState },
    ),
}))

vi.mock('@/store/branding', () => ({
    useBrand: () => ({ appName: 'Test', loginTagline: '', copyrightText: '' }),
}))
vi.mock('@/store/features', () => ({ useFeature: () => false }))
vi.mock('@/lib/useDocumentTitle', () => ({ useDocumentTitle: () => {} }))

function renderLogin() {
    return render(<MemoryRouter><LoginPage /></MemoryRouter>)
}

beforeEach(() => {
    vi.clearAllMocks()
    window.sessionStorage.clear()
    loginContext.mockResolvedValue({
        allowLocalLogin: true, emailFirstLogin: false, providers: [],
    })
    logout.mockResolvedValue(undefined)
    authState.isAuthenticated = true
    authState.status = 'authenticated'
    authState.user = { email: 'alice@example.com' }
})


describe('/login with a session that is still valid', () => {
    it('says who is signed in instead of bouncing them into the app', async () => {
        renderLogin()

        expect(
            await screen.findByText(/you're already signed in as alice@example.com/i),
        ).toBeInTheDocument()
        expect(navigate).not.toHaveBeenCalled()
    })

    it('continues into the app on request', async () => {
        const user = userEvent.setup()
        renderLogin()

        await user.click(await screen.findByRole('button', { name: /continue/i }))

        expect(navigate).toHaveBeenCalledWith('/', { replace: true })
    })

    it('drops the server session before offering the form to someone else', async () => {
        // The whole point of the second button: without the logout, the
        // next person would be typing their password on a page still
        // holding the previous user's cookies.
        const user = userEvent.setup()
        const { rerender } = renderLogin()

        await user.click(
            await screen.findByRole('button', { name: /sign in as someone else/i }),
        )
        await waitFor(() => expect(logout).toHaveBeenCalledTimes(1))

        authState.isAuthenticated = false
        authState.status = 'unauthenticated'
        authState.user = null
        rerender(<MemoryRouter><LoginPage /></MemoryRouter>)

        expect(await screen.findByLabelText(/^password$/i)).toBeInTheDocument()
        expect(navigate).not.toHaveBeenCalled()
    })

    it('shows the normal form when there is no session', async () => {
        authState.isAuthenticated = false
        authState.status = 'unauthenticated'
        authState.user = null
        renderLogin()

        expect(await screen.findByLabelText(/^password$/i)).toBeInTheDocument()
        expect(
            screen.queryByText(/you're already signed in/i),
        ).not.toBeInTheDocument()
    })
})
