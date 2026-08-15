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
  /** Pre-selected card, so the shot also shows the detail treatment
   *  (hover isn't scriptable in a static screenshot). */
  selectedId?: string
  /** A CARD id whose lineage cone is isolated for the shot — the same
   *  state a click leaves behind, which is the only way to look at the
   *  isolation in a still picture. */
  isolatedId?: string
  /** THE TRAIL (T21) — urns to mark as explicitly walked through, the
   *  same state `LineageLens` accumulates from focus history and
   *  extend/page anchors. A still picture can't drive a real walk, so
   *  this is the only way to photograph the mark. */
  trailUrns?: string[]
  /** Consecutive stops in the walked path, as `[from, to]` urn pairs —
   *  the wires that draw slightly firmer. */
  trailAdjacent?: Array<[string, string]>
  /** T23 R3 — pre-opens the hub-triage list for the shot (it only ever
   *  opens from a click, which a still picture can't drive). The CARD id
   *  a follow control hangs off — `'f'` for the focal, `n:${urn}`
   *  otherwise (T27 — one id scheme regardless of kind), the same
   *  scheme `isolatedId` above uses. */
  triageAnchor?: { cardId: string; dir: 'in' | 'out' }
}

const scripted = (
  base: LensViewState,
  over: {
    reveal?: Array<[string, number]>
    expand?: string[]
    showAll?: string[]
    /** Where a frame's scroll window is RESTING, by first row index. The
     *  only way to photograph a mid-window list: the top fade and the
     *  "show previous" step exist exactly when the window is not at 0,
     *  and a still picture cannot scroll. */
    offsets?: Array<[string, number]>
  },
): LensViewState => ({
  ...base,
  revealed: new Map([...base.revealed, ...(over.reveal ?? [])]),
  expandedContainment: new Set([...base.expandedContainment, ...(over.expand ?? [])]),
  frameShowAll: new Set([...base.frameShowAll, ...(over.showAll ?? [])]),
  frameOffsets: new Map([...base.frameOffsets, ...(over.offsets ?? [])]),
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
  // THE TRAIL (T21): as if the reader walked loan_positions → collaterals
  // → risk_exposure_daily. t1/t2/DB and the rest of the spine carry no
  // mark — the contrast is the point.
  trailUrns: ['t0', 'F', 'OUT'],
  trailAdjacent: [['t0', 'F'], ['F', 'OUT']],
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
 * The same sixty-child container, MID-WINDOW — the state R5.2 is about.
 *
 * A still picture cannot scroll, so the discoverability cues that exist
 * only when the window has left the top (the fade under the header and
 * the "Show previous 10 rows" step) are unphotographable at offset 0.
 * Resting the window on row 11 is the shot that shows them, and it shows
 * the other end honestly too: hidden content BOTH ways, a fade at each
 * edge and a step control on either side of the range chip.
 *
 * It is a second fixture rather than a scroll of the first, because at
 * offset 10 the connected rows, the divider and the peeked row are all
 * above the window — and those are what `walkChildrenRich` is the
 * photograph of. Both states matter; neither can be the same picture.
 *
 * EXPECTED: `11–20 of 60` at the foot between `Show previous 10 rows`
 * and `Show next 10 rows`, ten roster rows (`legacy_/raw_/audit_/ext_`),
 * a soft edge top and bottom, and the thumb resting mid-track.
 */
const walkChildrenScrolled = (): WalkFixture => {
  const base = walkChildrenRich()
  return {
    ...base,
    title: 'The same list, scrolled off the top — the cues that only exist mid-window',
    script: b => scripted(b, { expand: ['T'], showAll: ['T'], offsets: [['T', 10]] }),
    // No selection: the peeked row is above this window, and a peek
    // pointing at a row that is not on screen is a panel about nothing.
    selectedId: undefined,
  }
}

/**
 * The user's column-grain estate, mid-ISOLATION: one of the eight
 * parallel column wires clicked.
 *
 * The isolation rule is hardest to believe exactly here — eight wires
 * running side by side between two tables, every one of them the same
 * shape — and this is the picture that settles it: `amount` to `amount`
 * lit and graded, the seven columns either side of it quiet, and both
 * boxes lit because each holds a lit row.
 */
const walkIsolatedLeafCone = (): WalkFixture => ({
  ...walkSharedPlatformLeaf(),
  title: 'One column of eight — the cone at column grain',
  isolatedId: 'n:s:amount',
})

/**
 * The same estate, mid-ISOLATION: the reader has clicked `dim_customer`,
 * so the board draws its lineage cone and quiets everything else.
 *
 * It is the shape that proves the rule. `dim_customer` feeds two of the
 * focus's columns and one of its tables, and every one of those lights —
 * but `INTERMEDIATE_T2`, which feeds a THIRD column of the same table,
 * does not: a sibling producer of a shared consumer is not on this
 * lineage, and an isolation that lit it would be lighting the board.
 */
const walkIsolatedCone = (): WalkFixture => ({
  ...walkSharedPlatform(),
  title: 'One click on dim_customer — its lineage cone, and everything else quiet',
  isolatedId: 'n:dim_customer',
})

/**
 * THE SCALE MANDATE, first half (user, 2026-08-14): "really long lineage
 * that has like 20 hops". Twenty hops, degree-one pass-through the whole
 * way — no containment, nothing to auto-open — except two branch points
 * that keep it from being a single line the layout could special-case.
 *
 *   up09 → up08 → … → up00 → F → dn00 → … → dn09     (20 hops, 21 nodes)
 *   up05 also feeds branchA · dn04 also feeds dn05 from branchB
 *
 * REVEAL_PAGE (12) governs how many SIBLING groups one page admits, not
 * how many HOPS deep a walk sees — a chain has exactly one neighbour per
 * node, so each hop needs its OWN reveal (`revealKey('in'|'out', urn)`
 * keyed on the CHAIN NODE, not the focus) before the next one is even in
 * the population. Confirmed against a screenshot before trusting it: the
 * unscripted default drew one hop each side and a "+1" pill, not twenty
 * hops — so the script below walks the whole chain into view, one reveal
 * per link, which is the picture a 20-hop walk actually looks like.
 * Exists for the P3 layout-rebuild budget (chain depth, not fan-out) and
 * reused by Task 21.
 */
const walkLongChain = (): WalkFixture => {
  const nodes: LensWalkNode[] = [wnode('F', 'dataset', 'ledger_snapshot')]
  const lineageEdges: ReturnType<typeof hop>[] = []
  const upstreamUrns = new Set<string>()
  const downstreamUrns = new Set<string>()
  const CHAIN = 10
  let prev = 'F'
  for (let i = CHAIN - 1; i >= 0; i--) {
    const urn = `up${String(i).padStart(2, '0')}`
    nodes.push(wnode(urn, 'dataset', `stage_up_${String(i).padStart(2, '0')}`))
    lineageEdges.push(hop(urn, prev))
    upstreamUrns.add(urn)
    prev = urn
  }
  prev = 'F'
  for (let i = 0; i < CHAIN; i++) {
    const urn = `dn${String(i).padStart(2, '0')}`
    nodes.push(wnode(urn, 'dataset', `stage_dn_${String(i).padStart(2, '0')}`))
    lineageEdges.push(hop(prev, urn))
    downstreamUrns.add(urn)
    prev = urn
  }
  // Branch point 1 — FAN IN: a second producer merges into the upstream
  // chain alongside the main line. Reachable the same way the chain is
  // (upstream BFS walks target←source, so a card FEEDING up05 is on it;
  // a card up05 fed would not be — the two are not interchangeable).
  nodes.push(wnode('branchA', 'dataset', 'branch_reconciliation'))
  lineageEdges.push(hop('branchA', 'up05'))
  upstreamUrns.add('branchA')
  // Branch point 2 — FAN OUT, the downstream mirror: one chain card feeds
  // a second consumer besides the next link in the line.
  nodes.push(wnode('branchB', 'dataset', 'branch_adjustment'))
  lineageEdges.push(hop('dn05', 'branchB'))
  downstreamUrns.add('branchB')
  // One reveal per link: `up09`'s own upstream neighbour is `up08`, so
  // `up08` is not IN THE POPULATION until `in:up09` is revealed, and so
  // on down to `up00`. `frontierUp`/`frontierDown` sit at the far end of
  // what is actually loaded (`up00`/`dn09`) — the near end (`up09`/`dn00`)
  // is fully surrounded by loaded chain on both sides and has nothing
  // left to fetch.
  const revealChain: Array<[string, number]> = []
  for (let i = CHAIN - 1; i >= 1; i--) revealChain.push([`in:up${String(i).padStart(2, '0')}`, 1])
  for (let i = 0; i < CHAIN - 1; i++) revealChain.push([`out:dn${String(i).padStart(2, '0')}`, 1])
  return {
    title: 'Twenty hops, degree-one the whole way, two branch points',
    model: walkModel('F', {
      nodes,
      lineageEdges,
      upstreamUrns,
      downstreamUrns,
      frontierUp: [frontier('up00', null)],
      frontierDown: [frontier('dn09', null)],
    }),
    script: base => scripted(base, { reveal: revealChain }),
  }
}

/**
 * THE SCALE MANDATE, second half (user, 2026-08-14): "sources with 100
 * incoming items". One hundred upstream tables spread across twelve
 * systems (so the fan-in is realistic rather than one container with a
 * hundred rows), forty flat downstream consumers.
 *
 * Twelve systems is exactly REVEAL_PAGE (12), so every system — and the
 * ~100 tables inside them — draws on the default view state with no
 * script; the forty downstream are forty SEPARATE top-level groups (no
 * container of their own), so only the first page shows by default and
 * `script` reveals the rest, which is also the realistic shape: a fan-out
 * this wide is exactly what the reveal-page pill exists for.
 *
 * Exists for the P3 rebuild budget (fan-out, not chain depth) and the P1
 * isolation/hover-toggle scripting-cost budget at hub scale; reused by
 * Task 21.
 */
const walkWideHub = (): WalkFixture => {
  const SYSTEMS = 12
  const UPSTREAM = 100
  const DOWNSTREAM = 40
  const nodes: LensWalkNode[] = [
    wnode('F', 'dataset', 'core_ledger', { description: 'Consolidated across every source system', childCount: 6 }),
  ]
  const containmentEdges: ReturnType<typeof holds>[] = []
  const lineageEdges: ReturnType<typeof hop>[] = []
  const upstreamUrns = new Set<string>()
  const downstreamUrns = new Set<string>()
  for (let s = 0; s < SYSTEMS; s++) {
    const sysUrn = `sys${String(s).padStart(2, '0')}`
    nodes.push(wnode(sysUrn, 'system', `source_system_${String(s).padStart(2, '0')}`))
    upstreamUrns.add(sysUrn)
  }
  for (let i = 0; i < UPSTREAM; i++) {
    const sysUrn = `sys${String(i % SYSTEMS).padStart(2, '0')}`
    const urn = `up${String(i).padStart(3, '0')}`
    nodes.push(wnode(urn, 'dataset', `feed_${String(i).padStart(3, '0')}`))
    containmentEdges.push(holds(sysUrn, urn))
    lineageEdges.push(hop(urn, 'F'))
    upstreamUrns.add(urn)
  }
  for (let i = 0; i < DOWNSTREAM; i++) {
    const urn = `dn${String(i).padStart(3, '0')}`
    nodes.push(wnode(urn, 'dataset', `report_${String(i).padStart(3, '0')}`))
    lineageEdges.push(hop('F', urn))
    downstreamUrns.add(urn)
  }
  return {
    title: 'One hundred upstream across twelve systems, forty downstream',
    model: walkModel('F', {
      nodes,
      containmentEdges,
      lineageEdges,
      upstreamUrns,
      downstreamUrns,
    }),
    // Forty ungrouped groups is more than one REVEAL_PAGE (12) — reveal
    // four pages so the shot shows every downstream card the fixture
    // promises, not the first twelve behind a "+28" pill.
    script: base => scripted(base, { reveal: [['out:F', 4]] }),
  }
}

/**
 * T23 R2 — the twenty-hop chain with the run NEAREST the focus unfolded
 * (its four interior steps drawn): the "condensed run + its unfold"
 * mandatory shot. The FAR run (`up00`..`up05`) and the whole downstream
 * side stay condensed/folded, for contrast in the same shot. Connector
 * ids are `condense:${boundaryA}>${boundaryB}` over CARD ids
 * (`condensation.ts`) — `up05`'s run head is `n:up05`, and the focal's
 * own card id is the bare `'f'` (`focus-layout.ts`'s `baseCard`). (T28
 * R3 removed the sliding window this fixture used to ALSO steer
 * off-centre in the same shot — the board just grows now, so there is
 * no window position left to demonstrate.)
 */
const walkLongChainUnfolded = (): WalkFixture => {
  const base = walkLongChain()
  return {
    ...base,
    title: 'The chain — one run unfolded',
    script: b => ({
      ...(base.script ? base.script(b) : b),
      condensedOpen: new Set(['condense:n:up05>f']),
    }),
  }
}

/**
 * T23 R3 — `walkWideHub` with the hub-triage list forced open on F's own
 * hundred-incoming upstream direction: the mandatory "triage list on
 * walkWideHub" shot. FORCED, not clicked — the canonical fixture's own
 * default script (T20) admits all twelve systems for free (12 ≤
 * REVEAL_PAGE), so no ⊕ here would naturally cross the triage gate; the
 * panel is shown at the scale it exists for regardless, the same reason
 * `isolatedId` forces a state a still picture cannot click its way to.
 */
const walkWideHubTriage = (): WalkFixture => ({
  ...walkWideHub(),
  title: 'The hundred-incoming hub — the triage list, forced open',
  triageAnchor: { cardId: 'f', dir: 'in' },
})

/**
 * T25 A — the OTHER triage shape `walkWideHubTriage` cannot show: a
 * cohort that ARRIVED from a genuine fetch rather than sat fully local
 * from the start. `HUB` carries forty-five of its own downstream
 * consumers already known (a page that landed) plus a frontier claiming
 * sixty more — so the panel states BOTH halves Rule 2 promises, "45
 * known · 60 more not yet loaded" with its own ⊕ load-more, the shape
 * the reported empty wall ("0 known · N more not yet loaded · Nothing
 * fetched here yet") could never reach because it opened before any
 * fetch fired. FORCED open, same reason `walkWideHubTriage` is — a
 * still picture cannot click its way through a fetch.
 */
const walkUnfetchedFanTriage = (): WalkFixture => {
  const nodes = [
    wnode('F', 'dataset', 'payments_core', { description: 'Settled payment events' }),
    wnode('HUB', 'dataset', 'downstream_hub', { childCount: 105 }),
  ]
  const lineageEdges = [hop('F', 'HUB')]
  for (let i = 0; i < 45; i++) {
    const urn = `d${String(i).padStart(3, '0')}`
    nodes.push(wnode(urn, 'dataset', `consumer_${String(i).padStart(3, '0')}`))
    lineageEdges.push(hop('HUB', urn))
  }
  return {
    title: 'A cohort that just ARRIVED — the triage list populated, with an honest remainder',
    model: walkModel('F', {
      nodes,
      lineageEdges,
      upstreamUrns: new Set(),
      downstreamUrns: new Set(['HUB', ...nodes.slice(2).map(n => n.urn)]),
      // The genuine unfetched remainder — still there, still honest,
      // now stated INSIDE the panel rather than gating the click that
      // reaches it.
      frontierDown: [frontier('HUB', 105)],
    }),
    // All forty-five known consumers fully admitted (4 reveal pages ×
    // 12 ≥ 45) — otherwise `pillFor` still finds local groups to reveal
    // and never reaches the frontier branch, and the panel's remainder
    // line (the whole point of this fixture) never appears.
    script: base => scripted(base, { reveal: [['out:HUB', 4]] }),
    triageAnchor: { cardId: 'n:HUB', dir: 'out' },
  }
}

/**
 * THE GRAIN SEAM (Task 22, R1) — both failure directions in one estate.
 *
 *   Snowflake ⊃ REPORTING (chrome, demoted) ⊃ rpt_customer_360 (the focus)
 *     ⊃ full_name, signup_date
 *   GOLD ⊃ crm_snapshot_01..06        → six TABLE-grain producers of
 *                                        full_name (source = the whole
 *                                        table; which of ITS OWN columns
 *                                        fed it is unfetched) — the
 *                                        OVER-claim (15.41.27): isolating
 *                                        full_name used to light these
 *                                        with the same certainty as a
 *                                        column-true wire.
 *   crm_snapshot_01 also feeds crm_snapshot_02 directly — two rows of
 *     ONE frame, wired to each other: the R2 in-frame-routing case.
 *   BILLING ⊃ billing_source ⊃ full_name_src → full_name: a genuine
 *     COLUMN-to-COLUMN producer, for contrast — the seam must never
 *     touch this wire.
 *   BILLING ⊃ billing_snapshot (TABLE-grain) → full_name: a coarse
 *     producer sitting in the SAME container, right beside
 *     billing_source's row — T24 F8 review round 1's own ask: a
 *     same-colour, same-direction, adjacent certain/coarse pair so the
 *     dash-vs-solid contrast is verifiable apples-to-apples, not just
 *     across a busier six-wire bundle on the other side of the board.
 *   full_name → transactions (IoT): fine both ways.
 *   Marketing → IoT: a PLATFORM-grain hop landing on IoT's own frame,
 *     nothing to do with any specific row inside it — the UNDER-claim
 *     (19.01.05/19.02.33): isolating the "transactions" ROW used to go
 *     dark toward Marketing, because a row's cone never asked what its
 *     OWN containing frame carries.
 *
 * `crm_snapshot_01` offers a real ⊕ (frontierUp) — the seam's "trace
 * columns" has something to click; `crm_snapshot_02..06` are drained —
 * the seam states, honestly, that the source cannot answer finer.
 */
const walkGrainSeamModel = () => {
  const nodes = [
    wnode('SNOW', 'PLATFORM', 'Snowflake', { childCount: 10 }),
    wnode('REPORTING', 'CONTAINER', 'REPORTING', { childCount: 2 }),
    wnode('RPT', 'dataset', 'rpt_customer_360', { childCount: 5, description: 'Curated customer profile' }),
    wnode('FN', 'schemaField', 'full_name'),
    wnode('SD', 'schemaField', 'signup_date'),
    wnode('GOLD', 'CONTAINER', 'GOLD', { childCount: 8 }),
    ...['01', '02', '03', '04', '05', '06'].map(n =>
      wnode(`G${n}`, 'dataset', `crm_snapshot_${n}`, { childCount: 10 })),
    wnode('BILL', 'CONTAINER', 'BILLING', { childCount: 4 }),
    wnode('BSRC', 'dataset', 'billing_source', { childCount: 6 }),
    wnode('BFN', 'schemaField', 'full_name_src'),
    // The certain wire's own coarse neighbour — review round 1's
    // same-colour, same-direction, adjacent pair.
    wnode('BSNAP', 'dataset', 'billing_snapshot', { childCount: 4 }),
    wnode('IOT', 'PLATFORM', 'IoT', { childCount: 4 }),
    wnode('TXN', 'dataset', 'transactions'),
    wnode('MKT', 'PLATFORM', 'Marketing', { childCount: 12 }),
  ]
  return walkModel('RPT', {
    nodes,
    containmentEdges: [
      holds('SNOW', 'REPORTING'), holds('REPORTING', 'RPT'), holds('RPT', 'FN'), holds('RPT', 'SD'),
      ...['01', '02', '03', '04', '05', '06'].map(n => holds('GOLD', `G${n}`)),
      holds('BILL', 'BSRC'), holds('BSRC', 'BFN'), holds('BILL', 'BSNAP'),
      holds('IOT', 'TXN'),
    ],
    lineageEdges: [
      hop('G01', 'FN'), hop('G01', 'FN', 'JOINS'),
      hop('G02', 'FN'), hop('G02', 'FN', 'JOINS'),
      hop('G03', 'FN'), hop('G04', 'FN'), hop('G05', 'FN'), hop('G06', 'FN'),
      // R2 — two rows of the SAME frame (GOLD), wired to each other.
      hop('G01', 'G02', 'FEEDS'),
      // The genuine column-to-column contrast the seam must never touch.
      hop('BFN', 'FN'),
      // Its own coarse neighbour, same container, same target, same
      // direction — review round 1's adjacent apples-to-apples pair.
      hop('BSNAP', 'FN'),
      hop('FN', 'TXN'),
      // The under-claim: lands on IoT's own frame, not on any row of it.
      hop('MKT', 'IOT'),
    ],
    upstreamUrns: new Set(['GOLD', 'G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'BILL', 'BSRC', 'BFN', 'BSNAP']),
    downstreamUrns: new Set(['IOT', 'TXN']),
    frontierUp: [frontier('G01', 3)],
  })
}

/** OVER-claim: isolating the fine column lights six table-grain producers. */
const walkGrainSeam = (): WalkFixture => ({
  title: 'The grain seam — table-grain producers land honestly, never as column-true',
  model: walkGrainSeamModel(),
  // `expand: ['BSRC']` keeps `full_name_src` drawn as its own row — with
  // a second BILLING sibling now beside it (review round 1's adjacent
  // pair), the default single-child auto-expand no longer applies, and a
  // collapsed billing_source would draw the certain wire from the TABLE
  // boundary instead, silently turning the "must never touch this wire"
  // contrast into a coarse-vs-coarse comparison.
  script: base => scripted(base, { reveal: [['in:IOT', 1]], expand: ['BSRC'] }),
  isolatedId: 'n:FN',
})

/** UNDER-claim: isolating the row must not go dark toward Marketing. */
const walkGrainSeamUnderclaim = (): WalkFixture => ({
  ...walkGrainSeam(),
  title: 'The grain seam cuts both ways — the row\'s own frame carries the connection',
  isolatedId: 'n:TXN',
})

/**
 * T26 R3 — THE SEAM TERMINUS (the user's reported shape, 11.36.49/53):
 * spotlight ONE row, several containment levels deep, where EVERY
 * ancestor level between it and the platform root carries its OWN,
 * unrelated coarse traffic.
 *
 *   rpt_customer_360 (the focus) — full_name → transactions (genuine,
 *     column-certain — the certain path a spotlight must keep honest)
 *   BigCo Data Cloud ⊃ US-EAST ⊃ IoT ⊃ transactions (the row)
 *   Marketing → IoT: the ONE legitimate seam — a table-grain producer of
 *     transactions' OWN containing frame (same shape as the existing
 *     under-claim fixture above, one level).
 *   region_replication_feed → US-EAST: a SEPARATE, unrelated coarse
 *     producer one containment level further up — before the fix,
 *     isolating transactions lit this too, climbing straight past its
 *     own seam.
 *   bigco_platform_audit → BigCo Data Cloud: two levels further still —
 *     the "keeps walking transitively → most of the board lights
 *     orange" the user reported. After the fix, neither ever lights:
 *     the detailed walk terminates at IoT, the one true seam.
 */
const walkGrainSeamDeepNestingModel = () => walkModel('RPT', {
  nodes: [
    wnode('RPT', 'dataset', 'rpt_customer_360', { childCount: 1, description: 'Curated customer profile' }),
    wnode('FN', 'schemaField', 'full_name'),
    // TXN's own containment chain — BIGCO ⊃ REGION ⊃ IOT ⊃ TXN — entirely
    // unrelated to RPT's own ancestry (a DIFFERENT platform's estate).
    // Each of BIGCO/REGION/IOT is ALSO a direct lineage-hop endpoint
    // below, which is what earns it a real, band-positioned card: a
    // pure containment ancestor never does (it collapses to breadcrumb
    // chrome — see `walkGrainSeamDeepNestingModel`'s sibling attempt,
    // superseded, in this fixture's own git history) — only a hop
    // endpoint gets one. Three real ancestor frames, three unrelated
    // coarse producers, is the shape that actually exercises the climb.
    wnode('BIGCO', 'PLATFORM', 'BigCo Data Cloud', { childCount: 3 }),
    wnode('REGION', 'CONTAINER', 'US-EAST', { childCount: 2 }),
    wnode('IOT', 'PLATFORM', 'IoT', { childCount: 4 }),
    wnode('TXN', 'dataset', 'transactions'),
    // The ONE legitimate seam — IoT's own direct coarse producer, the
    // row's immediate containing frame.
    wnode('MKT', 'PLATFORM', 'Marketing', { childCount: 12 }),
    // Unrelated coarse traffic, one and two containment levels further
    // up — must never light from a row spotlighted inside IoT.
    wnode('REGION_SRC', 'dataset', 'region_replication_feed', { childCount: 8 }),
    wnode('BIGCO_SRC', 'dataset', 'bigco_platform_audit', { childCount: 10 }),
  ],
  containmentEdges: [
    holds('RPT', 'FN'),
    holds('BIGCO', 'REGION'), holds('REGION', 'IOT'), holds('IOT', 'TXN'),
  ],
  lineageEdges: [
    // The genuine column-to-column wire — the certain path a spotlight
    // must keep honest.
    hop('FN', 'TXN'),
    hop('MKT', 'IOT'),
    hop('REGION_SRC', 'REGION'),
    hop('BIGCO_SRC', 'BIGCO'),
  ],
  upstreamUrns: new Set(['MKT', 'REGION_SRC', 'BIGCO_SRC']),
  downstreamUrns: new Set(['IOT', 'TXN']),
})

const walkGrainSeamDeepNesting = (): WalkFixture => ({
  title: 'The seam terminates at the FIRST containment boundary — not the whole ancestor chain',
  model: walkGrainSeamDeepNestingModel(),
  script: base => scripted(base, {
    reveal: [['in:IOT', 1], ['in:REGION', 1], ['in:BIGCO', 1]],
    expand: ['BIGCO', 'REGION', 'IOT'],
  }),
  isolatedId: 'n:TXN',
})

export const WALK_FIXTURES: Record<string, WalkFixture> = {
  walkCollaterals: walkCollaterals(),
  walkIsolatedCone: walkIsolatedCone(),
  walkDiamond: walkDiamond(),
  walkHub: walkHub(),
  walkFrontier: walkFrontier(),
  walkDeep: walkDeep(),
  walkSmall: walkSmall(),
  walkDirectionAndHighlight: walkDirectionAndHighlight(),
  walkSharedPlatform: walkSharedPlatform(),
  walkSharedPlatformLeaf: walkSharedPlatformLeaf(),
  walkIsolatedLeafCone: walkIsolatedLeafCone(),
  walkSharedPlatformOneColumn: walkSharedPlatformOneColumn(),
  walkDensePills: walkDensePills(),
  walkChildrenRich: walkChildrenRich(),
  walkChildrenScrolled: walkChildrenScrolled(),
  walkColumnFocus: walkColumnFocus(),
  walkPlatformFocus: walkPlatformFocus(),
  walkLongChain: walkLongChain(),
  walkLongChainUnfolded: walkLongChainUnfolded(),
  walkWideHub: walkWideHub(),
  walkWideHubTriage: walkWideHubTriage(),
  walkUnfetchedFanTriage: walkUnfetchedFanTriage(),
  walkGrainSeam: walkGrainSeam(),
  walkGrainSeamUnderclaim: walkGrainSeamUnderclaim(),
  walkGrainSeamDeepNesting: walkGrainSeamDeepNesting(),
}
