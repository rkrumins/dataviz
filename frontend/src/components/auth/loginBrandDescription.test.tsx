/**
 * The branded description reads as a subtitle under the app name on the
 * sign-in screen — and leaves no empty gap when it is blank.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginPage } from './LoginPage'

const { loginContext, brand } = vi.hoisted(() => ({
    loginContext: vi.fn(),
    brand: { description: '' },
}))

vi.mock('@/services/authService', async () => {
    const actual = await vi.importActual<typeof import('@/services/authService')>(
        '@/services/authService',
    )
    return { ...actual, authService: { ...actual.authService, loginContext } }
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
    useBrand: () => ({
        appName: 'Acme Lineage', loginTagline: 'Sign in to continue', copyrightText: '', ...brand,
    }),
}))
vi.mock('@/store/features', () => ({ useFeature: () => false }))
vi.mock('@/lib/useDocumentTitle', () => ({ useDocumentTitle: () => {} }))

function renderLogin() {
    return render(<MemoryRouter><LoginPage /></MemoryRouter>)
}

beforeEach(() => {
    vi.clearAllMocks()
    brand.description = ''
    loginContext.mockResolvedValue({ allowLocalLogin: true, emailFirstLogin: false, providers: [] })
})

describe('LoginPage — brand description', () => {
    it('shows the description under the app name', async () => {
        brand.description = 'Lineage for every Acme dataset'
        renderLogin()
        await waitFor(() => expect(loginContext).toHaveBeenCalled())

        const heading = screen.getByRole('heading', { name: 'Acme Lineage' })
        const subtitle = screen.getByText('Lineage for every Acme dataset')
        expect(heading.compareDocumentPosition(subtitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(screen.getByText('Sign in to continue')).toBeInTheDocument()
    })

    it('renders nothing for a blank description', async () => {
        renderLogin()
        await waitFor(() => expect(loginContext).toHaveBeenCalled())

        const heading = screen.getByRole('heading', { name: 'Acme Lineage' })
        // Name, then straight to the tagline — no empty subtitle between them.
        expect(heading.nextElementSibling).toHaveTextContent('Sign in to continue')
    })
})
