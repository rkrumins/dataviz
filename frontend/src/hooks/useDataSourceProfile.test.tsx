import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/services/catalogService', () => ({
  catalogService: {
    get: vi.fn().mockResolvedValue({ id: 'cat-1', providerId: 'p-1', sourceIdentifier: 'orders', name: 'Orders', status: 'active', permittedWorkspaces: ['*'], createdAt: '', updatedAt: '' }),
    getImpact: vi.fn().mockResolvedValue({ catalogItems: [], workspaces: [{ id: 'w', name: 'WS', type: 'workspace' }], views: [] }),
  },
}))
vi.mock('@/services/providerService', () => ({
  providerService: { get: vi.fn().mockResolvedValue({ id: 'p-1', name: 'Falkor', providerType: 'falkordb' }) },
}))
vi.mock('@/hooks/useAssetStats', () => ({
  ASSET_STATS_QUERY_KEY_PREFIX: 'insights-asset-stats',
  useAssetStats: () => ({ isLoading: false, data: { data: { nodeCount: 10, edgeCount: 20, entityTypeCounts: {}, edgeTypeCounts: {} }, meta: { status: 'fresh' } } }),
}))

import { useDataSourceProfile } from './useDataSourceProfile'

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('useDataSourceProfile', () => {
  it('bundles item, provider, stats, and consumers', async () => {
    const { result } = renderHook(() => useDataSourceProfile('cat-1'), { wrapper })
    await waitFor(() => expect(result.current.item?.name).toBe('Orders'))
    expect(result.current.provider?.name).toBe('Falkor')
    expect(result.current.stats?.nodeCount).toBe(10)
    expect(result.current.consumers?.workspaces[0].name).toBe('WS')
    expect(result.current.notFound).toBe(false)
  })
})
