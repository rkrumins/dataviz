/**
 * useRelationshipRecords reads several relationships at once: under version control from the
 * version store, a slice of refs per request, each with its entity id and token; elsewhere from
 * the view's provider, by their ends — picked by id, else by (source, target, type).
 */
import type { ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  readEdges: vi.fn(),
  provider: { getEdges: vi.fn() },
}))
vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/versioningApiService')>()),
  EDGE_READ_MAX: 2,
  readEdges: h.readEdges,
}))
vi.mock('@/providers/GraphProviderContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/providers/GraphProviderContext')>()),
  useGraphProviderContext: () => ({ provider: h.provider, providerVersion: 1 }),
}))

import { useRelationshipRecords } from '../useRelationshipRecords'

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
)
const ref = (id: string, source = 'a', target = 'b', edgeType = 'FLOWS_TO') => ({ id, source, target, edgeType })

beforeEach(() => {
  h.readEdges.mockReset()
  h.provider.getEdges.mockReset()
})

describe('useRelationshipRecords', () => {
  it('under version control, reads the version store a slice at a time, with each one\'s token', async () => {
    h.readEdges
      .mockResolvedValueOnce({ edges: [{ id: 'e1', entityId: 'e1', version: 'v1', edgeType: 'FLOWS_TO', sourceEntityId: 'a', targetEntityId: 'b', properties: { owner: 'ana' } }], deleted: ['e2'], missing: [] })
      .mockResolvedValueOnce({ edges: [{ id: 'e3', entityId: 'edge:e3', version: 'v3', edgeType: 'FEEDS', sourceEntityId: 'a', targetEntityId: 'c', properties: {} }], deleted: [], missing: [] })
    const refs = [ref('e1'), ref('e2'), ref('e3', 'a', 'c', 'FEEDS')]
    const { result } = renderHook(() => useRelationshipRecords(refs, { wsId: 'ws', graphId: 'g', branchId: 'd1' }), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(h.readEdges.mock.calls.map((c) => [c[2], (c[3] as Array<{ id: string }>).map((r) => r.id)])).toEqual([['d1', ['e1', 'e2']], ['d1', ['e3']]])
    expect(h.readEdges.mock.calls[0]![3][0]).toEqual(ref('e1'))
    expect(result.current.versioned).toBe(true)
    expect(result.current.records.get('e1')).toEqual({ entityId: 'e1', edgeType: 'FLOWS_TO', properties: { owner: 'ana' }, version: 'v1' })
    expect(result.current.records.get('e3')!.entityId).toBe('edge:e3')
    expect([...result.current.deleted]).toEqual(['e2'])
    expect(h.provider.getEdges).not.toHaveBeenCalled()
  })

  it('elsewhere, reads the provider by their ends, picked by id or by their ends and type', async () => {
    h.provider.getEdges.mockResolvedValue([
      { id: 'e1', sourceUrn: 'a', targetUrn: 'b', edgeType: 'FLOWS_TO', properties: { owner: 'ana' } },
      { id: 'x9', sourceUrn: 'a', targetUrn: 'c', edgeType: 'FEEDS', properties: { sla: '1h' } },
    ])
    const refs = [ref('e1'), ref('bundle:wire', 'a', 'c', 'feeds'), ref('nope', 'b', 'c')]
    const { result } = renderHook(() => useRelationshipRecords(refs, {}), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(h.provider.getEdges).toHaveBeenCalledWith({ sourceUrns: ['a', 'b'], targetUrns: ['b', 'c'], limit: 5000 })
    expect(result.current.versioned).toBe(false)
    expect(result.current.records.get('bundle:wire')).toEqual({ entityId: 'x9', edgeType: 'FEEDS', properties: { sla: '1h' } })
    expect([...result.current.missing]).toEqual(['nope'])
    expect(h.readEdges).not.toHaveBeenCalled()
  })
})
