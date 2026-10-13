/**
 * A key's card and its detail drawer: the countdown coloured by how soon, a
 * key replaced by rotation called that, the drawer's three tabs, and Escape
 * closing only the top layer when a dialog sits over the drawer.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { KeyCard, PastKeyRow } from '../KeyCard'
import { KeyDetailDrawer } from '../KeyDetailDrawer'
import { MyApiKeysPage } from '@/pages/MyApiKeysPage'
import { access, apiKey, detail, inDays, options as opts, usage } from './fixtures'
import type { UsageDay } from '@/services/apiKeyService'

const svc = vi.hoisted(() => ({ list: vi.fn(), options: vi.fn(), get: vi.fn(), revoke: vi.fn(), update: vi.fn() }))
vi.mock('@/services/apiKeyService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/services/apiKeyService')>()),
    apiKeyService: svc,
}))
vi.mock('@/components/account/AccountShell', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/account/AccountShell')>()),
    AccountShell: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: vi.fn() }) }))
vi.mock('@/lib/useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
vi.mock('@/store/features', () => ({ useFeature: () => true }))

beforeEach(() => {
    vi.clearAllMocks()
    svc.list.mockResolvedValue([apiKey()])
    svc.options.mockResolvedValue(opts())
    svc.get.mockResolvedValue(detail())
})

function card(over: Parameters<typeof apiKey>[0] = {}) {
    render(<ul><KeyCard apiKey={apiKey(over)} onOpen={vi.fn()} /></ul>)
    return screen.getByRole('listitem')
}

describe('the card', () => {
    it('colours the countdown by how soon the key stops', () => {
        expect(within(card({ expiresAt: inDays(3) })).getByText('Expires in 3 days')).toHaveClass('truncate')
        expect(screen.getByText('Expires in 3 days').parentElement).toHaveClass('text-amber-600')
    })

    it('reads under a day as urgent', () => {
        card({ expiresAt: new Date(Date.now() + 5.5 * 3_600_000).toISOString() })
        expect(screen.getByText('Expires in 5 hours').parentElement).toHaveClass('text-rose-600')
    })

    it('reads a far expiry calmly, and a key without one as never expiring', () => {
        card({ expiresAt: inDays(45) })
        expect(screen.getByText('Expires in 45 days').parentElement).toHaveClass('text-ink')
        render(<ul><KeyCard apiKey={apiKey({ id: 'apk_x', expiresAt: null })} onOpen={vi.fn()} /></ul>)
        expect(screen.getByText('Never expires')).toBeInTheDocument()
    })

    it('says when it was last used, from where and by what, and how much in 14 days', () => {
        const row = card({
            lastUsedAt: new Date(Date.now() - 28 * 60_000).toISOString(),
            lastUsedIp: '203.0.113.24', lastUsedUserAgent: 'python-httpx/0.27.0',
            usage: usage({ daily14: [...Array(12).fill(10), 20, 31] }),
        })
        expect(within(row).getByText('Used 28 minutes ago')).toBeInTheDocument()
        expect(within(row).getByText('203.0.113.24 · python-httpx 0.27.0')).toBeInTheDocument()
        expect(within(row).getByText('171 requests')).toBeInTheDocument()
        expect(within(row).getByText('31 today')).toBeInTheDocument()
    })

    it('offers a paused key its way back — signing in — and never a renewal', () => {
        render(<ul><KeyCard apiKey={apiKey({ status: 'paused' })} resume={{ url: '/sso/login', provider: 'Okta' }} onOpen={vi.fn()} onRotate={vi.fn()} /></ul>)
        expect(screen.getByRole('link', { name: /sign in to resume/i })).toHaveAttribute('href', '/sso/login')
        expect(screen.getByRole('button', { name: /^rotate$/i })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /renew/i })).not.toBeInTheDocument()
        expect(screen.getByText(/paused until you sign in through okta again — nothing was revoked/i)).toBeInTheDocument()
    })

    it('calls a key ended by its rotation "Replaced"', () => {
        render(<ul><PastKeyRow apiKey={apiKey({ status: 'revoked', revokedReason: 'rotated', revokedAt: inDays(-2) })} onOpen={vi.fn()} /></ul>)
        expect(screen.getByText('Replaced')).toBeInTheDocument()
        expect(screen.getByText(/replaced by a new key/i)).toBeInTheDocument()
        expect(screen.queryByText('Revoked')).not.toBeInTheDocument()
    })

    it('shows an administrator’s note on a key they revoked', () => {
        render(<ul><PastKeyRow apiKey={apiKey({ status: 'revoked', revokedReason: 'admin', revokedAt: inDays(-1), revokedNote: 'Pasted in a public log' })} onOpen={vi.fn()} /></ul>)
        expect(screen.getByText(/revoked by an administrator/i)).toBeInTheDocument()
        expect(screen.getByText('“Pasted in a public log”')).toBeInTheDocument()
    })
})

describe('the drawer', () => {
    const days: UsageDay[] = Array.from({ length: 30 }, (_, i) => ({
        day: `2026-09-${String(i + 1).padStart(2, '0')}`, requests: 10, writes: 4, refused: i === 29 ? 3 : 0, errors: 1,
    }))

    function drawer(d = detail()) {
        const load = vi.fn().mockResolvedValue(d)
        render(<KeyDetailDrawer apiKey={apiKey()} variant="owner" load={load} onClose={vi.fn()} />)
        return load
    }

    it('opens on its overview: identity, lifetime and where it came from', async () => {
        const load = drawer(detail({ createdIp: '10.1.2.3', replaces: { id: 'apk_0', name: 'old sync', prefix: 'nxpat_Old' } }))
        expect(load).toHaveBeenCalledWith('apk_1')
        const panel = screen.getByRole('dialog', { name: /api key “nightly sync”/i })
        expect(within(panel).getByRole('tab', { name: /overview/i })).toHaveAttribute('aria-selected', 'true')
        expect(within(panel).getByRole('img', { name: /^created/i })).toBeInTheDocument()   // the lifetime bar
        expect(await within(panel).findByText('from 10.1.2.3')).toBeInTheDocument()
        expect(within(panel).getByText('old sync')).toBeInTheDocument()
    })

    it('shows what it reaches now, per workspace or across every one', async () => {
        drawer(detail({ effectiveAccess: access({ workspaces: [], everyWorkspace: { views: 'read', data: 'read', publish: false } }) }))
        await userEvent.click(screen.getByRole('tab', { name: /access/i }))
        expect(await screen.findByText('Every workspace')).toBeInTheDocument()
        expect(screen.getByText(/organisation-wide role/i)).toBeInTheDocument()
    })

    it('shows 30 days of use: totals, the share that wrote, refusals and errors', async () => {
        drawer(detail({ usageDays: days }))
        await userEvent.click(screen.getByRole('tab', { name: /usage/i }))
        const panel = await screen.findByRole('tabpanel')
        await within(panel).findByText('300')
        expect(within(panel).getByText('40%')).toBeInTheDocument()
        expect(within(panel).getByText('Refused').closest('div')).toHaveTextContent('3')
        expect(within(panel).getByRole('img', { name: /requests per period/i })).toBeInTheDocument()
    })

    it('says so when nothing has called it', async () => {
        drawer(detail({ usageDays: days.map((d) => ({ ...d, requests: 0, writes: 0, refused: 0, errors: 0 })) }))
        await userEvent.click(screen.getByRole('tab', { name: /usage/i }))
        expect(await screen.findByText('No calls in the last 30 days')).toBeInTheDocument()
    })
})

describe('layers', () => {
    it('a rename in the dialog over the drawer shows in the drawer at once', async () => {
        svc.update.mockResolvedValue(apiKey({ name: 'nightly load' }))
        render(<MyApiKeysPage />)
        await userEvent.click(await screen.findByRole('button', { name: 'nightly sync' }))
        const drawer = await screen.findByRole('dialog', { name: /api key “nightly sync”/i })
        await waitFor(() => expect(svc.get).toHaveBeenCalledWith('apk_1'))
        await userEvent.click(within(drawer).getByRole('button', { name: /^edit$/i }))
        const dialog = await screen.findByRole('dialog', { name: /edit “nightly sync”/i })
        await userEvent.clear(within(dialog).getByLabelText('Name'))
        await userEvent.type(within(dialog).getByLabelText('Name'), 'nightly load')
        await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
        const renamed = await screen.findByRole('dialog', { name: /api key “nightly load”/i })
        expect(within(renamed).getByRole('heading', { name: 'nightly load' })).toBeInTheDocument()
    })

    it('Escape closes the dialog over the drawer first, then the drawer', async () => {
        render(<MyApiKeysPage />)
        await userEvent.click(await screen.findByRole('button', { name: 'nightly sync' }))
        const drawerPanel = await screen.findByRole('dialog', { name: /api key “nightly sync”/i })
        await userEvent.click(within(drawerPanel).getByRole('button', { name: /^edit$/i }))
        expect(await screen.findByRole('dialog', { name: /edit “nightly sync”/i })).toBeInTheDocument()

        fireEvent.keyDown(document, { key: 'Escape' })
        await waitFor(() => expect(screen.queryByRole('dialog', { name: /edit “nightly sync”/i })).not.toBeInTheDocument())
        expect(screen.getByRole('dialog', { name: /api key “nightly sync”/i })).toBeInTheDocument()

        fireEvent.keyDown(document, { key: 'Escape' })
        await waitFor(() => expect(screen.queryByRole('dialog', { name: /api key “nightly sync”/i })).not.toBeInTheDocument())
    })
})
