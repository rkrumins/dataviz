import { describe, expect, it } from 'vitest'

import { compilePlacementSpec, type PlacementResult } from '@/lib/placement/placement'

import { placeCanvasNodes, withSessionPlacements } from '../placeCanvasNodes'

const layer = (id: string, order: number, extra: Record<string, unknown> = {}) => ({ id, name: id, order, entityTypes: [], ...extra })

const spec = (layers: unknown[], assignments: Record<string, unknown> = {}, scope: 'all' | 'curated' = 'all') =>
  compilePlacementSpec({ content: { entityScope: scope }, layout: { referenceLayout: { layers, assignments } } })

type Node = { id: string; data: Record<string, unknown> }
const node = (id: string, type = 'thing', extra: Record<string, unknown> = {}): Node => ({ id, data: { urn: id, type, label: id, ...extra } })

/** The agreed output: the internal cascade dropped. */
const out = ({ cascade: _cascade, ...p }: PlacementResult) => p

function run(i: {
  spec: ReturnType<typeof spec>
  nodes: Node[]
  edges?: [string, string][]      // [parent, child]; a parent may be unloaded
  chains?: Record<string, string[]>
  createdInBranch?: string[]
}) {
  const nodeMap = new Map(i.nodes.map(n => [n.id, n]))
  const parentMap = new Map<string, string>()
  const childMap = new Map<string, string[]>()
  for (const [p, c] of i.edges ?? []) {
    if (!parentMap.has(c)) parentMap.set(c, p)
    childMap.set(p, [...(childMap.get(p) ?? []), c])
  }
  const result = placeCanvasNodes({
    spec: i.spec, nodes: i.nodes, nodeMap, parentMap, childMap,
    chains: new Map(Object.entries(i.chains ?? {})), createdInBranch: new Set(i.createdInBranch ?? []),
  })
  return Object.fromEntries([...result].map(([u, p]) => [u, out(p)]))
}

describe('placeCanvasNodes', () => {
  it('a hand placement on an unloaded ancestor cascades down the fetched chain to a loaded node', () => {
    const s = spec([layer('a', 0), layer('b', 1)], { root: { layerId: 'b' } })
    const placed = run({ spec: s, nodes: [node('leaf')], chains: { leaf: ['mid', 'root'] } })
    expect(placed.leaf).toEqual({ layerId: 'b', source: 'inherited', inheritedFrom: 'mid' })
    expect(placed.mid).toEqual({ layerId: 'b', source: 'inherited', inheritedFrom: 'root' })
    expect(placed.root).toEqual({ layerId: 'b', source: 'explicit' })
  })

  it('before the chain lands, an unloaded direct parent still passes on its hand placement', () => {
    const s = spec([layer('a', 0), layer('b', 1)], { parent: { layerId: 'b' } })
    expect(run({ spec: s, nodes: [node('leaf')], edges: [['parent', 'leaf']] }).leaf)
      .toEqual({ layerId: 'b', source: 'inherited', inheritedFrom: 'parent' })
  })

  it('an unloaded ancestor has no facts: its rule never fires, so nothing soft cascades from it', () => {
    const s = spec([layer('a', 0, { rules: [{ id: 'r', urnPattern: 'urn:db:*', priority: 1 }] }), layer('b', 1)])
    const placed = run({ spec: s, nodes: [node('urn:x:leaf')], chains: { 'urn:x:leaf': ['urn:db:1'] } })
    expect(placed['urn:db:1']).toEqual({ layerId: null, source: 'none' })
    expect(placed['urn:x:leaf']).toEqual({ layerId: null, source: 'none' })
  })

  it('a loaded node uses its own facts and loaded parents, never its chain', () => {
    const s = spec([layer('a', 0, { entityTypes: ['table'] }), layer('b', 1)], { far: { layerId: 'b' } })
    const placed = run({
      spec: s,
      nodes: [node('db', 'database'), node('t', 'table')],
      edges: [['db', 't']],
      chains: { t: ['db', 'far'] },
    })
    expect(placed.t).toEqual({ layerId: 'a', source: 'rule', ruleId: '_type_a_table' })
    expect(placed.far).toBeUndefined()
  })

  it('a chain stops at the first loaded ancestor, whose own placement then applies', () => {
    const s = spec([layer('a', 0), layer('b', 1)], { top: { layerId: 'a' } })
    const placed = run({
      spec: s,
      nodes: [node('top'), node('leaf')],
      chains: { leaf: ['gap', 'top', 'beyond'] },
    })
    expect(placed.leaf).toEqual({ layerId: 'a', source: 'inherited', inheritedFrom: 'gap' })
    expect(placed.gap).toEqual({ layerId: 'a', source: 'inherited', inheritedFrom: 'top' })
    expect(placed.beyond).toBeUndefined()
  })

  it('a node held by two loaded parents takes the smaller-URN hand parent, whatever the childMap order', () => {
    const s = spec([layer('a', 0), layer('b', 1)], { p2: { layerId: 'a' }, p1: { layerId: 'b' } })
    for (const edges of [[['p2', 'c'], ['p1', 'c']], [['p1', 'c'], ['p2', 'c']]] as [string, string][][]) {
      expect(run({ spec: s, nodes: [node('p1'), node('p2'), node('c')], edges }).c)
        .toEqual({ layerId: 'b', source: 'inherited', inheritedFrom: 'p1', ambiguousParent: true })
    }
  })

  it('a curated view places an entity created in this draft by its stamp, and its child follows', () => {
    const s = spec([layer('a', 0), layer('b', 1)], { other: { layerId: 'a' } }, 'curated')
    const placed = run({
      spec: s,
      nodes: [node('new', 'thing', { layerAssignment: 'b' }), node('kid')],
      edges: [['new', 'kid']],
      createdInBranch: ['new'],
    })
    expect(placed.new).toEqual({ layerId: 'b', source: 'stamped' })
    expect(placed.kid).toEqual({ layerId: 'b', source: 'inherited', inheritedFrom: 'new' })
  })
})

describe('withSessionPlacements', () => {
  const s = spec([layer('a', 0), layer('b', 1)], { x: { layerId: 'a', inheritsChildren: false } })

  it('is the spec itself when nothing was dragged', () => {
    expect(withSessionPlacements(s, new Map())).toBe(s)
  })

  it('overlays drags onto layers the view still has, keeping the view entry\'s inheritsChildren', () => {
    const next = withSessionPlacements(s, new Map([
      ['x', { layerId: 'b' }], ['y', { layerId: 'a' }], ['z', { layerId: 'gone' }],
    ]))
    expect(next.explicit.get('x')).toEqual({ layerId: 'b', inheritsChildren: false })
    expect(next.explicit.get('y')).toEqual({ layerId: 'a', inheritsChildren: true })
    expect(next.explicit.has('z')).toBe(false)
    expect(next.hasCascadingExplicit).toBe(true)
    expect(s.explicit.get('x')?.layerId).toBe('a')   // the compiled spec is untouched
  })
})
