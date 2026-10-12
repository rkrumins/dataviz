/**
 * After a save the canvas takes the stored values — and their tokens — from the save's answer:
 * server-owned fields are replaced (a removed property is gone, not merged back), client state
 * stays, and the reader-stamped child count survives a value that does not carry one.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useCanvasStore, type LineageEdge, type LineageNode } from '../canvas'

beforeEach(() => {
  useCanvasStore.setState({
    nodes: [{
      id: 'urn:n', type: 'generic', position: { x: 40, y: 80 },
      data: { urn: 'urn:n', label: 'Old', type: 'dataset', version: 'v1', childCount: 3, isPending: undefined,
        properties: { owner: 'ana', gone: 1 } },
    } as unknown as LineageNode],
    edges: [{ id: 'e1', source: 'urn:n', target: 'urn:m', type: 'lineage', data: { edgeType: 'FLOWS_TO', version: 'e1' } } as LineageEdge],
    _nodeIndex: new Set(['urn:n']), _edgeIndex: new Set(['e1']),
  } as never)
})

describe('applyServerNodes / applyServerEdges', () => {
  it('replaces server-owned fields and keeps client state and the child count', () => {
    useCanvasStore.getState().applyServerNodes([{
      urn: 'urn:n', entityType: 'dataset', displayName: 'New', properties: { owner: 'bo' }, version: 'v2',
    } as never])
    const n = useCanvasStore.getState().nodes[0]
    expect(n.position).toEqual({ x: 40, y: 80 })
    expect(n.data.label).toBe('New')
    expect(n.data.properties).toEqual({ owner: 'bo' })
    expect(n.data.version).toBe('v2')
    expect(n.data.childCount).toBe(3)
  })

  it('writes nothing when no node matches', () => {
    const before = useCanvasStore.getState().nodes
    useCanvasStore.getState().applyServerNodes([{ urn: 'urn:other', entityType: 'x', displayName: 'x', properties: {} } as never])
    expect(useCanvasStore.getState().nodes).toBe(before)
  })

  it('refreshes an edge’s token and keeps its type', () => {
    useCanvasStore.getState().applyServerEdges([{ id: 'e1', sourceUrn: 'urn:n', targetUrn: 'urn:m', edgeType: 'FLOWS_TO', version: 'e2', confidence: 0.5 } as never])
    const e = useCanvasStore.getState().edges[0]
    expect(e.data?.version).toBe('e2')
    expect(e.data?.confidence).toBe(0.5)
    expect(e.data?.edgeType).toBe('FLOWS_TO')
  })
})
