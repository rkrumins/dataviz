/**
 * Regression net for the bug that made every shareable invite link useless.
 *
 * `/signup` used to be wrapped in `<RequireFeature feature="signupEnabled">`.
 * That guard has no way to see `?invite=`, and it decided from the SEEDED flag
 * value — which is `false`, fail-closed — before `loadFeatures()` had resolved.
 * So an invited user was redirected to `/login` on first paint and their token
 * was discarded in the redirect.
 *
 * Worse, it was not merely a race: an invite-only deployment SERVES
 * `signupEnabled: false`, so the cached value is false too and the redirect is
 * deterministic. The backend has always allowed invited signup with the flag off
 * (auth.py validates the invite before consulting it) — the frontend simply
 * refused to let anyone reach the form.
 *
 * The three cases below are exactly the states that were wrong.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const navigateSpy = vi.fn()

vi.mock('react-router-dom', async () => {
    const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
    return { ...actual, useNavigate: () => navigateSpy }
})

vi.mock('@/services/authService', () => ({
    authService: {
        verifyInvite: vi.fn().mockResolvedValue({
            valid: true,
            role: 'workspace_viewer',
            workspaceName: 'Finance',
            groupNames: ['Engineering'],
            email: null,
        }),
        listProviders: vi.fn().mockResolvedValue([]),
    },
}))

import { MemoryRouter } from 'react-router-dom'
import { SignUpPage } from '../SignUpPage'
import { useFeaturesStore, DEFAULT_FEATURES } from '@/store/features'
import { useAuthStore } from '@/store/auth'
import { authService } from '@/services/authService'

function renderAt(path: string) {
    return render(
        <MemoryRouter initialEntries={[path]}>
            <SignUpPage />
        </MemoryRouter>,
    )
}

/** The store exactly as it is on a cold boot: seeds only, fetch not yet landed. */
function resetFeatures(over: Partial<{ loaded: boolean; signupEnabled: boolean }> = {}) {
    const { loaded = false, signupEnabled = false } = over
    useFeaturesStore.setState({
        values: { ...DEFAULT_FEATURES, signupEnabled },
        loaded,
    })
}

beforeEach(() => {
    navigateSpy.mockClear()
    // Re-establish implementations, not just call history: `mockClear`
    // leaves a previous test's `mockResolvedValue` in place, so a case
    // that returns an invalid invite would silently poison every test
    // declared after it.
    vi.mocked(authService.verifyInvite).mockReset().mockResolvedValue({
        valid: true,
        role: 'workspace_viewer',
        workspaceName: 'Finance',
        groupNames: ['Engineering'],
        email: null,
    })
    vi.mocked(authService.listProviders).mockReset().mockResolvedValue([])
    resetFeatures()
    useAuthStore.setState({ isAuthenticated: false, isLoading: false, error: null })
})

afterEach(() => {
    vi.clearAllMocks()
})

describe('SignUpPage — invite links reach the form', () => {
    it('renders the form for an invited user even when signup is off and flags have not loaded', async () => {
        // The headline case. This is an invite-only deployment (signupEnabled
        // false) and a first-time visitor (flags still in flight). Before the
        // fix this redirected to /login and dropped the token.
        renderAt('/signup?invite=tok_abc')

        expect(await screen.findByLabelText(/^email$/i)).toBeInTheDocument()
        expect(navigateSpy).not.toHaveBeenCalled()
    })

    it('still renders once the flags land confirming signup is off', async () => {
        renderAt('/signup?invite=tok_abc')
        await screen.findByLabelText(/^email$/i)

        resetFeatures({ loaded: true, signupEnabled: false })

        await waitFor(() => expect(navigateSpy).not.toHaveBeenCalled())
        expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument()
    })

    it('verifies the invite and shows the role, workspace and groups it grants', async () => {
        renderAt('/signup?invite=tok_abc')

        expect(await screen.findByText(/workspace_viewer/)).toBeInTheDocument()
        expect(screen.getByText('Finance')).toBeInTheDocument()
        expect(screen.getByText('Engineering')).toBeInTheDocument()
        expect(authService.verifyInvite).toHaveBeenCalledWith('tok_abc')
    })
})

describe('SignUpPage — a link that will not work', () => {
    const cases: [string, string][] = [
        ['revoked', /revoked/i.source],
        ['exhausted', /as many people as it allows/i.source],
        ['expired', /has expired/i.source],
        ['links_disabled', /turned off for this deployment/i.source],
    ]

    it.each(cases)('explains a %s link specifically', async (reason, expected) => {
        // "Invalid or expired" covered four situations with four different
        // remedies. Only one of them is "ask for a new one".
        vi.mocked(authService.verifyInvite).mockResolvedValue({
            valid: false, role: null, reason: reason as never,
        })
        renderAt('/signup?invite=tok_dead')

        expect(
            await screen.findByText(new RegExp(expected, 'i')),
        ).toBeInTheDocument()
    })

    it('does not offer a fallback signup the server would refuse', async () => {
        // With self-registration off, "you can still sign up" was a promise
        // the form could not keep — the POST 403s.
        vi.mocked(authService.verifyInvite).mockResolvedValue({
            valid: false, role: null, reason: 'revoked',
        })
        renderAt('/signup?invite=tok_dead')
        await screen.findByText(/revoked/i)

        expect(screen.queryByText(/you can still sign up/i)).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: /create account/i })).toBeDisabled()
    })

    it('does offer the fallback when self-registration is on', async () => {
        resetFeatures({ loaded: true, signupEnabled: true })
        vi.mocked(authService.verifyInvite).mockResolvedValue({
            valid: false, role: null, reason: 'expired',
        })
        renderAt('/signup?invite=tok_dead')

        expect(await screen.findByText(/you can still sign up/i)).toBeInTheDocument()
    })
})

describe('SignUpPage — accepting an invite with SSO', () => {
    const OKTA = {
        id: 'idp_1', slug: 'okta', displayName: 'Okta',
        kind: 'oidc', priority: 0, buttonLabel: null, buttonIcon: null,
    }

    it('offers the identity provider, carrying the invite through the handshake', async () => {
        // Without this an invitee at an SSO org is asked to invent a
        // password that local login then refuses.
        vi.mocked(authService.listProviders).mockResolvedValue([OKTA])
        renderAt('/signup?invite=tok_abc')

        const link = await screen.findByRole('link', { name: /continue with okta/i })
        expect(link).toHaveAttribute(
            'href',
            '/api/v1/auth/okta/login?next=' +
            encodeURIComponent('/invite/accept?invite=tok_abc'),
        )
        // The password form stays available — SSO is offered, not forced.
        expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument()
    })

    it('does not offer SSO to someone without an invite', async () => {
        // A stranger on an open signup page has no business being handed
        // the company IdP.
        vi.mocked(authService.listProviders).mockResolvedValue([OKTA])
        resetFeatures({ loaded: true, signupEnabled: true })
        renderAt('/signup')

        await screen.findByLabelText(/^email$/i)
        expect(screen.queryByRole('link', { name: /continue with/i })).not.toBeInTheDocument()
        expect(authService.listProviders).not.toHaveBeenCalled()
    })

    it('does not offer SSO for a dead invite', async () => {
        vi.mocked(authService.listProviders).mockResolvedValue([OKTA])
        vi.mocked(authService.verifyInvite).mockResolvedValue({
            valid: false, role: null, reason: 'revoked',
        })
        renderAt('/signup?invite=tok_dead')

        await screen.findByText(/revoked/i)
        expect(screen.queryByRole('link', { name: /continue with/i })).not.toBeInTheDocument()
    })

    it('renders the password form normally when no provider is configured', async () => {
        renderAt('/signup?invite=tok_abc')

        expect(await screen.findByLabelText(/^email$/i)).toBeInTheDocument()
        expect(screen.queryByText(/or use a password/i)).not.toBeInTheDocument()
    })
})

describe('/signup route wiring', () => {
    // The tests above render SignUpPage directly, so they would keep passing if
    // someone re-wrapped the ROUTE in a feature gate — which is precisely where
    // the original bug lived. This one renders whatever routes.tsx actually
    // declares for /signup, so the wiring itself is covered.
    it('renders the signup element without a feature gate in front of it', async () => {
        const { router } = await import('@/routes')
        const signupRoute = router.routes.find((r) => r.path === '/signup')

        expect(signupRoute).toBeDefined()

        render(
            <MemoryRouter initialEntries={['/signup?invite=tok_abc']}>
                {signupRoute!.element}
            </MemoryRouter>,
        )

        // Invite-only deployment, cold cache: the form must appear.
        expect(await screen.findByLabelText(/^email$/i)).toBeInTheDocument()
        expect(navigateSpy).not.toHaveBeenCalled()
    })
})

describe('SignUpPage — uninvited visitors', () => {
    it('does NOT redirect while the flags are still loading', async () => {
        // The seeded `false` is a guess, not an answer. Acting on it is what
        // made the invited case fail; it is equally wrong here.
        renderAt('/signup')

        await waitFor(() => expect(navigateSpy).not.toHaveBeenCalled())
        expect(screen.queryByLabelText(/^email$/i)).not.toBeInTheDocument()
    })

    it('redirects to /login once the flags confirm self-registration is off', async () => {
        resetFeatures({ loaded: true, signupEnabled: false })
        renderAt('/signup')

        await waitFor(() =>
            expect(navigateSpy).toHaveBeenCalledWith('/login', { replace: true }),
        )
    })

    it('renders the form when self-registration is on', async () => {
        resetFeatures({ loaded: true, signupEnabled: true })
        renderAt('/signup')

        expect(await screen.findByLabelText(/^email$/i)).toBeInTheDocument()
        expect(navigateSpy).not.toHaveBeenCalled()
    })
})
