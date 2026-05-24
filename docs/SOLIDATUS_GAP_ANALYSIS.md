# Synodic vs Solidatus — Independent Gap Analysis

> **Status:** Independent review, May 2026.
> **Audience:** Synodic platform leads, product, engineering managers.
> **Tone:** Frank, calibrated, focused on functionality. Not a buying recommendation.

---

## 1. Purpose & Methodology

### Why this exists

The existing competitive table in `docs/OVERVIEW.md` benchmarks Synodic against
open-source catalog/lineage tools (DataHub, Atlas, Marquez, Amundsen). It does
**not** benchmark against [Solidatus](https://www.solidatus.com), which is the
closest commercial competitor to what Synodic is trying to be — an interactive,
model-first lineage and governance product — and the de-facto benchmark in
regulated industries (BCBS 239, GDPR, FINRA, financial services more broadly).

If Synodic's commercial ambition includes any of those buyers, **the
Solidatus comparison is the one that matters**. This document fills that gap.

### What Solidatus is, in one paragraph

Solidatus is a SaaS / on-prem data lineage and governance platform whose
distinguishing trait is **the model is the source of truth**. Lineage is
authored — by humans, by import, by API — into a versioned, branchable,
diff-able model. Visualization is a consequence of the model, not a query
over it. Its commercial moats are: rich manual modeling UX with custom
attributes on every entity; Git-like branching with visual diff and
time-travel; deep Excel/CSV ingestion (the workhorse for regulatory
projects); lenses for attribute-driven logical views; PNG/PDF/SVG export
and embeddable views; mature collaboration (comments, approvals, ownership);
and regulatory reporting templates. The pitch lands hardest in firms where
lineage is a **compliance artifact** that must be authored, attested,
versioned, and reported on — not just discovered.

### How this evaluation was done

- **Synodic side**: code reading of the current branch
  (`claude/solidatus-feature-gaps-QwgCE` at the time of writing,
  parent of `main`). Every "current state" claim cites a file path.
  Where a feature could exist as configuration-only (no code path),
  it is marked as "unverified".
- **Solidatus side**: based on publicly documented product features,
  vendor materials, and standard market positioning. Not based on a live
  demo or licensed evaluation. Solidatus capabilities that are widely
  documented (Excel import, branching, comments, PNG export, REST API)
  are stated as fact; less certain claims are hedged with "typically".
- **Severity** reflects *displacement readiness* — i.e., "can Synodic
  credibly enter a Solidatus deal without this?" — not absolute product
  quality. A "Missing — Critical" gap means *no*, not *bad*.
- **Non-goals**: this is not a buying recommendation, not a demand for
  feature parity, and not a critique of Synodic's technical execution.
  Many gaps are deliberate scope choices that the team should evaluate,
  not regret.

### Glossary used in this doc

| Term         | Meaning here                                                    |
|--------------|-----------------------------------------------------------------|
| **Meets**    | Synodic has comparable capability in production code.           |
| **Partial**  | Synodic has the substrate but not the full Solidatus UX/feature.|
| **Missing**  | No equivalent implementation. May or may not be on the roadmap. |
| **Severity** | Critical / High / Medium / Low — for displacing Solidatus deals.|
| **Effort**   | S (≤1wk) / M (1-4wk) / L (1-3mo) / XL (>3mo) — rough order.     |

---

## 2. Executive Summary

### The headline

Synodic is competitive with Solidatus on **architecture, multi-backend
flexibility, ontology governance, and modern UX foundations** — and is
genuinely ahead on a few axes (provider abstraction, persona toggle,
workspace-native multi-tenancy, three-layer ontology resolution).

It is materially behind on the **model-authoring lifecycle** that defines
Solidatus's value to regulated customers: bulk model authoring (Excel/CSV),
custom attributes as a first-class UX, comments and approval workflows,
visual diff and time-travel, PNG/PDF export, and regulatory reporting.

Most gaps are addressable on top of the existing architecture — the
ontology system, ContextModel primitive, RBAC, and graph mutation API are
strong extension points. **Two gaps are architectural** (model-first
authoring as the primary loop, and graph-data time-travel) and should be
debated before being committed to. They may not be the right strategy.

### Gap heat map (10 capability domains)

| # | Domain                              | Verdict   | Severity | Top gap                                         |
|---|-------------------------------------|-----------|----------|-------------------------------------------------|
| 1 | Model Authoring                     | Partial   | Critical | No CSV/Excel import; no first-class custom attrs|
| 2 | Version Control & History           | Partial   | High     | Ontology-only versioning; no graph-data branch  |
| 3 | Visualization & Layout              | Meets     | —        | Manual layout persistence needs verification    |
| 4 | Lenses / Filters / Conditional Fmt  | Partial   | High     | Filter primitives exist; no conditional format  |
| 5 | Lineage Analysis                    | Partial   | Medium   | No graph-data impact reports; ontology-only     |
| 6 | Collaboration & Workflow            | Partial   | Critical | No comments; no graph-change approvals          |
| 7 | Reporting & Export                  | Missing   | Critical | No PNG/PDF/SVG export; no regulatory templates  |
| 8 | Integration & API                   | Partial   | High     | No webhooks; no ETL/BI connectors; no real-time |
| 9 | Governance Overlays                 | Missing   | High     | No DQ overlay; no glossary; no sensitivity tags |
| 10| Enterprise Readiness                | Partial   | High     | No SSO; weak default security (acknowledged)    |

### Top 5 highest-value uplifts

These five close the largest commercial gap relative to Solidatus per unit of
engineering investment. Each maps to an existing extension point in Synodic;
none require greenfield rewrites.

1. **CSV / Excel import for graph data** *(Effort: M)* — Unlocks the
   regulated-industry workflow Solidatus is famous for. Extend
   `POST /graph/commands/batch` with a spreadsheet adapter; reuse the
   ontology to validate types.
2. **Comments and discussions on graph entities** *(Effort: M)* — The single
   most-cited missing collaboration feature. New `EntityCommentORM`,
   thread API, sidebar UI on the canvas.
3. **PNG / SVG / PDF export from the canvas** *(Effort: S–M)* — Table stakes
   for any tool whose output is shown to regulators or executives. Hooks
   into the existing ReactFlow canvas via `toBlob`/`html2canvas` and a
   server-side print endpoint for PDF.
4. **First-class custom attributes UX** *(Effort: M)* — The data model
   already carries `properties: Dict[str, Any]` and `tags` on
   `GraphNode`/`GraphEdge`. The missing piece is the UX: schema-defined
   custom attributes per entity type in the ontology, with edit/filter/
   color-by-attribute in the canvas. Promotes existing latent capability.
5. **Full user-action audit log** *(Effort: M)* — `OntologyAuditLogORM`
   only audits ontology changes. Extend the pattern to cover view
   changes, RBAC mutations, data-source bindings, graph mutations, and
   access-request decisions. Mandatory for any regulated customer.

The rest of the document defends these calls.

---

## 3. Capability-by-Capability Review

### 3.1 Model Authoring  ·  **Verdict: Partial · Severity: Critical**

#### What Solidatus does

- **Drag-and-drop authoring** of lineage as a primary workflow. The platform
  is built for an analyst to model lineage from scratch, not just visualize
  what already exists.
- **Excel/CSV bulk import** — typically the workhorse for large regulatory
  builds. Sheets define nodes, edges, attributes, and groupings; imports
  are idempotent and diff-aware.
- **Custom user-defined attributes** on every node, edge, and group, with
  type metadata (string/number/date/enum) and validation rules.
- **Inline + bulk attribute editing** in the canvas and via attribute
  spreadsheet views.
- **Model templates** for common architectures (data warehouse, regulatory
  report build, ETL pipeline) so authors start from a structured starting
  point.

#### What Synodic does today

- **Manual node/edge creation via API** exists:
  `POST /graph/nodes/create`, `POST /graph/edges`, `PATCH /graph/edges/{id}`,
  `DELETE /graph/edges/{id}` — `backend/app/api/v1/endpoints/graph.py:1239-1297`.
- **Batch mutations** via `POST /graph/commands/batch`
  (`graph.py:1320`) — strong substrate for an import adapter.
- **Frontend authoring primitives** exist on the canvas:
  `QuickCreateNode.tsx`, `InlineNodeEditor.tsx`, `NodePalette.tsx`,
  `CanvasContextMenu.tsx` — all under
  `frontend/src/components/canvas/`. So Synodic *can* author manually;
  the workflow exists but is not framed as the primary loop.
- **Custom attributes substrate** is present:
  `GraphNode` carries `properties: Dict[str, Any]` and `tags: List[str]`
  (`backend/common/models/graph.py:31-32`); `GraphEdge` carries
  `properties` (no `tags` on edges — `graph.py:47`).
  `NodeQuery` supports `property_filters`, `tag_filters`, `name_filter`
  with operators (`equals`, `contains`, `startsWith`, `gt`, `in`,
  `exists`, etc.) — `graph.py:55-75`. **The data layer is there.**
- **What's missing** at the UX/ontology layer:
  - No CSV/Excel import. `grep -RIl "csv|excel|xlsx|openpyxl"
    backend/app/` returns zero matches.
  - Custom attributes are free-form `properties`. The ontology system
    defines entity types and relationships, but does not formally declare
    per-type attribute schemas the way Solidatus does (typed attributes,
    enums, required/optional, validators).
  - No "attribute editor" UX promoting custom attributes to first-class
    citizens in the canvas. Properties are bag-of-keys, not modeled.
  - No model templates (the closest thing is **ontology** templates and
    `ContextModel` templates via `context_models.py:113-160`, but these
    are schema / view layouts, not lineage model starting points).

#### Why this matters

The Solidatus sale to regulated buyers — banks, insurers, pharma — is
fundamentally "import 20 spreadsheets of upstream lineage submitted by 14
teams, then version and attest the resulting model." Synodic does not have
the import side of this loop. Without it, Synodic is not a credible
replacement in those deals, regardless of how good the canvas is.

#### Suggested uplift

1. **CSV/Excel import adapter** (Effort: M). Define a sheet schema
   (`nodes`, `edges`, `attributes` tabs), reuse the ontology for type
   validation, surface a wizard that previews adds/updates/conflicts
   before committing through `POST /graph/commands/batch`. Idempotency
   via deterministic URN derivation.
2. **Typed attributes in the ontology** (Effort: M). Extend the
   ontology entity-type schema to declare attribute names, types
   (string/int/date/enum), and required-ness. Validate on
   create/update. The existing `OntologyORM` (`backend/app/db/models.py:281`)
   and its versioning lifecycle handle the governance side cleanly.
3. **Attribute editor surface in canvas** (Effort: S–M). Render typed
   attributes in `InlineNodeEditor.tsx`, expose them in
   `NodeQuery.property_filters` autocomplete, and persist edits via
   the existing graph mutation API.

---

### 3.2 Version Control & History  ·  **Verdict: Partial · Severity: High**

#### What Solidatus does

- **Git-like model branching** — create a branch from any model state,
  edit independently, merge back with conflict resolution.
- **Visual diff** between two model versions or branches — additions,
  removals, attribute changes rendered on the graph.
- **Time-travel** — view the model as it existed on any prior date,
  with the canvas rendering the historical state.
- **Pull-request-style change proposals** — author a change set, request
  review, approve/reject, merge with attribution.
- **Full audit trail** with diffs per change, actor, and timestamp.

#### What Synodic does today

- **Ontology versioning is excellent**: draft → validate → impact-analyze
  → publish → clone-to-new-draft, with immutable published versions.
  See `backend/app/api/v1/endpoints/ontologies.py` — `publish_ontology`
  (line 227), `clone_ontology` (line 255), `create_new_version` (line 286),
  `validate_ontology_endpoint` (line 318), `get_ontology_impact` (line 443).
- **Ontology audit log** is rich and queryable:
  `OntologyAuditLogORM` (`backend/app/db/models.py:345`) with
  `GET /api/v1/admin/ontologies/{id}/audit` (line 545), described as
  *"Paginated, newest first. Includes change diffs and actor information."*
- **View versioning is implicit, not explicit**: `ViewORM` has
  `ontology_digest` (`models.py:631`) to detect ontology drift when a
  view's underlying schema has changed, but views themselves don't
  version their config — updates overwrite.
- **No branching of graph data**. The graph in FalkorDB/Neo4j is a single
  mutable state. Cypher writes apply directly; there is no concept of
  alternative branches or proposed-change overlays.
- **No diff/compare UI** for any artifact. Ontology audit shows JSON
  diffs in the log API; there is no visual canvas diff.
- **No time-travel.** Once data is mutated, prior state is not retrievable
  from the graph layer. The `OutboxEventORM` (`models.py:1436`) could in
  principle support event-sourcing replay, but there is no replay
  implementation today.

#### Why this matters

For regulated customers, lineage is an **attestable artifact**. "What did
the lineage model say on Q3 2024 reporting date?" must be answerable.
Synodic answers this for ontologies (immutable published versions) but
not for the lineage data itself. The audit log is also ontology-only —
no record of who changed which graph node when.

#### Suggested uplift

1. **Workspace-wide audit log** (Effort: M). Generalize the
   `OntologyAuditLogORM` pattern into an `ActionAuditLogORM` covering
   view edits, RBAC mutations, data-source bindings, graph mutations
   (create/update/delete node/edge), access-request decisions. Use the
   existing `OutboxEventORM` for async write to avoid hot-path latency.
2. **View versioning** (Effort: S). Add a `view_versions` table with
   immutable snapshots of `config` JSON, keyed by view + timestamp +
   actor. Cheap, high-value for "what did this dashboard show last
   month".
3. **Graph snapshot / diff for ontology publish** (Effort: L). At
   ontology publish time, snapshot affected entity-type counts and
   sample URNs. Render a diff view between two snapshots. Enables
   "what changed in the model between publishes" without full
   event-sourced time travel.
4. **Full graph-data time-travel** (Effort: XL, architectural). Would
   require event-sourcing the graph layer or replaying outbox events
   into a snapshot store. **Worth debating before committing** — it
   contradicts the current introspection-first design. May be cheaper
   to integrate with provider-side temporal features (e.g., Neo4j 5.x
   schema history) than to build it natively.

---

### 3.3 Visualization & Layout  ·  **Verdict: Meets · Severity: —**

#### What Solidatus does

- Manual layout that **persists** across sessions and is **shareable**.
- Multiple layout algorithms (hierarchical, force, manual).
- Edge bundling / connection channels to reduce visual noise.
- Nested containment hierarchies rendered visually (group within group).
- Subgraph extraction (export a focused sub-view).
- Bookmarkable canvas state with deep-linking.

#### What Synodic does today

- **ELK-based layout in a Web Worker** for responsive rendering of
  large graphs — described in `docs/OVERVIEW.md` and grounded in the
  `frontend/src/components/canvas/` tree (`GraphCanvas.tsx`,
  `HierarchyCanvas.tsx`, `ContextViewCanvas.tsx`).
- **Multiple canvas variants** in code:
  `CanvasRouter.tsx`, `GraphCanvas.tsx`, `HierarchyCanvas.tsx`,
  `ReferenceModelCanvas.tsx`, `ContextViewCanvas.tsx` — indicating
  the canvas is genuinely multi-mode.
- **Containment hierarchy** is first-class:
  `get_node_parent`, `get_node_children`, `get_node_ancestors`,
  `get_node_descendants` in `graph.py` (lines 530, 544, 714, 724).
- **Views save canvas state** — `ViewORM.config` (`models.py:626`)
  is a JSON blob of full `ViewConfiguration`, with workspace + data
  source + visibility scoping, deep-linkable by view ID.
- **Multi-granularity LOD** via aggregated edges — coarse rollups at
  domain level, fine-grained at column level. Genuinely strong, and
  arguably ahead of Solidatus's typical static rendering.

#### Gaps and uplift

- **Manual layout persistence**: needs verification. The plan was to
  spot-check whether positions edited by a user in `GraphCanvas.tsx`
  survive across sessions. If they do — Meets. If they don't — Partial,
  small effort to fix (persist xy in `ViewORM.config`).
- **Edge bundling / channels**: not visible in the canvas code. ReactFlow
  doesn't bundle natively; would need a custom edge renderer. Low
  severity — nice-to-have.
- **Subgraph export**: views capture state, but there is no "export this
  subgraph as a new model/file" flow distinct from view save.
  Low severity unless paired with export-to-image (see §3.7).

---

### 3.4 Lenses, Filters & Conditional Formatting  ·  **Verdict: Partial · Severity: High**

#### What Solidatus does

- **Lenses** — saved attribute-driven logical views over the same model.
  A user can switch from "Regulatory lens" (BCBS 239 metadata) to
  "Technical lens" (system attributes) without changing the underlying
  model.
- **Conditional formatting / color-by-attribute** — node fill and edge
  color driven by attribute predicates ("color red if `pii=true`").
- **Show/hide predicates** — filter visibility by any attribute combination.
- **Per-user filter state** — my filters persist across sessions; teammates
  see theirs.
- **Lens templates** — share lens definitions across workspaces.

#### What Synodic does today

- **ContextModel is the closest analogue.** See `ContextModelORM`
  (`backend/app/db/models.py:551`):
  - `layers_config: JSON` — layered organization.
  - `scope_filter: JSON` — predicate for what's in scope.
  - `instance_assignments: JSON` — entity → layer mapping.
  - `scope_edge_config: JSON` — edge filter config.
  - `is_template: bool` — global template flag.
  - `category: str` — e.g., "data-engineering".
  - Endpoints in `backend/app/api/v1/endpoints/context_models.py` cover
    list/create/get/update/delete, plus `POST /context-models/instantiate`
    (line 89) and a template CRUD surface.
- **PersonaToggle** (`frontend/src/components/persona/PersonaToggle.tsx`)
  is a binary business/technical lens — a coarse version of the same idea.
- **NodeQuery filters** are rich:
  `property_filters`, `tag_filters`, `name_filter`,
  `entity_types`, `layer_id`, `search_query`
  (`backend/common/models/graph.py:69-89`).
- **Tag-based lookup**: `GET /nodes/by-tag/{tag}`
  (`graph.py:737`), `GET /nodes/by-layer/{layer_id}` (`graph.py:750`).
- **What's missing** at the UX layer:
  - No **conditional formatting** — no "color this node red if its
    `pii_classification` attribute is `restricted`." A search of
    `frontend/src/` for `colorBy|conditional.*format|formatRule`
    returns zero matches.
  - No **per-user lens state** distinct from saved views; views are
    workspace/team/enterprise-scoped but not a personal-filter overlay.
  - ContextModels lean more **organizational** (layers, scope) than
    **stylistic** (color, badge, opacity). The substrate is close but
    the UX is not focused on lens-style governance presentation.

#### Suggested uplift

1. **Conditional formatting on entity attributes** (Effort: M). Extend
   the ontology entity-type visual config to declare formatting rules
   ("if `properties.pii_classification == 'restricted'`, fill #DC2626").
   Apply in `GenericNode` renderer at canvas paint time. High visual
   impact, modest code surface.
2. **Promote ContextModel UI to "lenses"** (Effort: S). Rename in UX,
   add per-user activation, and expose lens templates more prominently.
   The data model already supports this — it's a product-framing change.
3. **Filter chip rail on canvas** (Effort: S). Surface
   `property_filters`/`tag_filters` as toggleable chips on the canvas
   toolbar, instead of hidden in query bodies. Closes the discoverability
   gap.

---

### 3.5 Lineage Analysis  ·  **Verdict: Partial · Severity: Medium**

#### What Solidatus does

- **Forward/backward column-level impact analysis** with configurable
  traversal degree.
- **Path tracing** between two specific entities — "show me how
  `orders.total` reaches `revenue_dashboard.q3_revenue`."
- **"What feeds X" / "What consumes X"** structured reports as exportable
  artifacts.
- **Change impact reports** — "if I deprecate this column, what
  downstream consumers break?" — exportable for regulatory submission.

#### What Synodic does today

- **Trace API is strong**: `POST /graph/trace/v2` (`graph.py:236`),
  `POST /graph/trace/expand` (line 276),
  `POST /graph/trace/expand-batch` (line 329) — directional
  (upstream/downstream/both), depth-limited, with ontology-aware
  edge filtering.
- **Ancestor/descendant traversal** at the containment level:
  `GET /nodes/{urn}/ancestors` (line 714),
  `GET /nodes/{urn}/descendants` (line 724).
- **Multi-granularity aggregation**:
  `POST /edges/aggregated` (line 1174),
  `POST /edges/aggregated/materialize` (line 1215) — column-level edges
  roll up to table-level and domain-level on-the-fly.
- **Impact analysis exists at the governance level**:
  - Ontology impact: `GET /ontologies/{id}/impact` (line 443).
  - Provider impact: `GET /providers/{id}/impact`
    (`providers.py:365`).
  - Catalog item impact: `GET /catalog/{id}/impact` (`catalog.py:172`).
  - Workspace membership impact: `workspace_members.py:290`.
- **What's missing**:
  - No **path-tracing-between-two-entities** endpoint. The trace API
    is rooted at a single URN; bi-rooted path search must be done
    client-side by walking and intersecting.
  - No **"if I delete this graph entity, what breaks"** impact report.
    The current impact endpoints answer "if I delete this *catalog
    item* or *ontology*", which is governance-level. The downstream
    *data* consequences are not surfaced.
  - No **exportable change-impact report** — see §3.7 (Export).

#### Suggested uplift

1. **Path-trace endpoint** (Effort: S). `POST /graph/trace/path` taking
   `source_urn` + `target_urn` + max-degree, returning the path(s).
   Builds on existing trace infrastructure.
2. **Entity-deletion impact preview** (Effort: M). Before a
   `DELETE /graph/edges/{id}` or node deletion, compute downstream
   ripple. Existing aggregation infra makes this tractable.
3. **Exportable impact report** (Effort: M). Renders trace + impact
   to PDF (depends on §3.7).

---

### 3.6 Collaboration & Workflow  ·  **Verdict: Partial · Severity: Critical**

#### What Solidatus does

- **Comments and discussion threads** on any node, edge, or group.
- **@mentions** with notifications.
- **Subscriptions** — watch an entity or model and get notified on changes.
- **Approval workflows for model changes** — proposed changes require
  reviewer sign-off before they land in the canonical model.
- **Branch/model-level permissions** — different teams own different
  parts of the federated model.
- **Share-by-link** with permission inheritance.

#### What Synodic does today

- **Access requests + approval workflow** exists at the
  workspace/resource level:
  `AccessRequestORM` (`models.py:1287`),
  `submit_access_request` (`access_requests.py:133`),
  `approve_access_request` (`access_requests.py:311`),
  `deny_access_request` (`access_requests.py:406`).
- **RBAC is mature**: `RoleORM`, `RoleBindingORM`,
  `GroupORM`, `GroupMemberORM`, `ResourceGrantORM`, `PermissionORM`,
  `RolePermissionORM` (`models.py:968-1287`). This is **significantly
  more developed than the executive summary in `OVERVIEW.md` gives
  credit for** and matches Solidatus on the auth-policy axis.
- **View sharing with visibility scoping**:
  private / workspace / enterprise levels via
  `PUT /views/{id}/visibility` (`views.py:509`) and
  `ViewFavouriteORM` (`models.py:114`) for bookmarking.
- **Signup approval workflow** with admin attestation
  (`UserApprovalORM`, `models.py:927`).
- **What's missing**:
  - **No comments/discussions anywhere.** Search of
    `backend/app/` and `frontend/src/` for
    `comment|annotation|discussion|reply|thread` returns no domain
    model — the only hit is a context-view file's unrelated code
    comment.
  - No `@mentions` and no notification infrastructure for end users
    (the outbox pattern exists but is used for system events, not
    user notifications).
  - No **approval workflow on graph data changes** — RBAC gates
    *who can write*, but writes are immediate, not proposed.
  - No webhook subscriptions for external system integration
    (grep for `webhook` returns nothing relevant).

#### Why this matters

Synodic's RBAC actually beats most open-source competitors and is in the
same league as Solidatus on auth. **The gap is in human-collaboration UX
on top of it**. For Solidatus's regulated buyers, the inability to attach
"the regulator asked about this — see attached discussion" to a lineage
node is a hard blocker.

#### Suggested uplift

1. **EntityCommentORM + thread API** (Effort: M). New table keyed
   on `urn` + workspace, basic CRUD endpoints, sidebar UI on the
   canvas. Thread per entity; nested replies optional v1.
2. **Notification fan-out** (Effort: M). Reuse `OutboxEventORM`
   for in-app notification queue; surface in nav bar; opt-in email.
3. **Graph-change approval workflow** (Effort: L). Generalize the
   ontology draft/publish lifecycle to graph mutations: queue a
   "proposed change set" against `OutboxEventORM`, render diff,
   require reviewer attestation before commit. Reuses the existing
   `RoleBindingORM` for reviewer designation.

---

### 3.7 Reporting & Export  ·  **Verdict: Missing · Severity: Critical**

#### What Solidatus does

- **PNG / SVG / PDF export** of the canvas or any subgraph.
- **Excel export** of attributes / nodes / edges.
- **Embeddable iframe views** for dashboards / wikis / Confluence.
- **Regulatory templates** (BCBS 239 RDARR, GDPR Article 30, etc.) —
  pre-canned report definitions a customer fills in.
- **Programmatic PDF report API** for scheduled compliance reports.

#### What Synodic does today

- **Ontology export to JSON**: `GET /admin/ontologies/{id}/export`
  (`ontologies.py:123`); reciprocal import endpoint at line 567.
- **View configuration is JSON-serializable** by virtue of
  `ViewORM.config` — exportable in principle, no endpoint surfaces it
  as a download.
- **No PNG / SVG / PDF export from the canvas.** Grep of
  `frontend/src/` for `toBlob|html2canvas|export.*png|export.*pdf`
  returns no matches.
- **No CSV export of graph data.**
- **No embeddable iframe view.** Views are SPA routes; nothing
  iframe-friendly (no `X-Frame-Options` allowlist, no embed-specific
  endpoints, no shrunken chrome).
- **No regulatory templates.**

#### Why this matters

This is the most lopsided category. Solidatus's downstream artifacts —
"here is the PDF the regulator wants" — are a *primary* unit of value.
Synodic produces zero exportable artifacts that a non-Synodic-user can
consume. For most enterprise data leaders, "I can't share this with my
CFO without screenshotting" is disqualifying.

#### Suggested uplift

1. **PNG / SVG export from the canvas** (Effort: S). ReactFlow supports
   `toImage` via `html-to-image`; wire to `CanvasControls.tsx`. Server
   not required.
2. **PDF export endpoint** (Effort: M). Server-side render via headless
   Chromium of a print-optimized canvas route; return as
   `application/pdf`. Reuses `ViewORM.config` to identify what to
   render.
3. **CSV/Excel export of node/edge attributes** (Effort: S). Pair with
   import work in §3.1 — same schema in both directions.
4. **Embed view route** (Effort: S). New `/embed/views/{id}` route that
   skips chrome, plus `frame-ancestors` allowlist tied to
   workspace-level config. Permission via signed-URL or share token.
5. **Regulatory templates** (Effort: L). Library of ontology + view
   bundles for common frameworks (BCBS 239, GDPR). Best done after
   typed-attribute work in §3.1 lands.

---

### 3.8 Integration & API  ·  **Verdict: Partial · Severity: High**

#### What Solidatus does

- **Database introspection connectors** (Postgres, Snowflake, Oracle,
  SQL Server, etc.) that auto-discover schemas into the model.
- **ETL connectors** (Informatica, dbt, Airflow, Talend) that ingest
  pipeline lineage.
- **BI connectors** (Tableau, Power BI, Looker, MicroStrategy) for
  downstream consumer mapping.
- **Full-CRUD REST API** for programmatic model management.
- **Webhooks / event subscriptions** for external systems.
- **Real-time lineage ingestion** via streaming connectors.

#### What Synodic does today

- **Provider abstraction is genuinely strong**: FalkorDB, Neo4j, DataHub,
  Mock — with the abstract base class (`GraphDataProvider`) making new
  providers tractable.
  See `backend/app/providers/` and `docs/BACKEND.md`.
- **Catalog item layer** (`CatalogItemORM`, `models.py:815`)
  cleanly separates infrastructure (Provider) from governed assets
  (CatalogItem) from operational context (WorkspaceDataSource).
- **REST API for graph CRUD** is comprehensive — see §3.1.
- **Stats polling sidecar** (`docs/OVERVIEW.md`, `backend/app/jobs/`)
  for async cache refresh.
- **What's missing**:
  - **No purpose-built ETL/BI connectors**. DataHub is supported as a
    *provider* (i.e., a backing store), not as a *source connector*
    for ingesting lineage from a separate DataHub instance. There is
    no dbt, Airflow, Tableau, or Power BI connector.
  - **No webhooks.** Grep for `webhook|event_subscription` in
    `backend/app/` returns nothing.
  - **No real-time ingestion.** No Kafka/Pulsar consumer, no
    OpenLineage event endpoint. `docs/OVERVIEW.md` lists this on the
    Phase 4 roadmap.
  - **No GraphQL.** Roadmap-noted, P3.
  - **No SDK.** Pythonic clients would be cheap to generate from
    OpenAPI but don't ship.

#### Suggested uplift

1. **OpenLineage event ingestion endpoint** (Effort: M). Single
   `POST /ingest/openlineage` endpoint that maps OL events to graph
   mutations via existing batch API. Unlocks dbt/Airflow/Spark via
   their native OL emitters — much cheaper than per-tool connectors.
2. **Webhooks** (Effort: M). Per-workspace webhook config table,
   fan-out from `OutboxEventORM` consumer to subscribed URLs with
   HMAC signatures. Solves a wide range of integration needs.
3. **Generated Python SDK** (Effort: S). FastAPI's OpenAPI schema
   feeds `openapi-python-client`; ship as `synodic-client`.
4. **Tableau / Power BI metadata pullers** (Effort: L). Lower
   priority — point connectors are expensive per tool. OpenLineage
   first.

---

### 3.9 Governance Overlays  ·  **Verdict: Missing · Severity: High**

#### What Solidatus does

- **Data quality score overlay** — DQ score on each node/edge from
  integrated DQ tools (Great Expectations, Soda, Anomalo), rendered
  visually.
- **Sensitivity tagging** — PII / PCI / regulatory classification, with
  inherited propagation along lineage.
- **Business glossary** — business terms linked to physical entities,
  with stewardship.
- **Ownership / stewardship metadata** — every entity has an
  accountable owner and a data steward.
- **Compliance dashboards** — aggregate views of coverage, quality, and
  ownership.

#### What Synodic does today

- **Tags on nodes**: `GraphNode.tags: List[str]` — open free-form
  tagging (`backend/common/models/graph.py:32`). `GraphEdge` does
  not carry tags, only `properties` — so cross-edge classification
  must currently live in `properties`.
- **Source system + last synced**: `GraphNode.source_system`,
  `last_synced_at` — provenance substrate exists.
- **Ontology-defined entity types** could carry classification metadata
  conceptually, but there is no first-class "sensitivity" or "owner"
  field. No code path that propagates classification along lineage.
- **No DQ integration.** Grep for `data.*quality|dq_score|great_expect`
  returns no matches.
- **No business glossary.** Grep for `glossary|business.*term` returns
  one matching comment about glossary exclusion from trace, but no
  glossary domain model.
- **No ownership metadata** — RBAC has `created_by`, but no concept of
  "this dataset's data owner is alice@".

#### Why this matters

Governance overlays are what convert lineage from a debugging tool into
a compliance artifact. Without DQ, sensitivity, and ownership, Synodic
remains an engineering tool. Solidatus is bought by Chief Data Officers
specifically because these overlays let them run an enterprise data
program.

#### Suggested uplift

1. **First-class ownership** (Effort: S–M). Owner/steward fields on
   `GraphNode` (or in ontology-defined attributes once typed-attributes
   land). Surface in canvas, filter in `NodeQuery`.
2. **Sensitivity classification with propagation** (Effort: M).
   Tag-based today, promoted to typed attribute. Add a trace-style
   propagation: "show all downstream consumers of any node tagged
   `pii=restricted`."
3. **Business glossary** (Effort: L). New `GlossaryTermORM` + linking
   table to entity URNs. Surface in search; expose as ontology
   sub-resource. Pair with PersonaToggle to elevate glossary terms in
   business view.
4. **DQ overlay** (Effort: L). Generic adapter pattern that pulls
   DQ scores from Great Expectations / Soda / Anomalo and stores
   per-URN. Render as canvas badge. The provider abstraction style
   from `backend/app/providers/` is the right reference pattern.

---

### 3.10 Enterprise Readiness  ·  **Verdict: Partial · Severity: High**

#### What Solidatus does

- **SSO** (SAML, OIDC) with role mapping.
- **Fine-grained RBAC** at workspace, model, branch, and entity level.
- **Full user-action audit log**.
- **Multi-tenancy** with strict isolation.
- **On-prem deployment** with hardened defaults.
- **Mature observability** — metrics, logs, alerting.

#### What Synodic does today

- **Multi-tenancy is genuine and architectural** — workspaces, data
  sources, views, context models, and ontology assignments are all
  workspace-scoped (`docs/OVERVIEW.md`, `docs/ARCHITECTURE.md`). This
  is **ahead** of DataHub / Atlas / Marquez.
- **RBAC is mature** (see §3.6 details). Resource-level grants via
  `ResourceGrantORM` go beyond coarse admin/user/viewer.
- **JWT auth with Argon2id**, refresh tokens with revocation
  (`RevokedRefreshJtiORM`, `models.py:1361`).
- **Docker Compose / Kubernetes** deployment paths exist.
- **What's missing or weak** (Synodic's own `TECHNICAL_DEBT.md`
  acknowledges most of these honestly):
  - **No SSO / SAML / OIDC.** Grep returned no matches in
    `backend/app/auth/`. Roadmap P2.
  - **JWT in localStorage** — known XSS exposure
    (`TECHNICAL_DEBT.md §1.1`).
  - **Optional credential encryption** — plaintext fallback if
    `CREDENTIAL_ENCRYPTION_KEY` is unset (`TECHNICAL_DEBT.md §1.2`).
  - **Weak default admin password** (`"changeme"`,
    `TECHNICAL_DEBT.md §1.3`).
  - **CORS wildcard on Graph Service** (`TECHNICAL_DEBT.md §1.4`).
  - **SQLite as default** — risk in any concurrent deployment
    (`TECHNICAL_DEBT.md §2.1`).
  - **No Alembic; inline migrations** with silent exception
    swallowing (`TECHNICAL_DEBT.md §2.2`).
  - **No metrics / observability / structured alerting**
    (`TECHNICAL_DEBT.md §4.x`).
  - **User-action audit log is ontology-only**, not workspace-wide
    (see §3.2).
  - **Test coverage is thin** — ~10 backend, ~3 frontend
    (`TECHNICAL_DEBT.md §5`).

#### Suggested uplift

The Phase 1 ("Hardening") tasks already enumerated in `docs/OVERVIEW.md`
**are the right list and order**. This document adds:

1. **SSO** (Effort: M). OIDC first (broader compatibility, simpler);
   SAML2 second. Both via `Authlib`. Map IdP groups → Synodic groups
   via `GroupORM`.
2. **General audit log** — see §3.2 uplift #1.
3. **`OpenTelemetry` instrumentation + Prometheus exporter**
   (Effort: M). Already on the roadmap.

This document does not re-litigate Synodic's stated Phase 1 priorities;
it confirms they are appropriate for closing the Solidatus enterprise
gap.

---

## 4. Architectural Tensions

These are gaps that may **not** be closeable without rethinking design
decisions Synodic has deliberately made. They are worth surfacing and
debating before being committed to.

### 4.1 Introspection-first vs Model-first

Synodic's primary loop is: connect a backing store → introspect → render.
Solidatus's is: author a model → render. The two converge when both
support manual modeling **and** introspection, but they have different
*centers of gravity*.

Today Synodic supports manual node/edge creation via
`POST /graph/nodes/create`/`/edges`, but the **workflow framing** in
`docs/OVERVIEW.md` and the FirstRunHero onboarding both reinforce
introspection-first ("Connect Provider → Discover & Catalog → Assign
Ontology → Explore"). If the team wants to win Solidatus deals, the
manual-authoring loop needs to become first-class in product framing,
not just an available API. **Worth deciding consciously**, not by
default.

### 4.2 Ontology-as-schema vs entity-level custom attributes

Synodic's ontology defines entity types and relationship types with
visual config. Solidatus lets every entity carry user-defined typed
attributes that the ontology need not pre-declare. Synodic's current
free-form `properties: Dict[str, Any]` is the loose version; the
**tension** is whether typed attributes should live in the ontology
(which makes them governed but rigid) or be entity-local (governance-lite
but flexible).

The §3.1 uplift recommends putting typed attribute schemas in the
ontology, but this is a debate worth having. A hybrid — declared types
plus a free-form `extra` bucket — may be the right answer, and is
what Solidatus arguably does.

### 4.3 Single-graph-per-workspace vs federation

Solidatus's regulated customers are large enterprises whose lineage is
maintained by **many federated teams** publishing into a shared graph.
Synodic's workspace model is single-tenanted: one workspace = one team's
view of one or more data sources. Cross-workspace lineage is not a
first-class concept; the closest substrate is `CatalogItemORM` sharing
across workspaces.

Federation done well (model-of-models, owner-by-subgraph, cross-team
discovery) is an XL effort. It is also a credible alternative pitch:
"Synodic for one team's lineage, not for the federation problem".
**Worth deciding** what kind of customer Synodic targets.

### 4.4 Graph-data time-travel

True time-travel of graph data (not ontologies) implies either
event-sourcing the graph layer or a snapshot store. Both are
architectural commitments. The cheaper alternative is to require the
underlying provider to support temporal queries (Neo4j has limited
versions of this) and surface them — but that fragments capability
across providers and weakens the provider-agnostic story.

The §3.2 uplift recommends *not* committing to graph-data time-travel
in the short term; instead, deliver attestable point-in-time **views**
(immutable view snapshots) which solve the regulatory use case for most
customers without the architectural cost.

---

## 5. Prioritized Uplift Roadmap

The list below sequences the uplifts above into three tiers, aligned to
the existing Phase 1–4 structure in `docs/OVERVIEW.md`. Effort tiers:
**S** ≤ 1 week · **M** 1–4 weeks · **L** 1–3 months · **XL** > 3 months.

### Tier 1 — Foundational (blocks credible Solidatus comparison)

| # | Uplift                                  | Effort | Owner subsystem                    | Section |
|---|-----------------------------------------|--------|------------------------------------|---------|
| 1 | CSV / Excel import for graph data        | M      | `endpoints/graph.py` + new wizard  | §3.1    |
| 2 | PNG / SVG export from canvas             | S      | `components/canvas/CanvasControls` | §3.7    |
| 3 | PDF export (server-rendered)             | M      | new service / job worker           | §3.7    |
| 4 | Entity comments + threads                | M      | new `EntityCommentORM`, sidebar UI | §3.6    |
| 5 | Full user-action audit log               | M      | generalize `OntologyAuditLogORM`   | §3.2    |
| 6 | OpenLineage ingestion endpoint           | M      | new `endpoints/ingest.py`          | §3.8    |
| 7 | Phase 1 security hardening (acknowledged)| S–M    | per `TECHNICAL_DEBT.md`             | §3.10   |

**Rationale:** Without these, Solidatus's core value props (regulatory
artifacts, collaboration, attestable lineage) are not credibly answered.
Effort total ~3–5 engineer-months. Aligns with existing Phase 1 + adds
the customer-visible features that hardening alone won't deliver.

### Tier 2 — Closes the "regulated industries" gap

| # | Uplift                                       | Effort | Section |
|---|----------------------------------------------|--------|---------|
| 1 | Typed custom attributes in ontology          | M      | §3.1    |
| 2 | Attribute editor UX in canvas                | S–M    | §3.1    |
| 3 | Conditional formatting / color-by-attribute  | M      | §3.4    |
| 4 | Promote ContextModel → "Lenses" in UX        | S      | §3.4    |
| 5 | View versioning (immutable snapshots)        | S      | §3.2    |
| 6 | Path-trace + entity-deletion impact preview  | S–M    | §3.5    |
| 7 | SSO (OIDC then SAML)                         | M      | §3.10   |
| 8 | Webhooks                                     | M      | §3.8    |
| 9 | Sensitivity tagging with lineage propagation | M      | §3.9    |
| 10| Graph-change approval workflow               | L      | §3.6    |

**Rationale:** Each one slots Synodic closer to the
"this is an attestable governance artifact, not a debugging tool"
positioning. Effort total ~6–9 engineer-months.

### Tier 3 — Long-horizon, may require architectural decisions

| # | Uplift                                     | Effort | Section |
|---|--------------------------------------------|--------|---------|
| 1 | Business glossary                          | L      | §3.9    |
| 2 | DQ score overlay (adapter pattern)         | L      | §3.9    |
| 3 | Regulatory report templates (BCBS 239, …)  | L      | §3.7    |
| 4 | Federation across workspaces               | XL     | §4.3    |
| 5 | Graph-data time-travel                     | XL     | §4.4    |
| 6 | Tableau / Power BI / dbt point connectors  | L–XL   | §3.8    |

**Rationale:** Each of these is a strategic bet, not table stakes.
Synodic should decide *which buyers it wants to displace Solidatus for*
before committing. A focused mid-market data-engineering pitch can skip
federation, time-travel, and regulatory templates. A Tier-1 bank pitch
cannot.

---

## 6. Where Synodic Genuinely Leads

A frank gap analysis is unbalanced if it lists only the gaps. The
following are points where Synodic meets or exceeds Solidatus and are
worth defending in any comparison.

1. **Multi-backend provider abstraction.** FalkorDB, Neo4j, DataHub, and
   Mock with a clean `GraphDataProvider` ABC. Solidatus stores in a
   proprietary backend. For customers with existing Neo4j or DataHub
   investments, Synodic's flexibility is a hard advantage.
2. **Versioned ontologies with three-layer resolution and impact
   analysis.** Solidatus tracks model versions; Synodic separately
   tracks **schema** versions with evolution policies (`reject` /
   `deprecate` / `migrate`) and pre-publish impact analysis. The
   `OntologyAuditLogORM` is more rigorous than typical lineage-tool
   schema management.
3. **Workspace-native multi-tenancy.** Every artifact (view, context
   model, data source, ontology assignment) is workspace-scoped from
   the data layer up. Solidatus is multi-tenant in deployment, not in
   data model.
4. **Persona toggle (business / technical) on the same graph.** A
   genuinely distinctive UX commitment Solidatus does not match cleanly.
5. **Multi-granularity rollups (column → table → domain).** Aggregated
   edges computed and materialized server-side keep the canvas
   responsive on large graphs. Solidatus typically renders at the
   resolution it was modeled at.
6. **Modern stack.** React 19, TypeScript, ELK in a Web Worker,
   FastAPI 0.115+, async SQLAlchemy 2.0, Redis Streams outbox. Solidatus
   does not publish stack details, but the prevailing assumption is a
   more conservative .NET/Angular base. Synodic's velocity ceiling is
   higher.
7. **Resource-grant RBAC.** `ResourceGrantORM` + `RoleBindingORM` +
   `GroupORM` + `AccessRequestORM` is a more capable auth model than
   most lineage tools ship.

For a buyer who values **flexibility, modern UX, ontology rigor, and
multi-tenancy** over **regulatory artifacts and incumbency**, Synodic
already has a real story. The gap analysis above is about expanding the
buyer set, not surviving it.

---

## Appendix A — Verification Trail

Every Synodic claim above should be traceable. Below is the mapping
used during research:

| Claim                                  | Source                                              |
|----------------------------------------|-----------------------------------------------------|
| Graph CRUD endpoints                   | `backend/app/api/v1/endpoints/graph.py:1239-1297`   |
| Batch graph mutations                  | `backend/app/api/v1/endpoints/graph.py:1320`        |
| Trace API                              | `endpoints/graph.py:236, 276, 329`                  |
| Aggregated edges                       | `endpoints/graph.py:1174, 1215`                     |
| `GraphNode` properties + tags          | `backend/common/models/graph.py:31-32`              |
| `GraphEdge` properties (no tags)       | `backend/common/models/graph.py:47`                 |
| Ontology versioning                    | `endpoints/ontologies.py:227, 255, 286, 318, 443`   |
| Ontology audit log                     | `db/models.py:345`, `endpoints/ontologies.py:545`   |
| ContextModel (lens substrate)          | `db/models.py:551-597`                              |
| Views with visibility scoping          | `db/models.py:604-660`, `endpoints/views.py:509`    |
| RBAC suite                             | `db/models.py:968-1287`                             |
| Access request approval                | `endpoints/access_requests.py:133, 311, 406`        |
| No CSV/Excel import                    | `grep -RIl "csv\|excel\|xlsx\|openpyxl" backend/`   |
| No image export                        | `grep -RIl "toBlob\|html2canvas" frontend/src/`     |
| No comments domain                     | `grep -RIl "comment\|annotation\|discussion"`       |
| No SSO                                 | `grep -RIl "saml\|oidc\|sso" backend/app/auth/`     |
| No webhooks                            | `grep -RIl "webhook" backend/app/`                  |
| No DQ / glossary                       | `grep -RIl "data.*quality\|glossary\|dq_score"`     |
| Phase 1–4 roadmap                      | `docs/OVERVIEW.md` "Roadmap" section                |
| Acknowledged security debt             | `docs/TECHNICAL_DEBT.md §1–§5`                      |

---

## Appendix B — What Was Deliberately Not Reviewed

- **Performance** of the canvas under realistic loads (>10k nodes).
- **Cost / license model** comparison — out of scope.
- **Specific Solidatus customer references** — not based on any single
  engagement.
- **Synodic's planned User Service extraction** (`docs/OVERVIEW.md`
  Phase 3) — orthogonal to functionality comparison.
- **Mobile / tablet** support.
- **Internationalization**.

These are legitimate evaluation axes but fall outside "core functionality
gaps versus Solidatus".
