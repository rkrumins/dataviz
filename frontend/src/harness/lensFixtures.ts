/**
 * Scripted providers for the Lens visual harness.
 *
 * Each fixture is a deterministic GraphDataProvider stand-in serving a
 * small, realistic estate, so the REAL data hook, merge core, builder
 * and view run end-to-end with no backend. Shapes mirror the
 * seed_data_lake demo: an Application consuming datasets and their
 * columns, a coarse platform whose lineage exists only as rollups, a
 * long chain for walking, and a rollup that drills to constituents.
 */
import type {
  EdgeQuery,
  ExpandAggregatedRequest,
  GraphDataProvider,
  GraphEdge,
  GraphNode,
  TraceV2Request,
  TraceV2Result,
} from '@/providers/GraphDataProvider'

const node = (urn: string, entityType: string, displayName: string, childCount?: number): GraphNode => ({
  urn,
  entityType,
  displayName,
  properties: {},
  ...(childCount !== undefined ? { childCount } : {}),
})

let edgeSeq = 0
const edge = (
  sourceUrn: string,
  targetUrn: string,
  edgeType: string,
  properties?: Record<string, unknown>,
): GraphEdge => ({ id: `hx-${edgeSeq++}`, sourceUrn, targetUrn, edgeType, ...(properties ? { properties } : {}) })

const emptyTrace = (urn: string): TraceV2Result => ({
  nodes: [],
  edges: [],
  containmentEdges: [],
  upstreamUrns: new Set<string>(),
  downstreamUrns: new Set<string>(),
  focus: { urn, level: 0, entityType: 'unknown' },
  effectiveLevel: 0,
  isInherited: false,
  inheritedFromUrn: null,
  truncated: false,
  truncationReason: null,
})

export interface HarnessWorld {
  nodes: GraphNode[]
  edges: GraphEdge[]
  containment: GraphEdge[]
  degrees: Record<string, { in: number; out: number }>
  traces?: Record<string, Partial<TraceV2Result>>
  expands?: (req: ExpandAggregatedRequest) => Partial<TraceV2Result> | null
}

/** A tiny in-memory provider over a fixture world. */
export function harnessProvider(world: HarnessWorld): GraphDataProvider {
  const nodesByUrn = new Map(world.nodes.map(n => [n.urn, n]))
  const parentOf = new Map(world.containment.map(e => [e.targetUrn, e.sourceUrn]))
  const childrenOf = new Map<string, GraphNode[]>()
  for (const e of world.containment) {
    const child = nodesByUrn.get(e.targetUrn)
    if (!child) continue
    const list = childrenOf.get(e.sourceUrn) ?? []
    list.push(child)
    childrenOf.set(e.sourceUrn, list)
  }
  const matchesTypes = (edgeType: string, types?: string[]) =>
    !types || types.some(t => t.toUpperCase() === edgeType.toUpperCase())

  const impl = {
    async getNodes(q: { urns?: string[] }) {
      return (q.urns ?? []).map(u => nodesByUrn.get(u)).filter((n): n is GraphNode => Boolean(n))
    },
    async getEdges(q: EdgeQuery) {
      const all = [...world.edges, ...world.containment]
      return all
        .filter(e => matchesTypes(e.edgeType, q.edgeTypes))
        .filter(e =>
          (q.sourceUrns ? q.sourceUrns.includes(e.sourceUrn) : true) &&
          (q.targetUrns ? q.targetUrns.includes(e.targetUrn) : true))
        .slice(0, q.limit ?? 500)
    },
    async getNodeDegrees(urns: string[]) {
      return Object.fromEntries(urns.filter(u => world.degrees[u]).map(u => [u, world.degrees[u]]))
    },
    async getAncestors(urn: string) {
      const chain: GraphNode[] = []
      let cursor = parentOf.get(urn)
      while (cursor) {
        const n = nodesByUrn.get(cursor)
        if (!n) break
        chain.push(n)
        cursor = parentOf.get(cursor)
      }
      return chain
    },
    async getChildrenWithEdges(parentUrn: string, options?: { limit?: number; cursor?: string | null }) {
      const kids = childrenOf.get(parentUrn) ?? []
      const limit = options?.limit ?? 25
      const start = options?.cursor ? kids.findIndex(k => k.displayName === options.cursor) + 1 : 0
      const page = kids.slice(start, start + limit)
      const kidUrns = new Set(page.map(k => k.urn))
      return {
        children: page,
        containmentEdges: world.containment.filter(e => e.sourceUrn === parentUrn && kidUrns.has(e.targetUrn)),
        lineageEdges: world.edges.filter(e => kidUrns.has(e.sourceUrn) || kidUrns.has(e.targetUrn)),
        totalChildren: kids.length,
        hasMore: start + limit < kids.length,
        nextCursor: start + limit < kids.length ? page[page.length - 1]?.displayName ?? null : null,
      }
    },
    async traceAtLevel(req: TraceV2Request): Promise<TraceV2Result> {
      const scripted = world.traces?.[req.urn]
      return { ...emptyTrace(req.urn), ...(scripted ?? {}) }
    },
    async expandAggregated(req: ExpandAggregatedRequest): Promise<TraceV2Result> {
      const scripted = world.expands?.(req)
      return { ...emptyTrace(req.sourceUrn), ...(scripted ?? {}) }
    },
  }
  return impl as unknown as GraphDataProvider
}

// ── Fixtures ───────────────────────────────────────────────────────────

/** Focus an Application: real CONSUMES edges at mixed grain, columns
 *  grouped inside their dataset frames, honest empty upstream. */
function appFixture(): { focal: string; world: HarnessWorld } {
  const world: HarnessWorld = {
    nodes: [
      node('app:portal', 'app', 'Customer Portal'),
      node('domain:retail', 'domain', 'Retail Domain'),
      node('ds:dim_customer', 'dataset', 'gold.dim_customer', 6),
      node('ds:rpt_360', 'dataset', 'mart.rpt_customer_360', 4),
      node('col:dim.email', 'column', 'email'),
      node('col:dim.ltv', 'column', 'lifetime_value'),
      node('col:dim.seg', 'column', 'segment'),
      node('col:rpt.score', 'column', 'churn_score'),
      node('sch:gold', 'schema', 'GOLD'),
      node('sch:mart', 'schema', 'MART'),
    ],
    edges: [
      edge('app:portal', 'ds:dim_customer', 'CONSUMES'),
      edge('app:portal', 'col:dim.email', 'CONSUMES'),
      edge('app:portal', 'col:dim.ltv', 'CONSUMES'),
      edge('app:portal', 'col:dim.seg', 'CONSUMES'),
      edge('app:portal', 'col:rpt.score', 'CONSUMES'),
      edge('ds:dim_customer', 'ds:rpt_360', 'FLOWS_TO'),
    ],
    containment: [
      edge('domain:retail', 'app:portal', 'CONTAINS'),
      edge('sch:gold', 'ds:dim_customer', 'CONTAINS'),
      edge('sch:mart', 'ds:rpt_360', 'CONTAINS'),
      edge('ds:dim_customer', 'col:dim.email', 'CONTAINS'),
      edge('ds:dim_customer', 'col:dim.ltv', 'CONTAINS'),
      edge('ds:dim_customer', 'col:dim.seg', 'CONTAINS'),
      edge('ds:rpt_360', 'col:rpt.score', 'CONTAINS'),
    ],
    degrees: {
      'app:portal': { in: 0, out: 5 },
      'ds:dim_customer': { in: 8, out: 3 },
      'col:dim.email': { in: 2, out: 1 },
      'ds:rpt_360': { in: 4, out: 0 },
    },
    traces: {
      'app:portal': {
        containmentEdges: [
          edge('ds:dim_customer', 'col:dim.email', 'CONTAINS'),
          edge('ds:dim_customer', 'col:dim.ltv', 'CONTAINS'),
          edge('ds:dim_customer', 'col:dim.seg', 'CONTAINS'),
          edge('ds:rpt_360', 'col:rpt.score', 'CONTAINS'),
        ],
        nodes: [
          node('ds:dim_customer', 'dataset', 'gold.dim_customer', 6),
          node('ds:rpt_360', 'dataset', 'mart.rpt_customer_360', 4),
        ],
      },
    },
  }
  return { focal: 'app:portal', world }
}

/** Focus a coarse platform: no raw edges of its own — the picture is
 *  rolled-up peers with drillable ×N connections. */
function coarseFixture(): { focal: string; world: HarnessWorld } {
  const world: HarnessWorld = {
    nodes: [
      node('plat:snowflake', 'dataPlatform', 'Snowflake', 3),
      node('plat:kafka', 'dataPlatform', 'Kafka'),
      node('plat:tableau', 'dataPlatform', 'Tableau'),
      node('domain:core', 'domain', 'Core Data'),
      node('ds:raw_events', 'dataset', 'raw.events'),
      node('ds:stg_events', 'dataset', 'stg.events'),
    ],
    edges: [],
    containment: [
      edge('domain:core', 'plat:snowflake', 'CONTAINS'),
      edge('plat:kafka', 'ds:raw_events', 'CONTAINS'),
      edge('plat:snowflake', 'ds:stg_events', 'CONTAINS'),
    ],
    degrees: { 'plat:snowflake': { in: 14, out: 9 } },
    traces: {
      'plat:snowflake': {
        edges: [
          edge('plat:kafka', 'plat:snowflake', 'AGGREGATED', { weight: 14, sourceEdgeTypes: ['FLOWS_TO'] }),
          edge('plat:snowflake', 'plat:tableau', 'AGGREGATED', { weight: 9, sourceEdgeTypes: ['FLOWS_TO', 'CONSUMES'] }),
        ],
        nodes: [
          node('plat:kafka', 'dataPlatform', 'Kafka'),
          node('plat:tableau', 'dataPlatform', 'Tableau'),
        ],
        upstreamUrns: new Set(['plat:kafka']),
        downstreamUrns: new Set(['plat:tableau']),
      },
    },
    expands: req => {
      if (req.sourceUrn === 'plat:kafka' && req.targetUrn === 'plat:snowflake') {
        return {
          nodes: [
            node('ds:raw_events', 'dataset', 'raw.events'),
            node('ds:stg_events', 'dataset', 'stg.events'),
          ],
          containmentEdges: [
            edge('plat:kafka', 'ds:raw_events', 'CONTAINS'),
            edge('plat:snowflake', 'ds:stg_events', 'CONTAINS'),
          ],
          edges: [edge('ds:raw_events', 'ds:stg_events', 'FLOWS_TO', { weight: 14 })],
        }
      }
      return null
    },
  }
  return { focal: 'plat:snowflake', world }
}

/** A long chain so ⊕ can be pressed hop after hop with no cap. */
function deepWalkFixture(): { focal: string; world: HarnessWorld } {
  const stages = ['src.crm', 'stg.contacts', 'int.identities', 'gold.customers', 'mart.summary', 'dash.exec', 'rpt.board']
  const urns = stages.map((s, i) => `n${i}:${s}`)
  const world: HarnessWorld = {
    nodes: urns.map((u, i) => node(u, i < 4 ? 'dataset' : 'dashboard', stages[i])),
    edges: urns.slice(0, -1).map((u, i) => edge(u, urns[i + 1], 'FLOWS_TO')),
    containment: [],
    degrees: Object.fromEntries(urns.map((u, i) => [u, { in: i === 0 ? 0 : 1, out: i === urns.length - 1 ? 0 : 1 }])),
  }
  return { focal: urns[3], world }
}

/** A rollup between the focal and a system, drilling to constituents. */
function drillFixture(): { focal: string; world: HarnessWorld } {
  const world: HarnessWorld = {
    nodes: [
      node('ds:orders', 'dataset', 'gold.orders'),
      node('sys:billing', 'system', 'Billing System', 2),
      node('ds:invoices', 'dataset', 'billing.invoices'),
      node('ds:payments', 'dataset', 'billing.payments'),
    ],
    edges: [edge('ds:orders', 'sys:billing', 'AGGREGATED', { weight: 5, sourceEdgeTypes: ['FLOWS_TO'] })],
    containment: [
      edge('sys:billing', 'ds:invoices', 'CONTAINS'),
      edge('sys:billing', 'ds:payments', 'CONTAINS'),
    ],
    degrees: { 'ds:orders': { in: 2, out: 5 } },
    expands: req => {
      if (req.targetUrn === 'sys:billing') {
        return {
          nodes: [
            node('ds:invoices', 'dataset', 'billing.invoices'),
            node('ds:payments', 'dataset', 'billing.payments'),
          ],
          containmentEdges: [
            edge('sys:billing', 'ds:invoices', 'CONTAINS'),
            edge('sys:billing', 'ds:payments', 'CONTAINS'),
          ],
          edges: [
            edge('ds:orders', 'ds:invoices', 'FLOWS_TO', { weight: 3 }),
            edge('ds:orders', 'ds:payments', 'FLOWS_TO', { weight: 2 }),
          ],
        }
      }
      return null
    },
  }
  return { focal: 'ds:orders', world }
}

/** Focus Domain A with rollups to Domains B and C: the macro→micro
 *  story. Expanding B shows only the applications A's lineage reaches
 *  (level-aligned constituents — the true A-side endpoints live under A
 *  and stay unplaced until A is opened); expanding an application shows
 *  its datasets, three frames deep. C is a pass-through chain of
 *  self-nested domains (C ⊃ PROD ⊃ CURATED ⊃ one app) that the
 *  auto-walk crosses in one gesture, ending in concrete truth. */
function domainsFixture(): { focal: string; world: HarnessWorld } {
  const world: HarnessWorld = {
    nodes: [
      node('dom:a', 'domain', 'Domain A', 1),
      node('dom:b', 'domain', 'Domain B', 3),
      node('dom:c', 'domain', 'Domain C', 1),
      node('app:a1', 'app', 'Portal', 0),
      node('app:b1', 'app', 'Orders Service', 2),
      node('app:b2', 'app', 'Inventory Service', 0),
      node('app:b3', 'app', 'Legacy Reports', 0),
      node('ds:b1_orders', 'dataset', 'orders.core'),
      node('ds:b1_lines', 'dataset', 'orders.lines'),
      node('dom:c_prod', 'domain', 'PROD', 1),
      node('dom:c_curated', 'domain', 'CURATED', 1),
      node('app:c1', 'app', 'Analytics Hub', 0),
    ],
    edges: [],
    containment: [
      edge('dom:a', 'app:a1', 'CONTAINS'),
      edge('dom:b', 'app:b1', 'CONTAINS'),
      edge('dom:b', 'app:b2', 'CONTAINS'),
      edge('dom:b', 'app:b3', 'CONTAINS'),
      edge('app:b1', 'ds:b1_orders', 'CONTAINS'),
      edge('app:b1', 'ds:b1_lines', 'CONTAINS'),
      edge('dom:c', 'dom:c_prod', 'CONTAINS'),
      edge('dom:c_prod', 'dom:c_curated', 'CONTAINS'),
      edge('dom:c_curated', 'app:c1', 'CONTAINS'),
    ],
    degrees: {
      'app:a1': { in: 0, out: 18 },
      'app:b1': { in: 7, out: 2 },
      'app:b2': { in: 5, out: 0 },
      'ds:b1_orders': { in: 4, out: 1 },
      'app:c1': { in: 6, out: 0 },
    },
    traces: {
      'dom:a': {
        edges: [
          edge('dom:a', 'dom:b', 'AGGREGATED', { weight: 12, sourceEdgeTypes: ['CONSUMES', 'FLOWS_TO'] }),
          edge('dom:a', 'dom:c', 'AGGREGATED', { weight: 6, sourceEdgeTypes: ['FLOWS_TO'] }),
        ],
        nodes: [node('dom:b', 'domain', 'Domain B', 3), node('dom:c', 'domain', 'Domain C', 1)],
        downstreamUrns: new Set(['dom:b', 'dom:c']),
      },
    },
    expands: req => {
      const anchored = (s: string, t: string, anchor: string) =>
        req.sourceUrn === s && req.targetUrn === t && req.drillAnchor === anchor
      // B, one step: the applications A's lineage actually reaches —
      // level-aligned cells whose A-side endpoint is A's app, not A.
      if (anchored('dom:a', 'dom:b', 'dom:b')) {
        return {
          nodes: [
            node('app:b1', 'app', 'Orders Service', 2),
            node('app:b2', 'app', 'Inventory Service', 0),
            node('app:a1', 'app', 'Portal', 0),
          ],
          containmentEdges: [
            edge('dom:b', 'app:b1', 'CONTAINS'),
            edge('dom:b', 'app:b2', 'CONTAINS'),
            edge('dom:a', 'app:a1', 'CONTAINS'),
          ],
          edges: [
            edge('app:a1', 'app:b1', 'AGGREGATED', { weight: 7, sourceEdgeTypes: ['CONSUMES'] }),
            edge('app:a1', 'app:b2', 'AGGREGATED', { weight: 5, sourceEdgeTypes: ['FLOWS_TO'] }),
          ],
        }
      }
      // Orders Service, one step deeper: exactly which datasets.
      if (anchored('app:a1', 'app:b1', 'app:b1')) {
        return {
          nodes: [
            node('ds:b1_orders', 'dataset', 'orders.core'),
            node('ds:b1_lines', 'dataset', 'orders.lines'),
          ],
          containmentEdges: [
            edge('app:b1', 'ds:b1_orders', 'CONTAINS'),
            edge('app:b1', 'ds:b1_lines', 'CONTAINS'),
            edge('dom:a', 'app:a1', 'CONTAINS'),
          ],
          edges: [
            edge('app:a1', 'ds:b1_orders', 'AGGREGATED', { weight: 4, sourceEdgeTypes: ['CONSUMES'] }),
            edge('app:a1', 'ds:b1_lines', 'AGGREGATED', { weight: 3, sourceEdgeTypes: ['CONSUMES'] }),
          ],
        }
      }
      // C is a pass-through tower of self-nested domains: each level has
      // exactly one connected child, so the auto-walk crosses all of it.
      if (anchored('dom:a', 'dom:c', 'dom:c')) {
        return {
          nodes: [node('dom:c_prod', 'domain', 'PROD', 1), node('app:a1', 'app', 'Portal', 0)],
          containmentEdges: [
            edge('dom:c', 'dom:c_prod', 'CONTAINS'),
            edge('dom:a', 'app:a1', 'CONTAINS'),
          ],
          edges: [edge('app:a1', 'dom:c_prod', 'AGGREGATED', { weight: 6, sourceEdgeTypes: ['FLOWS_TO'] })],
        }
      }
      if (anchored('app:a1', 'dom:c_prod', 'dom:c_prod')) {
        return {
          nodes: [node('dom:c_curated', 'domain', 'CURATED', 1)],
          containmentEdges: [edge('dom:c_prod', 'dom:c_curated', 'CONTAINS')],
          edges: [edge('app:a1', 'dom:c_curated', 'AGGREGATED', { weight: 6, sourceEdgeTypes: ['FLOWS_TO'] })],
        }
      }
      if (anchored('app:a1', 'dom:c_curated', 'dom:c_curated')) {
        return {
          nodes: [node('app:c1', 'app', 'Analytics Hub', 0)],
          containmentEdges: [edge('dom:c_curated', 'app:c1', 'CONTAINS')],
          edges: [edge('app:a1', 'app:c1', 'AGGREGATED', { weight: 6, sourceEdgeTypes: ['FLOWS_TO'] })],
        }
      }
      // The chain's last step: the raw fallback returns concrete truth
      // between the pair itself — the walk ends on a solid wire.
      if (anchored('app:a1', 'app:c1', 'app:c1')) {
        return {
          nodes: [node('app:c1', 'app', 'Analytics Hub', 0)],
          containmentEdges: [edge('dom:c_curated', 'app:c1', 'CONTAINS')],
          edges: [edge('app:a1', 'app:c1', 'FLOWS_TO', { weight: 6 })],
        }
      }
      return null
    },
  }
  return { focal: 'dom:a', world }
}

/** Focus a dataset whose lineage lives entirely on its COLUMNS — no
 *  raw edges of its own, no materialized rollups (traces come back
 *  empty). The container fallback must paint the children-grain truth:
 *  the focal's columns under its frame, source columns grouped in
 *  their dataset frame upstream, consumer columns downstream. */
function columnsFixture(): { focal: string; world: HarnessWorld } {
  const t1cols = ['total_amount', 'subtotal', 'order_id', 'net_revenue']
  const world: HarnessWorld = {
    nodes: [
      node('ds:t2', 'dataset', 'int_clean_orders_t2', 4),
      node('sch:int', 'schema', 'INTERMEDIATE_T2'),
      node('ds:t1', 'dataset', 'int_clean_orders_t1', 4),
      node('ds:fact', 'dataset', 'fact_orders', 2),
      ...t1cols.map(c => node(`col:t1.${c}`, 'column', c)),
      ...t1cols.map(c => node(`col:t2.${c}`, 'column', c)),
      node('col:fact.total_amount', 'column', 'total_amount'),
      node('col:fact.gross_profit', 'column', 'gross_profit'),
    ],
    edges: [
      ...t1cols.map(c => edge(`col:t1.${c}`, `col:t2.${c}`, 'FLOWS_TO')),
      edge('col:t2.total_amount', 'col:fact.total_amount', 'FLOWS_TO'),
      edge('col:t2.net_revenue', 'col:fact.gross_profit', 'FLOWS_TO'),
    ],
    containment: [
      edge('sch:int', 'ds:t2', 'CONTAINS'),
      ...t1cols.map(c => edge('ds:t1', `col:t1.${c}`, 'CONTAINS')),
      ...t1cols.map(c => edge('ds:t2', `col:t2.${c}`, 'CONTAINS')),
      edge('ds:fact', 'col:fact.total_amount', 'CONTAINS'),
      edge('ds:fact', 'col:fact.gross_profit', 'CONTAINS'),
    ],
    degrees: {
      'ds:t2': { in: 0, out: 0 },
      'col:t2.total_amount': { in: 1, out: 1 },
      'col:t2.net_revenue': { in: 1, out: 1 },
      'col:t1.total_amount': { in: 3, out: 1 },
    },
  }
  return { focal: 'ds:t2', world }
}

export const FIXTURES: Record<string, () => { focal: string; world: HarnessWorld }> = {
  app: appFixture,
  coarse: coarseFixture,
  'deep-walk': deepWalkFixture,
  drill: drillFixture,
  domains: domainsFixture,
  columns: columnsFixture,
}
