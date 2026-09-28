import { describe, it, expect } from 'vitest'
import { targetFromLine, targetFromEdge, type DrawnLine } from '../drawerEdgeTarget'
import type { LineageEdge } from '@/store/canvas'

const storeEdge = (id: string, source: string, target: string, edgeType = 'FLOWS_TO'): LineageEdge =>
  ({ id, source, target, data: { edgeType } }) as LineageEdge

const member = (id: string, origSource: string, origTarget: string, edgeType = 'FLOWS_TO') =>
  ({ id, source: 'drawnA', target: 'drawnB', _origSource: origSource, _origTarget: origTarget, data: { edgeType } })

const NO_STORE = (): LineageEdge | undefined => undefined

describe('targetFromLine', () => {
  it('a line standing for one relationship opens that relationship, at its real endpoints', () => {
    const line: DrawnLine = { id: 'bundle-p->b', source: 'p', target: 'b', data: { members: [member('e1', 'c1', 'b')] } }
    expect(targetFromLine(line, NO_STORE)).toEqual({
      kind: 'relationship', id: 'e1', source: 'c1', target: 'b', edgeType: 'FLOWS_TO', lineId: 'bundle-p->b',
    })
  })

  it('a line of several relationships opens a connection listing them', () => {
    const line: DrawnLine = {
      id: 'bundle-p->b', source: 'p', target: 'b', types: ['FLOWS_TO', 'PRODUCES'], edgeCount: 2,
      data: { members: [member('e1', 'c1', 'b'), member('e2', 'c2', 'b', 'PRODUCES')] },
    }
    const t = targetFromLine(line, NO_STORE)
    expect(t.kind).toBe('connection')
    if (t.kind !== 'connection') return
    expect(t.members.map(m => `${m.id}:${m.source}->${m.target}:${m.edgeType}`))
      .toEqual(['e1:c1->b:FLOWS_TO', 'e2:c2->b:PRODUCES'])
    expect(t.types).toEqual(['FLOWS_TO', 'PRODUCES'])
    expect(t.weight).toBe(2)
    expect(t.summaryOnly).toBeUndefined()
  })

  it('one raw relationship beside a roll-up is a connection, not the raw one alone', () => {
    const line: DrawnLine = {
      id: 'bundle-a->b', source: 'a', target: 'b', edgeCount: 4300,
      data: { members: [member('e1', 'a', 'b'), member('agg1', 'a', 'b', 'AGGREGATED')] },
    }
    const t = targetFromLine(line, NO_STORE)
    expect(t.kind).toBe('connection')
    if (t.kind !== 'connection') return
    expect(t.members.find(m => m.id === 'agg1')?.rollup).toBe(true)
    expect(t.weight).toBe(4300)
  })

  it('a roll-up alone is a connection — it is a summary, not an authored relationship', () => {
    const line: DrawnLine = { id: 'bundle-a->b', source: 'a', target: 'b', data: { members: [member('agg1', 'a', 'b', 'AGGREGATED')] } }
    expect(targetFromLine(line, NO_STORE).kind).toBe('connection')
  })

  it('a bidirectional line says so', () => {
    const line: DrawnLine = {
      id: 'bundle-bi-a->b', source: 'a', target: 'b', isBidirectional: true,
      data: { members: [member('e1', 'a', 'b'), member('e2', 'b', 'a')] },
    }
    const t = targetFromLine(line, NO_STORE)
    expect(t.kind === 'connection' && t.bidirectional).toBe(true)
  })

  it('a Graph canvas line keeps its store edges as members; one member is that edge', () => {
    const e1 = storeEdge('e1', 'c1', 'b')
    const one: DrawnLine = { id: 'proj:e1', source: 'p', target: 'b', data: { edgeType: 'FLOWS_TO', members: [e1] } }
    expect(targetFromLine(one, NO_STORE)).toMatchObject({ kind: 'relationship', id: 'e1', source: 'c1', target: 'b' })

    const three: DrawnLine = {
      id: 'proj:e1', source: 'p', target: 'b',
      data: { edgeType: 'FLOWS_TO', members: [e1, storeEdge('e2', 'c2', 'b'), storeEdge('e3', 'c3', 'b')] },
    }
    const t = targetFromLine(three, NO_STORE)
    expect(t.kind === 'connection' && t.members.map(m => m.id)).toEqual(['e1', 'e2', 'e3'])
  })

  it('a store edge drawn as itself, with no member list, is that edge', () => {
    const e1 = storeEdge('c1', 'p', 'c', 'CONTAINS')
    const line: DrawnLine = { id: 'c1', source: 'p', target: 'c', data: { edgeType: 'CONTAINS' } }
    expect(targetFromLine(line, (id) => (id === 'c1' ? e1 : undefined))).toMatchObject({ kind: 'relationship', id: 'c1', edgeType: 'CONTAINS' })
  })

  it('a trace wire joining the two cards of its one hop is that relationship, found by its triple', () => {
    const wire: DrawnLine = { id: 'bundle:a>b:raw', source: 'a', target: 'b', kind: 'raw', isBundled: false, types: ['FLOWS_TO'], edgeCount: 1 }
    expect(targetFromLine(wire, NO_STORE)).toEqual({
      kind: 'relationship', id: 'bundle:a>b:raw', source: 'a', target: 'b', edgeType: 'FLOWS_TO', lineId: 'bundle:a>b:raw',
    })
  })

  it('a bundled or roll-up wire is a summary with no member list', () => {
    const wire: DrawnLine = { id: 'bundle:a>b:rollup', source: 'a', target: 'b', kind: 'rollup', isBundled: true, types: ['FLOWS_TO'], edgeCount: 12 }
    expect(targetFromLine(wire, NO_STORE)).toMatchObject({ kind: 'connection', summaryOnly: true, members: [], weight: 12, types: ['FLOWS_TO'] })

    const agg: DrawnLine = { id: 'agg:a->b', source: 'a', target: 'b', data: { edgeType: 'AGGREGATED', edgeTypes: ['FLOWS_TO'], edgeCount: 9 } }
    expect(targetFromLine(agg, NO_STORE)).toMatchObject({ kind: 'connection', summaryOnly: true, types: ['FLOWS_TO'], weight: 9 })
  })
})

describe('targetFromEdge', () => {
  it('opens a store edge as a relationship', () => {
    expect(targetFromEdge(storeEdge('e1', 'a', 'b'))).toEqual({ kind: 'relationship', id: 'e1', source: 'a', target: 'b', edgeType: 'FLOWS_TO' })
  })
})
