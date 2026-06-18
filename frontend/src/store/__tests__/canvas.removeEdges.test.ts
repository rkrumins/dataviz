/**
 * removeEdgesByNodeIds is the collapse cleanup: it drops edges touching the collapsed
 * subtree, relying on re-fetch on re-expand. That re-fetch only exists for SAVED data,
 * so it must NEVER drop an edge attached to an unsaved (optimistic) node — e.g. a
 * just-created child's containment edge. Dropping it would flatten the hierarchy
 * permanently (the bug this guards).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore, type LineageNode, type LineageEdge } from '../canvas'

const node = (id: string, pending?: 'create'): LineageNode => ({
  id, type: 'generic', position: { x: 0, y: 0 },
  data: { label: id, urn: id, type: 't', ...(pending ? { isPending: pending } : {}) },
})
const edge = (id: string, source: string, target: string, pending?: 'create'): LineageEdge => ({
  id, source, target, ...(pending ? { data: { isPending: pending } } : {}),
})

const reset = (nodes: LineageNode[], edges: LineageEdge[]) =>
  useCanvasStore.setState({
    nodes, edges,
    _nodeIndex: new Set(nodes.map((n) => n.id)),
    _edgeIndex: new Set(edges.map((e) => e.id)),
  } as never)

const edgeIds = () => useCanvasStore.getState().edges.map((e) => e.id).sort()

describe('removeEdgesByNodeIds — collapse cleanup', () => {
  beforeEach(() => reset([], []))

  it('drops saved subtree edges (normal collapse, re-fetched on expand)', () => {
    reset(
      [node('P'), node('C'), node('GC')],
      [edge('e-P-C', 'P', 'C'), edge('e-C-GC', 'C', 'GC')],
    )
    // Collapse P → its descendants {C, GC}. Saved edges to/within the subtree drop.
    useCanvasStore.getState().removeEdgesByNodeIds(new Set(['C', 'GC']))
    expect(edgeIds()).toEqual([])
  })

  it('preserves a containment edge to an UNSAVED child (no flatten)', () => {
    reset(
      [node('P'), node('C', 'create')],
      [edge('contains-P-C', 'P', 'C')],   // optimistic edge to a pending child
    )
    useCanvasStore.getState().removeEdgesByNodeIds(new Set(['C']))
    expect(edgeIds()).toEqual(['contains-P-C'])   // survives → hierarchy intact
  })

  it('preserves an edge flagged pending even when both endpoints are saved', () => {
    reset(
      [node('P'), node('C')],
      [edge('e', 'P', 'C', 'create')],
    )
    useCanvasStore.getState().removeEdgesByNodeIds(new Set(['C']))
    expect(edgeIds()).toEqual(['e'])
  })

  it('still honours explicit preserveEdgeIds (trace mode)', () => {
    reset([node('P'), node('C')], [edge('keep', 'P', 'C'), edge('drop', 'P', 'C')])
    useCanvasStore.getState().removeEdgesByNodeIds(new Set(['C']), new Set(['keep']))
    expect(edgeIds()).toEqual(['keep'])
  })
})
