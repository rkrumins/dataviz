/**
 * useLayerAssignment — unassigned-entity surfacing + showUnassigned routing.
 *
 * A loaded node that resolves to NO layer must never vanish silently: the
 * hook returns it in `unassignedNodes` so the canvas can surface a count.
 * In OPEN scope, a layer opting in via `showUnassigned: true` receives
 * such roots instead. Curated (closed-scope) views keep drop semantics.
 */
import { renderHook } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useLayerAssignment } from '../useLayerAssignment'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import type { ViewLayerConfig } from '@/types/schema'

type TestNode = { id: string; data: Record<string, unknown> }
const node = (id: string, type: string): TestNode => ({ id, data: { urn: id, type, label: id } })
const layer = (id: string, order: number, entityTypes: string[], extra?: Partial<ViewLayerConfig>): ViewLayerConfig => ({
  id, name: id, order, entityTypes, ...extra,
})

function run(opts: {
  nodes: TestNode[]
  sortedLayers: ViewLayerConfig[]
  assignments?: Record<string, { layerId: string }>
  entityScope?: 'all' | 'curated'
  traceFallbackLayerId?: string
}) {
  const nodeMap = new Map<string, TestNode>(opts.nodes.map(n => [n.id, n]))
  const { result } = renderHook(() =>
    useLayerAssignment({
      nodes: opts.nodes,
      sortedLayers: opts.sortedLayers,
      nodeEdgeFingerprint: opts.nodes.map(n => n.id).join(','),
      instanceAssignments: new Map(),
      effectiveAssignments: new Map(),
      nodeMap,
      childMap: new Map(),
      parentMap: new Map(),
      assignments: opts.assignments as never,
      entityScope: opts.entityScope,
      branchCreatedUrns: new Set(),
      traceFallbackLayerId: opts.traceFallbackLayerId,
    }),
  )
  return result.current
}

beforeEach(() => {
  useStagedChangesStore.setState({ changes: [], _scopeKey: null, _byScope: {} } as never)
})

describe('useLayerAssignment — unassignedNodes surfacing', () => {
  it('a node matching no layer is returned in unassignedNodes (open scope, no fallback layer)', () => {
    const res = run({
      nodes: [node('a', 'domain'), node('orphan', 'mystery-type')],
      sortedLayers: [layer('L1', 0, ['domain'])],
    })
    expect(res.nodeLayerMap.get('a')).toBe('L1')
    expect(res.nodeLayerMap.has('orphan')).toBe(false)
    expect(res.unassignedNodes.map(n => n.id)).toEqual(['orphan'])
  })

  it('open scope: showUnassigned layer receives unmatched roots (nothing unassigned)', () => {
    const res = run({
      nodes: [node('a', 'domain'), node('orphan', 'mystery-type')],
      sortedLayers: [
        layer('L1', 0, ['domain']),
        layer('LCatchAll', 1, [], { showUnassigned: true }),
      ],
    })
    expect(res.nodeLayerMap.get('orphan')).toBe('LCatchAll')
    expect(res.unassignedNodes).toHaveLength(0)
  })

  it('curated scope: unlisted roots are NOT routed to a showUnassigned layer, only reported', () => {
    const res = run({
      nodes: [node('a', 'domain'), node('orphan', 'mystery-type')],
      sortedLayers: [
        layer('L1', 0, ['domain']),
        layer('LCatchAll', 1, [], { showUnassigned: true }),
      ],
      assignments: { a: { layerId: 'L1' } },
      entityScope: 'curated',
    })
    expect(res.nodeLayerMap.get('a')).toBe('L1')
    expect(res.nodeLayerMap.has('orphan')).toBe(false)
    expect(res.unassignedNodes.map(n => n.id)).toEqual(['orphan'])
  })

  it('fully assigned canvas reports no unassigned nodes', () => {
    const res = run({
      nodes: [node('a', 'domain'), node('b', 'domain')],
      sortedLayers: [layer('L1', 0, ['domain'])],
    })
    expect(res.unassignedNodes).toHaveLength(0)
  })
})

describe('useLayerAssignment — the trace lane (2026-08-19: in trace mode, the flow is the picture)', () => {
  // A trace on a curated view walks a flow whose participants mostly live
  // OUTSIDE the wizard's assignments. Dropping them (the curated rule)
  // silenced entire 300KB closures on 1M+ graphs — the board stayed empty
  // while "N connections outside this view" exploded. While tracing, the
  // canvas passes a virtual lane id; roots the view cannot place route
  // there instead of vanishing. Outside trace the option is absent and
  // curated drop semantics are untouched.
  it('curated scope: an unlisted root routes to the trace lane instead of dropping', () => {
    const res = run({
      nodes: [node('a', 'domain'), node('foreignPlat', 'dataPlatform')],
      sortedLayers: [
        layer('L1', 0, ['domain']),
        layer('__trace_flow__', 99, []),
      ],
      assignments: { a: { layerId: 'L1' } },
      entityScope: 'curated',
      traceFallbackLayerId: '__trace_flow__',
    })
    expect(res.nodeLayerMap.get('a')).toBe('L1')
    expect(res.nodeLayerMap.get('foreignPlat')).toBe('__trace_flow__')
    expect(res.unassignedNodes).toHaveLength(0)
  })

  it('open scope without a showUnassigned layer: the trace lane is the last resort', () => {
    const res = run({
      nodes: [node('a', 'domain'), node('orphan', 'mystery-type')],
      sortedLayers: [
        layer('L1', 0, ['domain']),
        layer('__trace_flow__', 99, []),
      ],
      traceFallbackLayerId: '__trace_flow__',
    })
    expect(res.nodeLayerMap.get('orphan')).toBe('__trace_flow__')
    expect(res.unassignedNodes).toHaveLength(0)
  })

  // 2026-08-19 Solidatus ruling ("full lineage whilst RETAINING their
  // layers"): while tracing, a curated-unlisted root first resolves
  // through its NATURAL chain — the layer stamped on the node itself,
  // then the view's type rules — and only a root with no natural home
  // falls into the trace lane. Everything piling into one catch-all
  // column read as "completely disjointed".
  it('trace + curated: a root with its OWN stamped layerAssignment retains that layer', () => {
    const stamped: TestNode = { id: 'foreign', data: { urn: 'foreign', type: 'dataset', label: 'foreign', layerAssignment: 'L2' } }
    const res = run({
      nodes: [node('a', 'domain'), stamped],
      sortedLayers: [
        layer('L1', 0, ['domain']),
        layer('L2', 1, []),
        layer('__trace_flow__', 99, []),
      ],
      assignments: { a: { layerId: 'L1' } },
      entityScope: 'curated',
      traceFallbackLayerId: '__trace_flow__',
    })
    expect(res.nodeLayerMap.get('foreign')).toBe('L2')
  })

  it('trace + curated: a root matching a layer TYPE RULE retains that layer', () => {
    const res = run({
      nodes: [node('a', 'domain'), node('foreignTable', 'dataset')],
      sortedLayers: [
        layer('L1', 0, ['domain']),
        layer('LTables', 1, ['dataset']),
        layer('__trace_flow__', 99, []),
      ],
      assignments: { a: { layerId: 'L1' } },
      entityScope: 'curated',
      traceFallbackLayerId: '__trace_flow__',
    })
    expect(res.nodeLayerMap.get('foreignTable')).toBe('LTables')
  })

  it('trace + curated: only a root with NO natural home lands in the lane', () => {
    const res = run({
      nodes: [node('a', 'domain'), node('homeless', 'mystery-type')],
      sortedLayers: [
        layer('L1', 0, ['domain']),
        layer('LTables', 1, ['dataset']),
        layer('__trace_flow__', 99, []),
      ],
      assignments: { a: { layerId: 'L1' } },
      entityScope: 'curated',
      traceFallbackLayerId: '__trace_flow__',
    })
    expect(res.nodeLayerMap.get('homeless')).toBe('__trace_flow__')
  })

  it('WITHOUT a trace, curated drop semantics are untouched by natural resolution', () => {
    const stamped: TestNode = { id: 'foreign', data: { urn: 'foreign', type: 'dataset', label: 'foreign', layerAssignment: 'L2' } }
    const res = run({
      nodes: [node('a', 'domain'), stamped],
      sortedLayers: [layer('L1', 0, ['domain']), layer('L2', 1, [])],
      assignments: { a: { layerId: 'L1' } },
      entityScope: 'curated',
    })
    expect(res.nodeLayerMap.has('foreign')).toBe(false)
    expect(res.unassignedNodes.map(n => n.id)).toEqual(['foreign'])
  })
})
