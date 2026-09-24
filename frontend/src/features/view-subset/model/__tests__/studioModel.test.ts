/**
 * The Subset Studio's pure model: growing along lineage, what picks cover,
 * how picks connect, where an entity from outside the view lands — and the
 * studio's own state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { GraphNode, LayerAssignmentRule } from '@/providers/GraphDataProvider'

import { summarizeConnectivity } from '../connectivity'
import { coveredRows, coveringAncestor } from '../coverage'
import { memberGraph, reachFrom } from '../grow'
import { placeOutside } from '../placement'
import { orderedPicks, useSubsetStudioStore, type SubsetPick } from '../studioStore'

const link = (source: string, target: string, hops = 1) => ({ source, target, hops })
const pick = (urn: string, over: Partial<SubsetPick> = {}): SubsetPick =>
  ({ urn, layerId: 'L1', inheritsChildren: true, origin: 'picked', label: urn, ...over })

// A → B → C → D, and B → E (a branch), and X → C (a second feed).
const graph = memberGraph([link('A', 'B'), link('B', 'C', 3), link('C', 'D'), link('B', 'E'), link('X', 'C')])

describe('reachFrom', () => {
  it('one step goes to the nearest members only', () => {
    expect(reachFrom(graph, ['C'], 'upstream', 'one').sort()).toEqual(['B', 'X'])
    expect(reachFrom(graph, ['B'], 'downstream', 'one').sort()).toEqual(['C', 'E'])
  })

  it('all goes as far as lineage runs, nearest first', () => {
    expect(reachFrom(graph, ['D'], 'upstream', 'all')).toEqual(['C', 'B', 'X', 'A'])
  })

  it('never returns what it started from', () => {
    expect(reachFrom(graph, ['B', 'C'], 'downstream', 'one').sort()).toEqual(['D', 'E'])
  })

  it('is safe on a cycle', () => {
    const loop = memberGraph([link('A', 'B'), link('B', 'A')])
    expect(reachFrom(loop, ['A'], 'downstream', 'all')).toEqual(['B'])
  })
})

describe('summarizeConnectivity', () => {
  it('splits direct links from virtual hops and names the isolated', () => {
    const s = summarizeConnectivity(['A', 'C', 'F', 'Z'], [link('A', 'C', 2), link('C', 'F', 3), link('A', 'Q', 1)])
    expect(s.direct).toEqual([])
    expect(s.virtual.map(l => `${l.source}>${l.target}`)).toEqual(['A>C', 'C>F'])
    expect(s.isolated).toEqual(['Z'])
  })

  it('an entity the walk could not finish for is unknown, not isolated', () => {
    const s = summarizeConnectivity(['A', 'Z'], [], [{ urn: 'Z', side: 'downstream', reason: 'hub' }])
    expect(s.isolated).toEqual(['A'])
    expect(s.incomplete).toEqual(['Z'])
  })
})

describe('coveredRows', () => {
  const children = new Map([['T', ['T.a', 'T.b']], ['T.b', ['T.b.x']], ['S', ['S.a']]])
  const id = (u: string) => u

  it('a pick that takes in its contents covers every loaded row beneath it', () => {
    expect([...coveredRows([pick('T')], children, id)].sort()).toEqual(['T', 'T.a', 'T.b', 'T.b.x'])
  })

  it('a pick that leaves its contents out covers itself only', () => {
    expect([...coveredRows([pick('S', { inheritsChildren: false })], children, id)]).toEqual(['S'])
  })

  it('stops at a deeper pick that leaves its own contents out', () => {
    const covered = coveredRows([pick('T'), pick('T.b', { inheritsChildren: false })], children, id)
    expect([...covered].sort()).toEqual(['T', 'T.a', 'T.b'])
  })

  it('finds the pick that already covers a row', () => {
    const byRow = new Map([['T', pick('T')], ['S', pick('S', { inheritsChildren: false })]])
    const parents = new Map([['T.a', 'T'], ['T.b', 'T'], ['T.b.x', 'T.b'], ['S.a', 'S']])
    expect(coveringAncestor('T.b.x', byRow, parents)?.urn).toBe('T')
    expect(coveringAncestor('S.a', byRow, parents)).toBeUndefined()
  })
})

describe('placeOutside', () => {
  const node = (entityType: string): GraphNode => ({ urn: `u:${entityType}`, entityType, displayName: 'n', properties: {} })
  const rules: LayerAssignmentRule[] = [{ id: 'r', layerId: 'marts', entityTypes: ['dashboard'], priority: 10 }]
  const order = ['raw', 'staging', 'marts']

  it('a layer rule decides first', () => {
    expect(placeOutside(node('dashboard'), rules, order, 'raw', 'downstream')).toEqual({ layerId: 'marts', byRule: true })
  })

  it('else one layer beyond the entity it was grown from, held to the ends', () => {
    expect(placeOutside(node('table'), rules, order, 'staging', 'upstream')).toEqual({ layerId: 'raw', byRule: false })
    expect(placeOutside(node('table'), rules, order, 'raw', 'upstream')).toEqual({ layerId: 'raw', byRule: false })
    expect(placeOutside(node('table'), rules, order, 'marts', 'downstream')).toEqual({ layerId: 'marts', byRule: false })
  })
})

describe('the studio store', () => {
  beforeEach(() => {
    sessionStorage.clear()
    useSubsetStudioStore.getState().open('view-1')
  })
  afterEach(() => useSubsetStudioStore.getState().close({ discard: true }))

  it('toggles a pick in and out, in the order picked', () => {
    const s = useSubsetStudioStore.getState()
    expect(s.toggle(pick('A'))).toBe('added')
    s.toggle(pick('B'))
    expect(orderedPicks(useSubsetStudioStore.getState()).map(p => p.urn)).toEqual(['A', 'B'])
    expect(useSubsetStudioStore.getState().toggle(pick('A'))).toBe('removed')
    expect(useSubsetStudioStore.getState().order).toEqual(['B'])
  })

  it('adds a batch once each, and undoes it as one', () => {
    const s = useSubsetStudioStore.getState()
    s.toggle(pick('A'))
    expect(s.add([pick('A'), pick('B'), pick('B'), pick('C')], 'Grow downstream')).toBe(2)
    expect(useSubsetStudioStore.getState().order).toEqual(['A', 'B', 'C'])
    useSubsetStudioStore.getState().undo()
    expect(useSubsetStudioStore.getState().order).toEqual(['A'])
  })

  it('holds no more than the cap', () => {
    const many = Array.from({ length: 1005 }, (_, i) => pick(`u${i}`))
    expect(useSubsetStudioStore.getState().add(many, 'Add all')).toBe(1000)
    expect(useSubsetStudioStore.getState().toggle(pick('one-more'))).toBe('full')
  })

  it('comes back after a reload of the same view, and is forgotten on discard', () => {
    useSubsetStudioStore.getState().toggle(pick('A'))
    useSubsetStudioStore.getState().setMaxHops(6)
    useSubsetStudioStore.getState().close()
    useSubsetStudioStore.getState().open('view-1')
    expect(useSubsetStudioStore.getState().order).toEqual(['A'])
    expect(useSubsetStudioStore.getState().maxHops).toBe(6)
    useSubsetStudioStore.getState().close({ discard: true })
    useSubsetStudioStore.getState().open('view-1')
    expect(useSubsetStudioStore.getState().order).toEqual([])
  })

  it('keeps each view its own', () => {
    useSubsetStudioStore.getState().toggle(pick('A'))
    useSubsetStudioStore.getState().open('view-2')
    expect(useSubsetStudioStore.getState().order).toEqual([])
  })

  it('holds the reach inside the bounds the server takes', () => {
    useSubsetStudioStore.getState().setMaxHops(99)
    expect(useSubsetStudioStore.getState().maxHops).toBe(20)
    useSubsetStudioStore.getState().setMaxHops(0)
    expect(useSubsetStudioStore.getState().maxHops).toBe(1)
  })
})
