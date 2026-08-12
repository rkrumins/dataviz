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

export const FIXTURES: Record<string, () => { focal: string; world: HarnessWorld }> = {
  app: appFixture,
  coarse: coarseFixture,
  'deep-walk': deepWalkFixture,
  drill: drillFixture,
}
