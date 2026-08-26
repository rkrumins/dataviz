/**
 * The account page's load-bearing behaviours.
 *
 * The ones about identity-provider ownership matter most: the page must
 * never present an editable-looking field whose value the next sign-in
 * would revert, and it must never post one either — the server refuses
 * with a 409, and a user who typed into the box would have earned an
 * error the UI should have prevented.
 *
 * The rest are about not wasting people's input: Save appears only when
 * there is something to save, the password form stays out of the way
 * until asked for, and a rejected password change keeps what was typed
 * rather than making somebody retype three fields over one typo.
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
    authService: { listMyIdentities: vi.fn(), forgotPassword: vi.fn() },
}))

const showToast = vi.fn()
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ showToast }) }))

const applyProfile = vi.fn()
vi.mock('@/store/auth', () => ({
    SYSTEM_ROLE_LABELS: { user: 'User' },
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

vi.mock('@/components/layout/AvatarPickerDialog', () => ({
    AvatarPickerDialog: () => null,
    useAvatarContent: () => null,
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
    idpManagedFields: [] as string[], idpManagedBy: null,
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
        expect(screen.queryByRole('button', { name: /Change my password/i })).not.toBeInTheDocument()
    })

    it('reads sign-in methods from the shell, not from a default', async () => {
        // Regression: the page called useAccountIdentity() in its own
        // body while AccountShell — its child — rendered the Provider.
        // A component cannot consume context from its own child, so it
        // silently read the default (passwordSet: null) and decided
        // every account was password-less. Nothing about the page
        // looked broken; it just quietly told the truth about nobody.
        vi.mocked(authService.listMyIdentities).mockResolvedValue({
            passwordSet: false,
            identities: [{
                id: 'idn_1',
                provider: { id: 'p1', slug: 'okta', displayName: 'Okta', kind: 'oidc' },
                externalId: 'x', createdAt: '',
            }],
        })

        renderPage()

        // Proves the value reached the page rather than the default.
        expect(await screen.findByText(/no password on this account/i)).toBeInTheDocument()
    })

    it('lets an SSO-only account ask for a password, and confirms', async () => {
        // The request is the forgot-password flow: no token is minted —
        // the account is flagged and an administrator grants a link
        // deliberately. The confirmation has to say the admin is the
        // next step, or the person sits waiting for an email that only
        // an admin can cause.
        vi.mocked(authService.listMyIdentities).mockResolvedValue({
            passwordSet: false,
            identities: [{
                id: 'idn_1',
                provider: { id: 'p1', slug: 'okta', displayName: 'Okta', kind: 'oidc' },
                externalId: 'x', createdAt: '',
            }],
        })
        vi.mocked(authService.forgotPassword).mockResolvedValue({ message: 'ok' })
        const user = userEvent.setup()
        renderPage()

        await user.click(
            await screen.findByRole('button', { name: /request a password/i }),
        )

        expect(authService.forgotPassword)
            .toHaveBeenCalledWith('alice@example.com')
        expect(await screen.findByRole('status'))
            .toHaveTextContent(/administrator will see it/i)
        expect(
            screen.queryByRole('button', { name: /request a password/i }),
        ).not.toBeInTheDocument()
    })

    it('keeps the password form out of the way until it is asked for', async () => {
        const user = userEvent.setup()
        renderPage()

        // Collapsed on open — the three-field form used to dominate the page.
        expect(await screen.findByRole('button', { name: /Change my password/i })).toBeInTheDocument()
        expect(screen.queryByLabelText(/Current password/i)).not.toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: /Change my password/i }))
        expect(screen.getByLabelText(/Current password/i)).toBeInTheDocument()
    })

    it('locks fields the identity provider owns, and says who owns them', async () => {
        vi.mocked(accountService.getProfile).mockResolvedValue({
            ...PROFILE, idpManagedFields: ['first_name'], idpManagedBy: 'p1',
        })
        vi.mocked(authService.listMyIdentities).mockResolvedValue({
            passwordSet: true,
            identities: [{
                id: 'idn_1',
                provider: { id: 'p1', slug: 'okta', displayName: 'Okta', kind: 'oidc' },
                externalId: 'x', createdAt: '',
            }],
        })

        renderPage()

        // Owned field is locked and attributed...
        expect(await screen.findByLabelText(/First name/i)).toBeDisabled()
        // ...the one the IdP did not assert stays editable...
        expect(screen.getByLabelText(/Last name/i)).not.toBeDisabled()
        // ...and display name is never IdP-owned, which is what keeps
        // this page useful for an SSO account.
        expect(screen.getByLabelText(/Display name/i)).not.toBeDisabled()
    })

    it('never sends an IdP-owned field, so the user cannot trip a 409', async () => {
        vi.mocked(accountService.getProfile).mockResolvedValue({
            ...PROFILE, idpManagedFields: ['first_name', 'last_name'], idpManagedBy: 'p1',
        })
        vi.mocked(accountService.updateProfile).mockResolvedValue(PROFILE)
        const user = userEvent.setup()
        renderPage()

        await user.type(await screen.findByLabelText(/Display name/i), 'Ada')
        await user.click(await screen.findByRole('button', { name: /Save changes/i }))

        await waitFor(() => expect(accountService.updateProfile).toHaveBeenCalled())
        expect(accountService.updateProfile).toHaveBeenCalledWith({ displayName: 'Ada' })
    })

    it('offers Save only once something has changed', async () => {
        const user = userEvent.setup()
        renderPage()

        await screen.findByLabelText(/First name/i)
        expect(screen.queryByRole('button', { name: /Save changes/i })).not.toBeInTheDocument()

        await user.type(screen.getByLabelText(/Display name/i), 'Ada')
        expect(await screen.findByRole('button', { name: /Save changes/i })).toBeInTheDocument()
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
        await user.click(await screen.findByRole('button', { name: /Save changes/i }))

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

        await user.click(await screen.findByRole('button', { name: /Change my password/i }))
        await user.type(screen.getByLabelText(/Current password/i), 'wrong-one')
        await user.type(screen.getByLabelText(/^New password/i), 'N3w!Passw0rd#2026')
        await user.type(screen.getByLabelText(/Confirm new password/i), 'N3w!Passw0rd#2026')
        await user.click(screen.getByRole('button', { name: /^Change password$/i }))

        expect(await screen.findByText('Current password is incorrect.')).toBeInTheDocument()
        expect(screen.getByLabelText(/Current password/i)).toHaveValue('wrong-one')
        expect(navigateSpy).not.toHaveBeenCalled()
    })
})

describe('one-word names', () => {
    it('saves with the surname left blank', async () => {
        // "Prince" and undivided scripts land whole in the first name.
        // Requiring a second field made Save permanently dead for them
        // — and took the display-name escape hatch down with it, since
        // it rides in the same patch.
        vi.mocked(accountService.updateProfile).mockResolvedValue({
            ...PROFILE, lastName: '', displayName: '',
        })
        const user = userEvent.setup()
        renderPage()

        const last = await screen.findByLabelText(/Last name/i)
        await user.clear(last)
        await user.type(
            await screen.findByLabelText(/Display name/i), 'Prince',
        )
        const save = await screen.findByRole('button', {
            name: /Save changes/i,
        })
        expect(save).toBeEnabled()
        await user.click(save)
        await waitFor(() => {
            expect(accountService.updateProfile).toHaveBeenCalled()
        })
    })
})
