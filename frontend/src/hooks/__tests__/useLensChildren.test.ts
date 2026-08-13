/**
 * useLensChildren — the roster/paging/Find half extracted from the old
 * useLensContainer (`getChildrenWithEdges`), minus the pairwise
 * open-against-a-focal machinery (that stays behind in useLensContainer.ts
 * until THE SWAP task retires it). Same contract as the source: server-side
 * paging and search, "drained" means no more round trips, a failed page is
 * re-kickable by just calling again, session clears when the lens closes.
 */
import { renderHook, waitFor, act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useLensChildren } from '../useLensChildren'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'

const gn = (urn: string) => ({ urn, displayName: `label-${urn}`, entityType: 'dataset', properties: {} })

function makeProvider(
  children: (req: { urn: string; offset: number; limit: number; searchQuery?: string }) => unknown,
) {
  const getChildrenWithEdges = vi.fn(async (urn: string, o?: { offset?: number; limit?: number; searchQuery?: string }) =>
    children({ urn, offset: o?.offset ?? 0, limit: o?.limit ?? 0, searchQuery: o?.searchQuery }))
  return { provider: { getChildrenWithEdges } as unknown as GraphDataProvider, getChildrenWithEdges }
}

describe('useLensChildren', () => {
  it('asks about the urn directly, and pages by offset', async () => {
    const page = (o: number, n: number) => Array.from({ length: n }, (_, i) => gn(`c${o + i}`))
    const { provider, getChildrenWithEdges } = makeProvider(({ offset }) =>
      offset === 0
        ? { children: page(0, 100), hasMore: true }
        : { children: page(100, 3), hasMore: false })
    const { result } = renderHook(() => useLensChildren('F', provider))

    act(() => result.current.loadAllChildren('C'))
    await waitFor(() => expect(result.current.allStatus.get('C')).toBe('done'))
    expect(getChildrenWithEdges).toHaveBeenCalledWith('C', expect.objectContaining({
      offset: 0, limit: 100, includeLineageEdges: false,
    }))
    let all = result.current.allResults.get('C')!
    expect(all.children).toHaveLength(100)
    expect(all.hasMore).toBe(true)
    // Still paging => the count is genuinely unknown, never fabricated.
    expect(all.total).toBeNull()

    act(() => result.current.loadAllChildren('C'))
    await waitFor(() => expect(result.current.allResults.get('C')!.children).toHaveLength(103))
    expect(getChildrenWithEdges).toHaveBeenLastCalledWith('C', expect.objectContaining({ offset: 100 }))
    all = result.current.allResults.get('C')!
    // Drained => and only now is the total actually known.
    expect(all.hasMore).toBe(false)
    expect(all.total).toBe(103)

    // Drained means drained — no further round trips.
    act(() => result.current.loadAllChildren('C'))
    expect(getChildrenWithEdges).toHaveBeenCalledTimes(2)
  })

  // REGRESSION (ported): Find used to filter the loaded page in the
  // browser, so on a wide table you could not find a column you had not
  // paged to yet — the one thing a Find box is for.
  it('sends a search to the server, and a new search restarts the list', async () => {
    const { provider, getChildrenWithEdges } = makeProvider(({ offset, searchQuery }) =>
      searchQuery
        ? { children: [gn('order_id'), gn('order_ts')], hasMore: false }
        : offset === 0
          ? { children: Array.from({ length: 100 }, (_, i) => gn(`c${i}`)), hasMore: true }
          : { children: [gn('c100')], hasMore: false })
    const { result } = renderHook(() => useLensChildren('F', provider))

    act(() => result.current.loadAllChildren('C'))
    await waitFor(() => expect(result.current.allResults.get('C')!.children).toHaveLength(100))

    act(() => result.current.loadAllChildren('C', 'order'))
    await waitFor(() => expect(result.current.allResults.get('C')!.query).toBe('order'))
    expect(getChildrenWithEdges).toHaveBeenLastCalledWith('C', expect.objectContaining({
      offset: 0, searchQuery: 'order',
    }))
    // The matches REPLACE the unfiltered page — the answer to a different
    // question, not more of the same one.
    const found = result.current.allResults.get('C')!
    expect(found.children.map(c => c.id)).toEqual(['order_id', 'order_ts'])
    expect(found.total).toBe(2)

    // A drained search does not block going back to the full list.
    act(() => result.current.loadAllChildren('C'))
    await waitFor(() => expect(result.current.allResults.get('C')!.children).toHaveLength(100))
    expect(result.current.allResults.get('C')!.query).toBe('')
  })

  it('never sends searchQuery when nothing is typed', async () => {
    const { provider, getChildrenWithEdges } = makeProvider(() => ({ children: [gn('c0')], hasMore: false }))
    const { result } = renderHook(() => useLensChildren('F', provider))
    act(() => result.current.loadAllChildren('C'))
    await waitFor(() => expect(result.current.allStatus.get('C')).toBe('done'))
    expect(getChildrenWithEdges.mock.calls[0]![1]).not.toHaveProperty('searchQuery')
  })

  it('reports a failed fetch and lets the user re-kick it', async () => {
    let fail = true
    const { provider, getChildrenWithEdges } = makeProvider(() => {
      if (fail) throw new Error('nope')
      return { children: [gn('c1')], hasMore: false }
    })
    const { result } = renderHook(() => useLensChildren('F', provider))

    act(() => result.current.loadAllChildren('C'))
    await waitFor(() => expect(result.current.allStatus.get('C')).toBe('error'))
    expect(getChildrenWithEdges).toHaveBeenCalledTimes(1)

    fail = false
    act(() => result.current.loadAllChildren('C'))
    await waitFor(() => expect(result.current.allStatus.get('C')).toBe('done'))
    expect(result.current.allResults.get('C')!.children.map(n => n.id)).toEqual(['c1'])
  })

  it('loadChildrenOf fetches a plain, unfiltered roster for any urn', async () => {
    const { provider, getChildrenWithEdges } = makeProvider(() => ({ children: [gn('x'), gn('y')], hasMore: false }))
    const { result } = renderHook(() => useLensChildren('F', provider))
    act(() => result.current.loadChildrenOf('N'))
    await waitFor(() => expect(result.current.allStatus.get('N')).toBe('done'))
    expect(getChildrenWithEdges.mock.calls[0]![1]).not.toHaveProperty('searchQuery')
    expect(result.current.allResults.get('N')!.children.map(n => n.id)).toEqual(['x', 'y'])
  })

  it('degrades to unsupported with no provider reachable', () => {
    const { result } = renderHook(() => useLensChildren('F', null))
    act(() => result.current.loadAllChildren('C'))
    expect(result.current.allStatus.get('C')).toBe('unsupported')
  })

  it('clears the session when the lens closes', async () => {
    const { provider } = makeProvider(() => ({ children: [gn('c1')], hasMore: false }))
    const { result, rerender } = renderHook(
      ({ focal }: { focal: string | null }) => useLensChildren(focal, provider),
      { initialProps: { focal: 'F' as string | null } },
    )
    act(() => result.current.loadAllChildren('C'))
    await waitFor(() => expect(result.current.allResults.size).toBe(1))

    rerender({ focal: null })
    expect(result.current.allResults.size).toBe(0)
    expect(result.current.allStatus.size).toBe(0)
  })
})
