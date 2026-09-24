/**
 * useLineageBridges / useBridgePath — asked once per member set and graph
 * generation, honest about what they could not finish, and silent (never
 * "broken") where the server does not offer the walk.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const holder: { current: Record<string, unknown> } = { current: {} }
vi.mock('@/providers', async (original) => ({
  ...(await original<typeof import('@/providers')>()),
  useGraphProvider: () => holder.current,
}))

import { useBridgePath } from '../useBridgePath'
import { useLineageBridges } from '../useLineageBridges'

function wrapper() {
  // The hooks set their own retry policy; only the pause is taken away.
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

const members = [{ urn: 'A' }, { urn: 'C' }, { urn: 'F', inheritsChildren: false }]
const answer = (over: Record<string, unknown> = {}) => ({
  links: [{ source: 'A', target: 'C', hops: 2 }],
  incomplete: [],
  depthLimited: false,
  truncated: false,
  ...over,
})
const refusal = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status })

afterEach(() => { holder.current = {} })

describe('useLineageBridges', () => {
  it('asks for every member at once and hands back the links', async () => {
    const getLineageBridges = vi.fn(async (_request: unknown) => answer())
    holder.current = { scopeKey: 'ws:ds::v', getLineageBridges }
    const { result } = renderHook(
      () => useLineageBridges({ enabled: true, members, maxHops: 6 }),
      { wrapper: wrapper() },
    )
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.links).toEqual([{ source: 'A', target: 'C', hops: 2 }])
    expect(getLineageBridges).toHaveBeenCalledTimes(1)
    expect(getLineageBridges.mock.calls[0][0]).toEqual({ members, maxHops: 6 })
  })

  it('reads an unfinished walk as partial, naming who may be missing links', async () => {
    const incomplete = [{ urn: 'F', side: 'downstream', reason: 'hub' }]
    holder.current = { getLineageBridges: vi.fn(async () => answer({ incomplete })) }
    const { result } = renderHook(() => useLineageBridges({ enabled: true, members }), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.status).toBe('partial'))
    expect(result.current.incomplete).toEqual(incomplete)
  })

  it('stays quiet where the server does not offer the walk', async () => {
    holder.current = { getLineageBridges: vi.fn(async () => { throw refusal(403) }) }
    const { result } = renderHook(() => useLineageBridges({ enabled: true, members }), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.status).toBe('disabled'))
    expect(result.current.links).toEqual([])
    // A refusal is final: asking again would only be refused again.
    expect(holder.current.getLineageBridges).toHaveBeenCalledTimes(1)
  })

  it('reports any other failure as an error it can retry', async () => {
    const getLineageBridges = vi.fn()
      .mockRejectedValueOnce(refusal(500))
      .mockRejectedValueOnce(refusal(500))   // its one automatic retry
      .mockResolvedValueOnce(answer())
    holder.current = { getLineageBridges }
    const { result } = renderHook(() => useLineageBridges({ enabled: true, members }), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.status).toBe('error'))
    result.current.refetch()
    await waitFor(() => expect(result.current.status).toBe('ready'))
  })

  it('asks nothing while switched off, for an empty set, or of a provider without the walk', () => {
    const getLineageBridges = vi.fn(async () => answer())
    holder.current = { getLineageBridges }
    const off = renderHook(() => useLineageBridges({ enabled: false, members }), { wrapper: wrapper() })
    const empty = renderHook(() => useLineageBridges({ enabled: true, members: [] }), { wrapper: wrapper() })
    expect(off.result.current.status).toBe('idle')
    expect(empty.result.current.status).toBe('idle')
    holder.current = {}
    const bare = renderHook(() => useLineageBridges({ enabled: true, members }), { wrapper: wrapper() })
    expect(bare.result.current.status).toBe('idle')
    expect(getLineageBridges).not.toHaveBeenCalled()
  })

  it('says a view is too large to walk rather than drawing nothing silently', () => {
    const getLineageBridges = vi.fn(async () => answer())
    holder.current = { getLineageBridges }
    const many = Array.from({ length: 2001 }, (_, i) => ({ urn: `u${i}` }))
    const { result } = renderHook(() => useLineageBridges({ enabled: true, members: many }), { wrapper: wrapper() })
    expect(result.current.status).toBe('oversized')
    expect(getLineageBridges).not.toHaveBeenCalled()
  })

  it('re-asks when the graph moves on, not when the same set is listed again', async () => {
    const getLineageBridges = vi.fn(async () => answer())
    holder.current = { getLineageBridges }
    const { result, rerender } = renderHook(
      ({ list, generation }) => useLineageBridges({ enabled: true, members: list, generation }),
      { wrapper: wrapper(), initialProps: { list: members, generation: 1 } },
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))
    rerender({ list: [...members].reverse(), generation: 1 })
    expect(getLineageBridges).toHaveBeenCalledTimes(1)
    rerender({ list: members, generation: 2 })
    await waitFor(() => expect(getLineageBridges).toHaveBeenCalledTimes(2))
  })
})

describe('useBridgePath', () => {
  it('asks for one link with the member set it was drawn with', async () => {
    const path = { source: 'A', target: 'C', hops: 2, hiddenUrns: ['B'], endpointUrns: [], nodes: [], edges: [], ancestorChains: {}, truncated: false }
    const getLineageBridgePath = vi.fn(async (_request: unknown) => path)
    holder.current = { getLineageBridgePath }
    const { result } = renderHook(
      () => useBridgePath({ link: { source: 'A', target: 'C' }, members, maxHops: 6 }),
      { wrapper: wrapper() },
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.result).toEqual(path)
    expect(getLineageBridgePath.mock.calls[0][0]).toEqual({ members, source: 'A', target: 'C', maxHops: 6 })
  })

  it('asks nothing until there is a link to explain', () => {
    const getLineageBridgePath = vi.fn()
    holder.current = { getLineageBridgePath }
    const { result } = renderHook(() => useBridgePath({ link: null, members }), { wrapper: wrapper() })
    expect(result.current.status).toBe('idle')
    expect(getLineageBridgePath).not.toHaveBeenCalled()
  })
})
