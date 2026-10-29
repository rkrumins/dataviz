/**
 * useEdgeProjection — a Connections search's matches on the lines.
 *
 * A match lights the line that draws it (`searchMatches`) and adds nothing
 * to it: the line's weight, size and look stay its other members'. Placed
 * like any other end, a match:
 *   - between two drawn rows lights their line;
 *   - between two closed containers lights the roll-up between them, or,
 *     with none loaded, makes a line of its own that stands for the matches;
 *   - into a child of an open container not loaded yet lights the line to
 *     the container, as such an edge draws; from a loaded child to such a
 *     sibling, between two ends of one container, or out of the view, it
 *     draws nothing;
 *   - of a type the reader hid stays hidden, and containment, drawn as
 *     nesting, lights no line.
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { NO_PLACE_FOUND } from '@/hooks/useAncestorChains'
import type { MatchedEdge } from '@/store/searchStore'
import type { HierarchyNode } from '@/types/hierarchy'

import { useEdgeProjection } from '../useEdgeProjection'

const hNode = (id: string, children: HierarchyNode[] = [], data: Record<string, unknown> = {}): HierarchyNode => ({
  id, typeId: 'entity', name: id, data: { urn: id, type: 'entity', label: id, ...data }, children,
  depth: 0, urn: id, entityTypeOption: 'entity', tags: [],
})

const edge = (source: string, target: string, type = 'FLOWS_TO') => ({
  id: `${source}|${type}|${target}`, source, target, data: { edgeType: type },
})

const cell = (sourceUrn: string, targetUrn: string, edgeCount: number) => {
  const c = {
    id: `agg-${sourceUrn}-${targetUrn}`, sourceUrn, targetUrn, edgeCount,
    edgeTypes: ['FLOWS_TO'], confidence: 1, sourceEdgeIds: [],
  }
  return [c.id, { state: 'collapsed' as const, detailedEdges: [], aggregated: c }] as const
}

const match = (source: string, target: string, type = 'FLOWS_TO', chains: [string[], string[]] = [[], []]): MatchedEdge => ({
  key: `${source}|${type}|${target}`, id: `${source}|${type}|${target}`, source, target, edgeType: type,
  sourceChain: chains[0], targetChain: chains[1],
})

type Line = {
  source: string; target: string; edgeCount: number; bundleSize: number
  isGhost: boolean; isBidirectional: boolean; searchMatches: number; types: string[]
}

/**
 * Column L1 holds R and the closed container A (a1, a2 inside); column L2
 * holds S and the closed container B (b1 inside), and the open container P
 * with c1 loaded of its 5 children.
 */
function run(opts: {
  edges?: ReturnType<typeof edge>[]
  cells?: Array<ReturnType<typeof cell>>
  matches: MatchedEdge[]
  hidden?: string[]
  chains?: Record<string, readonly string[]>
}) {
  const nodesByLayer = new Map(Object.entries({
    L1: [hNode('R'), hNode('A', [hNode('a1'), hNode('a2')])],
    L2: [hNode('S'), hNode('B', [hNode('b1')]), hNode('P', [hNode('c1')], { childCount: 5 })],
  }))
  const flat: HierarchyNode[] = []
  nodesByLayer.forEach(roots => {
    const stack = [...roots]
    while (stack.length > 0) {
      const n = stack.pop()!
      flat.push(n)
      stack.push(...n.children)
    }
  })
  const { result } = renderHook(() => useEdgeProjection({
    edges: opts.edges ?? [],
    aggregatedEdges: new Map(opts.cells ?? []) as Map<string, unknown>,
    nodesByLayer,
    expandedNodes: new Set(['P']),
    displayFlat: flat,
    displayMap: new Map(flat.map(n => [n.id, n])),
    urnToIdMap: new Map(flat.map(n => [n.urn!, n.id])),
    showLineageFlow: true,
    isTracing: false,
    traceContextSet: new Set(),
    isContainmentEdge: (type: string) => type.toUpperCase() === 'CONTAINS',
    browseBundleParentMap: new Map([['a1', 'A'], ['a2', 'A'], ['b1', 'B'], ['c1', 'P']]),
    hiddenEdgeTypes: new Set(opts.hidden ?? []),
    ancestorChains: new Map(Object.entries(opts.chains ?? {})),
    searchEdges: opts.matches,
  }))
  const lines = result.current.visibleLineageEdges as Line[]
  const line = (source: string, target: string) => lines.find(l => l.source === source && l.target === target)
  return { lines, line }
}

describe('a Connections search on the lines', () => {
  it('lights the line between two drawn rows, adding nothing to it', () => {
    const { line } = run({ edges: [edge('R', 'S')], matches: [match('R', 'S')] })
    expect(line('R', 'S')).toMatchObject({ searchMatches: 1, edgeCount: 1, bundleSize: 1, isGhost: false })
  })

  it('lights the roll-up between two closed containers it falls under', () => {
    const { line } = run({ cells: [cell('A', 'B', 5)], matches: [match('a1', 'b1'), match('a2', 'b1')] })
    expect(line('A', 'B')).toMatchObject({ searchMatches: 2, edgeCount: 5, bundleSize: 1 })
  })

  it('draws a line of its own between two containers no roll-up joins', () => {
    const { lines, line } = run({ matches: [match('a1', 'b1'), match('a2', 'b1')] })
    expect(lines).toHaveLength(1)
    expect(line('A', 'B')).toMatchObject({ searchMatches: 2, edgeCount: 2, isGhost: true, types: ['FLOWS_TO'] })
  })

  it('files an end the canvas has not loaded by its chain', () => {
    const { line } = run({ matches: [match('R', 'x9', 'FLOWS_TO', [[], ['B']])], chains: { x9: ['B'] } })
    expect(line('R', 'B')).toMatchObject({ searchMatches: 1, isGhost: true })
  })

  it('lights the line to an open container for a child of it not loaded yet', () => {
    const { lines, line } = run({ matches: [match('R', 'c7')], chains: { c7: ['P'] } })
    expect(lines).toHaveLength(1)
    expect(line('R', 'P')).toMatchObject({ searchMatches: 1 })
  })

  it('draws nothing from a loaded child to a sibling not loaded yet', () => {
    const { lines } = run({ matches: [match('c1', 'c7')], chains: { c7: ['P'] } })
    expect(lines).toEqual([])
  })

  it('draws nothing between two ends in the same container, or out of the view', () => {
    const { lines } = run({
      matches: [match('a1', 'a2'), match('R', 'gone'), match('R', 'lost')],
      chains: { gone: ['elsewhere'], lost: NO_PLACE_FOUND },
    })
    expect(lines).toEqual([])
  })

  it('keeps a match of a hidden type hidden, and the line it would light as it was', () => {
    const { line } = run({
      edges: [edge('R', 'S', 'FLOWS_TO')],
      matches: [match('R', 'S', 'DEFINED_BY')],
      hidden: ['DEFINED_BY'],
    })
    expect(line('R', 'S')).toMatchObject({ searchMatches: 0, edgeCount: 1, types: ['FLOWS_TO'] })
  })

  it('lights no line for containment, which is drawn as nesting', () => {
    const { lines } = run({ matches: [match('R', 'S', 'CONTAINS')] })
    expect(lines).toEqual([])
  })

  it('counts both ways on a two-way line', () => {
    const { line } = run({ edges: [edge('R', 'S'), edge('S', 'R')], matches: [match('R', 'S'), match('S', 'R')] })
    expect(line('R', 'S')).toMatchObject({ isBidirectional: true, searchMatches: 2, edgeCount: 2 })
  })

  it('leaves every line unlit with no search', () => {
    const { line } = run({ edges: [edge('R', 'S')], matches: [] })
    expect(line('R', 'S')).toMatchObject({ searchMatches: 0 })
  })
})
