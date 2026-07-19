# Context Engine

The Context Engine is the central query orchestrator in {brand}. It binds a
workspace's graph provider and its resolved ontology together, so every read —
nodes, edges, children, lineage, traces, aggregated edges, schema — runs against
a correctly configured provider with the workspace's semantic model applied.

Related reading: [Platform Services](/docs/services-overview),
[Backend guide](/docs/backend), [Assignment Engine](/docs/services-assignments),
[Aggregation pipeline](/docs/aggregation-pipeline).

## Purpose / What it does

`ContextEngine` (`backend/app/services/context_engine.py`) is the layer between
the API and the raw graph provider. Its core job is to resolve the workspace's
**ontology** — the semantic schema of entity and relationship types — and push
it into the provider before any query runs, then orchestrate the actual reads.

Ontology resolution is **three-layer**: system defaults + workspace-assigned
definitions + provider-introspected types, assembled into a single resolved
ontology and cached for 5 minutes per engine instance. Resolution also injects
the authoritative **containment edge types** into the provider, which is what
lets containment-aware queries (child counts, parent lookups, top-level roots)
work correctly. Resolution is eager (so call sites that hit
`engine.provider.*` directly still see a configured provider) and non-fatal on
failure (the engine still returns so the endpoint can surface a clean error and
retry once the cache TTL rolls).

On top of ontology resolution, the engine exposes the read surface the product
is built on, including:

- Node / edge reads and queries (`get_nodes_query`, `get_edges`,
  `get_children_with_edges`, `get_top_level_or_orphan_nodes`).
- Lineage and tracing (`get_lineage`, `trace`, `get_trace_v2`,
  `get_trace_delta_v2`, `expand_aggregated_edge`).
- Aggregated edges (`get_aggregated_edges`, `materialize_aggregated_edges`).
- Schema and stats (`get_graph_schema`, `get_schema_stats`, `get_stats`).

### Context models and context lenses

A **context lens** (product term) is a saved view configuration that highlights a
specific aspect of lineage — a data domain, a pipeline stage, an ownership
boundary — without modifying the underlying graph. A **context model** is the
reusable layer configuration behind it: how entities are grouped into layers and
displayed.

The Context Engine is what makes lenses meaningful: it applies the resolved
ontology (containment, granularity, lineage semantics) that layer grouping and
lineage aggregation depend on. Context-model **instances** are retired — layers
and entity assignments now live on the view config
(`view.config.layout.referenceLayout`). What remains as first-class,
independently managed objects are the reusable **Quick Start Templates**, exposed
through the context-model template endpoints below. Turning a view's layer
configuration into actual per-entity placements is the job of the
[Assignment Engine](/docs/services-assignments).

## Where it runs

The Context Engine is a **library / orchestration layer, not a standalone
process**. It is instantiated per request or per job wherever graph access
happens:

- In the **WEB** role, via the `get_context_engine` FastAPI dependency, backing
  the graph, canvas, search, and assignment endpoints.
- In the **insights service**, via `ContextEngine.for_workspace(...)`, to run
  stats collection and schema profiling.
- In the **aggregation worker**, for lineage projection and aggregated-edge
  materialization.

The factory `ContextEngine.for_workspace(workspace_id, registry, session,
data_source_id=...)` scopes an engine to one workspace data source and resolves
its ontology on construction.

## Key endpoints

The engine has no dedicated router of its own — it powers the workspace-scoped
graph endpoints. Representative routes (under `/api/v1/{ws_id}/graph`, requiring
`workspace:datasource:read`) include node/edge queries, `/nodes/top-level`,
`/nodes/{urn}/children-with-edges`, lineage/trace, and aggregated edges.

Context-model templates (the reusable layer configs behind lenses):

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/{ws_id}/context-models/templates` | List Quick Start Templates available to a workspace (read-only). |
| GET | `/api/v1/{ws_id}/context-models/templates/{template_id}` | Get a single template. |
| GET/POST/PUT/DELETE | `/api/v1/admin/context-model-templates[/{id}]` | Full template CRUD (requires `system:admin`). |

## Configuration

- **Ontology cache TTL** is 5 minutes per engine instance (`_ONTOLOGY_CACHE_TTL`),
  after which the ontology is re-resolved on the next call.
- The active **graph provider** (FalkorDB / Neo4j / DataHub / Spanner) is
  selected by the data source's provider binding, not by the engine.
- Read timeouts, trace headroom, and aggregated-read budgets come from the shared
  resilience configuration (e.g. `TRACE_TIMEOUT_SECS`,
  `FALKORDB_AGGREGATED_READ_TIMEOUT_SECS`), applied uniformly whether a call
  originates from the web tier or a background worker.

## How it appears in the product

Every graph the user explores in the canvas is served through the Context Engine:
the top-level entry list, expanding children, lineage traces, aggregated
rollups, and the schema panel all flow through it. Context lenses (saved view
configurations) reshape what the user sees on top of the same engine-served
graph, without changing the underlying data.

## Limitations

- The 5-minute ontology cache means a just-changed ontology can take up to one
  TTL to be reflected by an already-warm engine instance.
- Ontology resolution is best-effort: if resolution fails, the engine still
  constructs, and containment-dependent queries may fall back or error until a
  later resolution succeeds.
- The engine is stateful per instance (its ontology cache), so it is created per
  request/job rather than shared as a long-lived singleton.
- Not every provider supports every operation identically; provider capability
  differences (e.g. advanced search) surface at the call site, not in the engine.
