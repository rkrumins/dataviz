/**
 * Fixtures for the visual harness — accumulated walk models, exactly
 * what a sequence of `/trace/closure` responses merges into. What a
 * screenshot shows is therefore what the server can actually produce.
 *
 * Each one reproduces a real reported shape, so a screenshot is a
 * diagnosis rather than a demo.
 */
import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'
import type { LensFrontierEntry } from '@/components/canvas/context-view/lens/lens-subgraph'
import type { LensDirectionFilter, LensRoster, LensViewState } from '@/components/canvas/context-view/lens/focus-layout'

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
  /** Header direction preset in effect for the shot. Defaults to 'both'. */
  directionFilter?: LensDirectionFilter
  /** Pre-selected card, so the shot also shows the path-to-focus
   *  highlight (hover isn't scriptable in a static screenshot). */
  selectedId?: string
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
    upstreamUrns: new Set(['t0', 't1', 't2']),
    downstreamUrns: new Set(['OUT']),
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
    upstreamUrns: new Set(['SRC']),
    downstreamUrns: new Set(['A', 'B', 'D', 'M']),
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
      upstreamUrns: new Set(nodes.slice(1).map(n => n.urn)),
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
    upstreamUrns: new Set(['EXACT', 'UNKNOWN', 'PAGED', 'ENDED', 'BUSY', 'FAILED', 'MORE']),
    downstreamUrns: new Set(['DOWN']),
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
      upstreamUrns: new Set(['leafA', 'leafB']),
      frontierUp: [frontier('leafA', 2)],
    }),
    script: base => scripted(base, { expand: ['R3'] }),
  }
}

/** The tiny answer that used to float in an ocean of dots. The partners
 *  sit in their tables; the focus names its own table instead of being
 *  boxed inside it. */
const walkSmall = (): WalkFixture => ({
  title: 'One column between two tables — the focus names where it lives',
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
    upstreamUrns: new Set(['U']),
    downstreamUrns: new Set(['D']),
    frontierUp: [frontier('U', 4)],
  }),
})

/** Root cause only (Impact hidden) plus a selected card, so a screenshot
 *  proves both header-control features at once: the downstream band is
 *  gone, and SRC's path to the focus is lit while nothing else is. */
const walkDirectionAndHighlight = (): WalkFixture => ({
  title: 'Root cause only, with a path-to-focus highlight on the selected source',
  model: walkModel('F', {
    nodes: [
      wnode('SRC', 'dataset', 'raw_orders'),
      wnode('F', 'dataset', 'stg_orders'),
      wnode('DOWN', 'dataset', 'mart_revenue'),
    ],
    containmentEdges: [],
    lineageEdges: [hop('SRC', 'F'), hop('F', 'DOWN')],
    upstreamUrns: new Set(['SRC']),
    downstreamUrns: new Set(['DOWN']),
  }),
  directionFilter: 'in',
  selectedId: 'SRC',
})

/**
 * THE REPORTED TOWER, from the live dev stack: the focus and its sources
 * all live in the SAME platform.
 *
 *   Snowflake ⊃ REPORTING (the focus) ⊃ {rpt_revenue ⊃ 4 columns, rpt_churn}
 *   Snowflake ⊃ GOLD ⊃ dim_customer          → upstream
 *   Snowflake ⊃ INTERMEDIATE_T2              → upstream
 *   BI ⊃ exec_dashboard                      → downstream, outside it
 *
 * Drawn with Snowflake as a frame, this was one vertical tower: focus
 * and both sources stacked inside a single box, no hop columns, wires
 * arcing back through it, and an empty upstream band whispering "no
 * upstream sources in the data source" beside the sources it was
 * drawing.
 *
 * EXPECTED: no boxes above anything — not Snowflake, not GOLD, not BI.
 * A compact REPORTING focal card reading `in Snowflake`, its two tables
 * in the contains-stack below it (one opened onto four columns), the two
 * sources as free-standing cards in the upstream column carrying `GOLD`
 * and `Snowflake`, the consumer in the downstream column carrying `BI`,
 * band headers on both sides, and every wire arriving at ONE port on the
 * focal (×3, ×2) and leaving from one (×2).
 */
const walkSharedPlatform = (): WalkFixture => ({
  title: 'The focus and its sources share a platform — columns, not a tower',
  model: walkModel('REPORTING', {
    nodes: [
      wnode('SNOW', 'PLATFORM', 'Snowflake', { childCount: 14 }),
      wnode('REPORTING', 'CONTAINER', 'REPORTING', { childCount: 9, description: 'Curated reporting layer' }),
      wnode('rpt_revenue', 'dataset', 'rpt_revenue_daily', { childCount: 12 }),
      wnode('rv_order', 'schemaField', 'order_id'),
      wnode('rv_customer', 'schemaField', 'customer_id'),
      wnode('rv_net', 'schemaField', 'net_amount'),
      wnode('rv_booked', 'schemaField', 'booked_at'),
      wnode('rpt_churn', 'dataset', 'rpt_churn_weekly', { childCount: 7 }),
      wnode('GOLD', 'CONTAINER', 'GOLD', { childCount: 6 }),
      wnode('dim_customer', 'dataset', 'dim_customer', { childCount: 22 }),
      wnode('INT_T2', 'CONTAINER', 'INTERMEDIATE_T2', { childCount: 4 }),
      wnode('BI', 'PLATFORM', 'BI', { childCount: 3 }),
      wnode('dash', 'dataset', 'exec_dashboard'),
    ],
    containmentEdges: [
      holds('SNOW', 'REPORTING'), holds('SNOW', 'GOLD'), holds('SNOW', 'INT_T2'),
      holds('REPORTING', 'rpt_revenue'), holds('REPORTING', 'rpt_churn'),
      holds('rpt_revenue', 'rv_order'), holds('rpt_revenue', 'rv_customer'),
      holds('rpt_revenue', 'rv_net'), holds('rpt_revenue', 'rv_booked'),
      holds('GOLD', 'dim_customer'),
      holds('BI', 'dash'),
    ],
    lineageEdges: [
      hop('dim_customer', 'rv_customer'), hop('dim_customer', 'rv_order'),
      hop('dim_customer', 'rpt_churn'),
      // Two relationships between the same pair — one line, weight 2, and
      // a run long enough to carry the badge that says so.
      hop('INT_T2', 'rv_net'), hop('INT_T2', 'rv_net', 'JOINS'),
      hop('rv_booked', 'dash'), hop('rpt_churn', 'dash'),
    ],
    upstreamUrns: new Set(['GOLD', 'dim_customer', 'INT_T2']),
    downstreamUrns: new Set(['BI', 'dash']),
    frontierUp: [frontier('dim_customer', 5), frontier('INT_T2', null)],
    frontierDown: [frontier('dash', 3)],
  }),
  // The drill the rebuild got right: a table opened onto the columns
  // that actually carry the lineage.
  script: base => scripted(base, { expand: ['rpt_revenue'] }),
})

/**
 * The same shape one grain down — the reported SPAGHETTI: two tables of
 * the same eight columns, in two containers of one platform, wired
 * column to column.
 *
 *   Snowflake ⊃ BRONZE ⊃ clean_charges_t2 (the focus) ⊃ 8 columns
 *   Snowflake ⊃ SILVER ⊃ clean_charges    ⊃ the same 8 columns
 *
 * Sixteen cards inside one platform frame drew sixteen crossing arcs.
 *
 * EXPECTED: no platform box and no container box. The partner TABLE is
 * the free-standing frame on the left — the grain the answer is
 * presented at — with its eight columns as rows and `in SILVER ·
 * Snowflake` beside its name. The focus is a compact card reading
 * `Snowflake › BRONZE`, its own eight columns in the contains-stack
 * below it, and the eight wires converge into the one port on its left
 * edge rather than crossing the board column by column.
 */
const walkSharedPlatformLeaf = (): WalkFixture => {
  const columns = [
    'charge_id', 'account_id', 'amount', 'currency',
    'booked_at', 'posted_at', 'status', 'source_system',
  ]
  const nodes = [
    wnode('SNOW', 'PLATFORM', 'Snowflake', { childCount: 14 }),
    wnode('BRONZE', 'CONTAINER', 'BRONZE', { childCount: 5 }),
    wnode('SILVER', 'CONTAINER', 'SILVER', { childCount: 9 }),
    wnode('F', 'dataset', 'clean_charges_t2', { childCount: 11 }),
    wnode('SRC', 'dataset', 'clean_charges', { childCount: 11 }),
  ]
  const containmentEdges = [
    holds('SNOW', 'BRONZE'), holds('SNOW', 'SILVER'),
    holds('BRONZE', 'F'), holds('SILVER', 'SRC'),
  ]
  const lineageEdges: ReturnType<typeof hop>[] = []
  for (const name of columns) {
    nodes.push(wnode(`f:${name}`, 'schemaField', name))
    nodes.push(wnode(`s:${name}`, 'schemaField', name))
    containmentEdges.push(holds('F', `f:${name}`), holds('SRC', `s:${name}`))
    lineageEdges.push(hop(`s:${name}`, `f:${name}`))
  }
  return {
    title: 'Column to column across one platform — eight parallel wires, no tower',
    model: walkModel('F', {
      nodes,
      containmentEdges,
      lineageEdges,
      upstreamUrns: new Set(['SILVER', 'SRC', ...columns.map(c => `s:${c}`)]),
      frontierUp: [frontier('s:charge_id', 2)],
    }),
    // The partner table opened to the columns that carry the lineage —
    // the picture the report was about.
    script: base => scripted(base, { expand: ['SRC'] }),
  }
}

/**
 * The same estate as `walkSharedPlatformLeaf` with SEVEN columns taken
 * away — one connected column each side.
 *
 * The focus then has exactly one populated child and ships no hop of its
 * own, which is every pass-through test the answer walk has. Seeing
 * through the FOCUS demoted it out of the picture and took the focal
 * card, the contains-stack and — because every hop reprojects onto the
 * focus — every wire with it: a board with nothing on it.
 *
 * EXPECTED: the partner table on the left as a frame with its one column
 * as a row, the compact focal reading `Snowflake › BRONZE` with its own
 * column in the contains-stack, and one wire between them.
 */
const walkSharedPlatformOneColumn = (): WalkFixture => ({
  title: 'One column each side — the focus is never chrome',
  model: walkModel('F', {
    nodes: [
      wnode('SNOW', 'PLATFORM', 'Snowflake', { childCount: 14 }),
      wnode('BRONZE', 'CONTAINER', 'BRONZE', { childCount: 5 }),
      wnode('SILVER', 'CONTAINER', 'SILVER', { childCount: 9 }),
      wnode('F', 'dataset', 'clean_charges_t2', { childCount: 11 }),
      wnode('f:charge_id', 'schemaField', 'charge_id'),
      wnode('SRC', 'dataset', 'clean_charges', { childCount: 11 }),
      wnode('s:charge_id', 'schemaField', 'charge_id'),
    ],
    containmentEdges: [
      holds('SNOW', 'BRONZE'), holds('SNOW', 'SILVER'),
      holds('BRONZE', 'F'), holds('F', 'f:charge_id'),
      holds('SILVER', 'SRC'), holds('SRC', 's:charge_id'),
    ],
    lineageEdges: [hop('s:charge_id', 'f:charge_id')],
    upstreamUrns: new Set(['SILVER', 'SRC', 's:charge_id']),
    frontierUp: [frontier('s:charge_id', 2)],
  }),
})

/**
 * THE DENSE-PILL SHAPE — the arrangement the reported "+ needs three
 * clicks" screenshots caught.
 *
 * A downstream table opened onto four columns, every one of them with
 * more lineage beyond it AND the table itself with more: a ⊕ on each row
 * at the frame's inner edge, plus the frame's own ⊕ just outside it. They
 * used to land on top of each other — a row's pill straddled the frame's
 * border, four pixels from the frame's pill, under a hover toolbar that
 * only appeared once the pointer was already on its way to that pill.
 * (The toolbar is gone: a row's actions live in the preview panel now.)
 *
 * EXPECTED: every pill fully inside its own row, a clear gutter to the
 * frame's border, and the frame's own pill separated from all of them.
 */
const walkDensePills = (): WalkFixture => {
  const columns = ['charge_id', 'amount', 'status', 'booked_at']
  const nodes = [
    wnode('F', 'dataset', 'clean_charges', { childCount: 4 }),
    wnode('T', 'dataset', 'billing_facts', { childCount: 96 }),
  ]
  const containmentEdges: ReturnType<typeof holds>[] = []
  const lineageEdges: ReturnType<typeof hop>[] = []
  for (const name of columns) {
    nodes.push(wnode(`t:${name}`, 'schemaField', name))
    containmentEdges.push(holds('T', `t:${name}`))
    lineageEdges.push(hop('F', `t:${name}`))
  }
  return {
    title: 'Dense pills — a ⊕ on every row, and one on the frame around them',
    model: walkModel('F', {
      nodes,
      containmentEdges,
      lineageEdges,
      downstreamUrns: new Set(['T', ...columns.map(c => `t:${c}`)]),
      // Each column has more beyond it, and the table has a partial
      // adjacency of its own still to page.
      frontierDown: [
        frontier('t:charge_id', 84),
        frontier('t:amount', 12),
        frontier('t:status', 7),
        frontier('t:booked_at', null),
        frontier('T', 59, 'e:41'),
      ],
    }),
  }
}

/**
 * THE RICH CHILDREN SHAPE — a sixty-child container browsed rather than
 * paged, with every row cue on one board.
 *
 *   fct_orders (the focus)
 *   billing_events ⊃ 6 columns on this lineage + 54 more inside it
 *
 * The partner frame is in "everything inside": its six connected columns
 * come first, then the quiet divider ("everything else inside — 54
 * items") and the roster rows that merely live there. It MIXES kinds
 * (columns and a view), so every row states its type; two columns carry
 * a relationship their siblings do not; two carry descriptions; one is a
 * container of its own, so it can be opened from the keyboard.
 *
 * EXPECTED: one row language throughout — the connected rows and the
 * roster rows differ in weight, not in shape. No pager anywhere: the
 * header says "showing 1–10 of 60" and a thumb sits on the frame's right
 * edge. The selected row shows the peek panel beside the frame, with its
 * flows, its unfetched remainder, and the three moves it can make.
 */
const walkChildrenRich = (): WalkFixture => {
  const connected = [
    { urn: 'b:order_id', label: 'order_id', type: 'schemaField', edge: 'DERIVES_FROM',
      extra: { description: 'Natural key from the billing system' } },
    { urn: 'b:customer_id', label: 'customer_id', type: 'schemaField', edge: 'DERIVES_FROM', extra: {} },
    { urn: 'b:net_amount', label: 'net_amount', type: 'schemaField', edge: 'JOINS',
      extra: { description: 'Charge net of refunds, in reporting currency' } },
    { urn: 'b:currency', label: 'currency', type: 'schemaField', edge: 'DERIVES_FROM', extra: {} },
    { urn: 'b:booked_at', label: 'booked_at', type: 'schemaField', edge: 'JOINS', extra: {} },
    { urn: 'b:daily_totals', label: 'daily_totals_v', type: 'view', edge: 'DERIVES_FROM',
      extra: { childCount: 3 } },
  ]
  const nodes = [
    wnode('F', 'dataset', 'fct_orders', { childCount: 24, description: 'Order grain fact table' }),
    wnode('T', 'dataset', 'billing_events', { childCount: 60 }),
    // The view row holds things, so the keyboard's "open inside" means
    // something on at least one row of this list.
    wnode('b:dt_gross', 'schemaField', 'gross_amount'),
  ]
  const containmentEdges = [holds('T', 'b:daily_totals'), holds('b:daily_totals', 'b:dt_gross')]
  const lineageEdges: ReturnType<typeof hop>[] = []
  for (const c of connected) {
    nodes.push(wnode(c.urn, c.type, c.label, c.extra))
    if (c.urn !== 'b:daily_totals') containmentEdges.push(holds('T', c.urn))
    lineageEdges.push(hop(c.urn, 'F', c.edge))
  }
  // The roster: everything else the container holds, straight off the
  // children endpoint — the half of "what is in here" lineage cannot
  // answer.
  const roster: LensRoster = {
    children: [
      ...connected.map(c => wnode(c.urn, c.type, c.label, c.extra)),
      ...Array.from({ length: 54 }, (_, i) => wnode(
        `b:other_${i}`,
        i % 9 === 0 ? 'view' : 'schemaField',
        `${['legacy', 'raw', 'audit', 'ext'][i % 4]}_field_${String(i).padStart(2, '0')}`,
        i % 7 === 0 ? { description: 'Retired with the 2024 billing migration' } : {},
      )),
    ],
    hasMore: false,
    total: 60,
  }
  return {
    title: 'Sixty children, browsed — one row language, a divider, and a peek',
    model: walkModel('F', {
      nodes,
      containmentEdges,
      lineageEdges,
      upstreamUrns: new Set(connected.map(c => c.urn)),
      frontierUp: [frontier('b:order_id', 9), frontier('b:net_amount', null)],
    }),
    script: base => scripted(base, { expand: ['T'], showAll: ['T'] }),
    childrenAll: new Map([['T', roster]]),
    selectedId: 'b:order_id',
  }
}

/**
 * THE BLANK BOARD (user, 2026-08-14 09.13–09.21), from the live dev
 * graph: focusing the SCHEMAFIELD `channel` drew nothing at all.
 *
 *   Snowflake ⊃ INTERMEDIATE_T1 ⊃ int_clean_orders_t1 ⊃ channel  ← focus
 *   Snowflake ⊃ SILVER ⊃ clean_orders ⊃ channel                  → upstream
 *   Snowflake ⊃ INTERMEDIATE_T2 ⊃ int_clean_orders_t2 ⊃ channel  → downstream
 *
 * The hops shown at CONTAINER and PLATFORM grain are what a source
 * genuinely declaring coarse-grain lineage produces: a column wired to its
 * upstream partner's table and container, and — both ways — to its own
 * containment root. The two that reach the root are what the focal's
 * "+2 connect at a coarser grain" counts.
 *
 * This shape came from the live estate's `:AGGREGATED` rollups, which the
 * engine no longer walks at all (see the closure's synthetic-edge filter).
 * The FIXTURE is kept because the LAYOUT question it pins is not about
 * where the hops came from: a hop that lands on a level this picture does
 * not draw has to be said out loud rather than dropped, and the focal must
 * never offer a walk it cannot make. Any source declaring container-grain
 * lineage of its own puts the lens right back here.
 *
 * EXPECTED: a compact `channel` focal reading `Snowflake ›
 * INTERMEDIATE_T1 › int_clean_orders_t1`, its two partner containers as
 * cards either side, and NO ⊕ on the focal — the platform's own frontier
 * of 321 is 321 pieces of the platform's inside, and the focal's extend
 * (seeded from the focus's own leaves) could never have fetched it.
 */
const walkColumnFocus = (): WalkFixture => ({
  title: 'A column whose platform is also its lineage — the board that came back empty',
  model: walkModel('f:channel', {
    nodes: [
      wnode('SNOW', 'dataPlatform', 'Snowflake', { childCount: 14 }),
      wnode('INT_T1', 'container', 'INTERMEDIATE_T1', { childCount: 6 }),
      wnode('T1', 'dataset', 'int_clean_orders_t1', { childCount: 14 }),
      wnode('f:channel', 'schemaField', 'channel'),
      wnode('SILVER', 'container', 'SILVER', { childCount: 12 }),
      wnode('src_t', 'dataset', 'clean_orders', { childCount: 14 }),
      wnode('s:channel', 'schemaField', 'channel'),
      wnode('INT_T2', 'container', 'INTERMEDIATE_T2', { childCount: 7 }),
      wnode('dst_t', 'dataset', 'int_clean_orders_t2', { childCount: 14 }),
      wnode('d:channel', 'schemaField', 'channel'),
    ],
    containmentEdges: [
      holds('SNOW', 'INT_T1'), holds('SNOW', 'SILVER'), holds('SNOW', 'INT_T2'),
      holds('INT_T1', 'T1'), holds('T1', 'f:channel'),
      holds('SILVER', 'src_t'), holds('src_t', 's:channel'),
      holds('INT_T2', 'dst_t'), holds('dst_t', 'd:channel'),
    ],
    lineageEdges: [
      hop('s:channel', 'f:channel', 'TRANSFORMS'),
      hop('src_t', 'f:channel', 'DERIVED_FROM'),
      hop('SILVER', 'f:channel', 'DERIVED_FROM'),
      // The focus's OWN root, both ways — no card can carry these.
      hop('SNOW', 'f:channel', 'DERIVED_FROM'),
      hop('f:channel', 'SNOW', 'DERIVED_FROM'),
      hop('f:channel', 'd:channel', 'TRANSFORMS'),
      hop('f:channel', 'dst_t', 'DERIVED_FROM'),
      hop('f:channel', 'INT_T2', 'DERIVED_FROM'),
    ],
    upstreamUrns: new Set(['SILVER', 'src_t', 's:channel', 'SNOW']),
    downstreamUrns: new Set(['INT_T2', 'dst_t', 'd:channel']),
    frontierUp: [frontier('SNOW', 321)],
    frontierDown: [frontier('d:channel', 5), frontier('INT_T2', 57), frontier('dst_t', 15)],
  }),
})

/**
 * THE CONTAINER BOUNDARY (user, 2026-08-14 09.13): focusing the platform
 * Snowflake offered "+211" upstream; the click fetched, drew nothing, and
 * the badge grew to +384 while the rows re-ordered under it.
 *
 * The live closure for that focus: 567 nodes, 2,426 hops, `upstreamUrns`
 * EMPTY — every hop interior — and 51 frontier entries, every one on a
 * node inside the platform. This is that estate in miniature, including
 * a hop from an interior table to the platform itself.
 *
 * Most of that volume was `:AGGREGATED` rollups, which the engine no
 * longer walks. The boundary question survives them: a container focus
 * whose members feed each other reads the same way at any volume, and one
 * interior hop states it as well as two thousand.
 *
 * EXPECTED: no upstream ⊕ on the focal and no "+" on its upstream Reach
 * — the platform's own inside is not its lineage — while the genuine
 * downstream consumer outside it keeps both.
 */
const walkPlatformFocus = (): WalkFixture => ({
  title: 'A platform focus — its own inside is not its lineage',
  model: walkModel('SNOW', {
    nodes: [
      wnode('SNOW', 'dataPlatform', 'Snowflake', { childCount: 14 }),
      wnode('BRONZE', 'container', 'BRONZE', { childCount: 5 }),
      wnode('SILVER', 'container', 'SILVER', { childCount: 12 }),
      wnode('INT_T2', 'container', 'INTERMEDIATE_T2', { childCount: 7 }),
      wnode('raw_t', 'dataset', 'raw_orders', { childCount: 9 }),
      wnode('src_t', 'dataset', 'clean_orders', { childCount: 14 }),
      wnode('dst_t', 'dataset', 'int_clean_orders_t2', { childCount: 14 }),
      wnode('BI', 'dataPlatform', 'Tableau', { childCount: 4 }),
      wnode('dash', 'dataset', 'revenue_by_channel'),
    ],
    containmentEdges: [
      holds('SNOW', 'BRONZE'), holds('SNOW', 'SILVER'), holds('SNOW', 'INT_T2'),
      holds('BRONZE', 'raw_t'), holds('SILVER', 'src_t'), holds('INT_T2', 'dst_t'),
      holds('BI', 'dash'),
    ],
    lineageEdges: [
      hop('raw_t', 'src_t', 'TRANSFORMS'),
      hop('BRONZE', 'SILVER', 'DERIVED_FROM'),
      hop('src_t', 'dst_t', 'TRANSFORMS'),
      hop('SILVER', 'dst_t', 'DERIVED_FROM'),
      // A hop onto the platform itself — 321 of these are what "+211" was
      // counting.
      hop('src_t', 'SNOW', 'DERIVED_FROM'),
      hop('dst_t', 'dash', 'TRANSFORMS'),
    ],
    upstreamUrns: new Set(),
    downstreamUrns: new Set(['BI', 'dash']),
    frontierUp: [frontier('SNOW', 321), frontier('src_t', 96), frontier('dst_t', 115), frontier('SILVER', 57)],
    frontierDown: [frontier('dash', 4)],
  }),
})

/**
 * THE GOLD ESTATE (user, 2026-08-14) — the shape the FLATTEN was locked
 * for, and the reproduction of both defects it fixes.
 *
 *   Snowflake ⊃ SILVER ⊃ stg_orders                    ← the focus
 *   Snowflake ⊃ GOLD (8 tables, 7 of them on this lineage):
 *       fact_orders, dim_customer          hop 1
 *       agg_daily_sales, fact_returns,
 *       dim_product, fact_shipments        hop 2
 *       dim_date                           hop 3
 *   Tableau ⊃ exec_dashboard               hop 3
 *
 * BEFORE (frames): GOLD was one box holding all seven tables as rows.
 * Every flow between two of them — the ordinary business of a warehouse
 * layer — left the box and arced back into it, and because a frame sits
 * in the column of whichever member is nearest the focus, hop 2 and hop 3
 * were pinned into the hop-1 band. Two same-hop peers (`fact_orders →
 * dim_customer`) were stamped with a LOOP badge by the old `≤` hop rule,
 * beside the genuine loop (`agg_daily_sales ⇄ fact_returns`) with no way
 * to tell them apart.
 *
 * AFTER (flat): GOLD is one ROLLUP card — "7 on this lineage · of 8" —
 * with `feeds itself ×9` for the wires among its hidden members. The
 * script drills it, and the seven land as free-standing cards in the
 * columns their own hops dictate, each reading `in GOLD · Snowflake`,
 * with the peer flows as ordinary node→node wires. Only the true loop
 * carries a badge.
 */
const walkFlatPeers = (): WalkFixture => ({
  title: 'GOLD, drilled — seven tables, their peer flows, and one true loop',
  model: walkModel('F', {
    nodes: [
      wnode('SNOW', 'dataPlatform', 'Snowflake', { childCount: 14 }),
      wnode('SILVER', 'container', 'SILVER', { childCount: 9 }),
      wnode('F', 'dataset', 'stg_orders', { childCount: 12, description: 'Landed order events, deduplicated' }),
      wnode('GOLD', 'container', 'GOLD', { childCount: 8 }),
      wnode('fact_orders', 'dataset', 'fact_orders', { childCount: 14 }),
      wnode('dim_customer', 'dataset', 'dim_customer', { childCount: 22 }),
      wnode('agg_daily', 'dataset', 'agg_daily_sales', { childCount: 6 }),
      wnode('fact_returns', 'dataset', 'fact_returns', { childCount: 11 }),
      wnode('dim_product', 'dataset', 'dim_product', { childCount: 18 }),
      wnode('fact_ship', 'dataset', 'fact_shipments', { childCount: 9 }),
      wnode('dim_date', 'dataset', 'dim_date', { childCount: 5 }),
      wnode('BI', 'dataPlatform', 'Tableau', { childCount: 3 }),
      wnode('dash', 'dataset', 'exec_dashboard', { childCount: 7 }),
    ],
    containmentEdges: [
      holds('SNOW', 'SILVER'), holds('SNOW', 'GOLD'), holds('SILVER', 'F'),
      holds('GOLD', 'fact_orders'), holds('GOLD', 'dim_customer'), holds('GOLD', 'agg_daily'),
      holds('GOLD', 'fact_returns'), holds('GOLD', 'dim_product'), holds('GOLD', 'fact_ship'),
      holds('GOLD', 'dim_date'),
      holds('BI', 'dash'),
    ],
    lineageEdges: [
      hop('F', 'fact_orders', 'TRANSFORMS'),
      hop('F', 'dim_customer', 'TRANSFORMS'),
      // A PEER FLOW between two tables at the SAME hop. One way. The old
      // `≤` rule stamped it as a loop; it is not one.
      hop('fact_orders', 'dim_customer', 'JOINS'),
      hop('fact_orders', 'agg_daily'),
      hop('dim_customer', 'agg_daily'),
      hop('fact_orders', 'fact_returns'),
      hop('fact_orders', 'dim_product'),
      hop('fact_orders', 'fact_ship'),
      // A GENUINE loop: two tables at the same hop feeding each other.
      hop('agg_daily', 'fact_returns', 'JOINS'),
      hop('fact_returns', 'agg_daily', 'JOINS'),
      hop('dim_product', 'dim_date'),
      hop('agg_daily', 'dash', 'TRANSFORMS'),
    ],
    upstreamUrns: new Set(),
    downstreamUrns: new Set([
      'GOLD', 'fact_orders', 'dim_customer', 'agg_daily', 'fact_returns',
      'dim_product', 'fact_ship', 'dim_date', 'BI', 'dash',
    ]),
    frontierDown: [frontier('dash', 4), frontier('dim_date', null)],
  }),
  // The walk a reader actually makes: the focus's own page, then the ⊕
  // on the tables it lands on, hop by hop. Then the rollup, drilled —
  // the gesture R2 is about.
  script: base => scripted(base, {
    reveal: [['out:fact_orders', 1], ['out:agg_daily', 1], ['out:dim_product', 1]],
    expand: ['GOLD'],
  }),
})

/** The SAME walk, one click earlier: GOLD undrilled. One rollup card
 *  saying "7 on this lineage · of 8", carrying the frontier of everything
 *  it hides and the `feeds itself ×9` badge for the nine flows among its
 *  members. This and `walkFlatPeers` are the before/after of R2. */
const walkFlatRollup = (): WalkFixture => ({
  ...walkFlatPeers(),
  title: 'The same estate, undrilled — GOLD as one rollup that feeds itself',
  script: base => scripted(base, {
    reveal: [['out:fact_orders', 1], ['out:agg_daily', 1], ['out:dim_product', 1]],
  }),
})

/**
 * ONE NODE, SEVENTY WIRES — the density shape (user screenshot 11.06.20,
 * "handle 100s of incoming/outgoing edges").
 *
 * `hub_events` has 40 upstream sources and 30 downstream consumers, every
 * one of them a table of its own. Both of its sides are past the port
 * budget, so both bundle into trunks carrying their summed weight; the
 * per-wire detail is reached by isolating the hub (hover or click), which
 * un-bundles its cone.
 *
 * EXPECTED: two trunks, not two black wedges. Every source and consumer
 * spreads its own single wire across the hub's edge; the sources' column
 * and the consumers' column are ordered so nothing crosses; no stub
 * arrowheads anywhere.
 */
const walkDense = (): WalkFixture => {
  const nodes = [wnode('F', 'dataset', 'hub_events', { childCount: 31, description: 'Every event, before it is split' })]
  const lineageEdges: ReturnType<typeof hop>[] = []
  for (let i = 0; i < 40; i++) {
    const urn = `up${String(i).padStart(2, '0')}`
    nodes.push(wnode(urn, 'dataset', `src_${String(i).padStart(2, '0')}_feed`, { childCount: 4 }))
    lineageEdges.push(hop(urn, 'F'))
  }
  for (let i = 0; i < 30; i++) {
    const urn = `dn${String(i).padStart(2, '0')}`
    nodes.push(wnode(urn, 'dataset', `mart_${String(i).padStart(2, '0')}`, { childCount: 6 }))
    lineageEdges.push(hop('F', urn))
  }
  return {
    title: 'Forty in, thirty out — one node, two trunks',
    model: walkModel('F', {
      nodes,
      containmentEdges: [],
      lineageEdges,
      upstreamUrns: new Set(nodes.slice(1, 41).map(n => n.urn)),
      downstreamUrns: new Set(nodes.slice(41).map(n => n.urn)),
      frontierUp: [frontier('up00', 12)],
    }),
    // Reveal enough pages that every one of the seventy is on the board —
    // a bundle of twelve is not the shape this fixture is about.
    script: base => scripted(base, { reveal: [['in:F', 4], ['out:F', 3]] }),
  }
}

/** The same board MID-ISOLATION: the hub is selected, so its cone is lit
 *  and un-bundled while everything else sits at the dim floor. Hover
 *  cannot be scripted into a still, and a selection takes the identical
 *  path through the view (see `coneSourceId`). */
const walkDenseIsolated = (): WalkFixture => ({
  ...walkDense(),
  title: 'The same hub, isolated — its cone un-bundles, the rest goes quiet',
  selectedId: 'up00',
})

export const WALK_FIXTURES: Record<string, WalkFixture> = {
  walkCollaterals: walkCollaterals(),
  walkDiamond: walkDiamond(),
  walkHub: walkHub(),
  walkFrontier: walkFrontier(),
  walkDeep: walkDeep(),
  walkSmall: walkSmall(),
  walkDirectionAndHighlight: walkDirectionAndHighlight(),
  walkSharedPlatform: walkSharedPlatform(),
  walkSharedPlatformLeaf: walkSharedPlatformLeaf(),
  walkSharedPlatformOneColumn: walkSharedPlatformOneColumn(),
  walkDensePills: walkDensePills(),
  walkChildrenRich: walkChildrenRich(),
  walkColumnFocus: walkColumnFocus(),
  walkPlatformFocus: walkPlatformFocus(),
  walkFlatRollup: walkFlatRollup(),
  walkFlatPeers: walkFlatPeers(),
  walkDense: walkDense(),
  walkDenseIsolated: walkDenseIsolated(),
}
