/**
 * One service account's own page: how it stands and who answers for it, then
 * its keys — made, rotated and revoked through the account's own routes, in
 * words that name the account rather than you. Its managers run it here, and
 * the page offers each person only what the server's `can` says they may do.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ServiceAccountPage } from '../ServiceAccountPage'
import { apiKey, inDays, options as opts } from '@/components/apiKeys/__tests__/fixtures'
import type { ServiceAccountCan, ServiceAccountDetail } from '@/services/serviceAccountService'

const { sa, client, keysOf, notify, feature, perms, searchDirectory, listPage, requestableRoles, ar, directory } = vi.hoisted(() => {
    const client = {
        list: vi.fn(), options: vi.fn(), revoke: vi.fn(), get: vi.fn(), rotate: vi.fn(),
        searchResources: vi.fn(), create: vi.fn(), preview: vi.fn(), lastUse: vi.fn(), update: vi.fn(),
    }
    return {
        sa: {
            get: vi.fn(), update: vi.fn(), disable: vi.fn(), enable: vi.fn(), addManager: vi.fn(),
            removeManager: vi.fn(), grantRole: vi.fn(), revokeRole: vi.fn(),
        },
        client, keysOf: vi.fn(() => client), notify: vi.fn(), feature: { on: true },
        perms: new Set<string>(),
        searchDirectory: vi.fn(), listPage: vi.fn(), requestableRoles: vi.fn(), directory: vi.fn(),
        ar: { submit: vi.fn(), extend: vi.fn(), withdraw: vi.fn() },
    }
})

vi.mock('@/services/serviceAccountService', () => ({ serviceAccountService: sa }))
vi.mock('@/services/apiKeyService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/services/apiKeyService')>()),
    serviceAccountKeys: keysOf,
}))
vi.mock('@/services/userDirectoryService', () => ({ searchDirectory }))
vi.mock('@/services/workspaceService', () => ({ workspaceService: { listPage, directory } }))
vi.mock('@/services/accessRequestsService', () => ({ accessRequestsService: { requestableRoles, ...ar } }))
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
vi.mock('@/store/auth', () => ({ usePermission: (perm: string) => perms.has(perm) }))

/** What one of its managers may do. */
const MANAGER: ServiceAccountCan = {
    view: true, edit: true, disable: true, enable: true, managers: true, keys: true, grant: false, revoke: true,
    request: true,
}

const ADA = {
    type: 'user' as const, id: 'usr_ada', name: 'Ada Lovelace', email: 'ada@example.com', inGoodStanding: true,
    membersInGoodStanding: null, addedAt: '2026-10-01T00:00:00+00:00', addedBy: 'usr_admin',
}

function account(over: Partial<ServiceAccountDetail> = {}): ServiceAccountDetail {
    return {
        id: 'svc_sync', name: 'Metadata sync', description: 'Reads graph metadata nightly', status: 'active',
        createdAt: '2026-10-01T00:00:00+00:00', createdBy: 'usr_admin',
        managers: [
            ADA,
            {
                type: 'group', id: 'grp_data', name: 'Data platform', email: null, inGoodStanding: false,
                membersInGoodStanding: 0, addedAt: '2026-10-01T00:00:00+00:00', addedBy: 'usr_admin',
            },
        ],
        managed: true, singleManager: true, unmanagedSince: null, pausesAt: null, adminHold: false, handOver: null,
        roles: [{ bindingId: 'rb_1', workspaceId: 'ws1', workspaceName: 'Finance', role: 'workspace_viewer', grantedAt: null, expiresAt: null }],
        requests: [],
        liveKeys: 1,
        can: MANAGER,
        ...over,
    }
}

const KEY = apiKey({ id: 'apk_s1', name: 'nightly metadata', prefix: 'nxsat_AbCdEfGh', kind: 'service' })

function renderPage() {
    return render(
        <MemoryRouter initialEntries={['/service-accounts/svc_sync']}>
            <Routes>
                <Route path="/service-accounts/:accountId" element={<ServiceAccountPage />} />
                <Route path="/me/api-keys" element={<p>Your API keys</p>} />
            </Routes>
        </MemoryRouter>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    feature.on = true
    perms.clear()
    sa.get.mockResolvedValue(account())
    client.list.mockResolvedValue([KEY])
    client.options.mockResolvedValue(opts())
    client.revoke.mockResolvedValue(undefined)
    client.get.mockReturnValue(new Promise(() => {}))
    searchDirectory.mockResolvedValue({ users: [{ id: 'usr_bea', displayName: 'Bea Smith', email: 'bea@example.com' }], groups: [] })
    listPage.mockResolvedValue({ items: [], totalCount: 0 })
    directory.mockRejectedValue(new Error('switched off'))
    requestableRoles.mockResolvedValue({ roles: [] })
})

describe('the account', () => {
    it('says how it stands, who manages it, and where it has a role', async () => {
        renderPage()
        expect(await screen.findByRole('heading', { name: 'Metadata sync' })).toBeInTheDocument()
        expect(sa.get).toHaveBeenCalledWith('svc_sync')
        expect(keysOf).toHaveBeenCalledWith('svc_sync')
        const about = screen.getByRole('region', { name: 'About this service account' })
        expect(within(about).getByText('Single manager')).toBeInTheDocument()
        const managers = within(about).getByRole('list', { name: 'Managers' })
        expect(within(managers).getByText('Ada Lovelace')).toBeInTheDocument()
        expect(within(managers).getByText('Data platform')).toBeInTheDocument()
        expect(within(managers).getByText('Can’t act now')).toBeInTheDocument()
        expect(within(about).getByText(/anyone in data platform can make keys that act as “metadata sync”/i)).toBeInTheDocument()
        expect(within(about).getByRole('list', { name: 'Roles' })).toHaveTextContent('Finance · Workspace viewer')
    })

    it('says until when its keys work while nobody manages it', async () => {
        sa.get.mockResolvedValue(account({ managed: false, singleManager: false, pausesAt: inDays(5) }))
        renderPage()
        const about = await screen.findByRole('region', { name: 'About this service account' })
        expect(within(about).getByText(/needs a manager — keys pause/i)).toBeInTheDocument()
    })

    it('is not there for someone who does not manage it', async () => {
        sa.get.mockRejectedValue(Object.assign(new Error('Service account not found'), { status: 404 }))
        renderPage()
        expect(await screen.findByRole('alert')).toHaveTextContent(/may not manage it/i)
        expect(client.list).not.toHaveBeenCalled()
    })
})

describe('running it', () => {
    it('lets its managers rename it, disable it and take a role away — but not give one', async () => {
        sa.disable.mockResolvedValue(account({ status: 'disabled' }))
        sa.revokeRole.mockResolvedValue(undefined)
        renderPage()
        const about = await screen.findByRole('region', { name: 'About this service account' })
        expect(within(about).getByRole('button', { name: /rename or describe/i })).toBeInTheDocument()
        expect(within(about).queryByRole('button', { name: /give role/i })).not.toBeInTheDocument()

        await userEvent.click(within(about).getByRole('button', { name: /^disable$/i }))
        await waitFor(() => expect(sa.disable).toHaveBeenCalledWith('svc_sync'))
        expect(await within(about).findByRole('button', { name: /^enable$/i })).toBeInTheDocument()

        await userEvent.click(within(about).getByRole('button', { name: 'Take away its role in Finance' }))
        await waitFor(() => expect(sa.revokeRole).toHaveBeenCalledWith('svc_sync', 'rb_1'))
        expect(sa.get).toHaveBeenCalledTimes(2)                       // read again: a removal returns nothing
    })

    it('offers its managers no way to enable it while an administrator holds it disabled', async () => {
        sa.get.mockResolvedValue(account({ status: 'disabled', adminHold: true, can: { ...MANAGER, enable: false } }))
        renderPage()
        const about = await screen.findByRole('region', { name: 'About this service account' })
        expect(within(about).getByText(/an administrator disabled it: its keys don’t work until an administrator enables it/i)).toBeInTheDocument()
        expect(within(about).queryByRole('button', { name: /^enable$/i })).not.toBeInTheDocument()
        expect(await screen.findByText(/until an administrator enables it\. you can still revoke them/i)).toBeInTheDocument()
    })

    it('keeps its last manager, unless you administer service accounts', async () => {
        sa.get.mockResolvedValue(account({ managers: [ADA] }))
        const { unmount } = renderPage()
        const about = await screen.findByRole('region', { name: 'About this service account' })
        expect(within(about).getByRole('button', { name: 'Stop Ada Lovelace managing it' })).toBeDisabled()
        unmount()

        perms.add('system:service-accounts:manage')
        sa.removeManager.mockResolvedValue(account({ managers: [], managed: false, singleManager: false }))
        renderPage()
        const asAdmin = await screen.findByRole('region', { name: 'About this service account' })
        await userEvent.click(within(asAdmin).getByRole('button', { name: 'Stop Ada Lovelace managing it' }))
        expect(sa.removeManager).not.toHaveBeenCalled()
        expect(within(asAdmin).getByText(/that is its last manager/i)).toBeInTheDocument()
        await userEvent.click(within(asAdmin).getByRole('button', { name: 'Remove Ada Lovelace, the last manager?' }))
        await waitFor(() => expect(sa.removeManager).toHaveBeenCalledWith('svc_sync', ADA))
    })

    it('says why someone can’t be made a manager', async () => {
        sa.addManager.mockRejectedValue(new Error(
            'Whoever manages a service account can do whatever it can, and Bea Smith would gain Viewer in Finance, which you can’t grant',
        ))
        renderPage()
        const about = await screen.findByRole('region', { name: 'About this service account' })
        await userEvent.type(within(about).getByLabelText('Add a manager'), 'bea')
        await userEvent.click(await within(about).findByRole('button', { name: /bea smith/i }))
        await waitFor(() => expect(notify).toHaveBeenCalledWith('error', expect.stringMatching(/would gain Viewer in Finance/)))
    })

    it('leaves the page once you no longer manage it', async () => {
        sa.removeManager.mockResolvedValue(account({ managers: [ADA], can: { ...MANAGER, view: false } }))
        renderPage()
        const about = await screen.findByRole('region', { name: 'About this service account' })
        await userEvent.click(within(about).getByRole('button', { name: 'Stop Data platform managing it' }))
        expect(await screen.findByText('Your API keys')).toBeInTheDocument()
    })

    it('gives it roles for an administrator of service accounts', async () => {
        perms.add('system:service-accounts:manage')
        sa.get.mockResolvedValue(account({ can: { ...MANAGER, grant: true } }))
        renderPage()
        const about = await screen.findByRole('region', { name: 'About this service account' })
        expect(within(about).getByLabelText('Find a workspace')).toBeInTheDocument()
        expect(within(about).getByRole('button', { name: /give role/i })).toBeDisabled()
        expect(screen.getByRole('link', { name: /service accounts/i })).toHaveAttribute('href', '/admin/service-accounts')
    })

    it('shows someone who may not make its keys how many it has, not how to make one', async () => {
        perms.add('system:audit:read')
        sa.get.mockResolvedValue(account({ can: { ...MANAGER, keys: false, managers: false } }))
        renderPage()
        const keys = await screen.findByRole('region', { name: 'Its keys' })
        expect(within(keys).getByText('1 live key.')).toBeInTheDocument()
        expect(within(keys).getByRole('link', { name: /see them/i })).toHaveAttribute('href', '/admin/api-keys?ownerId=svc_sync')
        expect(within(keys).queryByRole('button', { name: /create key/i })).not.toBeInTheDocument()
        expect(client.list).not.toHaveBeenCalled()
        expect(screen.queryByLabelText('Add a manager')).not.toBeInTheDocument()
    })
})

describe('its access', () => {
    it('asks a workspace for access for it', async () => {
        listPage.mockResolvedValue({ items: [{ id: 'ws_sales', name: 'Sales' }], totalCount: 1 })
        requestableRoles.mockResolvedValue({
            roles: [{ name: 'workspace_member', description: null, isSystem: true }], requestPolicy: 'approval', joinRole: null,
        })
        ar.submit.mockResolvedValue({ id: 'req_1' })
        renderPage()
        const about = await screen.findByRole('region', { name: 'About this service account' })
        await userEvent.click(within(about).getByRole('button', { name: /ask a workspace for access/i }))
        const dialog = await screen.findByRole('dialog', { name: 'Ask for access for “Metadata sync”' })
        await within(dialog).findByRole('option', { name: 'Sales' })
        await userEvent.selectOptions(within(dialog).getByLabelText('Workspace'), 'ws_sales')
        await within(dialog).findByRole('option', { name: 'Workspace member' })
        await userEvent.selectOptions(within(dialog).getByLabelText('Role'), 'workspace_member')
        await userEvent.type(within(dialog).getByLabelText('Why it needs this'), 'Nightly sync of Sales graphs')
        await userEvent.click(within(dialog).getByRole('button', { name: /^ask$/i }))
        await waitFor(() => expect(ar.submit).toHaveBeenCalledWith({
            targetType: 'workspace', targetId: 'ws_sales', requestedRole: 'workspace_member',
            justification: 'Nightly sync of Sales graphs', serviceAccountId: 'svc_sync',
        }))
        await waitFor(() => expect(sa.get).toHaveBeenCalledTimes(2))       // read again, with the request
    })

    it('says a workspace that takes no requests must add it', async () => {
        listPage.mockResolvedValue({ items: [{ id: 'ws_sales', name: 'Sales' }], totalCount: 1 })
        requestableRoles.mockResolvedValue({ roles: [], requestPolicy: 'closed', joinRole: null })
        renderPage()
        const about = await screen.findByRole('region', { name: 'About this service account' })
        await userEvent.click(within(about).getByRole('button', { name: /ask a workspace for access/i }))
        const dialog = await screen.findByRole('dialog', { name: 'Ask for access for “Metadata sync”' })
        await within(dialog).findByRole('option', { name: 'Sales' })
        await userEvent.selectOptions(within(dialog).getByLabelText('Workspace'), 'ws_sales')
        expect(await within(dialog).findByText(/isn’t taking requests: ask its admins to add “Metadata sync”/)).toBeInTheDocument()
        expect(within(dialog).getByRole('button', { name: /^ask$/i })).toBeDisabled()
    })

    it('shows what it waits on, and withdraws it', async () => {
        sa.get.mockResolvedValue(account({
            requests: [{
                id: 'req_1', workspaceId: 'ws_sales', workspaceName: 'Sales', role: 'workspace_member',
                createdAt: '2026-10-25T00:00:00+00:00', requestedBy: 'Ada Lovelace', bindingId: null,
            }],
        }))
        ar.withdraw.mockResolvedValue({ id: 'req_1', status: 'withdrawn' })
        renderPage()
        const waiting = await screen.findByRole('list', { name: 'Waiting on a workspace' })
        expect(waiting).toHaveTextContent('Asked for Workspace member in Sales by Ada Lovelace — waiting on the workspace')
        await userEvent.click(within(waiting).getByRole('button', { name: /withdraw/i }))
        await waitFor(() => expect(ar.withdraw).toHaveBeenCalledWith('req_1'))
    })

    it('asks to keep a role that ends', async () => {
        sa.get.mockResolvedValue(account({
            roles: [{ bindingId: 'rb_1', workspaceId: 'ws1', workspaceName: 'Finance', role: 'workspace_viewer', grantedAt: null, expiresAt: '2099-01-01T00:00:00+00:00' }],
        }))
        ar.extend.mockResolvedValue({ id: 'req_2' })
        renderPage()
        const roles = await screen.findByRole('list', { name: 'Roles' })
        expect(roles).toHaveTextContent(/until/)
        await userEvent.click(within(roles).getByRole('button', { name: /^keep$/i }))
        await waitFor(() => expect(ar.extend).toHaveBeenCalledWith({ bindingId: 'rb_1' }))
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
        sa.get.mockResolvedValue(account({ status: 'disabled' }))
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
