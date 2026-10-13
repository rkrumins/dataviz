/**
 * Making a key: presets that set the rest, steps that will not let you on
 * without what they need, the server's preview asked once per visit to
 * Review, confirming it's you — by password, or a round trip to the identity
 * provider that parks the draft at Review and comes back to it — and the one
 * screen that shows the token, which will not close quietly before you say it
 * is stored.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiKeyWizard } from '../ApiKeyWizard'
import { MyApiKeysPage } from '@/pages/MyApiKeysPage'
import { freshDraft, parkDraft } from '../../apiKeyDraft'
import { apiKey, access, options as opts } from '../../__tests__/fixtures'
import { ApiKeyError, type ApiKeyOptions, type ApiKeyPreview } from '@/services/apiKeyService'

const svc = vi.hoisted(() => ({
    create: vi.fn(),
    preview: vi.fn(),
    searchResources: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    options: vi.fn(),
    revoke: vi.fn(),
    rotate: vi.fn(),
}))

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

const PREVIEW: ApiKeyPreview = {
    permissions: { views: 'read', data: 'none', publish: false }, resources: 'all', allowedCidrs: [],
    expiresAt: '2026-11-12T00:00:00Z', effectiveAccess: access(), activeKeys: 3, maxActiveKeys: 25,
}
const CREATED = { key: apiKey({ id: 'apk_9', name: 'ci' }), token: 'nxpat_THE_TOKEN_VALUE' }

const realLocation = window.location

beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    svc.preview.mockResolvedValue(PREVIEW)
    svc.create.mockResolvedValue(CREATED)
    svc.searchResources.mockImplementation((type: string) => Promise.resolve(type === 'view'
        ? [{ id: 'v_rev', name: 'Revenue lineage', workspaceId: 'ws1', workspaceName: 'Finance', level: 'read' }]
        : []))
    svc.get.mockReturnValue(new Promise(() => {}))
    Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...realLocation, href: 'http://localhost/me/api-keys', origin: 'http://localhost' },
    })
})

afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation })
})

/** Open the wizard, and let its opening focus land (the house wizard
 *  keyboard hook moves focus 250 ms after opening) before typing anything. */
async function wizard(over: Partial<ApiKeyOptions> = {}) {
    const onClose = vi.fn()
    const onCreated = vi.fn()
    render(<ApiKeyWizard options={opts(over)} onClose={onClose} onCreated={onCreated} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close the key wizard' })).toHaveFocus())
    return { onClose, onCreated }
}

const next = () => screen.getByRole('button', { name: /^next/i })

/** Custom preset, a name, everything, the defaults — to Review. */
async function toReview(name = 'ci') {
    await userEvent.click(screen.getByRole('radio', { name: /^custom/i }))
    await userEvent.type(screen.getByLabelText('Name'), name)
    await userEvent.click(next())
    await userEvent.click(await screen.findByRole('radio', { name: /everything i can access/i }))
    await userEvent.click(next())
    await screen.findByText('What may it do there?')
    await userEvent.click(next())
    await screen.findByText('How long, and from where?')
    await userEvent.click(next())
    await screen.findByText('Check it, then create it')
}

describe('presets', () => {
    it('sets access, reach and lifetime, and closes one you cannot satisfy', async () => {
        await wizard({ workspaces: [{ id: 'ws1', name: 'Finance', views: 'write', data: 'read', publish: false }] })
        const loading = screen.getByRole('radio', { name: /load data and signal refreshes/i })
        expect(loading).toBeDisabled()
        expect(loading).toHaveTextContent('You cannot change data in any workspace.')
        expect(screen.getByRole('radio', { name: /publish views from ci/i })).toBeDisabled()

        await userEvent.click(screen.getByRole('radio', { name: /read data for reporting/i }))
        expect(screen.getByLabelText('Name')).toHaveAttribute('placeholder', expect.stringContaining('Quarterly revenue dashboard'))
        await userEvent.type(screen.getByLabelText('Name'), 'dashboards')
        await userEvent.click(next())
        expect(await screen.findByRole('radio', { name: /selected views & data sources/i })).toHaveAttribute('aria-checked', 'true')
        await userEvent.click(await screen.findByRole('button', { name: /revenue lineage/i }))
        await userEvent.click(next())
        await screen.findByText('What may it do there?')
        const views = screen.getByRole('radiogroup', { name: 'Views' })
        const data = screen.getByRole('radiogroup', { name: 'Data' })
        expect(within(views).getByRole('radio', { name: /^read open views/i })).toHaveAttribute('aria-checked', 'true')
        expect(within(data).getByRole('radio', { name: /^read query graphs/i })).toHaveAttribute('aria-checked', 'true')
    })
})

describe('the steps', () => {
    it('will not go on without what each step needs', async () => {
        await wizard()
        expect(next()).toBeDisabled()                                   // no purpose, no name
        await userEvent.click(screen.getByRole('radio', { name: /^custom/i }))
        expect(next()).toBeDisabled()                                   // no name
        await userEvent.type(screen.getByLabelText('Name'), 'ci')
        await userEvent.click(next())

        await screen.findByText('What should it reach?')
        expect(next()).toBeDisabled()                                   // nothing picked
        await userEvent.click(await screen.findByRole('button', { name: /revenue lineage/i }))
        expect(next()).toBeEnabled()
        await userEvent.click(next())

        await screen.findByText('What may it do there?')
        await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Views' })).getByRole('radio', { name: /^no access/i }))
        expect(next()).toBeDisabled()                                   // a key that can do nothing
        await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Data' })).getByRole('radio', { name: /^read query/i }))
        expect(next()).toBeEnabled()
        await userEvent.click(next())

        await screen.findByText('How long, and from where?')
        const networks = screen.getByLabelText('Allowed networks')
        await userEvent.type(networks, '10.0.0.300{enter}')
        expect(screen.getByText(/has a part above 255/)).toBeInTheDocument()
        expect(next()).toBeDisabled()                                   // a network that cannot be
        await userEvent.click(screen.getByRole('button', { name: 'Remove 10.0.0.300' }))
        await userEvent.click(screen.getByRole('button', { name: /add this address \(203\.0\.113\.24\)/i }))
        expect(next()).toBeEnabled()
    })

    it('summarises finished steps in the stepper, and goes back to one', async () => {
        await wizard()
        await toReview('nightly sync')
        const steps = screen.getByRole('list', { name: 'Steps' })
        expect(within(steps).getByText('nightly sync')).toBeInTheDocument()
        expect(within(steps).getByText('Everything you can access')).toBeInTheDocument()
        await userEvent.click(within(steps).getByRole('button', { name: /reach/i }))
        expect(await screen.findByText('What should it reach?')).toBeInTheDocument()
    })
})

describe('the review', () => {
    it('asks the server for a preview once each time it is entered', async () => {
        await wizard()
        await toReview()
        await waitFor(() => expect(svc.preview).toHaveBeenCalledTimes(1))
        expect(svc.preview.mock.calls[0][0]).toMatchObject({ name: 'ci', resources: 'all', neverExpires: false })
        expect(svc.preview.mock.calls[0][0]).not.toHaveProperty('currentPassword')
        expect(await screen.findByText('Finance')).toBeInTheDocument()  // the preview's effective access

        await userEvent.type(screen.getByLabelText('Your password'), 'pw')
        expect(svc.preview).toHaveBeenCalledTimes(1)                    // typing is not a new visit

        await userEvent.click(screen.getByRole('button', { name: /back/i }))
        await screen.findByText('How long, and from where?')
        await userEvent.click(next())
        await screen.findByText('Check it, then create it')
        await waitFor(() => expect(svc.preview).toHaveBeenCalledTimes(2))
    })

    it('says what the key will do, and how far a leaked copy would reach', async () => {
        await wizard()
        await toReview()
        expect(screen.getByText('Act as you to read views')).toBeInTheDocument()
        expect(screen.getByText(/on everything you can access/i)).toBeInTheDocument()
        expect(screen.getByRole('meter', { name: 'Exposure' })).toHaveAttribute('aria-valuetext', 'Moderate')
        expect(screen.getByText('Works from any network')).toBeInTheDocument()
    })
})

describe('confirming it is you', () => {
    it('asks for the password, then shows the token once', async () => {
        const { onCreated, onClose } = await wizard()
        await toReview()
        const create = screen.getByRole('button', { name: /^create key$/i })
        expect(create).toBeDisabled()                                   // no password yet
        await userEvent.type(screen.getByLabelText('Your password'), 'pw')
        await userEvent.click(create)

        await waitFor(() => expect(svc.create).toHaveBeenCalled())
        expect(svc.create.mock.calls[0][0]).toMatchObject({
            name: 'ci', resources: 'all', currentPassword: 'pw', neverExpires: false,
            permissions: { views: 'read', data: 'none', publish: false }, allowedCidrs: [],
        })
        const box = await screen.findByLabelText('Your new API key')
        expect(box).not.toHaveValue('nxpat_THE_TOKEN_VALUE')           // hidden until asked
        await userEvent.click(screen.getByRole('button', { name: 'Show the key' }))
        expect(box).toHaveValue('nxpat_THE_TOKEN_VALUE')
        expect(onCreated).not.toHaveBeenCalled()
        expect(onClose).not.toHaveBeenCalled()
    })

    it('says so when the password is wrong, and creates nothing', async () => {
        svc.create.mockRejectedValue(new ApiKeyError(403, 'No', { error: 'step_up_failed' }))
        await wizard()
        await toReview()
        await userEvent.type(screen.getByLabelText('Your password'), 'wrong')
        await userEvent.click(screen.getByRole('button', { name: /^create key$/i }))
        expect(await screen.findByText(/that password isn’t right/i)).toBeInTheDocument()
        expect(screen.getByLabelText('Your password')).toHaveValue('')
    })

    it('with an identity provider, parks the draft at Review without secrets and goes to sign in', async () => {
        svc.create.mockRejectedValue(new ApiKeyError(403, 'Confirm it’s you', {
            error: 'step_up_required', method: 'sso', loginUrl: '/api/v1/auth/corp/login?next=/me/api-keys&force=1',
        }))
        await wizard({ stepUp: { method: 'sso', fresh: false } })
        await toReview('from sso')
        expect(screen.queryByLabelText('Your password')).not.toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: /continue with your identity provider/i }))

        await waitFor(() => expect(window.location.href).toBe('/api/v1/auth/corp/login?next=/me/api-keys&force=1'))
        const parked = JSON.parse(sessionStorage.getItem('nx-api-key-draft')!)
        expect(parked).toMatchObject({ v: 2, mode: 'create', step: 'review', name: 'from sso', resourceMode: 'all', preset: 'custom' })
        expect(JSON.stringify(parked)).not.toMatch(/password|token/i)
    })

    it('with a gateway it can ask, creates outright — and says plainly when the gateway does not answer', async () => {
        svc.create
            .mockRejectedValueOnce(new ApiKeyError(503, 'Your company sign-in didn’t answer, so it can’t confirm it’s you right now. Try again in a moment.', {
                error: 'gateway_unreachable',
            }))
            .mockResolvedValueOnce(CREATED)
        await wizard({ stepUp: { method: 'sso', fresh: true } })
        await toReview()
        expect(screen.queryByLabelText('Your password')).not.toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: /^create key$/i }))
        expect(await screen.findByText(/didn’t answer/)).toBeInTheDocument()
        expect(window.location.href).toBe('http://localhost/me/api-keys')      // nowhere to go
        await userEvent.click(screen.getByRole('button', { name: /^create key$/i }))
        expect(await screen.findByLabelText('Your new API key')).toBeInTheDocument()
    })

    it('comes back to Review with what was chosen, on the way back', async () => {
        svc.list.mockResolvedValue([])
        svc.options.mockResolvedValue(opts({ stepUp: { method: 'sso', fresh: true } }))
        parkDraft({
            ...freshDraft(null), step: 'review', preset: 'custom', name: 'resumed', resourceMode: 'all',
            permissions: { views: 'write', data: 'none', publish: true },
        })
        render(<MyApiKeysPage />)
        expect(await screen.findByText('Check it, then create it')).toBeInTheDocument()
        expect(screen.getByText('“resumed” will')).toBeInTheDocument()
        expect(screen.getByText('Act as you to read and change views and publish them to everyone')).toBeInTheDocument()
        expect(sessionStorage.getItem('nx-api-key-draft')).toBeNull()   // used once
        await waitFor(() => expect(svc.preview).toHaveBeenCalledTimes(1))
        expect(screen.getByRole('button', { name: /^create key$/i })).toBeEnabled()
    })

    it('says up front when this sign-in cannot confirm it is you, rather than after the form', async () => {
        await wizard({ stepUpAvailable: false })
        expect(screen.getByText(/Administration → Features → Authentication/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /^next/i })).not.toBeInTheDocument()
        expect(screen.queryByRole('radio', { name: /^custom/i })).not.toBeInTheDocument()
    })

    it('explains a refusal to confirm, and stops offering to create', async () => {
        svc.create.mockRejectedValue(new ApiKeyError(403, 'Unavailable', { error: 'step_up_unavailable' }))
        await wizard()
        await toReview()
        await userEvent.type(screen.getByLabelText('Your password'), 'pw')
        await userEvent.click(screen.getByRole('button', { name: /^create key$/i }))
        expect(await screen.findByText(/Administration → Features → Authentication/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /^create key$/i })).toBeDisabled()
    })
})

describe('the reveal', () => {
    async function revealed() {
        const handlers = await wizard()
        await toReview()
        await userEvent.type(screen.getByLabelText('Your password'), 'pw')
        await userEvent.click(screen.getByRole('button', { name: /^create key$/i }))
        await screen.findByLabelText('Your new API key')
        return handlers
    }

    it('lets you leave only once you say the key is stored', async () => {
        const { onCreated, onClose } = await revealed()
        const done = screen.getByRole('button', { name: /done/i })
        expect(done).toBeDisabled()
        await userEvent.click(screen.getByRole('checkbox', { name: /i’ve stored it somewhere safe/i }))
        expect(done).toBeEnabled()
        await userEvent.click(done)
        expect(onCreated).toHaveBeenCalled()
        expect(onClose).toHaveBeenCalled()
    })

    it('asks before Escape closes it, and Escape closes only the question', async () => {
        const { onClose } = await revealed()
        fireEvent.keyDown(document, { key: 'Escape' })
        const ask = await screen.findByRole('alertdialog', { name: /close without storing the key/i })
        expect(ask).toBeInTheDocument()
        fireEvent.keyDown(document, { key: 'Escape' })
        await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
        expect(onClose).not.toHaveBeenCalled()
        expect(screen.getByLabelText('Your new API key')).toBeInTheDocument()

        await userEvent.click(screen.getByRole('checkbox', { name: /i’ve stored it somewhere safe/i }))
        fireEvent.keyDown(document, { key: 'Escape' })
        expect(onClose).toHaveBeenCalled()
    })

    it('offers first calls that keep the key off the command line', async () => {
        await revealed()
        const curl = screen.getByRole('tabpanel')
        expect(curl).toHaveTextContent('printf')
        expect(curl).not.toHaveTextContent('nxpat_THE_TOKEN_VALUE')
        await userEvent.click(screen.getByRole('tab', { name: '.env' }))
        expect(screen.getByRole('tabpanel')).toHaveTextContent('API_KEY=nxpat_THE_TOKEN_VALUE')
    })

    it('lights up when the key is first used — by watching its record, never by calling with it', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        try {
            svc.get.mockResolvedValueOnce({ ...apiKey({ id: 'apk_9' }), lastUsedAt: null })
                .mockResolvedValueOnce({ ...apiKey({ id: 'apk_9' }), lastUsedAt: '2026-10-13T12:00:00Z', lastUsedIp: '198.51.100.7', lastUsedUserAgent: 'curl/8.5.0' })
            await revealed()
            expect(screen.getByText('Waiting for the first call…')).toBeInTheDocument()
            await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
            expect(svc.get).toHaveBeenCalledWith('apk_9', expect.any(AbortSignal))
            await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
            expect(await screen.findByText(/first call from 198\.51\.100\.7 · curl 8\.5\.0/i)).toBeInTheDocument()
            expect(svc.get).toHaveBeenCalledTimes(2)
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('closing early', () => {
    it('asks before throwing away a half-made key', async () => {
        const { onClose } = await wizard()
        await userEvent.click(screen.getByRole('radio', { name: /^custom/i }))
        fireEvent.keyDown(document, { key: 'Escape' })
        await userEvent.click(await screen.findByRole('button', { name: 'Keep editing' }))
        expect(onClose).not.toHaveBeenCalled()
        fireEvent.keyDown(document, { key: 'Escape' })
        await userEvent.click(await screen.findByRole('button', { name: 'Discard' }))
        expect(onClose).toHaveBeenCalled()
    })
})
