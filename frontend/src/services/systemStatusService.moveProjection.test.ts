/**
 * Moving a versioned graph's projection from the admin API: the call posts
 * the target to the graph's move route, and a refusal keeps the server's
 * structured detail (its `type` and `reason`), so the dialog can say what
 * the administrator can do about it instead of echoing a message.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { systemStatusService } from './systemStatusService'

const realFetch = globalThis.fetch

function serve(status: number, body: unknown) {
    const f = vi.fn(async (..._args: Parameters<typeof fetch>) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
    globalThis.fetch = f as unknown as typeof fetch
    return f
}

describe('systemStatusService.moveProjection', () => {
    afterEach(() => { globalThis.fetch = realFetch })

    it('posts the target to the graph\'s move route', async () => {
        const f = serve(200, { graphId: 'g{1}', changed: true })
        await expect(systemStatusService.moveProjection('g{1}', { providerId: 'falkor-us', key: 'k' }))
            .resolves.toMatchObject({ changed: true })
        const [url, init] = f.mock.calls[0]
        expect(String(url)).toBe('/api/v1/admin/versioning/graphs/g%7B1%7D/projection/move')
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({ providerId: 'falkor-us', key: 'k' })
    })

    it('keeps a refusal\'s structured detail on the error', async () => {
        serve(409, { detail: { type: 'projection_not_adopted', reason: 'shared', message: 'shared key' } })
        await expect(systemStatusService.moveProjection('g1', { providerId: 'falkor-us' })).rejects.toMatchObject({
            message: 'shared key', status: 409, detail: { type: 'projection_not_adopted', reason: 'shared' },
        })
    })
})
