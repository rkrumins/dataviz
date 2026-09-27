import { describe, expect, it, vi } from 'vitest'

import type { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { SearchExportRequest, SearchExportResult } from '@/types/search'

import { followExport } from '../searchExport'


function answer(over: Partial<SearchExportResult>): SearchExportResult {
    return { sessionId: 'sid', status: 'running', rows: 0, format: 'csv', columns: [], ...over }
}

function providerAnswering(...answers: SearchExportResult[]) {
    const searchExport = vi.fn(async (_body: SearchExportRequest, _opts?: { signal?: AbortSignal }) => {
        const next = answers.shift()
        if (!next) throw new Error('no more answers')
        return next
    })
    return { provider: { searchExport } as unknown as RemoteGraphProvider, searchExport }
}

const REQUEST = {
    scope: { viewId: 'view-1', scopeMode: 'view' as const },
    predicate: { kind: 'all' as const },
    format: 'csv' as const,
    columns: ['owner'],
}


describe('followExport', () => {
    it('sends the session back until the export is complete, reporting each answer', async () => {
        const { provider, searchExport } = providerAnswering(
            answer({ sessionId: 's1', rows: 100 }),
            answer({ sessionId: 's1', rows: 250 }),
            answer({ sessionId: 's1', status: 'complete', rows: 300, downloadToken: 't' }),
        )
        const seen: number[] = []
        const final = await followExport(provider, REQUEST, { onUpdate: (a) => seen.push(a.rows) })
        expect(final.downloadToken).toBe('t')
        expect(seen).toEqual([100, 250, 300])
        const bodies = searchExport.mock.calls.map(([body]) => body)
        expect(bodies[0]).toEqual({ ...REQUEST, waitMs: 2000 })
        expect(bodies[1]).toEqual({ ...REQUEST, waitMs: 2000, sessionId: 's1' })
        expect(bodies).toHaveLength(3)
    })

    it('hands every request the abort signal', async () => {
        const { provider, searchExport } = providerAnswering(answer({ status: 'complete' }))
        const controller = new AbortController()
        await followExport(provider, REQUEST, { signal: controller.signal })
        expect(searchExport.mock.calls[0][1]).toEqual({ signal: controller.signal })
    })

    it('rejects when a request fails', async () => {
        const searchExport = vi.fn(async () => { throw new Error('Service Unavailable') })
        await expect(followExport({ searchExport } as unknown as RemoteGraphProvider, REQUEST))
            .rejects.toThrow('Service Unavailable')
    })
})
