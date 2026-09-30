/**
 * updateBranding() tells a stale-version 409 apart from every other failure
 * by HTTP status. The admin page used to regex the message for "conflict",
 * so any error that happened to mention the word opened the conflict flow.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

const { fetchWithTimeoutMock, reportFailureMock } = vi.hoisted(() => ({
    fetchWithTimeoutMock: vi.fn(),
    reportFailureMock: vi.fn(),
}))
vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: fetchWithTimeoutMock }))
vi.mock('@/store/health', () => ({
    useHealthStore: { getState: () => ({ reportFailure: reportFailureMock }) },
}))

import { updateBranding, BrandingConflictError } from '../brandingService'

describe('updateBranding', () => {
    beforeEach(() => {
        fetchWithTimeoutMock.mockReset()
        reportFailureMock.mockReset()
    })

    it('rejects a 409 with BrandingConflictError', async () => {
        fetchWithTimeoutMock.mockResolvedValueOnce(new Response(
            JSON.stringify({ detail: 'version mismatch: expected 3, got 4' }), { status: 409 },
        ))
        const err = await updateBranding({ appName: 'X', expectedVersion: 3 }).catch((e: unknown) => e)
        expect(err).toBeInstanceOf(BrandingConflictError)
        expect((err as Error).message).toBe('version mismatch: expected 3, got 4')
    })

    it('rejects any other status with a plain Error, even when it says "conflict"', async () => {
        fetchWithTimeoutMock.mockResolvedValueOnce(new Response(
            JSON.stringify({ detail: 'Write conflict in storage layer' }), { status: 500 },
        ))
        const err = await updateBranding({ appName: 'X' }).catch((e: unknown) => e)
        expect(err).toBeInstanceOf(Error)
        expect(err).not.toBeInstanceOf(BrandingConflictError)
        expect((err as Error).message).toBe('Write conflict in storage layer')
    })

    it('reports a network failure to the health banner, like every authFetch call', async () => {
        const offline = new TypeError('Failed to fetch')
        fetchWithTimeoutMock.mockRejectedValueOnce(offline)
        await expect(updateBranding({ appName: 'X' })).rejects.toBe(offline)
        expect(reportFailureMock).toHaveBeenCalledWith(offline)
    })

    it('resolves with the saved branding on success', async () => {
        fetchWithTimeoutMock.mockResolvedValueOnce(new Response(
            JSON.stringify({ appName: 'X', version: 4 }), { status: 200 },
        ))
        await expect(updateBranding({ appName: 'X', expectedVersion: 3 }))
            .resolves.toMatchObject({ appName: 'X', version: 4 })
        const [, init] = fetchWithTimeoutMock.mock.calls[0]
        expect(init.method).toBe('PATCH')
        expect(JSON.parse(init.body)).toEqual({ appName: 'X', expectedVersion: 3 })
    })
})
