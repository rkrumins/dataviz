/**
 * The palette finds a data source by what it says about itself — its description (else the
 * catalog's) and its tags — once data source details are on; by its name alone otherwise.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const WORKSPACES = vi.hoisted(() => [{
    id: 'ws_fin', name: 'Finance Risk', dataSources: [
        { id: 'ds_gl', label: 'General Ledger', description: 'Balances and journals', tags: ['month-end'] },
        { id: 'ds_risk', label: 'Risk Models', catalogDescription: 'Stress scenarios', tags: [] },
    ],
}])
vi.mock('@/hooks/useDashboardData', () => ({ useDashboardData: () => ({ workspaces: WORKSPACES, ontologies: [] }) }))
vi.mock('@/hooks/useLayoutTemplates', () => ({ useLayoutTemplates: () => ({ templates: [] }) }))
vi.mock('@/services/viewApiService', () => ({
    listViews: vi.fn().mockResolvedValue({ items: [], total: 0, hasMore: false, nextOffset: null }),
}))

import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { useGlobalSearch } from '../useGlobalSearch'

let queryClient: QueryClient
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>

async function sourcesFor(q: string) {
    const { result } = renderHook(() => useGlobalSearch(q), { wrapper })
    await waitFor(() => expect(result.current.query).toBe(q))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    return result.current.byCategory['Data Source'].map(h => h.name)
}

beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES }, loaded: true })
})

describe('useGlobalSearch — data sources', () => {
    it('finds one by name only while data source details are off', async () => {
        expect(await sourcesFor('ledger')).toEqual(['General Ledger'])
        expect(await sourcesFor('journals')).toEqual([])
        expect(await sourcesFor('month-end')).toEqual([])
    })

    it('finds one by its description, the catalog’s, or a tag once they are on', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, dataSourceMetadataEnabled: true }, loaded: true })
        expect(await sourcesFor('journals')).toEqual(['General Ledger'])
        expect(await sourcesFor('stress')).toEqual(['Risk Models'])
        expect(await sourcesFor('month-end')).toEqual(['General Ledger'])
    })
})
