/**
 * Fixtures for the visual harness. Each one reproduces a real reported
 * shape, so a screenshot is a diagnosis rather than a demo.
 *
 * TWO FAMILIES, because the lens is mid-rebuild:
 *  • `FIXTURES` — neighbour-record shapes for the OLD builder
 *    (`buildFocusGraph`). Untouched.
 *  • `WALK_FIXTURES` — accumulated walk models for the new one
 *    (`buildLensSubgraph` → `buildFocusLayout`). These are literally
 *    what a sequence of `/trace/closure` responses merges into, so what
 *    the screenshot shows is what the server can actually produce.
 */
import type { LineageEdge, LineageNode } from '@/store/canvas'
import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'
import type { LensFrontierEntry } from '@/components/canvas/context-view/lens/lens-subgraph'
import type { LensRoster, LensViewState } from '@/components/canvas/context-view/lens/focus-layout'

const node = (id: string, type = 'dataset', label = id): LineageNode => ({
  id, type: 'generic',
  position: { x: 0, y: 0 },
  data: { label, urn: id, type },
} as unknown as LineageNode)

const edge = (id: string, source: string, target: string, edgeType = 'DERIVES_FROM'): LineageEdge => ({
  id, source, target, data: { edgeType },
} as unknown as LineageEdge)

const contains = (id: string, source: string, target: string): LineageEdge =>
  edge(id, source, target, 'CONTAINS')

export interface Fixture {
  title: string
  focal: string
  nodes: LineageNode[]
  edges: LineageEdge[]
  isCoarser?: (t: string | undefined, base: string) => boolean
  canContain?: (t: string | undefined) => boolean
  over?: Record<string, unknown>
}

const COARSE = new Set(['CONTAINER', 'DATAPLATFORM', 'DATADOMAIN', 'dataset'])
const isCoarser = (t: string | undefined) => COARSE.has(t ?? '')
const canContain = (t: string | undefined) => t !== 'schemaField'

/**
 * The reported shape: a column focal, its own table upstream, EIGHT of
 * that table's columns also upstream, and the same connections restated
 * at container / platform / dataset grain. This is the picture that
 * rendered as one table card plus eight loose columns each captioned
 * `int_clean_order…`.
 */
const columns = (): Fixture => {
  const nodes = [
    node('F', 'schemaField', 'net_revenue'),
    node('T1', 'dataset', 'int_clean_orders_t1'),
    node('T2', 'dataset', 'int_clean_orders_t2'),
    node('CTR', 'CONTAINER', 'INTERMEDIATE_T1'),
    node('PLAT', 'DATAPLATFORM', 'Snowflake'),
    node('OUT', 'dataset', 'fact_orders'),
  ]
  const edges = [
    contains('k-plat', 'PLAT', 'CTR'),
    contains('k-ctr1', 'CTR', 'T1'),
    contains('k-ctr2', 'CTR', 'T2'),
    contains('k-f', 'T2', 'F'),
    // The focal's own table, and the coarser restatements of the same fact.
    edge('u-t1', 'T1', 'F'),
    edge('u-ctr', 'CTR', 'F'),
    edge('u-plat', 'PLAT', 'F'),
  ]
  const cols = ['subtotal', 'discount', 'tax_amt', 'shipping', 'gross_revenue', 'refund_amt', 'fx_rate', 'net_revenue']
  cols.forEach((c, i) => {
    nodes.push(node(`c${i}`, 'schemaField', c))
    edges.push(contains(`k-c${i}`, 'T1', `c${i}`))
    edges.push(edge(`u-c${i}`, `c${i}`, 'F'))
  })
  // Downstream: nine columns of one consumer table.
  nodes.push(node('OUT', 'dataset', 'fact_orders'))
  const outCols = ['order_id', 'net_revenue', 'net_revenue_usd', 'margin', 'margin_pct', 'is_refunded']
  outCols.forEach((c, i) => {
    nodes.push(node(`d${i}`, 'schemaField', c))
    edges.push(contains(`k-d${i}`, 'OUT', `d${i}`))
    edges.push(edge(`d-e${i}`, 'F', `d${i}`))
  })
  return { title: 'Column focal, table upstream, columns both sides', focal: 'F', nodes, edges, isCoarser, canContain }
}

/** A six-level chain, to check the breadcrumb rather than nesting. */
const deep = (): Fixture => {
  const nodes = [
    node('DOM', 'DATADOMAIN', 'Sales'),
    node('PLAT', 'DATAPLATFORM', 'Snowflake'),
    node('APP', 'CONTAINER', 'OrderApp'),
    node('DB', 'CONTAINER', 'PROD'),
    node('T', 'dataset', 'fact_orders'),
    node('F', 'schemaField', 'net_revenue'),
    node('SRC', 'dataset', 'stg_orders_v2_final'),
  ]
  const edges = [
    contains('a', 'DOM', 'PLAT'), contains('b', 'PLAT', 'APP'),
    contains('c', 'APP', 'DB'), contains('d', 'DB', 'T'), contains('e', 'T', 'F'),
    edge('u', 'SRC', 'F'),
  ]
  const cols = ['revenue_raw', 'currency', 'rate']
  cols.forEach((c, i) => {
    nodes.push(node(`s${i}`, 'schemaField', c))
    edges.push(contains(`ks${i}`, 'SRC', `s${i}`))
    edges.push(edge(`us${i}`, `s${i}`, 'F'))
  })
  return { title: 'Six-level hierarchy', focal: 'F', nodes, edges, isCoarser, canContain }
}

/** A wide table, to check the frame pages instead of growing. */
const wide = (): Fixture => {
  const nodes = [node('F', 'schemaField', 'net_revenue'), node('T', 'dataset', 'wide_source_table')]
  const edges: LineageEdge[] = []
  for (let i = 0; i < 40; i++) {
    nodes.push(node(`w${i}`, 'schemaField', `column_${String(i).padStart(2, '0')}_value`))
    edges.push(contains(`kw${i}`, 'T', `w${i}`))
    edges.push(edge(`ew${i}`, `w${i}`, 'F'))
  }
  return { title: '40-column upstream table', focal: 'F', nodes, edges, isCoarser, canContain }
}

/** The tiny answer that used to float in an ocean of dots. */
const small = (): Fixture => ({
  title: 'Three cards',
  focal: 'F',
  nodes: [
    node('F', 'schemaField', 'product_id'),
    node('T', 'dataset', 'int_clean_products_t2'),
    node('U', 'schemaField', 'product_id'),
    node('UT', 'dataset', 'int_clean_products_t1'),
    node('D', 'schemaField', 'product_key'),
    node('DT', 'dataset', 'dim_product'),
    node('D2', 'schemaField', 'product_id'),
  ],
  edges: [
    contains('k1', 'T', 'F'), contains('k2', 'UT', 'U'),
    contains('k3', 'DT', 'D'), contains('k4', 'DT', 'D2'),
    edge('u', 'U', 'F'), edge('d1', 'F', 'D'), edge('d2', 'F', 'D2'),
  ],
  isCoarser,
  canContain,
})

/**
 * The reported estate: seven levels with `Container` REPEATED, focal on
 * a table. `Data Domain > Application > Container > Container >
 * Database > Table > Column` — the shape no type→level map can
 * describe, which is why opening the Domain used to report "nothing
 * connects" about lineage that plainly exists.
 */
const collaterals = (): Fixture => {
  const nodes = [
    node('DOM', 'DATADOMAIN', 'Finance'),
    node('APP', 'APPLICATION', 'RiskApp'),
    node('CTR1', 'CONTAINER', 'PROD'),
    node('CTR2', 'CONTAINER', 'CURATED'),
    node('DB', 'DATABASE', 'RISK_DB'),
    node('F', 'dataset', 'collaterals'),
    node('FT', 'dataset', 'fin_marts'),
  ]
  const edges = [
    contains('k1', 'DOM', 'APP'), contains('k2', 'APP', 'CTR1'),
    contains('k3', 'CTR1', 'CTR2'), contains('k4', 'CTR2', 'DB'),
    contains('k5', 'FT', 'F'),
    // All the focal itself sees is a Data Domain rollup.
    edge('u', 'DOM', 'F', 'DERIVES_FROM'),
  ]
  // ...which resolves, five containment steps down, to real tables.
  const upstream = ['loan_positions', 'collateral_valuations', 'fx_rates']
  upstream.forEach((label, i) => {
    nodes.push(node(`t${i}`, 'dataset', label))
    edges.push(contains(`kt${i}`, 'DB', `t${i}`))
  })
  return {
    title: 'Seven levels, Container repeated',
    focal: 'F',
    nodes,
    edges,
    isCoarser: (t?: string) => t !== 'dataset' && t !== 'schemaField',
    canContain: (t?: string) => t !== 'schemaField',
    over: {
      containerResults: new Map([['in:DOM', {
        nodes: upstream.map((label, i) => node(`t${i}`, 'dataset', label)),
        edges: upstream.map((_, i) => edge(`r${i}`, `t${i}`, 'F')),
        passedThrough: [
          node('APP', 'APPLICATION', 'RiskApp'),
          node('CTR1', 'CONTAINER', 'PROD'),
          node('CTR2', 'CONTAINER', 'CURATED'),
          node('DB', 'DATABASE', 'RISK_DB'),
        ],
        truncated: false, empty: false,
      }]]),
      containerStatus: new Map([['in:DOM', 'done' as const]]),
    },
  }
}

export const FIXTURES: Record<string, Fixture> = {
  collaterals: collaterals(),
  columns: columns(),
  deep: deep(),
  wide: wide(),
  small: small(),
}

// ── Walk-model fixtures (focus-layout.ts) ────────────────────────────

const wnode = (
  urn: string,
  type = 'dataset',
  label = urn,
  extra: Record<string, unknown> = {},
): LensWalkNode => ({
  id: urn,
  type: 'generic',
  position: { x: 0, y: 0 },
  data: { urn, label, type, ...extra },
  urn,
  displayName: label,
  entityType: type,
}) as unknown as LensWalkNode

/** A lineage hop. Direction is verbatim: source flows INTO target. */
const hop = (source: string, target: string, edgeType = 'DERIVES_FROM') =>
  ({ id: `h:${source}>${target}`, sourceUrn: source, targetUrn: target, edgeType })

const holds = (parent: string, child: string) => ({ sourceUrn: parent, targetUrn: child })

const frontier = (urn: string, totalCount: number | null, nextCursor: string | null = null): LensFrontierEntry =>
  ({ urn, totalCount, nextCursor })

function walkModel(
  focusUrn: string,
  parts: Partial<Omit<LensWalkModel, 'focusUrn'>>,
): LensWalkModel {
  return {
    focusUrn,
    nodes: [],
    lineageEdges: [],
    containmentEdges: [],
    upstreamUrns: new Set(),
    downstreamUrns: new Set(),
    frontierUp: [],
    frontierDown: [],
    truncated: false,
    truncationReason: null,
    seedTruncated: false,
    ...parts,
  }
}

export interface WalkFixture {
  title: string
  model: LensWalkModel
  /** A few scripted clicks, so the shot shows a MID-WALK state rather
   *  than only the moment a walk lands. */
  script?: (base: LensViewState) => LensViewState
  childrenAll?: Map<string, LensRoster>
  extendStatus?: Map<string, 'loading' | 'error'>
}

const scripted = (
  base: LensViewState,
  over: { reveal?: Array<[string, number]>; expand?: string[]; showAll?: string[] },
): LensViewState => ({
  ...base,
  revealed: new Map([...base.revealed, ...(over.reveal ?? [])]),
  expandedContainment: new Set([...base.expandedContainment, ...(over.expand ?? [])]),
  frameShowAll: new Set([...base.frameShowAll, ...(over.showAll ?? [])]),
})

/**
 * The reported estate, as the walk actually returns it: seven levels
 * with Container REPEATED, and the answer five containment steps below
 * the only thing the focus can see. This is the shape that used to
 * render as one "Finance" card that opened onto nothing.
 */
const walkCollaterals = (): WalkFixture => ({
  title: 'Seven levels, Container repeated — the estate the walk resolves',
  model: walkModel('F', {
    nodes: [
      wnode('DOM', 'DATADOMAIN', 'Finance', { childCount: 4 }),
      wnode('APP', 'APPLICATION', 'RiskApp', { childCount: 2 }),
      wnode('CTR1', 'CONTAINER', 'PROD', { childCount: 3 }),
      wnode('CTR2', 'CONTAINER', 'CURATED', { childCount: 6 }),
      wnode('DB', 'DATABASE', 'RISK_DB', { childCount: 12 }),
      wnode('FT', 'dataset', 'fin_marts', { childCount: 9 }),
      wnode('F', 'dataset', 'collaterals', { description: 'Collateral positions, daily' }),
      wnode('t0', 'dataset', 'loan_positions'),
      wnode('t1', 'dataset', 'collateral_valuations'),
      wnode('t2', 'dataset', 'fx_rates'),
      wnode('OUT', 'dataset', 'risk_exposure_daily'),
    ],
    containmentEdges: [
      holds('DOM', 'APP'), holds('APP', 'CTR1'), holds('CTR1', 'CTR2'), holds('CTR2', 'DB'),
      holds('DB', 't0'), holds('DB', 't1'), holds('DB', 't2'),
      holds('FT', 'F'),
    ],
    lineageEdges: [
      hop('t0', 'F'), hop('t1', 'F'), hop('t2', 'F'), hop('F', 'OUT'),
    ],
    frontierUp: [frontier('t0', 6), frontier('t1', null)],
    frontierDown: [frontier('OUT', 14)],
  }),
  // Open the branch too, so the shot shows the whole nest AND its
  // answer: five rects deep, three tables at the bottom.
  script: base => scripted(base, { expand: ['DB'] }),
})

/** Two paths that rejoin. The rejoin node must be ONE card, and the
 *  columns must not fight over which band it belongs to. */
const walkDiamond = (): WalkFixture => ({
  title: 'A diamond — two paths, one card where they rejoin',
  model: walkModel('F', {
    nodes: [
      wnode('SRC', 'dataset', 'raw_orders'),
      wnode('F', 'dataset', 'stg_orders'),
      wnode('A', 'dataset', 'int_orders_enriched'),
      wnode('B', 'dataset', 'int_orders_refunds'),
      wnode('D', 'dataset', 'fct_orders'),
      wnode('M', 'dataset', 'mart_revenue'),
    ],
    containmentEdges: [],
    lineageEdges: [
      hop('SRC', 'F'), hop('F', 'A'), hop('F', 'B'),
      hop('A', 'D'), hop('B', 'D'), hop('D', 'M'),
    ],
    frontierUp: [frontier('SRC', 3)],
    frontierDown: [frontier('M', null)],
  }),
  script: base => scripted(base, { reveal: [['out:A', 1], ['out:B', 1], ['out:D', 1]] }),
})

/** A wide fan-in: more upstream than one page holds, so the cap has to
 *  state its exact remainder — and one of them is only half loaded, so
 *  its pill is a PAGE rather than a hop. */
const walkHub = (): WalkFixture => {
  const nodes = [
    wnode('F', 'dataset', 'dim_customer', { description: 'Conformed customer dimension' }),
    wnode('HUB', 'dataset', 'crm_contacts_all', { childCount: 240 }),
  ]
  const lineageEdges = [hop('HUB', 'F'), hop('HUB', 'F', 'JOINS')]
  for (let i = 0; i < 19; i++) {
    const urn = `s${String(i).padStart(2, '0')}`
    nodes.push(wnode(urn, 'dataset', `source_system_${String(i).padStart(2, '0')}`))
    lineageEdges.push(hop(urn, 'F'))
  }
  return {
    title: 'Nineteen upstream sources and a half-loaded hub',
    model: walkModel('F', {
      nodes,
      containmentEdges: [],
      lineageEdges,
      // The server answered part of the hub's adjacency and handed back
      // a cursor for the rest.
      frontierUp: [frontier('HUB', 240, 'eyJvZmZzZXQiOjJ9')],
    }),
  }
}

/** The pill catalogue: every state on one board, so a regression in any
 *  one of them is visible at a glance. */
const walkFrontier = (): WalkFixture => ({
  title: 'Every ⊕ state at once — reveal, page, extend, countless, in flight, failed, ended',
  model: walkModel('F', {
    nodes: [
      wnode('F', 'dataset', 'orders_enriched'),
      wnode('EXACT', 'dataset', 'has_48_more'),
      wnode('UNKNOWN', 'dataset', 'count_unknown'),
      wnode('PAGED', 'dataset', 'partially_loaded'),
      wnode('ENDED', 'dataset', 'end_of_lineage'),
      wnode('BUSY', 'dataset', 'fetching_now'),
      wnode('FAILED', 'dataset', 'fetch_failed'),
      wnode('DOWN', 'dataset', 'one_consumer'),
      wnode('MORE', 'dataset', 'not_yet_revealed'),
    ],
    containmentEdges: [],
    lineageEdges: [
      hop('EXACT', 'F'), hop('UNKNOWN', 'F'), hop('PAGED', 'F'),
      hop('ENDED', 'F'), hop('BUSY', 'F'), hop('FAILED', 'F'),
      hop('F', 'DOWN'), hop('MORE', 'ENDED'),
    ],
    frontierUp: [
      frontier('EXACT', 48),
      frontier('UNKNOWN', null),
      frontier('PAGED', 96, 'eyJvZmZzZXQiOjMwfQ=='),
      frontier('BUSY', 12),
      frontier('FAILED', 9),
      // ENDED gets NO entry at all — that is what a dead end is.
    ],
    frontierDown: [frontier('DOWN', 5)],
  }),
  extendStatus: new Map([['up:BUSY', 'loading'], ['up:FAILED', 'error']]),
})

/** Node ⊃ Node ⊃ Node ⊃ Node: one entity type at every level, which no
 *  type→level map can describe. The nesting must be real rects. */
const walkDeep = (): WalkFixture => {
  const nodes = [
    wnode('FP', 'Node', 'customer_domain', { childCount: 4 }),
    wnode('F', 'Node', 'customer_master'),
    wnode('R', 'Node', 'ingest_estate', { childCount: 2 }),
    wnode('R1', 'Node', 'landing_zone', { childCount: 1 }),
    wnode('R2', 'Node', 'raw_feeds', { childCount: 7 }),
    wnode('R3', 'Node', 'crm_extract', { childCount: 3 }),
    wnode('leafA', 'Node', 'contacts_delta'),
    wnode('leafB', 'Node', 'accounts_delta'),
  ]
  return {
    title: 'Node ⊃ Node ⊃ Node ⊃ Node — nesting with no type→level map',
    model: walkModel('F', {
      nodes,
      containmentEdges: [
        holds('FP', 'F'),
        holds('R', 'R1'), holds('R1', 'R2'), holds('R2', 'R3'),
        holds('R3', 'leafA'), holds('R3', 'leafB'),
      ],
      lineageEdges: [hop('leafA', 'F'), hop('leafB', 'F')],
      frontierUp: [frontier('leafA', 2)],
    }),
    script: base => scripted(base, { expand: ['R3'] }),
  }
}

/** The tiny answer that used to float in an ocean of dots. */
const walkSmall = (): WalkFixture => ({
  title: 'Three cards, nested in their tables',
  model: walkModel('F', {
    nodes: [
      wnode('T', 'dataset', 'int_clean_products_t2', { childCount: 18 }),
      wnode('F', 'schemaField', 'product_id'),
      wnode('UT', 'dataset', 'int_clean_products_t1', { childCount: 22 }),
      wnode('U', 'schemaField', 'product_id'),
      wnode('DT', 'dataset', 'dim_product', { childCount: 31 }),
      wnode('D', 'schemaField', 'product_key'),
    ],
    containmentEdges: [holds('T', 'F'), holds('UT', 'U'), holds('DT', 'D')],
    lineageEdges: [hop('U', 'F'), hop('F', 'D')],
    frontierUp: [frontier('U', 4)],
  }),
})

export const WALK_FIXTURES: Record<string, WalkFixture> = {
  walkCollaterals: walkCollaterals(),
  walkDiamond: walkDiamond(),
  walkHub: walkHub(),
  walkFrontier: walkFrontier(),
  walkDeep: walkDeep(),
  walkSmall: walkSmall(),
}
