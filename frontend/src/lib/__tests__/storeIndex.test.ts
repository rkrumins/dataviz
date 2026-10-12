/** The canvas lookups are built once per array and answer with the store's own objects. */
import { describe, expect, it } from 'vitest'
import type { LineageEdge, LineageNode } from '@/store/canvas'
import { childrenOf, containmentIndexOf, edgeIndexOf, nodeIndexOf } from '../storeIndex'

const node = (id: string, urn = id) => ({ id, type: 'generic', position: { x: 0, y: 0 }, data: { urn } }) as unknown as LineageNode
const edge = (id: string, source: string, target: string, edgeType: string) =>
  ({ id, source, target, data: { edgeType } }) as LineageEdge

describe('nodeIndexOf / edgeIndexOf', () => {
  it('answers by id (and by a different urn) with the same object, built once per array', () => {
    const nodes = [node('a'), node('b', 'urn:b')]
    const index = nodeIndexOf(nodes)
    expect(index.get('a')).toBe(nodes[0])
    expect(index.get('urn:b')).toBe(nodes[1])
    expect(nodeIndexOf(nodes)).toBe(index)
    expect(nodeIndexOf([...nodes])).not.toBe(index)
  })

  it('edges by id', () => {
    const edges = [edge('e1', 'a', 'b', 'FLOWS_TO')]
    expect(edgeIndexOf(edges).get('e1')).toBe(edges[0])
  })
})

describe('containmentIndexOf', () => {
  it('holds parents and children for the containment types only, case-insensitively', () => {
    const edges = [edge('c1', 'p', 'a', 'contains'), edge('c2', 'p', 'b', 'CONTAINS'), edge('f', 'a', 'b', 'FLOWS_TO')]
    const index = containmentIndexOf(edges, ['CONTAINS'])
    expect(index.parentEdgeOf.get('a')?.id).toBe('c1')
    expect(index.parentEdgeOf.has('p')).toBe(false)
    expect(childrenOf(index, 'p')).toEqual(['a', 'b'])
    expect(childrenOf(index, 'a')).toEqual([])
    expect(containmentIndexOf(edges, ['contains'])).toBe(index)
  })
})
