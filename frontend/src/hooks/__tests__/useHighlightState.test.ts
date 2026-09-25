import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useHighlightState } from '../useHighlightState'

const lines = [
  { id: 'a>b', source: 'a', target: 'b' },
  { id: 'c>d', source: 'c', target: 'd' },
  { id: 'e>f', source: 'e', target: 'f' },
]

const highlight = (selectedNodeIds: string[]) => renderHook(() => useHighlightState({
  selectedNodeId: selectedNodeIds[0] ?? null,
  selectedNodeIds,
  visibleLineageEdges: lines,
  isTracing: false,
  displayMap: new Map(),
  childMap: new Map(),
})).result.current

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
})
