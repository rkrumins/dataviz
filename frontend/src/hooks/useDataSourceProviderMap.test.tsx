import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi } from 'vitest'

const canRead = vi.fn((_perm: string) => true)
vi.mock('@/store/auth', () => ({
  useAnyWorkspacePermission: (perm: string) => canRead(perm),
}))
vi.mock('@/store/workspaces', () => ({
  useWorkspacesStore: (sel: (s: unknown) => unknown) =>
    sel({
      workspaces: [{
        id: 'ws1', name: 'Prod',
        dataSources: [
          { id: 'ds1', label: 'Falkor Main', providerId: 'p1', graphName: 'main_graph' },
          { id: 'ds2', label: 'Catalogued', catalogItemId: 'cat1', graphName: 'other' },
        ],
      }],
    }),
}))
vi.mock('@/services/catalogService', () => ({
  catalogService: {
    list: vi.fn().mockResolvedValue([
      { id: 'cat1', providerId: 'p1', sourceIdentifier: 'orders', name: 'Orders' },
    ]),
  },
}))
vi.mock('@/services/providerService', () => ({
  providerService: {
    list: vi.fn().mockResolvedValue([
      { id: 'p1', name: 'Falkor Prod', providerType: 'falkordb', host: 'falkor.internal', port: 6379 },
    ]),
  },
}))

import { useDataSourceProviderMap } from './useDataSourceProviderMap'

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('useDataSourceProviderMap', () => {
  it('resolves provider identity including host/port from the providers cache', async () => {
    const { result } = renderHook(() => useDataSourceProviderMap(), { wrapper })
    await waitFor(() => expect(result.current.resolve('ds1')?.providerType).toBe('falkordb'))
    expect(result.current.resolve('ds1')).toMatchObject({
      providerId: 'p1',
      providerName: 'Falkor Prod',
      providerType: 'falkordb',
      sourceIdentifier: 'main_graph',
      host: 'falkor.internal',
      port: 6379,
    })
    // Catalog-onboarded source resolves through catalogItem → provider
    expect(result.current.resolve('ds2')).toMatchObject({
      sourceIdentifier: 'orders',
      host: 'falkor.internal',
    })
  })

  it('degrades without provider detail when the user lacks catalog/provider read permission', async () => {
    canRead.mockReturnValue(false)
    const { result } = renderHook(() => useDataSourceProviderMap(), { wrapper })
    // No fetch fires — a source carrying its own providerId still gets an
    // entry, but with no provider name/type/host resolved.
    expect(result.current.resolve('ds1')).toMatchObject({
      providerId: 'p1',
      providerName: 'p1',
      providerType: 'unknown',
      host: undefined,
    })
    // Catalog-only sources can't resolve at all without the catalog list.
    expect(result.current.resolve('ds2')).toBeUndefined()
  })
})
