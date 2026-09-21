import { describe, expect, it } from 'vitest'
import { emptyWalkModel, type LensWalkModel, type LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'
import { partnersFromWalk, partnerName } from '../lineagePartnerTree'

const node = (urn: string, name = urn): LensWalkNode =>
  ({ id: urn, urn, displayName: name, entityType: 'Node', position: { x: 0, y: 0 }, data: { label: name, urn, type: 'Node' } }) as unknown as LensWalkNode

// Payment Gateway ⊃ Accounts (the focal) ⊃ acct_1, acct_2
// Web Analytics ⊃ Customers ⊃ cust_1, cust_2 ; Web Analytics ⊃ Orders ⊃ ord_1
// HR System ⊃ Staff ⊃ staff_1
function model(over: Partial<LensWalkModel> = {}): LensWalkModel {
  const contain = (parent: string, ...kids: string[]) => kids.map(k => ({ sourceUrn: parent, targetUrn: k }))
  return {
    ...emptyWalkModel('accounts'),
    nodes: ['pg', 'accounts', 'acct_1', 'acct_2', 'wa', 'customers', 'cust_1', 'cust_2', 'orders', 'ord_1', 'hr', 'staff', 'staff_1'].map(u => node(u)),
    containmentEdges: [
      ...contain('pg', 'accounts'), ...contain('accounts', 'acct_1', 'acct_2'),
      ...contain('wa', 'customers', 'orders'), ...contain('customers', 'cust_1', 'cust_2'), ...contain('orders', 'ord_1'),
      ...contain('hr', 'staff'), ...contain('staff', 'staff_1'),
    ],
    lineageEdges: [
      { id: 'e1', sourceUrn: 'cust_1', targetUrn: 'acct_1', edgeType: 'FLOWS_TO', kind: 'raw' },
      { id: 'e2', sourceUrn: 'cust_2', targetUrn: 'acct_1', edgeType: 'FLOWS_TO', kind: 'raw' },
      { id: 'e3', sourceUrn: 'cust_2', targetUrn: 'acct_2', edgeType: 'FLOWS_TO', kind: 'raw' },
      { id: 'e4', sourceUrn: 'ord_1', targetUrn: 'acct_2', edgeType: 'FLOWS_TO', kind: 'raw' },
      { id: 'e5', sourceUrn: 'acct_2', targetUrn: 'staff_1', edgeType: 'FLOWS_TO', kind: 'raw' },
      // Lineage inside the focal is not a partner of it.
      { id: 'e6', sourceUrn: 'acct_1', targetUrn: 'acct_2', edgeType: 'FLOWS_TO', kind: 'raw' },
    ],
    upstreamUrns: new Set(['cust_1', 'cust_2', 'ord_1']),
    downstreamUrns: new Set(['staff_1']),
    ...over,
  }
}

describe('partnersFromWalk — a container focal', () => {
  it('counts the partners the walk found, and the flows that reach them', () => {
    const up = partnersFromWalk(model(), 'up')
    expect(up.partners).toBe(3)
    expect(up.flows).toBe(4)
    expect(up.coarse).toBe(false)
  })

  it('groups them under their systems, then the entities that hold them', () => {
    const up = partnersFromWalk(model(), 'up')
    expect(up.roots.map(partnerName)).toEqual(['wa'])
    const wa = up.roots[0]
    expect(wa.partners).toBe(3)
    // Most partners first.
    expect(wa.children.map(partnerName)).toEqual(['customers', 'orders'])
    const customers = wa.children[0]
    expect(customers.partners).toBe(2)
    expect(customers.flows).toBe(3)
    expect(customers.children.map(c => [c.urn, c.isPartner, c.flows])).toEqual([
      ['cust_2', true, 2],
      ['cust_1', true, 1],
    ])
  })

  it('says which of the focal\'s own fields each partner meets', () => {
    const cust2 = partnersFromWalk(model(), 'up').roots[0].children[0].children[0]
    expect(cust2.via.sort()).toEqual(['acct_1', 'acct_2'])
  })

  it('peers are the partners at the focal\'s own level — the tables beside a table', () => {
    expect(partnersFromWalk(model(), 'up').peers.sort()).toEqual(['customers', 'orders'])
    expect(partnersFromWalk(model(), 'down').peers).toEqual(['staff'])
  })

  it('peers are measured along the flow, not from the top — hierarchies nest differently', () => {
    // A top-level table (no parent) whose column is fed by
    // Web Analytics › Customers › cust_1: Customers sits beside it.
    const m = model({
      containmentEdges: [
        { sourceUrn: 'accounts', targetUrn: 'acct_1' },
        { sourceUrn: 'wa', targetUrn: 'customers' },
        { sourceUrn: 'customers', targetUrn: 'cust_1' },
      ],
      upstreamUrns: new Set(['cust_1']),
      downstreamUrns: new Set(),
    })
    expect(partnersFromWalk(m, 'up').peers).toEqual(['customers'])
  })

  it('never counts lineage inside the focal as a partner', () => {
    const m = model({ upstreamUrns: new Set(['cust_1', 'acct_1']) })
    expect(partnersFromWalk(m, 'up').partners).toBe(1)
  })
})

describe('partnersFromWalk — before the raw pages land', () => {
  const coarseModel = () => model({
    upstreamUrns: new Set(),
    downstreamUrns: new Set(),
    coarseUpstreamUrns: new Set(['customers', 'orders']),
    lineageEdges: [
      { id: 'r1', sourceUrn: 'customers', targetUrn: 'accounts', edgeType: 'AGGREGATED', kind: 'rollup', weight: 3 },
      { id: 'r2', sourceUrn: 'orders', targetUrn: 'accounts', edgeType: 'AGGREGATED', kind: 'rollup', weight: 1 },
    ],
  })

  it('reads the rollup cells: partner containers and the flows each summarises', () => {
    const up = partnersFromWalk(coarseModel(), 'up')
    expect(up.coarse).toBe(true)
    expect(up.partners).toBe(2)
    expect(up.flows).toBe(4)
    expect(up.roots[0].children.map(c => [partnerName(c), c.flows])).toEqual([['customers', 3], ['orders', 1]])
  })

  it('once the raw pages have settled, an empty raw set is the answer', () => {
    const up = partnersFromWalk(coarseModel(), 'up', { fineSettled: true })
    expect(up.coarse).toBe(false)
    expect(up.partners).toBe(0)
    expect(up.roots).toEqual([])
  })
})

describe('partnersFromWalk — a leaf focal', () => {
  it('partners are its direct neighbours, and peers are the same things', () => {
    const m = model({
      focusUrn: 'acct_2',
      upstreamUrns: new Set(['cust_2', 'ord_1']),
      downstreamUrns: new Set(['staff_1']),
    })
    const up = partnersFromWalk(m, 'up')
    expect(up.partners).toBe(2)
    expect(up.flows).toBe(2)
    expect(up.peers.sort()).toEqual(['cust_2', 'ord_1'])
  })

  it('a manual model\'s flows authored as rollups still count once each', () => {
    const m = model({
      focusUrn: 'acct_2',
      upstreamUrns: new Set(['ord_1']),
      downstreamUrns: new Set(),
      lineageEdges: [{ id: 'm1', sourceUrn: 'ord_1', targetUrn: 'acct_2', edgeType: 'AGGREGATED', kind: 'rollup', weight: null }],
    })
    const up = partnersFromWalk(m, 'up')
    expect(up.partners).toBe(1)
    expect(up.flows).toBe(1)
  })
})
