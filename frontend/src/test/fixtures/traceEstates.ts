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
 * A DATASET focus whose flow is authored at FIELD grain — the shape that
 * produced the user's screenshot on 2026-08-21: partner datasets in the same
 * layer landing fully expanded beside a focus that is itself a dataset.
 *
 *   snowflake ⊃ INTERMEDIATE_T2 ⊃ gl_postings ⊃ {amount, cost_center}
 *   snowflake ⊃ GOLD            ⊃ fact_revenue ⊃ {amount, cost_center}
 *
 * Focus is `gl_postings` (containment depth 2). The lineage runs field to
 * field, so the raw partners are three deep — and the card that stands for
 * them must be `fact_revenue`, at the focus's own depth, CLOSED.
 */
export function fieldGrainEstate() {
  const nodes = [
    wn('snowflake', 'dataPlatform', 2),
    wn('INTERMEDIATE_T2', 'container', 1), wn('gl_postings', 'dataset', 2),
    wn('gl_postings.amount', 'schemaField'), wn('gl_postings.cost_center', 'schemaField'),
    wn('GOLD', 'container', 1), wn('fact_revenue', 'dataset', 2),
    wn('fact_revenue.amount', 'schemaField'), wn('fact_revenue.cost_center', 'schemaField'),
  ]
  const containmentEdges = [
    has('snowflake', 'INTERMEDIATE_T2'), has('INTERMEDIATE_T2', 'gl_postings'),
    has('gl_postings', 'gl_postings.amount'), has('gl_postings', 'gl_postings.cost_center'),
    has('snowflake', 'GOLD'), has('GOLD', 'fact_revenue'),
    has('fact_revenue', 'fact_revenue.amount'), has('fact_revenue', 'fact_revenue.cost_center'),
  ]
  const lineageEdges = [
    raw('gl_postings.amount', 'fact_revenue.amount'),
    raw('gl_postings.cost_center', 'fact_revenue.cost_center'),
  ]
  const model: LensWalkModel = {
    focusUrn: 'gl_postings', nodes, lineageEdges, containmentEdges,
    upstreamUrns: new Set(),
    downstreamUrns: new Set(['fact_revenue.amount', 'fact_revenue.cost_center']),
    frontierUp: [], frontierDown: [], truncated: false, truncationReason: null,
    seedTruncated: false, seedCursor: null,
  }
  const layers: ViewLayerConfig[] = [
    { id: 'curated', name: 'Curated', order: 0, entityTypes: ['container'] },
  ]
  return {
    model, layers,
    assignments: { INTERMEDIATE_T2: { layerId: 'curated' }, GOLD: { layerId: 'curated' } },
  }
}

/**
 * A DEEP, MIXED-TYPE chain — `Data Domain > Application > Container >
 * Container > Database > Table > Column` — with the flow authored at COLUMN
 * grain between two sibling chains.
 *
 * The partner-grain rule is type-agnostic on purpose: it reads containment
 * DEPTH, never the ontology, because an ontology that repeats a type at two
 * depths (Container inside Container, here) has no level to appeal to. This
 * estate is what proves that — trace at depth 4 and the partner card is at
 * depth 4; trace at column grain and the partner columns are the cards, with
 * their tables and databases open as hosts.
 */
export function deepChainEstate() {
  const types = ['domain', 'application', 'container', 'container', 'database', 'table', 'column']
  const nodes: LensWalkNode[] = []
  const containmentEdges: Array<{ sourceUrn: string; targetUrn: string }> = []
  for (const side of ['x', 'y']) {
    let parent: string | null = null
    types.forEach((type, depth) => {
      const urn = `${side}${depth}`
      nodes.push(wn(urn, type, depth < types.length - 1 ? 1 : 0))
      if (parent) containmentEdges.push(has(parent, urn))
      parent = urn
    })
  }
  const leaf = types.length - 1
  const lineageEdges = [raw(`x${leaf}`, `y${leaf}`)]
  const model: LensWalkModel = {
    focusUrn: 'x4', nodes, lineageEdges, containmentEdges,
    upstreamUrns: new Set(), downstreamUrns: new Set([`y${leaf}`]),
    frontierUp: [], frontierDown: [], truncated: false, truncationReason: null,
    seedTruncated: false, seedCursor: null,
  }
  const layers: ViewLayerConfig[] = [{ id: 'all', name: 'All', order: 0, entityTypes: ['domain'] }]
  return { model, layers, assignments: { x0: { layerId: 'all' }, y0: { layerId: 'all' } } }
}

/**
 * THE ANCESTOR ESTATE — the shape behind the user's report on 2026-08-21:
 * "trace on a table keeps going and going across every ancestor; it opens
 * lineage for the database this table belongs to, the application, the data
 * domain."
 *
 *   D ⊃ A ⊃ DB ⊃ T ⊃ c        (and the mirror side D' ⊃ A' ⊃ DB' ⊃ T' ⊃ c')
 *
 * Flow is authored at EVERY grain, which is what rollups are: `c→c'` raw,
 * and `T→T'`, `DB→DB'`, `A→A'`, `D→D'` as summaries of that one column hop,
 * one per containment-level PAIR. The table also carries the CROSS-LEVEL
 * rollups a real estate materialises — `T→DB'`, `T→A'`, `T→D'` — and those
 * are the ones that used to drag the world in: each far endpoint summarises
 * every table beneath it, so following it answers a question nobody asked.
 *
 * `model()` is what the fixed closure ships for T. `poisonedModel()` is what
 * the OLD one shipped — ancestor-grain partners AND the focus's own D/A/DB
 * marked upstream — kept so the view model's own guard has something to
 * refuse.
 */
export function ancestorRollupEstate() {
  const chain = ['D', 'A', 'DB', 'T', 'c']
  const types = ['domain', 'application', 'database', 'table', 'column']
  const nodes: LensWalkNode[] = []
  const containmentEdges: Array<{ sourceUrn: string; targetUrn: string }> = []
  for (const side of ['', "'"]) {
    chain.forEach((name, depth) => {
      nodes.push(wn(`${name}${side}`, types[depth], depth < chain.length - 1 ? 1 : 0))
      if (depth > 0) containmentEdges.push(has(`${chain[depth - 1]}${side}`, `${name}${side}`))
    })
  }
  const layers: ViewLayerConfig[] = [{ id: 'all', name: 'All', order: 0, entityTypes: ['domain'] }]
  const assignments = { D: { layerId: 'all' }, "D'": { layerId: 'all' } }

  const base = {
    focusUrn: 'T', nodes, containmentEdges,
    frontierUp: [], frontierDown: [], truncated: false, truncationReason: null,
    seedTruncated: false, seedCursor: null,
  }
  // What the closure ships now: the raw hop, plus the ONE rollup whose far
  // endpoint stands at the focus's own grain.
  const model: LensWalkModel = {
    ...base,
    lineageEdges: [raw('c', "c'"), roll('T', "T'", 2)],
    upstreamUrns: new Set(),
    downstreamUrns: new Set(["c'", "T'"]),
  }
  // What it used to ship: three uphill rollups whose partners summarise the
  // estate, and — via the frontier walking back down them — the focus's OWN
  // database, application and domain marked as things on this lineage.
  const poisonedModel: LensWalkModel = {
    ...base,
    lineageEdges: [
      raw('c', "c'"), roll('T', "T'", 2),
      roll('T', "DB'", 90), roll('T', "A'", 400), roll('T', "D'", 900),
      roll('DB', "DB'", 90), roll('A', "A'", 400), roll('D', "D'", 900),
    ],
    upstreamUrns: new Set(['DB', 'A', 'D']),
    downstreamUrns: new Set(["c'", "T'", "DB'", "A'", "D'"]),
  }
  return { model, poisonedModel, layers, assignments }
}
