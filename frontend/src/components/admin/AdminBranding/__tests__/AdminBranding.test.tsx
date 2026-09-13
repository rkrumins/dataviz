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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/brandingService', () => ({
    fetchAdminBranding: vi.fn(),
    updateBranding: vi.fn(),
    uploadBrandingImage: vi.fn(),
    resetBranding: vi.fn(),
}))

import { AdminBranding } from '../index'
import {
    fetchAdminBranding, updateBranding, uploadBrandingImage, resetBranding,
    type Branding,
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
    return render(
        <QueryClientProvider client={client}><AdminBranding /></QueryClientProvider>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    useNotificationStore.setState({ notifications: [], history: [], _nextId: 1 })
    vi.mocked(fetchAdminBranding).mockResolvedValue(branding())
    vi.mocked(updateBranding).mockResolvedValue(branding({ version: 4 }))
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
        vi.mocked(updateBranding).mockRejectedValue(new Error('version mismatch'))
        const user = userEvent.setup()
        renderPage()
        await saveAChange(user)

        expect(await screen.findByText(/Someone else updated branding/i)).toBeInTheDocument()
        // ...and it is not ALSO shouted, which is the double-report this sweep removes.
        expect(messages()).toEqual([])
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
    it('applying a built-in mark says which one', async () => {
        const user = userEvent.setup()
        renderPage()
        const marks = await screen.findAllByRole('button', { name: /Use this mark/i })
        await user.click(marks[0])

        await waitFor(() => expect(messages()).toEqual([
            '“Graph constellation” applied as the logo and favicon.',
        ]))
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
})
