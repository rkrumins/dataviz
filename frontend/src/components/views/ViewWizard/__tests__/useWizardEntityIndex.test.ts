/**
 * useWizardEntityIndex — identity for assigned URNs, and paged children.
 *
 * A layer with thousands of assigned entities is the case this guards:
 *  - lookups are BATCHED (100 URNs a request), not one request per entity;
 *  - only a CONFIRMED miss (absent from a successful answer) is final — a failed
 *    request leaves its URNs unresolved and retries. Tombstoning a failure made
 *    an anchor "unknown, 0 children" for the session, and the rail then offered
 *    none of its children;
 *  - an answer that lands after the lookup effect re-ran (a snapshot publish
 *    mid-flight) is SHOWN — the re-run skips in-flight URNs, so the original
 *    run is the only one that can re-render for them;
 *  - child paging records what the SERVER said (hasMore) and whether the last
 *    page failed, and reads each page where the server said it starts.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useWizardEntityIndex } from '../useWizardEntityIndex'
import type { LayerAssignmentEntry } from '@/types/schema'

const urn = (i: number) => `urn:w:${String(i).padStart(4, '0')}`

function assignmentsFor(n: number): Record<string, LayerAssignmentEntry> {
  const out: Record<string, LayerAssignmentEntry> = {}
  for (let i = 0; i < n; i++) out[urn(i)] = { layerId: 'L1' } as LayerAssignmentEntry
  return out
}

function makeProvider() {
  return {
    getNode: vi.fn(),
    getNodes: vi.fn(async (q: { urns: string[] }) =>
      q.urns.map(u => ({ urn: u, entityType: 'system', displayName: `name ${u}`, childCount: 7 }))),
    getChildrenWithEdges: vi.fn(),
  }
}

function render(provider: ReturnType<typeof makeProvider>, assignments: Record<string, LayerAssignmentEntry>) {
  // One stable provider and assignments object: the hook resets its caches
  // when the provider identity changes.
  return renderHook(() => useWizardEntityIndex({
    provider: provider as never, containmentEdgeTypes: ['CONTAINS'], assignments, snapshot: null,
  }))
}

describe('useWizardEntityIndex — resolving assigned URNs', () => {
  afterEach(() => { vi.useRealTimers() })

  it('batches lookups 100 at a time and never asks one by one', async () => {
    const provider = makeProvider()
    const { result } = render(provider, assignmentsFor(250))
    await waitFor(() => expect(result.current.resolve(urn(249))?.name).toBe(`name ${urn(249)}`))
    expect(provider.getNode).not.toHaveBeenCalled()
    const sizes = provider.getNodes.mock.calls.map(c => (c[0] as { urns: string[] }).urns.length).sort((a, b) => b - a)
    expect(sizes).toEqual([100, 100, 50])
  })

  it('tombstones only a URN the graph confirms it does not know', async () => {
    const provider = makeProvider()
    provider.getNodes.mockImplementation(async (q: { urns: string[] }) =>
      q.urns.filter(u => u !== urn(1)).map(u => ({ urn: u, entityType: 'system', displayName: u, childCount: 0 })))
    const { result } = render(provider, assignmentsFor(3))
    await waitFor(() => expect(result.current.resolve(urn(1))?.missing).toBe(true))
    expect(result.current.resolve(urn(0))?.missing).toBeUndefined()
  })

  it('leaves a FAILED lookup unresolved and recovers it on retry', async () => {
    vi.useFakeTimers()
    const provider = makeProvider()
    const ok = provider.getNodes.getMockImplementation()!
    provider.getNodes.mockRejectedValueOnce(new Error('504'))
    const { result } = render(provider, assignmentsFor(2))

    // Let the failed request settle WITHOUT letting time pass (the retry is 1s out).
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(provider.getNodes).toHaveBeenCalledTimes(1)
    // Not "unknown, 0 children": just not known YET.
    expect(result.current.resolve(urn(0))).toBeUndefined()

    provider.getNodes.mockImplementation(ok)
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(result.current.resolve(urn(0))).toMatchObject({ name: `name ${urn(0)}`, childCount: 7 })
    expect(result.current.resolve(urn(0))?.missing).toBeUndefined()
  })
})

describe('useWizardEntityIndex — an answer that lands after a re-run', () => {
  it('is shown, not left in the cache with nothing to draw it', async () => {
    const pending: Array<{ urns: string[]; resolve: (v: unknown) => void }> = []
    const getNodes = vi.fn((q: { urns: string[] }) => new Promise(r => { pending.push({ urns: q.urns, resolve: r }) }))
    const provider = { getNodes, getChildrenWithEdges: vi.fn() }
    let assignments = assignmentsFor(3)
    const { result, rerender } = renderHook(() => useWizardEntityIndex({
      provider: provider as never, containmentEdgeTypes: ['CONTAINS'], assignments, snapshot: null,
    }))
    // An assignment edit (or a snapshot publish) re-runs the lookup mid-flight.
    assignments = { ...assignments }
    rerender()
    const before = result.current
    await act(async () => {
      pending.splice(0).forEach(p => p.resolve(p.urns.map(u => ({ urn: u, entityType: 't', displayName: u, childCount: 4000 }))))
      await new Promise(r => setTimeout(r, 1))
    })
    expect(result.current).not.toBe(before)                   // it re-rendered…
    expect(result.current.resolve(urn(0))?.childCount).toBe(4000)   // …with the answer
  })
})

describe('useWizardEntityIndex — a provider that keeps failing', () => {
  afterEach(() => { vi.useRealTimers() })

  it('is asked again on the backoff schedule, never in a burst — even when its identity churns', async () => {
    // The shape that hung a suite: a failure used to trigger a re-render, a
    // fresh provider identity reset the index, and the lookup ran again at
    // microtask speed. A failure now changes nothing on screen, so it cannot
    // drive a render; the only re-ask is the scheduled retry.
    vi.useFakeTimers()
    const getNodes = vi.fn().mockRejectedValue(new Error('down'))
    const assignments = assignmentsFor(3)
    renderHook(() => useWizardEntityIndex({
      provider: { getNodes, getChildrenWithEdges: vi.fn() } as never,   // fresh object every render
      containmentEdgeTypes: ['CONTAINS'], assignments, snapshot: null,
    }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(999) })
    expect(getNodes).toHaveBeenCalledTimes(1)
  })
})

describe('useWizardEntityIndex — paging a container', () => {
  const ANCHOR = 'urn:anchor'
  /** The server reads `count` rows at `from` and reports where the next page
   *  starts; `hide` rows are dropped from what it RETURNS (a draft that deleted
   *  them) without moving that position. */
  const page = (from: number, count: number, total: number, hide = new Set<number>()) => ({
    children: Array.from({ length: count }, (_, k) => from + k).filter(i => !hide.has(i))
      .map(i => ({ urn: urn(i), entityType: 'system', displayName: `c${i}` })),
    containmentEdges: [], lineageEdges: [], totalChildren: total,
    hasMore: from + count < total, nextOffset: from + count,
  })

  let provider: ReturnType<typeof makeProvider>
  beforeEach(() => {
    provider = makeProvider()
    provider.getChildrenWithEdges.mockImplementation(async (_u: string, o: { offset?: number }) =>
      page(o.offset ?? 0, Math.min(50, 120 - (o.offset ?? 0)), 120))
  })

  it("records the server's hasMore and reads each page where the server said it starts", async () => {
    // A draft deleted child 10: page 1 returns 49 rows, but the next page still
    // starts at 50 — counting the rows would re-read child 49 and drift.
    provider.getChildrenWithEdges.mockImplementation(async (_u: string, o: { offset?: number }) =>
      page(o.offset ?? 0, Math.min(50, 120 - (o.offset ?? 0)), 120, new Set([10])))
    const { result } = render(provider, {})
    await act(async () => { await result.current.loadChildren(ANCHOR) })
    expect(result.current.childPageState(ANCHOR)).toEqual({ hasMore: true, failed: false })

    await act(async () => { await result.current.loadMoreChildren(ANCHOR) })
    const second = provider.getChildrenWithEdges.mock.calls[1][1] as { offset?: number; cursor?: string }
    expect(second.offset).toBe(50)
    expect(second.cursor).toBeUndefined()
    await act(async () => { await result.current.loadMoreChildren(ANCHOR) })
    expect(result.current.childrenOf(ANCHOR)).toHaveLength(119)
    expect(result.current.childPageState(ANCHOR).hasMore).toBe(false)
  })

  it('says when a page failed, and clears it when the retry lands', async () => {
    const { result } = render(provider, {})
    await act(async () => { await result.current.loadChildren(ANCHOR) })
    provider.getChildrenWithEdges.mockRejectedValueOnce(new Error('503'))
    await act(async () => { await result.current.loadMoreChildren(ANCHOR) })
    expect(result.current.childPageState(ANCHOR).failed).toBe(true)
    expect(result.current.childrenOf(ANCHOR)).toHaveLength(50)          // nothing lost, nothing faked

    await act(async () => { await result.current.loadMoreChildren(ANCHOR) })
    expect(result.current.childPageState(ANCHOR).failed).toBe(false)
    expect(result.current.childrenOf(ANCHOR)).toHaveLength(100)
  })
})
