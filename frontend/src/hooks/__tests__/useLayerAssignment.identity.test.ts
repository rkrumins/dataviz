/**
 * useLayerAssignment keeps a layer's rows when they come out the same: a page landing in one
 * layer of a 50,000-row view re-renders that column, never the rest (each column is memoized
 * on its rows). A layer whose rows changed — a row added, an entity changed — gets new ones.
 */
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { useStagedChangesStore } from '@/store/stagedChangesStore'
import type { ViewLayerConfig } from '@/types/schema'

import { useLayerAssignment } from '../useLayerAssignment'

type TestNode = { id: string; data: Record<string, unknown> }
const node = (id: string, layerId: string, extra: Record<string, unknown> = {}): TestNode =>
  ({ id, data: { urn: id, type: 'table', label: id, feedLayerId: layerId, ...extra } })
const layers: ViewLayerConfig[] = [
  { id: 'up', name: 'Sources', entityTypes: [], order: 0 },
  { id: 'down', name: 'Consumers', entityTypes: [], order: 1 },
]

function useAssigned(nodes: TestNode[], whereTheySit = false) {
  return useLayerAssignment({
    nodes, sortedLayers: layers, nodeEdgeFingerprint: nodes.map((n) => `${n.id}:${String(n.data.label)}`).join(','),
    instanceAssignments: new Map(nodes.map((n) => [n.id, { layerId: String(n.data.feedLayerId) }])),
    effectiveAssignments: new Map(), nodeMap: new Map(nodes.map((n) => [n.id, n])),
    childMap: new Map(), parentMap: new Map(), branchCreatedUrns: new Set(), whereTheySit,
  })
}

describe('useLayerAssignment — rows kept across renders', () => {
  beforeEach(() => {
    useStagedChangesStore.setState({ changes: [], _scopeKey: null, _byScope: {} } as never)
  })

  it('a page landing in one layer leaves the other layer’s rows as they were', () => {
    const first = [node('a1', 'up'), node('d1', 'down'), node('d2', 'down')]
    const { result, rerender } = renderHook((p: { nodes: TestNode[] }) => useAssigned(p.nodes), { initialProps: { nodes: first } })
    const before = result.current.nodesByLayer
    rerender({ nodes: [...first, node('a2', 'up')] })
    const after = result.current.nodesByLayer
    expect(after).not.toBe(before)
    expect(after.get('down')).toBe(before.get('down'))
    expect(after.get('up')).not.toBe(before.get('up'))
    expect(after.get('up')!.map((n) => n.id)).toEqual(['a1', 'a2'])
  })

  it('a changed entity is a new row: its layer’s rows are new', () => {
    const first = [node('a1', 'up'), node('d1', 'down')]
    const { result, rerender } = renderHook((p: { nodes: TestNode[] }) => useAssigned(p.nodes), { initialProps: { nodes: first } })
    const before = result.current.nodesByLayer
    rerender({ nodes: [first[0], node('d1', 'down', { label: 'renamed' })] })
    expect(result.current.nodesByLayer.get('up')).toBe(before.get('up'))
    expect(result.current.nodesByLayer.get('down')).not.toBe(before.get('down'))
  })

  it('a match drawn inside its containers: a new match under the same container is a change there only', () => {
    const path = [{ urn: 'urn:sales', displayName: 'sales', entityType: 'schema' }]
    const inside = (id: string, layerId: string) => node(id, layerId, { ancestorPath: path, inLayer: 1 })
    const first = [inside('a1', 'up'), inside('d1', 'down')]
    const { result, rerender } = renderHook((p: { nodes: TestNode[] }) => useAssigned(p.nodes, true), { initialProps: { nodes: first } })
    const before = result.current.nodesByLayer
    // Context rows are built afresh each render: unchanged ones still compare the same.
    rerender({ nodes: [...first] })
    expect(result.current.nodesByLayer.get('down')).toBe(before.get('down'))
    rerender({ nodes: [...first, inside('a2', 'up')] })
    expect(result.current.nodesByLayer.get('down')).toBe(before.get('down'))
    const up = result.current.nodesByLayer.get('up')!
    expect(up).not.toBe(before.get('up'))
    expect(up[0].data.context).toEqual({ urn: 'urn:sales', matches: 2 })
  })
})
