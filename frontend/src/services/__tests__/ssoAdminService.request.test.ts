/**
 * What a refused SSO admin call hands back.
 *
 * The message has always been the readable line — and every caller shows
 * exactly that. But turning passwords off answers 409 with a LIST (the
 * Super Admins it would strand), and the message alone dropped it. The
 * parsed ``detail`` and the status now ride on the same error, so the one
 * caller that needs the list can read it and nobody else notices.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchWithTimeoutMock } = vi.hoisted(() => ({ fetchWithTimeoutMock: vi.fn() }))
vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: fetchWithTimeoutMock }))

import { ssoAdminService, type SsoAdminRequestError } from '../ssoAdminService'

function failure(): Promise<SsoAdminRequestError> {
    return ssoAdminService.updateAuthConfig({ allowLocalLogin: false }).then(
        () => { throw new Error('expected updateAuthConfig() to reject') },
        (e: unknown) => e as SsoAdminRequestError,
    )
}

describe('ssoAdminService — a refused request', () => {
    beforeEach(() => fetchWithTimeoutMock.mockReset())

    it('keeps a structured refusal whole, beside the same readable message', async () => {
        const detail = {
            error: 'would_lock_out_admin',
            adminsWithoutSso: [{ id: 'u1', email: 'ana@corp.example' }],
            message: 'Some Super Admins have no SSO identity.',
        }
        fetchWithTimeoutMock.mockResolvedValueOnce(new Response(
            JSON.stringify({ detail }), { status: 409 },
        ))

        const err = await failure()
        expect(err.message).toBe('Some Super Admins have no SSO identity.')
        expect(err.status).toBe(409)
        expect(err.detail).toEqual(detail)
    })

    it('reads a plain-string detail exactly as before', async () => {
        fetchWithTimeoutMock.mockResolvedValueOnce(new Response(
            JSON.stringify({ detail: 'Someone else changed this first.' }),
            { status: 409 },
        ))

        const err = await failure()
        expect(err.message).toBe('Someone else changed this first.')
        expect(err.detail).toBe('Someone else changed this first.')
    })

    it('keeps a body that is not JSON as the message, with no detail', async () => {
        fetchWithTimeoutMock.mockResolvedValueOnce(
            new Response('<html>502 Bad Gateway</html>', { status: 502 }),
        )

        const err = await failure()
        expect(err.message).toBe('<html>502 Bad Gateway</html>')
        expect(err.status).toBe(502)
        expect(err.detail).toBeUndefined()
    })
})

describe('ssoAdminService — the emergency window', () => {
    beforeEach(() => {
        fetchWithTimeoutMock.mockReset()
        fetchWithTimeoutMock.mockImplementation(async () => new Response(
            JSON.stringify({ allowLocalLogin: false }), { status: 200 },
        ))
    })

    it('opens with the hours and the reason', async () => {
        await ssoAdminService.openPasswordFallback(4, 'Entra outage')
        expect(fetchWithTimeoutMock).toHaveBeenCalledWith(
            '/api/v1/admin/sso/config/password-fallback',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ hours: 4, reason: 'Entra outage' }),
            }),
        )
    })

    it('leaves the reason out when there is none', async () => {
        await ssoAdminService.openPasswordFallback(1)
        expect(fetchWithTimeoutMock.mock.calls[0][1].body)
            .toBe(JSON.stringify({ hours: 1 }))
    })

    it('closes with a DELETE', async () => {
        await ssoAdminService.closePasswordFallback()
        expect(fetchWithTimeoutMock).toHaveBeenCalledWith(
            '/api/v1/admin/sso/config/password-fallback',
            expect.objectContaining({ method: 'DELETE' }),
        )
    })
})
