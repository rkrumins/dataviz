/**
 * Rotating, renewing and editing a key.
 *
 * Rotation chooses how long the old token lives on, and says when that is;
 * renewing a key that has stopped has nothing to keep, so it sends no grace
 * and shows what the key reaches today first; editing sends only what
 * changed, and only ever the name and description.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EditKeyDialog } from '../EditKeyDialog'
import { RotateKeyDialog } from '../RotateKeyDialog'
import { access, apiKey, detail, inDays, options as opts } from './fixtures'
import { ApiKeyError, type ApiKey } from '@/services/apiKeyService'
import { useAuthStore } from '@/store/auth'

const svc = vi.hoisted(() => ({ rotate: vi.fn(), get: vi.fn(), update: vi.fn() }))
vi.mock('@/services/apiKeyService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/services/apiKeyService')>()),
    apiKeyService: svc,
}))
const reauth = vi.hoisted(() => ({ attemptSilentReauth: vi.fn(), me: vi.fn() }))
vi.mock('@/services/backchannelReauth', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/services/backchannelReauth')>()),
    attemptSilentReauth: reauth.attemptSilentReauth,
}))
vi.mock('@/services/authService', async (importOriginal) => {
    const real = await importOriginal<typeof import('@/services/authService')>()
    return { ...real, authService: { ...real.authService, me: reauth.me } }
})

beforeEach(() => {
    vi.clearAllMocks()
    svc.rotate.mockResolvedValue({ key: apiKey({ id: 'apk_2' }), token: 'nxpat_NEW_TOKEN' })
    svc.get.mockResolvedValue(detail({ effectiveAccess: access({ workspaces: [{ id: 'ws1', name: 'Finance', views: 'read', data: 'write', publish: false }] }) }))
})

function rotateDialog(key: ApiKey, over = {}) {
    const onClose = vi.fn()
    const onDone = vi.fn()
    render(<RotateKeyDialog apiKey={key} options={opts(over)} onClose={onClose} onDone={onDone} />)
    return { onClose, onDone }
}

describe('rotating a live key', () => {
    it('chooses how long the old one keeps working, and says when that ends', async () => {
        rotateDialog(apiKey())
        expect(screen.getByRole('dialog', { name: /rotate “nightly sync”/i })).toBeInTheDocument()
        const grace = screen.getByRole('radiogroup', { name: 'Old key keeps working' })
        expect(within(grace).getByRole('radio', { name: /in 1 day/i })).toHaveAttribute('aria-checked', 'true')
        expect(screen.getByText(/your old key stops working tomorrow at/i)).toBeInTheDocument()

        await userEvent.click(within(grace).getByRole('radio', { name: /right away/i }))
        expect(screen.getByText(/stops working the moment the new one is created/i)).toBeInTheDocument()
        await userEvent.click(within(grace).getByRole('radio', { name: /in 1 hour/i }))
        // An hour from now: today, unless the test runs in the day's last hour.
        expect(screen.getByText(/your old key stops working (today|tomorrow) at/i)).toBeInTheDocument()

        const submit = screen.getByRole('button', { name: /^rotate key$/i })
        expect(submit).toBeDisabled()
        await userEvent.type(screen.getByLabelText('Your password'), 'pw')
        await userEvent.click(submit)
        await waitFor(() => expect(svc.rotate).toHaveBeenCalledWith('apk_1', { graceSeconds: 3600, currentPassword: 'pw' }))
        expect(await screen.findByLabelText('Your new API key')).toBeInTheDocument()
    })

    it('can give the new key a different lifetime', async () => {
        rotateDialog(apiKey({ createdAt: inDays(-80), expiresAt: inDays(10) }))
        expect(screen.getByRole('radio', { name: /same as before/i })).toHaveTextContent('90 days again')
        await userEvent.click(screen.getByRole('radio', { name: /^7 days/i }))
        await userEvent.type(screen.getByLabelText('Your password'), 'pw')
        await userEvent.click(screen.getByRole('button', { name: /^rotate key$/i }))
        await waitFor(() => expect(svc.rotate).toHaveBeenCalled())
        expect(svc.rotate.mock.calls[0][1]).toMatchObject({ graceSeconds: 86400, neverExpires: false, expiresAt: expect.any(String) })
    })

    it('says it is password sign-in being off when the rotation is refused for it', async () => {
        svc.rotate.mockRejectedValue(new ApiKeyError(403, 'Refused', {
            error: 'step_up_unavailable', method: 'password', reason: 'passwords_off',
        }))
        rotateDialog(apiKey())
        await userEvent.type(screen.getByLabelText('Your password'), 'pw')
        await userEvent.click(screen.getByRole('button', { name: /^rotate key$/i }))
        expect(await screen.findByText(/password sign-in is switched off/i)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /^rotate key$/i })).toBeDisabled()
    })

    it('confirms through an Enterprise gateway without leaving the page, and rotates', async () => {
        useAuthStore.setState({ user: { id: 'usr_me' } } as never)
        reauth.me.mockResolvedValue({ user: { id: 'usr_me' } })
        reauth.attemptSilentReauth.mockResolvedValue('recovered')
        svc.rotate.mockRejectedValueOnce(new ApiKeyError(403, 'Confirm it’s you', {
            error: 'step_up_required', method: 'sso', gateway: 'corp-gateway',
        }))
        rotateDialog(apiKey(), { stepUp: { method: 'sso', fresh: false } })
        await userEvent.click(screen.getByRole('button', { name: /continue with your identity provider/i }))
        expect(await screen.findByLabelText('Your new API key')).toBeInTheDocument()
        expect(reauth.attemptSilentReauth).toHaveBeenCalledWith('corp-gateway')
        expect(svc.rotate).toHaveBeenCalledTimes(2)
    })

    it('says so when the key was already replaced', async () => {
        svc.rotate.mockRejectedValue(new ApiKeyError(409, 'Conflict', { error: 'api_key_rotated' }))
        rotateDialog(apiKey())
        await userEvent.type(screen.getByLabelText('Your password'), 'pw')
        await userEvent.click(screen.getByRole('button', { name: /^rotate key$/i }))
        expect(await screen.findByText(/already been replaced/i)).toBeInTheDocument()
    })

    it('asks before closing the reveal, and Escape answers the question first', async () => {
        const { onClose, onDone } = rotateDialog(apiKey())
        await userEvent.type(screen.getByLabelText('Your password'), 'pw')
        await userEvent.click(screen.getByRole('button', { name: /^rotate key$/i }))
        await screen.findByLabelText('Your new API key')

        fireEvent.keyDown(document, { key: 'Escape' })
        expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
        fireEvent.keyDown(document, { key: 'Escape' })
        await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
        expect(onClose).not.toHaveBeenCalled()

        await userEvent.click(screen.getByRole('checkbox', { name: /stored it somewhere safe/i }))
        await userEvent.click(screen.getByRole('button', { name: /done/i }))
        expect(onDone).toHaveBeenCalled()
        expect(onClose).toHaveBeenCalled()
    })
})

describe('renewing a key that has stopped', () => {
    it('shows what it reaches today first, offers no grace, and sends none', async () => {
        rotateDialog(apiKey({ status: 'expired', expiresAt: inDays(-3) }))
        expect(screen.getByRole('dialog', { name: /renew “nightly sync”/i })).toBeInTheDocument()
        expect(screen.queryByRole('radiogroup', { name: 'Old key keeps working' })).not.toBeInTheDocument()
        expect(await screen.findByText('Finance')).toBeInTheDocument()
        expect(svc.get).toHaveBeenCalledWith('apk_1')

        await userEvent.type(screen.getByLabelText('Your password'), 'pw')
        await userEvent.click(screen.getByRole('button', { name: /^renew key$/i }))
        await waitFor(() => expect(svc.rotate).toHaveBeenCalledWith('apk_1', { graceSeconds: 0, currentPassword: 'pw' }))
    })

    it('does not renew a paused key: it rotates it like a live one, saying signing in resumes it', async () => {
        rotateDialog(apiKey({ status: 'paused' }), { stepUp: { method: 'sso', fresh: true } })
        expect(screen.getByRole('dialog', { name: /rotate “nightly sync”/i })).toBeInTheDocument()
        expect(screen.getByText(/signing in through your identity provider again resumes it/i)).toBeInTheDocument()
        expect(screen.getByRole('radiogroup', { name: 'Old key keeps working' })).toBeInTheDocument()
        expect(svc.get).not.toHaveBeenCalled()
        await userEvent.click(screen.getByRole('button', { name: /^rotate key$/i }))
        await waitFor(() => expect(svc.rotate).toHaveBeenCalledWith('apk_1', { graceSeconds: 86400, currentPassword: undefined }))
    })
})

describe('editing a key', () => {
    function edit(key = apiKey({ description: 'Loads the warehouse' })) {
        const onSaved = vi.fn()
        render(<EditKeyDialog apiKey={key} onClose={vi.fn()} onSaved={onSaved} />)
        return { onSaved }
    }

    it('sends only what changed', async () => {
        svc.update.mockResolvedValue(apiKey({ name: 'nightly load' }))
        const { onSaved } = edit()
        const save = screen.getByRole('button', { name: 'Save' })
        expect(save).toBeDisabled()                                     // nothing changed yet
        await userEvent.clear(screen.getByLabelText('Name'))
        await userEvent.type(screen.getByLabelText('Name'), 'nightly load')
        await userEvent.click(save)
        await waitFor(() => expect(svc.update).toHaveBeenCalledWith('apk_1', { name: 'nightly load' }))
        expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ name: 'nightly load' }))
    })

    it('clears a description as null', async () => {
        svc.update.mockResolvedValue(apiKey())
        edit()
        await userEvent.clear(screen.getByLabelText('Description'))
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))
        await waitFor(() => expect(svc.update).toHaveBeenCalledWith('apk_1', { description: null }))
    })

    it('says a revoked key cannot be changed', async () => {
        svc.update.mockRejectedValue(new ApiKeyError(409, 'Conflict', null))
        edit()
        await userEvent.type(screen.getByLabelText('Name'), ' 2')
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))
        expect(await screen.findByText(/has been revoked, so it can no longer be changed/i)).toBeInTheDocument()
    })
})
