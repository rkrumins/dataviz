/**
 * useOntologyMutations — publish must NOT trigger a refetch storm.
 *
 * Publishing bumps server-side resolution caches for every assigned source;
 * refetching all ontology + graph-schema queries at once used to saturate
 * the provider concurrency slots (429s). The mutation now marks everything
 * stale with refetchType:'none' and actively refetches only detail/versions/
 * list.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/services/ontologyDefinitionService', () => ({
  ontologyDefinitionService: {
    publish: vi.fn().mockResolvedValue({ id: 'bp_1', isPublished: true }),
  },
}))

import { useOntologyMutations } from './useOntologyMutations'

describe('useOntologyMutations.publish', () => {
  it('marks broad keys stale without refetch and actively refetches only the publish surface', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )

    const { result } = renderHook(() => useOntologyMutations(), { wrapper })
    result.current.publish.mutate('bp_1')
    await waitFor(() => expect(result.current.publish.isSuccess).toBe(true))

    const calls = invalidateSpy.mock.calls.map(([arg]) => arg)

    // Broad keys: stale-only, no refetch storm.
    expect(calls).toContainEqual({ queryKey: ['ontologies'], refetchType: 'none' })
    expect(calls).toContainEqual({ queryKey: ['graph', 'schema'], refetchType: 'none' })

    // Active refetch: exactly the publish surface.
    expect(calls).toContainEqual({ queryKey: ['ontologies', 'detail', 'bp_1'] })
    expect(calls).toContainEqual({ queryKey: ['ontologies', 'versions', 'bp_1'] })
    expect(calls).toContainEqual({ queryKey: ['ontologies', 'list'] })

    // Nothing else refetches actively (no bare ['ontologies'] invalidation).
    const activeBroad = calls.filter(
      c => JSON.stringify((c as { queryKey?: unknown }).queryKey) === JSON.stringify(['ontologies'])
        && (c as { refetchType?: string }).refetchType !== 'none',
    )
    expect(activeBroad).toHaveLength(0)
  })
})
