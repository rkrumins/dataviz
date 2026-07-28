/**
 * The account page's three load-bearing behaviours.
 *
 * 1. An SSO-only account is told why there is no password form, rather
 *    than being shown one the server would 409.
 * 2. A rename sends trimmed values and pushes the result into the auth
 *    store, which is what updates the TopBar without a reload.
 * 3. A rejected password change shows the reason and keeps what the
 *    user typed — retyping three fields because the current password
 *    had a typo is the worst possible response to a typo.
 *
 * zxcvbn is stubbed: the real dictionaries are lazily imported and
 * would make this slow and timing-dependent. The scoring itself is the
 * same code the two shipping auth pages already run.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const navigateSpy = vi.fn()

vi.mock('react-router-dom', async () => {
    const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
    return { ...actual, useNavigate: () => navigateSpy, Link: actual.Link }
})

vi.mock('@/lib/passwordStrength', () => ({
    STRENGTH_COLORS: ['a', 'b', 'c', 'd', 'e'],
    STRENGTH_LABELS: ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'],
    MIN_STRENGTH_SCORE: 3,
    usePasswordStrength: () => ({ score: 4, feedback: '' }),
}))

vi.mock('@/services/accountService', () => ({
    accountService: {
        getProfile: vi.fn(),
        updateProfile: vi.fn(),
        changePassword: vi.fn(),
        revokeAllSessions: vi.fn(),
        listActivity: vi.fn(),
    },
}))

vi.mock('@/services/authService', () => ({
    authService: { listMyIdentities: vi.fn() },
}))

const showToast = vi.fn()
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ showToast }) }))

const applyProfile = vi.fn()
vi.mock('@/store/auth', () => ({
    useAuthStore: (sel: (s: unknown) => unknown) => sel({
        user: {
            id: 'usr_1', email: 'alice@example.com',
            firstName: 'Alice', lastName: 'Doe',
            role: 'user', status: 'active', authProvider: 'local',
            createdAt: '', updatedAt: '', avatarId: null,
        },
        applyProfile,
    }),
}))

vi.mock('@/store/preferences', () => {
    const store = (sel: (s: unknown) => unknown) => sel({ avatarId: null })
    store.getState = () => ({ avatarId: null })
    return { usePreferencesStore: store }
})

import { MemoryRouter } from 'react-router-dom'
import { accountService } from '@/services/accountService'
import { authService } from '@/services/authService'
import { AccountSettingsPage } from '../AccountSettingsPage'

const PROFILE = {
    id: 'usr_1', email: 'alice@example.com',
    firstName: 'Alice', lastName: 'Doe', displayName: 'Alice Doe',
    status: 'active', role: 'user', createdAt: '', avatarId: null,
    mustChangePassword: false,
}

function renderPage() {
    return render(
        <MemoryRouter>
            <AccountSettingsPage />
        </MemoryRouter>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(accountService.getProfile).mockResolvedValue(PROFILE)
    vi.mocked(accountService.listActivity).mockResolvedValue([])
    vi.mocked(authService.listMyIdentities).mockResolvedValue({
        passwordSet: true, identities: [],
    })
})

describe('AccountSettingsPage', () => {
    it('explains itself instead of offering a form an SSO-only account cannot use', async () => {
        vi.mocked(authService.listMyIdentities).mockResolvedValue({
            passwordSet: false,
            identities: [{
                id: 'idn_1',
                provider: { id: 'p1', slug: 'okta', displayName: 'Okta', kind: 'oidc' },
                externalId: 'x', createdAt: '',
            }],
        })

        renderPage()

        expect(await screen.findByText(/You sign in with Okta/)).toBeInTheDocument()
        expect(screen.queryByLabelText(/Current password/i)).not.toBeInTheDocument()
        expect(
            screen.getByRole('link', { name: /Manage connected identities/i }),
        ).toBeInTheDocument()
    })

    it('sends trimmed names and pushes the result into the auth store', async () => {
        vi.mocked(accountService.updateProfile).mockResolvedValue({
            ...PROFILE, firstName: 'Alicia', displayName: 'Alicia Doe',
        })
        const user = userEvent.setup()
        renderPage()

        const first = await screen.findByLabelText(/First name/i)
        await user.clear(first)
        await user.type(first, '  Alicia  ')
        await user.click(screen.getByRole('button', { name: /Save changes/i }))

        await waitFor(() => {
            expect(accountService.updateProfile).toHaveBeenCalledWith({
                firstName: 'Alicia', lastName: 'Doe', displayName: '',
            })
        })
        expect(applyProfile).toHaveBeenCalledWith(
            expect.objectContaining({ firstName: 'Alicia' }),
        )
    })

    it('shows why a password change failed and keeps what was typed', async () => {
        vi.mocked(accountService.changePassword).mockRejectedValue(
            new Error('Current password is incorrect.'),
        )
        const user = userEvent.setup()
        renderPage()

        await user.type(await screen.findByLabelText(/Current password/i), 'wrong-one')
        await user.type(screen.getByLabelText(/^New password/i), 'N3w!Passw0rd#2026')
        await user.type(screen.getByLabelText(/Confirm new password/i), 'N3w!Passw0rd#2026')
        await user.click(screen.getByRole('button', { name: /Change password/i }))

        expect(
            await screen.findByText('Current password is incorrect.'),
        ).toBeInTheDocument()
        expect(screen.getByLabelText(/Current password/i)).toHaveValue('wrong-one')
        expect(navigateSpy).not.toHaveBeenCalled()
    })
})
