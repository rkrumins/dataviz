/**
 * After a save the canvas is reconciled in place (there is no reload): every create's temp id is
 * swapped for the one the server minted — the nodes, the links to and from them, their layer
 * placements, whether they are open — in ONE pass. Done per created node, each swap rescanned and
 * rewrote the whole canvas, and re-wrote the view's layout: a 2,000-row paste reconciled in O(n²).
 *
 * Also pinned: a reversed link is a create the server names (no client-made id), and the tokens of
 * everything the save wrote — not only the entities it answers with in full, at most 500 — land on
 * the canvas, a link the server calls `edge:X` included, so the next edit of any of them is checked
 * against the value just saved.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/versioningApiService')>(),
  applyGraphChanges: vi.fn(),
}))
vi.mock('@/hooks/useAggregatedLineage', () => ({ invalidateAggregatedEdges: vi.fn() }))

import { saveStagedChangesToDraft } from '../saveStagedChangesToDraft'
import { applyGraphChanges } from '@/services/versioningApiService'
import { useCanvasStore, type LineageEdge, type LineageNode } from '@/store/canvas'
import type { StagedChange } from '@/store/stagedChangesStore'

const mockApply = vi.mocked(applyGraphChanges)
const target = { wsId: 'w', dataSourceId: 'ds', branchId: 'b', provider: {} as never }

const node = (id: string, data: Record<string, unknown> = {}) =>
  ({ id, type: 'generic', position: { x: 0, y: 0 }, data: { label: id, urn: id, type: 'table', ...data } }) as LineageNode
const seed = (nodes: LineageNode[], edges: LineageEdge[]) => useCanvasStore.setState({
  nodes, edges, _nodeIndex: new Set(nodes.map((n) => n.id)), _edgeIndex: new Set(edges.map((e) => e.id)),
} as never)
const sc = (over: Partial<StagedChange>): StagedChange =>
  ({ id: 'c', type: 'create_entity', targetId: 't', after: {}, summary: '', timestamp: 0, ...over })

beforeEach(() => mockApply.mockReset())

describe('reconciling a large save', () => {
  const N = 2000
  const temp = (i: number) => `urn:staged:table:${i}`
  // A ten-wide tree under a saved root, as a big paste builds it, with a link drawn along each tenth row.
  const parentOf = (i: number) => (i === 0 ? 'urn:root' : temp(Math.floor((i - 1) / 10)))

  function stage() {
    const nodes = [node('urn:root'), ...Array.from({ length: N }, (_, i) => node(temp(i), { isPending: 'create' }))]
    const containment: LineageEdge[] = Array.from({ length: N }, (_, i) => ({
      id: `contains-${parentOf(i)}-${temp(i)}`, source: parentOf(i), target: temp(i), type: 'containment',
      data: { edgeType: 'CONTAINS', relationship: 'contains', isPending: 'create' },
    }))
    const links: LineageEdge[] = Array.from({ length: N / 10 }, (_, k) => ({
      id: `staged-edge-${k}`, source: temp(k * 10), target: temp(k * 10 + 1), type: 'lineage',
      data: { edgeType: 'FLOWS_TO', isPending: 'create' },
    }))
    seed(nodes, [...containment, ...links])
    const changes: StagedChange[] = [
      ...Array.from({ length: N }, (_, i) => sc({
        id: `c${i}`, targetId: temp(i), targetUrn: temp(i),
        after: { entityType: 'table', displayName: `T${i}`, parentUrn: parentOf(i), containmentEdgeType: 'CONTAINS' },
      })),
      ...links.map((l, k) => sc({
        id: `l${k}`, type: 'create_edge', targetId: l.id, after: { edgeType: 'FLOWS_TO', source: l.source, target: l.target },
      })),
    ]
    const assigned: Record<string, string> = {}
    for (let i = 0; i < N; i++) {
      assigned[temp(i)] = `urn:real:${i}`
      assigned[`contains-${temp(i)}`] = `edge_c${i}`
    }
    links.forEach((l, k) => { assigned[l.id] = `edge_l${k}` })
    mockApply.mockResolvedValue({ commitId: 'x', assigned } as never)
    return changes
  }

  it('re-keys every node, link, placement and open node in one store write and one layout write', async () => {
    const changes = stage()
    const remapEntityIds = vi.fn()
    const pruneTempAssignments = vi.fn()
    // Writes that rewrite the graph — what re-renders and re-lays-out every column.
    const writes = vi.fn()
    const off = useCanvasStore.subscribe((s, prev) => { if (s.nodes !== prev.nodes || s.edges !== prev.edges) writes() })
    await saveStagedChangesToDraft(changes, { ...target, remapEntityIds, pruneTempAssignments })
    off()

    expect(writes).toHaveBeenCalledTimes(1)
    expect(remapEntityIds).toHaveBeenCalledTimes(1)
    expect(pruneTempAssignments).not.toHaveBeenCalled()   // the remap's one layout write prunes too
    const ids = remapEntityIds.mock.calls[0][0] as ReadonlyMap<string, string>
    expect(ids.size).toBe(N)
    expect(ids.get(temp(7))).toBe('urn:real:7')

    const { nodes, edges } = useCanvasStore.getState()
    expect(nodes).toHaveLength(N + 1)
    expect(nodes.some((n) => n.id.startsWith('urn:staged:') || n.data.isPending)).toBe(false)
    expect(nodes.find((n) => n.id === 'urn:real:0')?.data).toMatchObject({ urn: 'urn:real:0', childCount: 10 })
    expect(edges).toHaveLength(N + N / 10)
    expect(edges.some((e) => e.data?.isPending || e.source.startsWith('urn:staged:') || e.target.startsWith('urn:staged:'))).toBe(false)
    expect(edges.find((e) => e.id === 'edge_c11')).toMatchObject({ source: 'urn:real:1', target: 'urn:real:11', type: 'containment' })
    expect(edges.find((e) => e.id === 'edge_l3')).toMatchObject({ source: 'urn:real:30', target: 'urn:real:31' })
    expect(useCanvasStore.getState()._nodeIndex.has('urn:real:1999')).toBe(true)
  })
})

describe('reconciling a reversed link', () => {
  it('takes the id the server minted for it', async () => {
    seed([node('urn:a'), node('urn:b')], [{
      id: 'staged-edge-r', source: 'urn:b', target: 'urn:a', type: 'lineage', data: { edgeType: 'FLOWS_TO', isPending: 'create' },
    }])
    mockApply.mockResolvedValue({ commitId: 'x', assigned: { 'staged-edge-r': 'edge_real' } } as never)
    await saveStagedChangesToDraft([sc({
      type: 'reverse_edge', targetId: 'staged-edge-r',
      before: { edge: { id: 'e1', source: 'urn:a', target: 'urn:b' } },
      after: { edge: { id: 'staged-edge-r', source: 'urn:b', target: 'urn:a', data: { edgeType: 'FLOWS_TO' } } },
    })], target)

    expect(mockApply.mock.calls[0][3]).toContainEqual(expect.objectContaining({ op: 'create', kind: 'edge', ref: 'staged-edge-r' }))
    expect(useCanvasStore.getState().edges).toEqual([
      expect.objectContaining({ id: 'edge_real', source: 'urn:b', target: 'urn:a', data: expect.objectContaining({ isPending: undefined }) }),
    ])
  })
})

describe('the tokens a save answers with', () => {
  it('land on every written entity the canvas holds — past the entities it answered in full, and an `edge:X` link', async () => {
    seed([node('urn:a', { version: 'a1' }), node('urn:b', { version: 'b1' })], [
      { id: 'X', source: 'urn:a', target: 'urn:b', type: 'lineage', data: { edgeType: 'FLOWS_TO', version: 'x1' } },
    ])
    mockApply.mockResolvedValue({
      commitId: 'x', assigned: {}, entitiesTruncated: true,
      entities: {
        'urn:a': { kind: 'node', version: 'a2', node: { urn: 'urn:a', entityType: 'table', displayName: 'A2', properties: {}, version: 'a2' } },
        'edge:X': { kind: 'edge', version: 'x2', edge: {
          id: 'edge:X', sourceUrn: 'urn:a', targetUrn: 'urn:b', edgeType: 'FLOWS_TO', confidence: 0.4, properties: {}, version: 'x2' } },
      },
      versions: { 'urn:a': 'a2', 'urn:b': 'b2', 'edge:X': 'x2' },
    } as never)
    await saveStagedChangesToDraft([
      sc({ id: 'a', type: 'rename_entity', targetId: 'urn:a', targetUrn: 'urn:a', before: { label: 'urn:a' }, after: { label: 'A2' } }),
      sc({ id: 'b', type: 'rename_entity', targetId: 'urn:b', targetUrn: 'urn:b', before: { label: 'urn:b' }, after: { label: 'B2' } }),
      sc({ id: 'x', type: 'edit_edge', targetId: 'X', before: { confidence: 0.9 }, after: { confidence: 0.4 } }),
    ], target)

    const { nodes, edges } = useCanvasStore.getState()
    expect(nodes.map((n) => [n.id, n.data.version])).toEqual([['urn:a', 'a2'], ['urn:b', 'b2']])
    expect(edges[0].data).toMatchObject({ version: 'x2', confidence: 0.4 })
  })
})
