import { describe, expect, it, vi } from 'vitest'

import type { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { SearchCatalogRequest, SearchCatalogResult } from '@/types/search'

import { followCatalog } from '../propertyCatalog'


function answer(over: Partial<SearchCatalogResult>): SearchCatalogResult {
    return {
        sessionId: 'sid', status: 'running', stale: false, entities: 0,
        entityTypes: [], properties: [], tags: [], ...over,
    }
}

function providerAnswering(...answers: SearchCatalogResult[]) {
    const searchCatalog = vi.fn(async (_body: SearchCatalogRequest) => {
        const next = answers.shift()
        if (!next) throw new Error('no more answers')
        return next
    })
    return { provider: { searchCatalog } as unknown as RemoteGraphProvider, searchCatalog }
}


describe('followCatalog', () => {
    it('sends the session back until the catalog is complete, reporting each answer', async () => {
        const { provider, searchCatalog } = providerAnswering(
            answer({ sessionId: 's1', entities: 100 }),
            answer({ sessionId: 's1', entities: 250 }),
            answer({ sessionId: 's1', status: 'complete', entities: 300 }),
        )
        const seen: number[] = []
        const final = await followCatalog(provider, 'view-1', { onUpdate: (c) => seen.push(c.entities) })
        expect(final.entities).toBe(300)
        expect(seen).toEqual([100, 250, 300])
        const bodies = searchCatalog.mock.calls.map(([body]) => body)
        expect(bodies[0]).toEqual({ scope: { viewId: 'view-1', scopeMode: 'view' }, waitMs: 800 })
        expect(bodies[1].sessionId).toBe('s1')
    })

    it('asks for a fresh read only on its first request', async () => {
        const { provider, searchCatalog } = providerAnswering(
            answer({ sessionId: 's2' }), answer({ sessionId: 's2', status: 'complete' }),
        )
        await followCatalog(provider, 'view-1', { refresh: true })
        const [first, second] = searchCatalog.mock.calls.map(([body]) => body)
        expect(first.refresh).toBe(true)
        expect(second.refresh).toBeUndefined()
    })

    it('rejects when a request fails', async () => {
        const searchCatalog = vi.fn(async () => { throw new Error('Service Unavailable') })
        await expect(followCatalog({ searchCatalog } as unknown as RemoteGraphProvider, 'v'))
            .rejects.toThrow('Service Unavailable')
    })
})
