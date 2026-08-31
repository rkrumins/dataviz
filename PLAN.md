# Current State & What's Next

**What this is:** a current-state snapshot of the platform — what's built today and the short list of work still ahead. **Who it's for:** contributors and stakeholders who want the honest picture without wading through the full docs.

The platform is a data-lineage system: it connects to graph
databases, overlays user-defined business ontologies onto physical technical metadata,
and renders interactive lineage on a canvas. For deeper detail on any area, see the docs under
[`docs/`](docs/) and the [CHANGELOG](CHANGELOG.md).

---

## Built today

### Graph & providers

- **FalkorDB** is the default graph store (Redis protocol). **Neo4j**, **DataHub**, and
  **Google Cloud Spanner Graph** are supported through the `GraphDataProvider` interface,
  each wrapped in a circuit breaker.
- Provider types register **once**, in a catalog (`backend/common/providers/catalog/`),
  which drives construction, capability gating, connection validation, the admin API
  and the onboarding wizard — so adding an engine is one registration plus a handful of
  declarative entries, each named by a failing test.
- Management state (users, workspaces, providers, ontologies, views) lives in
  **PostgreSQL** in production and **SQLite** for the local quickstart. **Redis** backs
  cache, sessions, and job streams.

### Semantic layer & aggregation

- **Ontology / semantic-layer system** — entity and relationship types that classify
  graph edges as containment (structural) vs lineage (functional), scoped to workspaces.
- **Aggregation pipeline** — a background worker materializes summary `AGGREGATED` edges
  so million-node graphs can be navigated at any zoom level without live traversal.
  Cursor-based batching, Postgres checkpoints, and crash-resumable jobs.
- **Insights service** — cache-only pre-registration discovery (per-asset stats and
  previews) that never blocks the web tier on provider I/O.

### Graph versioning

Version control for a data graph, verified end to end against a live **7.7M-entity**
graph:

- Drafts, review, and **merge / pull-request** flow; publish.
- **Revert / restore** — undo a single published revision, or restore the graph to an
  earlier point. Both append a new revision; history is never rewritten.
- **Resumable enable-version-control bootstrap** — turning on versioning for an existing
  data source runs as a background job that resumes from checkpoint after a crash and
  proves itself with an integrity report before anything goes live.
- **Admin master switch** — `Admin → Features → Version control` turns the whole feature
  off; existing versioned graphs stay viewable, read-only.
- Operator visibility for running, stalled, or failed enable-VC copies under
  `/admin/infrastructure`.

### Access & identity

- **RBAC** with eight roles and workspace-scoped permissions.
- **SSO** via OIDC and SAML2.

### Canvas & views

- **Lineage Lens / Context View** — the interactive canvas lineage lens.
- **Layer Strip** with resizable layer columns and one-page-ahead pagination.
- **External-degree curated-view signal** (`GET /nodes/degree`) for surfacing high-degree
  nodes in curated views.

---

## What's next

A short, grounded roadmap. Detail lives in the linked docs.

- **Re-sync at any scale.** Re-sync currently holds the whole graph in memory and is
  guarded above `GRAPHVER_RESYNC_MAX_ENTITIES` (default 250,000). The streaming design
  that removes the guard is written up in
  [`docs/versioning/11-resync-at-any-scale.md`](docs/versioning/11-resync-at-any-scale.md).
- **Version control beyond FalkorDB.** Enabling versioning is FalkorDB-only today; other
  providers are refused with a clear `422`. Extending the copy path to other providers is
  future work.
- **Integrity fingerprint at scale.** The Merkle root is deferred above 1,000,000 entities
  rather than built in memory; the full integrity checks still run.
