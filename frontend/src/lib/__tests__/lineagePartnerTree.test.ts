import { describe, expect, it } from 'vitest'
import { emptyWalkModel, type LensWalkModel, type LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'
import { partnersFromRollups, partnersFromWalk, partnerName, withFields } from '../lineagePartnerTree'

const node = (urn: string, name = urn): LensWalkNode =>
  ({ id: urn, urn, displayName: name, entityType: 'Node', position: { x: 0, y: 0 }, data: { label: name, urn, type: 'Node' } }) as unknown as LensWalkNode

const contain = (parent: string, ...kids: string[]) => kids.map(k => ({ sourceUrn: parent, targetUrn: k }))

// Payment Gateway ⊃ Accounts (the focal) ⊃ acct_1, acct_2
// Web Analytics ⊃ Customers ⊃ cust_1, cust_2 ; Web Analytics ⊃ Orders ⊃ ord_1
// HR System ⊃ Staff ⊃ staff_1
function walk(over: Partial<LensWalkModel> = {}): LensWalkModel {
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

/** The coarse page for the same focal: partner entities and their rollup
 *  weights — no column at all. */
function rollups(over: Partial<LensWalkModel> = {}): LensWalkModel {
  return {
    ...emptyWalkModel('accounts'),
    nodes: ['pg', 'accounts', 'wa', 'customers', 'orders', 'hr', 'staff'].map(u => node(u)),
    containmentEdges: [...contain('pg', 'accounts'), ...contain('wa', 'customers', 'orders'), ...contain('hr', 'staff')],
    lineageEdges: [
      { id: 'r1', sourceUrn: 'customers', targetUrn: 'accounts', edgeType: 'AGGREGATED', kind: 'rollup', weight: 3 },
      { id: 'r2', sourceUrn: 'orders', targetUrn: 'accounts', edgeType: 'AGGREGATED', kind: 'rollup', weight: 1 },
      { id: 'r3', sourceUrn: 'accounts', targetUrn: 'staff', edgeType: 'AGGREGATED', kind: 'rollup', weight: 1 },
    ],
    coarseUpstreamUrns: new Set(['customers', 'orders']),
    coarseDownstreamUrns: new Set(['staff']),
    ...over,
  }
}

describe('partnersFromRollups — what opening the drawer loads', () => {
  it('counts the entities that feed it and the flows each carries, with no column fetched', () => {
    const up = partnersFromRollups(rollups(), 'up')
    expect(up.coarse).toBe(true)
    expect(up.peers.sort()).toEqual(['customers', 'orders'])
    expect(up.flows).toBe(4)
    expect(up.roots.map(partnerName)).toEqual(['wa'])
    const wa = up.roots[0]
    expect(wa.peers).toBe(2)
    expect(wa.children.map(c => [partnerName(c), c.flows, c.isPeer, c.contentsLoaded])).toEqual([
      ['customers', 3, true, false],
      ['orders', 1, true, false],
    ])
  })

  it('keeps the two directions apart', () => {
    expect(partnersFromRollups(rollups(), 'down').peers).toEqual(['staff'])
  })

  it('inner-first: a system-level cell restating its tables\' flows is not a partner too', () => {
    const m = rollups({
      lineageEdges: [
        ...rollups().lineageEdges,
        { id: 'r0', sourceUrn: 'wa', targetUrn: 'accounts', edgeType: 'AGGREGATED', kind: 'rollup', weight: 4 },
      ],
    })
    const up = partnersFromRollups(m, 'up')
    expect(up.peers.sort()).toEqual(['customers', 'orders'])
    expect(up.flows).toBe(4)
  })
})

describe('partnersFromWalk — what opening an entity loads', () => {
  it('counts the same entities, and the columns and flows under them', () => {
    const up = partnersFromWalk(walk(), 'up')
    expect(up.coarse).toBe(false)
    expect(up.peers.sort()).toEqual(['customers', 'orders'])
    expect(up.partnerUrns.sort()).toEqual(['cust_1', 'cust_2', 'ord_1'])
    expect(up.flows).toBe(4)
  })

  it('nests them system → entity → column, and says which focal columns each feeds', () => {
    const wa = partnersFromWalk(walk(), 'up').roots[0]
    expect(partnerName(wa)).toBe('wa')
    expect([wa.peers, wa.partners, wa.flows]).toEqual([2, 3, 4])
    const customers = wa.children[0]
    expect([partnerName(customers), customers.isPeer, customers.partners, customers.flows]).toEqual(['customers', true, 2, 3])
    expect(customers.children.map(c => [c.urn, c.flows])).toEqual([['cust_2', 2], ['cust_1', 1]])
    expect(customers.children[0].via.sort()).toEqual(['acct_1', 'acct_2'])
  })

  it('measures a peer along the flow, not from the root — hierarchies nest differently', () => {
    // A top-level table (no parent) whose column is fed by
    // Web Analytics › Customers › cust_1: Customers sits beside it.
    const m = walk({
      containmentEdges: [...contain('accounts', 'acct_1'), ...contain('wa', 'customers'), ...contain('customers', 'cust_1')],
      upstreamUrns: new Set(['cust_1']),
      downstreamUrns: new Set(),
    })
    expect(partnersFromWalk(m, 'up').peers).toEqual(['customers'])
  })

  it('never counts lineage inside the focal as a partner', () => {
    const up = partnersFromWalk(walk({ upstreamUrns: new Set(['cust_1', 'acct_1']) }), 'up')
    expect(up.partnerUrns).toEqual(['cust_1'])
  })

  it('a leaf focal\'s peers are its direct neighbours', () => {
    const up = partnersFromWalk(walk({ focusUrn: 'acct_2', upstreamUrns: new Set(['cust_2', 'ord_1']), downstreamUrns: new Set(['staff_1']) }), 'up')
    expect(up.peers.sort()).toEqual(['cust_2', 'ord_1'])
    expect(up.flows).toBe(2)
  })

  it('a manual model\'s flows authored as rollups still count once each', () => {
    const up = partnersFromWalk(walk({
      focusUrn: 'acct_2',
      upstreamUrns: new Set(['ord_1']),
      downstreamUrns: new Set(),
      lineageEdges: [{ id: 'm1', sourceUrn: 'ord_1', targetUrn: 'acct_2', edgeType: 'AGGREGATED', kind: 'rollup', weight: null }],
    }), 'up')
    expect([up.peers.length, up.flows]).toEqual([1, 1])
  })
})

describe('withFields — the columns land under the tree the reader holds', () => {
  it('grafts each entity\'s columns under the coarse entity, keeping the coarse counts', () => {
    const merged = withFields(partnersFromRollups(rollups(), 'up'), partnersFromWalk(walk(), 'up'), true)
    expect(merged.coarse).toBe(true)
    expect(merged.flows).toBe(4)
    const customers = merged.roots[0].children.find(c => c.urn === 'customers')!
    expect(customers.contentsLoaded).toBe(true)
    expect(customers.children.map(c => c.urn).sort()).toEqual(['cust_1', 'cust_2'])
  })

  it('columns from an unfinished walk show, but the entity is not called loaded', () => {
    // A first page holding 3 of a table's 10 feeding columns must not read
    // as the whole answer.
    const merged = withFields(partnersFromRollups(rollups(), 'up'), partnersFromWalk(walk(), 'up'), false)
    const customers = merged.roots[0].children.find(c => c.urn === 'customers')!
    expect(customers.children.length).toBe(2)
    expect(customers.contentsLoaded).toBe(false)
  })

  it('an entity the walk has not reached yet stays closed-but-openable', () => {
    const partial = partnersFromWalk(walk({ upstreamUrns: new Set(['cust_1']) }), 'up')
    const merged = withFields(partnersFromRollups(rollups(), 'up'), partial)
    const orders = merged.roots[0].children.find(c => c.urn === 'orders')!
    expect(orders.contentsLoaded).toBe(false)
  })
})
