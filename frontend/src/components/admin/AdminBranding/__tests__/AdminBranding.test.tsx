/**
 * Branding says what it did — out loud, in the one place the app speaks.
 *
 * The report that started this: "Branding doesn't appear to have one when I
 * click save." It didn't. The only sign a save had landed was the Save button
 * turning into a tick, at the bottom of a long scrolling page — easy to be
 * looking away from, and gone the moment you touch a field again.
 *
 * The worse half was the reset: its failure rendered into a banner in the page
 * flow, UNDERNEATH the confirmation modal that caused it, so the one action on
 * the page that "can't be undone" could fail completely invisibly.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/brandingService', () => ({
    // The real class shape: the page tells a stale-version 409 apart from
    // every other failure by type, never by message text.
    BrandingConflictError: class BrandingConflictError extends Error {
        readonly code = 'CONFLICT' as const
    },
    fetchAdminBranding: vi.fn(),
    updateBranding: vi.fn(),
    uploadBrandingImage: vi.fn(),
    resetBranding: vi.fn(),
}))

import { AdminBranding } from '../index'
import {
    fetchAdminBranding, updateBranding, uploadBrandingImage, resetBranding,
    BrandingConflictError, type Branding, type BrandingPatch,
} from '@/services/brandingService'
import { useNotificationStore } from '@/components/ui/notifications'

function branding(over: Partial<Branding> = {}): Branding {
    return {
        appName: 'Nexus Lineage',
        shortName: 'Nexus',
        description: 'Interactive Data Lineage Visualization',
        logoUrl: '/nexus-icon.svg',
        faviconUrl: '/nexus-icon.svg',
        accentColor: '#6366f1',
        copyrightText: '© 2026 Nexus',
        supportEmail: 'support@example.com',
        loginTagline: 'Sign in to continue',
        version: 3,
        updatedAt: new Date().toISOString(),
        ...over,
    }
}

/** What the app's ONE notification stack is currently holding. */
const raised = () => useNotificationStore.getState().notifications
const messages = () => raised().map(n => n.message)

function renderPage() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(
        <QueryClientProvider client={client}><AdminBranding /></QueryClientProvider>,
    )
    return { ...view, client }
}

/** A fake server: GET serves ``server``; PATCH checks ``expectedVersion``
 *  and echoes the patch back at the next version. A PATCH mock that always
 *  answered with fixed values is what hid the stale-cache bug. */
let server: Branding
function patchServer(patch: BrandingPatch): Branding {
    const { expectedVersion, ...rest } = patch
    if (expectedVersion !== undefined && expectedVersion !== server.version) {
        throw new BrandingConflictError(
            `version mismatch: expected ${expectedVersion}, got ${server.version}`,
        )
    }
    const fields = Object.fromEntries(
        Object.entries(rest).filter(([k]) => !/(Data|Mime)$/.test(k)),
    )
    server = { ...server, ...fields, version: server.version + 1 }
    return server
}
/** Someone else saves in another tab. */
function theyChange(over: Partial<Branding>) {
    server = { ...server, ...over, version: server.version + 1 }
}

beforeEach(() => {
    vi.clearAllMocks()
    useNotificationStore.setState({ notifications: [], history: [], _nextId: 1 })
    server = branding()
    vi.mocked(fetchAdminBranding).mockImplementation(async () => server)
    vi.mocked(updateBranding).mockImplementation(async (p) => patchServer(p))
    vi.mocked(uploadBrandingImage).mockResolvedValue(branding({ version: 4 }))
    vi.mocked(resetBranding).mockResolvedValue(branding({ version: 4 }))
})

/** Make the form dirty so Save is enabled, then press it. */
async function saveAChange(user: ReturnType<typeof userEvent.setup>) {
    const appName = await screen.findByDisplayValue('Nexus Lineage')
    await user.clear(appName)
    await user.type(appName, 'Acme Graph')
    await user.click(screen.getByRole('button', { name: /Save changes/i }))
}

describe('AdminBranding — saving', () => {
    it('says what the save did, not just "Saved"', async () => {
        const user = userEvent.setup()
        renderPage()
        await saveAChange(user)

        await waitFor(() => expect(messages()).toEqual([
            'Branding saved — the new name and logo are live everywhere.',
        ]))
        expect(raised()[0].type).toBe('success')
    })

    it('keeps the button’s own "Saved" state — reinforcement, not silence', async () => {
        const user = userEvent.setup()
        renderPage()
        await saveAChange(user)

        await waitFor(() => expect(messages()).toHaveLength(1))
        expect(await screen.findByRole('button', { name: /^Saved$/ })).toBeInTheDocument()
    })

    it('reports a failed save instead of swallowing it', async () => {
        vi.mocked(updateBranding).mockRejectedValue(new Error('Storage is read-only'))
        const user = userEvent.setup()
        renderPage()
        await saveAChange(user)

        await waitFor(() => expect(messages()).toEqual(['Storage is read-only']))
        expect(raised()[0].type).toBe('error')
    })

    it('never raises an empty message when the error carries none', async () => {
        vi.mocked(updateBranding).mockRejectedValue(new Error(''))
        const user = userEvent.setup()
        renderPage()
        await saveAChange(user)

        await waitFor(() => expect(messages()).toEqual(['Could not save the branding changes.']))
    })

    it('a 409 stays on the page: it is still true while you read it', async () => {
        const user = userEvent.setup()
        renderPage()
        await screen.findByDisplayValue('Nexus Lineage')
        theyChange({ shortName: 'Theirs' })
        await saveAChange(user)

        const panel = await screen.findByRole('alert')
        expect(panel).toHaveTextContent(/Branding changed while you were editing/i)
        expect(panel).toHaveTextContent(/Version 4 was saved elsewhere/i)
        // ...and it is not ALSO shouted, which is the double-report this sweep removes.
        expect(messages()).toEqual([])
    })

    it('a non-409 error that mentions "conflict" is reported, not mistaken for one', async () => {
        vi.mocked(updateBranding).mockRejectedValue(new Error('Write conflict in storage layer'))
        const user = userEvent.setup()
        renderPage()
        await saveAChange(user)

        await waitFor(() => expect(messages()).toEqual(['Write conflict in storage layer']))
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('sends only the fields that changed, bound to the loaded version', async () => {
        const user = userEvent.setup()
        renderPage()
        await saveAChange(user)

        await waitFor(() => expect(updateBranding).toHaveBeenCalledTimes(1))
        expect(updateBranding).toHaveBeenCalledWith({ appName: 'Acme Graph', expectedVersion: 3 })
    })

    it('a second save is bound to the version the first one produced', async () => {
        const user = userEvent.setup()
        renderPage()
        await saveAChange(user)
        await screen.findByRole('button', { name: /^Saved$/ })

        const shortName = screen.getByDisplayValue('Nexus')
        await user.clear(shortName)
        await user.type(shortName, 'Acme')
        await user.click(screen.getByRole('button', { name: /Save changes/i }))

        await waitFor(() => expect(updateBranding).toHaveBeenCalledTimes(2))
        expect(updateBranding).toHaveBeenLastCalledWith({ shortName: 'Acme', expectedVersion: 4 })
        await waitFor(() => expect(messages()).toHaveLength(2))
        expect(raised().every((n) => n.type === 'success')).toBe(true)
    })

    it('counts the unsaved changes', async () => {
        const user = userEvent.setup()
        renderPage()
        const appName = await screen.findByDisplayValue('Nexus Lineage')
        await user.type(appName, '!')
        expect(await screen.findByText('1 unsaved change')).toBeInTheDocument()
        await user.type(screen.getByDisplayValue('Nexus'), '!')
        expect(await screen.findByText('2 unsaved changes')).toBeInTheDocument()
    })
})

describe('AdminBranding — someone else saved first', () => {
    it('keeps the typed edits and compares the fields both sides changed', async () => {
        const user = userEvent.setup()
        renderPage()
        await screen.findByDisplayValue('Nexus Lineage')
        theyChange({ appName: 'Theirs Co', shortName: 'TC' })
        await saveAChange(user)

        const panel = await screen.findByRole('alert')
        // Only appName was changed by both; their shortName edit is no collision.
        expect(within(panel).getByText('Application name')).toBeInTheDocument()
        expect(within(panel).queryByText('Short name')).not.toBeInTheDocument()
        expect(within(panel).getByText('Theirs Co')).toBeInTheDocument()
        expect(within(panel).getByText('Acme Graph')).toBeInTheDocument()
        // Nothing typed was lost while the panel is up.
        expect(screen.getByDisplayValue('Acme Graph')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Save changes/i })).toBeDisabled()
    })

    it('Keep my changes re-applies them on the latest version and saves against it', async () => {
        const user = userEvent.setup()
        renderPage()
        await screen.findByDisplayValue('Nexus Lineage')
        theyChange({ appName: 'Theirs Co', shortName: 'TC' })
        await saveAChange(user)

        await user.click(await screen.findByRole('button', { name: /Keep my changes/i }))
        await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
        // Mine where I edited, theirs everywhere else.
        expect(screen.getByDisplayValue('Acme Graph')).toBeInTheDocument()
        expect(screen.getByDisplayValue('TC')).toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: /Save changes/i }))
        await waitFor(() => expect(updateBranding).toHaveBeenCalledTimes(2))
        expect(updateBranding).toHaveBeenLastCalledWith({ appName: 'Acme Graph', expectedVersion: 4 })
        await waitFor(() => expect(messages()).toEqual([
            'Branding saved — the new name and logo are live everywhere.',
        ]))
    })

    it('Discard mine loads the latest values', async () => {
        const user = userEvent.setup()
        renderPage()
        await screen.findByDisplayValue('Nexus Lineage')
        theyChange({ appName: 'Theirs Co' })
        await saveAChange(user)

        await user.click(await screen.findByRole('button', { name: /Discard mine/i }))
        await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
        expect(screen.getByDisplayValue('Theirs Co')).toBeInTheDocument()
        expect(screen.queryByDisplayValue('Acme Graph')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Save changes/i })).toBeDisabled()
    })

    it('a background refetch does not clobber a dirty form', async () => {
        const user = userEvent.setup()
        const { client } = renderPage()
        const appName = await screen.findByDisplayValue('Nexus Lineage')
        await user.clear(appName)
        await user.type(appName, 'Acme Graph')

        theyChange({ shortName: 'TC' })
        await act(() => client.invalidateQueries())

        expect(await screen.findByText(/Someone else saved branding \(version 4\)/)).toBeInTheDocument()
        expect(screen.getByDisplayValue('Acme Graph')).toBeInTheDocument()
        expect(screen.getByDisplayValue('Nexus')).toBeInTheDocument()
    })

    it('a background refetch updates a clean form', async () => {
        const { client } = renderPage()
        await screen.findByDisplayValue('Nexus Lineage')

        theyChange({ appName: 'Theirs Co' })
        await act(() => client.invalidateQueries())

        expect(await screen.findByDisplayValue('Theirs Co')).toBeInTheDocument()
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })
})

describe('AdminBranding — loading', () => {
    it('a load failure shows the error, with a way to try again', async () => {
        vi.mocked(fetchAdminBranding).mockRejectedValueOnce(new Error('Gateway timeout'))
        const user = userEvent.setup()
        renderPage()

        const alert = await screen.findByRole('alert')
        expect(alert).toHaveTextContent(/Couldn't load branding settings/)
        expect(alert).toHaveTextContent('Gateway timeout')

        await user.click(within(alert).getByRole('button', { name: /Try again/i }))
        expect(await screen.findByDisplayValue('Nexus Lineage')).toBeInTheDocument()
    })

    it('shows the description in the live preview', async () => {
        const user = userEvent.setup()
        renderPage()
        expect(await screen.findByText('Interactive Data Lineage Visualization')).toBeInTheDocument()

        const description = screen.getByDisplayValue('Interactive Data Lineage Visualization')
        await user.clear(description)
        await user.type(description, 'Lineage for Acme')
        expect(screen.getByText('Lineage for Acme')).toBeInTheDocument()
    })
})

describe('AdminBranding — the reset that could fail invisibly', () => {
    it('confirms the reset in words', async () => {
        const user = userEvent.setup()
        renderPage()
        await user.click(await screen.findByRole('button', { name: /Reset to defaults/i }))
        await user.click(await screen.findByRole('button', { name: /^Reset$/ }))

        await waitFor(() => expect(messages()).toEqual([
            'Branding reset — every override is gone and the deployment defaults are back.',
        ]))
    })

    it('a failed reset is visible, and no longer hides behind its own modal', async () => {
        vi.mocked(resetBranding).mockRejectedValue(new Error('Defaults are not configured'))
        const user = userEvent.setup()
        renderPage()
        await user.click(await screen.findByRole('button', { name: /Reset to defaults/i }))
        await user.click(await screen.findByRole('button', { name: /^Reset$/ }))

        await waitFor(() => expect(messages()).toEqual(['Defaults are not configured']))
        // The dialog asked its question and got an answer. Leaving it standing
        // over the failure is what buried the old in-flow banner.
        await waitFor(() =>
            expect(screen.queryByRole('dialog', { name: /Reset to defaults/i })).not.toBeInTheDocument())
    })
})

describe('AdminBranding — the other three mutations', () => {
    it('applying a built-in mark keeps what was typed but not yet saved', async () => {
        const user = userEvent.setup()
        renderPage()
        const appName = await screen.findByDisplayValue('Nexus Lineage')
        await user.clear(appName)
        await user.type(appName, 'Acme Graph')
        await user.click((await screen.findAllByRole('button', { name: /Use this mark/i }))[0])

        await waitFor(() => expect(messages()).toHaveLength(1))
        expect(screen.getByDisplayValue('Acme Graph')).toBeInTheDocument()
        expect(await screen.findByText('1 unsaved change')).toBeInTheDocument()
    })

    it('a built-in mark that loses the race says it was not applied, then applies on the latest', async () => {
        const user = userEvent.setup()
        renderPage()
        await screen.findByDisplayValue('Nexus Lineage')
        theyChange({ appName: 'Theirs Co' })
        await user.click((await screen.findAllByRole('button', { name: /Use this mark/i }))[0])

        const panel = await screen.findByRole('alert')
        expect(panel).toHaveTextContent(/Branding changed while you were editing/)
        expect(panel).toHaveTextContent("“Graph constellation” wasn't applied")
        // Nothing was typed, so there is nothing to "keep" and no "keeps both".
        expect(panel).not.toHaveTextContent(/keeps both|Nothing you typed/)
        expect(within(panel).queryByRole('button', { name: /Keep my changes/i })).not.toBeInTheDocument()
        expect(messages()).toEqual([])

        await user.click(within(panel).getByRole('button', { name: /Load version 4/i }))
        await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
        expect(screen.getByDisplayValue('Theirs Co')).toBeInTheDocument()

        await user.click((await screen.findAllByRole('button', { name: /Use this mark/i }))[0])
        await waitFor(() => expect(messages()).toEqual([
            '“Graph constellation” applied as the logo and favicon.',
        ]))
        expect(updateBranding).toHaveBeenLastCalledWith(
            expect.objectContaining({ logoUrl: '/brand-graph-mark.svg', expectedVersion: 4 }),
        )
    })

    it('applying a built-in mark says which one', async () => {
        const user = userEvent.setup()
        renderPage()
        const marks = await screen.findAllByRole('button', { name: /Use this mark/i })
        await user.click(marks[0])

        await waitFor(() => expect(messages()).toEqual([
            '“Graph constellation” applied as the logo and favicon.',
        ]))
    })

    it('an upload keeps what was typed, except the URL the upload replaces', async () => {
        vi.mocked(uploadBrandingImage).mockImplementation(async () => {
            server = { ...server, logoUrl: 'data:image/svg+xml;base64,PHN2Zy8+', version: server.version + 1 }
            return server
        })
        const user = userEvent.setup()
        const { container } = renderPage()
        const appName = await screen.findByDisplayValue('Nexus Lineage')
        await user.clear(appName)
        await user.type(appName, 'Acme Graph')
        const logoUrl = screen.getAllByPlaceholderText(/paste a hosted image URL/i)[0]
        await user.clear(logoUrl)
        await user.type(logoUrl, 'https://cdn.example.com/acme.svg')
        expect(await screen.findByText('2 unsaved changes')).toBeInTheDocument()

        const file = new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })
        await user.upload(container.querySelectorAll<HTMLInputElement>('input[type="file"]')[0], file)

        await waitFor(() => expect(messages()).toHaveLength(1))
        expect(screen.getByDisplayValue('Acme Graph')).toBeInTheDocument()
        expect(screen.queryByDisplayValue('https://cdn.example.com/acme.svg')).not.toBeInTheDocument()
        expect(await screen.findByText('1 unsaved change')).toBeInTheDocument()
    })

    it('an upload says what is now live', async () => {
        const user = userEvent.setup()
        const { container } = renderPage()
        await screen.findByRole('button', { name: /Save changes/i })

        const file = new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })
        await user.upload(container.querySelectorAll<HTMLInputElement>('input[type="file"]')[0], file)

        await waitFor(() => expect(messages()).toEqual([
            'New logo uploaded — it is live everywhere now.',
        ]))
    })

    it('clearing an uploaded image no longer happens in silence', async () => {
        vi.mocked(fetchAdminBranding).mockResolvedValue(
            branding({ logoUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }),
        )
        const user = userEvent.setup()
        renderPage()
        const remove = await screen.findAllByRole('button', { name: /Remove/i })
        await user.click(remove[0])

        await waitFor(() => expect(messages()).toEqual([
            'Uploaded logo removed — the URL field, or the default mark, takes over.',
        ]))
    })

    it('removing an uploaded image keeps what was typed but not yet saved', async () => {
        server = branding({ logoUrl: 'data:image/svg+xml;base64,PHN2Zy8+' })
        const user = userEvent.setup()
        renderPage()
        const appName = await screen.findByDisplayValue('Nexus Lineage')
        await user.clear(appName)
        await user.type(appName, 'Acme Graph')
        await user.click((await screen.findAllByRole('button', { name: /Remove/i }))[0])

        await waitFor(() => expect(messages()).toHaveLength(1))
        expect(updateBranding).toHaveBeenCalledWith({ logoData: '', logoMime: '', expectedVersion: 3 })
        expect(screen.getByDisplayValue('Acme Graph')).toBeInTheDocument()
        expect(await screen.findByText('1 unsaved change')).toBeInTheDocument()
    })

    it('removing an uploaded image that loses the race opens the conflict panel', async () => {
        server = branding({ logoUrl: 'data:image/svg+xml;base64,PHN2Zy8+' })
        const user = userEvent.setup()
        renderPage()
        const appName = await screen.findByDisplayValue('Nexus Lineage')
        await user.clear(appName)
        await user.type(appName, 'Acme Graph')
        theyChange({ shortName: 'TC' })
        await user.click((await screen.findAllByRole('button', { name: /Remove/i }))[0])

        const panel = await screen.findByRole('alert')
        expect(panel).toHaveTextContent("The uploaded logo wasn't removed")
        expect(messages()).toEqual([])

        await user.click(within(panel).getByRole('button', { name: /Keep my changes/i }))
        await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
        expect(screen.getByDisplayValue('Acme Graph')).toBeInTheDocument()
        expect(screen.getByDisplayValue('TC')).toBeInTheDocument()
    })
})
