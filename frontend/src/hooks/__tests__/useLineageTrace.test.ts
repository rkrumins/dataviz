/**
 * Smoke tests for useLineageTrace.
 *
 * Mocks `postTrace` / `postTraceExpand` — does NOT hit a real server.
 * Covers:
 *  - state transitions on start (idle → loading → success)
 *  - applyDelta merge correctness on expand
 *  - AbortController plumbing (rapid start: only the last result lands)
 *  - debounced edge-type filter retrace (350ms triggers exactly one call)
 *  - clear() resets state and aborts pending controllers
 *  - TraceApiError propagation into state.error
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyDelta,
  useLineageTrace,
  type TraceResult,
} from '../useLineageTrace'
import {
  TraceApiError,
  type TraceDelta,
  type TraceResultV2,
} from '@/services/traceApi'
import * as traceApi from '@/services/traceApi'

// Hoisted fetch wrapper mock so the API client never reaches network.
vi.mock('@/services/fetchWithTimeout', () => ({
  fetchWithTimeout: vi.fn(),
}))

const WS = 'ws-test'

function buildResult(focusUrn = 'urn:n:focus'): TraceResultV2 {
  return {
    data: {
      focusUrn,
      focusLevel: 0,
      targetLevel: 0,
      nodes: [
        {
          urn: focusUrn,
          entityType: 'Domain',
          displayName: 'Focus',
          properties: {},
        },
      ],
      edges: [],
      upstreamUrns: [],
      downstreamUrns: [],
      expandableUrns: ['urn:n:focus'],
      aggregatedChildCount: { 'urn:n:focus': 3 },
      inheritedFrom: [],
      hasMore: false,
      nextCursor: null,
    },
    meta: {
      regime: 'materialized',
      cacheStatus: 'miss',
      ontologyDigest: 'digest-1',
      traceSessionId: 'session-1',
      targetLevel: 0,
      targetLevelSource: 'ontology_default',
      queryMs: 12,
      materializedHitRate: 1.0,
      warnings: [],
      notices: [],
    },
  }
}

beforeEach(() => {
  // Reset the singleton store before every test.
  useLineageTrace.getState().clear()
  useLineageTrace.getState().bindWorkspace(WS)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useLineageTrace.start()', () => {
  it('transitions idle -> loading -> success and stores the result', async () => {
    const result = buildResult()
    const spy = vi.spyOn(traceApi, 'postTrace').mockResolvedValue(result)

    expect(useLineageTrace.getState().status).toBe('idle')

    const promise = useLineageTrace.getState().start('urn:n:focus', {})

    // After the synchronous part of start(), we should be loading.
    expect(useLineageTrace.getState().status).toBe('loading')
    expect(useLineageTrace.getState().focusUrn).toBe('urn:n:focus')

    await promise

    expect(useLineageTrace.getState().status).toBe('success')
    expect(useLineageTrace.getState().result).toEqual(result)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('errors set state.error and status=error without throwing', async () => {
    vi.spyOn(traceApi, 'postTrace').mockRejectedValue(
      new TraceApiError('trace_focus_not_found', 'No such URN', 404, { foo: 1 }),
    )

    await useLineageTrace.getState().start('urn:n:missing', {})

    const state = useLineageTrace.getState()
    expect(state.status).toBe('error')
    expect(state.error?.code).toBe('trace_focus_not_found')
    expect(state.error?.message).toBe('No such URN')
  })

  it('aborts the prior in-flight request when start is called twice rapidly', async () => {
    const first = buildResult('urn:n:first')
    const second = buildResult('urn:n:second')

    let firstResolve: (v: TraceResultV2) => void = () => {}
    const firstPromise = new Promise<TraceResultV2>((res) => {
      firstResolve = res
    })

    let firstSignal: AbortSignal | undefined
    const spy = vi
      .spyOn(traceApi, 'postTrace')
      .mockImplementationOnce((_ws, _body, opts) => {
        firstSignal = opts?.signal
        // Resolve only after we've seen the abort.
        return firstPromise
      })
      .mockResolvedValueOnce(second)

    // Kick off the first request — its promise will hang.
    const p1 = useLineageTrace.getState().start('urn:n:first', {})

    // Immediately kick off a second — this should abort the first.
    const p2 = useLineageTrace.getState().start('urn:n:second', {})

    // Now resolve the (stale) first request.
    firstResolve(first)
    await Promise.all([p1, p2])

    expect(spy).toHaveBeenCalledTimes(2)
    expect(firstSignal?.aborted).toBe(true)

    const state = useLineageTrace.getState()
    expect(state.focusUrn).toBe('urn:n:second')
    expect(state.result).toEqual(second)
    expect(state.status).toBe('success')
  })
})

describe('useLineageTrace.expand() + applyDelta', () => {
  it('applyDelta merges added nodes/edges and removes edges', () => {
    const base: TraceResultV2 = buildResult()
    base.data.edges = [
      {
        id: 'agg-1',
        sourceUrn: 'urn:n:focus',
        targetUrn: 'urn:n:other',
        edgeType: 'AGGREGATED',
        isAggregated: true,
        weight: 5,
        sourceEdgeTypes: ['TRANSFORMS'],
        underlyingPairs: 5,
        source: 'materialized',
        isContainment: false,
      },
    ]

    const delta: TraceDelta = {
      data: {
        addedNodes: [
          {
            urn: 'urn:n:child1',
            entityType: 'Platform',
            displayName: 'Child 1',
            properties: {},
          },
        ],
        removedEdges: ['agg-1'],
        addedEdges: [
          {
            id: 'edge-detail',
            sourceUrn: 'urn:n:child1',
            targetUrn: 'urn:n:other',
            edgeType: 'TRANSFORMS',
            isAggregated: false,
            weight: 1,
            sourceEdgeTypes: ['TRANSFORMS'],
            underlyingPairs: 1,
            source: 'trace_time',
            isContainment: false,
          },
        ],
        newExpandableUrns: ['urn:n:child1'],
        aggregatedChildCount: { 'urn:n:child1': 2 },
      },
      meta: { ...base.meta, queryMs: 5 },
    }

    const merged = applyDelta(base, delta, 'urn:n:focus')
    expect(merged).not.toBeNull()
    expect(merged!.data.nodes.map((n) => n.urn).sort()).toEqual([
      'urn:n:child1',
      'urn:n:focus',
    ])
    expect(merged!.data.edges.map((e) => e.id)).toEqual(['edge-detail'])
    // expandable: 'urn:n:focus' removed (just expanded), 'urn:n:child1' added
    expect(merged!.data.expandableUrns).toEqual(['urn:n:child1'])
    expect(merged!.data.aggregatedChildCount['urn:n:child1']).toBe(2)
  })

  it('expand() merges delta into result and clears pending', async () => {
    const base = buildResult()
    vi.spyOn(traceApi, 'postTrace').mockResolvedValue(base)
    await useLineageTrace.getState().start('urn:n:focus', {})

    const delta: TraceDelta = {
      data: {
        addedNodes: [
          {
            urn: 'urn:n:child',
            entityType: 'Platform',
            displayName: 'Child',
            properties: {},
          },
        ],
        removedEdges: [],
        addedEdges: [],
        newExpandableUrns: ['urn:n:child'],
        aggregatedChildCount: {},
      },
      meta: base.meta,
    }
    vi.spyOn(traceApi, 'postTraceExpand').mockResolvedValue(delta)

    await useLineageTrace.getState().expand('urn:n:focus')

    const state = useLineageTrace.getState()
    expect(state.result?.data.nodes.map((n) => n.urn).sort()).toEqual([
      'urn:n:child',
      'urn:n:focus',
    ])
    expect(state.pendingExpansionUrns.has('urn:n:focus')).toBe(false)
    expect(state.delta).toHaveLength(1)
  })
})

describe('useLineageTrace.setEdgeTypeFilter()', () => {
  it('debounces retrace by 350ms and triggers exactly one server call', async () => {
    vi.useFakeTimers()
    const result = buildResult()
    const spy = vi.spyOn(traceApi, 'postTrace').mockResolvedValue(result)

    // Real timers for the initial start — fake them after.
    vi.useRealTimers()
    await useLineageTrace.getState().start('urn:n:focus', {})
    expect(spy).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    // Fire several filter changes within the debounce window.
    useLineageTrace.getState().setEdgeTypeFilter(['TRANSFORMS'])
    useLineageTrace.getState().setEdgeTypeFilter(['TRANSFORMS', 'COPY'])
    useLineageTrace.getState().setEdgeTypeFilter(['DERIVES'])

    expect(useLineageTrace.getState().pendingFilterRetrace).toBe(true)
    // Not yet retraced — still 1 call total.
    expect(spy).toHaveBeenCalledTimes(1)

    // Advance the debounce window. The timer schedules a start(),
    // which itself is async — flush microtasks afterwards.
    await vi.advanceTimersByTimeAsync(350)
    vi.useRealTimers()
    // Yield so the start() promise can settle.
    await Promise.resolve()
    await Promise.resolve()

    expect(spy).toHaveBeenCalledTimes(2)
    expect(useLineageTrace.getState().pendingFilterRetrace).toBe(false)
  })
})

describe('useLineageTrace.clear()', () => {
  it('resets all state and aborts pending controllers', async () => {
    let signalCaptured: AbortSignal | undefined
    let resolveTrace: (v: TraceResultV2) => void = () => {}
    const hangingPromise = new Promise<TraceResultV2>((res) => {
      resolveTrace = res
    })
    vi.spyOn(traceApi, 'postTrace').mockImplementationOnce((_ws, _body, opts) => {
      signalCaptured = opts?.signal
      return hangingPromise
    })

    // Kick off a request that never resolves, then clear.
    const p = useLineageTrace.getState().start('urn:n:focus', {})

    expect(useLineageTrace.getState().status).toBe('loading')

    useLineageTrace.getState().clear()

    expect(signalCaptured?.aborted).toBe(true)

    // Allow the in-flight handler to settle (abort path returns silently).
    resolveTrace(buildResult())
    await p

    const state = useLineageTrace.getState()
    expect(state.status).toBe('idle')
    expect(state.focusUrn).toBeNull()
    expect(state.result).toBeNull()
    expect(state.error).toBeNull()
    expect(state.pendingExpansionUrns.size).toBe(0)
    expect(state.locallyCollapsedUrns.size).toBe(0)
  })
})

describe('TraceResult type alias', () => {
  it('is assignable from TraceResultV2', () => {
    // Compile-time check via runtime use: just an identity assignment.
    const v: TraceResult = buildResult()
    expect(v.meta.traceSessionId).toBe('session-1')
  })
})
