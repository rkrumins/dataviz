/**
 * The SSO buttons, which shipped as unlabelled empty outlines.
 *
 * Two independent faults produced one screenshot. The API serialised the
 * catalog snake_case while this page reads `displayName`/`buttonLabel`,
 * so the label resolved to `undefined` and the button rendered as an icon
 * and nothing else. And the button's border was `border-white/20` on a
 * white card, so on the light theme there was not even an outline to
 * suggest a control was there.
 *
 * The backend half is asserted in `test_login_catalog_shape.py` — a
 * frontend test cannot catch a wire-format mismatch, because the mock is
 * written to the shape the page expects. What this file covers is the
 * rest: that a label is rendered from each source in the fallback chain,
 * that a provider with no label at all still gets a usable name, and that
 * the button does not depend on a colour that only exists on one theme.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { loginContext, resolveEmailDomain } = vi.hoisted(() => ({
    loginContext: vi.fn(),
    resolveEmailDomain: vi.fn(),
}))

vi.mock('@/services/authService', async () => {
    const actual = await vi.importActual<
        typeof import('@/services/authService')
    >('@/services/authService')
    return {
        ...actual,
        authService: { ...actual.authService, loginContext, resolveEmailDomain },
    }
})

import { LoginPage } from '../LoginPage'
import { useAuthStore } from '@/store/auth'

function provider(over: Record<string, unknown> = {}) {
    return {
        id: 'idp_1', slug: 'corp-sso', displayName: 'Corp SSO',
        kind: 'oidc', priority: 100,
        buttonLabel: null, buttonIcon: null, config: {},
        ...over,
    }
}

function renderLogin(providers: Record<string, unknown>[]) {
    loginContext.mockResolvedValue({
        allowLocalLogin: true, emailFirstLogin: false, providers,
    })
    return render(<MemoryRouter><LoginPage /></MemoryRouter>)
}

beforeEach(() => {
    vi.clearAllMocks()
    // The page holds a spinner until the session probe has settled; a
    // signed-out visitor is the state these buttons exist for.
    useAuthStore.setState({ status: 'unauthenticated', isAuthenticated: false })
})

describe('SSO buttons carry a name', () => {
    it('falls back to the display name when there is no button label', async () => {
        renderLogin([provider()])
        expect(await screen.findByRole('link', { name: /corp sso/i }))
            .toBeInTheDocument()
    })

    it('prefers the operator-set button label', async () => {
        renderLogin([provider({ buttonLabel: 'Continue with Okta' })])
        expect(await screen.findByRole('link', { name: /continue with okta/i }))
            .toBeInTheDocument()
    })

    it('falls back to the slug rather than rendering nothing', async () => {
        // The state the screenshot was in. A poor label beats a control
        // with no accessible name at all, which is what shipped.
        renderLogin([provider({ displayName: '', buttonLabel: null })])
        expect(await screen.findByRole('link', { name: /corp-sso/i }))
            .toBeInTheDocument()
    })

    it('treats a whitespace-only label as absent', async () => {
        renderLogin([provider({ buttonLabel: '   ' })])
        expect(await screen.findByRole('link', { name: /corp sso/i }))
            .toBeInTheDocument()
    })
})

describe('SSO buttons are visible on both themes', () => {
    it('does not draw its border in a colour the light theme shares', async () => {
        // `border-white/20` on a white card is not a faint control, it is
        // an absent one. Anything here must name both themes.
        renderLogin([provider()])
        const link = await screen.findByRole('link', { name: /corp sso/i })

        expect(link.className).not.toMatch(/(^|\s)border-white\//)
        expect(link.className).toMatch(/border-black\/10/)
        expect(link.className).toMatch(/dark:border-white\//)
    })

    it('gives the amber dev-provider button a readable colour in light', async () => {
        // text-yellow-300 on white fails contrast badly enough to be
        // unreadable, and this is the button that says "non-production".
        renderLogin([provider({ kind: 'custom', displayName: 'Mock IdP' })])
        const link = await screen.findByRole('link', { name: /mock idp/i })

        expect(link.className).toMatch(/text-yellow-700/)
        expect(link.className).toMatch(/dark:text-yellow-300/)
    })
})

describe('the divider above them', () => {
    it('is drawn in a colour both themes can show', async () => {
        renderLogin([provider()])
        await screen.findByRole('link', { name: /corp sso/i })

        await waitFor(() => {
            expect(screen.getByText(/or sign in with/i).parentElement!.className)
                .toMatch(/border-black\/10 dark:border-white\/10/)
        })
    })
})
