# Release Notes — Context Visualization Platform

**Coverage window:** 16 July 2026 → 20 July 2026 (all work merged to `main`)
**Prepared:** 20 July 2026

---

## Overview

This is the largest single week of change the platform has seen. Across roughly **40 merged
pull requests** (28 feature & fix PRs plus a batch of 11 dependency updates), the work touched
**451 files (+35,183 / −6,540 lines)** and moved on eight fronts at once:

1. **Ontology & Graph Schema** — onboarding no longer dead-ends on partial coverage; ontology
   edits now reach every canvas.
2. **Graph backend reliability** — FalkorDB connections, provider lifecycle, and graph-inventory
   drift were hardened so large graphs stop silently under-reporting.
3. **Context-View canvas (edges)** — lineage edges stay visible and honest on very large graphs,
   with adaptive bundling, flow ribbons, resizable lanes, and a framed focus mode.
4. **Lineage Lens (Miller-columns walk)** — the Lens became a walkable, on-demand lineage
   explorer with a visible trail, parent grouping, and an "outside this view" cue.
5. **Per-layer node ordering** — real sort controls with a server-backed direction and stable
   custom ordering.
6. **Onboarding, guided tours, help & telemetry** — a role-aware Getting Started hub, a spotlight
   tour engine, an in-app Help drawer, and a product-analytics pipeline.
7. **Documentation & rebrand** — every doc refreshed to current reality and the product rebranded
   to **Context Visualization Platform (CVP)**.
8. **Quality & maintenance** — 37 unit tests repaired, replay-safe database migrations, and a
   dependency refresh.

The notes below are written twice: **Part 1** for a business/stakeholder audience (what changed
and why it matters), and **Part 2** for engineers (what changed, in which components, with PR
references). A full PR index is in the appendix.

> **Naming note:** The product was rebranded this week from *Nexus Lineage* to **Context
> Visualization Platform (CVP)**. Both names may appear in older screenshots; the platform is the
> same product.

---

# Part 1 · Business / Executive Release Notes

### 1. Setting up your data is more forgiving

Getting a data source connected and mapped to a schema used to fail if the mapping wasn't
*perfect* — a source that was 90% understood could stop you cold. Now a mostly-covered setup
proceeds: anything not yet mapped is flagged as an amber "advisory" (with a one-click **Add
missing types** fix) rather than a hard block, and the setup screen shows an exact **coverage
percentage** so you know how complete you are. The data-source-to-schema mapping and management
screens were also simplified and given clearer insights. **Why it matters:** faster, less
frustrating onboarding, and fewer support tickets from teams stuck on partial coverage.

A related correctness fix: when you edit an ontology (the model that defines how your data
connects), those edits now reliably show up on **every** canvas immediately. Previously a stale
cache could leave different views disagreeing for up to 15 minutes.

### 2. The graph is more reliable at scale

Several deep reliability problems that only appear on large, real deployments were fixed:

- **No more silent "empty" or "vanished" data.** On big clustered graphs, a missing shard or a
  stale snapshot could make the system quietly report *nothing* — which looked like healthy,
  empty data instead of a problem. The platform now detects that mismatch and surfaces a clear
  banner instead of losing your data silently.
- **Connections stopped thrashing.** A single momentary network blip used to make the backend
  tear down and rebuild every database connection, which degraded performance on fleets with
  hundreds of graphs. Connections are now stable and shared.
- **Credentials "just work" more consistently.** Subtle differences in how a blank password was
  recorded could cause intermittent authentication failures after a rotation. That whole class of
  bug was closed.
- **Big lists load fast.** Browsing and filtering the top level of a large graph is now paginated
  and cached, so searching by name or type stays responsive instead of re-scanning the whole
  graph on every keystroke.

**Why it matters:** the product now behaves predictably on production-scale graphs, and failures
are visible rather than silent.

### 3. The lineage canvas reads clearly, even on huge graphs

The Context-View canvas — where you see how data flows between systems — got a major upgrade for
dense graphs:

- **Edges stay visible.** On large graphs, connection lines used to disappear. They now remain
  drawn, and when there are too many to show individually, the canvas summarizes them as
  **flow ribbons** (Sankey-style volume bands, e.g. "12.4k flows") so you still see where the
  volume goes.
- **Adaptive detail.** An "Adaptive" mode keeps the most important connections drawn and bundles
  the rest, with a visible chip telling you exactly how many are hidden and a one-click **Show
  all**. Nothing is ever hidden silently.
- **Focus on one thing.** Right-click any item and **Focus Connections** to frame just its
  neighborhood; a clearly labeled bar tells you you're in focus mode and how to exit.
- **Make it yours.** Columns (lanes) are now resizable by dragging, and — for shared views —
  the width is saved for everyone.

### 4. Follow data lineage like a detective — the Lineage Lens

Clicking an item now opens a focused **Lineage Lens** that shows its true upstream sources and
downstream consumers, fetched live from the source system (not just what happened to be on
screen). You can **walk** from neighbor to neighbor, and the route you took is shown as a
clickable **trail** across the top — jump back to any step, or branch off in a new direction.
Related items are grouped under their parent dataset, and if lineage continues *outside* the
current view, a chip tells you so ("3↑ 5↓ outside this view") and offers a preview — worded as
*expected*, never as an error. **Why it matters:** impact analysis and root-cause tracing that
used to require guesswork are now a guided, honest walk.

### 5. Order the canvas the way you think

Each column now has a real sort menu — default, A→Z, Z→A, by type, most-connected, or a **custom
drag-and-drop order**. Managers can set the order for a whole shared view; individual viewers'
personal tweaks stay on their own device.

### 6. New users get productive faster

- A **Getting Started** hub now adapts to your role (admin, explorer, collaborator), tracks your
  real progress automatically, and always has a launcher in the sidebar.
- A built-in **guided tour** system can walk users through the key areas (exploring lineage,
  workspaces, ingestion, semantic layers, reviews) with an on-screen spotlight. Tours are
  replayable and are currently **off by default** behind a feature flag, ready to switch on.
- A new **Help** drawer (press `?`) gives instant searchable access to all documentation and
  guides without leaving the app.

### 7. We can now see how the product is actually used

A new **product analytics** panel (Admin → Telemetry) shows which help searches came up empty
(i.e. what documentation to write next), how far users get through each guided tour, and which
help pages people found useful. **Why it matters:** onboarding and docs can now be improved from
evidence instead of guesswork.

### 8. Documentation is trustworthy again — and the product has a name

Every user- and developer-facing document was audited and refreshed to match how the system
actually works today, including brand-new pages for the platform's services (Insights, Deep
Search, Context Engine, Assignment Engine). The docs now show when each page was last updated,
carry a "was this helpful?" prompt, and have a ⌘K search. The product was rebranded to
**Context Visualization Platform (CVP)**, delivered as a white-label system so a deployment can
set its own name.

---

# Part 2 · Technical Release Notes

Grouped by theme. Each item lists the concrete behavior and the primary components; PR numbers
are in parentheses.

## 1 · Ontology & Graph Schema management  (#244, #246, #247, #248 — Jul 16)

**Added**
- `infer_edge_classification()` — conservative whole-token name heuristics (`HAS`/`CONTAINS`/
  `BELONGS_TO` → containment; `DERIVES`/`FEEDS`/`UPSTREAM` → lineage; containment wins ties;
  unknown → neither), applied to novel edge types in `suggest_relationship_defs_from_stats` so a
  suggested ontology passes the resolution gate out of the box. (`backend/.../resolver.py`,
  `ontologies.py`)
- `coverage_percent` on the resolution report; `SchemaReviewStep` renders coverage and splits
  **blocking (red)** from **advisory (amber)** findings, promoting one-click "Add missing types."

**Changed**
- Resolution gate demoted `missing_entity_types` / `missing_edge_types` /
  `unclassified_relationships` from blocking to **advisory** — unmapped types are ignored by
  aggregation and rendered with fallback styling. Only `no_lineage` still blocks (aggregation
  would otherwise produce nothing); built-in edges such as `AGGREGATED` never read as unmapped.
- Relationship-definition **flags became the stored source of truth**: the repo re-derives the
  flat containment/lineage lists from `is_containment` / `is_lineage` on every content write,
  killing the additive-union drift where a cleared flag could never leave the persisted list.
- Data-source→schema mapping and overall ontology management UX simplified; appearance-tab bug
  fixed and ontology-view insights enriched. (`OntologySchemaPage.tsx`,
  `features/ontology/components/panels/SourceMappingSection.tsx`, `AssignmentManagerDialog.tsx`,
  `ChangesTray.tsx`, `DeploymentDashboardPanel.tsx`, `EvalContextBar.tsx`)

**Fixed**
- Cache coherence: data-source delete passed a stray `session` arg to
  `bump_ontology_generation`, so the `TypeError` was swallowed and the resolved-ontology
  generation never bumped (views stale up to 15 min). `_invalidate_ontology_caches` now also
  bumps the `GraphCache` generation; the onboarding wizard invalidates the `['ontologies']` and
  `['graph','schema']` react-query caches after direct mutations.
- `ensure_indices` reports real failures in one warning instead of bare `except: pass`; skipping
  aggregation still ensures per-label indexes so the first read doesn't pay DDL + cold scan.

## 2 · Graph backend reliability & connectivity  (#245, #249, #250, #251, #252 — Jul 17)

**Fixed / Changed**
- **FalkorDB credential normalization** (#245) — one chokepoint (`normalize_credentials` /
  `load_connection_config` in `falkordb_connection.py`) collapses every "no credential" spelling
  to `None` (`""`/whitespace → `None`; a username without a password is dropped). Fixes a
  split-brain where `username=""` and `username=None` hashed to different client-cache identities
  and learned-auth marks, so a rotation recorded under one spelling missed the other. Empty/missing
  secret files are now hard errors instead of silent unauthenticated connects.
- **Provider re-instantiation churn** (#252) — recovery no longer evicts cached providers on
  every transient probe blip; eviction now needs N consecutive failures or a genuinely open
  breaker. The client cache is keyed by **owning node** (cluster) rather than by graph, so many
  graphs share one pool. (`manager.py`, `TopologyGraphClients`, `falkordb_provider.py`)
- **Registry-vs-observed drift detection** (#251) — `_detect_registry_drift()` compares observed
  `GRAPH.LIST` against the expected-present set (active catalog items ∪ fully-projected resident
  versioned graphs), subtracting evicted / mid-flight rows. A gap stamps a `graph_drift:` banner
  onto the list-all cache row. New `ClusterCoverageError` (primaries must cover the full slot
  space), `verify_not_cluster_node()` (rejects standalone config aimed at a cluster node), and
  `_empty_key_is_genuine()` (slot-routed `EXISTS` probe before masking an empty read as zeros)
  close several silent-under-reporting paths. All guards fail-open on transient errors.
  (`insights_service/discovery.py`, `falkordb_connection.py`, `preflight.py`,
  frontend `useProviderAssets.ts` / `RegistryAssets.tsx` for drift banners and transient-state
  classification.)
- **Top-level / root node listing** (#250) — large graphs serve pages from a Postgres-materialized
  displayName-sorted payload; when complete, search/type filters run **in-process** instead of an
  O(N) scan per keystroke. A filter-keyed, generation-invalidated **count side-cache** means each
  filtered listing pays at most one live count scan. Keyset `(displayName, urn)` pagination is
  stable under writes; the top-level predicate was rewritten to `NOT (n)<-[:T]-()` to stop a
  full-graph scan pinning FalkorDB CPU; count degrades to `null` on timeout.
  (`graph.py` `/nodes/top-level`, `top_level_cache.py`, `falkordb_provider.py`)

## 3 · Context-View canvas — edges & lineage rendering  (#253–#263 — Jul 18)

**Added**
- **Flow ribbons** (#258) — Sankey-style, log-scaled volume bands between layer columns,
  labeled (e.g. "12.4k flows"), shown while Adaptive mode is summarizing; toggleable in Lineage
  Settings. (`flowRibbons.ts`, `LineageFlowOverlay.tsx`, `LineageDisplayPopover.tsx`)
- **Framed mode / Focus Connections** (#259, #260) — select an item with off-screen neighbors to
  get a **Frame** pill that reveals and centers its neighborhood as a distinct dimmed mode, with a
  persistent bar naming the state and an explicit **Exit frame** (learnable `Esc`). Reachable from
  the node context menu and from a Lens reveal. Never auto-scrolls uninvited. (`ContextViewCanvas.tsx`)
- **Resizable lanes** (#263) — drag a column's right edge (260–560px), double-click to reset. In
  draft mode the width is saved to the view for all viewers; otherwise it's a per-device
  preference. (`LayerColumn.tsx`)

**Changed / Fixed**
- **Adaptive edge density truly adaptive** (#253, #254, #255, #256, #257) — three edge modes
  (On-Hover / Adaptive / All Edges); Adaptive keeps the strongest flows drawn (user-tunable
  **Edge Budget** 100–2000) and bundles dense many-to-many links into a single thicker line per
  parent pair. A status chip shows how many flows are hidden with a **Show all** override. Edge
  rendering was fixed to stay visible on large graphs and handle very-large-canvas edge cases.
  (`LineageDisplayPopover.tsx`, `useEdgeProjection.ts`, `CanvasStatusChips.tsx`)
- **Edge/count correctness & scroll** (#261, #262) — edge and count fixes; Display Settings menu
  bug resolved and horizontal scroll made consistent.

> Engineering invariants for this canvas (never lose data silently; anchor edges only to real
> DOM; every layer has an explicit budget; counts have units and never mix) are documented in
> `docs/BOOK_OF_WORK.md`.

## 4 · Lineage Lens — Miller-columns walk  (#290, #291, #292, #293, #295 — Jul 19)

**Added**
- **On-demand lineage fetch** — the Lens fetches each visited entity's real upstream/downstream
  lineage from the data source on demand (not just what's on the canvas), narrating loading /
  empty / error states honestly. (`LineageLens.tsx`, `useLensLineage.ts`)
- **Walk trail** (#295) — the previously-hidden Back stack now renders as a labeled chip trail
  above the body (`acct_num > System A > DB X`); the current frontier is highlighted and clicking
  any earlier hop jumps the walk back to that point. Horizontal-scrolling for deep walks; export
  via **Show on canvas** / **Copy path**.
- **Parent-dataset grouping / grain chips / rollups** — connections group under their parent
  dataset (bare field names get dataset breadcrumbs); grain/type chips toggle a type off while
  always keeping counts; coarser summaries (containers/platforms) drop into a labeled **Rollups**
  tier; headline counts split by grain so units never mix.
- **External-lineage signal** (#292, #293) — new `POST /nodes/degree` endpoint returns total
  in/out lineage degree per URN over the full graph (absent URN = UNKNOWN, never a false zero).
  The canvas subtracts already-loaded degree to show hollow dashed hairline tabs and a
  "N↑ M↓ outside this view" chip with a **Preview** action, gated by an External Preview toggle.
  (`graph.py`, `falkordb_provider.py::get_node_degrees`, `useExternalDegrees.ts`,
  `CanvasStatusChips.tsx`)

**Changed**
- **Root fetching + one-page-ahead pagination** (#290, #291) — scrolling a column to its end
  auto-loads the next 200-entity page (guarded against short columns and momentum scroll);
  loading is strictly additive. A "N top-level loaded / Load more" chip gives explicit manual
  control. (`LayerColumn.tsx`, `useGraphHydration.ts`)

## 5 · Per-layer node ordering  (#294 — Jul 19–20)

**Added**
- Column sort menu: **View default, A→Z, Z→A, By type, Most children, Custom order**. Managers can
  apply a mode view-wide or define drag/keyboard custom orders; viewers' picks stay device-local.
  Custom order uses **fractional order keys** so a single move never renumbers other rows. The
  sort direction is applied **server-side**. (`LayerSortMenu.tsx`, `useLayerAssignment.ts`,
  `orderKeys.ts`, `graph.py` sort params)

## 6 · Onboarding, guided tours, help & telemetry  (#296 — Jul 19)

**Added**
- **Guided tour engine** (`frontend/src/features/tour/`) — data-defined tours in `tours.ts`,
  each step anchored to stable `data-tour="…"` selectors with optional route navigation;
  `TourOverlay.tsx` renders the dimmed backdrop, target-following spotlight, coach-mark card,
  progress dots, and keyboard control; `tourStore.ts` persists completed tours (replayable, not
  re-nagged). Tours: Getting Started, Set up, Explore lineage, Workspaces, Read the canvas,
  Ingestion, Semantic layers, Reviews. Deep-linkable via `?tour=<id>` and from doc markdown
  ` ```tour-<id> ` blocks. **Gated by the `toursEnabled` flag, which ships OFF.**
- **Role-aware Getting Started hub** (`components/onboarding/GettingStarted.tsx`,
  `hooks/useOnboardingProgress.ts`) — Set up / Explore / Collaborate & govern tracks; steps
  auto-complete from real backend counts (providers, assets, workspaces, ontology, views);
  always-visible, hideable sidebar launcher.
- **In-app Help drawer** (`components/help/HelpPanel.tsx`, `DocsLink.tsx`) — right-side slide-over
  (header button / `?`) with live full-text search over docs + guide, quick-starts, and a
  "Take a tour" list. `DocsLink.tsx` is the reusable in-SPA "learn more" router.
- **Product-events telemetry** — append-only `product_events` table (migration
  `20260719_1400_product_events`), `POST /telemetry/events` (auth-required, event-type allowlist,
  payload cap) and audit-gated `GET /admin/telemetry/summary` aggregated in Python (portable
  SQLite/Postgres). Fire-and-forget frontend emitters (`services/telemetryService.ts`) and an
  Admin panel (`components/admin/AdminTelemetry/index.tsx`, `/admin/telemetry`) with 7/30/90-day
  windows: KPI tiles, a **content-gaps** list (searches that found nothing), a **per-tour funnel**
  (starts, completion rate, biggest drop-off step), and a helpful-by-page table.
- A11y / light-mode parity polish across the Lineage Lens, admin console, and onboarding wizards.

## 7 · Documentation refresh & rebrand  (#296 — Jul 19)

**Added / Changed**
- Every reader-facing doc audited and refreshed to current reality; new **Platform Services**
  section (Insights, Deep/Advanced Search, Context Engine, Assignment Engine) plus a services
  overview, all researched against backend source. Two new Viewer guide articles
  ("The Lineage Lens & Context View", "Navigating Layers").
- **Jobs-first IA** with audience personas + outcome "key journey" cards (`docsConfig.ts`,
  `guideConfig.ts`); Diátaxis **doc-type badges**; git-derived **freshness chips** (build-generated
  `reading/docMeta.generated.ts`); **"Was this helpful?"** + Edit-on-GitHub; in-app contextual
  routing of relative `.md` links; a lazy cached **full-text search index** and a ⌘K
  **docs search modal** that logs zero-result content gaps; accented Note/Tip/Warning **callout**
  markdown elements; a **drift-prevention integrity suite** (`docsIntegrity.test.ts`) that fails
  the build on dead links, orphaned slugs, or missing markdown.
- **Rebrand → Context Visualization Platform (CVP)** — white-label branding fetched on boot and
  applied to title/favicon/accent (pre-mount cache prevents flash); `{brand}`/`{brandShort}`
  tokens resolve at render time; backend `branding.py` + endpoint and a non-clobbering one-time
  migration (`20260719_1200_rebrand_branding`) that updates the default identity only
  where an admin hasn't customized it. (`store/branding.ts`, `components/brand/BrandName.tsx`)
- CHANGELOG `[Unreleased]` cut to a dated `[0.2.0]` entry; broken README links fixed; login
  credentials reconciled to real defaults.

## 8 · Quality & maintenance

**Fixed**
- **Unit tests** (#297) — repaired 37 failing unit tests against evolved app behavior.
- **Replay-safe migrations** — services that `create_all` at current shape on boot left live DBs
  ahead of historical replay, wedging `upgrade head`. Fixes apply a **widen-only** doctrine:
  `restore_kind` carries the later `'pull'` kind so replay never re-adds a narrower constraint;
  `DROP CONSTRAINT IF EXISTS`, pre-validation that names offending values, `ADD COLUMN IF NOT
  EXISTS`, and `has_table`-guarded creates let the chain complete to head in one run.
  (`20260713_1200_restore_kind.py`, `feature_impact` / `feature_changes` migrations)

## Dependencies & Security

- **Backend (pip)** — `fastapi` ≥0.109.1→≥0.139.2 (#271), `uvicorn` ≥0.23.0→≥0.51.0 (#273),
  `alembic` ≥1.13.0→≥1.18.5 (#270), `asyncpg` ≥0.29.0→≥0.31.0 (#277), `aiosqlite` ≥0.20→≥0.22.1
  (#274), `anyio` ≥4.14.1→≥4.14.2 (#269), `zxcvbn` ≥4.4.28→≥4.5.0 (#275), `openpyxl`
  ≥3.1.0→≥3.1.5 (#272), `python-multipart` ≥0.0.31→≥0.0.32 (#268).
- **Infrastructure (docker)** — `falkordb/falkordb` v4.18.11 → v4.20.1 (#264).
- **Frontend (npm)** — npm minor/patch group across 2 directories, 14 updates (#298).

---

## Appendix · Full PR index (merged to `main`, Jul 16–20)

| PR | Merged | Area | Title |
|----|--------|------|-------|
| #244 | 07-16 | Ontology | Heuristic edge classification, advisory coverage gate, cache coherence, onboarding indexes |
| #246 | 07-16 | Ontology | Ontology / Graph Schema strategic fixes |
| #247 | 07-16 | Ontology | Simplify Data-Source→Schema mapping and management |
| #248 | 07-16 | Ontology | Appearance-tab fix, richer ontology-view insights, UI/UX uplift |
| #245 | 07-17 | Backend | FalkorDB credential normalization at one chokepoint |
| #249 | 07-17 | Ontology | Ontology schema review |
| #250 | 07-17 | Backend | Top-level nodes: in-process filtering + count side-cache |
| #251 | 07-17 | Backend | Detect and report registry-vs-observed graph drift in discovery |
| #252 | 07-17 | Backend | Stop continuous provider re-instantiation churn |
| #253 | 07-18 | Canvas | Keep lineage edges visible in Adaptive mode on large graphs |
| #254 | 07-18 | Canvas | Strategic fix for edges hidden on large graphs |
| #255 | 07-18 | Canvas | Adaptive bundling is truly adaptive |
| #256 | 07-18 | Canvas | Edge optimizations for the visualization |
| #257 | 07-18 | Canvas | Resolve edge cases for very large canvases |
| #258 | 07-18 | Canvas | Flow ribbons + toggle state |
| #259 | 07-18 | Canvas | Framed-mode chrome: explicit exit pill with Esc hint |
| #260 | 07-18 | Canvas | Focus Connections in node context menu; frame from Lens reveal |
| #261 | 07-18 | Canvas | Fix for the edges and counts |
| #262 | 07-18 | Canvas | Display Settings menu fix; consistent horizontal scroll |
| #263 | 07-18 | Canvas | Resizable lanes |
| #290 | 07-19 | Lens | Root fetching |
| #291 | 07-19 | Lens | One-page-ahead auto-load for children and roots, pump-proofed |
| #292 | 07-19 | Lens | External lineage signal: `/nodes/degree` endpoint + curated-view chip |
| #293 | 07-19 | Lens | Flagged external-lineage preview: guided chip CTA into the Lens |
| #295 | 07-19 | Lens | Lineage walk trail in the Lens (Miller walk, increment 1) |
| #294 | 07-19/20 | Canvas | Per-layer node sort modes with server-side sort direction |
| #296 | 07-19 | Docs/Onboarding | Docs audit & refresh, tours, telemetry, onboarding, help, rebrand |
| #297 | 07-19 | Quality | Repair 37 failing unit tests against evolved app behavior |
| #264 | 07-19 | Deps | Bump falkordb/falkordb v4.18.11 → v4.20.1 |
| #268 | 07-19 | Deps | Update python-multipart ≥0.0.31 → ≥0.0.32 |
| #269 | 07-19 | Deps | Update anyio ≥4.14.1 → ≥4.14.2 |
| #270 | 07-19 | Deps | Update alembic ≥1.13.0 → ≥1.18.5 |
| #271 | 07-19 | Deps | Update fastapi ≥0.109.1 → ≥0.139.2 |
| #272 | 07-19 | Deps | Update openpyxl ≥3.1.0 → ≥3.1.5 |
| #273 | 07-19 | Deps | Update uvicorn ≥0.23.0 → ≥0.51.0 |
| #274 | 07-19 | Deps | Update aiosqlite ≥0.20 → ≥0.22.1 |
| #275 | 07-19 | Deps | Update zxcvbn ≥4.4.28 → ≥4.5.0 |
| #277 | 07-19 | Deps | Update asyncpg ≥0.29.0 → ≥0.31.0 |
| #298 | 07-19 | Deps | Bump the npm-minor-patch group (14 updates across 2 directories) |

*The Jul-18 canvas PRs (#253–#263) and the Jul-19 Lens PRs (#290–#293) were merged as a rapid
sequence on the `claude/canvas-lineage-edges-disappear-bhstlt` and related branches.*
