/**
 * useLensLineage — orchestration tests for the on-demand lineage fetch
 * shared by the Lineage Lens and the entity drawer.
 *
 * The component tests cover the MERGE and UI; these cover the hook's
 * own contract: fetch-once per visited node, status transitions,
 * explicit retry (never an auto-retry loop), session clearing when the
 * stack empties, truncation flagging at the per-direction cap, drill
 * idempotence, typed-fetch containment/partner-parent queries, and the
 * null-provider degrade path.
 */
import { renderHook, waitFor, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useLensLineage, EDGE_FETCH_LIMIT } from '../useLensLineage'
import { useCanvasStore, type LineageEdge } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import type { GraphDataProvider, EdgeQuery } from '@/providers/GraphDataProvider'

const ge = (id: string, s: string, t: string, edgeType = 'FLOWS_TO') => ({
  id, sourceUrn: s, targetUrn: t, edgeType,
})
const gn = (urn: string, displayName: string) => ({
  urn, displayName, entityType: 'dataset', properties: {},
})

type EdgesImpl = (q: EdgeQuery) => unknown[]
type NodesImpl = (q: { urns?: string[] }) => unknown[]

function makeProvider(edgesImpl: EdgesImpl = () => [], nodesImpl: NodesImpl = () => []) {
  const getEdges = vi.fn(async (q: EdgeQuery) => edgesImpl(q))
  const getNodes = vi.fn(async (q: { urns?: string[] }) => nodesImpl(q))
  return { provider: { getEdges, getNodes } as unknown as GraphDataProvider, getEdges, getNodes }
}

beforeEach(() => {
  useCanvasStore.setState({ nodes: [], edges: [], visibleEdges: [], _nodeIndex: new Set() } as never)
  useSchemaStore.setState({ schema: null } as never)
})

describe('useLensLineage', () => {
  it('fetches each stack node ONCE, converts edges, and names unknown partners', async () => {
    const { provider, getEdges, getNodes } = makeProvider(
      (q) => (q.sourceUrns?.length ? [ge('e-out', 'a', 'x')] : [ge('e-in', 'y', 'a')]),
      () => [gn('x', 'X Node'), gn('y', 'Y Node')],
    )
    const { result, rerender } = renderHook(
      ({ stack }) => useLensLineage(stack, provider, []),
      { initialProps: { stack: ['a'] } },
    )
    await waitFor(() => expect(result.current.status.get('a')).toBe('done'))
    expect(result.current.supplementalEdges.map(e => e.id).sort()).toEqual(['e-in', 'e-out'])
    expect(result.current.supplementalNodes.get('x')?.data.label).toBe('X Node')
    expect(getEdges).toHaveBeenCalledTimes(2)
    expect(getNodes).toHaveBeenCalledTimes(1)

    // Re-render with an equivalent (new-identity) stack — no refetch.
    rerender({ stack: ['a'] })
    await waitFor(() => expect(result.current.status.get('a')).toBe('done'))
    expect(getEdges).toHaveBeenCalledTimes(2)

    // Walking pushes a NEW node — only it is fetched.
    rerender({ stack: ['a', 'b'] })
    await waitFor(() => expect(result.current.status.get('b')).toBe('done'))
    expect(getEdges).toHaveBeenCalledTimes(4)
  })

  it('does not cache URNs getNodes failed to return (they stay retryable)', async () => {
    // getNodes returns ONLY 'x', never 'z' — 'z' must not be marked as
    // resolved, so a later fetch can try again instead of stranding it
    // as an unresolved raw-id row.
    const returnedUrns: string[] = []
    const { provider, getNodes } = makeProvider(
      (q) => (q.sourceUrns?.length ? [ge('e1', 'a', 'x'), ge('e2', 'a', 'z')] : []),
      (q) => {
        returnedUrns.push(...(q.urns ?? []))
        return (q.urns ?? []).filter(u => u === 'x').map(u => gn(u, 'X Node'))
      },
    )
    const { result } = renderHook(() => useLensLineage(['a'], provider, []))
    await waitFor(() => expect(result.current.status.get('a')).toBe('done'))
    expect(result.current.supplementalNodes.has('x')).toBe(true)
    expect(result.current.supplementalNodes.has('z')).toBe(false)
    expect(returnedUrns).toContain('z')

    // Revisit via a drill fetch that references 'z' again — because 'z'
    // was never cached, it is requested once more (not stranded).
    getNodes.mockClear()
    returnedUrns.length = 0
    act(() => result.current.fetchDrill(
      { id: 'agg', source: 'a', target: 'z', data: { isAggregated: true, sourceEdgeCount: 2 } } as unknown as LineageEdge,
    ))
    await waitFor(() => expect(result.current.drillStatus.get('agg')).toBe('done'))
    expect(returnedUrns).toContain('z')
  })

  it('reports a failed fetch as error and recovers via explicit retry only', async () => {
    let fail = true
    const { provider, getEdges } = makeProvider(() => {
      if (fail) throw new Error('backend down')
      return []
    })
    const { result } = renderHook(() => useLensLineage(['a'], provider, []))
    await waitFor(() => expect(result.current.status.get('a')).toBe('error'))
    const callsAfterError = getEdges.mock.calls.length
    // No auto-retry loop: nothing new happens on its own.
    expect(callsAfterError).toBe(2)

    fail = false
    act(() => result.current.retry('a'))
    await waitFor(() => expect(result.current.status.get('a')).toBe('done'))
  })

  it('clears the session when the stack empties; reopening refetches fresh', async () => {
    const { provider, getEdges } = makeProvider((q) =>
      q.sourceUrns?.length ? [ge('e1', 'a', 'x')] : [])
    const { result, rerender } = renderHook(
      ({ stack }) => useLensLineage(stack, provider, []),
      { initialProps: { stack: ['a'] } },
    )
    await waitFor(() => expect(result.current.status.get('a')).toBe('done'))

    rerender({ stack: [] })
    await waitFor(() => expect(result.current.status.size).toBe(0))
    expect(result.current.supplementalEdges).toHaveLength(0)

    rerender({ stack: ['a'] })
    await waitFor(() => expect(result.current.status.get('a')).toBe('done'))
    expect(getEdges).toHaveBeenCalledTimes(4)
  })

  it('flags truncation when a direction hits the per-direction cap', async () => {
    const many = Array.from({ length: EDGE_FETCH_LIMIT }, (_, i) => ge(`e${i}`, 'a', `t${i}`))
    const { provider } = makeProvider((q) => (q.sourceUrns?.length ? many : []))
    const { result } = renderHook(() => useLensLineage(['a'], provider, []))
    await waitFor(() => expect(result.current.status.get('a')).toBe('done'))
    expect(result.current.truncatedIds.has('a')).toBe(true)
  })

  it('drill fetch runs the pair query once per aggregate (idempotent)', async () => {
    const { provider, getEdges } = makeProvider((q) =>
      q.sourceUrns?.length && q.targetUrns?.length
        ? [ge('raw1', 'p1', 'q1'), ge('raw2', 'p2', 'q2')]
        : [])
    const { result } = renderHook(() => useLensLineage(['a'], provider, []))
    await waitFor(() => expect(result.current.status.get('a')).toBe('done'))
    const baseCalls = getEdges.mock.calls.length

    const agg = { id: 'agg1', source: 'P', target: 'Q', data: { isAggregated: true, sourceEdgeCount: 2 } } as unknown as LineageEdge
    act(() => result.current.fetchDrill(agg))
    await waitFor(() => expect(result.current.drillStatus.get('agg1')).toBe('done'))
    expect(result.current.drillEdges.get('agg1')?.map(e => e.id)).toEqual(['raw1', 'raw2'])
    expect(getEdges).toHaveBeenCalledTimes(baseCalls + 1)

    // Second drill of the same aggregate is a no-op.
    act(() => result.current.fetchDrill(agg))
    expect(getEdges).toHaveBeenCalledTimes(baseCalls + 1)
  })

  it('typed lineage fetch adds containment and partner-parent queries', async () => {
    useSchemaStore.setState({ schema: { containmentEdgeTypes: ['CONTAINS'] } } as never)
    const { provider, getEdges } = makeProvider((q) =>
      q.sourceUrns?.includes('a') && !q.edgeTypes?.includes('CONTAINS')
        ? [ge('e1', 'a', 'x')]
        : [])
    const { result } = renderHook(() => useLensLineage(['a'], provider, ['FLOWS_TO']))
    await waitFor(() => expect(result.current.status.get('a')).toBe('done'))
    // 2 typed lineage + 2 containment (children/parent) + 1 partner-parent.
    expect(getEdges).toHaveBeenCalledTimes(5)
    const containmentCalls = getEdges.mock.calls.filter(
      ([q]) => (q as EdgeQuery).edgeTypes?.includes('CONTAINS'))
    expect(containmentCalls).toHaveLength(3)
  })

  it('degrades to a no-op when no provider is reachable', async () => {
    const { result } = renderHook(() => useLensLineage(['a'], null, []))
    // Nothing to await — the hook must simply stay empty.
    await act(async () => {})
    expect(result.current.status.size).toBe(0)
    expect(result.current.supplementalEdges).toHaveLength(0)
  })
})
