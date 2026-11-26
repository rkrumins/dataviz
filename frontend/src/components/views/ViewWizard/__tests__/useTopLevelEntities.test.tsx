/**
 * The top-level entities the Layout step's "one column per entity" reads: a
 * page per root type, how many there are, and whether there are more than the
 * most columns ever offered — asked for only while enabled.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { TopLevelNodesQuery } from '@/providers/GraphDataProvider'

const getTopLevelNodes = vi.hoisted(() => vi.fn())
vi.mock('@/providers/GraphProviderContext', () => ({ useGraphProvider: () => ({ getTopLevelNodes }) }))

import { ENTITY_COLUMNS_MAX, useTopLevelEntities } from '../useTopLevelEntities'

const node = (type: string, name: string) => ({ urn: `urn:${type}:${name}`, entityType: type, displayName: name, childCount: 3 })

function wrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('useTopLevelEntities', () => {
    it('reads a page per root type: who they are, how many, and whether there are too many', async () => {
        getTopLevelNodes.mockImplementation(async ({ entityTypes }: TopLevelNodesQuery) => entityTypes![0] === 'Domain'
            ? { nodes: [node('Domain', 'Finance'), node('Domain', 'Sales')], totalCount: 2, hasMore: false, nextCursor: null, rootTypeCount: 2, orphanCount: 0 }
            : { nodes: Array.from({ length: ENTITY_COLUMNS_MAX + 1 }, (_, i) => node('Team', `T${i}`)), totalCount: null, hasMore: true, nextCursor: 'x', rootTypeCount: 0, orphanCount: 0 })
        const types = ['Domain', 'Team']
        const { result } = renderHook(() => useTopLevelEntities('ds1', types, true), { wrapper })

        await waitFor(() => expect(result.current.byType.size).toBe(2))
        expect(getTopLevelNodes).toHaveBeenCalledWith({ entityTypes: ['Domain'], limit: ENTITY_COLUMNS_MAX + 1, includeChildCount: true })
        expect(result.current.byType.get('Domain')).toEqual({
            entities: [
                { urn: 'urn:Domain:Finance', name: 'Finance', type: 'Domain', childCount: 3 },
                { urn: 'urn:Domain:Sales', name: 'Sales', type: 'Domain', childCount: 3 },
            ],
            count: 2, over: false,
        })
        expect(result.current.byType.get('Team')).toMatchObject({ count: null, over: true })
    })

    it('asks nothing while it is not needed', () => {
        getTopLevelNodes.mockClear()
        const types = ['Domain']
        const { result } = renderHook(() => useTopLevelEntities('ds1', types, false), { wrapper })
        expect(getTopLevelNodes).not.toHaveBeenCalled()
        expect(result.current.byType.size).toBe(0)
        expect(result.current.isLoading).toBe(false)
    })
})
