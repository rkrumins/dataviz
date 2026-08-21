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
  FULL_WALK_CONCURRENCY,
  WALK_BATCH_SIZE,
  TRACE_CHECKPOINT_NODES,
  WALK_REQUEST_FAILSAFE,
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
    expect(traceClosure.mock.calls[0]![0]).toEqual({
      urn: 'a', direction: 'both', upstreamDepth: 2, downstreamDepth: 2,
    })
    // Every request carries the session's abort signal.
    expect((traceClosure.mock.calls[0] as unknown as [unknown, { signal?: AbortSignal }])[1].signal).toBeInstanceOf(AbortSignal)
  })

  it('defaults depth to 1 when the prop is omitted', async () => {
    const { provider, traceClosure } = makeProvider()
    renderHook(() => useLensWalk('a', provider))
    await waitFor(() => expect(traceClosure).toHaveBeenCalledTimes(1))
    expect(traceClosure).toHaveBeenCalledWith(expect.objectContaining({ upstreamDepth: 1, downstreamDepth: 1 }), expect.anything())
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

/** The fixture's initial response offers t_report as a paged hub (`e:0`),
 *  which the driver now drains BY ITSELF: this provider answers that page
 *  with the fixture's `hubPage` and the `e:41` continuation with an
 *  exhausted page, exactly as a server would. The settled one-hop picture is
 *  therefore initial + hubPage = 17 nodes (the adapter test's arithmetic),
 *  and a user's extend of t_raw lifts it to 22. */
function fixtureProvider(onExtend: (req: Record<string, unknown>) => Promise<TraceV2Result & LensClosureExtras> | TraceV2Result & LensClosureExtras =
  () => toResponse(fixture.extension)) {
  const traceClosure = vi.fn(async (req: Record<string, unknown>) => {
    if (req.urn === FOCUS_URN && !req.afterCursor) return toResponse(fixture.initial)
    if (req.afterCursor === 'e:0') return toResponse(fixture.hubPage)
    if (req.afterCursor) return closureResult({ focus: { urn: req.urn as string, level: 0, entityType: 'table' } })
    return onExtend(req)
  })
  return { provider: { traceClosure } as unknown as GraphDataProvider, traceClosure }
}
const HOP1_SETTLED = 17   // initial (12) + hubPage (9 new, 4 re-shipped)

describe('useLensWalk — extend (integration with the real closure-adapter)', () => {
  it('forwards seedUrns/excludeUrns, merges the response, and clears the per-pill status on success', async () => {
    const { provider, traceClosure } = fixtureProvider()
    const { result } = renderHook(() => useLensWalk(FOCUS_URN, provider))
    await waitFor(() => expect(result.current.walkProgressFor(FOCUS_URN)?.phase).toBe('done'))
    expect(result.current.walkFor(FOCUS_URN)!.model.nodes).toHaveLength(HOP1_SETTLED)

    act(() => result.current.extend('urn:li:table:t_raw', 'up', ['urn:li:table:t_src_a', 'urn:li:table:t_src_b']))
    expect(result.current.walkFor(FOCUS_URN)!.extendStatus.get('up:urn:li:table:t_raw')).toBe('loading')

    await waitFor(() => expect(result.current.walkFor(FOCUS_URN)!.model.nodes).toHaveLength(22))
    expect(result.current.walkFor(FOCUS_URN)!.model.lineageEdges).toHaveLength(9)   // 7 (initial + extension) + the hub page's 2 new
    // Cleared back to idle (absent), not a "done" value.
    expect(result.current.walkFor(FOCUS_URN)!.extendStatus.has('up:urn:li:table:t_raw')).toBe(false)

    const req = traceClosure.mock.calls.map(c => c[0] as Record<string, unknown>).find(r => r.seedUrns)!
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
    const { provider, traceClosure } = fixtureProvider(() => {
      if (fail) throw new Error('backend down')
      return toResponse(fixture.extension)
    })
    const { result } = renderHook(() => useLensWalk(FOCUS_URN, provider))
    await waitFor(() => expect(result.current.walkProgressFor(FOCUS_URN)?.phase).toBe('done'))
    const settled = traceClosure.mock.calls.length

    act(() => result.current.extend('urn:li:table:t_raw', 'up', []))
    await waitFor(() => expect(result.current.walkFor(FOCUS_URN)!.extendStatus.get('up:urn:li:table:t_raw')).toBe('error'))
    expect(traceClosure).toHaveBeenCalledTimes(settled + 1)

    fail = false
    act(() => result.current.retryExtend('urn:li:table:t_raw', 'up', ['urn:li:table:t_src_a', 'urn:li:table:t_src_b']))
    await waitFor(() => expect(result.current.walkFor(FOCUS_URN)!.model.nodes).toHaveLength(22))
    expect(result.current.walkFor(FOCUS_URN)!.extendStatus.has('up:urn:li:table:t_raw')).toBe(false)
    expect(traceClosure).toHaveBeenCalledTimes(settled + 2)
  })
})

describe('useLensWalk — the click is acknowledged, once, per pill', () => {
  /** A provider that answers the initial fetch and then hangs, so the
   *  in-flight state is what the assertions can look at. */
  function hangingProvider() {
    const traceClosure = vi.fn(async (req: Record<string, unknown>) => {
      if (req.urn === FOCUS_URN && !req.afterCursor) return toResponse(fixture.initial)
      // The driver's own hub page settles at once (exhausted); only the
      // user's clicks hang, so the in-flight state is what the assertions
      // can look at.
      if (req.afterCursor === 'e:0' && !req.seedUrns) return closureResult({ focus: { urn: req.urn as string, level: 0, entityType: 'table' } })
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
    await waitFor(() => expect(result.current.walkProgressFor(FOCUS_URN)?.phase).toBe('done'))

    act(() => {
      result.current.extend('urn:li:table:t_raw', 'up', [])
      result.current.page('urn:li:table:t_report', 'down', 'e:41')
    })

    const status = result.current.walkFor(FOCUS_URN)!.extendStatus
    expect(status.get('up:urn:li:table:t_raw')).toBe('loading')
    expect(status.get('down:urn:li:table:t_report')).toBe('loading')
  })

  it('acknowledges the click in the same tick, and a second click on an in-flight pill queues nothing', async () => {
    const { provider, traceClosure } = hangingProvider()
    const { result } = renderHook(() => useLensWalk(FOCUS_URN, provider))
    await waitFor(() => expect(result.current.walkProgressFor(FOCUS_URN)?.phase).toBe('done'))
    const settled = traceClosure.mock.calls.length

    // No awaiting: the spinner is state set BEFORE the request goes out,
    // so a pill acknowledges the press without waiting for the server.
    act(() => result.current.extend('urn:li:table:t_raw', 'up', []))
    expect(result.current.walkFor(FOCUS_URN)!.extendStatus.get('up:urn:li:table:t_raw')).toBe('loading')

    act(() => result.current.extend('urn:li:table:t_raw', 'up', []))
    act(() => result.current.extend('urn:li:table:t_raw', 'up', []))
    expect(traceClosure).toHaveBeenCalledTimes(settled + 1)   // ONE extend
  })
})

describe('useLensWalk — page (integration with the real closure-adapter)', () => {
  it('forwards afterCursor; a fresh nextCursor replaces the old, and the driver follows it', async () => {
    // Hold the hub's continuation page until the assertions have looked at
    // the replaced cursor; then release it as an exhausted page.
    let release: (() => void) | null = null
    const traceClosure = vi.fn(async (req: Record<string, unknown>) => {
      if (req.urn === FOCUS_URN && !req.afterCursor) return toResponse(fixture.initial)
      if (req.afterCursor === 'e:0') return toResponse(fixture.hubPage)
      if (req.afterCursor === 'e:41') {
        await new Promise<void>(r => { release = r })
        return closureResult({ focus: { urn: req.urn as string, level: 0, entityType: 'table' } })
      }
      return toResponse(fixture.extension)
    })
    const provider = { traceClosure } as unknown as GraphDataProvider
    const { result } = renderHook(() => useLensWalk(FOCUS_URN, provider))
    await waitFor(() => expect(result.current.walkFor(FOCUS_URN)!.model.nodes).toHaveLength(HOP1_SETTLED))

    const pageReq = traceClosure.mock.calls.map(c => c[0] as Record<string, unknown>).find(r => r.afterCursor === 'e:0')
    expect(pageReq).toEqual({
      urn: 'urn:li:table:t_report', direction: 'downstream', upstreamDepth: 0, downstreamDepth: 1, afterCursor: 'e:0',
    })
    // The exhausted-toward-e:41 cursor REPLACES the earlier e:0 one…
    expect(result.current.walkFor(FOCUS_URN)!.model.frontierDown).toEqual([
      { urn: 'urn:li:table:t_report', totalCount: 9, nextCursor: 'e:41', kind: 'cut' },
    ])
    // …and the driver is already following it.
    await waitFor(() => expect(traceClosure.mock.calls.some(c => (c[0] as Record<string, unknown>).afterCursor === 'e:41')).toBe(true))
    expect(result.current.walkProgressFor(FOCUS_URN)?.phase).toBe('seeding')

    act(() => { release?.() })
    await waitFor(() => expect(result.current.walkProgressFor(FOCUS_URN)?.phase).toBe('done'))
    expect(result.current.walkFor(FOCUS_URN)!.model.frontierDown).toEqual([])
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

// ── The walk completes HANDS-FREE in both modes (2026-08-21) ─────────────
// One hop: everything the server OWES at hop 1 — the focus's seed pages, CUT
// frontier entries (re-seeded in bulk), paged hubs — drains by itself; DEPTH
// entries stay pills. Full flow: depth entries drain too, hop after hop, with
// no node budget — only the one-time memory checkpoint and a request failsafe
// that surfaces as an error. No "Keep walking", ever.

describe('useLensWalk — the walk completes hands-free (both modes)', () => {
  const f = (urn: string) => ({ urn, level: 0, entityType: 'table' })
  const cut = (urn: string, totalCount = 1, nextCursor: string | null = null) =>
    ({ urn, totalCount, nextCursor, reason: 'cut' as const })
  const depth = (urn: string, totalCount = 1) =>
    ({ urn, totalCount, nextCursor: null, reason: 'depth' as const })

  function providerByUrn(responses: Record<string, (req: Record<string, unknown>) => TraceV2Result & LensClosureExtras | Promise<TraceV2Result & LensClosureExtras>>) {
    const traceClosure = vi.fn(async (req: Record<string, unknown>) => {
      const impl = responses[req.urn as string]
      if (!impl) throw new Error(`unexpected call: ${JSON.stringify(req)}`)
      return impl(req)
    })
    return { provider: { traceClosure } as unknown as GraphDataProvider, traceClosure }
  }

  it('one hop: drains the focus seed cursor by itself and reports done', async () => {
    const { provider, traceClosure } = providerByUrn({
      a: (req) => req.seedCursor
        ? closureResult({ focus: f('a'), nodes: [gn('c3')] })
        : closureResult({ focus: f('a'), nodes: [gn('a'), gn('c1'), gn('c2')], truncated: true, truncationReason: 'max_nodes', seedTruncated: true, seedCursor: 's:c3' }),
    })
    const { result } = renderHook(() => useLensWalk('a', provider, 1, false))
    await waitFor(() => expect(result.current.walkProgressFor('a')?.phase).toBe('done'))

    expect(traceClosure).toHaveBeenCalledTimes(2)
    expect(traceClosure.mock.calls[1]![0]).toEqual({
      urn: 'a', direction: 'both', upstreamDepth: 1, downstreamDepth: 1,
      seedCursor: 's:c3', excludeUrns: ['a', 'c1', 'c2'],
    })
    expect(result.current.walkFor('a')!.model.seedCursor).toBeNull()
    expect(result.current.walkFor('a')!.model.truncated).toBe(false)
  })

  it('one hop: re-seeds CUT entries in one bulk request per direction and never touches DEPTH entries', async () => {
    const { provider, traceClosure } = providerByUrn({
      a: () => closureResult({
        focus: f('a'), nodes: [gn('a'), gn('b'), gn('c'), gn('d')],
        truncated: true, truncationReason: 'max_nodes',
        frontierDown: [cut('b', 2), cut('c', 2), depth('d', 9)],
      }),
      b: () => closureResult({ focus: f('b'), nodes: [gn('b1'), gn('c1')] }),
    })
    const { result } = renderHook(() => useLensWalk('a', provider, 1, false))
    await waitFor(() => expect(result.current.walkProgressFor('a')?.phase).toBe('done'))

    expect(traceClosure).toHaveBeenCalledTimes(2)
    expect(traceClosure.mock.calls[1]![0]).toEqual({
      urn: 'b', direction: 'downstream', upstreamDepth: 0, downstreamDepth: 1,
      seedUrns: ['b', 'c'], excludeUrns: ['a', 'b', 'c', 'd'],
    })
    const model = result.current.walkFor('a')!.model
    expect(model.frontierDown.map(x => x.urn)).toEqual(['d'])      // the next hop stays a pill
    expect(model.truncated).toBe(false)
  })

  it('one hop: pages a hub by its real cursor, per anchor', async () => {
    const { provider, traceClosure } = providerByUrn({
      a: () => closureResult({ focus: f('a'), nodes: [gn('a'), gn('h')], truncated: true, truncationReason: 'max_nodes', frontierDown: [cut('h', 9, 'e:7')] }),
      h: () => closureResult({ focus: f('h'), nodes: [gn('x')] }),
    })
    const { result } = renderHook(() => useLensWalk('a', provider, 1, false))
    await waitFor(() => expect(result.current.walkProgressFor('a')?.phase).toBe('done'))
    expect(traceClosure.mock.calls[1]![0]).toEqual({
      urn: 'h', direction: 'downstream', upstreamDepth: 0, downstreamDepth: 1, afterCursor: 'e:7',
    })
  })

  it('one hop: a card ⊕ whose response carries a seed cursor is followed until it drains', async () => {
    const { provider, traceClosure } = providerByUrn({
      a: () => closureResult({ focus: f('a'), nodes: [gn('a'), gn('tbl')], frontierUp: [depth('tbl', 30)] }),
      tbl: (req) => req.seedCursor === 's:c20'
        ? closureResult({ focus: f('tbl'), nodes: [gn('c20')] })
        : closureResult({ focus: f('tbl'), nodes: [gn('c1')], truncated: true, truncationReason: 'max_nodes', seedTruncated: true, seedCursor: 's:c20' }),
    })
    const { result } = renderHook(() => useLensWalk('a', provider, 1, false))
    await waitFor(() => expect(result.current.walkProgressFor('a')?.phase).toBe('done'))
    expect(traceClosure).toHaveBeenCalledTimes(1)

    act(() => result.current.extend('tbl', 'up', ['tbl']))
    await waitFor(() => expect(traceClosure).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(result.current.walkProgressFor('a')?.phase).toBe('done'))
    expect(traceClosure.mock.calls[2]![0]).toEqual({
      urn: 'tbl', direction: 'upstream', upstreamDepth: 1, downstreamDepth: 0,
      seedUrns: ['tbl'], seedCursor: 's:c20', excludeUrns: ['a', 'tbl', 'c1'],
    })
    expect(result.current.walkFor('a')!.model.nodes.map(n => n.urn).sort()).toEqual(['a', 'c1', 'c20', 'tbl'])
  })

  it('full flow: drains depth entries in bulk, hop after hop, with no budget and zero clicks', async () => {
    // a → 450 partners (depth entries) → each partner → one more node.
    const partners = Array.from({ length: 450 }, (_, i) => `p${String(i).padStart(3, '0')}`)
    const { provider, traceClosure } = providerByUrn({
      a: () => closureResult({ focus: f('a'), nodes: [gn('a'), ...partners.map(u => gn(u))], frontierDown: partners.map(u => depth(u, 1)) }),
      ...Object.fromEntries(partners.map(u => [u, (req: Record<string, unknown>) => closureResult({
        focus: f(u), nodes: (req.seedUrns as string[]).map(s => gn(`${s}-next`)),
      })])),
    })
    const { result } = renderHook(() => useLensWalk('a', provider, 1, true))
    await waitFor(() => expect(result.current.walkProgressFor('a')?.phase).toBe('done'), { timeout: 10000 })

    const bulk = traceClosure.mock.calls.slice(1).map(c => c[0] as Record<string, unknown>)
    expect(bulk).toHaveLength(Math.ceil(450 / WALK_BATCH_SIZE))
    for (const req of bulk) expect((req.seedUrns as string[]).length).toBeLessThanOrEqual(WALK_BATCH_SIZE)
    expect(result.current.walkFor('a')!.model.nodes).toHaveLength(1 + 450 + 450)
    expect(result.current.walkProgressFor('a')).toMatchObject({ phase: 'done', nodes: 901, requests: 1 + bulk.length, pending: 0 })
  })

  it('full flow: the memory checkpoint asks ONCE; continuing lifts it for good', async () => {
    const wave = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => gn(`${prefix}${i}`))
    const { provider } = providerByUrn({
      a: () => closureResult({ focus: f('a'), nodes: [gn('a'), ...wave('w1-', TRACE_CHECKPOINT_NODES)], frontierDown: [depth('w1-0', 1)] }),
      'w1-0': () => closureResult({ focus: f('w1-0'), nodes: wave('w2-', 10), frontierDown: [depth('w2-0', 1)] }),
      'w2-0': () => closureResult({ focus: f('w2-0'), nodes: wave('w3-', 10) }),
    })
    const { result } = renderHook(() => useLensWalk('a', provider, 1, true))
    await waitFor(() => expect(result.current.walkProgressFor('a')?.phase).toBe('checkpoint'), { timeout: 10000 })
    expect(result.current.walkProgressFor('a')!.pending).toBe(1)

    act(() => result.current.continuePastCheckpoint('a'))
    await waitFor(() => expect(result.current.walkProgressFor('a')?.phase).toBe('done'), { timeout: 10000 })
    expect(result.current.walkProgressFor('a')!.unbounded).toBe(true)
    expect(result.current.walkFor('a')!.model.nodes.length).toBe(1 + TRACE_CHECKPOINT_NODES + 20)
  })

  it('a failed step is never auto-retried: phase error; retryWalk gives it one more attempt', async () => {
    let fails = 1
    const { provider, traceClosure } = providerByUrn({
      a: () => closureResult({ focus: f('a'), nodes: [gn('a'), gn('b')], truncated: true, truncationReason: 'max_nodes', frontierDown: [cut('b', 2)] }),
      b: () => {
        if (fails-- > 0) throw new Error('boom')
        return closureResult({ focus: f('b'), nodes: [gn('c')] })
      },
    })
    const { result } = renderHook(() => useLensWalk('a', provider, 1, false))
    await waitFor(() => expect(result.current.walkProgressFor('a')?.phase).toBe('error'))
    await new Promise(r => setTimeout(r, 20))
    expect(traceClosure).toHaveBeenCalledTimes(2)

    act(() => result.current.retryWalk('a'))
    await waitFor(() => expect(result.current.walkProgressFor('a')?.phase).toBe('done'))
    expect(traceClosure).toHaveBeenCalledTimes(3)
  })

  it('closing the lens aborts in-flight work', async () => {
    let seen: AbortSignal | undefined
    const traceClosure = vi.fn((_req: Record<string, unknown>, opts?: { signal?: AbortSignal }) => {
      seen = opts?.signal
      return new Promise<never>(() => {})      // never resolves — the lens closes first
    })
    const provider = { traceClosure } as unknown as GraphDataProvider
    const { rerender } = renderHook(({ focus }: { focus: string | null }) => useLensWalk(focus, provider, 1, false), { initialProps: { focus: 'a' as string | null } })
    await waitFor(() => expect(traceClosure).toHaveBeenCalledTimes(1))
    expect(seen?.aborted).toBe(false)

    rerender({ focus: null })
    expect(seen?.aborted).toBe(true)
  })

  it('the request failsafe stops a walk that never converges, as an error — never silently', async () => {
    let n = 0
    const { provider } = providerByUrn({
      a: () => closureResult({ focus: f('a'), nodes: [gn('a'), gn('x0')], truncated: true, truncationReason: 'max_nodes', frontierDown: [cut('x0', 1)] }),
    })
    // Every re-seed answers with a fresh cut entry: a server bug shaped like an infinite frontier.
    ;(provider as unknown as { traceClosure: ReturnType<typeof vi.fn> }).traceClosure.mockImplementation(async (req: Record<string, unknown>) => {
      if (req.urn === 'a' && !req.seedUrns) {
        return closureResult({ focus: f('a'), nodes: [gn('a'), gn('x0')], truncated: true, truncationReason: 'max_nodes', frontierDown: [cut('x0', 1)] })
      }
      n += 1
      return closureResult({ focus: f(`x${n}`), nodes: [gn(`x${n}`)], truncated: true, truncationReason: 'max_nodes', frontierDown: [cut(`x${n}`, 1)] })
    })
    const { result } = renderHook(() => useLensWalk('a', provider, 1, false))
    await waitFor(() => expect(result.current.walkProgressFor('a')?.phase).toBe('error'), { timeout: 20000 })
    expect(result.current.walkProgressFor('a')!.requests).toBe(WALK_REQUEST_FAILSAFE)
  }, 30000)

  it('holds at most FULL_WALK_CONCURRENCY requests in flight', async () => {
    let inFlight = 0, peak = 0
    const hold = () => new Promise<void>(r => setTimeout(r, 5))
    const { provider } = providerByUrn({
      a: () => closureResult({ focus: f('a'), nodes: [gn('a'), gn('h1'), gn('h2'), gn('h3'), gn('h4'), gn('h5'), gn('h6')],
        truncated: true, truncationReason: 'max_nodes',
        frontierDown: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(u => cut(u, 9, 'e:1')) }),
      ...Object.fromEntries(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(u => [u, async () => {
        inFlight += 1; peak = Math.max(peak, inFlight)
        await hold()
        inFlight -= 1
        return closureResult({ focus: f(u), nodes: [gn(`${u}x`)] })
      }])),
    })
    const { result } = renderHook(() => useLensWalk('a', provider, 1, false))
    await waitFor(() => expect(result.current.walkProgressFor('a')?.phase).toBe('done'))
    expect(peak).toBeLessThanOrEqual(FULL_WALK_CONCURRENCY)
    expect(peak).toBeGreaterThan(1)
  })
})

describe('useLensWalk — full flow flips on MID-SESSION', () => {
  const f = (urn: string) => ({ urn, level: 0, entityType: 'dataset' })

  it('a one-hop session re-rendered with fullWalk=true walks its depth frontier to completion', async () => {
    const traceClosure = vi.fn(async (req: Record<string, unknown>) => {
      if (req.seedUrns) {
        return closureResult({ focus: f('F'), nodes: [gn('up2')] })
      }
      return closureResult({
        focus: f('F'), nodes: [gn('F'), gn('up1')],
        frontierUp: [{ urn: 'up1', totalCount: 5, nextCursor: null, reason: 'depth' }],
      })
    })
    const provider = { traceClosure } as unknown as GraphDataProvider
    const { result, rerender } = renderHook(
      ({ fw }: { fw: boolean }) => useLensWalk('F', provider, 1, fw),
      { initialProps: { fw: false } },
    )
    await waitFor(() => expect(result.current.walkProgressFor('F')?.phase).toBe('done'))
    await new Promise(r => setTimeout(r, 20))
    expect(traceClosure).toHaveBeenCalledTimes(1)   // one hop never follows a depth entry
    expect(result.current.walkProgressFor('F')!.pending).toBe(0)

    rerender({ fw: true })
    await waitFor(() => expect(traceClosure).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.walkProgressFor('F')?.phase).toBe('done'))
    expect(result.current.walkFor('F')!.model.nodes.map(n => n.urn).sort()).toEqual(['F', 'up1', 'up2'])
  })
})
