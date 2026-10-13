/**
 * Options come from the unfiltered universe and stay put; their numbers come from
 * the facets counted with the other filters. With nothing filtered there is one
 * request, not two.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/viewApiService', () => ({ getViewFacets: vi.fn() }))

import { getViewFacets, type ViewFacetsResponse } from '@/services/viewApiService'
import { useLiveFacets } from '../useLiveFacets'
import { EMPTY_FILTERS } from '../model'

const mockFacets = vi.mocked(getViewFacets)
const CTX = { currentUserId: 'u_me', today: '2026-10-12' }

const person = (userId: string, count: number) => ({
  userId, displayName: userId, email: null, avatarId: null,
  count, createdCount: count, editedCount: 0, publishedCount: 0,
})

const UNIVERSE: ViewFacetsResponse = {
  tags: [{ value: 'pii', count: 5 }, { value: 'kpi', count: 3 }],
  viewTypes: [], creators: [],
  contributors: [person('u_ada', 4), person('u_bob', 2)],
  sourceKinds: { versioned: 6, external: 2 },
}
const LIVE: ViewFacetsResponse = {
  tags: [{ value: 'pii', count: 2 }],
  viewTypes: [], creators: [],
  contributors: [person('u_ada', 1)],
  sourceKinds: { versioned: 2, external: 0 },
}

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => {
  mockFacets.mockReset()
  mockFacets.mockImplementation(params => Promise.resolve(params ? LIVE : UNIVERSE))
})

describe('useLiveFacets', () => {
  it('makes one request when nothing is filtered, and counts from the universe', async () => {
    const { result } = renderHook(() => useLiveFacets(EMPTY_FILTERS, CTX), { wrapper })
    await waitFor(() => expect(result.current.counts.tags).not.toBeNull())
    expect(mockFacets).toHaveBeenCalledTimes(1)
    expect(result.current.counts.tags!.get('kpi')).toBe(3)
    expect(result.current.sourceKinds).toEqual({ versioned: 6, external: 2 })
  })

  it('keeps everyone listed and gives them the filtered numbers — 0 when absent', async () => {
    const state = { ...EMPTY_FILTERS, tags: ['pii'] }
    const { result } = renderHook(() => useLiveFacets(state, CTX), { wrapper })
    await waitFor(() => expect(result.current.sourceKinds).toEqual({ versioned: 2, external: 0 }))
    expect(result.current.people.map(p => [p.userId, p.count])).toEqual([['u_ada', 1], ['u_bob', 0]])
    expect(result.current.counts.tags!.get('kpi')).toBeUndefined()
    expect(result.current.universe.tags.map(t => t.value)).toEqual(['pii', 'kpi'])
  })
})
