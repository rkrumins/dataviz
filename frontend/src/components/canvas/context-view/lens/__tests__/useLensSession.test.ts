/**
 * useLensSession — the request-policy contract.
 *
 * The merge semantics live in lensGraph.test.ts; these pin what the
 * hook actually asks the server, per gesture:
 *
 *   focal open   raw edges both directions + ONE both-ways trace at
 *                level "auto" + the ancestor chain, then bounded
 *                hydration (partner parents, degrees, names);
 *   ⊕            raw edges one direction + one direction-limited trace;
 *   chevron      children-with-edges pages behind a keyset cursor;
 *   drill        expandAggregated with nextLevel:null + drillAnchor.
 *
 * Plus the discipline: AGGREGATED is excluded from raw and degree
 * queries, gestures fire exactly once (explicit retry only), a trace
 * failure degrades to raw-only rather than an error, and results from
 * a superseded focal never land.
 */
import { renderHook, waitFor, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useLensSession, LENS_CHILD_PAGE, LENS_EDGE_LIMIT } from '../useLensSession'
import { expansionKeyOf } from '../lensGraph'
import { useSchemaStore } from '@/store/schema'
import type {
  EdgeQuery,
  GraphDataProvider,
  GraphEdge,
  GraphNode,
  TraceV2Request,
  TraceV2Result,
} from '@/providers/GraphDataProvider'

const ge = (id: string, s: string, t: string, edgeType = 'FLOWS_TO', properties?: Record<string, unknown>): GraphEdge =>
  ({ id, sourceUrn: s, targetUrn: t, edgeType, properties })
const gn = (urn: string, displayName = urn): GraphNode =>
  ({ urn, entityType: 'dataset', displayName, properties: {} })

const trace = (overrides: Partial<TraceV2Result> = {}): TraceV2Result => ({
  nodes: [],
  edges: [],
  containmentEdges: [],
  upstreamUrns: new Set<string>(),
  downstreamUrns: new Set<string>(),
  focus: { urn: 'f', level: 3, entityType: 'dataset' },
  effectiveLevel: 3,
  isInherited: false,
  inheritedFromUrn: null,
  truncated: false,
  truncationReason: null,
  ...overrides,
})

interface ProviderScript {
  edges?: (q: EdgeQuery) => GraphEdge[]
  trace?: (req: TraceV2Request) => TraceV2Result | Promise<TraceV2Result>
  ancestors?: (urn: string) => GraphNode[]
  children?: () => {
    children: GraphNode[]
    containmentEdges: GraphEdge[]
    lineageEdges: GraphEdge[]
    totalChildren: number
    hasMore: boolean
    nextCursor?: string | null
  }
  expand?: () => TraceV2Result
}

function makeProvider(script: ProviderScript = {}) {
  const getEdges = vi.fn(async (q: EdgeQuery) => script.edges?.(q) ?? [])
  const getNodes = vi.fn(async (q: { urns?: string[] }) => (q.urns ?? []).map(u => gn(u, `name:${u}`)))
  const getNodeDegrees = vi.fn(async (urns: string[], _edgeTypes?: string[]) =>
    Object.fromEntries(urns.map(u => [u, { in: 2, out: 3 }])))
  const getAncestors = vi.fn(async (urn: string) => script.ancestors?.(urn) ?? [])
  const traceAtLevel = vi.fn(async (req: TraceV2Request) => script.trace?.(req) ?? trace())
  const getChildrenWithEdges = vi.fn(async (_parentUrn: string, _options?: Record<string, unknown>) =>
    script.children?.() ?? {
      children: [],
      containmentEdges: [],
      lineageEdges: [],
      totalChildren: 0,
      hasMore: false,
      nextCursor: null,
    })
  const expandAggregated = vi.fn(async () => script.expand?.() ?? trace())
  const provider = {
    getEdges,
    getNodes,
    getNodeDegrees,
    getAncestors,
    traceAtLevel,
    getChildrenWithEdges,
    expandAggregated,
  } as unknown as GraphDataProvider
  return { provider, getEdges, getNodes, getNodeDegrees, getAncestors, traceAtLevel, getChildrenWithEdges, expandAggregated }
}

beforeEach(() => {
  useSchemaStore.setState({
    schema: {
      containmentEdgeTypes: ['CONTAINS'],
      // AGGREGATED is deliberately in the ontology list — the hook must
      // strip it from raw and degree queries itself.
      lineageEdgeTypes: ['FLOWS_TO', 'CONSUMES', 'AGGREGATED'],
      entityTypes: [],
      relationshipTypes: [],
    },
  } as never)
})

const doneAt = (api: NonNullable<ReturnType<typeof useLensSession>>, key: string) =>
  api.state.expansions.get(key)?.state === 'done'

describe('focal open', () => {
  it('fires raw both directions + one auto trace + ancestors, then bounded hydration', async () => {
    const { provider, getEdges, getNodeDegrees, getAncestors, traceAtLevel, getNodes } = makeProvider({
      edges: q => {
        if (q.targetUrns?.[0] === 'f') return [ge('in', 'src', 'f')]
        if (q.sourceUrns?.[0] === 'f') return [ge('out', 'f', 'sink')]
        return []
      },
      ancestors: () => [gn('db'), gn('domain')],
    })
    const { result } = renderHook(() => useLensSession('f', provider))
    await waitFor(() => expect(result.current && doneAt(result.current, expansionKeyOf('up', 'f'))).toBe(true))
    await waitFor(() => expect(getNodes).toHaveBeenCalled())

    // Raw queries: one per direction, AGGREGATED stripped, capped.
    const rawCalls = getEdges.mock.calls.map(c => c[0]).filter(q => q.sourceUrns?.[0] === 'f' || q.targetUrns?.[0] === 'f')
    expect(rawCalls).toHaveLength(2)
    for (const q of rawCalls) {
      expect(q.edgeTypes).toEqual(['FLOWS_TO', 'CONSUMES'])
      expect(q.limit).toBe(LENS_EDGE_LIMIT)
    }

    // Exactly one trace: both ways, depth 1 each, auto, inherited on.
    expect(traceAtLevel).toHaveBeenCalledTimes(1)
    expect(traceAtLevel.mock.calls[0][0]).toMatchObject({
      urn: 'f',
      direction: 'both',
      upstreamDepth: 1,
      downstreamDepth: 1,
      level: 'auto',
      includeInheritedLineage: true,
      lineageEdgeTypes: ['FLOWS_TO', 'CONSUMES'],
    })

    expect(getAncestors).toHaveBeenCalledWith('f')

    // Hydration: partner-parent containment query + degrees without
    // AGGREGATED + names — all batched, never per-node.
    const containmentCall = getEdges.mock.calls.map(c => c[0]).find(q => q.edgeTypes?.includes('CONTAINS'))
    expect(containmentCall?.targetUrns).toEqual(expect.arrayContaining(['src', 'sink']))
    expect(getNodeDegrees).toHaveBeenCalledTimes(1)
    expect(getNodeDegrees.mock.calls[0][1]).toEqual(['FLOWS_TO', 'CONSUMES'])

    // State: both directions landed, partners placed, breadcrumb known.
    const s = result.current!.state
    expect(s.hops.get('src')).toBe(-1)
    expect(s.hops.get('sink')).toBe(1)
    expect(s.parents.get('f')).toBe('db')
    expect(s.degrees.get('src')).toEqual({ in: 2, out: 3 })
  })

  it('degrades to raw-only when the trace fails, still landing as done', async () => {
    const { provider } = makeProvider({
      edges: q => (q.sourceUrns?.[0] === 'f' ? [ge('out', 'f', 'sink')] : []),
      trace: () => Promise.reject(new Error('trace down')),
    })
    const { result } = renderHook(() => useLensSession('f', provider))
    await waitFor(() => expect(result.current && doneAt(result.current, expansionKeyOf('down', 'f'))).toBe(true))
    expect(result.current!.state.hops.get('sink')).toBe(1)
  })

  it('returns null while closed and resets to a fresh session per focal', async () => {
    const { provider } = makeProvider()
    const { result, rerender } = renderHook(({ focal }: { focal: string | null }) => useLensSession(focal, provider), {
      initialProps: { focal: null as string | null },
    })
    expect(result.current).toBeNull()
    rerender({ focal: 'f' })
    await waitFor(() => expect(result.current).not.toBeNull())
    expect(result.current!.state.focal).toBe('f')
  })
})

describe('lineage expansion (⊕)', () => {
  async function openFocal(provider: GraphDataProvider) {
    const rendered = renderHook(() => useLensSession('f', provider))
    await waitFor(() =>
      expect(rendered.result.current && doneAt(rendered.result.current, expansionKeyOf('down', 'f'))).toBe(true))
    return rendered
  }

  it('fires one raw query and one direction-limited trace for the node', async () => {
    const { provider, getEdges, traceAtLevel } = makeProvider({
      edges: q => (q.sourceUrns?.[0] === 'f' ? [ge('out', 'f', 'a')] : []),
    })
    const { result } = await openFocal(provider)
    act(() => result.current!.expandLineage('down', 'a'))
    await waitFor(() => expect(doneAt(result.current!, expansionKeyOf('down', 'a'))).toBe(true))

    const raw = getEdges.mock.calls.map(c => c[0]).find(q => q.sourceUrns?.[0] === 'a')
    expect(raw).toBeDefined()
    const tr = traceAtLevel.mock.calls.map(c => c[0]).find(r => r.urn === 'a')
    expect(tr).toMatchObject({
      direction: 'downstream',
      upstreamDepth: 0,
      downstreamDepth: 1,
      level: 'auto',
    })
  })

  it('fires exactly once per key; retry refires after an error', async () => {
    let fail = false
    const { provider, getEdges } = makeProvider({
      edges: q => {
        if (q.sourceUrns?.[0] === 'a' && fail) throw new Error('boom')
        if (q.sourceUrns?.[0] === 'f') return [ge('out', 'f', 'a')]
        return []
      },
    })
    const { result } = await openFocal(provider)
    const callsFor = (urn: string) => getEdges.mock.calls.filter(c => c[0].sourceUrns?.[0] === urn).length

    act(() => {
      result.current!.expandLineage('down', 'a')
      result.current!.expandLineage('down', 'a')
    })
    await waitFor(() => expect(doneAt(result.current!, expansionKeyOf('down', 'a'))).toBe(true))
    expect(callsFor('a')).toBe(1)

    // The focal's own keys were claimed by the open — no double fetch.
    act(() => result.current!.expandLineage('down', 'f'))
    expect(callsFor('f')).toBe(1)

    fail = true
    act(() => result.current!.retryExpansion('down', 'a'))
    await waitFor(() =>
      expect(result.current!.state.expansions.get(expansionKeyOf('down', 'a'))?.state).toBe('error'))
    fail = false
    act(() => result.current!.retryExpansion('down', 'a'))
    await waitFor(() => expect(doneAt(result.current!, expansionKeyOf('down', 'a'))).toBe(true))
  })
})

describe('containment opens (chevron)', () => {
  it('pages children behind the keyset cursor and measures their degrees', async () => {
    let page = 0
    const pages = [
      { children: [gn('c1'), gn('c2')], nextCursor: 'c2', hasMore: true },
      { children: [gn('c3')], nextCursor: null, hasMore: false },
    ]
    const { provider, getChildrenWithEdges, getNodeDegrees } = makeProvider({
      children: () => ({
        ...pages[Math.min(page++, 1)],
        containmentEdges: [],
        lineageEdges: [],
        totalChildren: 3,
      }),
    })
    const { result } = renderHook(() => useLensSession('f', provider))
    await waitFor(() => expect(result.current && doneAt(result.current, expansionKeyOf('down', 'f'))).toBe(true))

    act(() => result.current!.openChildren('f'))
    await waitFor(() => expect(result.current!.state.children.get('f')?.state).toBe('done'))
    expect(getChildrenWithEdges).toHaveBeenCalledWith('f', expect.objectContaining({
      limit: LENS_CHILD_PAGE,
      includeLineageEdges: true,
      lineageEdgeTypes: ['FLOWS_TO', 'CONSUMES'],
    }))
    expect(result.current!.state.children.get('f')?.urns).toEqual(['c1', 'c2'])

    act(() => result.current!.loadMoreChildren('f'))
    await waitFor(() => expect(result.current!.state.children.get('f')?.urns).toEqual(['c1', 'c2', 'c3']))
    expect(getChildrenWithEdges.mock.calls[1][1]).toMatchObject({ cursor: 'c2' })
    expect(result.current!.state.children.get('f')?.hasMore).toBe(false)

    // Child degrees measured (AGGREGATED stripped is covered above).
    const degreeUrnBatches = getNodeDegrees.mock.calls.map(c => c[0])
    expect(degreeUrnBatches.some(b => b.includes('c1') && b.includes('c2'))).toBe(true)

    // Idempotent: reopening fires nothing new.
    const calls = getChildrenWithEdges.mock.calls.length
    act(() => result.current!.openChildren('f'))
    expect(getChildrenWithEdges.mock.calls.length).toBe(calls)
  })
})

describe('rollup drills', () => {
  it('drills with nextLevel:null and the clicked side as drillAnchor', async () => {
    const { provider, expandAggregated } = makeProvider({
      edges: q => (q.sourceUrns?.[0] === 'f'
        ? [ge('agg', 'f', 'sys', 'AGGREGATED', { weight: 3 })]
        : []),
      expand: () => trace({
        nodes: [gn('t1')],
        containmentEdges: [ge('c1', 'sys', 't1', 'CONTAINS')],
        edges: [ge('raw1', 'f', 't1')],
      }),
    })
    const { result } = renderHook(() => useLensSession('f', provider))
    await waitFor(() => expect(result.current && doneAt(result.current, expansionKeyOf('down', 'f'))).toBe(true))

    const rollup = [...result.current!.state.records.values()].find(r => r.aggregated)!
    act(() => result.current!.drillRollup(rollup.id, 'sys'))
    await waitFor(() => expect(result.current!.state.drills.get(rollup.id)?.state).toBe('done'))
    expect(expandAggregated).toHaveBeenCalledWith(expect.objectContaining({
      sourceUrn: 'f',
      targetUrn: 'sys',
      nextLevel: null,
      drillAnchor: 'sys',
    }))
    expect(result.current!.state.hops.get('t1')).toBe(1)
  })
})

describe('session integrity', () => {
  it('drops results that resolve after the focal changed', async () => {
    let releaseFirst: (edges: GraphEdge[]) => void = () => {}
    const firstGate = new Promise<GraphEdge[]>(resolve => { releaseFirst = resolve })
    const { provider } = makeProvider()
    const slowProvider = {
      ...provider,
      getEdges: vi.fn((q: EdgeQuery) => {
        if (q.sourceUrns?.[0] === 'old') return firstGate
        if (q.sourceUrns?.[0] === 'new') return Promise.resolve([ge('out', 'new', 'sink')])
        return Promise.resolve([])
      }),
    } as unknown as GraphDataProvider
    const { result, rerender } = renderHook(({ focal }: { focal: string }) => useLensSession(focal, slowProvider), {
      initialProps: { focal: 'old' },
    })
    rerender({ focal: 'new' })
    await waitFor(() => expect(result.current && doneAt(result.current, expansionKeyOf('down', 'new'))).toBe(true))
    // The old focal's fetch resolves late, into the void.
    act(() => releaseFirst([ge('stale', 'old', 'ghost')]))
    await waitFor(() => expect(result.current!.state.focal).toBe('new'))
    expect(result.current!.state.hops.has('ghost')).toBe(false)
    expect(result.current!.state.records.size).toBeGreaterThan(0)
  })
})
