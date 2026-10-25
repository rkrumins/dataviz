/**
 * Administration → API keys: counts that filter, status tabs with their
 * totals, a server-sorted table, a person's keys from their record
 * (`?ownerId=`), the detail drawer, an export that carries the filters — and
 * revocation, with a note to the owner, for those who may manage users.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AdminApiKeys } from '../AdminApiKeys'
import { adminKey, detail } from '@/components/apiKeys/__tests__/fixtures'
import type { AdminApiKeyStats } from '@/services/apiKeyService'

const { svc, notify, perms } = vi.hoisted(() => ({
    svc: {
        adminList: vi.fn(),
        adminStats: vi.fn(),
        adminGet: vi.fn(),
        adminRevoke: vi.fn(),
        adminRevokeAll: vi.fn(),
    },
    notify: vi.fn(),
    perms: { manage: false },
}))

vi.mock('@/services/apiKeyService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/services/apiKeyService')>()
    return { ...actual, apiKeyService: { ...svc, adminExportUrl: actual.apiKeyService.adminExportUrl } }
})
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/store/auth', () => ({ usePermission: () => perms.manage }))

const KEY = adminKey({
    permissions: { views: 'none', data: 'write', publish: false }, resources: 'all',
    allowedCidrs: ['10.0.0.0/8'], expiresAt: null,
    lastUsedAt: '2026-10-01T00:00:00+00:00', lastUsedIp: '10.1.2.3', lastUsedUserAgent: 'curl',
})

const STATS: AdminApiKeyStats = {
    total: 31,
    byStatus: { active: 20, paused: 2, ownerInactive: 1, expired: 5, revoked: 3 },
    expiringSoon: 4, neverExpires: 6, unused90: 7, revoked30d: 2,
}

const lastList = () => svc.adminList.mock.lastCall?.[0]

/** The page as the app mounts it: people are named through the query cache. */
const renderPage = () => render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AdminApiKeys />
    </QueryClientProvider>,
)

beforeEach(() => {
    vi.clearAllMocks()
    perms.manage = false
    window.history.replaceState({}, '', '/admin/api-keys')
    svc.adminList.mockResolvedValue({ items: [KEY], total: 1 })
    svc.adminStats.mockResolvedValue(STATS)
    svc.adminGet.mockResolvedValue({ ...detail(), ...KEY })
    svc.adminRevoke.mockResolvedValue(undefined)
    svc.adminRevokeAll.mockResolvedValue({ revoked: 3 })
})

describe('the inventory', () => {
    it('shows each key, whose it is, what it can do and when it was used', async () => {
        renderPage()
        const row = (await screen.findByRole('button', { name: 'etl' })).closest('tr')!
        expect(within(row).getByText('dana@example.com')).toBeInTheDocument()
        expect(row).toHaveTextContent('Data: read & write')
        expect(row).toHaveTextContent('only from 10.0.0.0/8')
        expect(within(row).getByText('10.1.2.3')).toBeInTheDocument()
        expect(within(row).getByText('Never expires')).toBeInTheDocument()
        expect(lastList()).toMatchObject({ status: 'active', offset: 0, sort: 'created', order: 'desc' })
    })

    it('marks a service account’s key, whose owner is no person', async () => {
        svc.adminList.mockResolvedValue({
            items: [KEY, adminKey({
                id: 'apk_s', name: 'metadata sync', kind: 'service', prefix: 'nxsat_AbCdEfGh',
                owner: { id: 'svc_sync', email: 'svc_sync@service-account.invalid', displayName: 'Metadata sync', avatarId: null, hasImage: false, deleted: false },
            })],
            total: 2,
        })
        renderPage()
        const service = (await screen.findByRole('button', { name: 'metadata sync' })).closest('tr')!
        expect(within(service).getByText('Service account')).toBeInTheDocument()
        expect(within(service).queryByText('svc_sync@service-account.invalid')).not.toBeInTheDocument()
        const person = screen.getByRole('button', { name: 'etl' }).closest('tr')!
        expect(within(person).queryByText('Service account')).not.toBeInTheDocument()
    })

    it('counts each status on its tab, from the stats', async () => {
        renderPage()
        const tabs = await screen.findByRole('tablist', { name: 'Status' })
        await waitFor(() => expect(within(tabs).getByRole('tab', { name: /paused/i })).toHaveTextContent('2'))
        expect(within(tabs).getByRole('tab', { name: /owner inactive/i })).toHaveTextContent('1')
        expect(within(tabs).getByRole('tab', { name: /^all/i })).toHaveTextContent('31')
        await userEvent.click(within(tabs).getByRole('tab', { name: /expired/i }))
        await waitFor(() => expect(lastList()).toMatchObject({ status: 'expired', offset: 0 }))
    })

    it('turns a count into a filter, and back', async () => {
        renderPage()
        const counts = await screen.findByRole('group', { name: 'Key counts' })
        const expiring = within(counts).getByRole('button', { name: /expiring within 7 days/i })
        await waitFor(() => expect(expiring).toHaveAccessibleName('4 Expiring within 7 days'))
        await userEvent.click(expiring)
        await waitFor(() => expect(lastList()).toMatchObject({ focus: 'expiring_soon', status: undefined }))
        expect(expiring).toHaveAttribute('aria-pressed', 'true')
        expect(screen.getByRole('button', { name: /stop showing only expiring within 7 days/i })).toBeInTheDocument()

        await userEvent.click(within(counts).getByRole('button', { name: /never expire/i }))
        await waitFor(() => expect(lastList()).toMatchObject({ focus: 'never_expires' }))
        await userEvent.click(within(counts).getByRole('button', { name: /unused for 90 days/i }))
        await waitFor(() => expect(lastList()).toMatchObject({ focus: 'unused' }))
        await userEvent.click(within(counts).getByRole('button', { name: /unused for 90 days/i }))
        await waitFor(() => expect(lastList()).toMatchObject({ focus: undefined }))
        await userEvent.click(within(counts).getByRole('button', { name: /paused/i }))
        await waitFor(() => expect(lastList()).toMatchObject({ status: 'paused', focus: undefined }))
    })

    it('asks the server to sort by a column, and says which way', async () => {
        renderPage()
        await screen.findByRole('button', { name: 'etl' })
        await userEvent.click(screen.getByRole('button', { name: 'Last used' }))
        await waitFor(() => expect(lastList()).toMatchObject({ sort: 'lastUsed', order: 'asc', offset: 0 }))
        expect(screen.getByRole('button', { name: 'Last used' }).closest('th')).toHaveAttribute('aria-sort', 'ascending')
        await userEvent.click(screen.getByRole('button', { name: 'Last used' }))
        await waitFor(() => expect(lastList()).toMatchObject({ sort: 'lastUsed', order: 'desc' }))
        await userEvent.click(screen.getByRole('button', { name: 'Expires' }))
        await waitFor(() => expect(lastList()).toMatchObject({ sort: 'expires', order: 'asc' }))
    })

    it('shows one person’s keys when sent from their record', async () => {
        window.history.replaceState({}, '', '/admin/api-keys?ownerId=usr_1')
        renderPage()
        expect(await screen.findByText('Keys of Dana')).toBeInTheDocument()
        expect(svc.adminList.mock.calls[0][0]).toMatchObject({ ownerId: 'usr_1' })
        expect(svc.adminStats).toHaveBeenCalledWith({ ownerId: 'usr_1', q: undefined })
        await userEvent.click(screen.getByRole('button', { name: /stop showing only keys of dana/i }))
        await waitFor(() => expect(lastList()).toMatchObject({ ownerId: undefined }))
    })

    it('exports what is on screen, filters and order included', async () => {
        renderPage()
        const link = await screen.findByRole('link', { name: /export csv/i })
        expect(link).toHaveAttribute('href', '/api/v1/admin/api-keys/export.csv?status=active&sort=created&order=desc')
        await userEvent.click(within(screen.getByRole('group', { name: 'Key counts' })).getByRole('button', { name: /never expire/i }))
        await waitFor(() => expect(link.getAttribute('href')).toBe('/api/v1/admin/api-keys/export.csv?focus=never_expires&sort=created&order=desc'))
    })

    it('opens a key’s detail: whose it is, what it did, and its tabs', async () => {
        renderPage()
        await userEvent.click(await screen.findByRole('button', { name: 'etl' }))
        const drawer = await screen.findByRole('dialog', { name: /api key “etl”/i })
        expect(svc.adminGet).toHaveBeenCalledWith('apk_1')
        expect(within(drawer).getByText('Acts as them')).toBeInTheDocument()
        expect(within(drawer).getByRole('link', { name: 'Dana' })).toHaveAttribute('href', '/admin/users?user=usr_1')
        expect(within(drawer).getByRole('link', { name: /its activity/i }))
            .toHaveAttribute('href', '/admin/audit?act_key=apk_1&act_days=365')
        await userEvent.click(within(drawer).getByRole('tab', { name: /access/i }))
        expect(await within(drawer).findByText('Finance')).toBeInTheDocument()
    })
})

describe('revoking', () => {
    it('is offered only to those who may manage users', async () => {
        renderPage()
        await screen.findByRole('button', { name: 'etl' })
        expect(screen.queryByRole('button', { name: /revoke/i })).not.toBeInTheDocument()
    })

    it('revokes one key, with a note to its owner', async () => {
        perms.manage = true
        renderPage()
        const row = (await screen.findByRole('button', { name: 'etl' })).closest('tr')!
        await userEvent.click(within(row).getByRole('button', { name: 'Revoke “etl”…' }))
        const dialog = await screen.findByRole('dialog', { name: /revoke “etl”/i })
        await userEvent.type(within(dialog).getByLabelText('Note to the owner'), 'Pasted in a public CI log')
        await userEvent.click(within(dialog).getByRole('button', { name: /^revoke key$/i }))
        await waitFor(() => expect(svc.adminRevoke).toHaveBeenCalledWith('apk_1', 'Pasted in a public CI log'))
        expect(notify).toHaveBeenCalledWith('success', '“etl” revoked. Its owner has been told.')
    })

    it('revokes every key of its owner only once their address is typed', async () => {
        perms.manage = true
        renderPage()
        const row = (await screen.findByRole('button', { name: 'etl' })).closest('tr')!
        await userEvent.click(within(row).getByRole('button', { name: 'Revoke “etl”…' }))
        const dialog = await screen.findByRole('dialog')
        await userEvent.click(within(dialog).getByRole('radio', { name: /every key they hold/i }))
        const confirm = within(dialog).getByRole('button', { name: /revoke all their keys/i })
        expect(confirm).toBeDisabled()
        await userEvent.type(within(dialog).getByLabelText('Their email address'), 'dana@example.com')
        expect(confirm).toBeEnabled()
        await userEvent.click(confirm)
        await waitFor(() => expect(svc.adminRevokeAll).toHaveBeenCalledWith('usr_1', ''))
        expect(notify).toHaveBeenCalledWith('success', '3 keys of Dana revoked.')
    })
})
