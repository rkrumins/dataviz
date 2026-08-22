/**
 * Names the canvas cannot supply come from the SERVER (2026-08-22).
 *
 * The trace-history launcher labelled its entries from whatever the canvas
 * had loaded, so after a reload — when only the lane roots are hydrated —
 * the list read `intermediate_t2_17d10688`, `reporting_9a044b28`: URN tails,
 * not names. The entity has a name; the canvas simply had not fetched it.
 *
 * This hook is that fetch, and these are its manners: ask once, ask only for
 * what it was given, never twice for the same urn, and never turn a failed
 * lookup into a failed screen.
 */
import { describe, it, expect, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { GraphDataProvider, GraphNode } from '@/providers/GraphDataProvider'
import { useResolvedNames } from '../useResolvedNames'

const node = (urn: string, displayName: string): GraphNode =>
  ({ urn, displayName, entityType: 'dataset' }) as unknown as GraphNode

function fakeProvider(known: Record<string, string>) {
  const asked: string[][] = []
  const getNodes = vi.fn(async ({ urns }: { urns?: string[] }) => {
    asked.push([...(urns ?? [])])
    return (urns ?? []).filter(u => u in known).map(u => node(u, known[u]))
  })
  return { provider: { getNodes } as unknown as GraphDataProvider, asked, getNodes }
}

describe('useResolvedNames', () => {
  it('asks the server for the urns it is given and answers with their names', async () => {
    const { provider, asked } = fakeProvider({ a: 'Orders', b: 'Customers' })
    const { result } = renderHook(() => useResolvedNames(['a', 'b'], provider))

    await waitFor(() => expect(result.current.size).toBe(2))
    expect(result.current.get('a')).toBe('Orders')
    expect(result.current.get('b')).toBe('Customers')
    expect(asked).toEqual([['a', 'b']])
  })

  it('asks only for what is new — a urn already looked up is never asked again', async () => {
    const { provider, asked } = fakeProvider({ a: 'Orders', b: 'Customers', c: 'Invoices' })
    const { result, rerender } = renderHook(
      ({ urns }: { urns: string[] }) => useResolvedNames(urns, provider),
      { initialProps: { urns: ['a'] } },
    )
    await waitFor(() => expect(result.current.get('a')).toBe('Orders'))

    rerender({ urns: ['a', 'b', 'c'] })
    await waitFor(() => expect(result.current.get('c')).toBe('Invoices'))
    expect(asked).toEqual([['a'], ['b', 'c']])

    // The same list again is not a reason to ask anything.
    rerender({ urns: ['a', 'b', 'c'] })
    await waitFor(() => expect(result.current.size).toBe(3))
    expect(asked).toEqual([['a'], ['b', 'c']])
  })

  it('duplicates in one list are one question', async () => {
    const { provider, asked } = fakeProvider({ a: 'Orders' })
    const { result } = renderHook(() => useResolvedNames(['a', 'a', 'a'], provider))
    await waitFor(() => expect(result.current.get('a')).toBe('Orders'))
    expect(asked).toEqual([['a']])
  })

  it('a urn the server does not know stays unresolved, and is not asked again', async () => {
    const { provider, asked } = fakeProvider({ a: 'Orders' })
    const { result, rerender } = renderHook(
      ({ urns }: { urns: string[] }) => useResolvedNames(urns, provider),
      { initialProps: { urns: ['a', 'ghost'] } },
    )
    await waitFor(() => expect(result.current.get('a')).toBe('Orders'))
    expect(result.current.has('ghost')).toBe(false)

    rerender({ urns: ['a', 'ghost'] })
    await waitFor(() => expect(result.current.size).toBe(1))
    expect(asked).toEqual([['a', 'ghost']])
  })

  it('a failed lookup is not a failed screen — and the next change may retry', async () => {
    const getNodes = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([node('a', 'Orders')])
    const provider = { getNodes } as unknown as GraphDataProvider
    const { result, rerender } = renderHook(
      ({ urns }: { urns: string[] }) => useResolvedNames(urns, provider),
      { initialProps: { urns: ['a'] } },
    )
    await waitFor(() => expect(getNodes).toHaveBeenCalledTimes(1))
    expect(result.current.size).toBe(0)

    rerender({ urns: ['a', 'a'] })
    await waitFor(() => expect(result.current.get('a')).toBe('Orders'))
  })

  // MEASURED IN THE BROWSER (2026-08-22): the request went out and came back
  // 200 with the names in it, and the launcher still showed urn tails. The
  // caller's list is derived from the canvas, which re-renders all through
  // hydration — so the effect was torn down and rebuilt while the answer was
  // in flight, and a teardown flag threw the answer away. Nothing asks again:
  // those urns are already spoken for.
  it('an answer that arrives after the list changed is still recorded', async () => {
    let deliver: ((nodes: GraphNode[]) => void) | null = null
    const getNodes = vi.fn()
      .mockImplementationOnce(() => new Promise<GraphNode[]>(res => { deliver = res }))
      .mockResolvedValue([node('b', 'Customers')])
    const provider = { getNodes } as unknown as GraphDataProvider
    const { result, rerender } = renderHook(
      ({ urns }: { urns: string[] }) => useResolvedNames(urns, provider),
      { initialProps: { urns: ['a'] } },
    )
    await waitFor(() => expect(getNodes).toHaveBeenCalledTimes(1))

    // The canvas hydrates; the caller hands over a new list mid-flight.
    rerender({ urns: ['a', 'b'] })
    await waitFor(() => expect(result.current.get('b')).toBe('Customers'))

    await act(async () => { deliver!([node('a', 'Orders')]) })
    await waitFor(() => expect(result.current.get('a')).toBe('Orders'))
  })

  it('no provider, no questions and no names', async () => {
    const { result } = renderHook(() => useResolvedNames(['a'], null))
    await waitFor(() => expect(result.current.size).toBe(0))
  })

  it('an empty list asks nothing', async () => {
    const { provider, getNodes } = fakeProvider({ a: 'Orders' })
    renderHook(() => useResolvedNames([], provider))
    await waitFor(() => expect(getNodes).not.toHaveBeenCalled())
  })
})
