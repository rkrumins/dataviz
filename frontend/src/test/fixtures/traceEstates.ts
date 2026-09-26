import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'
import type { ViewLayerConfig } from '@/types/schema'

const wn = (urn: string, type: string, childCount = 0): LensWalkNode => ({
  id: urn, type: 'default', position: { x: 0, y: 0 },
  data: { urn, label: urn, type, childCount }, urn, displayName: urn, entityType: type,
}) as unknown as LensWalkNode
const raw = (s: string, t: string) => ({ id: `r:${s}>${t}`, sourceUrn: s, targetUrn: t, edgeType: 'TRANSFORMS', kind: 'raw' as const, weight: null })
const roll = (s: string, t: string, w: number) => ({ id: `g:${s}>${t}`, sourceUrn: s, targetUrn: t, edgeType: 'AGGREGATED', kind: 'rollup' as const, weight: w })
const has = (p: string, c: string) => ({ sourceUrn: p, targetUrn: c })

export function cfoEstate() {
  // Report lane: Tableau ⊃ CFO Revenue Dashboard ⊃ {AOV by Channel ⊃ {channel, avg_order_value}}
  // Warehouse lane: INTERMEDIATE_T2 ⊃ int_clean_orders_t2 ⊃ {channel, net_revenue}; REPORTING ⊃ rpt_monthly_revenue ⊃ {channel, gross_profit}
  const nodes = [
    wn('tableau', 'dataPlatform', 1), wn('cfo', 'dashboard', 1), wn('aov', 'chart', 2), wn('aov.channel', 'schemaField'), wn('aov.avg', 'schemaField'),
    wn('INTERMEDIATE_T2', 'container', 1), wn('orders', 'dataset', 2), wn('orders.channel', 'schemaField'), wn('orders.net', 'schemaField'),
    wn('REPORTING', 'container', 1), wn('rpt', 'dataset', 2), wn('rpt.channel', 'schemaField'), wn('rpt.gross', 'schemaField'),
    wn('snowflake', 'dataPlatform', 2),
  ]
  const containmentEdges = [
    has('tableau', 'cfo'), has('cfo', 'aov'), has('aov', 'aov.channel'), has('aov', 'aov.avg'),
    has('snowflake', 'INTERMEDIATE_T2'), has('snowflake', 'REPORTING'),
    has('INTERMEDIATE_T2', 'orders'), has('orders', 'orders.channel'), has('orders', 'orders.net'),
    has('REPORTING', 'rpt'), has('rpt', 'rpt.channel'), has('rpt', 'rpt.gross'),
  ]
  const lineageEdges = [
    raw('orders.channel', 'aov.channel'), raw('orders.net', 'aov.avg'), raw('rpt.gross', 'aov.avg'),
    roll('orders', 'aov', 2), roll('rpt', 'aov', 1), roll('INTERMEDIATE_T2', 'cfo', 2), roll('REPORTING', 'cfo', 1),
  ]
  const model: LensWalkModel = {
    focusUrn: 'cfo', nodes, lineageEdges, containmentEdges,
    upstreamUrns: new Set(['orders.channel', 'orders.net', 'rpt.gross', 'orders', 'rpt', 'INTERMEDIATE_T2', 'REPORTING']),
    downstreamUrns: new Set(), frontierUp: [], frontierDown: [], truncated: false, truncationReason: null,
    seedTruncated: false, seedCursor: null,
  }
  const layers: ViewLayerConfig[] = [
    { id: 'warehouse', name: 'Warehouse', order: 0, entityTypes: ['container'] },
    { id: 'report', name: 'Report', order: 1, entityTypes: ['dataPlatform'] },
  ]
  // The VIEW anchors at the container (not the platform) for the warehouse side — the screenshot's truth.
  const assignments = { INTERMEDIATE_T2: { layerId: 'warehouse' }, REPORTING: { layerId: 'warehouse' }, tableau: { layerId: 'report' } }
  return { model, layers, assignments }
}

export function rootsNodeEstate(depth: 3 | 10) {
  // Roots ⊃ Node ⊃ … ⊃ Node (depth levels) with lineage at the deepest level between two sibling chains.
  const nodes: LensWalkNode[] = [wn('ROOT', 'Roots', 2)]
  const containmentEdges: Array<{ sourceUrn: string; targetUrn: string }> = []
  for (const chain of ['a', 'b']) {
    let parent = 'ROOT'
    for (let d = 1; d <= depth; d++) {
      const urn = `${chain}${d}`
      nodes.push(wn(urn, 'Node', d < depth ? 1 : 0))
      containmentEdges.push(has(parent, urn)); parent = urn
    }
  }
  const lineageEdges = [raw(`a${depth}`, `b${depth}`)]
  const model: LensWalkModel = {
    focusUrn: `a${Math.max(1, depth - 1)}`, nodes, lineageEdges, containmentEdges,
    upstreamUrns: new Set(), downstreamUrns: new Set([`b${depth}`]), frontierUp: [], frontierDown: [],
    truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
  }
  const layers: ViewLayerConfig[] = [{ id: 'roots', name: 'Roots', order: 0, entityTypes: ['Roots'] }]
  return { model, layers, assignments: { ROOT: { layerId: 'roots' } } }
}

/**
 * The user's report #3 (2026-08-21), raw-only: a TABLE whose lineage lives
 * on its columns, with no rollups at all (a manual model, or an estate
 * whose aggregation worker has not run). No edge touches `orders` itself.
 *
 *   RAW ⊃ orders ⊃ {orders.id, orders.amt}      ← the focus
 *   MART ⊃ sales ⊃ {sales.id, sales.amt}         ← downstream partner table
 *   FIN ⊃ ledger ⊃ {ledger.amt}                   ← upstream partner table
 *   ledger.amt → orders.amt;  orders.id → sales.id;  orders.amt → sales.amt
 *
 * Lane: one warehouse lane anchored at the three containers, so each partner
 * table is a depth-1 child of a closed lane root — hidden unless the seed
 * opens the root.
 */
export function tableEstate() {
  const nodes = [
    wn('RAW', 'container', 1), wn('orders', 'dataset', 2), wn('orders.id', 'schemaField'), wn('orders.amt', 'schemaField'),
    wn('MART', 'container', 1), wn('sales', 'dataset', 2), wn('sales.id', 'schemaField'), wn('sales.amt', 'schemaField'),
    wn('FIN', 'container', 1), wn('ledger', 'dataset', 1), wn('ledger.amt', 'schemaField'),
  ]
  const containmentEdges = [
    has('RAW', 'orders'), has('orders', 'orders.id'), has('orders', 'orders.amt'),
    has('MART', 'sales'), has('sales', 'sales.id'), has('sales', 'sales.amt'),
    has('FIN', 'ledger'), has('ledger', 'ledger.amt'),
  ]
  const lineageEdges = [raw('ledger.amt', 'orders.amt'), raw('orders.id', 'sales.id'), raw('orders.amt', 'sales.amt')]
  const model: LensWalkModel = {
    focusUrn: 'orders', nodes, lineageEdges, containmentEdges,
    upstreamUrns: new Set(['ledger.amt']), downstreamUrns: new Set(['sales.id', 'sales.amt']),
    frontierUp: [], frontierDown: [], truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
  }
  const layers: ViewLayerConfig[] = [{ id: 'warehouse', name: 'Warehouse', order: 0, entityTypes: ['container'] }]
  const assignments = { RAW: { layerId: 'warehouse' }, MART: { layerId: 'warehouse' }, FIN: { layerId: 'warehouse' } }
  return { model, layers, assignments }
}

/**
 * THE COARSE FIRST PAINT's page (Part G, 2026-08-21), before a raw hop has
 * landed: the focus table `orders` with the rollup cells incident to it —
 * partner tables `journal` (30) and `balances` (10), their database (40),
 * its department (40) — as the aggregation worker stamps them per
 * containment-level pair. Inner-first: the tables are the cards, the
 * database and department are hosts (their cells are fully stated inside).
 */
export function coarseCellsEstate() {
  const nodes = [
    wn('dept', 'container', 2), wn('ledger_db', 'container', 2), wn('journal', 'dataset', 2), wn('balances', 'dataset', 1),
    wn('orders_db', 'container', 1), wn('orders', 'dataset', 2),
  ]
  const containmentEdges = [has('dept', 'ledger_db'), has('ledger_db', 'journal'), has('ledger_db', 'balances'), has('dept', 'orders_db'), has('orders_db', 'orders')]
  const lineageEdges = [roll('orders', 'journal', 30), roll('orders', 'balances', 10), roll('orders', 'ledger_db', 40), roll('orders', 'dept', 40)]
  const model: LensWalkModel = {
    focusUrn: 'orders', nodes, lineageEdges, containmentEdges,
    upstreamUrns: new Set(), downstreamUrns: new Set(),
    coarseUpstreamUrns: new Set(), coarseDownstreamUrns: new Set(['journal', 'balances', 'ledger_db', 'dept']),
    frontierUp: [], frontierDown: [], truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
  }
  const layers: ViewLayerConfig[] = [{ id: 'warehouse', name: 'Warehouse', order: 0, entityTypes: ['container'] }]
  const assignments = { dept: { layerId: 'warehouse' } }
  return { model, layers, assignments }
}

/** `coarseCellsEstate` once the raw pages have landed too: the focus's
 *  columns, the partners' columns, and the real flows — three into
 *  `journal`, one into `balances`. The harness serves the cells as the
 *  coarse page and the raw hops as the fine page. */
export function coarseThenFineEstate() {
  const base = coarseCellsEstate()
  const nodes = [...base.model.nodes, wn('orders.c0', 'schemaField'), wn('orders.c1', 'schemaField'), wn('journal.a', 'schemaField'), wn('journal.b', 'schemaField'), wn('balances.a', 'schemaField')]
  const containmentEdges = [...base.model.containmentEdges, has('orders', 'orders.c0'), has('orders', 'orders.c1'), has('journal', 'journal.a'), has('journal', 'journal.b'), has('balances', 'balances.a')]
  const lineageEdges = [...base.model.lineageEdges, raw('orders.c0', 'journal.a'), raw('orders.c1', 'journal.a'), raw('orders.c1', 'journal.b'), raw('orders.c0', 'balances.a')]
  const model: LensWalkModel = {
    ...base.model, nodes, containmentEdges, lineageEdges,
    downstreamUrns: new Set(['journal.a', 'journal.b', 'balances.a']),
  }
  return { model, layers: base.layers, assignments: base.assignments }
}


/**
 * A view built the way Data Source views are: ONE COLUMN PER ENTITY. Each
 * layer is anchored at an entity, the anchor is promoted to be the column
 * itself (never a row), and its children are the column's rows.
 *
 *   SRC ⊃ {SRC.orders, SRC.customers}   ← column "Source"
 *   DST ⊃ {DST.revenue}                 ← column "Target"
 *   SRC.orders → DST.revenue
 */
export function anchoredEstate() {
  const nodes = [
    wn('SRC', 'dataPlatform', 2), wn('SRC.orders', 'dataset'), wn('SRC.customers', 'dataset'),
    wn('DST', 'dataPlatform', 1), wn('DST.revenue', 'dataset'),
  ]
  const containmentEdges = [has('SRC', 'SRC.orders'), has('SRC', 'SRC.customers'), has('DST', 'DST.revenue')]
  const lineageEdges = [raw('SRC.orders', 'DST.revenue')]
  const model: LensWalkModel = {
    focusUrn: 'SRC.orders', nodes, lineageEdges, containmentEdges,
    upstreamUrns: new Set(), downstreamUrns: new Set(['DST.revenue']),
    frontierUp: [], frontierDown: [], truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
  }
  const layers: ViewLayerConfig[] = [
    { id: 'src', name: 'Source', order: 0, entityTypes: [], anchorUrn: 'SRC' },
    { id: 'dst', name: 'Target', order: 1, entityTypes: [], anchorUrn: 'DST' },
  ]
  const assignments = { SRC: { layerId: 'src' }, DST: { layerId: 'dst' } }
  return { model, layers, assignments }
}

/**
 * An anchored view where every card has its own lineage story: what each
 * card's lineage ports must say on open.
 *
 *   SRC ⊃ {raw_orders, DB_A ⊃ {DB_A.t1}, DB_B ⊃ {DB_B.t2}, quiet}   ← column "Source"
 *   STG ⊃ {s1, s2, s9}             ← column "Staging"; s9 is not loaded
 *   REP ⊃ {dash, rpt, uncounted}   ← column "Report"
 *   far                            ← held by nothing in the view
 *
 * The lineage (a test adds it to the store, and serves the DB_A cell as a
 * roll-up): raw_orders → s1; raw_orders → STG (another column's anchor);
 * DB_A ⇒ s2 (a roll-up cell); s2 → s9; DB_B.t2 → rpt; far → dash.
 */
export function anchoredPortsEstate() {
  const nodes = [
    wn('SRC', 'dataPlatform', 4), wn('SRC.raw_orders', 'dataset'),
    wn('SRC.DB_A', 'container', 1), wn('SRC.DB_A.t1', 'dataset'),
    wn('SRC.DB_B', 'container', 1), wn('SRC.DB_B.t2', 'dataset'),
    wn('SRC.quiet', 'dataset'),
    wn('STG', 'dataPlatform', 3), wn('s1', 'dataset'), wn('s2', 'dataset'), wn('s9', 'dataset'),
    wn('REP', 'dataPlatform', 3), wn('dash', 'dataset'), wn('rpt', 'dataset'), wn('uncounted', 'dataset'),
    wn('far', 'dataset'),
  ]
  const containmentEdges = [
    has('SRC', 'SRC.raw_orders'), has('SRC', 'SRC.DB_A'), has('SRC.DB_A', 'SRC.DB_A.t1'),
    has('SRC', 'SRC.DB_B'), has('SRC.DB_B', 'SRC.DB_B.t2'), has('SRC', 'SRC.quiet'),
    has('STG', 's1'), has('STG', 's2'), has('STG', 's9'),
    has('REP', 'dash'), has('REP', 'rpt'), has('REP', 'uncounted'),
  ]
  const model: LensWalkModel = {
    focusUrn: 'SRC.raw_orders', nodes, lineageEdges: [], containmentEdges,
    upstreamUrns: new Set(), downstreamUrns: new Set(),
    frontierUp: [], frontierDown: [], truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
  }
  const layers: ViewLayerConfig[] = [
    { id: 'src', name: 'Source', order: 0, entityTypes: [], anchorUrn: 'SRC' },
    { id: 'stg', name: 'Staging', order: 1, entityTypes: [], anchorUrn: 'STG' },
    { id: 'rep', name: 'Report', order: 2, entityTypes: [], anchorUrn: 'REP' },
  ]
  const assignments = { SRC: { layerId: 'src' }, STG: { layerId: 'stg' }, REP: { layerId: 'rep' } }
  return { model, layers, assignments }
}

/**
 * A container drawn across three columns:
 *
 *   P ⊃ {P.c1, P.C, A}   P in "Left", P.c1 with it
 *   P.C                  placed in "Right", beside R
 *   A ⊃ {A.a1}           the anchor of "Anchored": nested under P
 */
export function splitChildEstate() {
  const nodes = [
    wn('P', 'container', 3), wn('P.c1', 'dataset'), wn('P.C', 'dataset'),
    wn('A', 'container', 1), wn('A.a1', 'dataset'), wn('R', 'dataset'),
  ]
  const containmentEdges = [has('P', 'P.c1'), has('P', 'P.C'), has('P', 'A'), has('A', 'A.a1')]
  const model: LensWalkModel = {
    focusUrn: 'R', nodes, lineageEdges: [], containmentEdges,
    upstreamUrns: new Set(), downstreamUrns: new Set(),
    frontierUp: [], frontierDown: [], truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
  }
  const layers: ViewLayerConfig[] = [
    { id: 'left', name: 'Left', order: 0, entityTypes: [] },
    { id: 'right', name: 'Right', order: 1, entityTypes: [] },
    { id: 'anch', name: 'Anchored', order: 2, entityTypes: [], anchorUrn: 'A' },
  ]
  const assignments = { P: { layerId: 'left' }, 'P.C': { layerId: 'right' }, R: { layerId: 'right' }, A: { layerId: 'anch' } }
  return { model, layers, assignments }
}

/**
 * A curated column holding a view-only group:
 *
 *   Group ⊃ {g.a, g.b}   a logical group in "Left"
 *   solo                 beside it
 */
export function groupedEstate() {
  const nodes = [wn('g.a', 'dataset'), wn('g.b', 'dataset'), wn('solo', 'dataset')]
  const model: LensWalkModel = {
    focusUrn: 'solo', nodes, lineageEdges: [], containmentEdges: [],
    upstreamUrns: new Set(), downstreamUrns: new Set(),
    frontierUp: [], frontierDown: [], truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
  }
  const layers: ViewLayerConfig[] = [
    { id: 'left', name: 'Left', order: 0, entityTypes: [], logicalNodes: [{ id: 'grp', name: 'Group', type: 'group' }] },
  ]
  const assignments = {
    'g.a': { layerId: 'left', logicalNodeId: 'grp' },
    'g.b': { layerId: 'left', logicalNodeId: 'grp' },
    solo: { layerId: 'left' },
  }
  return { model, layers, assignments }
}

/**
 * A curated column holding a view-only group, beside an anchored column:
 *
 *   Group ⊃ {g.a, g.c}   a logical group in "Left"; g.c ⊃ {g.c.t}
 *   solo                 beside it
 *   STG ⊃ {s1, s2, s9}   the anchor of "Staging"
 *   far                  in no column
 */
export function groupAndAnchorEstate() {
  const nodes = [
    wn('g.a', 'dataset'), wn('g.c', 'container', 1), wn('g.c.t', 'dataset'), wn('solo', 'dataset'),
    wn('STG', 'dataPlatform', 3), wn('s1', 'dataset'), wn('s2', 'dataset'), wn('s9', 'dataset'),
    wn('far', 'dataset'),
  ]
  const containmentEdges = [has('g.c', 'g.c.t'), has('STG', 's1'), has('STG', 's2'), has('STG', 's9')]
  const model: LensWalkModel = {
    focusUrn: 'solo', nodes, lineageEdges: [], containmentEdges,
    upstreamUrns: new Set(), downstreamUrns: new Set(),
    frontierUp: [], frontierDown: [], truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
  }
  const layers: ViewLayerConfig[] = [
    { id: 'left', name: 'Left', order: 0, entityTypes: [], logicalNodes: [{ id: 'grp', name: 'Group', type: 'group' }] },
    { id: 'stg', name: 'Staging', order: 1, entityTypes: [], anchorUrn: 'STG' },
  ]
  const assignments = {
    'g.a': { layerId: 'left', logicalNodeId: 'grp' },
    'g.c': { layerId: 'left', logicalNodeId: 'grp' },
    solo: { layerId: 'left' },
    STG: { layerId: 'stg' },
  }
  return { model, layers, assignments }
}

/**
 * A view open to its whole data source, one column per entity type:
 *
 *   Sources   src1, src2
 *   Reports   rep1, rep2, rep9   (rep9 past the column's first page)
 *
 * and misc1, of a type no column places.
 */
export function perTypeEstate() {
  const nodes = [wn('src1', 'source'), wn('src2', 'source'), wn('rep1', 'report'), wn('rep2', 'report'), wn('rep9', 'report'),
    wn('misc1', 'misc')]
  const model: LensWalkModel = {
    focusUrn: 'src1', nodes, lineageEdges: [], containmentEdges: [],
    upstreamUrns: new Set(), downstreamUrns: new Set(),
    frontierUp: [], frontierDown: [], truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
  }
  const layers: ViewLayerConfig[] = [
    { id: 'sources', name: 'Sources', order: 0, entityTypes: ['source'] },
    { id: 'reports', name: 'Reports', order: 1, entityTypes: ['report'] },
  ]
  return { model, layers, assignments: {} }
}
