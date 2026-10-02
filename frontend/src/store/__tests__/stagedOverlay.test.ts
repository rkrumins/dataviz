import { describe, expect, it } from 'vitest'
import { filterIncomingEdges, overlayOnReplace, type MoveAfter } from '../stagedOverlay'
import type { LineageEdge, LineageNode } from '../canvas'
import type { StagedChange } from '../stagedChangesStore'

const node = (id: string, label = id, extra: Record<string, unknown> = {}): LineageNode =>
  ({ id, type: 'entity', position: { x: 0, y: 0 }, data: { urn: id, label, type: 'Node', ...extra } }) as unknown as LineageNode
const edge = (id: string, source: string, target: string, edgeType = 'HAS', extra: Record<string, unknown> = {}): LineageEdge =>
  ({ id, source, target, type: 'lineage', data: { edgeType, ...extra } }) as unknown as LineageEdge
const change = (type: StagedChange['type'], targetId: string, after: unknown = {}): StagedChange =>
  ({ id: `c-${type}-${targetId}`, type, targetId, after, summary: '', timestamp: 0 }) as StagedChange
const move = (childId: string, parentId: string | null, edgeId: string | null): StagedChange =>
  change('move_entity', childId, { childId, parentId, edgeId, edgeType: 'HAS', containmentTypes: ['HAS'] } satisfies MoveAfter)

describe('the canvas is the server view plus pending edits', () => {
  it('passes the server view through untouched when nothing is staged', () => {
    const next = { nodes: [node('A')], edges: [] }
    expect(overlayOnReplace(next, { nodes: [node('X')], edges: [] }, [])).toBe(next)
  })

  it('keeps an unsaved node (and its link) that the server does not have yet', () => {
    const pending = node('urn:staged:node:1', 'New', { isPending: 'create' })
    const link = edge('staged-edge-1', 'A', pending.id, 'HAS', { isPending: 'create' })
    const out = overlayOnReplace(
      { nodes: [node('A')], edges: [] },
      { nodes: [node('A'), pending], edges: [link] },
      [change('create_entity', pending.id)],
    )
    expect(out.nodes.map((n) => n.id)).toEqual(['A', pending.id])
    expect(out.edges.map((e) => e.id)).toEqual(['staged-edge-1'])
  })

  it('keeps an unsaved rename over the server copy, which has no marker', () => {
    const out = overlayOnReplace(
      { nodes: [node('A', 'Old')], edges: [] },
      { nodes: [node('A', 'Renamed')], edges: [] },
      [change('rename_entity', 'A')],
    )
    expect(out.nodes[0].data?.label).toBe('Renamed')
  })

  it('does not bring back a relationship a pending edit deleted', () => {
    const out = overlayOnReplace(
      { nodes: [node('A'), node('B')], edges: [edge('e1', 'A', 'B', 'FLOWS_TO')] },
      { nodes: [node('A'), node('B')], edges: [] },
      [change('delete_edge', 'e1')],
    )
    expect(out.edges).toEqual([])
  })

  it('drops EVERY parent link of a moved node, loaded or not, and keeps the new one', () => {
    const newLink = edge('staged-edge-9', 'P2', 'X', 'HAS', { isPending: 'create' })
    const next = {
      nodes: [node('P1'), node('P2'), node('X')],
      // the old parent link the canvas never loaded, plus an unrelated lineage edge into X
      edges: [edge('old', 'P1', 'X', 'HAS'), edge('flow', 'P1', 'X', 'FLOWS_TO')],
    }
    const out = overlayOnReplace(next, { nodes: [], edges: [newLink] }, [move('X', 'P2', 'staged-edge-9')])
    expect(out.edges.map((e) => e.id).sort()).toEqual(['flow', 'staged-edge-9'])
  })

  it('a page merged in never re-adds a moved node\'s old parent link', () => {
    const incoming = [edge('old', 'P1', 'X', 'HAS'), edge('sib', 'P1', 'Y', 'HAS')]
    expect(filterIncomingEdges(incoming, [move('X', null, null)]).map((e) => e.id)).toEqual(['sib'])
  })
})
