/**
 * The provider editor.
 *
 * What the inline form it replaces did not do, and what breaks if any of it
 * regresses:
 *
 *   * **Unsaved work is not thrown away silently.** A claim mapping is
 *     twenty minutes of work and the old form discarded it on close.
 *   * **A configured secret is never re-submitted.** The API returns
 *     `********` and PATCH *merges*, so submitting the mask would write it
 *     over the real signing key and brick the connection.
 *   * **Errors resolve while typing.** A remote button icon is refused by
 *     the CSP; learning that after Save, at the bottom of a long form, is
 *     how it stayed broken.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IdpProvider } from '@/services/ssoAdminService'

const { updateProvider, deleteProvider, getDefaultMapping, testMapping, discover } =
    vi.hoisted(() => ({
        updateProvider: vi.fn(),
        deleteProvider: vi.fn(),
        getDefaultMapping: vi.fn(),
        testMapping: vi.fn(),
        discover: vi.fn(),
    }))

vi.mock('@/services/ssoAdminService', async () => {
    const actual = await vi.importActual<typeof import('@/services/ssoAdminService')>(
        '@/services/ssoAdminService',
    )
    return {
        ...actual,
        ssoAdminService: {
            ...actual.ssoAdminService,
            updateProvider, deleteProvider, getDefaultMapping, testMapping, discover,
        },
    }
})

const notify = vi.fn()
vi.mock('@/components/ui/notifications', () => ({
    useAppNotifications: () => ({ notify }),
}))

vi.mock('@/components/help/DocsLink', () => ({
    DocsLink: () => null,
}))

import { ProviderEditorDrawer } from '../ProviderEditorDrawer'

function provider(over: Partial<IdpProvider> = {}): IdpProvider {
    return {
        id: 'idp_1', slug: 'entra-staff', displayName: 'Corporate Entra',
        kind: 'oidc', enabled: true, priority: 100,
        settings: { issuer: 'https://idp', client_id: 'abc', client_secret: '********' },
        claimMapping: {}, linkingPolicy: 'strict',
        assurance: 'verified', assuranceReason: 'Signature checked',
        emailDomains: [], lifecycle: 'live',
        createdAt: '', updatedAt: '',
        ...over,
    } as IdpProvider
}

/** Scoped to the rail: "Connection" also appears in the danger zone's
 *  "Delete this connection", and "Login page" in its own prose. */
function section(name: RegExp) {
    return within(screen.getByRole('navigation', { name: 'Sections' }))
        .getByRole('button', { name })
}

function renderDrawer(over: Partial<IdpProvider> = {}, handlers = {}) {
    const props = {
        onClose: vi.fn(), onSaved: vi.fn(), onDeleted: vi.fn(), ...handlers,
    }
    render(<ProviderEditorDrawer provider={provider(over)} {...props} />)
    return props
}

beforeEach(() => {
    vi.clearAllMocks()
    getDefaultMapping.mockResolvedValue({})
    updateProvider.mockResolvedValue(provider())
})

describe('dirty guard', () => {
    it('closes straight away when nothing has changed', async () => {
        const user = userEvent.setup()
        const { onClose } = renderDrawer()

        await user.click(screen.getByRole('button', { name: /cancel/i }))

        expect(onClose).toHaveBeenCalled()
        expect(screen.queryByRole('alertdialog')).toBeNull()
    })

    it('asks before discarding edits', async () => {
        const user = userEvent.setup()
        const { onClose } = renderDrawer()

        await user.type(screen.getByPlaceholderText('Corporate Entra ID'), '!')
        await user.click(screen.getByRole('button', { name: /cancel/i }))

        expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
        expect(onClose).not.toHaveBeenCalled()

        await user.click(screen.getByRole('button', { name: /keep editing/i }))
        expect(onClose).not.toHaveBeenCalled()
    })

    it('discards when the operator confirms', async () => {
        const user = userEvent.setup()
        const { onClose } = renderDrawer()

        await user.type(screen.getByPlaceholderText('Corporate Entra ID'), '!')
        await user.click(screen.getByRole('button', { name: /cancel/i }))
        await user.click(await screen.findByRole('button', { name: /^discard$/i }))

        expect(onClose).toHaveBeenCalled()
    })

    it('counts what is unsaved rather than only flagging it', async () => {
        const user = userEvent.setup()
        renderDrawer()
        expect(screen.getByText(/no changes/i)).toBeInTheDocument()

        await user.type(screen.getByPlaceholderText('Corporate Entra ID'), '!')
        expect(await screen.findByText(/1 unsaved change$/i)).toBeInTheDocument()
    })
})

describe('saving', () => {
    it('will not save until something has changed', () => {
        renderDrawer()
        expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled()
    })

    it('never re-submits a configured secret', async () => {
        // The mask is what the API returns for a secret that exists. PATCH
        // merges, so sending it back would overwrite the real signing key.
        const user = userEvent.setup()
        renderDrawer()

        await user.type(screen.getByPlaceholderText('Corporate Entra ID'), '!')
        await user.click(screen.getByRole('button', { name: /save changes/i }))

        await waitFor(() => expect(updateProvider).toHaveBeenCalled())
        const sent = updateProvider.mock.calls[0][1].settings
        expect(sent).not.toHaveProperty('client_secret')
        expect(sent.client_id).toBe('abc')
    })

    it('sends a rotated secret', async () => {
        const user = userEvent.setup()
        renderDrawer()

        await user.click(section(/^connection$/i))
        await user.click(await screen.findByRole('button', { name: /rotate/i }))
        await user.type(screen.getByLabelText(/show secret/i).closest('div')!
            .querySelector('input')!, 'brand-new-secret')
        await user.click(screen.getByRole('button', { name: /save changes/i }))

        await waitFor(() => expect(updateProvider).toHaveBeenCalled())
        expect(updateProvider.mock.calls[0][1].settings.client_secret)
            .toBe('brand-new-secret')
    })

    it('sends a blanked button label as an empty string, not null', async () => {
        // The server reads null as "field not in this PATCH", so a
        // blanked box sent as null kept the old label forever — the
        // owner's "Sign in via DSP" outlived every edit. '' clears.
        const user = userEvent.setup()
        renderDrawer({ buttonLabel: 'Sign in via DSP' })

        await user.click(section(/login page/i))
        const labelInput = screen.getByDisplayValue('Sign in via DSP')
        await user.clear(labelInput)
        await user.click(screen.getByRole('button', { name: /save changes/i }))

        await waitFor(() => expect(updateProvider).toHaveBeenCalled())
        expect(updateProvider.mock.calls[0][1].buttonLabel).toBe('')
    })

    it('reports a failed save in place instead of closing', async () => {
        const user = userEvent.setup()
        updateProvider.mockRejectedValue(new Error('slug already in use'))
        const { onClose } = renderDrawer()

        await user.type(screen.getByPlaceholderText('Corporate Entra ID'), '!')
        await user.click(screen.getByRole('button', { name: /save changes/i }))

        expect(await screen.findByText(/slug already in use/i)).toBeInTheDocument()
        expect(onClose).not.toHaveBeenCalled()
    })
})

describe('validation while typing', () => {
    it('refuses a remote button icon the CSP would block', async () => {
        const user = userEvent.setup()
        renderDrawer()

        await user.click(section(/^login page$/i))
        await user.type(
            await screen.findByPlaceholderText(/data:image\/svg\+xml/),
            'https://cdn.example.com/logo.svg',
        )

        expect(await screen.findByText(/blocked by the content-security policy/i))
            .toBeInTheDocument()
        expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled()
    })

    it('points the rail at the section holding the problem', async () => {
        const user = userEvent.setup()
        renderDrawer()

        await user.click(section(/^login page$/i))
        await user.type(
            await screen.findByPlaceholderText(/data:image\/svg\+xml/),
            'http://cdn.example.com/logo.svg',
        )

        expect(await screen.findByLabelText('1 problem')).toBeInTheDocument()
    })

    it('refuses an empty display name', async () => {
        const user = userEvent.setup()
        renderDrawer()

        await user.clear(screen.getByPlaceholderText('Corporate Entra ID'))

        expect(await screen.findByText(/a connection needs a name/i)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled()
    })
})

describe('immutable fields', () => {
    it('says why the slug cannot be changed rather than greying it out', async () => {
        renderDrawer()
        expect(screen.getByText(/baked into every URL/i)).toBeInTheDocument()
        // …and it is genuinely not editable.
        expect(screen.queryByDisplayValue('entra-staff')).toBeNull()
    })
})

describe('lifecycle honesty', () => {
    it('says a draft is invisible whatever the enabled switch says', async () => {
        const user = userEvent.setup()
        renderDrawer({ lifecycle: 'draft', enabled: true })

        await user.click(section(/^login page$/i))

        expect(await screen.findByText(/nobody\s+can see it on the sign-in page/i))
            .toBeInTheDocument()
    })

    it('says a live enabled connection is visible to everyone', async () => {
        const user = userEvent.setup()
        renderDrawer({ lifecycle: 'live', enabled: true })

        await user.click(section(/^login page$/i))

        expect(await screen.findByText(/everyone reaching the sign-in page/i))
            .toBeInTheDocument()
    })
})

describe('danger zone', () => {
    it('will not delete until the slug is typed', async () => {
        const user = userEvent.setup()
        renderDrawer()

        await user.click(section(/^danger zone$/i))
        const button = await screen.findByRole('button', { name: /delete connection/i })
        expect(button).toBeDisabled()

        await user.type(screen.getByLabelText(/type the slug/i), 'entra-staff')
        expect(button).toBeEnabled()
    })

    it('deletes once confirmed', async () => {
        const user = userEvent.setup()
        deleteProvider.mockResolvedValue(undefined)
        const { onDeleted } = renderDrawer()

        await user.click(section(/^danger zone$/i))
        await user.type(await screen.findByLabelText(/type the slug/i), 'entra-staff')
        await user.click(screen.getByRole('button', { name: /delete connection/i }))

        await waitFor(() => expect(deleteProvider).toHaveBeenCalledWith('idp_1'))
        expect(onDeleted).toHaveBeenCalled()
    })

    it('warns harder about deleting a live connection', async () => {
        const user = userEvent.setup()
        renderDrawer({ lifecycle: 'live' })

        await user.click(section(/^danger zone$/i))

        expect(await screen.findByText(/this connection is live/i)).toBeInTheDocument()
    })
})
