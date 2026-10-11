/**
 * The change screen in front of an account holding a password somebody
 * else chose. It has no way into the app — the API refuses everything but
 * the change — so signing out is the one other way off it.
 *
 * zxcvbn is stubbed, as in the account page's tests: the real dictionaries
 * are lazily imported and would make this slow and timing-dependent.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const navigateSpy = vi.fn()

vi.mock('react-router-dom', async () => {
    const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
    return { ...actual, useNavigate: () => navigateSpy }
})

vi.mock('@/lib/passwordStrength', () => ({
    STRENGTH_COLORS: ['a', 'b', 'c', 'd', 'e'],
    STRENGTH_LABELS: ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'],
    MIN_STRENGTH_SCORE: 3,
    usePasswordStrength: () => ({ score: 4, feedback: '' }),
}))

const changePassword = vi.fn()
vi.mock('@/services/accountService', () => ({
    accountService: { changePassword: (...a: unknown[]) => changePassword(...a) },
}))

import { PasswordChangeRequired } from '../PasswordChangeRequired'
import { useAuthStore } from '@/store/auth'

const logout = vi.fn(async () => {})

beforeEach(() => {
    navigateSpy.mockReset()
    changePassword.mockReset()
    logout.mockClear()
    useAuthStore.setState({ logout } as never)
})

describe('PasswordChangeRequired', () => {
    it('says why, without assuming it was the published default', () => {
        render(<PasswordChangeRequired />)
        expect(screen.getByRole('heading', { name: 'Choose a new password' })).toBeInTheDocument()
        expect(screen.getByText(/chosen by someone else/)).toBeInTheDocument()
    })

    it('lets the person sign out instead', async () => {
        render(<PasswordChangeRequired />)
        await userEvent.click(screen.getByRole('button', { name: /sign out instead/i }))
        await waitFor(() => expect(logout).toHaveBeenCalledTimes(1))
        expect(navigateSpy).toHaveBeenCalledWith('/login', { replace: true })
        expect(changePassword).not.toHaveBeenCalled()
    })

    it('changes the password, then signs out to sign in again', async () => {
        changePassword.mockResolvedValue(undefined)
        render(<PasswordChangeRequired />)
        await userEvent.type(screen.getByLabelText('Current password'), 'Old!Passw0rd#2026')
        await userEvent.type(screen.getByLabelText('New password'), 'An0ther!Lengthy#Phrase')
        await userEvent.type(screen.getByLabelText('Confirm new password'), 'An0ther!Lengthy#Phrase')
        await userEvent.click(screen.getByRole('button', { name: /set new password/i }))

        await waitFor(() => expect(changePassword).toHaveBeenCalledWith(
            'Old!Passw0rd#2026', 'An0ther!Lengthy#Phrase',
        ))
        expect(logout).toHaveBeenCalledTimes(1)
        expect(navigateSpy).toHaveBeenCalledWith('/login', { replace: true })
    })
})
