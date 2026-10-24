/**
 * Moving a provider that versioned graphs are projected into: the server refuses with 409
 * `versioned_graphs_pinned` and lists them, and the edit is resent with `confirmReseed`. While a
 * graph's version control is still being enabled the move is refused, and its message is shown.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { providerService, VersionedGraphsPinnedError } from './providerService'

const realFetch = globalThis.fetch

function serve(status: number, body: unknown) {
    const f = vi.fn(async (..._args: Parameters<typeof fetch>) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
    globalThis.fetch = f as unknown as typeof fetch
    return () => f.mock.calls.map((c) => String(c[0]))
}

describe('editing a provider with pinned versioned graphs', () => {
    afterEach(() => { globalThis.fetch = realFetch })

    it('raises the graphs the server lists', async () => {
        const graphs = [{ id: 'g1', name: 'customer360', type: 'versioned_graph' }]
        serve(409, { detail: { type: 'versioned_graphs_pinned', message: '1 versioned graph', graphs } })
        const err = await providerService.update('prov_1', { host: 'falkor-b' }).catch((e) => e)
        expect(err).toBeInstanceOf(VersionedGraphsPinnedError)
        expect(err.graphs).toEqual(graphs)
    })

    it('shows the message naming the graphs still being enabled', async () => {
        const message = 'Version control is still being enabled for pkg on this provider.'
        serve(409, { detail: { type: 'versioned_graphs_bootstrapping', message, graphs: [] } })
        const err = await providerService.update('prov_1', { host: 'falkor-b' }).catch((e) => e)
        expect(err.message).toBe(message)
    })

    it('sends confirmReseed when asked', async () => {
        const calls = serve(200, { id: 'prov_1' })
        await providerService.update('prov_1', { host: 'falkor-b' }, { confirmReseed: true })
        expect(calls()).toEqual(['/api/v1/admin/providers/prov_1?confirmReseed=true'])
    })
})
