/**
 * providerService.listTypes() / discoverSchemaUnsaved() — the two new
 * calls this module gains for the provider catalog (T-G's
 * `GET /admin/providers/types` and `POST /admin/providers/discover-schema`).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

const { fetchWithTimeoutMock } = vi.hoisted(() => ({ fetchWithTimeoutMock: vi.fn() }))
vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: fetchWithTimeoutMock }))

import { providerService } from '../providerService'
import fixture from '../__fixtures__/providerTypes.backend.json'

describe('providerService.listTypes', () => {
    beforeEach(() => fetchWithTimeoutMock.mockReset())

    it('GETs the same-origin /api/v1/admin/providers/types path', async () => {
        fetchWithTimeoutMock.mockResolvedValueOnce(new Response(JSON.stringify(fixture), { status: 200 }))
        await providerService.listTypes()
        const [url, init] = fetchWithTimeoutMock.mock.calls[0]
        expect(url).toBe('/api/v1/admin/providers/types')
        expect((init as RequestInit | undefined)?.method).toBeUndefined() // GET
    })

    it('returns the fixture parsed, unchanged', async () => {
        fetchWithTimeoutMock.mockResolvedValueOnce(new Response(JSON.stringify(fixture), { status: 200 }))
        const types = await providerService.listTypes()
        expect(types).toEqual(fixture)
    })

    it('drops a malformed row rather than surfacing garbage to the caller', async () => {
        fetchWithTimeoutMock.mockResolvedValueOnce(
            new Response(JSON.stringify([...fixture, { id: 'broken' }]), { status: 200 }),
        )
        const types = await providerService.listTypes()
        expect(types).toEqual(fixture)
    })
})

describe('providerService.discoverSchemaUnsaved', () => {
    beforeEach(() => fetchWithTimeoutMock.mockReset())

    it('POSTs the wrapped {provider, assetName} body to /discover-schema', async () => {
        fetchWithTimeoutMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ labels: [], relationshipTypes: [], labelDetails: {} }), { status: 200 }),
        )
        const req = { name: 'probe', providerType: 'neo4j' as const, host: 'localhost', port: 7687 }
        await providerService.discoverSchemaUnsaved(req, 'orders')

        const [url, init] = fetchWithTimeoutMock.mock.calls[0]
        expect(url).toBe('/api/v1/admin/providers/discover-schema')
        expect((init as RequestInit).method).toBe('POST')
        expect(JSON.parse((init as RequestInit).body as string)).toEqual({ provider: req, assetName: 'orders' })
    })

    it('sends assetName: null when none is given', async () => {
        fetchWithTimeoutMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ labels: [], relationshipTypes: [], labelDetails: {} }), { status: 200 }),
        )
        const req = { name: 'probe', providerType: 'neo4j' as const, host: 'localhost', port: 7687 }
        await providerService.discoverSchemaUnsaved(req)

        const [, init] = fetchWithTimeoutMock.mock.calls[0]
        expect(JSON.parse((init as RequestInit).body as string)).toEqual({ provider: req, assetName: null })
    })
})
