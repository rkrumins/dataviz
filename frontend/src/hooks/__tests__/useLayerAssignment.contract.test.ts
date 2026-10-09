/**
 * useLayerAssignment under the One Placement Contract (placementContractEnabled): with
 * `placementSpec` set, lib/placement places every loaded node and the legacy chain — backend answer,
 * rule loop, top-down traversal — is skipped. The flag-off chain is pinned, unedited, by the other
 * useLayerAssignment.* suites.
 */
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { compilePlacementSpec } from '@/lib/placement/placement'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import type { LayerAssignmentEntry, ViewLayerConfig } from '@/types/schema'

import { useLayerAssignment } from '../useLayerAssignment'

type TestNode = { id: string; data: Record<string, unknown> }
const node = (id: string, type: string, extra: Record<string, unknown> = {}): TestNode =>
  ({ id, data: { urn: id, type, label: id, ...extra } })
const layer = (id: string, order: number, entityTypes: string[] = [], extra: Partial<ViewLayerConfig> = {}): ViewLayerConfig =>
  ({ id, name: id, order, entityTypes, ...extra })

function render(opts: {
  nodes: TestNode[]
  layers: ViewLayerConfig[]
  edges?: [string, string][]                 // [parent, child]; the parent may be unloaded
  assignments?: Record<string, LayerAssignmentEntry>
  scope?: 'all' | 'curated'
  effectiveAssignments?: Map<string, { layerId: string }>
  instanceAssignments?: Map<string, { layerId: string }>
  branchCreatedUrns?: Set<string>
  chains?: Record<string, string[]>
}) {
  const assignments = opts.assignments ?? {}
  const scope = opts.scope ?? 'all'
  const placementSpec = compilePlacementSpec({
    content: { entityScope: scope },
    layout: { referenceLayout: { layers: opts.layers, assignments } },
  })
  const nodeMap = new Map(opts.nodes.map(n => [n.id, n]))
  const parentMap = new Map<string, string>()
  const childMap = new Map<string, string[]>()
  for (const [p, c] of opts.edges ?? []) {
    parentMap.set(c, p)
    childMap.set(p, [...(childMap.get(p) ?? []), c])
  }
  const { result } = renderHook(() => useLayerAssignment({
    nodes: opts.nodes,
    sortedLayers: [...opts.layers].sort((a, b) => a.order - b.order),
    nodeEdgeFingerprint: opts.nodes.map(n => n.id).join(','),
    instanceAssignments: opts.instanceAssignments ?? new Map(),
    effectiveAssignments: opts.effectiveAssignments ?? new Map(),
    nodeMap,
    childMap,
    parentMap,
    assignments,
    entityScope: scope,
    branchCreatedUrns: opts.branchCreatedUrns ?? new Set(),
    placementSpec,
    placementChains: new Map(Object.entries(opts.chains ?? {})),
  }))
  const roots = (layerId: string) => (result.current.nodesByLayer.get(layerId) ?? []).map(n => n.id)
  return { result: result.current, layerOf: (id: string) => result.current.nodeLayerMap.get(id), roots }
}

beforeEach(() => {
  useStagedChangesStore.setState({ changes: [], _scopeKey: null, _byScope: {} } as never)
})

describe('useLayerAssignment — One Placement Contract', () => {
  it('ignores the backend answer', () => {
    const { layerOf } = render({
      nodes: [node('t', 'table')],
      layers: [layer('a', 0, ['table']), layer('b', 1)],
      effectiveAssignments: new Map([['t', { layerId: 'b' }]]),
    })
    expect(layerOf('t')).toBe('a')
  })

  it('a child\'s own rule beats its rule-placed parent: it heads its own column, its source a rule', () => {
    const { layerOf, roots, result } = render({
      nodes: [node('db', 'database'), node('t', 'table')],
      layers: [layer('a', 0, ['database']), layer('b', 1, ['table'])],
      edges: [['db', 't']],
    })
    expect(layerOf('db')).toBe('a')
    expect(layerOf('t')).toBe('b')
    expect(roots('b')).toEqual(['t'])
    expect(result.contractPlacements?.get('t')).toMatchObject({ source: 'rule', ruleId: '_type_b_table' })
  })

  it('a hand placement cascades over the child\'s own rule, so the subtree stays nested', () => {
    const { layerOf, roots } = render({
      nodes: [node('db', 'database'), node('t', 'table')],
      layers: [layer('a', 0), layer('b', 1, ['table'])],
      edges: [['db', 't']],
      assignments: { db: { layerId: 'a', inheritsChildren: true } },
      scope: 'all',
    })
    expect(layerOf('t')).toBe('a')
    expect(roots('a')).toEqual(['db'])
  })

  it('renders a node whose containment parent is not loaded as a root of its own column', () => {
    const { layerOf, roots } = render({
      nodes: [node('t', 'table')],
      layers: [layer('a', 0, ['table'])],
      edges: [['unloaded-db', 't']],
    })
    expect(layerOf('t')).toBe('a')
    expect(roots('a')).toEqual(['t'])
  })

  it('a fetched chain moves a fed node into its unloaded ancestor\'s hand-placed column', () => {
    const { layerOf } = render({
      nodes: [node('col', 'column')],
      layers: [layer('a', 0, ['column']), layer('b', 1)],
      assignments: { domain: { layerId: 'b', inheritsChildren: true } },
      chains: { col: ['table', 'domain'] },
    })
    expect(layerOf('col')).toBe('b')
  })

  it('a stale explicit entry falls through to the rule', () => {
    const { layerOf, result } = render({
      nodes: [node('t', 'table')],
      layers: [layer('a', 0, ['table'])],
      assignments: { t: { layerId: 'deleted', inheritsChildren: true } },
      scope: 'all',
    })
    expect(layerOf('t')).toBe('a')
    expect(result.contractPlacements?.get('t')).toMatchObject({ source: 'rule', staleExplicit: true })
  })

  it('a type claimed by two layers goes to the first, whatever its case', () => {
    const { layerOf } = render({
      nodes: [node('t', 'Table')],
      layers: [layer('later', 1, ['table']), layer('first', 0, ['TABLE'])],
    })
    expect(layerOf('t')).toBe('first')
  })

  it('a rule with no criteria captures nothing', () => {
    const { layerOf, result } = render({
      nodes: [node('t', 'table')],
      layers: [layer('a', 0, [], { rules: [{ id: 'empty', priority: 9 }] }), layer('b', 1, ['table'])],
    })
    expect(layerOf('t')).toBe('b')
    expect(result.unassignedNodes).toEqual([])
  })

  it('a curated view places a node created in this draft by its stamp, and its child follows', () => {
    const { layerOf } = render({
      nodes: [node('new', 'table', { layerAssignment: 'b' }), node('kid', 'column'), node('global', 'table', { layerAssignment: 'b' })],
      layers: [layer('a', 0), layer('b', 1)],
      edges: [['new', 'kid']],
      assignments: { other: { layerId: 'a', inheritsChildren: true } },
      scope: 'curated',
      branchCreatedUrns: new Set(['new']),
    })
    expect(layerOf('new')).toBe('b')
    expect(layerOf('kid')).toBe('b')
    expect(layerOf('global')).toBeUndefined()        // not created here: the view never placed it
  })

  it('a session drag places the node there, onto a layer the view still has', () => {
    const { layerOf } = render({
      nodes: [node('t', 'table'), node('u', 'table')],
      layers: [layer('a', 0, ['table']), layer('b', 1)],
      instanceAssignments: new Map([['t', { layerId: 'b' }], ['u', { layerId: 'gone' }]]),
    })
    expect(layerOf('t')).toBe('b')
    expect(layerOf('u')).toBe('a')
  })

  it('draws an unplaced root in the showUnassigned column of an open view', () => {
    const { layerOf, result } = render({
      nodes: [node('x', 'thing')],
      layers: [layer('a', 0, ['table']), layer('rest', 1, [], { showUnassigned: true })],
    })
    expect(layerOf('x')).toBe('rest')
    expect(result.contractPlacements?.get('x')?.source).toBe('fallback')
  })
})
