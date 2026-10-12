/**
 * Account → API keys: what a key can do at a glance, minting one behind a
 * fresh proof that it is you, seeing it once, and ending it.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MyApiKeysPage } from '../MyApiKeysPage'
import { parkDraft } from '@/components/apiKeys/apiKeyDraft'
import type { ApiKey, ApiKeyOptions } from '@/services/apiKeyService'

const { list, options, create, revoke, searchResources, get, notify, feature } = vi.hoisted(() => ({
    list: vi.fn(),
    options: vi.fn(),
    create: vi.fn(),
    revoke: vi.fn(),
    searchResources: vi.fn(),
    get: vi.fn(),
    notify: vi.fn(),
    feature: { on: true },
}))

vi.mock('@/services/apiKeyService', async () => {
    const actual = await vi.importActual<typeof import('@/services/apiKeyService')>(
        '@/services/apiKeyService',
    )
    return {
        ...actual,
        apiKeyService: { list, options, create, revoke, searchResources, get, rotate: vi.fn() },
    }
})
vi.mock('@/components/account/AccountShell', () => ({
    AccountShell: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    AccountCard: ({ children, title }: { children?: React.ReactNode; title?: string }) => (
        <section aria-label={title}>{children}</section>
    ),
    EmptyState: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/lib/useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
vi.mock('@/store/features', () => ({ useFeature: () => feature.on }))

const KEY: ApiKey = {
    id: 'apk_1', name: 'nightly sync', description: null, prefix: 'nxpat_AbCdEfGh', kind: 'personal',
    permissions: { views: 'read', data: 'write', publish: false },
    resources: { workspaces: [], views: ['v1'], dataSources: ['ds1', 'ds2'] },
    allowedCidrs: [], expiresAt: '2030-01-01T00:00:00+00:00', status: 'active',
    createdAt: '2026-10-01T00:00:00+00:00', createdIp: null,
    lastUsedAt: null, lastUsedIp: null, lastUsedUserAgent: null,
    revokedAt: null, revokedBy: null, revokedReason: null, rotatedFrom: null,
}
const REVOKED: ApiKey = { ...KEY, id: 'apk_0', name: 'old one', status: 'revoked', revokedAt: '2026-09-01T00:00:00+00:00' }

function opts(over: Partial<ApiKeyOptions> = {}): ApiKeyOptions {
    return {
        policy: { enabled: true, maxLifetimeDays: null, ssoSignInWindowDays: 30, maxActiveKeys: 25 },
        stepUp: { method: 'password', fresh: false },
        activeKeys: 1,
        workspaces: [{ id: 'ws1', name: 'Finance', views: 'write', data: 'read', publish: false }],
        ...over,
    }
}

const realLocation = window.location

beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    feature.on = true
    list.mockResolvedValue([KEY, REVOKED])
    options.mockResolvedValue(opts())
    searchResources.mockResolvedValue([])
    revoke.mockResolvedValue(undefined)
    Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...realLocation, href: 'http://localhost/me/api-keys', origin: 'http://localhost' },
    })
})

describe('the list', () => {
    it('says what each key can do, on what, and keeps ended keys apart', async () => {
        render(<MyApiKeysPage />)
        const yours = await screen.findByRole('region', { name: 'Your keys' })
        expect(within(yours).getByText('nightly sync')).toBeInTheDocument()
        expect(within(yours).getByText(/views: read · data: read & write on 1 view, 2 data sources/i)).toBeInTheDocument()
        expect(within(yours).getByText('Never used')).toBeInTheDocument()
        expect(within(yours).queryByText('old one')).not.toBeInTheDocument()
        const ended = screen.getByRole('region', { name: 'Expired and revoked' })
        expect(within(ended).getByText('old one')).toBeInTheDocument()
    })

    it('revokes after asking, in place', async () => {
        render(<MyApiKeysPage />)
        const row = (await screen.findByText('nightly sync')).closest('li')!
        await userEvent.click(within(row).getByRole('button', { name: /revoke/i }))
        expect(revoke).not.toHaveBeenCalled()
        await userEvent.click(within(row).getByRole('button', { name: /^revoke$/i }))
        await waitFor(() => expect(revoke).toHaveBeenCalledWith('apk_1'))
        expect(notify).toHaveBeenCalledWith('success', expect.stringContaining('revoked'))
    })

    it('with keys switched off, offers no new key but still lets you revoke', async () => {
        options.mockResolvedValue(opts({ policy: { enabled: false, maxLifetimeDays: null, ssoSignInWindowDays: 30, maxActiveKeys: 25 } }))
        render(<MyApiKeysPage />)
        expect(await screen.findByText(/API keys are turned off for this deployment/i)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /create key/i })).toBeDisabled()
        const row = screen.getByText('nightly sync').closest('li')!
        expect(within(row).getByRole('button', { name: /revoke/i })).toBeEnabled()
        expect(within(row).queryByRole('button', { name: /rotate/i })).not.toBeInTheDocument()
    })
})

describe('creating a key', () => {
    it('asks for the password, then shows the token once', async () => {
        create.mockResolvedValue({ key: { ...KEY, id: 'apk_2', name: 'ci' }, token: 'nxpat_THE_TOKEN' })
        render(<MyApiKeysPage />)
        await userEvent.click(await screen.findByRole('button', { name: /create key/i }))

        const dialog = await screen.findByRole('dialog')
        await userEvent.type(within(dialog).getByLabelText('Name'), 'ci')
        await userEvent.click(within(dialog).getByRole('radio', { name: /everything i can access/i }))
        const submit = within(dialog).getByRole('button', { name: /^create key$/i })
        expect(submit).toBeDisabled()                          // no password yet
        await userEvent.type(within(dialog).getByLabelText('Your password'), 'pw')
        await userEvent.click(submit)

        await waitFor(() => expect(create).toHaveBeenCalled())
        const body = create.mock.calls[0][0]
        expect(body).toMatchObject({
            name: 'ci', resources: 'all', currentPassword: 'pw', neverExpires: false,
            permissions: { views: 'read', data: 'none', publish: false },
        })
        expect(body.expiresAt).toBeTruthy()

        expect(await within(dialog).findByDisplayValue('nxpat_THE_TOKEN')).toBeInTheDocument()
        await userEvent.click(within(dialog).getByRole('button', { name: /i’ve copied it/i }))
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        expect(list).toHaveBeenCalledTimes(2)                  // reloaded after closing
    })

    it('with an identity provider, parks the form and signs in again', async () => {
        const { ApiKeyError } = await vi.importActual<typeof import('@/services/apiKeyService')>(
            '@/services/apiKeyService',
        )
        options.mockResolvedValue(opts({ stepUp: { method: 'sso', fresh: false } }))
        create.mockRejectedValue(new ApiKeyError(403, 'Confirm it’s you', {
            error: 'step_up_required', method: 'sso',
            loginUrl: '/api/v1/auth/corp/login?next=/me/api-keys&force=1',
        }))
        render(<MyApiKeysPage />)
        await userEvent.click(await screen.findByRole('button', { name: /create key/i }))
        const dialog = await screen.findByRole('dialog')
        expect(within(dialog).queryByLabelText('Your password')).not.toBeInTheDocument()
        await userEvent.type(within(dialog).getByLabelText('Name'), 'from sso')
        await userEvent.click(within(dialog).getByRole('radio', { name: /everything i can access/i }))
        await userEvent.click(within(dialog).getByRole('button', { name: /^create key$/i }))

        await userEvent.click(await within(dialog).findByRole('button', { name: /sign in again/i }))
        expect(window.location.href).toBe('/api/v1/auth/corp/login?next=/me/api-keys&force=1')
        const parked = JSON.parse(sessionStorage.getItem('nx-api-key-draft')!)
        expect(parked).toMatchObject({ mode: 'create', name: 'from sso', resourceMode: 'all' })
        expect(JSON.stringify(parked)).not.toMatch(/password/i)
    })

    it('reopens the form with what was filled in, on the way back', async () => {
        parkDraft({
            mode: 'create', name: 'resumed', description: '', resourceMode: 'all', workspaces: [],
            views: [], dataSources: [], permissions: { views: 'write', data: 'none', publish: true },
            expiry: '30', customDate: '', cidrs: '', grace: 0,
        })
        render(<MyApiKeysPage />)
        const dialog = await screen.findByRole('dialog')
        expect(within(dialog).getByLabelText('Name')).toHaveValue('resumed')
        expect(sessionStorage.getItem('nx-api-key-draft')).toBeNull()   // used once
    })
})
