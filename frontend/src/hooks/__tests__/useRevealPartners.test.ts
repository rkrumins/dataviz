/**
 * useRevealPartners — bring a card's partners that are in the view but not
 * drawn onto the canvas, along their paths only.
 *
 * The model canvas here: an anchor is drawn as its column, so a child of it
 * held by the store is a row; below that, a node is drawn when its parent is
 * drawn and open. What the hook opens and loads is read off that.
 */
import { renderHook, act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useRevealPartners } from '../useRevealPartners'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import type { GraphDataProvider, GraphEdge, GraphNode } from '@/providers/GraphDataProvider'

const graphNode = (urn: string): GraphNode => ({ urn, entityType: 'dataset', displayName: urn, properties: {} })
const lineageNode = (id: string) => ({ id, position: { x: 0, y: 0 }, data: { label: id, urn: id, type: 'generic' } }) as LineageNode
const contains = (parent: string, child: string) => ({
  id: `c:${parent}>${child}`, source: parent, target: child, type: 'lineage',
  data: { edgeType: 'CONTAINS', relationship: 'CONTAINS' },
})

/** child → parent, as the server knows it. */
const PARENTS: Record<string, string> = {}

function provider() {
  const chainOf = (urn: string) => {
    const chain: string[] = []
    for (let up = PARENTS[urn]; up; up = PARENTS[up]) chain.push(up)
    return chain
  }
  return {
    getAncestorChains: vi.fn(async (urns: string[]) => Object.fromEntries(urns.map(u => [u, chainOf(u)]))),
    getNodes: vi.fn(async (q: { urns?: string[] }) => (q.urns ?? []).map(graphNode)),
    getEdgesBetween: vi.fn(async (urns: string[]) => {
      const asked = new Set(urns)
      return urns.filter(u => PARENTS[u] && asked.has(PARENTS[u]))
        .map(u => ({ id: `c:${PARENTS[u]}>${u}`, sourceUrn: PARENTS[u], targetUrn: u, edgeType: 'CONTAINS' }))
    }),
    // Flows: none unless a test says so.
    getEdges: vi.fn(async (_q: { sourceUrns?: string[]; targetUrns?: string[] }): Promise<GraphEdge[]> => []),
    getAncestors: vi.fn(),
    getChildren: vi.fn(),
    getChildrenWithEdges: vi.fn(),
  }
}

function canvas(anchors: string[], rows: string[]) {
  const anchorSet = new Set(anchors)
  const rowSet = new Set(rows)
  let expanded = new Set<string>()
  const order: string[] = []
  const setExpandedNodes = vi.fn((update: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    const next = typeof update === 'function' ? update(expanded) : update
    order.push(`open:${[...next].filter(id => !expanded.has(id)).sort().join(',')}`)
    expanded = next
  })
  const markFirstPageHandled = vi.fn((id: string) => { order.push(`mark:${id}`) })
  const parentOf = (id: string) => useCanvasStore.getState().edges
    .find(e => e.target === id && e.data?.edgeType === 'CONTAINS')?.source
  const isVisible = (id: string): boolean => {
    if (rowSet.has(id)) return true
    if (!useCanvasStore.getState()._nodeIndex.has(id)) return false
    const parent = parentOf(id)
    if (!parent) return false
    if (anchorSet.has(parent)) return true
    return expanded.has(parent) && isVisible(parent)
  }
  return {
    setExpandedNodes, markFirstPageHandled, isVisible, order,
    isAnchor: (urn: string) => anchorSet.has(urn),
    expanded: () => expanded,
  }
}

function seed(ids: string[], edges: ReturnType<typeof contains>[] = []) {
  useCanvasStore.setState({
    nodes: ids.map(lineageNode),
    edges: edges as never,
    _nodeIndex: new Set(ids),
    _edgeIndex: new Set(edges.map(e => e.id)),
    visibleEdges: [],
    lineagePartial: { in: new Set(), out: new Set() },
  })
}

function reveal(p: ReturnType<typeof provider>, c: ReturnType<typeof canvas>, chains: ReadonlyMap<string, readonly string[]> = new Map()) {
  return renderHook(() => useRevealPartners({
    provider: p as unknown as GraphDataProvider,
    setExpandedNodes: c.setExpandedNodes as never,
    markFirstPageHandled: c.markFirstPageHandled,
    chainOf: (urn) => chains.get(urn),
    isVisible: c.isVisible,
    isAnchor: c.isAnchor,
    containmentEdgeTypes: ['CONTAINS'],
    lineageEdgeTypes: ['FLOWS_TO'],
    settleMs: 20,
  })).result
}

beforeEach(() => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => { cb(0); return 0 })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  for (const k of Object.keys(PARENTS)) delete PARENTS[k]
})

describe('useRevealPartners', () => {
  it('a hundred partners cost three requests: chains it lacks, the nodes, the edges', async () => {
    const partners = Array.from({ length: 100 }, (_, i) => `p${i}`)
    for (const p of partners) PARENTS[p] = 'A'
    seed(['A'])
    // The canvas already knows where sixty of them live.
    const known = new Map(partners.slice(0, 60).map(p => [p, ['A']] as const))
    const p = provider()
    const c = canvas(['A'], [])

    const result = reveal(p, c, known)
    let outcome: { landed: string[]; missed: string[] } | undefined
    await act(async () => { outcome = await result.current(partners) })

    expect(p.getAncestorChains).toHaveBeenCalledTimes(1)
    expect(p.getAncestorChains).toHaveBeenCalledWith(partners.slice(60))
    expect(p.getNodes).toHaveBeenCalledTimes(1)
    expect(p.getNodes).toHaveBeenCalledWith({ urns: partners, limit: 100 })
    expect(p.getEdgesBetween).toHaveBeenCalledTimes(1)
    expect(p.getAncestors).not.toHaveBeenCalled()
    expect(p.getChildren).not.toHaveBeenCalled()
    expect(p.getChildrenWithEdges).not.toHaveBeenCalled()
    expect(outcome).toEqual({ landed: partners, missed: [] })
  })

  it('a promoted anchor is where the path stops, and is never opened', async () => {
    PARENTS.p = 'A'
    PARENTS.X = 'A'
    PARENTS.p2 = 'X'
    seed(['A'])
    const p = provider()
    const c = canvas(['A'], [])

    const result = reveal(p, c)
    let outcome: { landed: string[]; missed: string[] } | undefined
    await act(async () => { outcome = await result.current(['p', 'p2']) })

    // X holds its spine child before it opens, and everything opens at once.
    expect(c.order).toEqual(['mark:X', 'open:X'])
    expect(c.expanded().has('A')).toBe(false)
    expect(outcome).toEqual({ landed: ['p', 'p2'], missed: [] })
  })

  it('a collapsed row on the path opens, and so does every level below it', async () => {
    PARENTS.R = 'A'
    PARENTS.Y = 'R'
    PARENTS.p = 'Y'
    seed(['A', 'R'], [contains('A', 'R')])
    const p = provider()
    const c = canvas(['A'], ['R'])

    const result = reveal(p, c, new Map([['p', ['Y', 'R', 'A']]]))
    let outcome: { landed: string[]; missed: string[] } | undefined
    await act(async () => { outcome = await result.current(['p']) })

    expect(c.markFirstPageHandled.mock.calls.map(([id]) => id).sort()).toEqual(['R', 'Y'])
    expect(c.setExpandedNodes).toHaveBeenCalledTimes(1)
    expect([...c.expanded()].sort()).toEqual(['R', 'Y'])
    // Only the partner's own path is asked for.
    expect(p.getNodes).toHaveBeenCalledWith({ urns: ['Y', 'p'], limit: 2 })
    expect(outcome).toEqual({ landed: ['p'], missed: [] })
  })

  it('a partner whose path reaches nothing drawn is not placed, and costs no load', async () => {
    PARENTS.p = 'ROOT'
    seed(['A'])
    const p = provider()
    const c = canvas(['A'], [])

    const result = reveal(p, c)
    let outcome: { landed: string[]; missed: string[] } | undefined
    await act(async () => { outcome = await result.current(['p']) })

    expect(p.getNodes).not.toHaveBeenCalled()
    expect(p.getEdgesBetween).not.toHaveBeenCalled()
    expect(c.setExpandedNodes).not.toHaveBeenCalled()
    expect(outcome).toEqual({ landed: [], missed: ['p'] })
  })

  it('landing is counted by drawn rows, not by the store', async () => {
    PARENTS.p = 'A'
    seed(['A'])
    const p = provider()
    // The edge never arrives: the node is in the store, and drawn nowhere.
    p.getEdgesBetween.mockResolvedValue([])
    const c = canvas(['A'], [])

    const result = reveal(p, c)
    let outcome: { landed: string[]; missed: string[] } | undefined
    await act(async () => { outcome = await result.current(['p']) })

    expect(useCanvasStore.getState()._nodeIndex.has('p')).toBe(true)
    expect(outcome).toEqual({ landed: [], missed: ['p'] })
  })

  it('a partner already drawn costs nothing', async () => {
    seed(['A', 'p'], [contains('A', 'p')])
    const p = provider()
    const c = canvas(['A'], [])

    const result = reveal(p, c)
    let outcome: { landed: string[]; missed: string[] } | undefined
    await act(async () => { outcome = await result.current(['p']) })

    expect(p.getAncestorChains).not.toHaveBeenCalled()
    expect(p.getNodes).not.toHaveBeenCalled()
    expect(outcome).toEqual({ landed: ['p'], missed: [] })
  })

  it('a partner it lands gets its own flows, so its other lines draw', async () => {
    PARENTS.p = 'A'
    PARENTS.q = 'ROOT'
    seed(['A'])
    const p = provider()
    const flowsTo = (source: string, target: string): GraphEdge => ({ id: `f:${source}>${target}`, sourceUrn: source, targetUrn: target, edgeType: 'FLOWS_TO' })
    // p's flows out come back at the cap: there may be more of them.
    p.getEdges.mockImplementation(async (q) => q.sourceUrns
      ? [flowsTo('p', 'x'), ...Array.from({ length: 499 }, (_, i) => flowsTo('p', `x${i}`))]
      : [flowsTo('w', 'p')])
    const c = canvas(['A'], [])

    const result = reveal(p, c)
    let outcome: { landed: string[]; missed: string[] } | undefined
    await act(async () => { outcome = await result.current(['p', 'q']) })

    expect(outcome).toEqual({ landed: ['p'], missed: ['q'] })
    await waitFor(() => expect(useCanvasStore.getState().edges.map(e => e.id)).toEqual(expect.arrayContaining(['f:p>x', 'f:w>p'])))
    // Only what landed is read: q is not on the canvas to draw from.
    expect(p.getEdges).toHaveBeenCalledTimes(2)
    expect(p.getEdges).toHaveBeenCalledWith({ sourceUrns: ['p'], edgeTypes: ['FLOWS_TO'], limit: 500 })
    expect(p.getEdges).toHaveBeenCalledWith({ targetUrns: ['p'], edgeTypes: ['FLOWS_TO'], limit: 500 })
    expect([...useCanvasStore.getState().lineagePartial.out]).toEqual(['p'])
  })

  it('flows read for a graph that has since been replaced are not kept', async () => {
    PARENTS.p = 'A'
    seed(['A'])
    const p = provider()
    let answer: (edges: GraphEdge[]) => void = () => {}
    p.getEdges.mockImplementation(async (q) => q.sourceUrns
      ? new Promise<GraphEdge[]>(resolve => { answer = resolve })
      : [])
    const c = canvas(['A'], [])

    const result = reveal(p, c)
    await act(async () => { await result.current(['p']) })
    await waitFor(() => expect(p.getEdges).toHaveBeenCalledTimes(2))
    act(() => { useCanvasStore.getState().setGraph(useCanvasStore.getState().nodes, useCanvasStore.getState().edges) })
    await act(async () => { answer([{ id: 'f:p>x', sourceUrn: 'p', targetUrn: 'x', edgeType: 'FLOWS_TO' }]) })

    expect(useCanvasStore.getState().edges.some(e => e.id === 'f:p>x')).toBe(false)
  })
})
