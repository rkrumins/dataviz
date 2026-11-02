/**
 * A workspace's data-source list leaves forks' data sources out unless asked: the fork screens ask
 * for them, and each says what it was forked from (`forkOf`).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

const { fetchWithTimeoutMock } = vi.hoisted(() => ({ fetchWithTimeoutMock: vi.fn() }))
vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: fetchWithTimeoutMock }))

import { workspaceService } from '../workspaceService'

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe('workspaceService.listDataSources', () => {
    beforeEach(() => fetchWithTimeoutMock.mockReset())

    it('asks for forks only when told to', async () => {
        const fork = { id: 'dsfork_1', label: 'Sales · Q3', forkOf: { dataSourceId: 'ds1', graphId: 'g1' } }
        fetchWithTimeoutMock.mockResolvedValueOnce(ok([{ id: 'ds1', forkOf: null }, fork]))
        const sources = await workspaceService.listDataSources('ws1', { includeForks: true })
        expect(fetchWithTimeoutMock.mock.calls[0][0]).toBe('/api/v1/admin/workspaces/ws1/data-sources?includeForks=true')
        expect(sources[1].forkOf).toEqual({ dataSourceId: 'ds1', graphId: 'g1' })

        fetchWithTimeoutMock.mockResolvedValueOnce(ok([]))
        await workspaceService.listDataSources('ws1')
        expect(fetchWithTimeoutMock.mock.calls[1][0]).toBe('/api/v1/admin/workspaces/ws1/data-sources')
    })
})
