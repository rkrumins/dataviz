# Current State & What's Next

**What this is:** a current-state snapshot of the platform — what's built today and the short list of work still ahead. **Who it's for:** contributors and stakeholders who want the honest picture without wading through the full docs.

**As of 2026-10-09** (`42cae50`).

The platform is a data-lineage system: it connects to graph
databases, overlays user-defined business ontologies onto physical technical metadata,
and renders interactive lineage on a canvas. For deeper detail on any area, see the docs under
[`docs/`](docs/) and the [CHANGELOG](CHANGELOG.md); for what is wrong today, see the
[technical-debt register](docs/TECHNICAL_DEBT.md).

---

## Built today

### Graph & providers

- **FalkorDB** is the default graph store (Redis protocol), as a single instance or a
  sharded cluster. **Neo4j** and **Google Cloud Spanner Graph** are supported through the
  `GraphDataProvider` interface. **DataHub** is a connectivity adapter — ping, stats and
  basic lineage; its other reads are not implemented. Every provider sits behind a circuit
  breaker, per-data-source admission control and a fleet-wide slot per graph.
- Management state (users, workspaces, providers, ontologies, views) lives in
  **PostgreSQL**, the only supported management database. **Redis** backs cache, sessions,
  revocation and job streams.

### Semantic layer, aggregation & freshness

- **Ontology / semantic-layer system** — entity and relationship types that classify
  graph edges as containment (structural) vs lineage (functional), scoped to workspaces.
- **Aggregation pipeline** — a background worker materializes summary `AGGREGATED` edges
  so million-node graphs can be navigated at any zoom level without live traversal.
  Cursor-based batching, Postgres checkpoints, and crash-resumable jobs, with an automatic
  reconciliation sweep that keeps rollups matching each source.
- **Data freshness** — a drift probe notices an external load within about a minute, and
  `POST /api/v1/admin/data-sources/{id}/refresh` lets a pipeline say a source changed.
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
- **Import and export at scale** — imports up to 10 GB and exports up to 50 GB run on the
  versioning worker, off the web servers; exports stream to the object store and download
  in pieces that resume.
- **View portability** — views move between environments as a file or a package, and keep
  their version history.

### Access & identity

- **RBAC** with eight built-in roles (four global, four workspace-scoped), custom roles,
  group bindings, and per-view sharing.
- **SSO** via OIDC and SAML 2.0, plus a corporate-portal profile handoff and an
  enterprise-gateway back-channel; just-in-time provisioning, IdP-group-to-role mapping,
  and sessions that keep two deployments apart in one browser.
- Invite links, and sign-up with admin approval.

### Canvas, views & analytics

- **Context View canvas** — the Layer Strip (jump, drag-to-pan, fit), resizable layer
  columns whose widths a draft saves into the view, root pagination past 200 per layer,
  and an off-screen partner rail.
- **Lineage Lens** — one-hop and full-flow walks, direction and entity-type filters, a
  graph view with a minimap, and share links.
- **Trace** — one entity, or up to 25 at once as a single picture, drawn on the canvas
  itself.
- **External-degree signal** (`POST /api/v1/{ws_id}/graph/nodes/degree`) — each card's
  lineage ports, and the "outside this view" count in curated views.
- **Advanced Search and Display Rules**, with per-view libraries that export, import, and
  publish to every view of a data source.
- **Analytics** at `/analytics` — growth, engagement, content and health, for holders of
  `system:analytics:read`.
- **Branding** — name, logo, favicon, accent colour and support contact, set in the app.

### Operations

- Web, worker, control-plane, versioning-worker and stats processes run as separate
  services in Compose and in the Kubernetes manifests, which add autoscaling and a
  production overlay with a two-replica control plane and a sharded FalkorDB option. The
  Helm chart lags them (see the register, §1.5).
- A Prometheus-format `/metrics` endpoint (off by default), a load-test harness with
  written pass/fail criteria, and a guide to sizing for ~100 to ~1,000+ concurrent users.

---

## In preview

Shipped behind a feature flag that is off by default.

- **One placement rule for every view surface** (`placementContractEnabled`) — the server,
  the canvas, the wizard, Layer Studio, trace, search badges, Build Mode and import agree on
  which layer an entity belongs to. Run `python -m backend.scripts.placement_dry_run`
  before turning it on; `docs/services/ASSIGNMENTS.md` has the runbook.

---

## What's next

A short, grounded roadmap. Detail lives in the linked docs.

- **The register's §1 before new features.** Production safeguards that no shipped config
  turns on, the connection-tester SSRF, FalkorDB persistence on Kubernetes that nobody has
  checked, metrics that nothing scrapes, gaps in both Kubernetes deploy paths (no migration
  step in the kustomize manifests, no versioning worker in the Helm chart), and a setup
  script that can overwrite live secrets — see
  [`docs/TECHNICAL_DEBT.md`](docs/TECHNICAL_DEBT.md), which also sets the order.
- **Server-side membership for the placement contract.** Export, scoped replace, the search
  Layer filter, open-view type feeds and column totals keep the old placement rules until
  membership moves to the server, which is what lets the flag default on.
- **Re-sync at any scale.** Re-sync is refused above `GRAPHVER_RESYNC_MAX_ENTITIES`
  (default 250,000). The bounded merge from
  [`docs/versioning/11-resync-at-any-scale.md`](docs/versioning/11-resync-at-any-scale.md)
  is already the live code, but the test that proves it on a graph the bootstrap worker
  wrote does not exist yet — that comes first (register §2.8). Then: streaming the provider
  snapshot, and a background re-sync job, before the guard can go.
- **Version control beyond FalkorDB.** Enabling versioning is FalkorDB-only today; other
  providers are refused with a clear `422`. Extending the copy path to other providers is
  future work.
- **The versioned store at scale.** Incremental Merkle for draft checkpoints, pulls and
  forks; retention for superseded versions; and the partition-key decision, which has to
  be made before the first large tenant —
  [`docs/versioning/09-scale-limits-and-roadmap.md`](docs/versioning/09-scale-limits-and-roadmap.md) §10.
- **Integrity fingerprint at scale.** The Merkle root is deferred above 1,000,000 entities
  rather than built in memory; the full integrity checks still run.
- **Imports and exports that resume.** An interrupted job still starts over, and there is
  no native S3 or GCS object store yet.
