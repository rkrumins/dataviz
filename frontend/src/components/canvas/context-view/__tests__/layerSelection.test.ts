/**
 * selectableIdsInLayer — what "Select all in <Layer>" selects, wherever it is
 * asked from: every loaded entity in the layer, folded containers' insides
 * included, never a group, never a row a filter has taken off the canvas.
 */
import { describe, expect, it } from 'vitest'

import type { NarrowVisibility } from '@/features/narrow/model'
import type { HierarchyNode } from '@/types/hierarchy'

import { selectableIdsInLayer } from '../layerSelection'

const n = (id: string, children: HierarchyNode[] = [], extra: Partial<HierarchyNode> = {}): HierarchyNode =>
  ({ id, urn: id, name: id, typeId: 't', data: {}, children, depth: 0, tags: [], entityTypeOption: {} as never, ...extra })

// Sources: wh ⊃ {s1 ⊃ {t1, t2}, s2}, and a group holding lake ⊃ {b1}. Reports: d1.
const byLayer = new Map<string, HierarchyNode[]>([
  ['sources', [
    n('wh', [n('s1', [n('t1'), n('t2')]), n('s2')]),
    n('logical:g', [n('lake', [n('b1')])], { isLogical: true }),
  ]],
  ['reports', [n('d1')]],
])

describe('selectableIdsInLayer', () => {
  it('takes every loaded entity in the layer, inside folded containers too, top-down', () => {
    expect(selectableIdsInLayer('sources', byLayer)).toEqual(['wh', 's1', 't1', 't2', 's2', 'lake', 'b1'])
    expect(selectableIdsInLayer('reports', byLayer)).toEqual(['d1'])
    expect(selectableIdsInLayer('nowhere', byLayer)).toEqual([])
  })

  it('never a group, though what is in one is the layer\'s', () => {
    expect(selectableIdsInLayer('sources', byLayer)).not.toContain('logical:g')
  })

  it('Isolate leaves out what it hides: matches and the way down to them stay', () => {
    const search = { mode: 'isolate' as const, matches: new Set(['t2', 'b1']), spine: new Map([['wh', 1], ['s1', 1], ['lake', 1]]) }
    expect(selectableIdsInLayer('sources', byLayer, { search })).toEqual(['wh', 's1', 't2', 'lake', 'b1'])
  })

  it('Hide leaves out the matches; Highlight leaves out nothing', () => {
    const matches = new Set(['t2', 'b1'])
    expect(selectableIdsInLayer('sources', byLayer, { search: { mode: 'hide', matches, spine: new Map() } }))
      .toEqual(['wh', 's1', 't1', 's2', 'lake'])
    expect(selectableIdsInLayer('sources', byLayer, { search: { mode: 'highlight', matches, spine: new Map() } }))
      .toHaveLength(7)
  })

  it('a narrowing keeps its members, the way down to them, and all inside a whole member', () => {
    const narrow: NarrowVisibility = {
      byUrn: new Map([['s1', {} as never], ['b1', {} as never]]),
      ancestors: new Map([['wh', 1], ['lake', 1]]),
      whole: new Set(['s1']),
    }
    expect(selectableIdsInLayer('sources', byLayer, { narrow })).toEqual(['wh', 's1', 't1', 't2', 'lake', 'b1'])
  })

  it('what is selected already is never filtered away', () => {
    const search = { mode: 'hide' as const, matches: new Set(['t1']), spine: new Map() }
    expect(selectableIdsInLayer('sources', byLayer, { search, selected: new Set(['t1']) })).toContain('t1')
  })
})
