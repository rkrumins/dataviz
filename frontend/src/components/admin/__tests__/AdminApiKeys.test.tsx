/**
 * Administration → API keys: the inventory auditors read, and revocation for
 * those who may manage users — one key, or every key a person holds.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AdminApiKeys } from '../AdminApiKeys'
import type { AdminApiKey } from '@/services/apiKeyService'

const { adminList, adminRevoke, adminRevokeAll, notify, perms } = vi.hoisted(() => ({
    adminList: vi.fn(),
    adminRevoke: vi.fn(),
    adminRevokeAll: vi.fn(),
    notify: vi.fn(),
    perms: { manage: false },
}))

vi.mock('@/services/apiKeyService', async () => {
    const actual = await vi.importActual<typeof import('@/services/apiKeyService')>(
        '@/services/apiKeyService',
    )
    return { ...actual, apiKeyService: { adminList, adminRevoke, adminRevokeAll } }
})
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/store/auth', () => ({ usePermission: () => perms.manage }))

const KEY: AdminApiKey = {
    id: 'apk_1', name: 'etl', description: null, prefix: 'nxpat_AbCdEfGh', kind: 'personal',
    permissions: { views: 'none', data: 'write', publish: false }, resources: 'all',
    allowedCidrs: ['10.0.0.0/8'], expiresAt: null, status: 'active',
    createdAt: '2026-01-01T00:00:00+00:00', createdIp: null,
    lastUsedAt: '2026-10-01T00:00:00+00:00', lastUsedIp: '10.1.2.3', lastUsedUserAgent: 'curl',
    revokedAt: null, revokedBy: null, revokedReason: null, rotatedFrom: null,
    owner: { id: 'usr_1', email: 'dana@example.com', displayName: 'Dana' },
}

beforeEach(() => {
    vi.clearAllMocks()
    perms.manage = false
    adminList.mockResolvedValue({ items: [KEY], total: 1 })
    adminRevoke.mockResolvedValue(undefined)
    adminRevokeAll.mockResolvedValue({ revoked: 3 })
})

describe('the inventory', () => {
    it('shows each key, whose it is, what it can do and when it was used', async () => {
        render(<AdminApiKeys />)
        const row = (await screen.findByText('etl')).closest('tr')!
        expect(within(row).getByText('dana@example.com')).toBeInTheDocument()
        expect(within(row).getByText('Data: read & write')).toBeInTheDocument()
        expect(within(row).getByText('Only from 10.0.0.0/8')).toBeInTheDocument()
        expect(within(row).getByText('10.1.2.3')).toBeInTheDocument()
        expect(adminList).toHaveBeenCalledWith(expect.objectContaining({ status: 'active', offset: 0 }))
    })

    it('filters to keys nobody has used in 90 days', async () => {
        render(<AdminApiKeys />)
        await screen.findByText('etl')
        await userEvent.click(screen.getByRole('checkbox', { name: /unused for 90 days/i }))
        await waitFor(() => expect(adminList).toHaveBeenLastCalledWith(
            expect.objectContaining({ unusedDays: 90 }),
        ))
    })

    it('offers revoking only to those who may manage users', async () => {
        render(<AdminApiKeys />)
        await screen.findByText('etl')
        expect(screen.queryByRole('button', { name: /revoke/i })).not.toBeInTheDocument()
    })

    it('revokes one key, or every key of its owner', async () => {
        perms.manage = true
        render(<AdminApiKeys />)
        const row = (await screen.findByText('etl')).closest('tr')!
        await userEvent.click(within(row).getByRole('button', { name: /revoke…/i }))
        await userEvent.click(within(row).getByRole('button', { name: /all of theirs/i }))
        await waitFor(() => expect(adminRevokeAll).toHaveBeenCalledWith('usr_1'))
        expect(notify).toHaveBeenCalledWith('success', '3 keys of Dana revoked.')

        await userEvent.click(within((await screen.findByText('etl')).closest('tr')!).getByRole('button', { name: /revoke…/i }))
        await userEvent.click(within(screen.getByText('etl').closest('tr')!).getByRole('button', { name: /^revoke$/i }))
        await waitFor(() => expect(adminRevoke).toHaveBeenCalledWith('apk_1'))
    })
})
