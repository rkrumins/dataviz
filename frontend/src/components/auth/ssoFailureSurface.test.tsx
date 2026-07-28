/**
 * What the user sees when SSO doesn't work.
 *
 * The backend mints a reference for every SSO failure, audits it, and puts
 * it in the redirect. None of that is worth anything if the page the user
 * lands on doesn't show it — they can't quote a reference they were never
 * given, and the admin's Activity search has nothing to search for. Same
 * shape of bug for the provider catalog: a failed fetch used to render
 * exactly like a successful empty one.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginPage } from './LoginPage'

const { listProviders, loginContext, navigate } = vi.hoisted(() => ({
    listProviders: vi.fn(),
    loginContext: vi.fn(),
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
                loginWithBrowserProfile: vi.fn(),
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

function renderAt(search: string) {
    return render(
        <MemoryRouter initialEntries={[`/login${search}`]}>
            <LoginPage />
        </MemoryRouter>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    listProviders.mockResolvedValue([])
    // The page reads catalog + posture in one call now. Deriving the
    // context from ``listProviders`` keeps each test's existing
    // provider setup — and every assertion — exactly as it was.
    loginContext.mockImplementation(async () => ({
        allowLocalLogin: true,
        emailFirstLogin: false,
        providers: await listProviders(),
    }))
})


// ── The failure reference ────────────────────────────────────────────

describe('SSO failure banner', () => {
    it('shows the reference the user was given in the URL', async () => {
        renderAt('?sso_error=1&ref=abc12345')

        expect(await screen.findByRole('alert')).toBeInTheDocument()
        expect(screen.getByText('abc12345')).toBeInTheDocument()
        expect(screen.getByText(/quote this reference/i)).toBeInTheDocument()
    })

    it('never shows the reason — that is admin-only by construction', async () => {
        // The redirect deliberately carries no reason; if one ever starts
        // leaking into the query string this asserts we don't render it.
        renderAt('?sso_error=1&ref=abc12345&reason=state_mismatch')

        await screen.findByRole('alert')
        expect(screen.queryByText(/state_mismatch/)).not.toBeInTheDocument()
    })

    it('still explains the failure when there is no reference', async () => {
        renderAt('?sso_error=1')

        expect(await screen.findByRole('alert')).toBeInTheDocument()
        expect(screen.queryByText(/quote this reference/i)).not.toBeInTheDocument()
    })

    it('can be dismissed', async () => {
        const user = userEvent.setup()
        renderAt('?sso_error=1&ref=abc12345')

        await user.click(await screen.findByRole('button', { name: /dismiss/i }))
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('stays out of the way of the collision modal', async () => {
        // The collision case has its own modal with a specific recovery
        // path. Two overlapping explanations of the same failure is worse
        // than one.
        renderAt('?sso_error=1&error_code=unsafe_auto_link&email=a%40corp.example')

        expect(await screen.findByText(/already exists/i)).toBeInTheDocument()
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('is absent on a normal visit', async () => {
        renderAt('')

        await waitFor(() => expect(listProviders).toHaveBeenCalled())
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
})


// ── The collision modal's recovery path ──────────────────────────────

describe('collision modal', () => {
    it('links somewhere that actually exists', async () => {
        // It used to tell the user to open "Account → Identities", a menu
        // path with no door. The recovery path for the most common SSO
        // failure has to be reachable.
        renderAt('?error_code=unsafe_auto_link&email=a%40corp.example')

        const link = await screen.findByRole('link', { name: /identities/i })
        expect(link).toHaveAttribute('href', '/me/identities')
    })
})


// ── The provider catalog ─────────────────────────────────────────────

describe('provider catalog', () => {
    it('says so when it could not be loaded', async () => {
        // Silence here is an unrecoverable dead end on an SSO-only
        // deployment: the buttons are the only way in.
        listProviders.mockRejectedValue(new Error('boom'))
        renderAt('')

        expect(
            await screen.findByText(/couldn't load single sign-on options/i),
        ).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
    })

    it('renders nothing extra when there are simply no providers', async () => {
        listProviders.mockResolvedValue([])
        renderAt('')

        await waitFor(() => expect(listProviders).toHaveBeenCalled())
        expect(
            screen.queryByText(/couldn't load single sign-on options/i),
        ).not.toBeInTheDocument()
    })
})
