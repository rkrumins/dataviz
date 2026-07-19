# Assignment Engine

The Assignment Engine decides which **layer** each entity belongs to when a view
is rendered. Given a view's layer configuration and the set of entities on the
canvas, it computes a placement for every entity — the step that turns a context
lens's layer rules into concrete per-entity assignments.

Related reading: [Platform Services](/docs/services-overview),
[Context Engine](/docs/services-context-engine), [Backend guide](/docs/backend).

## Purpose / What it does

`AssignmentEngine.compute_assignments` (`backend/app/services/assignment_engine.py`)
takes a `LayerAssignmentRequest` (the view's layers + rules + any explicit
placements) and a workspace-scoped `ContextEngine`, and returns a
`LayerAssignmentResult`: the per-entity assignment map, the parent map, the
in-scope edges, the list of unassigned entities, and timing/coverage stats.

**Scope is exactly the rendered set — never the whole graph.** The engine reads
only the entities the caller is placing: `request.urns` (the canvas's loaded set,
ancestors included) or, for legacy callers, the keys of `request.assignments`.
Each scope is read completely (node limit = scope size) so no rendered entity is
clipped; edges are read only among the scope. If there is no scope and nothing
being placed, it returns empty rather than scan the graph.

Placement follows a fixed **precedence**:

1. **Explicit assignment** — an entity named directly in the request's
   `assignments` map or a legacy per-layer `entity_assignments` (all scopes).
2. **Containment inheritance** — inherit the parent's resolved layer, unless the
   parent's explicit assignment set `inheritsChildren = false` (all scopes).
3. **Node's own persisted `layerAssignment`** — the per-entity hint stamped by
   explicit create/move actions (open scope only).
4. **Generic rules** — type / tag / URN-pattern rules, highest priority wins
   (open scope only).
5. **Default** — `layers[0]` (open scope only).

In **curated scope**, only tiers 1–2 apply; anything that falls through is left
unassigned. Containment direction comes from the resolved ontology's
**containment edge types** (not hardcoded), which is why the engine resolves the
ontology through the `ContextEngine` before building the parent map.

### Ontology mapping (foreign-schema mapping)

When a data source points at a graph that wasn't populated by {brand} — for
example an existing Neo4j database whose nodes use `uuid` / `title` / `name`
instead of the canonical `urn` / `displayName` / `qualifiedName` — a
`SchemaMapping` (`backend/graph/adapters/schema_mapping.py`) describes the
translation so the provider can query and hydrate `GraphNode` / `GraphEdge`
objects transparently. Configuration lives in `extra_config.schemaMapping` on
either the Provider (a shared default) or the WorkspaceDataSource (a per-workspace
override); the DataSource-level mapping wins when both are present. Defaults match
{brandShort}'s own property schema, so no mapping is needed for graphs written by
the platform. This mapping is what makes an entity's type, tags, and identity
resolvable — the same fields the Assignment Engine's type/tag/pattern rules key
on.

## Where it runs

Assignment compute runs **in the WEB role**, workspace-scoped, driven from the
canvas. The endpoint resolves a `ContextEngine` via `get_context_engine` and
passes it into `compute_assignments`, guaranteeing the ontology (and its
containment edge types) is resolved before any provider call. Results are routed
through the graph cache: a given `(workspace, data_source, request)` is
deterministic, so repeat calls with the same layer config hit Redis instead of
the provider, and the same generation counter that invalidates other graph-cache
entries invalidates this one.

## Key endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/v1/{ws_id}/graph/assignments/compute` | `workspace:datasource:read` (router) + workspace-manage check in the handler | Compute layer assignments for the entities in the request and return a `LayerAssignmentResult`. |

The response includes `assignments` (entity → layer), `parentMap`, `edges` (when
requested), `unassignedEntityIds`, and `stats` (`totalNodes`, `assignedNodes`,
`computeTimeMs`, `truncated`). The response also carries an `X-Provider-Health`
header, and `X-Cache-Status: stale-fallback` when a cached result was served
under provider stress.

## Configuration

The Assignment Engine has no dedicated environment knobs; its behavior is driven
by request input (layers, rules, scope) and the resolved ontology. Relevant
surrounding configuration:

- **Containment edge types** come from ontology resolution in the Context Engine
  (5-minute cache). An empty set is valid and means "flat graph, no hierarchy" —
  it is not treated as "unresolved."
- **Edge read cap** for a scope is `max(len(scope) * 8, 10000)`; exceeding it sets
  `stats.truncated = true` (it never silently drops a needed edge for a normal
  view).
- **Schema mapping** is configured per Provider / DataSource via
  `extra_config.schemaMapping` (see above), not via environment variables.

## How it appears in the product

Assignment results determine which layer/lane each entity renders in on the graph
canvas. When a user opens a view, changes its layer configuration in Layer Studio,
or moves an entity between layers, the computed assignments drive the placement.
Explicit moves are persisted onto the entity's `layerAssignment` so they survive
reload (tier 3 above) rather than snapping back to a type-rule layer.

## Limitations

- Assignment covers only the rendered scope. It deliberately does **not** assign
  layers across the whole graph — a whole-graph pass would be slow and, when
  capped, lossy.
- Curated-scope views leave anything outside explicit assignment + containment
  inheritance unassigned by design.
- The containment-direction heuristic assumes `BELONGS_TO`-style edges point
  child→parent and other containment edges point parent→child; unusual custom
  containment semantics may need explicit ontology configuration.
- If a scope's intra-view edges exceed the edge cap, `stats.truncated` flags it
  rather than failing — a signal to narrow the view, not a silent data loss.
