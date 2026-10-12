import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { HierarchyNode } from '@/types/hierarchy'
import { useHighlightState } from '../useHighlightState'

const lines = [
  { id: 'a>b', source: 'a', target: 'b' },
  { id: 'c>d', source: 'c', target: 'd' },
  { id: 'e>f', source: 'e', target: 'f' },
]

type Line = { id: string; source: string; target: string }

const highlight = (
  selectedNodeIds: string[],
  visibleLineageEdges: Line[] = lines,
  displayMap = new Map<string, HierarchyNode>(),
  childMap = new Map<string, string[]>(),
) => renderHook(() => useHighlightState({
  selectedNodeId: selectedNodeIds[0] ?? null,
  selectedNodeIds,
  visibleLineageEdges,
  isTracing: false,
  displayMap,
  childMap,
})).result.current

const sorted = (s: Set<string>) => [...s].sort()

describe('useHighlightState', () => {
  it('one selected entity lights its own lines', () => {
    const { highlightState } = highlight(['a'])
    expect([...highlightState.edges]).toEqual(['a>b'])
    expect([...highlightState.nodes].sort()).toEqual(['a', 'b'])
  })

  it('several selected entities light all of their lines', () => {
    const { highlightState, isHighlightActive } = highlight(['a', 'c'])
    expect(isHighlightActive).toBe(true)
    expect([...highlightState.edges].sort()).toEqual(['a>b', 'c>d'])
    expect([...highlightState.nodes].sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  // The several-entity pass walks the lines ONCE for the whole selection. It
  // has to light exactly what selecting each entity alone would, together —
  // a container's lines through its descendants, and a line that names an
  // entity by urn rather than by id.
  it('lights exactly the union of each entity selected alone — descendants and urns included', () => {
    const edges = [
      { id: 'schema.t1>x', source: 'schema.t1', target: 'x' },
      { id: 'y>schema.t2.col', source: 'y', target: 'schema.t2.col' },
      { id: 'urn:li:q>z', source: 'urn:li:q', target: 'z' },
      { id: 'w>v', source: 'w', target: 'v' },
    ]
    const childMap = new Map([
      ['schema', ['schema.t1', 'schema.t2']],
      ['schema.t2', ['schema.t2.col']],
    ])
    const displayMap = new Map([
      ['q', { id: 'q', urn: 'urn:li:q' } as unknown as HierarchyNode],
    ])
    const alone = (id: string) => highlight([id], edges, displayMap, childMap).highlightState

    const together = highlight(['schema', 'q'], edges, displayMap, childMap).highlightState
    const union = [alone('schema'), alone('q')]

    expect(sorted(together.edges)).toEqual(['schema.t1>x', 'urn:li:q>z', 'y>schema.t2.col'])
    expect(sorted(together.edges)).toEqual([...new Set(union.flatMap(u => [...u.edges]))].sort())
    expect(sorted(together.nodes)).toEqual([...new Set(union.flatMap(u => [...u.nodes]))].sort())
  })
})

describe('useHighlightState — the selection’s partners on each side', () => {
  const edges = [
    { id: 'up1>a', source: 'up1', target: 'a' },
    { id: 'up2>b', source: 'up2', target: 'b' },
    { id: 'up1>b', source: 'up1', target: 'b' },
    { id: 'a>down', source: 'a', target: 'down' },
    // Between two members of the selection: its own line, on neither side.
    { id: 'a>b', source: 'a', target: 'b' },
    { id: 'x>y', source: 'x', target: 'y' },
  ]

  it('counts the entities feeding the selection and the ones it feeds, each once', () => {
    expect(highlight(['a', 'b'], edges).selectionLineage).toEqual({ upstream: 2, downstream: 1 })
  })

  it('reads a container’s lines through its descendants', () => {
    const childMap = new Map([['schema', ['a', 'b']]])
    expect(highlight(['schema', 'x'], edges, new Map(), childMap).selectionLineage).toEqual({ upstream: 2, downstream: 2 })
  })

  it('is not asked of one entity, which has no bar to say it', () => {
    expect(highlight(['a'], edges).selectionLineage).toBeUndefined()
  })
})
