/**
 * useLensWalk — the accumulated walk-model per focal, server-lazy one hop
 * at a time. Contract: initial depth fetch on focal change, cached per
 * (provider scope, focal) for the session, extend/page accumulate via the
 * REAL closure-adapter (never mocked here), supersede-safe, session clears
 * when the lens closes.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderHook, waitFor, act } from '@testing-library/react'
import { describe, expect, it, vi, beforeAll } from 'vitest'

import {
  useLensWalk,
  FULL_WALK_INITIAL_DEPTH,
  FULL_WALK_CONCURRENCY,
} from '../useLensWalk'
import type { GraphDataProvider, TraceV2Result, LensClosureExtras, GraphNode } from '@/providers/GraphDataProvider'

const FOCUS_URN = 'urn:li:table:t_orders'
const gn = (urn: string, entityType = 'table'): GraphNode => ({
  urn, displayName: `label-${urn}`, entityType, properties: {},
})

function closureResult(
  overrides: Partial<TraceV2Result & LensClosureExtras> & { focus: TraceV2Result['focus'] },
): TraceV2Result & LensClosureExtras {
  return {
    nodes: [], edges: [], containmentEdges: [],
    upstreamUrns: new Set(), downstreamUrns: new Set(),
    effectiveLevel: 0, isInherited: false, inheritedFromUrn: null,
    truncated: false, truncationReason: null,
    frontierUp: [], frontierDown: [], seedTruncated: false,
    ...overrides,
  }
}

function makeProvider(impl?: (req: Record<string, unknown>) => unknown) {
  const traceClosure = vi.fn(async (req: Record<string, unknown>) =>
    impl ? impl(req) : closureResult({ focus: { urn: req.urn as string, level: 0, entityType: 'table' } }))
  return { provider: { traceClosure } as unknown as GraphDataProvider, traceClosure }
}

describe('useLensWalk — initial fetch', () => {
  it('fetches once per focal, direction both, at the given depth', async () => {
    const { provider, traceClosure } = makeProvider()
    const { result } = renderHook(() => useLensWalk('a', provider, 2))

    await waitFor(() => expect(result.current.walkFor('a')?.status).toBe('done'))

    expect(traceClosure).toHaveBeenCalledTimes(1)
    expect(traceClosure).toHaveBeenCalledWith({
      urn: 'a', direction: 'both', upstreamDepth: 2, downstreamDepth: 2,
    })
  })

  it('defaults depth to 1 when the prop is omitted', async () => {
    const { provider, traceClosure } = makeProvider()
    renderHook(() => useLensWalk('a', provider))
    await waitFor(() => expect(traceClosure).toHaveBeenCalledTimes(1))
    expect(traceClosure).toHaveBeenCalledWith(expect.objectContaining({ upstreamDepth: 1, downstreamDepth: 1 }))
  })

  it('back/forward: focus A -> B -> A hits the cache, never refetching A', async () => {
    const { provider, traceClosure } = makeProvider()
    const { result, rerender } = renderHook(
      ({ focal }: { focal: string | null }) => useLensWalk(focal, provider),
      { initialProps: { focal: 'a' as string | null } },
    )
    await waitFor(() => expect(result.current.walkFor('a')?.status).toBe('done'))

    rerender({ focal: 'b' })
    await waitFor(() => expect(result.current.walkFor('b')?.status).toBe('done'))

    rerender({ focal: 'a' })
    // Cache hit — the entry is already there, instantly, with no new call.
    expect(result.current.walkFor('a')?.status).toBe('done')
    expect(traceClosure).toHaveBeenCalledTimes(2)
  })

  it('degrades to unsupported when the provider lacks traceClosure, with zero calls', async () => {
    const provider = {} as unknown as GraphDataProvider
    const { result } = renderHook(() => useLensWalk('a', provider))
    await waitFor(() => expect(result.current.walkFor('a')?.status).toBe('unsupported'))
  })

  it('clears every cached focal when the lens closes', async () => {
    const { provider } = makeProvider()
    const { result, rerender } = renderHook(
      ({ focal }: { focal: string | null }) => useLensWalk(focal, provider),
      { initialProps: { focal: 'a' as string | null } },
    )
    await waitFor(() => expect(result.current.walkFor('a')?.status).toBe('done'))

    rerender({ focal: null })
    expect(result.current.walkFor('a')).toBeNull()
  })

  it('reopening after a close re-fetches (a fresh session, not a stale cache)', async () => {
    const { provider, traceClosure } = makeProvider()
    const { result, rerender } = renderHook(
      ({ focal }: { focal: string | null }) => useLensWalk(focal, provider),
      { initialProps: { focal: 'a' as string | null } },
    )
    await waitFor(() => expect(result.current.walkFor('a')?.status).toBe('done'))
    rerender({ focal: null })
    rerender({ focal: 'a' })
    await waitFor(() => expect(result.current.walkFor('a')?.status).toBe('done'))
    expect(traceClosure).toHaveBeenCalledTimes(2)
  })

  it('reports an error and recovers via explicit retry (never an automatic loop)', async () => {
    let fail = true
    const { provider, traceClosure } = makeProvider(() => {
      if (fail) throw new Error('backend down')
      return closureResult({ focus: { urn: 'a', level: 0, entityType: 'table' } })
    })
    const { result } = renderHook(() => useLensWalk('a', provider))
    await waitFor(() => expect(result.current.walkFor('a')?.status).toBe('error'))
    expect(traceClosure).toHaveBeenCalledTimes(1)
    expect(result.current.walkFor('a')!.error).toBe('backend down')

    // No automatic retry loop.
    await new Promise(r => setTimeout(r, 20))
    expect(traceClosure).toHaveBeenCalledTimes(1)

    fail = false
    act(() => result.current.retry('a'))
    await waitFor(() => expect(result.current.walkFor('a')?.status).toBe('done'))
    expect(traceClosure).toHaveBeenCalledTimes(2)
    expect(result.current.walkFor('a')!.error).toBeNull()
  })
})

// ── extend / page — integration with the REAL closure-adapter + ───────────
// lens-subgraph (only the provider is stubbed). Reuses the same fixture
// backend/tests/test_trace_closure_wire_contract.py and
// closure-adapter.test.ts validate: `initial` (focus t_orders), `extension`
// (t_raw walked further upstream, seam edge straight back into t_orders),
// `hubPage` (t_report's downstream hub paged one step further). The node/
// edge counts asserted below are the SAME arithmetic closure-adapter.test.ts
// already pins for this exact fixture pair.

interface RawFrontierEntry { urn: string; totalCount?: number | null; nextCursor?: string | null }
interface RawClosureDoc {
  nodes: GraphNode[]
  edges: { id: string; sourceUrn: string; targetUrn: string; edgeType: string }[]
  containmentEdges: { id: string; sourceUrn: string; targetUrn: string; edgeType: string }[]
  upstreamUrns: string[]
  downstreamUrns: string[]
  focus: { urn: string; level: number; entityType: string }
  effectiveLevel: number
  isInherited: boolean
  inheritedFromUrn: string | null
  truncated: boolean
  truncationReason: string | null
  frontierUp: RawFrontierEntry[]
  frontierDown: RawFrontierEntry[]
  seedTruncated: boolean
}
interface WalkFixture { initial: RawClosureDoc; extension: RawClosureDoc; hubPage: RawClosureDoc }

let fixture: WalkFixture
beforeAll(() => {
  const path = resolve(__dirname, '../../../../backend/tests/fixtures/trace_closure_walk_fixture.json')
  fixture = JSON.parse(readFileSync(path, 'utf-8')) as WalkFixture
})

function toResponse(doc: RawClosureDoc): TraceV2Result & LensClosureExtras {
  return {
    ...doc,
    upstreamUrns: new Set(doc.upstreamUrns),
    downstreamUrns: new Set(doc.downstreamUrns),
  }
}

describe('useLensWalk — extend (integration with the real closure-adapter)', () => {
  it('forwards seedUrns/excludeUrns, merges the response, and clears the per-pill status on success', async () => {
    const traceClosure = vi.fn(async (req: Record<string, unknown>) =>
      req.urn === FOCUS_URN ? toResponse(fixture.initial) : toResponse(fixture.extension))
    const provider = { traceClosure } as unknown as GraphDataProvider
    const { result } = renderHook(() => useLensWalk(FOCUS_URN, provider))
    await waitFor(() => expect(result.current.walkFor(FOCUS_URN)?.status).toBe('done'))
    expect(result.current.walkFor(FOCUS_URN)!.model.nodes).toHaveLength(12)

    act(() => result.current.extend('urn:li:table:t_raw', 'up', ['urn:li:table:t_src_a', 'urn:li:table:t_src_b']))
    expect(result.current.walkFor(FOCUS_URN)!.extendStatus.get('up:urn:li:table:t_raw')).toBe('loading')

    await waitFor(() => expect(result.current.walkFor(FOCUS_URN)!.model.nodes).toHaveLength(17))
    expect(result.current.walkFor(FOCUS_URN)!.model.lineageEdges).toHaveLength(7)
    // Cleared back to idle (absent), not a "done" value.
    expect(result.current.walkFor(FOCUS_URN)!.extendStatus.has('up:urn:li:table:t_raw')).toBe(false)

    const req = traceClosure.mock.calls[1]![0] as Record<string, unknown>
    expect(req).toEqual({
      urn: 'urn:li:table:t_raw',
      direction: 'upstream',
      upstreamDepth: 1,
      downstreamDepth: 0,
      seedUrns: ['urn:li:table:t_src_a', 'urn:li:table:t_src_b'],
      excludeUrns: expect.arrayContaining(['urn:li:table:t_orders', 'urn:li:table:t_raw']),
    })
  })

  it('retryExtend re-fires after an error; extendStatus goes loading -> error -> idle', async () => {
    let fail = true
    const traceClosure = vi.fn(async (req: Record<string, unknown>) => {
      if (req.urn === FOCUS_URN) return toResponse(fixture.initial)
      if (fail) throw new Error('backend down')
      return toResponse(fixture.extension)
    })
    const provider = { traceClosure } as unknown as GraphDataProvider
    const { result } = renderHook(() => useLensWalk(FOCUS_URN, provider))
    await waitFor(() => expect(result.current.walkFor(FOCUS_URN)?.status).toBe('done'))

    act(() => result.current.extend('urn:li:table:t_raw', 'up', []))
    await waitFor(() => expect(result.current.walkFor(FOCUS_URN)!.extendStatus.get('up:urn:li:table:t_raw')).toBe('error'))
    expect(traceClosure).toHaveBeenCalledTimes(2)

    fail = false
    act(() => result.current.retryExtend('urn:li:table:t_raw', 'up', ['urn:li:table:t_src_a', 'urn:li:table:t_src_b']))
    await waitFor(() => expect(result.current.walkFor(FOCUS_URN)!.model.nodes).toHaveLength(17))
    expect(result.current.walkFor(FOCUS_URN)!.extendStatus.has('up:urn:li:table:t_raw')).toBe(false)
    expect(traceClosure).toHaveBeenCalledTimes(3)
  })
})

describe('useLensWalk — the click is acknowledged, once, per pill', () => {
  /** A provider that answers the initial fetch and then hangs, so the
   *  in-flight state is what the assertions can look at. */
  function hangingProvider() {
    const traceClosure = vi.fn(async (req: Record<string, unknown>) => {
      if (req.urn === FOCUS_URN) return toResponse(fixture.initial)
      return new Promise<never>(() => {})   // never settles
    })
    return { provider: { traceClosure } as unknown as GraphDataProvider, traceClosure }
  }

  it('two pills clicked in one tick BOTH keep their spinner', async () => {
    // The reported "the + needs three clicks", at its source. The
    // in-flight marker used to be written onto the entry read from a
    // ref that updates in an effect — a render behind — so the second
    // click of a tick wrote the PRE-CLICK entry back and erased the
    // first pill's spinner. The click had fired; nothing on screen
    // said so, so the user clicked again.
    const { provider } = hangingProvider()
    const { result } = renderHook(() => useLensWalk(FOCUS_URN, provider))
    await waitFor(() => expect(result.current.walkFor(FOCUS_URN)?.status).toBe('done'))

    act(() => {
      result.current.extend('urn:li:table:t_raw', 'up', [])
      result.current.page('urn:li:table:t_report', 'down', 'e:0')
    })

    const status = result.current.walkFor(FOCUS_URN)!.extendStatus
    expect(status.get('up:urn:li:table:t_raw')).toBe('loading')
    expect(status.get('down:urn:li:table:t_report')).toBe('loading')
  })

  it('acknowledges the click in the same tick, and a second click on an in-flight pill queues nothing', async () => {
    const { provider, traceClosure } = hangingProvider()
    const { result } = renderHook(() => useLensWalk(FOCUS_URN, provider))
    await waitFor(() => expect(result.current.walkFor(FOCUS_URN)?.status).toBe('done'))

    // No awaiting: the spinner is state set BEFORE the request goes out,
    // so a pill acknowledges the press without waiting for the server.
    act(() => result.current.extend('urn:li:table:t_raw', 'up', []))
    expect(result.current.walkFor(FOCUS_URN)!.extendStatus.get('up:urn:li:table:t_raw')).toBe('loading')

    act(() => result.current.extend('urn:li:table:t_raw', 'up', []))
    act(() => result.current.extend('urn:li:table:t_raw', 'up', []))
    expect(traceClosure).toHaveBeenCalledTimes(2)   // the initial fetch + ONE extend
  })
})

describe('useLensWalk — page (integration with the real closure-adapter)', () => {
  it('forwards afterCursor; a fresh nextCursor replaces the old', async () => {
    const traceClosure = vi.fn(async (req: Record<string, unknown>) => {
      if (req.urn === FOCUS_URN) return toResponse(fixture.initial)
      if (req.urn === 'urn:li:table:t_raw') return toResponse(fixture.extension)
      return toResponse(fixture.hubPage)
    })
    const provider = { traceClosure } as unknown as GraphDataProvider
    const { result } = renderHook(() => useLensWalk(FOCUS_URN, provider))
    await waitFor(() => expect(result.current.walkFor(FOCUS_URN)?.status).toBe('done'))
    act(() => result.current.extend('urn:li:table:t_raw', 'up', []))
    await waitFor(() => expect(result.current.walkFor(FOCUS_URN)!.model.nodes).toHaveLength(17))
    expect(result.current.walkFor(FOCUS_URN)!.model.frontierDown).toEqual([
      { urn: 'urn:li:table:t_report', totalCount: 9, nextCursor: 'e:0' },
    ])

    act(() => result.current.page('urn:li:table:t_report', 'down', 'e:0'))
    await waitFor(() => expect(result.current.walkFor(FOCUS_URN)!.model.nodes).toHaveLength(22))

    const req = traceClosure.mock.calls[2]![0] as Record<string, unknown>
    expect(req).toEqual({
      urn: 'urn:li:table:t_report', direction: 'downstream', upstreamDepth: 0, downstreamDepth: 1, afterCursor: 'e:0',
    })
    // The exhausted-toward-e:41 cursor REPLACES the earlier e:0 one.
    expect(result.current.walkFor(FOCUS_URN)!.model.frontierDown).toEqual([
      { urn: 'urn:li:table:t_report', totalCount: 9, nextCursor: 'e:41' },
    ])
  })
})

describe('useLensWalk — supersede', () => {
  it('a re-center mid-extend routes the late response to the OLD focal only — the new focal is untouched', async () => {
    let resolveCard: ((v: TraceV2Result & LensClosureExtras) => void) | undefined
    const traceClosure = vi.fn(async (req: Record<string, unknown>) => {
      if (req.urn === 'a') return closureResult({ focus: { urn: 'a', level: 0, entityType: 'table' } })
      if (req.urn === 'b') return closureResult({ focus: { urn: 'b', level: 0, entityType: 'table' } })
      // 'card': held open until the test resolves it explicitly.
      return new Promise<TraceV2Result & LensClosureExtras>(resolve => { resolveCard = resolve })
    })
    const provider = { traceClosure } as unknown as GraphDataProvider
    const { result, rerender } = renderHook(
      ({ focal }: { focal: string }) => useLensWalk(focal, provider),
      { initialProps: { focal: 'a' } },
    )
    await waitFor(() => expect(result.current.walkFor('a')?.status).toBe('done'))

    act(() => result.current.extend('card', 'up', []))
    expect(result.current.walkFor('a')!.extendStatus.get('up:card')).toBe('loading')

    // Re-center to a DIFFERENT focal while that extend is still in flight.
    rerender({ focal: 'b' })
    await waitFor(() => expect(result.current.walkFor('b')?.status).toBe('done'))

    // Now let the stale extend resolve.
    act(() => {
      resolveCard?.(closureResult({ focus: { urn: 'card', level: 0, entityType: 'table' }, nodes: [gn('extra')] }))
    })

    // It lands on the focal it was REQUESTED for (scoped by cacheKey) ...
    await waitFor(() => expect(result.current.walkFor('a')!.model.nodes.some(n => n.urn === 'extra')).toBe(true))
    // ... and never on the focal that is merely current now.
    expect(result.current.walkFor('b')!.model.nodes.some(n => n.urn === 'extra')).toBe(false)
  })
})

// REGRESSION (review fix round 1): extend/page used to fabricate a base
// model from emptyWalkModel whenever no 'done' entry existed yet, so a
// merge landed while the INITIAL fetch was still loading silently vanished
// the moment that fetch's success handler replaced the whole entry. The
// pill these fire from only exists once the model has rendered, so a call
// before that is a caller bug — now a no-op, not a corruption.
describe('useLensWalk — extend/page precondition (entry must be done)', () => {
  it('extend before the initial fetch resolves is a no-op: no second call, no corruption once it lands', async () => {
    let resolveInitial: ((v: TraceV2Result & LensClosureExtras) => void) | undefined
    const traceClosure = vi.fn(async (req: Record<string, unknown>) => {
      if (req.urn === 'a') return new Promise<TraceV2Result & LensClosureExtras>(resolve => { resolveInitial = resolve })
      throw new Error(`unexpected call: ${JSON.stringify(req)}`)
    })
    const provider = { traceClosure } as unknown as GraphDataProvider
    const { result } = renderHook(() => useLensWalk('a', provider))

    // Still loading — the initial fetch hasn't resolved yet.
    expect(result.current.walkFor('a')?.status).toBe('loading')

    // Calling extend now must be a silent no-op.
    act(() => result.current.extend('card', 'up', []))
    expect(traceClosure).toHaveBeenCalledTimes(1)
    expect(result.current.walkFor('a')!.extendStatus.size).toBe(0)

    // Let the initial fetch land — its model must be intact, because
    // nothing was ever merged in to be wiped.
    act(() => {
      resolveInitial?.(closureResult({ focus: { urn: 'a', level: 0, entityType: 'table' }, nodes: [gn('n1')] }))
    })
    await waitFor(() => expect(result.current.walkFor('a')?.status).toBe('done'))
    expect(result.current.walkFor('a')!.model.nodes.map(n => n.urn)).toEqual(['n1'])
    expect(traceClosure).toHaveBeenCalledTimes(1)
  })

  it('extend on an entry that errored, or a focal never fetched, is also a no-op', async () => {
    const traceClosure = vi.fn(async (req: Record<string, unknown>) => {
      if (req.urn === 'a') throw new Error('backend down')
      throw new Error(`unexpected call: ${JSON.stringify(req)}`)
    })
    const provider = { traceClosure } as unknown as GraphDataProvider
    const { result } = renderHook(() => useLensWalk('a', provider))
    await waitFor(() => expect(result.current.walkFor('a')?.status).toBe('error'))

    act(() => result.current.extend('card', 'up', []))
    act(() => result.current.page('card', 'down', 'e:0'))
    expect(traceClosure).toHaveBeenCalledTimes(1)
    expect(result.current.walkFor('a')!.extendStatus.size).toBe(0)
  })
})

// T28 R1 — the depth control (and the `deepen` re-fetch it drove, T24 F4)
// is gone; `WalkEntry.depth` survives as an honest fact about the INITIAL
// fetch only now (see the field's own doc comment).
describe('useLensWalk — fetched depth', () => {
  it('tracks the depth an entry was fetched at, from the initial fetch', async () => {
    const { provider } = makeProvider()
    const { result } = renderHook(() => useLensWalk('a', provider, 2))
    await waitFor(() => expect(result.current.walkFor('a')?.status).toBe('done'))
    expect(result.current.walkFor('a')!.depth).toBe(2)
  })
})

// ── Full walk (trace mode) — the hook itself follows every frontier the ───
// server reports until the flow is exhausted or the node budget is hit.
// Contract: deep initial fetch, auto-extend (seeded with the frontier node
// itself) for depth-exhausted entries, auto-page for cursor entries, honest
// budgetHit/stalled states, "continue" resumes both, toggling off cancels.

describe('useLensWalk — full walk', () => {
  const f = (urn: string) => ({ urn, level: 0, entityType: 'table' })
  const frontier = (urn: string, totalCount = 1, nextCursor: string | null = null) =>
    ({ urn, totalCount, nextCursor })

  function providerByUrn(responses: Record<string, () => TraceV2Result & LensClosureExtras | Promise<TraceV2Result & LensClosureExtras>>) {
    const traceClosure = vi.fn(async (req: Record<string, unknown>) => {
      const impl = responses[req.urn as string]
      if (!impl) throw new Error(`unexpected call: ${JSON.stringify(req)}`)
      return impl()
    })
    return { provider: { traceClosure } as unknown as GraphDataProvider, traceClosure }
  }

  it('fetches the initial closure DEEP, regardless of the one-hop preference', async () => {
    const { provider, traceClosure } = providerByUrn({
      a: () => closureResult({ focus: f('a') }),
    })
    renderHook(() => useLensWalk('a', provider, 1, true))
    await waitFor(() => expect(traceClosure).toHaveBeenCalledTimes(1))
    expect(traceClosure).toHaveBeenCalledWith({
      urn: 'a', direction: 'both', upstreamDepth: FULL_WALK_INITIAL_DEPTH, downstreamDepth: FULL_WALK_INITIAL_DEPTH,
    })
  })

  it('auto-extends a depth-exhausted frontier entry, seeded with the frontier node itself, then reports exhausted', async () => {
    const { provider, traceClosure } = providerByUrn({
      a: () => closureResult({ focus: f('a'), nodes: [gn('a'), gn('b')], frontierUp: [frontier('b')] }),
      b: () => closureResult({ focus: f('b'), nodes: [gn('c')] }),
    })
    const { result } = renderHook(() => useLensWalk('a', provider, 1, true))
    await waitFor(() => expect(result.current.fullWalkFor('a')?.exhausted).toBe(true))

    expect(traceClosure).toHaveBeenCalledTimes(2)
    expect(traceClosure.mock.calls[1]![0]).toEqual({
      urn: 'b', direction: 'upstream', upstreamDepth: 1, downstreamDepth: 0,
      seedUrns: ['b'], excludeUrns: ['a', 'b'],
    })
    expect(result.current.walkFor('a')!.model.nodes.map(n => n.urn).sort()).toEqual(['a', 'b', 'c'])
  })

  it('auto-pages a frontier entry that carries a cursor', async () => {
    const { provider, traceClosure } = providerByUrn({
      a: () => closureResult({ focus: f('a'), nodes: [gn('a'), gn('h')], frontierDown: [frontier('h', 9, 'e:7')] }),
      h: () => closureResult({ focus: f('h'), nodes: [gn('x')] }),
    })
    const { result } = renderHook(() => useLensWalk('a', provider, 1, true))
    await waitFor(() => expect(result.current.fullWalkFor('a')?.exhausted).toBe(true))

    expect(traceClosure.mock.calls[1]![0]).toEqual({
      urn: 'h', direction: 'downstream', upstreamDepth: 0, downstreamDepth: 1, afterCursor: 'e:7',
    })
  })

  it('keeps walking hop after hop until every frontier drains', async () => {
    const { provider, traceClosure } = providerByUrn({
      a: () => closureResult({ focus: f('a'), nodes: [gn('a'), gn('b')], frontierUp: [frontier('b')] }),
      b: () => closureResult({ focus: f('b'), nodes: [gn('c')], frontierUp: [frontier('c')] }),
      c: () => closureResult({ focus: f('c'), nodes: [] }),
    })
    const { result } = renderHook(() => useLensWalk('a', provider, 1, true))
    await waitFor(() => expect(result.current.fullWalkFor('a')?.exhausted).toBe(true))

    expect(traceClosure).toHaveBeenCalledTimes(3)
    expect(result.current.walkFor('a')!.model.nodes.map(n => n.urn).sort()).toEqual(['a', 'b', 'c'])
  })

  it('does nothing when the mode is off: frontiers stay pills, fullWalkFor is null', async () => {
    const { provider, traceClosure } = providerByUrn({
      a: () => closureResult({ focus: f('a'), nodes: [gn('a'), gn('b')], frontierUp: [frontier('b')] }),
    })
    const { result } = renderHook(() => useLensWalk('a', provider))
    await waitFor(() => expect(result.current.walkFor('a')?.status).toBe('done'))
    await new Promise(r => setTimeout(r, 20))

    expect(traceClosure).toHaveBeenCalledTimes(1)
    expect(result.current.fullWalkFor('a')).toBeNull()
  })

  // THE RULING, AS A TEST (2026-08-21): "we must see the entire lineage; we
  // must not apply any constraints." The walk used to stop at 1,000 nodes and
  // ask the reader to press "Keep walking". A thousand-node first response no
  // longer stops anything — the frontier behind it is followed hands-free and
  // the walk simply finishes, with `budgetHit` false throughout.
  it('no node budget: a thousand-node response keeps walking to exhaustion', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => gn(`n${i}`))
    const { provider, traceClosure } = providerByUrn({
      a: () => closureResult({ focus: f('a'), nodes: many, frontierUp: [frontier('n0')] }),
      n0: () => closureResult({ focus: f('n0'), nodes: [gn('deeper')] }),
    })
    const { result } = renderHook(() => useLensWalk('a', provider, 1, true))

    await waitFor(() => expect(result.current.fullWalkFor('a')?.exhausted).toBe(true))
    expect(result.current.fullWalkFor('a')?.budgetHit).toBe(false)
    expect(result.current.walkFor('a')!.model.nodes.some(n => n.urn === 'deeper')).toBe(true)
    expect(traceClosure).toHaveBeenCalledTimes(2)
  })

  it('never auto-retries a failed frontier op: reports stalled, and "continue" gives it another attempt', async () => {
    let fail = true
    const { provider, traceClosure } = providerByUrn({
      a: () => closureResult({ focus: f('a'), nodes: [gn('a'), gn('b')], frontierUp: [frontier('b')] }),
      b: () => {
        if (fail) throw new Error('backend down')
        return closureResult({ focus: f('b'), nodes: [gn('c')] })
      },
    })
    const { result } = renderHook(() => useLensWalk('a', provider, 1, true))
    await waitFor(() => expect(result.current.fullWalkFor('a')?.stalled).toBe(true))
    expect(traceClosure).toHaveBeenCalledTimes(2)
    await new Promise(r => setTimeout(r, 20))
    expect(traceClosure).toHaveBeenCalledTimes(2)

    fail = false
    act(() => result.current.continueFullWalk('a'))
    await waitFor(() => expect(result.current.fullWalkFor('a')?.exhausted).toBe(true))
    expect(result.current.walkFor('a')!.model.nodes.some(n => n.urn === 'c')).toBe(true)
  })

  it('toggling the mode off cancels the walk: in-flight results land, nothing new fires', async () => {
    let resolveB: ((v: TraceV2Result & LensClosureExtras) => void) | undefined
    const { provider, traceClosure } = providerByUrn({
      a: () => closureResult({ focus: f('a'), nodes: [gn('a'), gn('b')], frontierUp: [frontier('b')] }),
      b: () => new Promise<TraceV2Result & LensClosureExtras>(resolve => { resolveB = resolve }),
      c: () => closureResult({ focus: f('c'), nodes: [] }),
    })
    const { result, rerender } = renderHook(
      ({ walk }: { walk: boolean }) => useLensWalk('a', provider, 1, walk),
      { initialProps: { walk: true } },
    )
    await waitFor(() => expect(traceClosure).toHaveBeenCalledTimes(2))

    rerender({ walk: false })
    act(() => {
      resolveB?.(closureResult({ focus: f('b'), nodes: [gn('c2')], frontierUp: [frontier('c')] }))
    })
    // The landed hop is kept, but the frontier it opened is NOT followed.
    await waitFor(() => expect(result.current.walkFor('a')!.model.nodes.some(n => n.urn === 'c2')).toBe(true))
    await new Promise(r => setTimeout(r, 20))
    expect(traceClosure).toHaveBeenCalledTimes(2)
    expect(result.current.fullWalkFor('a')).toBeNull()
  })

  it('holds at most FULL_WALK_CONCURRENCY frontier ops in flight', async () => {
    const spokes = Array.from({ length: 6 }, (_, i) => `s${i}`)
    const hang = () => new Promise<never>(() => {})
    const { provider, traceClosure } = providerByUrn({
      a: () => closureResult({
        focus: f('a'),
        nodes: [gn('a'), ...spokes.map(s => gn(s))],
        frontierUp: spokes.map(s => frontier(s)),
      }),
      ...Object.fromEntries(spokes.map(s => [s, hang])),
    })
    renderHook(() => useLensWalk('a', provider, 1, true))
    await waitFor(() => expect(traceClosure).toHaveBeenCalledTimes(1 + FULL_WALK_CONCURRENCY))
    await new Promise(r => setTimeout(r, 20))
    expect(traceClosure).toHaveBeenCalledTimes(1 + FULL_WALK_CONCURRENCY)
  })
})

describe('useLensWalk — full walk follows the seed cursor (focus contents pages)', () => {
  const f = (urn: string) => ({ urn, level: 0, entityType: 'dataset' })

  it('auto-pages a capped container seed until it drains, focus-anchored with excludes', async () => {
    const calls: Array<Record<string, unknown>> = []
    const traceClosure = vi.fn(async (req: Record<string, unknown>) => {
      calls.push(req)
      if (!req.seedCursor) {
        return closureResult({ focus: f('F'), nodes: [gn('F'), gn('w1')], seedTruncated: true, seedCursor: 's:w1' })
      }
      if (req.seedCursor === 's:w1') {
        return closureResult({ focus: f('F'), nodes: [gn('w2')], seedTruncated: true, seedCursor: 's:w2' })
      }
      return closureResult({ focus: f('F'), nodes: [gn('w3')], seedCursor: null })
    })
    const provider = { traceClosure } as unknown as GraphDataProvider
    const { result } = renderHook(() => useLensWalk('F', provider, 1, true))

    await waitFor(() => expect(result.current.fullWalkFor('F')?.exhausted).toBe(true))
    expect(traceClosure).toHaveBeenCalledTimes(3)
    expect(result.current.walkFor('F')!.model.nodes.map(n => n.urn).sort()).toEqual(['F', 'w1', 'w2', 'w3'])
    // The continuation is FOCUS-anchored, both directions, with excludes.
    const second = calls[1]!
    expect(second.urn).toBe('F')
    expect(second.seedCursor).toBe('s:w1')
    expect(second.direction).toBe('both')
    expect(second.excludeUrns).toEqual(expect.arrayContaining(['F', 'w1']))
    // The drained model keeps no cursor.
    expect(result.current.walkFor('F')!.model.seedCursor).toBeNull()
  })

  it('one-hop mode exposes pageSeeds for the manual "Load more contents" affordance', async () => {
    const traceClosure = vi.fn(async (req: Record<string, unknown>) => {
      if (!req.seedCursor) {
        return closureResult({ focus: f('F'), nodes: [gn('F'), gn('w1')], seedTruncated: true, seedCursor: 's:w1' })
      }
      return closureResult({ focus: f('F'), nodes: [gn('w2')], seedCursor: null })
    })
    const provider = { traceClosure } as unknown as GraphDataProvider
    const { result } = renderHook(() => useLensWalk('F', provider))
    await waitFor(() => expect(result.current.walkFor('F')?.status).toBe('done'))
    expect(traceClosure).toHaveBeenCalledTimes(1)   // one-hop never auto-pages

    act(() => result.current.pageSeeds('F'))
    await waitFor(() => expect(result.current.walkFor('F')!.model.nodes.some(n => n.urn === 'w2')).toBe(true))
    expect(result.current.walkFor('F')!.model.seedCursor).toBeNull()
  })

  it("pageSeeds marks its OWN 'seed:' status key — a genuine upstream extend of the focus is not blocked", async () => {
    let releaseSeedPage: (() => void) | null = null
    const traceClosure = vi.fn(async (req: Record<string, unknown>) => {
      if (req.seedCursor) {
        await new Promise<void>(r => { releaseSeedPage = r })
        return closureResult({ focus: f('F'), nodes: [gn('w2')], seedCursor: null })
      }
      if (req.seedUrns) {
        return closureResult({ focus: f('F'), nodes: [gn('up1')] })
      }
      return closureResult({ focus: f('F'), nodes: [gn('F'), gn('w1')], seedTruncated: true, seedCursor: 's:w1' })
    })
    const provider = { traceClosure } as unknown as GraphDataProvider
    const { result } = renderHook(() => useLensWalk('F', provider))
    await waitFor(() => expect(result.current.walkFor('F')?.status).toBe('done'))

    act(() => result.current.pageSeeds('F'))
    await waitFor(() => expect(result.current.walkFor('F')!.extendStatus.get('seed:F')).toBe('loading'))
    expect(result.current.walkFor('F')!.extendStatus.has('up:F')).toBe(false)

    // The focus's upstream ⊕ still works while the contents page is in flight.
    act(() => result.current.extend('F', 'up', ['F']))
    await waitFor(() => expect(result.current.walkFor('F')!.model.nodes.some(n => n.urn === 'up1')).toBe(true))

    act(() => { releaseSeedPage?.() })
    await waitFor(() => expect(result.current.walkFor('F')!.model.nodes.some(n => n.urn === 'w2')).toBe(true))
  })
})

describe('useLensWalk — "Load everything" flips full walk on MID-SESSION', () => {
  const f = (urn: string) => ({ urn, level: 0, entityType: 'dataset' })

  it('a one-hop session re-rendered with fullWalk=true walks its existing frontier to exhaustion', async () => {
    const traceClosure = vi.fn(async (req: Record<string, unknown>) => {
      if (req.seedUrns) {
        // The frontier extend: closes the walk (no further frontier).
        return closureResult({ focus: f('F'), nodes: [gn('up2')] })
      }
      return closureResult({
        focus: f('F'), nodes: [gn('F'), gn('up1')],
        frontierUp: [{ urn: 'up1', totalCount: 5, nextCursor: null }],
      })
    })
    const provider = { traceClosure } as unknown as GraphDataProvider
    const { result, rerender } = renderHook(
      ({ fw }: { fw: boolean }) => useLensWalk('F', provider, 1, fw),
      { initialProps: { fw: false } },
    )
    await waitFor(() => expect(result.current.walkFor('F')?.status).toBe('done'))
    await new Promise(r => setTimeout(r, 20))
    expect(traceClosure).toHaveBeenCalledTimes(1)   // one-hop never auto-follows
    expect(result.current.fullWalkFor('F')).toBeNull()

    rerender({ fw: true })
    await waitFor(() => expect(result.current.fullWalkFor('F')?.exhausted).toBe(true))
    expect(result.current.walkFor('F')!.model.nodes.map(n => n.urn).sort()).toEqual(['F', 'up1', 'up2'])
  })
})
