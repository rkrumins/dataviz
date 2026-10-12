/**
 * primeRevealSpine — what a reveal loads before it opens anything: the
 * spine's missing nodes, marked `viaReveal`, and its containment edges.
 *
 * Shared by the search reveal and the partner reveal, which can ask for a
 * hundred partners at once — past the server's default page for a node query.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { primeRevealSpine } from '../primeRevealSpine'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import type { GraphDataProvider, GraphNode } from '@/providers/GraphDataProvider'

const graphNode = (urn: string): GraphNode => ({ urn, entityType: 'dataset', displayName: urn, properties: {} })
const lineageNode = (id: string) => ({ id, position: { x: 0, y: 0 }, data: { label: id, urn: id, type: 'generic' } }) as LineageNode

function providerFor(opts: { edgesFail?: boolean } = {}) {
  const getNodes = vi.fn(async (q: { urns?: string[] }) => (q.urns ?? []).map(graphNode))
  const getEdgesBetween = vi.fn(async (urns: string[]) => {
    if (opts.edgesFail) throw new Error('between refused')
    return urns.slice(1).map(u => ({ id: `c:${urns[0]}>${u}`, sourceUrn: urns[0], targetUrn: u, edgeType: 'CONTAINS' }))
  })
  return { provider: { getNodes, getEdgesBetween } as unknown as GraphDataProvider, getNodes, getEdgesBetween }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  useCanvasStore.setState({
    nodes: [lineageNode('A')],
    edges: [],
    _nodeIndex: new Set(['A']),
    _edgeIndex: new Set(),
    visibleEdges: [],
  })
  useCanvasStore.getState().clearEdgeFetchFailures()
})

describe('primeRevealSpine', () => {
  it('asks for every missing node in one request, past the server\'s default page', async () => {
    const { provider, getNodes } = providerFor()
    const rows = Array.from({ length: 150 }, (_, i) => `r${i}`)
    await primeRevealSpine(provider, ['A', ...rows], ['CONTAINS'])

    expect(getNodes).toHaveBeenCalledTimes(1)
    expect(getNodes).toHaveBeenCalledWith({ urns: rows, limit: 150 })
  })

  it('marks what it loads viaReveal, so no page counts it', async () => {
    const { provider } = providerFor()
    await primeRevealSpine(provider, ['A', 'r1'], ['CONTAINS'])

    const r1 = useCanvasStore.getState().nodes.find(n => n.id === 'r1')
    expect(r1?.data.viaReveal).toBe(true)
  })

  it('asks for the containment edges of the whole spine at once', async () => {
    const { provider, getEdgesBetween } = providerFor()
    await primeRevealSpine(provider, ['A', 'r1', 'r2'], ['CONTAINS'])

    expect(getEdgesBetween).toHaveBeenCalledTimes(1)
    expect(getEdgesBetween).toHaveBeenCalledWith(['A', 'r1', 'r2'], ['CONTAINS'])
    expect(useCanvasStore.getState().edges.map(e => `${e.source}>${e.target}`).sort()).toEqual(['A>r1', 'A>r2'])
  })

  it('notes an edge failure instead of throwing', async () => {
    const { provider } = providerFor({ edgesFail: true })
    await expect(primeRevealSpine(provider, ['A', 'r1'], ['CONTAINS'])).resolves.toBeUndefined()
    expect(useCanvasStore.getState().edgeFetchFailures).toBe(1)
  })

  it('asks for no edges for a spine of one', async () => {
    const { provider, getEdgesBetween } = providerFor()
    await primeRevealSpine(provider, ['r1'], ['CONTAINS'])
    expect(getEdgesBetween).not.toHaveBeenCalled()
  })
})
