/**
 * getDiffVsMain — the draft bar asks for a slim diff: modified entities by id alone, so opening a
 * draft that changes 100k entities doesn't ship 100k before/after payloads to count them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDiffVsMain } from './versioningApiService'

const realFetch = globalThis.fetch

function capture() {
    const f = vi.fn(async (..._args: Parameters<typeof fetch>) =>
        new Response(JSON.stringify({ added: [], removed: [], modified: [] }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
        }))
    globalThis.fetch = f as unknown as typeof fetch
    return () => f.mock.calls.map((c) => String(c[0]))
}

describe('getDiffVsMain', () => {
    afterEach(() => { globalThis.fetch = realFetch })

    it('asks for modified entities by id alone when slim', async () => {
        const urls = capture()
        await getDiffVsMain('ws1', 'g1', 'br_1', { slim: true })
        expect(urls()).toEqual(['/api/v1/ws1/versioning/graphs/g1/branches/br_1/diff-vs-main?payloads=changes'])
    })

    it('asks for every payload by default', async () => {
        const urls = capture()
        await getDiffVsMain('ws1', 'g1', 'br_1')
        expect(urls()).toEqual(['/api/v1/ws1/versioning/graphs/g1/branches/br_1/diff-vs-main'])
    })
})
