# Versioned Graph — End-to-End Testing Guide

> 📚 **Part of the Versioned Graph documentation suite.** This guide is the hands-on
> run/test companion; for the concepts see the
> [Overview & Architecture](/docs/versioning-overview) and the
> [API Reference](/docs/versioning-api-reference). Permission strings map to the
> [RBAC taxonomy](/docs/rbac).

> **At a glance.** Bring up the Postgres stack, drive the whole *git-for-graphs* flow over
> HTTP (one smoke script or by hand with curl), and verify it: create graph → draft →
> stage → checkpoint → publish → history/diff → fork → PR → merge, plus revert/restore,
> "enable version control" bootstrap, and the automated test suites.

The versioned-graph store (`graphver`) and its API: *git for graphs* — per-user
**drafts**, **checkpoints**, **squash-publish** to `main`, copy-on-write
**forks**, and **pull requests** with field-level 3-way merge. The browser never
touches Postgres directly; everything goes through the API.

```
HTTP client / browser
   │  /api/v1/{ws_id}/versioning/...        (cookie session + CSRF)
   ▼
viz-service (FastAPI)  ──►  GraphVersioningService  ──►  Postgres  (graphver schema — source of truth)
                                                    └─►  FalkorDB projection (derived hot reads — optional)
```

Reads through the API (`/state`, `/history`, `/diff`) come from **Postgres**. The
FalkorDB projection is a derived, rebuildable cache and is **not required** for
end-to-end testing.

> The store needs Postgres (JSONB + hash partitions), so use the Postgres stack —
> not the SQLite quickstart image.

---

## 1 · Bring up the stack

### Docker (recommended)

```bash
docker compose up --build
```

The one-shot **`upgrade`** service runs `alembic upgrade head` — which applies the
`graphver` provisioning migration — **before** viz-service starts
(`depends_on … service_completed_successfully`). viz-service then verifies the
schema is at head.

| What | Where |
|------|-------|
| viz-service API (direct) | http://localhost:8000 |
| viz-service via nginx | http://localhost:3080/api |
| Swagger | http://localhost:8000/docs |
| Admin login | `admin@nexuslineage.local` / `admin123` |

### Local dev (uvicorn, hot reload)

```bash
docker compose -f docker-compose.dev.yml up -d                 # Postgres 16
export MANAGEMENT_DB_URL='postgresql+asyncpg://synodic:synodic@localhost:5432/synodic'

# Migrations are owned by the upgrade script — init_db() only VERIFIES head.
python -m backend.scripts.upgrade upgrade                      # applies the graphver migration

uvicorn backend.app.main:app --port 8000
```

First boot seeds the admin user (local `.env.dev` uses `admin@nexuslineage.local`
/ `admin123`).

---

## 2 · Drive the flow

### One command — the smoke script

```bash
pip install httpx
python scripts/versioning_smoke.py --base http://localhost:8000 \
    --email admin@nexuslineage.local --password admin123
```

It logs in, then runs the whole MVP over HTTP and prints a green checklist:

```
create graph → open draft → stage → checkpoint → read state
            → publish to main → history + diff
            → fork (copy-on-write) → diverge → open PR → preview → merge → verify
```

The lifecycle those steps exercise — from an isolated draft through review to a shared
`main`, and the two ways back out:

```mermaid
flowchart LR
    D["Draft<br/>(working_changes)"] -->|checkpoint| C["Commit<br/>(version rows)"]
    C -->|merge-preview| R{"review /<br/>PR"}
    R -->|publish / merge| M["main @ head"]
    M -->|revert one commit<br/>(may 409)| M
    M -->|restore to a point<br/>(never conflicts)| M
    M -.->|project| F[("FalkorDB<br/>hot reads")]
    D -.->|fork (copy-on-write)| D2["Fork → PR → base"]
    D2 -->|merge| M
```

`--workspace` is optional: it discovers the first workspace from
`GET /api/v1/admin/workspaces`, or synthesizes one (admin's `system:admin` works
in any workspace; the store treats `workspace_id` as a logical reference).

### Manual — curl

```bash
BASE=http://localhost:8000
# 1) login (persist cookies) and grab the CSRF token
curl -c cookies.txt -s -X POST $BASE/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@nexuslineage.local","password":"admin123"}' >/dev/null
CSRF=$(awk '/nx_csrf/{print $7}' cookies.txt)
WS=ws_demo          # any id works for admin; or pick one from GET /api/v1/admin/workspaces

post(){ curl -b cookies.txt -s -H "x-csrf-token: $CSRF" -H 'content-type: application/json' -X POST "$@"; }

# 2) create a graph, open a draft, stage, checkpoint, publish
GID=$(post $BASE/api/v1/$WS/versioning/graphs -d "{\"dataSourceId\":\"ds_demo\",\"workspaceId\":\"$WS\"}" | jq -r .graphId)
BID=$(post $BASE/api/v1/$WS/versioning/graphs/$GID/branches -d '{}' | jq -r .branchId)
post $BASE/api/v1/$WS/versioning/graphs/$GID/branches/$BID/changes \
  -d '{"ops":[{"op":"create","entityKind":"node","entityId":"A","payload":{"displayName":"Alpha"}}]}'
post $BASE/api/v1/$WS/versioning/graphs/$GID/branches/$BID/commit -d '{"message":"seed"}'
post $BASE/api/v1/$WS/versioning/graphs/$GID/branches/$BID/publish -d '{"message":"v1"}'

# 3) read it back (GET needs no CSRF)
curl -b cookies.txt -s "$BASE/api/v1/$WS/versioning/graphs/$GID/branches/$BID/state" | jq
```

---

## 3 · Endpoint reference  ·  `/api/v1/{ws_id}/versioning`

| Method & path | Purpose | Permission |
|---|---|---|
| `POST /graphs` | create a versioned graph | `…:manage` |
| `POST /blank-graphs` | one-call blank model: manual data source + genesis graph (see §7) | `…:manage` |
| `GET  /graphs/{gid}` | graph metadata | `…:read` |
| `GET  /graphs/{gid}/branches` | list branches (main + drafts) | `…:read` |
| `POST /graphs/{gid}/branches` | open a draft | `…:manage` |
| `POST /graphs/{gid}/branches/{bid}/changes` | bulk-stage node/edge edits | `…:manage` |
| `POST /graphs/{gid}/branches/{bid}/commit` | checkpoint the draft | `…:manage` |
| `GET  /graphs/{gid}/branches/{bid}/merge-preview` | dry-run publish (conflicts) | `…:read` |
| `POST /graphs/{gid}/branches/{bid}/publish` | squash-publish to main | `…:manage` |
| `GET  /graphs/{gid}/branches/{bid}/state` | live node/edge state | `…:read` |
| `GET  /graphs/{gid}/entities/{eid}/history` | entity revision timeline | `…:read` |
| `GET  /graphs/{gid}/branches/{bid}/diff?fromSeq=&toSeq=` | field-level diff | `…:read` |
| `POST /graphs/{gid}/forks` | copy-on-write fork | `…:read` |
| `POST /graphs/{gid}/pulls` | open a PR (fork → base) | `…:read` |
| `GET  /graphs/{gid}/pulls` | list PRs targeting this graph | `…:read` |
| `GET  /pulls/{pr}` | PR metadata | `…:read` |
| `GET  /pulls/{pr}/preview` | dry-run the PR merge | `…:read` |
| `POST /pulls/{pr}/merge` | merge the PR into base main | `…:manage` |
| `POST /graphs/{gid}/commits/{cid}/revert` | undo ONE published commit (409 `merge_conflict` if later commits touched the same entities) | `…:manage` |
| `POST /graphs/{gid}/commits/{cid}/restore` | reset main to its state at that commit — point-in-time rollback, never conflicts | `…:manage` |
| `GET  /graphs/{gid}/commits/{cid}/restore-preview` | exact impact of that restore (commits undone + per-kind counts) | `…:read` |

`…` = `workspace:datasource` (a versioned graph is 1:1 with a data source).

### Rollback: revert vs restore

Both write a **new commit** — history is never rewritten, and the rollback itself is
revertable.

- **Revert** undoes one commit and keeps everything after it (git-revert). Because it
  has to reconcile with later work, it *can* conflict: if a later commit changed the same
  entities, it returns 409 with the blocking entity ids.
- **Restore** resets main to its state at commit *K*: entities modified after *K* go back,
  entities created after *K* are deleted, entities deleted after *K* come back. It
  overrides everything after *K* by definition, so it **cannot conflict** — which makes it
  the escape hatch when a revert is blocked. The UI offers exactly that (a blocked revert
  offers "restore to just before it instead"). Restoring to genesis is the well-defined
  "empty the graph".

The UI reaches both from the history timeline (per-revision menu) and offers "Revert this
merge" on a merged PR (which maps to its `resulting_commit_id`).

### "Enable version control" (`/api/v1/{ws_id}/graph/bootstrap`)

Copying a whole source graph into version history is a **job**, not a request — a 10M-entity
graph cannot be paged into one HTTP call, and doing so made the web tier's memory O(graph).

| Method & path | Purpose | Permission |
|---|---|---|
| `POST /graph/bootstrap?dataSourceId=` | start the copy → **202** `{jobId, graphId, status}` (200 `{alreadyEnabled}` if versioned) | `…:manage` |
| `GET  /graph/bootstrap/status?dataSourceId=` | phase / processed / total / percent / error / integrity report | `…:read` |
| `POST /graph/bootstrap/retry?dataSourceId=&mode=resume\|restart` | resume from the last window, or re-read the source | `…:manage` |
| `POST /graph/bootstrap/abandon?dataSourceId=` | drop everything the job imported; the source reads as before | `…:manage` |

Phases: `counting → nodes → edges → validate → heads → merkle → backfill → finalize`.

```mermaid
stateDiagram-v2
    [*] --> counting: POST /bootstrap (202)
    counting --> nodes
    nodes --> edges
    edges --> validate: bounded ID-range windows
    validate --> heads
    heads --> merkle
    merkle --> backfill: stamp projector anchors
    backfill --> finalize
    finalize --> [*]: head flips → live & writable
    validate --> failed: integrity mismatch
    nodes --> failed: budget exhausted
    failed --> nodes: retry?mode=resume
    failed --> counting: retry?mode=restart
    failed --> [*]: abandon (source reads as before)
    note right of finalize
        irreversible — everything the
        live graph needs must be true first
    end note
```

> **Warning:** `finalize` is the only irreversible phase — it flips the head, making the
> graph live and writable, and fast-forwards the projection watermark. It runs **last**,
> after `backfill` has stamped the projector's delete/update anchors. A failed job
> **blocks writes** to that graph until you resume or abandon it — editing around it would
> let the projector drop and reseed the graph from a fraction of the data.

**`finalize` is last, and it is the only irreversible step** — it flips the head, which makes
the graph live and writable. Everything the live graph depends on must already be true when
it runs, including `backfill`, which stamps the projector's delete/update anchors
(`n.entityId`, `r.id`) onto the source graph. Finalizing first would leave a window — and,
if backfill then failed, a permanent state — where the graph is editable but the projector
cannot anchor: an edit MERGEs a duplicate node beside the original, and a delete matches
nothing and silently leaves the entity on the canvas.

Properties worth knowing:

- **Bounded memory.** The source is scanned in ID-range windows (never OFFSET) and written
  in per-window transactions: peak memory is O(window), not O(graph).
- **Resumable.** Rows, tallies and the cursor commit in ONE transaction, and version rows
  carry deterministic ids (`ON CONFLICT DO NOTHING`), so a crashed worker resumes exactly
  and a replayed window is a no-op. A `running` job whose heartbeat goes stale is taken over.
- **Invisible until proven.** The import commit sits at seq 2 while the head stays at
  genesis; every read composes bounded by `main_head_commit_seq`. Validation runs *before*
  `entity_heads` is written, so a failed copy leaves the data source reading exactly as it
  did — there is nothing to unwind. A failed job therefore also **blocks writes** to that
  graph (resume it or abandon it): editing around it would advance the head past the partial
  import commit, un-park the projection watermark, and let the projector drop and reseed the
  source graph from a fraction of the data.
- **Proven.** Source counts vs what landed, per node label AND per edge type (the
  containment/lineage preservation proof), no duplicate identifiers, no dangling endpoints,
  plus a random sample re-read from the source and content-hash-compared. The report is
  persisted on the job and rendered in the UI.
- **No reseed.** The graph is pinned to the source FalkorDB graph the canvas already reads,
  and validation just proved they agree, so finalize *fast-forwards* the projection
  watermark. (During the copy the watermark is parked at genesis on purpose: a projector
  that thought it had work would DROP that graph and reseed it from an empty genesis.)
- What the copy contains is **exactly what the application can see**: the reader ignores
  nodes without a `urn` and edges whose endpoints have none, so those are counted and
  disclosed in the report rather than copied. Derived artifacts (`:AGGREGATED`,
  `_GVRollupMeta`, `_AggMeta`, `_Projection`) are never imported.
- **Survives the infrastructure.** A copy of a 10M-entity graph runs for tens of minutes —
  long enough to span a FalkorDB restart, a Postgres failover, a node rotation or a network
  blip. Those are waited out with backoff (`BOOTSTRAP_RETRY_BUDGET_SECS`), not treated as
  fatal; a *fault that shrinking can fix* (a window too fat for the server's query budget)
  shrinks the window instead. The number of interruptions ridden out is recorded on the job.
  Beyond the budget the job fails honestly and stays resumable from its cursor.
- **FalkorDB only, and it says so up front.** The scan is FalkorDB-shaped (`ID(n)` windows,
  FalkorDB row decoding). A data source on any other provider is refused at the door with
  `422 provider_unsupported` — before a graph shell exists — rather than accepted with a 202
  and failed later, which would leave the data source write-blocked behind an impossible job.

#### Tuning (all optional; defaults are sized for a 10M-entity graph)

| Knob | Default | Meaning |
|---|---|---|
| `GRAPHVER_BOOTSTRAP_SCAN_WIDTH` | 100000 | Node-id span per scan window (`config.py:235`). |
| `GRAPHVER_BOOTSTRAP_SCAN_MIN_WIDTH` | 10000 | Floor the halve-on-oversize ladder stops at (`config.py:236`). |
| `GRAPHVER_BOOTSTRAP_EDGE_TARGET` | 50000 | Edges per window. Node ids cluster by type, so the edge phase counts a window's edges first and shrinks the node span until it fits (`config.py:242`). |
| `GRAPHVER_BOOTSTRAP_WINDOW` | 50000 | Rows per Postgres write transaction (`config.py:244`). |
| `GRAPHVER_BOOTSTRAP_SAMPLE_K` | 64 | Entities re-read from the source and content-hash-compared during validation (`config.py:246`). |
| `GRAPHVER_BOOTSTRAP_MERKLE_MAX` | 1000000 | Above this the import commit's Merkle root is left NULL and the report says `merkle: deferred`, rather than building a 10M-entity tree in memory (`config.py:250`). |
| `GRAPHVER_BOOTSTRAP_RETRY_BUDGET_SECS` | 600 | How long an OUTAGE may last before the job gives up. Per unit of work — a successful window resets it — so it does not bound how long the job may take (`config.py:270`). |
| `GRAPHVER_BOOTSTRAP_RETRY_MAX_DELAY_SECS` | 30 | Ceiling on the exponential backoff between retries (`config.py:271`). |
| `GRAPHVER_INGEST_POLL_SECS` | 5 | Worker pickup cadence (`config.py:253`). |
| `GRAPHVER_INGEST_STALE_SECS` | 120 | Heartbeat age after which a `running` job is presumed dead and taken over (`config.py:254`). |
| `GRAPHVER_RESYNC_MAX_ENTITIES` | 250000 | Largest graph a RE-SYNC may attempt. A guard rail over a real limit, not a policy: `sync_ingest` rebuilds the whole graph several times to 3-way merge it — **measured 2.03 GB of RSS to compute 808 changes on a 478k graph**, in one request on the web tier; the 7.7M model would ask for ~30 GB and take the API down. Above the limit it refuses with a `422 graph_too_large_to_sync` quoting the entity count and the estimate. Set `0` to disable if you know the memory is there. Exists to be DELETED — see [docs/versioning/11-resync-at-any-scale.md](https://github.com/rkrumins/dataviz/blob/main/docs/versioning/11-resync-at-any-scale.md) (`config.py:255`). |
| `GRAPHVER_INGEST_HEARTBEAT_SECS` | 30 | How often a running worker says "still alive" — a TIMER, not a per-window commit. Must stay well under the stale window: a scan halving down its ladder, or a validate anti-joining a 10M-row commit, works for minutes without committing anything, and a worker that only beat on commit would be declared dead by a colleague while perfectly healthy (`config.py:262`). |

Operationally: the k8s worker takes these via `envFrom: worker-config` (edit the ConfigMap and
restart the pod — no image rebuild). Note that ConfigMap is shared with the aggregation worker.

### The `versioningEnabled` admin flag

> **Note:** This is the master switch for the whole versioning surface. Turning it off is
> **non-destructive** — reads stay open, existing versioned graphs and blank models remain
> viewable, and background projection keeps running; only *mutating* routes and the Edit
> entry points are gated. Nothing is deleted.

`Admin → Features → Lineage → Version control` (a `feature_flags` boolean, default ON).
When off: every **mutating** versioning route returns 403
`{"type": "feature_disabled", "feature": "versioningEnabled"}` and the UI hides drafts,
reviews, history, blank models and the Edit entry — canvases become view-only. **Reads stay
open** and nothing is deleted: existing versioned graphs and blank models remain viewable,
and background projection keeps running. The frontend reads the flag from the public
`GET /api/v1/features/values` (no auth) at boot.

---

## 4 · Auth, RBAC & tenancy

- **Session**: `POST /api/v1/auth/login` `{email,password}` sets `nx_access`
  (HttpOnly) + `nx_csrf`. Persist cookies; echo `nx_csrf` as the `X-CSRF-Token`
  header on every write (POST). GETs are exempt.
- **Permissions**: reads need `workspace:datasource:read`, writes need
  `workspace:datasource:manage`. Forking + opening a PR need only `read`
  (anyone who can see a graph may propose changes); **merging** a PR into the
  base needs `manage` — the governance gate. Admin's `system:admin` implies all.
- **Tenant isolation**: a graph must belong to `{ws_id}`; cross-tenant access
  returns **404** (existence isn't leaked across workspaces).

---

## 5 · FalkorDB projection (optional)

API reads come from Postgres, so you can ignore this for MVP testing. To populate
the derived FalkorDB read graph:

```python
from backend.app.services.versioning.projection import (
    FalkorProjector, make_falkor_graph_factory,
)
proj = FalkorProjector(make_falkor_graph_factory())     # FALKORDB_HOST / FALKORDB_PORT
await proj.project_pending()        # catches up every graph whose projection lags
```

It's idempotent and crash-safe (the watermark advances only after a batch lands);
run it on a loop or from a publish/merge hook.

---

## 6 · Automated tests

```bash
export MANAGEMENT_DB_URL='postgresql+asyncpg://synodic:synodic@localhost:5432/synodic' GRAPHVER_E2E=1
python -m pytest backend/tests/test_versioning_core.py backend/tests/test_versioning_schema.py \
    backend/tests/integration/test_versioning_*.py -q
```

Covers the pure merge/diff/merkle core, the schema, the write path, fork→PR→merge
(copy-on-write), the API boundary (auth + RBAC + tenant + governance), and the
FalkorDB projection.

---

## 7 · The frontend UI — full authoring, including blank-canvas models

The canvas is a **full versioned editor** (the "read-only visualization" note that
used to live here is long stale). The React frontend drives everything in §3
through `frontend/src/services/versioningApiService.ts`:

- **Edit mode = an open draft** (`ensureDraftOpen`): node/edge creation
  (`UnifiedCreatePanel`, edge connect + ontology-filtered type picker), staged
  changes, one atomic save per batch (`POST /{ws}/graph/changes`), checkpoint,
  Publish / Discard / merge requests — all from `CanvasVersioningBar` and the
  Context View canvas.
- **Blank-canvas models (self-service)**: the New View wizard's **Start from
  blank** path asks for workspace + FalkorDB provider connection + a **published
  ontology**, then calls `POST /{ws}/versioning/blank-graphs`, which provisions a
  manual data source (minted `blank_<ds_id>` graph name, ontology bound) + a
  genesis-only `kind="blank"` versioned graph (strict enforcement) and registers
  it with the aggregation service. The user lands on the Context View with a
  draft auto-opened and a guided empty state; publishes project to FalkorDB and
  `:AGGREGATED` rollups sync automatically (see
  VERSIONING_DRAFTS_LINEAGE_AND_MERGE.md §10).
- **Ontology governance**: the durable write path (stage/commit/publish/merge and
  `/graph/changes`) enforces the assigned ontology's rich rules server-side —
  entity types must be defined, edge source/target types must be compatible,
  containment must satisfy `can_contain`. Violations return
  422 `{"type": "ontology_violation", "violations": [{entity_id, kind, reason,
  rule}]}`; blank graphs fail closed if their ontology can't be resolved.

API-driven testing (smoke script / curl) remains the fastest harness for the
write path itself.

---

## Related

- [Overview & Architecture](/docs/versioning-overview) — mental models, read/write routing, and the headline design decisions.
- [API Reference](/docs/versioning-api-reference) — the full REST contract behind the flows tested here.
- [RBAC](/docs/rbac) — the role taxonomy the `…:read` / `…:manage` gates resolve against.
