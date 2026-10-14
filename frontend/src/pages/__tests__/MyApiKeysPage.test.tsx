/**
 * Account → API keys: what a key can do at a glance, what needs doing first,
 * and ending a key in place. Making one is the wizard's, and is pinned in
 * `components/apiKeys/wizard/__tests__`.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MyApiKeysPage } from '../MyApiKeysPage'
import { apiKey, inDays, options as opts, usage } from '@/components/apiKeys/__tests__/fixtures'

const { list, options, revoke, get, rotate, notify, feature } = vi.hoisted(() => ({
    list: vi.fn(),
    options: vi.fn(),
    revoke: vi.fn(),
    get: vi.fn(),
    rotate: vi.fn(),
    notify: vi.fn(),
    feature: { on: true },
}))

vi.mock('@/services/apiKeyService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/services/apiKeyService')>()),
    apiKeyService: { list, options, revoke, get, rotate, searchResources: vi.fn(), create: vi.fn(), preview: vi.fn() },
}))
vi.mock('@/components/account/AccountShell', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/account/AccountShell')>()),
    AccountShell: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    AccountCard: ({ children, title, blurb }: { children?: React.ReactNode; title?: string; blurb?: string }) => (
        <section aria-label={title}><p>{blurb}</p>{children}</section>
    ),
}))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/lib/useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
vi.mock('@/store/features', () => ({ useFeature: () => feature.on }))

const KEY = apiKey()
const REVOKED = apiKey({ id: 'apk_0', name: 'old one', status: 'revoked', revokedAt: '2026-09-01T00:00:00+00:00', revokedReason: 'owner' })

beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    feature.on = true
    list.mockResolvedValue([KEY, REVOKED])
    options.mockResolvedValue(opts())
    revoke.mockResolvedValue(undefined)
    get.mockReturnValue(new Promise(() => {}))
})

describe('the list', () => {
    it('says what each key can do, on what, and keeps ended keys apart', async () => {
        render(<MyApiKeysPage />)
        const yours = await screen.findByRole('region', { name: 'Your keys' })
        expect(within(yours).getByText('nightly sync')).toBeInTheDocument()
        expect(within(yours).getByText('Views: read')).toBeInTheDocument()
        expect(within(yours).getByText('Data: read & write')).toBeInTheDocument()
        expect(within(yours).getByText('1 view, 2 data sources')).toBeInTheDocument()
        expect(within(yours).getByText('Never used')).toBeInTheDocument()
        expect(within(yours).queryByText('old one')).not.toBeInTheDocument()
        const ended = screen.getByRole('region', { name: 'Expired and revoked' })
        expect(within(ended).getByText('old one')).toBeInTheDocument()
        expect(within(ended).getByText(/you revoked it/i)).toBeInTheDocument()
    })

    it('says how to send a key without quoting markdown at you', async () => {
        render(<MyApiKeysPage />)
        const yours = await screen.findByRole('region', { name: 'Your keys' })
        expect(within(yours).getByText(/bearer token in the authorization header/i)).toBeInTheDocument()
        expect(yours.textContent).not.toContain('`')
    })

    it('sums the overview: keys in use of the limit, expiring, paused, requests today', async () => {
        list.mockResolvedValue([
            apiKey({ usage: usage({ daily14: [...Array(13).fill(0), 7] }) }),
            apiKey({ id: 'apk_2', name: 'soon', expiresAt: inDays(3), usage: usage({ daily14: [...Array(13).fill(0), 5] }) }),
        ])
        render(<MyApiKeysPage />)
        await screen.findByText('soon')
        expect(screen.getByText('Keys in use').parentElement).toHaveTextContent('2/ 25')
        expect(screen.getByText('Expiring within 7 days').parentElement).toHaveTextContent('1')
        expect(screen.getByText('Requests today').parentElement).toHaveTextContent('12')
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

    it('says up front when this sign-in cannot confirm it is you, and offers nothing that would be refused', async () => {
        options.mockResolvedValue(opts({ stepUpAvailable: false }))
        render(<MyApiKeysPage />)
        expect(await screen.findByText(/Administration → Features → Authentication/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /create key/i })).toBeDisabled()
        const row = screen.getByText('nightly sync').closest('li')!
        expect(within(row).queryByRole('button', { name: /rotate/i })).not.toBeInTheDocument()
    })

    it('says it is password sign-in being off when that is why keys cannot be made', async () => {
        options.mockResolvedValue(opts({ stepUpAvailable: false, stepUpReason: 'passwords_off' }))
        render(<MyApiKeysPage />)
        expect(await screen.findByText(/password sign-in is switched off/i)).toBeInTheDocument()
        expect(screen.queryByText(/Administration → Features → Authentication/)).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: /create key/i })).toBeDisabled()
    })

    it('reads older history on request', async () => {
        render(<MyApiKeysPage />)
        await screen.findByText('nightly sync')
        expect(list).toHaveBeenLastCalledWith(undefined)
        await userEvent.click(screen.getByRole('button', { name: /show older history/i }))
        await waitFor(() => expect(list).toHaveBeenLastCalledWith('all'))
        expect(screen.queryByRole('button', { name: /show older history/i })).not.toBeInTheDocument()
    })
})

describe('what needs doing first', () => {
    it('offers to rotate a key that expires within a week', async () => {
        list.mockResolvedValue([apiKey({ expiresAt: inDays(3) })])
        render(<MyApiKeysPage />)
        const item = (await screen.findByText(/“nightly sync” expires in 3 days/i)).closest('li') as HTMLElement
        expect(screen.getByRole('region', { name: 'Needs your attention' })).toContainElement(item)
        await userEvent.click(within(item).getByRole('button', { name: /rotate/i }))
        expect(await screen.findByRole('dialog', { name: /rotate “nightly sync”/i })).toBeInTheDocument()
    })

    it('sends someone with paused keys to sign in again, rather than renewing them', async () => {
        list.mockResolvedValue([apiKey({ status: 'paused' })])
        render(<MyApiKeysPage />)
        const banner = (await screen.findByText(/“nightly sync” is paused/i)).closest('li') as HTMLElement
        expect(within(banner).getByRole('link', { name: /sign in to resume/i }))
            .toHaveAttribute('href', `${window.location.origin}/api/v1/auth/corp/login?next=/me/api-keys`)
        expect(banner).toHaveTextContent(/nothing was revoked/i)
        expect(banner).toHaveTextContent(/30 days/)

        const card = within(screen.getByRole('region', { name: 'Your keys' })).getByText('nightly sync').closest('li') as HTMLElement
        expect(within(card).getByRole('link', { name: /sign in to resume/i }))
            .toHaveAttribute('href', `${window.location.origin}/api/v1/auth/corp/login?next=/me/api-keys`)
        expect(within(card).getByRole('button', { name: /^rotate$/i })).toBeInTheDocument()
        expect(within(card).queryByRole('button', { name: /renew/i })).not.toBeInTheDocument()
        expect(card).toHaveTextContent(/nothing was revoked/i)
    })

    it('offers nothing to sign in through when there is nowhere to sign in', async () => {
        options.mockResolvedValue(opts({ ssoSignInUrl: null }))
        list.mockResolvedValue([apiKey({ status: 'paused' })])
        render(<MyApiKeysPage />)
        await screen.findByText(/“nightly sync” is paused/i)
        expect(screen.queryByRole('link', { name: /sign in to resume/i })).not.toBeInTheDocument()
    })

    it('says when an expired key is still being called, and offers to renew it', async () => {
        list.mockResolvedValue([apiKey({
            status: 'expired', expiresAt: inDays(-2),
            usage: usage({ daily14: [...Array(12).fill(0), 9, 4] }),
        })])
        render(<MyApiKeysPage />)
        const banner = (await screen.findByText(/expired, but something still calls it/i)).closest('li') as HTMLElement
        expect(banner).toHaveTextContent('13 requests in the last 7 days were refused')
        await userEvent.click(within(banner).getByRole('button', { name: /renew/i }))
        expect(await screen.findByRole('dialog', { name: /renew “nightly sync”/i })).toBeInTheDocument()
    })
})

describe('before the first key', () => {
    it('says what a key is, and how to make one', async () => {
        list.mockResolvedValue([])
        render(<MyApiKeysPage />)
        await screen.findByText('Let scripts and services work as you')
        const hero = screen.getByRole('region', { name: 'Your keys' })
        expect(within(hero).getByText('Only what you choose')).toBeInTheDocument()
        expect(within(hero).getByText('Shown once, kept safe')).toBeInTheDocument()
        expect(within(hero).getByText('Yours to stop')).toBeInTheDocument()
        expect(within(hero).getByRole('link', { name: /how keys work/i })).toHaveAttribute('href', '/guide/api-keys')
        expect(within(hero).getByRole('link', { name: /calling the api/i })).toHaveAttribute('href', '/docs/api-guide')
        await userEvent.click(within(hero).getByRole('button', { name: /create your first key/i }))
        expect(await screen.findByRole('dialog', { name: /create an api key/i })).toBeInTheDocument()
    })
})
