# Branding that saves, combined traces, and time for very large graphs — 2026-09-30

Five reports arrived together:

1. **Branding could not be changed.** Every save on Admin → Branding answered *"Someone else
   updated branding while you were editing"*, and nothing was stored — not the title, not
   the description, nothing.
2. **Multi-selecting entities on the Context View canvas did not work** as people expected:
   the incoming and outgoing lineage of several entities could not be seen together, and a
   trace of the selection showed one entity, not the combined result.
3. **The environment was slow**, and there was no single guide for tuning pods, services and
   the graph, SQL and Redis stores for hundreds to thousands of concurrent users.
4. **Advanced Search and Display Rules had no documentation** — not how to use them, not how
   to import or export them, not how to build your own and publish them for everyone.
5. **Loads and searches on very large graphs were cut off.** Queries that legitimately take
   10–60 seconds failed before they could finish.

This documents what caused each, what changed, **every value that moved and every knob an
operator can turn**, how to roll it out, how to verify it, and what is deliberately not in
this release.

> **Operator action is needed for two things that no deploy does on its own:** rebuild the
> frontend image (browser timeouts are baked in at build time), and raise any load balancer
> or gateway idle timeout in front of the app to at least 150 s. See [§8](#8-rollout).
> There is **no database migration**.

Companions, each authoritative for what it covers:

* [`SCALING_CONCURRENT_USERS.md`](SCALING_CONCURRENT_USERS.md) — the operator guide written
  for item 3: capacity model, connection worksheets, per-tier settings, profiles for ~100 /
  ~500 / ~1000+ users.
* [`guide/ADVANCED_SEARCH.md`](guide/ADVANCED_SEARCH.md) and
  [`guide/DISPLAY_RULES.md`](guide/DISPLAY_RULES.md) — the user guides written for item 4.
* [`features/search-and-rules-reference.md`](features/search-and-rules-reference.md) — the
  developer reference: predicates, endpoints, the library pack format, scripting recipes.
* [`CONCURRENCY_TUNING.md`](CONCURRENCY_TUNING.md) — the ceilings and the timeout ladder
  rule. **The source of truth for the ladder values in [§7](#7-tuning-reference).**
* [`../CHANGELOG.md`](../CHANGELOG.md) — the per-change record.

---

## 1. What was wrong

### 1.1 Branding: a row that was never seeded, and a version check that could never pass

The branding settings live in one singleton row, `application_branding`, guarded by an
optimistic `version`. The only code that ever inserted that row is the migration
`20260608_1200_application_branding`, and it returns early when the table already exists.
It always does: the installer's fresh-database path (`backend/scripts/upgrade.py`) builds the
schema with `create_all` and stamps head, and the legacy chain's `0001_baseline` also runs
`create_all` first. **Every database built since the table entered the ORM has no row.**

From there the failure repeats forever:

1. `branding_repo.get_snapshot()` answers **version 0** for a missing row, so the page sends
   `expectedVersion: 0`.
2. `branding_repo.update_config()` creates the row inline at **version 1**, then compares
   `int(row.version or 1)` (1) with the expected 0 → `ConflictingVersion` → HTTP 409 →
   *"Someone else updated branding…"*.
3. The request's session rolls back on the error (`db/engine.py _session_scope`), so the row
   it just created is never committed. The next load reads version 0 again.

"Reload the latest" could not escape it either: the reload returned the identical payload,
react-query kept the same object, and the page's version stayed 0. The only accidental
workaround was **Reset to defaults** or a logo upload, which send no version.

The SSO settings singleton (`app_auth_config_repo`) had the identical defect.

The page had its own faults on top:

* After a save, the react-query cache still held the old values, so **Saved** never showed and
  **Discard** reverted to the pre-save values.
* Any background refetch (mount, reconnect, the app-wide `invalidateQueries()` on a permission
  change) **overwrote the form while you were typing**.
* A conflict was recognised by matching `version mismatch|conflict` in the error *text* —
  `authFetch` drops the HTTP status.
* A load failure showed an endless skeleton; the error branch was unreachable.
* The **description** never reached the app (no `<meta name="description">`, not in the
  preview), and the **support email** was shown nowhere.

### 1.2 Multi-select: the selection worked; what it drew did not

Cmd/Ctrl-click and the header **Select** toggle did build a multi-selection in the store, and
the browse-mode highlight did union every selected entity's lines. What failed:

* **A trace of the selection drew only the first entity.** Multi-seed tracing (added
  2026-09-21) reached the entry points and the walk — every seed was fetched and the models
  unioned — but the render layer (`useTraceOverlay`, `buildTraceView`, `buildLensSubgraph`)
  still took one focus, `tracedUrns[0]`. The union also removes seeds from the upstream and
  downstream sets, so seeds 2..N became *hosts*: dropped from the cards, drawn with no lines,
  their partners given no hop and hidden by any depth limit.
* **A multi-selection dimmed its own lineage partners** to 60 % opacity
  (`LayerColumn` applied the selection dim to every unselected row), so the upstream and
  downstream entities did not stand out the way they do for one selected entity.
* **Gestures:** Shift-click with its anchor in another column *replaced* the selection;
  `T` traced only a single selection; `F` opened the Lens on the first entity; the header
  tooltip said "Cmd-click" on Windows and Linux; on a Mac, Ctrl-click opened the context menu.
* **Gating:** a lone logical group enabled Trace, and the selection bar offered Trace and Focus
  even when tracing was switched off.
* **Performance:** the canvas trace walk memoised on an object rebuilt every render, so for
  more than one seed the union and two view-model passes re-ran on every canvas render.

### 1.3 Timeouts: the per-query budgets fired long before any outer limit

The stack nests its deadlines — per-query provider budget < engine budget < API (ASGI) tier <
browser < nginx — and the outer layers were never the problem (nginx 180 s, ingress 3600 s,
graph socket floor 615 s, FalkorDB `TIMEOUT_MAX` 180 s / 120 s on the production cluster).
What cut 10–60 s queries off were the innermost budgets:

| Where | Budget that fired |
|---|---|
| Advanced Search, one scan unit | **15 s** (`DEEP_SEARCH_CHUNK_TIMEOUT_MS`). A range unit over it was split and retried, wasting 15 s each time; a walk over one view subtree **cannot** be split, so the whole search failed. |
| Advanced Search, Load all / next page / API | units stopped starting after **19 s** (`_REQUEST_S = 40`) |
| Aggregate and path templates | **30 s** soft deadline, no continuation |
| Canvas `/nodes/query` | **20 s** |
| Children, ancestor chains, trace hops, generic reads | **15 s** |
| `/nodes/top-level` | **30 s** |
| `/edges/between` | **40 s** |
| `/edges/aggregated` | **30 s** per step, 36 s in all |

Each overrun was a 504, which the browser retries once — so the user waited about twice the
budget before seeing an error, and the store ran the failing query twice.

Two things made it worse:

* **A failed search counted as a provider outage.** `SearchFailed` was not registered as a
  logical exception, so the circuit breaker counted it; three in a row opened the breaker and
  failed **every graph read** on that provider for 30 s.
* **Hydrating a page of up to 1,000 hits after a long scan got 0.5 s**, so it often timed out
  and was retried.

### 1.4 Scaling: the ceiling is the graph store, and some shipped config was broken

The binding read constraint is **FalkorDB query threads on the shard that owns a data
source** (8 on a single instance, 6 per shard on the production cluster). More web replicas
add queue depth, not graph capacity. Around that:

* Each backend process opens up to ~85 Postgres connections across its six pools; four
  gunicorn workers per pod make one warm pod enough to exhaust Postgres's default 100.
  **Helm left `max_connections` at 100**; compose and k8s use 400.
* **Helm ran Redis at 256 MB with `noeviction`**, on an instance shared by job streams and
  cache — every write fails once it fills.
* **The production anti-affinity patch selected on `app:` labels no pod carries**, so it did
  nothing and replicas could all land on one node.
* **`kustomize build` panicked** on the production and production-cluster overlays (several
  `$patch: delete` documents in one file).
* Two existing docs promised **Postgres read replicas**, which the app does not support, and
  named Redis variables the code never reads.

### 1.5 Advanced Search and Display Rules: capable, undocumented

Both features existed and worked, but nothing explained them. Sharing is per view only
(a server-side view library of display rules and saved searches, portable as a
`.library.json` pack); import/export of that pack was reachable only from the Property
Manager; scripts must sign in with a session cookie. None of this was written down.

---

## 2. What changed — Branding

**Backend (the root cause).** In both `branding_repo.update_config()` and
`app_auth_config_repo.update_config()` the inline row now starts at **version 0** — the version
a missing row reports — and both `int(row.version or 1)` became `or 0` (the compare and the
bump). Changing only the create would still conflict, because `0 or 1 == 1`. The first save
lands at version 1 and commits; existing rows (version ≥ 1) behave exactly as before. **No
migration and no seeding**: databases already deployed repair themselves on their first save.

**Frontend.**

* A 409 is recognised by its status: `BrandingConflictError`, the pattern of
  `FeaturesConcurrencyError`. A non-409 error that happens to contain "conflict" is reported
  as an error, not a conflict.
* **The conflict panel keeps what you typed.** It says which version was saved and when, lists
  the fields both sides changed (Theirs · Yours, with colour swatches), and offers **Keep my
  changes** (your edits rebased onto the latest version; Save stays armed) or **Discard mine**.
  A lost race on *Use this mark* or *Remove uploaded image* says what was not applied and
  offers to load the latest version.
* The react-query cache follows every save; a background refetch never overwrites a form you
  are editing — it shows a "changed elsewhere" notice with a **Review** button instead.
* **Save sends only the fields you changed**, so untouched fields keep following the
  `APP_BRAND_*` env defaults instead of being frozen on the first save.
* Uploading an image or applying a mark keeps your unsaved text edits.
* A load failure shows an error with **Try again**. The action bar shows **N unsaved changes**.
* The description reaches `<meta name="description">`, the live preview and a subtitle on the
  sign-in screen (hidden when blank). The support email shows as **Contact support** in the
  Help panel (hidden when blank).

---

## 3. What changed — multi-select and the combined trace

**One trace, every origin.** The lens subgraph, the trace view model and the trace overlay take
an optional list of focus urns, defaulting to the single focus, so a one-entity trace is
byte-for-byte unchanged (checked against the previous code across every fixture, depth and
direction). Every selected entity is an origin; each partner's hop is measured from its
nearest origin; every origin's containers open; lines touching any origin keep the trace
emphasis.

**Trace controls.** The dock's focus chip reads **Tracing N entities** and opens a list of the
seeds, each with its type and a remove button. Removing one narrows the picture **without
fetching again**; removing the last ends the trace. On a narrow dock the label shortens to
"N entities" and then to a stack of initials with a "+N" bubble. More than 25 selected
entities are traced as the first 25, with a notice. History remembers the whole seed set and
restores it. Share is withheld for a combined trace, because a share link carries one entity.

**Browse mode.** A multi-selection no longer dims its own partners: upstream and downstream
entities stay at full strength with the ring they get for a single selection. The highlight is
computed in one pass however many entities are selected. The selection bar shows **↑ N in ·
↓ M out** for the combined selection and a gesture hint in the platform's own modifier.

**Gestures.** ⌘/Ctrl-click adds one; Shift-click **adds** a range (also across columns);
Space or ⌘/Ctrl+Enter toggles the focused row; Shift-click no longer paints a text selection;
a Mac Ctrl-click toggles instead of opening the context menu (a real right-click still opens
it). `T` traces the whole selection, `F` opens the Lens on it. A lone logical group no longer
enables Trace, and the selection bar offers Trace and Focus only when tracing is enabled.

**No backend change.** `/trace/closure` is per entity; the existing browser fan-out and union is
the right design, now capped at 25 seeds.

---

## 4. What changed — timeouts

Every per-query budget that cut large-graph queries off is raised, each outer layer is raised
to keep outlasting the one inside it, and every per-query budget stays under the production
cluster's `TIMEOUT_MAX` of 120 s. The full table, with what each bounds and when to change it,
is [§7.1](#71-backend-timeouts-env).

Alongside:

* **A failed search is no longer a provider outage.** `SearchFailed` is registered as a
  logical exception, so the breaker does not count it; the API answers it as a structured
  **500 `SEARCH_FAILED`** with a reason. It stays a 500 on purpose: the browser treats a 500 as
  a rejected query and does not retry it, whereas a 504 would re-run up to 100 s of work that
  fails the same way.
* **Hydrating hits after a long scan gets 5 s** (was 0.5 s).
* `getEdges` now passes the edges-between budget; it used the 45 s default against an 80 s
  server budget.
* The search schema (`backend/common/schema/searchquery.v1*.json`, and the generated frontend
  types) is regenerated for the new `softDeadlineMs` default.
* A new test, `backend/tests/test_timeout_ladder.py`, pins the nesting: the search budgets fit
  the request cap, the request cap fits the tier, every per-query budget fits `TIMEOUT_MAX`
  as the production-cluster manifest sets it, and the fleet-slot staleness outlasts the tier.

---

## 5. What changed — scaling

* **New guide, [`SCALING_CONCURRENT_USERS.md`](SCALING_CONCURRENT_USERS.md)** (in-app under
  Operations): the capacity model; a tier-by-tier table; the Postgres connection worksheet
  (replicas × workers × pools against `max_connections`, direct vs a transaction pooler, and
  how `GRAPH_READ` sizes the graph admission gate); FalkorDB threads, queue, replicas vs
  shards, sockets and the shedding layers; Redis roles, clients and memory policy; the timeout
  ladder and what longer budgets cost; metrics and alert thresholds; a load-test procedure;
  ready-to-apply profiles for ~100, ~500 and ~1000+ concurrent users; known gaps. Every knob
  is checked against the code; computed figures are marked *derived*.
* **Production anti-affinity** now selects on `app.kubernetes.io/name`, the label the pods
  carry.
* **The production overlays build.** Each `$patch: delete` is its own patch; all four overlays
  build with kustomize 5.4 and 5.6 and render the resources intended (in-cluster Postgres and
  Redis removed on production; the single FalkorDB replaced by the three shards on
  production-cluster).
* **Helm:** Postgres `max_connections` and Redis `maxmemory` / `maxmemory-policy` are values
  (see [§7.5](#75-helm-values)), with the Redis pod's memory raised to fit.
* The `PROVIDER_FLEET_MAX_CONCURRENCY` comment is corrected (0 sizes from `THREAD_COUNT`; a
  negative value turns the fleet counter off). The read-replica claims and the non-existent
  Redis variable names in `INFRASTRUCTURE_LAUNCH_SCALE.md`, `INFRASTRUCTURE_SCALING_250M.md`
  and `architecture-when-scaling.md` are corrected.

---

## 6. What changed — Advanced Search and Display Rules

* **User guides**, in-app: [`guide/ADVANCED_SEARCH.md`](guide/ADVANCED_SEARCH.md) (Viewer)
  and [`guide/DISPLAY_RULES.md`](guide/DISPLAY_RULES.md) (Builder) — a five-minute start,
  every workflow, shortcuts, recipes, limits and troubleshooting.
* **Developer reference**, in-app under Services:
  [`features/search-and-rules-reference.md`](features/search-and-rules-reference.md) — signing
  in from a script (session cookie + `X-CSRF-Token`), every predicate kind and operator, scope
  and options, every search and library endpoint with permissions and errors, the rule model,
  the library pack format and its import behaviour, curl and Python recipes, and an explicit
  list of what is not supported.
* **Examples**, [`examples/search-and-rules/`](examples/search-and-rules/): seven ready-made
  queries and two library packs (governance, data quality), each validated in a test against
  the real models and imported through the real endpoint.
* **Publish script**, `backend/scripts/publish_view_library.py`: publishes a pack to one view
  (`--view`) or to **every view of a data source** (`--data-source`), dry run unless `--apply`.
  This is how a pack is rolled out across a data source — there is no data-source-level
  library.
* **Pack schema**, `backend/common/schema/view-library.v1.json`, generated from the model by
  `backend/scripts/export_view_library_schema.py` and pinned by a test.
* **The Advanced Search Library menu** can export the view's library and (for editors) import
  one — previously only the Property Manager could. Keys pressed in that menu and its import
  dialog no longer reach the search panel's shortcuts.
* `services/SEARCH.md` now lists all twelve search endpoints; `guide/IMPORT_EXPORT.md` covers
  library packs.

---

## 7. Tuning reference

Everything an operator can turn that this release touched. Backend values are read from the
environment at process start; **browser values are baked in when the frontend image is
built.** Env overrides keep working — a deployment that pins an old value keeps it.

### 7.1 Backend timeouts (env)

| Variable | Was | Now | What it bounds | Raise / lower when |
|---|---|---|---|---|
| `FALKORDB_QUERY_TIMEOUT` | 15 | **30** s | Generic graph read: ancestor chains, trace hops, `/nodes/degree`, single-node reads. Every role reads it. | Raise if ancestor chains come back unknown on deep hierarchies. Pin lower on workers if their unbudgeted reads should fail fast. |
| `FALKORDB_CHILDREN_QUERY_TIMEOUT` | 15 | **30** s | Each of the two queries behind children / children-with-edges (keep equal to the generic read). | As above; 2 × this must stay under `HTTP_TIMEOUT_GRAPH_SECS`. |
| `FALKORDB_NODES_QUERY_TIMEOUT` | 20 | **45** s | `/nodes/query`, the canvas hydration hot path. | Raise if views on very large graphs open partially. |
| `FALKORDB_TOP_LEVEL_QUERY_TIMEOUT` | 30 | **60** s | `/nodes/top-level` page query (+ `FALKORDB_TOP_LEVEL_COUNT_TIMEOUT` 5 s, unchanged). | Raise if root columns of huge sources time out. |
| `FALKORDB_EDGES_BETWEEN_TIMEOUT` | 40 | **80** s | `/edges/between` urn-set edge resolve. | Must stay under `HTTP_TIMEOUT_AGGREGATION_SECS`. |
| `FALKORDB_AGGREGATED_READ_TIMEOUT_SECS` | 30 | **60** s | One step of `/edges/aggregated`; the whole read gets 0.8 × `HTTP_TIMEOUT_AGGREGATION_SECS` (**72 s**). | Raise with the aggregation tier. |
| `DEEP_SEARCH_CHUNK_TIMEOUT_MS` | 15000 | **45000** | One Advanced Search scan unit (also the FalkorDB statement timeout for it). | Raise if single-subtree searches fail; **keep ≤ 94 000** (a unit is cut at 94 s regardless). Lower `DEEP_SEARCH_CHUNK_WIDTH` (50 000) instead if progress updates feel slow. |
| `HTTP_TIMEOUT_GRAPH_SECS` | 60 | **120** s | API tier for `/graph/*`, including canvas bootstrap and Advanced Search. | Keep above every graph budget and the 100 s search cap, and **below 150** (`_FLEET_SLOT_STALE_S`). |
| `HTTP_TIMEOUT_TRACE_SECS` | 60 | **120** s | API tier for trace routes. | Keep ≥ `TRACE_TIMEOUT_SECS`. |
| `HTTP_TIMEOUT_AGGREGATION_SECS` | 45 | **90** s | API tier for `/edges/aggregated`, `/edges/between`, `/aggregation/*`. | Keep above `FALKORDB_EDGES_BETWEEN_TIMEOUT`. |
| `TRACE_TIMEOUT_SECS` | 60 | **120** s | Outer trace budget; the engine stops `TRACE_ENGINE_HEADROOM_SECS` under it. | Lower (e.g. 90) to shorten how long deep traces hold graph slots. |
| `TRACE_ENGINE_HEADROOM_SECS` | 10 | **20** s | Time left to serialise a large, truncated trace. Engine budget = 120 − 20 = **100 s**. | Raise if very large truncated traces time out while being sent. |

Unchanged but related: `HTTP_TIMEOUT_VERSIONING_SECS` 120, `HTTP_TIMEOUT_DEFAULT_SECS` 30,
`FALKORDB_SERVER_TIMEOUT_MAX_MS` 180 000 (must match the servers' `TIMEOUT_MAX`),
`DEEP_SEARCH_CHUNK_CONCURRENCY` 2, `PROVIDER_MAX_CONCURRENCY` 8,
`PROVIDER_FLEET_MAX_CONCURRENCY` 0 (derive from `THREAD_COUNT`).

`DEEP_SEARCH_SOFT_DEADLINE_MS` (now 60000) is **read but not used** by anything; the effective
default is the request option `softDeadlineMs` below.

### 7.2 Request defaults and browser timeouts (build-time)

| Setting | Was | Now | Notes |
|---|---|---|---|
| `SearchOptions.softDeadlineMs` default | 30000 | **60000** | The whole budget of aggregate/path templates and capped facets. Per request; max 120 000. |
| Search panel `softDeadlineMs` (`searchOptions.ts`) | 20000 | **45000** | Load all / next page only. |
| `VITE_TIMEOUT_DEFAULT_MS` | 30000 | **45000** | Any fetch without its own budget. |
| `VITE_TIMEOUT_NODES_QUERY_MS`, `VITE_TIMEOUT_GET_CHILDREN_MS`, `VITE_TIMEOUT_TOP_LEVEL_MS` | 45000 | **150000** | |
| `VITE_TIMEOUT_ANCESTOR_CHAINS_MS`, `VITE_TIMEOUT_TRACE_MS` | 75000 | **150000** | |
| `VITE_TIMEOUT_CANVAS_BOOTSTRAP_MS` | 60000 | **150000** | |
| `VITE_TIMEOUT_SEARCH_ADVANCED_MS` | 45000 | **150000** | |
| `VITE_TIMEOUT_AGGREGATED_EDGES_MS`, `VITE_TIMEOUT_EDGES_BETWEEN_MS` | 60000 | **105000** | Aggregation tier is 90 s. |

Browser values are clamped to safe ranges in `frontend/src/config/timeouts.ts`; a value outside
the range is clamped with a console warning.

### 7.3 Values set in code (a change needs a code change)

| Constant | Value | Where | Must hold |
|---|---|---|---|
| `_REQUEST_S` | **100** s (was 40) | `backend/app/providers/falkordb_search/engine.py` | < `HTTP_TIMEOUT_GRAPH_SECS`. Sets the 94 s cap on a search unit (100 − 2 × `_GRACE_S` 3). |
| `_HYDRATE_FLOOR_S` | **5** s (new; was 0.5) | same | Fits inside the tier with `_REQUEST_S`. |
| `_FLEET_SLOT_STALE_S` | 150 s (unchanged) | `backend/app/providers/manager.py` | > `HTTP_TIMEOUT_GRAPH_SECS`. Raise it if you raise the graph tier past ~140 s. |
| nginx `proxy_read_timeout` (`/api/`) | 180 s (unchanged) | `frontend/nginx.conf` | > the largest browser timeout (150 s). |
| `MAX_TRACE_SEEDS` | **25** (new) | `frontend/src/hooks/useCanvasTraceWalk.ts` | Each seed is two closure requests and up to `TRACE_CHECKPOINT_NODES` (20 000) nodes in memory. |
| `FOCUS_AUTO_OPEN_MAX` | 10 (unchanged; now per seed) | `frontend/src/hooks/useTraceOverlay.ts` | Containers auto-opened around each origin. |

### 7.4 The rule every value must keep

**Provider budget < engine budget < API tier < browser < nginx < load balancer**, and every
per-query budget < FalkorDB `TIMEOUT_MAX`. When the outer layer fires first, the user gets an
abort instead of the server's structured answer, and a retry doubles the load on exactly the
query that was slow. `backend/tests/test_timeout_ladder.py`,
`backend/tests/test_timeout_middleware.py` and
`frontend/src/config/__tests__/timeouts.budgets.test.ts` fail the build if a default breaks it.
An override in one environment is not checked — change a layer and its neighbours together.

### 7.5 Helm values

| Value | Was | Now | Notes |
|---|---|---|---|
| `stores.postgres.maxConnections` | server default 100 | **400** | Parity with compose and k8s. At HPA scale, front Postgres with a transaction pooler rather than raising this (scaling guide §4.5). |
| `stores.redis.maxmemory` | 256mb (hard-coded) | **2gb** | Pod memory raised to 2Gi request / 2560Mi limit to fit. |
| `stores.redis.maxmemoryPolicy` | `noeviction` (hard-coded) | **`volatile-lru`** | Evicts only keys with a TTL (cache), keeps the job streams. |

### 7.6 Capacity knobs (unchanged, now documented)

The scaling guide covers these with worked numbers; the ones operators reach for first:

* **Postgres pools per process:** `DB_<ROLE>_POOL_SIZE` / `DB_<ROLE>_POOL_MAX_OVERFLOW` for
  `WEB`, `JOBS`, `READONLY`, `PROVIDER_PROBE`, `GRAPH_READ`, `ADMIN`, plus the versioned
  store's `GRAPHVER_POOL_*`; `DB_POOLER_MODE=transaction` behind a transaction pooler.
  Connections ≈ replicas × `GUNICORN_WORKERS` (4) × Σ pools.
* **Graph admission:** `PROVIDER_MAX_CONCURRENCY`, `PROVIDER_FLEET_MAX_CONCURRENCY`,
  FalkorDB `THREAD_COUNT` / `MAX_QUEUED_QUERIES`; the `GRAPH_READ` pool also sizes the
  per-process admission gate (pool − 4).
* **Redis clients:** `REDIS_STREAMS_MAX_CONNECTIONS`, `REDIS_CACHE_MAX_CONNECTIONS`.
* **Rolling deploys** with longer requests: `GUNICORN_GRACEFUL_TIMEOUT` (30 s) and the viz
  Deployment's `terminationGracePeriodSeconds` (45 s) cut requests in flight — raise both if
  long reads are common (the guide has the patch).

### 7.7 Publish script

`backend/scripts/publish_view_library.py PACK (--view ID | --data-source ID) [--branch ID]
[--strategy merge|copy|replace] [--apply] [--base-url URL] [--email E] [--password P]`.
Defaults come from `SYNODIC_BASE_URL` (else `http://localhost:8000`), `SYNODIC_EMAIL` and
`SYNODIC_PASSWORD` (else a prompt; never printed). Exit 0 = every item imported or skipped;
1 = a refusal, an HTTP error or no readable view; 2 = bad arguments, pack or login.

---

## 8. Rollout

1. **Deploy the backend.** No migration. The first Branding (or SSO settings) save on a
   database without the singleton row now creates it.
2. **Rebuild and deploy the frontend image.** The `VITE_TIMEOUT_*` values are compiled in; an
   old image keeps the old browser timeouts and will abort before the server answers.
3. **Raise idle timeouts in front of the app to ≥ 150 s** — a cloud load balancer, API gateway
   or corporate proxy (60 s is a common default). The repo's own ingress (3600 s) and nginx
   (180 s) already outlast the app.
4. **Helm deployments** pick up `max_connections=400` and Redis at 2 GB `volatile-lru` on the
   next upgrade; make sure the Redis node can schedule a 2Gi request. Deployments that
   override these keep their values.
5. **Kustomize production / production-cluster** now render; render once before the rollout
   and diff against what is running.
6. **Optional:** if a deployment wants the old, shorter timeouts, set the variables in
   [§10](#10-going-back) — nothing else depends on the new values.

---

## 9. Verifying it worked

* **Branding:** on a database without the row, `GET /api/v1/admin/branding` returns
  `version: 0`; a `PATCH` with `expectedVersion: 0` returns **200** at version 1; the next
  save with version 1 returns 200 at version 2. In the UI, change the application name and
  description, save: **Saved** shows, the tab title and the sign-in subtitle change.
* **Multi-select:** select three entities with ⌘/Ctrl-click — all three entities' lines light
  up and their partners stay at full strength; the selection bar shows the in/out counts.
  Press `T`: the dock reads **Tracing 3 entities**, all three rows are marked as origins,
  and removing one from the dock's list makes no network request.
* **Timeouts:** `python -m pytest tests/test_timeout_ladder.py tests/test_timeout_middleware.py`
  passes; on a very large source, an Advanced Search over a whole view that took 20–40 s now
  completes instead of failing, and a failed search no longer opens the breaker (the Data
  health / provider status stays healthy).
* **Scaling config:** `kustomize build deploy/k8s/overlays/production` and
  `…/production-cluster` succeed; `helm template` renders `max_connections=400` and
  `--maxmemory 2gb --maxmemory-policy volatile-lru`.
* **Publish script:** `publish_view_library.py docs/examples/search-and-rules/packs/governance.library.json --view <id>`
  prints a dry-run table; with `--apply` the rules appear in the view's Property Manager.
* **Suites at the time of writing** (after merging `main`): frontend **716 files / 6,947
  tests passed**; backend **9,250 passed**, with the same 16 failures as unchanged `main`
  (feature gates, layered lineage schema, invite migration, refresh-token GC, ancestor chains)
  and none new; `tsc` and ESLint add nothing over the baseline.

---

## 10. Going back

| Piece | How | What comes back |
|---|---|---|
| Longer backend timeouts | Set `FALKORDB_QUERY_TIMEOUT=15`, `FALKORDB_CHILDREN_QUERY_TIMEOUT=15`, `FALKORDB_NODES_QUERY_TIMEOUT=20`, `FALKORDB_TOP_LEVEL_QUERY_TIMEOUT=30`, `FALKORDB_EDGES_BETWEEN_TIMEOUT=40`, `FALKORDB_AGGREGATED_READ_TIMEOUT_SECS=30`, `DEEP_SEARCH_CHUNK_TIMEOUT_MS=15000`, `HTTP_TIMEOUT_GRAPH_SECS=60`, `HTTP_TIMEOUT_TRACE_SECS=60`, `HTTP_TIMEOUT_AGGREGATION_SECS=45`, `TRACE_TIMEOUT_SECS=60`, `TRACE_ENGINE_HEADROOM_SECS=10` | The previous ladder, except the search request cap: `_REQUEST_S` (100 s) is code, so a non-progressive search (Load all, API callers) can outrun a 60 s graph tier and get a 504. Going fully back also means restoring `_REQUEST_S = 40` in `falkordb_search/engine.py`. |
| Longer browser timeouts | Build with the old `VITE_TIMEOUT_*` values | The previous client deadlines. |
| `SEARCH_FAILED` not counted by the breaker | No knob | A failed search counting as an outage is the bug this fixes. |
| Helm Postgres / Redis values | Set `stores.postgres.maxConnections` / `stores.redis.maxmemory`, `maxmemoryPolicy` | Any values you choose; `noeviction` is not recommended on a shared instance. |
| Combined trace | No knob; select one entity | The single-entity trace, unchanged. |
| The seed cap (25) | `MAX_TRACE_SEEDS`, code | Larger combined traces, at the cost of more concurrent closure requests and memory. |

---

## 11. Known limitations and follow-ups

* **Searches and display rules are shared per view.** There is no data-source-level library;
  publishing to a data source is a fan-out to its views (the publish script).
* **Scripts sign in with a session cookie.** There are no API tokens or service accounts.
* **A share link carries one entity**, so Share is not offered for a combined trace. A combined
  entry in the dock's Recent list can show as active together with an older single-entity
  entry for its first seed.
* **Slow queries now hold a graph slot, a FalkorDB thread and a `GRAPH_READ` connection
  longer** before they give up; the browser's one retry doubles time-to-error. The scaling
  guide §7.4 covers the trade-off and the metrics to watch.
* **`/canvas/bootstrap` can still exceed its tier** in the worst case (top-level 65 s +
  edges-between 80 s against 120 s); the browser then falls back to the per-purpose endpoints,
  as before.
* **Found while writing the guides, not fixed here:**
  * Advanced Search Code mode documents `tag:PII,GDPR` as "either tag", but it parses as one tag
    plus name filters. The guide uses `tag:PII OR tag:GDPR`.
  * Enter on buttons in the search panel's Save and Export dialogs is still swallowed by the
    panel's shortcuts (fixed for the Library menu and its import dialog only).
  * `DEEP_SEARCH_SOFT_DEADLINE_MS` is dead config.
  * To verify in a real cluster: the default-deny NetworkPolicy does not admit the FalkorDB
    cluster shards, a Prometheus scraper or the in-cluster load test; the k8s FalkorDB PVC is
    mounted at `/data` while compose and Helm use `/var/lib/falkordb/data`. Both are in the
    scaling guide's Known gaps.

---

## 12. What was corrected while this was being built

* **The Branding fix needed three lines, not one.** Creating the inline row at version 0 alone
  still failed, because `int(row.version or 1)` turns 0 back into 1.
* **"Keep my changes" silently dropped a lost built-in-mark or image removal** in the first
  version of the conflict panel; it now says what was not applied and offers to reload.
* **A failed search went from 503 to a bare 500** once the breaker stopped wrapping it; it now
  has its own handler and a typed `SEARCH_FAILED` body.
* **The seed-list popover went back and forth over its background.** A review asked for
  `bg-canvas-elevated/98` to match its siblings — but an alpha suffix on a CSS-variable token
  emits no CSS (the siblings have no fill either), and the repo's guard test fails on it. The
  blur is the surface.
* **The `kustomize build` panic predates this work.** It was found while validating the
  anti-affinity fix and fixed here because it blocks every production rollout.
