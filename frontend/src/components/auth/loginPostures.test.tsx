/**
 * The login page's shape is a function of the platform posture.
 *
 * It used to be fixed — password form, divider, every provider as a
 * button — regardless of configuration. Two things were wrong with that.
 * An SSO-only deployment led with a control the server always refuses.
 * And email-first routing rendered *below* the password form it was meant
 * to replace, alongside the full button row, so it removed neither the
 * coin flip nor the IdP-topology disclosure that were its whole purpose.
 *
 * The bar for the default posture is byte-for-byte what it was: those
 * deployments must see no change at all.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginPage } from './LoginPage'

const { loginContext, resolveEmailDomain, navigate } = vi.hoisted(() => ({
    loginContext: vi.fn(),
    resolveEmailDomain: vi.fn(),
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
        authService: { ...actual.authService, loginContext, resolveEmailDomain },
    }
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

const ENTRA = {
    id: 'idp_1', slug: 'entra', displayName: 'Corporate Entra',
    kind: 'oidc', priority: 100,
}
const OKTA = {
    id: 'idp_2', slug: 'okta', displayName: 'Okta',
    kind: 'oidc', priority: 200,
}

function posture(over: Record<string, unknown> = {}) {
    loginContext.mockResolvedValue({
        allowLocalLogin: true,
        emailFirstLogin: false,
        providers: [],
        ...over,
    })
}

function renderLogin() {
    return render(<MemoryRouter><LoginPage /></MemoryRouter>)
}

const password = () => screen.queryByLabelText(/^password$/i)
const emailField = () => screen.queryByLabelText(/^email$/i)

beforeEach(() => {
    vi.clearAllMocks()
    window.sessionStorage.clear()
    resolveEmailDomain.mockResolvedValue({ provider: null })
})


// ── 1. The default: nothing changes ──────────────────────────────────

describe('local + SSO, email-first off', () => {
    it('is the page it has always been', async () => {
        posture({ providers: [ENTRA, OKTA] })
        renderLogin()

        await waitFor(() => expect(loginContext).toHaveBeenCalled())
        expect(emailField()).toBeInTheDocument()
        expect(password()).toBeInTheDocument()
        expect(screen.getByText(/enter workspace/i)).toBeInTheDocument()
        expect(screen.getByText(/or sign in with/i)).toBeInTheDocument()
        expect(await screen.findByText('Corporate Entra')).toBeInTheDocument()
        expect(screen.getByText('Okta')).toBeInTheDocument()
        expect(screen.getByText(/forgot your password/i)).toBeInTheDocument()
    })

    it('does not ask the server to route an email address', async () => {
        // The endpoint can only answer null when the feature is off, so
        // this fired on every login page in every deployment for nothing.
        const user = userEvent.setup()
        posture({ providers: [ENTRA] })
        renderLogin()

        await user.type(await screen.findByLabelText(/^email$/i), 'a@corp.example')
        await new Promise((r) => setTimeout(r, 600))
        expect(resolveEmailDomain).not.toHaveBeenCalled()
    })
})


// ── 2. SSO-only ──────────────────────────────────────────────────────

describe('SSO-only', () => {
    it('does not offer a password form the server would refuse', async () => {
        posture({ allowLocalLogin: false, providers: [ENTRA] })
        renderLogin()

        expect(await screen.findByText('Corporate Entra')).toBeInTheDocument()
        expect(password()).not.toBeInTheDocument()
        expect(screen.queryByText(/enter workspace/i)).not.toBeInTheDocument()
        expect(screen.queryByText(/forgot your password/i)).not.toBeInTheDocument()
    })

    it('drops the "or sign in with" divider when there is no alternative', async () => {
        // The buttons are the whole page; calling them an alternative to
        // something absent reads as a missing section.
        posture({ allowLocalLogin: false, providers: [ENTRA] })
        renderLogin()

        await screen.findByText('Corporate Entra')
        expect(screen.queryByText(/or sign in with/i)).not.toBeInTheDocument()
        expect(emailField()).not.toBeInTheDocument()
    })
})


// ── 3. Email-first ───────────────────────────────────────────────────

describe('email-first', () => {
    it('asks for an email and keeps the provider list out of sight', async () => {
        // The topology disclosure is the point: /login should not publish
        // which IdPs an org runs to anyone who loads it.
        posture({ emailFirstLogin: true, providers: [ENTRA, OKTA] })
        renderLogin()

        expect(await screen.findByLabelText(/^email$/i)).toBeInTheDocument()
        expect(password()).not.toBeInTheDocument()
        expect(screen.queryByText('Corporate Entra')).not.toBeInTheDocument()
        expect(screen.queryByText('Okta')).not.toBeInTheDocument()
    })

    it('routes a known domain to its provider', async () => {
        const user = userEvent.setup()
        posture({ emailFirstLogin: true, providers: [ENTRA, OKTA] })
        resolveEmailDomain.mockResolvedValue({ provider: ENTRA })
        renderLogin()

        await user.type(await screen.findByLabelText(/^email$/i), 'a@corp.example')

        const cta = await screen.findByText(/continue with corporate entra/i)
        expect(cta.closest('a')).toHaveAttribute(
            'href', '/api/v1/auth/entra/login?next=%2Fdashboard',
        )
    })

    it('lets a user fall back to a password', async () => {
        const user = userEvent.setup()
        posture({ emailFirstLogin: true, providers: [ENTRA] })
        renderLogin()

        await user.click(await screen.findByText(/use a password instead/i))
        expect(password()).toBeInTheDocument()
    })

    it('reveals the full provider list on request', async () => {
        // Nobody is stranded by a domain the operator forgot to map.
        const user = userEvent.setup()
        posture({ emailFirstLogin: true, providers: [ENTRA, OKTA] })
        renderLogin()

        await user.click(await screen.findByText(/other ways to sign in/i))
        expect(await screen.findByText('Corporate Entra')).toBeInTheDocument()
        expect(screen.getByText('Okta')).toBeInTheDocument()
    })

    it('offers no password escape when local login is off', async () => {
        // There would be nothing to escape to.
        posture({
            allowLocalLogin: false, emailFirstLogin: true, providers: [ENTRA],
        })
        renderLogin()

        await screen.findByLabelText(/^email$/i)
        expect(screen.queryByText(/use a password instead/i)).not.toBeInTheDocument()
    })
})


// ── 4. When the posture never arrives ────────────────────────────────

describe('unreachable login context', () => {
    it('falls back to a usable password form rather than an empty page', async () => {
        // Failing closed here locks everyone out of the product.
        loginContext.mockRejectedValue(new Error('boom'))
        renderLogin()

        expect(await screen.findByLabelText(/^password$/i)).toBeInTheDocument()
        expect(screen.getByText(/enter workspace/i)).toBeInTheDocument()
        expect(
            await screen.findByText(/couldn't load single sign-on options/i),
        ).toBeInTheDocument()
    })
})
