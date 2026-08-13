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
import type { LensRoster, LensViewState } from '@/components/canvas/context-view/lens/focus-layout'

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
    upstreamUrns: new Set(['U']),
    downstreamUrns: new Set(['D']),
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
