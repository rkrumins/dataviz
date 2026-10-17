/**
 * The login page's shape is a function of the platform posture.
 *
 * Wherever a connection exists the page is SSO-first: the primary
 * connection is the main button, the address is the other way in, and
 * the password sits behind a step of its own. That last part is the
 * point. With a password field on the first step, Enter after an address
 * tripped the browser's `required` prompt — a password demanded of
 * someone whose address would have worked through single sign-on — and
 * under email-first an unmapped domain was an error. Now Enter always
 * leads somewhere: the domain's connection, else the primary.
 *
 * The password stays a deliberate fallback, offered to whoever the server
 * would accept it from: everyone, administrators during an outage, or
 * break-glass accounts. A deployment with no connections keeps the
 * single-step form, unchanged.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginPage } from './LoginPage'

const { loginContext, resolveEmailDomain, navigate, login } = vi.hoisted(() => ({
    loginContext: vi.fn(),
    resolveEmailDomain: vi.fn(),
    navigate: vi.fn(),
    login: vi.fn(),
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
                login,
                loginWithBrowserProfile: vi.fn(),
                loginWithBackchannel: vi.fn(),
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
    kind: 'saml2', priority: 200,
}
/** A portal whose credential lives in browser storage: a button can read
 *  it, but an address that matched nothing cannot be routed there. */
const PORTAL = {
    id: 'idp_3', slug: 'corp-portal', displayName: 'Corporate Portal',
    kind: 'custom_profile', priority: 100,
    config: { source: 'local_storage', sourceKey: 'corp.user' },
}
const OUTAGE = { since: '2026-10-13T09:00:00Z', providers: ['entra'] }

function posture(over: Record<string, unknown> = {}) {
    loginContext.mockResolvedValue({
        allowLocalLogin: true,
        emailFirstLogin: false,
        providers: [],
        passwordAccess: 'everyone',
        ssoOutage: null,
        passwordFallbackUntil: null,
        ...over,
    })
}

function renderLogin(url = '/login') {
    return render(
        <MemoryRouter initialEntries={[url]}><LoginPage /></MemoryRouter>,
    )
}

const password = () => screen.queryByLabelText(/^password$/i)
const emailField = () => screen.queryByLabelText(/^email$/i)
const failAround = () => screen.queryByRole('button', {
    name: /sign in with email and password/i,
})
const notRecognised = () => screen.queryByText(/recognise/i)
/** The first step's filled primary. The password step lists the same
 *  connection under "or", unfilled — so the fill is what tells them apart. */
const heroLink = () => screen.getAllByRole('link', { name: 'Continue with Corporate Entra' })
    .find((a) => /(^|\s)bg-accent-lineage(\s|$)/.test(a.className))

let assign: ReturnType<typeof vi.fn>
const realLocation = window.location

beforeEach(() => {
    vi.clearAllMocks()
    window.sessionStorage.clear()
    resolveEmailDomain.mockResolvedValue({ provider: null })
    login.mockResolvedValue(true)
    assign = vi.fn()
    Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...realLocation, assign },
    })
})

afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation })
})


// ── 1. SSO-first ─────────────────────────────────────────────────────

describe('SSO-first, wherever a connection exists', () => {
    it('leads with the primary connection as the main action', async () => {
        posture({ providers: [ENTRA, OKTA] })
        renderLogin()

        const hero = await screen.findByRole('link', { name: 'Continue with Corporate Entra' })
        expect(hero).toHaveAttribute('href', '/api/v1/auth/entra/login?next=%2Fdashboard')
        expect(hero.className).toMatch(/bg-accent-lineage/)
        // The other connections follow it, as the ordinary buttons.
        const okta = screen.getByRole('link', { name: 'Continue with Okta' })
        expect(okta.className).not.toMatch(/bg-accent-lineage/)
        expect(hero.compareDocumentPosition(okta) & Node.DOCUMENT_POSITION_FOLLOWING)
            .toBeTruthy()
        // Then the address, as the other way in.
        expect(screen.getByText(/or continue with email/i)).toBeInTheDocument()
        expect(emailField()).toHaveAttribute('autocomplete', 'username')
        expect(screen.getByRole('button', { name: /^continue$/i }))
            .toHaveAttribute('type', 'submit')
    })

    it('asks for no password on the first step', async () => {
        // The field whose `required` stopped Enter from going anywhere.
        posture({ providers: [ENTRA] })
        renderLogin()

        await screen.findByRole('link', { name: /continue with corporate entra/i })
        expect(password()).not.toBeInTheDocument()
        expect(screen.queryByText(/enter workspace/i)).not.toBeInTheDocument()
        expect(screen.queryByText(/forgot your password/i)).not.toBeInTheDocument()
    })

    it('Enter goes to the connection the address maps to', async () => {
        const user = userEvent.setup()
        posture({ providers: [ENTRA, OKTA] })
        resolveEmailDomain.mockResolvedValue({ provider: OKTA })
        renderLogin()

        await user.type(await screen.findByLabelText(/^email$/i), 'ada@okta.example{enter}')

        await waitFor(() => expect(assign)
            .toHaveBeenCalledWith('/api/v1/auth/okta/login?next=%2Fdashboard'))
        expect(await screen.findByText('Taking you to Okta…')).toHaveAttribute('role', 'status')
    })

    it('Enter goes to the primary when the address maps to nothing — never an error', async () => {
        const user = userEvent.setup()
        posture({ providers: [ENTRA, OKTA] })
        renderLogin()

        await user.type(await screen.findByLabelText(/^email$/i), 'ada@personal.example{enter}')

        await waitFor(() => expect(assign)
            .toHaveBeenCalledWith('/api/v1/auth/entra/login?next=%2Fdashboard'))
        expect(notRecognised()).not.toBeInTheDocument()
    })

    it('a failed lookup is a miss: Enter still goes to the primary', async () => {
        // The endpoint is rate-limited like /login.
        const user = userEvent.setup()
        posture({ providers: [ENTRA] })
        resolveEmailDomain.mockRejectedValue(new Error('429'))
        renderLogin()

        await user.type(await screen.findByLabelText(/^email$/i), 'ada@corp.example{enter}')

        await waitFor(() => expect(assign)
            .toHaveBeenCalledWith('/api/v1/auth/entra/login?next=%2Fdashboard'))
    })

    it('says where the address goes before Enter is pressed', async () => {
        // Answered whenever SSO is on now, not only under email-first.
        const user = userEvent.setup()
        posture({ providers: [ENTRA, OKTA] })
        resolveEmailDomain.mockResolvedValue({ provider: OKTA })
        renderLogin()

        await user.type(await screen.findByLabelText(/^email$/i), 'ada@okta.example')

        const cta = await screen.findByRole('button', { name: 'Continue with Okta' })
        expect(cta).toHaveAttribute('type', 'submit')
        expect(resolveEmailDomain).toHaveBeenCalledWith('ada@okta.example')
        expect(assign).not.toHaveBeenCalled()
    })
})


// ── 2. The password step ─────────────────────────────────────────────

describe('the password step', () => {
    async function toPasswordStep(typed = 'ada@corp.example') {
        const user = userEvent.setup()
        posture({ providers: [ENTRA, OKTA] })
        const view = renderLogin()
        if (typed) await user.type(await screen.findByLabelText(/^email$/i), typed)
        await user.click(await screen.findByRole('button', {
            name: /sign in with email and password/i,
        }))
        return { user, ...view }
    }

    it('is one click away, and carries the address over', async () => {
        const { container } = await toPasswordStep()

        const field = await screen.findByLabelText(/^password$/i)
        expect(field).toHaveAttribute('autocomplete', 'current-password')
        await waitFor(() => expect(field).toHaveFocus())
        // The address, settled, with the way to change it…
        expect(screen.getByText('ada@corp.example')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /change email/i })).toBeInTheDocument()
        expect(emailField()).not.toBeInTheDocument()
        // …and still there for a password manager to pair with.
        const username = container.querySelector('input[autocomplete="username"]')
        expect(username).toHaveValue('ada@corp.example')
        expect(username).toHaveAttribute('readonly')
        expect(screen.getByRole('button', { name: /enter workspace/i })).toBeInTheDocument()
        expect(screen.getByText(/forgot your password/i)).toBeInTheDocument()
        // Single sign-on is still on offer, under "or".
        expect(screen.getByText(/^or$/i)).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Continue with Corporate Entra' }))
            .toBeInTheDocument()
    })

    it('signs in with the address and the password', async () => {
        const { user } = await toPasswordStep()

        await user.type(await screen.findByLabelText(/^password$/i), 'hunter2{enter}')

        await waitFor(() => expect(login).toHaveBeenCalledWith('ada@corp.example', 'hunter2'))
        await waitFor(() => expect(navigate).toHaveBeenCalledWith('/', { replace: true }))
    })

    it('Change goes back to the first step, the address kept', async () => {
        const { user } = await toPasswordStep()

        await user.click(await screen.findByRole('button', { name: /change email/i }))

        const field = await screen.findByLabelText(/^email$/i)
        expect(field).toHaveValue('ada@corp.example')
        await waitFor(() => expect(field).toHaveFocus())
        expect(password()).not.toBeInTheDocument()
    })

    it('Back does too', async () => {
        const { user } = await toPasswordStep()

        await user.click(await screen.findByRole('button', { name: /^back$/i }))

        await waitFor(() => expect(password()).not.toBeInTheDocument())
        expect(heroLink()).toBeInTheDocument()
    })

    it('asks for the address there when none was typed', async () => {
        await toPasswordStep('')

        expect(await screen.findByLabelText(/^password$/i)).toBeInTheDocument()
        const field = screen.getByLabelText(/^email$/i)
        await waitFor(() => expect(field).toHaveFocus())
        expect(screen.queryByRole('button', { name: /change email/i })).not.toBeInTheDocument()
    })
})


// ── 3. Who the password is for ───────────────────────────────────────

describe('who the password is for', () => {
    it.each([
        ['break-glass accounts', { allowLocalLogin: false, passwordAccess: 'break_glass' }],
        ['administrators, during an outage',
            { allowLocalLogin: false, passwordAccess: 'administrators', ssoOutage: OUTAGE }],
    ])('offers no way around single sign-on when it is for %s', async (_, over) => {
        // The server would refuse everyone else; a link to a form that
        // cannot work is a dead control.
        posture({ providers: [ENTRA], ...over })
        renderLogin()

        await screen.findByRole('link', { name: /continue with corporate entra/i })
        expect(failAround()).not.toBeInTheDocument()
        expect(screen.queryByText(/forgot your password/i)).not.toBeInTheDocument()
    })

    it('reads an older server\'s "passwords off" as break-glass only', async () => {
        loginContext.mockResolvedValue({
            allowLocalLogin: false, emailFirstLogin: false, providers: [ENTRA],
        })
        renderLogin()

        await screen.findByRole('link', { name: /continue with corporate entra/i })
        expect(failAround()).not.toBeInTheDocument()
    })

    it('reads an older server with passwords on as everyone', async () => {
        loginContext.mockResolvedValue({
            allowLocalLogin: true, emailFirstLogin: false, providers: [ENTRA],
        })
        renderLogin()

        expect(await screen.findByRole('button', {
            name: /sign in with email and password/i,
        })).toBeInTheDocument()
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })
})


// ── 4. An identity-provider outage ───────────────────────────────────

describe('an identity-provider outage', () => {
    it('tells administrators they can still get in, and gives them the door', async () => {
        const user = userEvent.setup()
        posture({
            allowLocalLogin: false, passwordAccess: 'administrators',
            providers: [ENTRA, OKTA], ssoOutage: OUTAGE,
        })
        renderLogin()

        expect(await screen.findByText(/we can't reach corporate entra right now/i))
            .toBeInTheDocument()
        expect(screen.getByText(
            /administrators can sign in with their password while it's restored/i,
        )).toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: /administrator sign-in/i }))

        expect(await screen.findByLabelText(/^password$/i)).toBeInTheDocument()
        expect(screen.getByText(/limited to administrators/i)).toBeInTheDocument()
        // Nothing to offer once it is open.
        expect(screen.queryByRole('button', { name: /administrator sign-in/i }))
            .not.toBeInTheDocument()
    })

    it('leads with the password when everyone may use one', async () => {
        const user = userEvent.setup()
        posture({ providers: [ENTRA], ssoOutage: OUTAGE })
        renderLogin()

        expect(await screen.findByLabelText(/^password$/i)).toBeInTheDocument()
        expect(screen.getByText(/sign in with your password instead/i)).toBeInTheDocument()
        // No address was typed, so the step asks for one, first.
        await waitFor(() => expect(screen.getByLabelText(/^email$/i)).toHaveFocus())
        // Single sign-on is a step back, not gone.
        await user.click(screen.getByRole('button', { name: /^back$/i }))
        await waitFor(() => expect(password()).not.toBeInTheDocument())
        expect(heroLink()).toBeInTheDocument()
    })

    it('names every connection that is down', async () => {
        posture({
            allowLocalLogin: false, passwordAccess: 'administrators',
            providers: [ENTRA, OKTA],
            ssoOutage: { ...OUTAGE, providers: ['entra', 'okta'] },
        })
        renderLogin()

        expect(await screen.findByText(
            /we can't reach corporate entra and okta right now/i,
        )).toBeInTheDocument()
    })
})


// ── 5. The emergency window ──────────────────────────────────────────

describe('the emergency password window', () => {
    it('says until when, in local time, and offers the password', async () => {
        const user = userEvent.setup()
        // The server's own shape: an aware isoformat(), microseconds and all.
        const until = '2026-10-13T16:30:00.123456+00:00'
        posture({ providers: [ENTRA], passwordFallbackUntil: until })
        renderLogin()

        const closes = new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        expect(await screen.findByText(`Password sign-in is open until ${closes}.`))
            .toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: /use your password/i }))
        expect(await screen.findByLabelText(/^password$/i)).toBeInTheDocument()
    })
})


// ── 6. Break-glass ───────────────────────────────────────────────────

describe('break-glass: ?password=1', () => {
    it('opens the password step, and says who it is for', async () => {
        // The server still refuses every account not marked as a system
        // account, so opening the step grants nothing.
        posture({ allowLocalLogin: false, passwordAccess: 'break_glass', providers: [ENTRA] })
        renderLogin('/login?password=1')

        expect(await screen.findByLabelText(/^password$/i)).toBeInTheDocument()
        expect(screen.getByText(/enter workspace/i)).toBeInTheDocument()
        expect(screen.getByText(/reserved for break-glass accounts/i)).toBeInTheDocument()
    })

    it('is not advertised anywhere without it', async () => {
        posture({ allowLocalLogin: false, passwordAccess: 'break_glass', providers: [ENTRA] })
        renderLogin()

        await screen.findByRole('link', { name: /continue with corporate entra/i })
        expect(password()).not.toBeInTheDocument()
        expect(failAround()).not.toBeInTheDocument()
        expect(screen.queryByText(/break-glass/i)).not.toBeInTheDocument()
    })
})


// ── 7. Email-first ───────────────────────────────────────────────────

describe('email-first', () => {
    it('leads with the address and keeps the provider list out of sight', async () => {
        // The topology disclosure is the point: /login should not publish
        // which IdPs an org runs to anyone who loads it.
        posture({ emailFirstLogin: true, providers: [ENTRA, OKTA] })
        renderLogin()

        const cta = await screen.findByRole('button', { name: /^continue$/i })
        // The main action now, so it is the filled one.
        expect(cta.className).toMatch(/bg-accent-lineage/)
        expect(emailField()).toBeInTheDocument()
        expect(password()).not.toBeInTheDocument()
        expect(screen.queryByText(/continue with corporate entra/i)).not.toBeInTheDocument()
        expect(screen.queryByText(/continue with okta/i)).not.toBeInTheDocument()
    })

    it('reveals the full provider list on request', async () => {
        const user = userEvent.setup()
        posture({ emailFirstLogin: true, providers: [ENTRA, OKTA] })
        renderLogin()

        await user.click(await screen.findByText(/other ways to sign in/i))
        expect(await screen.findByText(/continue with corporate entra/i)).toBeInTheDocument()
        expect(screen.getByText(/continue with okta/i)).toBeInTheDocument()
    })

    it('routes an unmapped address to the primary too', async () => {
        const user = userEvent.setup()
        posture({ emailFirstLogin: true, providers: [ENTRA, OKTA] })
        renderLogin()

        await user.type(await screen.findByLabelText(/^email$/i), 'ada@personal.example{enter}')

        await waitFor(() => expect(assign)
            .toHaveBeenCalledWith('/api/v1/auth/entra/login?next=%2Fdashboard'))
        expect(notRecognised()).not.toBeInTheDocument()
    })
})


// ── 8. Nothing routable ──────────────────────────────────────────────

describe('when no connection can be routed to', () => {
    it('Enter opens the password step when everyone may use one', async () => {
        const user = userEvent.setup()
        posture({ providers: [PORTAL] })
        window.sessionStorage.setItem('nx_portal_autologin_tried', String(Date.now()))
        renderLogin()

        await user.type(await screen.findByLabelText(/^email$/i), 'ada@corp.example{enter}')

        expect(await screen.findByLabelText(/^password$/i)).toBeInTheDocument()
        expect(screen.getByText('ada@corp.example')).toBeInTheDocument()
        expect(assign).not.toHaveBeenCalled()
    })

    it('otherwise lays out the ways in, neutrally — never an error', async () => {
        const user = userEvent.setup()
        posture({
            allowLocalLogin: false, passwordAccess: 'break_glass',
            emailFirstLogin: true, providers: [PORTAL],
        })
        window.sessionStorage.setItem('nx_portal_autologin_tried', String(Date.now()))
        renderLogin()

        await user.type(await screen.findByLabelText(/^email$/i), 'ada@corp.example{enter}')

        expect(await screen.findByText('Choose how you sign in')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /continue with corporate portal/i }))
            .toBeInTheDocument()
        expect(notRecognised()).not.toBeInTheDocument()
        expect(password()).not.toBeInTheDocument()
        expect(assign).not.toHaveBeenCalled()
    })
})


// ── 9. No connections ────────────────────────────────────────────────

describe('a deployment with no connections', () => {
    it('keeps the single-step form it has always had', async () => {
        posture({ providers: [] })
        renderLogin()

        expect(await screen.findByLabelText(/^password$/i)).toBeInTheDocument()
        expect(emailField()).toBeInTheDocument()
        expect(screen.getByText(/enter workspace/i)).toBeInTheDocument()
        expect(screen.getByText(/forgot your password/i)).toBeInTheDocument()
        expect(screen.queryByText(/or continue with email/i)).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /^continue$/i })).not.toBeInTheDocument()
    })

    it('does not ask the server to route an address', async () => {
        // There is nothing it could route to.
        const user = userEvent.setup()
        posture({ providers: [] })
        renderLogin()

        await user.type(await screen.findByLabelText(/^email$/i), 'a@corp.example')
        await new Promise((r) => setTimeout(r, 600))
        expect(resolveEmailDomain).not.toHaveBeenCalled()
    })
})


// ── 10. When the posture never arrives ───────────────────────────────

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
