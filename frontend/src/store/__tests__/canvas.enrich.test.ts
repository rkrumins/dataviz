/**
 * A node arriving in a LEAN shape must not permanently shadow the real one.
 *
 * `addNodes`/`addGraph` keep the first version of an id — right for position
 * and for anything since edited, wrong for a node first met incomplete. The
 * `/ancestors` endpoint returns `childCount: null`, so a container first seen
 * that way kept no child count for the rest of the session: no `+N` badge, no
 * chevron, no way to open it, and no re-fetch could repair it.
 *
 * Filling is one-way: what the store already holds always wins.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore, type LineageNode } from '../canvas'

const node = (id: string, data: Record<string, unknown>): LineageNode =>
  ({ id, position: { x: 0, y: 0 }, data: { urn: id, ...data } }) as LineageNode

const s = () => useCanvasStore.getState()
const get = (id: string) => s().nodes.find((n) => n.id === id)

beforeEach(() => {
  useCanvasStore.setState({ nodes: [], edges: [], _nodeIndex: new Set(), _edgeIndex: new Set() } as never)
})

describe('a lean node is completed, not dropped', () => {
  it('fills a childCount the store never had', () => {
    s().addNodes([node('c1', { label: 'INTERMEDIATE_T2', childCount: null })])
    s().addNodes([node('c1', { label: 'INTERMEDIATE_T2', childCount: 7 })])

    expect(s().nodes).toHaveLength(1)
    expect(get('c1')!.data.childCount).toBe(7)
  })

  it('never overwrites something the store already knows', () => {
    s().addNodes([node('c1', { label: 'Real name', childCount: 7 })])
    s().addNodes([node('c1', { label: 'Stale name', childCount: 99 })])

    expect(get('c1')!.data.label).toBe('Real name')
    expect(get('c1')!.data.childCount).toBe(7)
  })

  it('treats null and undefined as "not known", in both directions', () => {
    s().addNodes([node('c1', { childCount: null, description: undefined })])
    s().addNodes([node('c1', { childCount: null, description: 'filled' })])

    expect(get('c1')!.data.childCount).toBeNull()      // incoming had nothing to give
    expect(get('c1')!.data.description).toBe('filled')
  })

  it('keeps the node object identical when nothing was missing', () => {
    s().addNodes([node('c1', { childCount: 7 })])
    const before = get('c1')
    s().addNodes([node('c1', { childCount: 7 })])

    expect(get('c1')).toBe(before)   // no re-render
  })

  it('does the same through addGraph, and still adds the new ones', () => {
    s().addGraph([node('c1', { childCount: null })], [])
    s().addGraph([node('c1', { childCount: 7 }), node('c2', { childCount: 1 })], [])

    expect(get('c1')!.data.childCount).toBe(7)
    expect(get('c2')).toBeDefined()
    expect(s().nodes).toHaveLength(2)
  })

  it('does the same when the node arrives in a landing PAGE', () => {
    // Child and type pages land through their own actions, not addGraph. A
    // lean ancestor that a later page brings in full is completed there too.
    s().addNodes([node('c1', { childCount: null })])
    s().addChildPage('p', { offset: 100, hasMore: true, direction: 'asc', lastUrn: 'c2', childCount: 2 },
      [node('c1', { childCount: 7 }), node('c2', {})], [])
    expect(get('c1')!.data.childCount).toBe(7)
    expect(s().nodes).toHaveLength(2)

    s().addFeedPage('f', { entityTypes: ['t'], offset: 200, hasMore: false }, [node('c2', { childCount: 3 })], [])
    expect(get('c2')!.data.childCount).toBe(3)
    expect(s().nodes).toHaveLength(2)
  })

  it('leaves position alone — layout owns it', () => {
    s().addNodes([{ id: 'c1', position: { x: 10, y: 20 }, data: { urn: 'c1' } } as LineageNode])
    s().addNodes([{ id: 'c1', position: { x: 0, y: 0 }, data: { urn: 'c1', childCount: 3 } } as LineageNode])

    expect(get('c1')!.position).toEqual({ x: 10, y: 20 })
    expect(get('c1')!.data.childCount).toBe(3)
  })
})
