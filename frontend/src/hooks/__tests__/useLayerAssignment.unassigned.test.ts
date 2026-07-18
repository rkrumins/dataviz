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
