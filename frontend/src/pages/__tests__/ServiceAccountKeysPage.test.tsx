/**
 * A service account's keys, for one of its managers: how the account stands
 * and who answers for it, then its keys — made, rotated and revoked through
 * the account's own routes, in words that name the account rather than you.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ServiceAccountKeysPage } from '../ServiceAccountKeysPage'
import { apiKey, inDays, options as opts } from '@/components/apiKeys/__tests__/fixtures'
import type { ServiceAccountDetail } from '@/services/serviceAccountService'

const { mineGet, client, keysOf, notify, feature } = vi.hoisted(() => {
    const client = {
        list: vi.fn(), options: vi.fn(), revoke: vi.fn(), get: vi.fn(), rotate: vi.fn(),
        searchResources: vi.fn(), create: vi.fn(), preview: vi.fn(), lastUse: vi.fn(), update: vi.fn(),
    }
    return { mineGet: vi.fn(), client, keysOf: vi.fn(() => client), notify: vi.fn(), feature: { on: true } }
})

vi.mock('@/services/serviceAccountService', () => ({ serviceAccountService: { mineGet } }))
vi.mock('@/services/apiKeyService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/services/apiKeyService')>()),
    serviceAccountKeys: keysOf,
}))
vi.mock('@/components/account/AccountShell', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/account/AccountShell')>()),
    AccountShell: ({ title, children }: { title: string; children?: React.ReactNode }) => (
        <div><h1>{title}</h1>{children}</div>
    ),
    AccountCard: ({ children, title, blurb }: { children?: React.ReactNode; title?: string; blurb?: string }) => (
        <section aria-label={title}><p>{blurb}</p>{children}</section>
    ),
}))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/lib/useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
vi.mock('@/store/features', () => ({ useFeature: () => feature.on }))

function account(over: Partial<ServiceAccountDetail> = {}): ServiceAccountDetail {
    return {
        id: 'svc_sync', name: 'Metadata sync', description: 'Reads graph metadata nightly', status: 'active',
        createdAt: '2026-10-01T00:00:00+00:00', createdBy: 'usr_admin',
        managers: [
            {
                type: 'user', id: 'usr_ada', name: 'Ada Lovelace', email: 'ada@example.com', inGoodStanding: true,
                membersInGoodStanding: null, addedAt: '2026-10-01T00:00:00+00:00', addedBy: 'usr_admin',
            },
            {
                type: 'group', id: 'grp_data', name: 'Data platform', email: null, inGoodStanding: false,
                membersInGoodStanding: 0, addedAt: '2026-10-01T00:00:00+00:00', addedBy: 'usr_admin',
            },
        ],
        managed: true, singleManager: true, unmanagedSince: null, pausesAt: null, handOver: null,
        roles: [{ bindingId: 'rb_1', workspaceId: 'ws1', workspaceName: 'Finance', role: 'workspace_viewer', grantedAt: null }],
        liveKeys: 1,
        ...over,
    }
}

const KEY = apiKey({ id: 'apk_s1', name: 'nightly metadata', prefix: 'nxsat_AbCdEfGh', kind: 'service' })

function renderPage() {
    return render(
        <MemoryRouter initialEntries={['/me/service-accounts/svc_sync']}>
            <Routes>
                <Route path="/me/service-accounts/:accountId" element={<ServiceAccountKeysPage />} />
            </Routes>
        </MemoryRouter>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    feature.on = true
    mineGet.mockResolvedValue(account())
    client.list.mockResolvedValue([KEY])
    client.options.mockResolvedValue(opts())
    client.revoke.mockResolvedValue(undefined)
    client.get.mockReturnValue(new Promise(() => {}))
})

describe('the account', () => {
    it('says how it stands, who manages it, and where it has a role', async () => {
        renderPage()
        expect(await screen.findByRole('heading', { name: 'Metadata sync' })).toBeInTheDocument()
        expect(keysOf).toHaveBeenCalledWith('svc_sync')
        const about = screen.getByRole('region', { name: 'About this service account' })
        expect(within(about).getByText('Single manager')).toBeInTheDocument()
        const managers = within(about).getByRole('list', { name: 'Managers' })
        expect(within(managers).getByText('Ada Lovelace')).toBeInTheDocument()
        expect(within(managers).getByText('Data platform')).toBeInTheDocument()
        expect(within(managers).getByText('Can’t act now')).toBeInTheDocument()
        expect(within(about).getByText(/everyone in a managing team can make keys/i)).toBeInTheDocument()
        expect(within(about).getByRole('list', { name: 'Roles' })).toHaveTextContent('Finance · workspace_viewer')
    })

    it('says until when its keys work while nobody manages it', async () => {
        mineGet.mockResolvedValue(account({ managed: false, singleManager: false, pausesAt: inDays(5) }))
        renderPage()
        const about = await screen.findByRole('region', { name: 'About this service account' })
        expect(within(about).getByText(/needs a manager — keys pause/i)).toBeInTheDocument()
    })

    it('is not there for someone who does not manage it', async () => {
        mineGet.mockRejectedValue(Object.assign(new Error('Service account not found'), { status: 404 }))
        renderPage()
        expect(await screen.findByRole('alert')).toHaveTextContent(/may not manage it/i)
        expect(client.list).not.toHaveBeenCalled()
    })
})

describe('its keys', () => {
    it('are the account’s, sent as nxsat_ tokens, and made in its name', async () => {
        renderPage()
        const keys = await screen.findByRole('region', { name: 'Its keys' })
        expect(await within(keys).findByText('nightly metadata')).toBeInTheDocument()
        expect(within(keys).getByText(/Bearer nxsat_/)).toBeInTheDocument()
        expect(within(keys).getByText(/acts as the account, never as you/i)).toBeInTheDocument()
        await userEvent.click(within(keys).getByRole('button', { name: /create key/i }))
        expect(await screen.findByRole('dialog', { name: 'Create a key for “Metadata sync”' })).toBeInTheDocument()
    })

    it('say a paused key waits for a manager, not for you to sign in', async () => {
        client.list.mockResolvedValue([{ ...KEY, status: 'paused' }])
        renderPage()
        const keys = await screen.findByRole('region', { name: 'Its keys' })
        expect(await within(keys).findByText(/paused while nobody manages its service account/i)).toBeInTheDocument()
        expect(within(keys).queryByText(/sign in/i)).not.toBeInTheDocument()
    })

    it('get no new one while the account is disabled, and can still be revoked', async () => {
        mineGet.mockResolvedValue(account({ status: 'disabled' }))
        renderPage()
        const keys = await screen.findByRole('region', { name: 'Its keys' })
        expect(await within(keys).findByText('nightly metadata')).toBeInTheDocument()
        expect(within(keys).getByRole('button', { name: /create key/i })).toBeDisabled()
        expect(screen.getByText('This service account is disabled')).toBeInTheDocument()
        await userEvent.click(within(keys).getByRole('button', { name: /revoke/i }))
        await userEvent.click(await within(keys).findByRole('button', { name: /^revoke$/i }))
        expect(client.revoke).toHaveBeenCalledWith('apk_s1')
    })
})
