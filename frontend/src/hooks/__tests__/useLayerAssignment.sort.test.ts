/**
 * Node-ordering tests for `useLayerAssignment` — the per-layer comparator
 * resolution added for user-defined sort modes:
 *
 *   effective mode = ephemeral override → layer.nodeSortMode
 *                    → defaultNodeSortMode → 'alpha-asc'
 *
 * Roots in 'custom' mode order by assignment `orderKey` (keyed first,
 * ordinally; unkeyed after, alphabetically). Children always sort
 * alphabetically asc/desc (custom is a root-level concept).
 */
import { renderHook } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useLayerAssignment } from '../useLayerAssignment'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import type { LayerAssignmentEntry, LayerNodeSortAlgo, ViewLayerConfig } from '@/types/schema'

type TestNode = { id: string; data: Record<string, unknown> }

const node = (id: string, type = 'obj'): TestNode => ({
  id,
  data: { urn: id, type, label: id },
})

const layer = (id: string, order: number, extra: Partial<ViewLayerConfig> = {}): ViewLayerConfig => ({
  id,
  name: id,
  order,
  entityTypes: [],
  ...extra,
})

const assign = (layerId: string, orderKey?: string): LayerAssignmentEntry => ({
  layerId,
  inheritsChildren: true,
  ...(orderKey ? { orderKey } : {}),
})

function rootNames(opts: {
  nodes: TestNode[]
  sortedLayers: ViewLayerConfig[]
  assignments: Record<string, LayerAssignmentEntry>
  defaultNodeSortMode?: LayerNodeSortAlgo
  sortOverrides?: ReadonlyMap<string, LayerNodeSortAlgo>
  childMap?: Map<string, string[]>
  parentMap?: Map<string, string>
}): Map<string, string[]> {
  const nodeMap = new Map<string, TestNode>(opts.nodes.map(n => [n.id, n]))
  const { result } = renderHook(() =>
    useLayerAssignment({
      nodes: opts.nodes,
      sortedLayers: opts.sortedLayers,
      nodeEdgeFingerprint: opts.nodes.map(n => n.id).join(','),
      instanceAssignments: new Map(),
      effectiveAssignments: new Map(),
      nodeMap,
      childMap: opts.childMap ?? new Map(),
      parentMap: opts.parentMap ?? new Map(),
      assignments: opts.assignments,
      defaultNodeSortMode: opts.defaultNodeSortMode,
      sortOverrides: opts.sortOverrides,
    }),
  )
  const out = new Map<string, string[]>()
  result.current.nodesByLayer.forEach((list, layerId) => {
    out.set(layerId, list.map(n => n.name))
  })
  return out
}

beforeEach(() => {
  useStagedChangesStore.setState({ changes: [], _scopeKey: null, _byScope: {} })
})

describe('useLayerAssignment — node sort modes', () => {
  const abc = () => [node('alpha'), node('beta'), node('gamma')]
  const allAssigned = () => ({
    alpha: assign('l1'),
    beta: assign('l1'),
    gamma: assign('l1'),
  })

  it('defaults to alphabetical ascending', () => {
    const out = rootNames({
      nodes: abc(),
      sortedLayers: [layer('l1', 0)],
      assignments: allAssigned(),
    })
    expect(out.get('l1')).toEqual(['alpha', 'beta', 'gamma'])
  })

  it("honours a layer's alpha-desc override", () => {
    const out = rootNames({
      nodes: abc(),
      sortedLayers: [layer('l1', 0, { nodeSortMode: 'alpha-desc' })],
      assignments: allAssigned(),
    })
    expect(out.get('l1')).toEqual(['gamma', 'beta', 'alpha'])
  })

  it('applies the view default to layers without an override; the override wins', () => {
    const out = rootNames({
      nodes: [...abc(), node('x'), node('y')],
      sortedLayers: [layer('l1', 0), layer('l2', 1, { nodeSortMode: 'alpha-asc' })],
      assignments: {
        ...allAssigned(),
        x: assign('l2'),
        y: assign('l2'),
      },
      defaultNodeSortMode: 'alpha-desc',
    })
    expect(out.get('l1')).toEqual(['gamma', 'beta', 'alpha']) // follows view default
    expect(out.get('l2')).toEqual(['x', 'y'])                 // explicit asc override wins
  })

  it('an ephemeral override beats the persisted layer mode', () => {
    const out = rootNames({
      nodes: abc(),
      sortedLayers: [layer('l1', 0, { nodeSortMode: 'alpha-desc' })],
      assignments: allAssigned(),
      sortOverrides: new Map([['l1', 'alpha-asc' as const]]),
    })
    expect(out.get('l1')).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('custom mode orders keyed roots by orderKey, unkeyed roots after alphabetically', () => {
    const out = rootNames({
      nodes: [node('alpha'), node('beta'), node('gamma'), node('delta'), node('zeta')],
      sortedLayers: [layer('l1', 0, { nodeSortMode: 'custom' })],
      assignments: {
        // Manual arrangement: gamma before alpha (B,A,C-style), beta unkeyed.
        gamma: assign('l1', 'a0'),
        alpha: assign('l1', 'a1'),
        delta: assign('l1', 'a2'),
        beta: assign('l1'),
        zeta: assign('l1'),
      },
    })
    expect(out.get('l1')).toEqual(['gamma', 'alpha', 'delta', 'beta', 'zeta'])
  })

  it('children of an expanded root sort alphabetically per the layer mode, not by orderKey', () => {
    const nodes = [node('root'), node('bb'), node('aa'), node('cc')]
    const childMap = new Map([['root', ['bb', 'aa', 'cc']]])
    const parentMap = new Map([['bb', 'root'], ['aa', 'root'], ['cc', 'root']])
    const asc = rootNames({
      nodes,
      sortedLayers: [layer('l1', 0)],
      assignments: { root: assign('l1') },
      childMap,
      parentMap,
    })
    expect(asc.get('l1')).toEqual(['root'])

    const { result } = renderHook(() =>
      useLayerAssignment({
        nodes,
        sortedLayers: [layer('l1', 0, { nodeSortMode: 'alpha-desc' })],
        nodeEdgeFingerprint: 'fp',
        instanceAssignments: new Map(),
        effectiveAssignments: new Map(),
        nodeMap: new Map(nodes.map(n => [n.id, n])),
        childMap,
        parentMap,
        assignments: { root: assign('l1') },
      }),
    )
    const root = result.current.nodesByLayer.get('l1')?.[0]
    expect(root?.children.map(c => c.name)).toEqual(['cc', 'bb', 'aa'])
  })
})

describe('useLayerAssignment — property-derived sort modes', () => {
  it("'type-asc' groups roots by type id, alphabetical within a group", () => {
    const nodes = [
      { id: 'zeta', data: { urn: 'zeta', type: 'table', label: 'zeta' } },
      { id: 'alpha', data: { urn: 'alpha', type: 'view', label: 'alpha' } },
      { id: 'beta', data: { urn: 'beta', type: 'table', label: 'beta' } },
    ]
    const out = rootNames({
      nodes,
      sortedLayers: [layer('l1', 0, { nodeSortMode: 'type-asc' })],
      assignments: { zeta: assign('l1'), alpha: assign('l1'), beta: assign('l1') },
    })
    expect(out.get('l1')).toEqual(['beta', 'zeta', 'alpha']) // tables first, alpha within
  })

  it("'count-desc' puts the biggest containers first (backend childCount wins)", () => {
    const nodes = [
      { id: 'small', data: { urn: 'small', type: 'obj', label: 'small', childCount: 2 } },
      { id: 'big', data: { urn: 'big', type: 'obj', label: 'big', childCount: 90 } },
      { id: 'mid', data: { urn: 'mid', type: 'obj', label: 'mid', childCount: 10 } },
    ]
    const out = rootNames({
      nodes,
      sortedLayers: [layer('l1', 0, { nodeSortMode: 'count-desc' })],
      assignments: { small: assign('l1'), big: assign('l1'), mid: assign('l1') },
    })
    expect(out.get('l1')).toEqual(['big', 'mid', 'small'])
  })

  it('property modes are valid view defaults', () => {
    const out = rootNames({
      nodes: [
        { id: 'a', data: { urn: 'a', type: 'obj', label: 'a', childCount: 1 } },
        { id: 'b', data: { urn: 'b', type: 'obj', label: 'b', childCount: 5 } },
      ],
      sortedLayers: [layer('l1', 0)],
      assignments: { a: assign('l1'), b: assign('l1') },
      defaultNodeSortMode: 'count-desc',
    })
    expect(out.get('l1')).toEqual(['b', 'a'])
  })
})

describe('useLayerAssignment — hierarchical custom order (children)', () => {
  it('orders a custom layer\'s CHILDREN by orderKey (keyed first, unkeyed alpha tail)', () => {
    // root → children A, B, C (+ unkeyed D). Manual arrangement: B, C, A.
    const nodes = [
      node('root'), node('cA'), node('cB'), node('cC'), node('cD'),
    ]
    const childMap = new Map([['root', ['cA', 'cB', 'cC', 'cD']]])
    const parentMap = new Map([['cA', 'root'], ['cB', 'root'], ['cC', 'root'], ['cD', 'root']])
    const { result } = renderHook(() =>
      useLayerAssignment({
        nodes,
        sortedLayers: [layer('l1', 0, { nodeSortMode: 'custom' })],
        nodeEdgeFingerprint: 'fp',
        instanceAssignments: new Map(),
        effectiveAssignments: new Map(),
        nodeMap: new Map(nodes.map(n => [n.id, n])),
        childMap,
        parentMap,
        assignments: {
          root: assign('l1', 'a0'),
          cB: assign('l1', 'a1'),
          cC: assign('l1', 'a2'),
          cA: assign('l1', 'a3'),
          // cD has no orderKey → alpha tail
        },
      }),
    )
    const root = result.current.nodesByLayer.get('l1')?.[0]
    expect(root?.children.map(c => c.name)).toEqual(['cB', 'cC', 'cA', 'cD'])
  })

  it('leaves children alphabetical when the layer is NOT custom (orderKeys ignored)', () => {
    const nodes = [node('root'), node('cB'), node('cA')]
    const childMap = new Map([['root', ['cB', 'cA']]])
    const parentMap = new Map([['cB', 'root'], ['cA', 'root']])
    const { result } = renderHook(() =>
      useLayerAssignment({
        nodes,
        sortedLayers: [layer('l1', 0)], // default alpha-asc
        nodeEdgeFingerprint: 'fp',
        instanceAssignments: new Map(),
        effectiveAssignments: new Map(),
        nodeMap: new Map(nodes.map(n => [n.id, n])),
        childMap,
        parentMap,
        assignments: { root: assign('l1'), cB: assign('l1', 'a0'), cA: assign('l1', 'a1') },
      }),
    )
    const root = result.current.nodesByLayer.get('l1')?.[0]
    expect(root?.children.map(c => c.name)).toEqual(['cA', 'cB']) // alpha, not orderKey
  })
})
