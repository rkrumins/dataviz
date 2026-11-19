/**
 * A narrowing in a view the server places loads every member it holds into its layer — what
 * isn't already drawn — behind the reader, with progress; and stops when it changes.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const loadIntoCanvas = vi.hoisted(() => vi.fn())
vi.mock('@/features/served-placement/loadIntoCanvas', () => ({ loadIntoCanvas }))

import { useCanvasStore } from '@/store/canvas'
import type { MembershipResult } from '@/types/membership'

import { useNarrowServedLoad } from '../useNarrowServedLoad'

const result = (urns: string[], specHash = 'h1'): MembershipResult => ({
  specHash, members: urns.map((urn) => ({ urn, via: 'seed' as const })), wholeSubtree: [], chains: {},
  counts: { seeds: urns.length, inside: 0, upstream: 0, downstream: 0, partnerInside: 0, total: urns.length },
  missingSeeds: 0, truncated: [], dataVersion: 'd', elapsedMs: 1,
})

describe('useNarrowServedLoad', () => {
  beforeEach(() => {
    loadIntoCanvas.mockReset()
    useCanvasStore.setState({ nodes: [{ id: 'a', type: 'default', position: { x: 0, y: 0 }, data: { urn: 'a', feedLayerId: 'L1' } }] } as never)
  })

  it('loads what isn’t drawn yet, in the background, and reports how it went', async () => {
    loadIntoCanvas.mockImplementation(async (_s, _p, urns: string[], o: { onProgress?: (p: unknown) => void }) => {
      o.onProgress?.({ done: 1, total: urns.length, placed: 1, outside: 0, failed: 0 })
      return { loaded: ['b'], outside: ['c'], failed: [] }
    })
    const served = {} as never
    const provider = {} as never
    const { result: out } = renderHook(() => useNarrowServedLoad({
      served, provider, result: result(['a', 'b', 'c']), containmentEdgeTypes: ['CONTAINS'], lineageEdgeTypes: ['FLOWS_TO'],
    }))
    await waitFor(() => expect(out.current?.finished).toBe(true))
    expect(loadIntoCanvas.mock.calls[0][2]).toEqual(['b', 'c'])
    expect(loadIntoCanvas.mock.calls[0][3]).toMatchObject({ priority: 'background' })
    expect(out.current).toEqual({ done: 2, total: 3, outside: 1, failed: 0, finished: true })
  })

  it('asks nothing outside a view the server places, or when all of it is drawn', () => {
    renderHook(() => useNarrowServedLoad({ served: null, provider: {} as never, result: result(['b']), containmentEdgeTypes: [], lineageEdgeTypes: [] }))
    renderHook(() => useNarrowServedLoad({ served: {} as never, provider: {} as never, result: result(['a']), containmentEdgeTypes: [], lineageEdgeTypes: [] }))
    expect(loadIntoCanvas).not.toHaveBeenCalled()
  })

  it('stops loading when the narrowing changes', async () => {
    const signals: AbortSignal[] = []
    loadIntoCanvas.mockImplementation((_s, _p, _u, o: { signal: AbortSignal }) => { signals.push(o.signal); return new Promise(() => {}) })
    const served = {} as never
    const provider = {} as never
    const { rerender } = renderHook(({ r }) => useNarrowServedLoad({
      served, provider, result: r, containmentEdgeTypes: [], lineageEdgeTypes: [],
    }), { initialProps: { r: result(['b']) } })
    rerender({ r: result(['c'], 'h2') })
    await waitFor(() => expect(signals).toHaveLength(2))
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)
  })
})
