# Local integration testing — the draft/branch graph journey

*For backend engineers working on versioned graphs and drafts.*

This guide is the focused, **backend-only** path to stand the graph service up locally and exercise the
draft journey end to end: **create a graph → import an existing one → edit on a draft → publish**. It
builds on [Developer Setup](/docs/setup), which covers the full stack; this page only covers what's
specific to the versioned-graph / draft path and how to test it.

The headline: the draft journey is the **normal `/graph` API plus a `?branchId=` query param** — there is
no separate "draft editing" API. Omit `branchId` (or pass `main`) and you read/write the live trunk; pass a
`br_…` draft id and the same endpoints read and write that draft (served from Postgres). Branch *lifecycle*
(open draft, publish) lives in the `/versioning` router.

**This guide covers:**

- The **two tiers** — Postgres-only automated tests vs the full-stack manual journey
- **Tier 0** — running the pytest draft-journey suite against Postgres only
- **Tier 1** — the smoke script and the by-hand `curl` walkthrough
- A **status & coverage** matrix and the **known gaps**

> **Important:** The `?branchId=` param is the whole seam. No `branchId` (or `main`) reads/writes the live trunk through the provider; a `br_…` id reads/writes that draft's overlay from Postgres. Get this wrong in a test and you'll assert against the wrong store.

### The draft journey

```mermaid
flowchart LR
    Create["Create versioned graph<br/>POST /versioning/graphs"]
    Import["Import existing<br/>bulk-ingest / bootstrap"]
    Draft["Open draft<br/>POST …/branches → br_…"]
    Edit["Edit on draft<br/>/graph/nodes/create?branchId="]
    Read["Read-your-writes<br/>/graph/nodes/query?branchId="]
    Publish["Publish<br/>…/branches/br_…/publish"]
    Main["Verify on main<br/>/graph/nodes/query (no branchId)"]

    Create --> Import --> Draft --> Edit --> Read --> Publish --> Main
```

---

## Two tiers

| | Tier 0 — Postgres only | Tier 1 — full stack |
|---|---|---|
| Infra | Postgres | Postgres + FalkorDB + Redis + viz-service (+ projection worker) |
| Covers | the whole **draft** loop (create, import, edit, read-your-writes, publish) | also **main-path** reads through `/graph` and bootstrap-from-a-live-provider import |
| How | `pytest` (automated) | `./dev.sh up` + the smoke script / curl (manual) |
| Speed | seconds, no containers besides PG | full compose stack |

Why the split: a **draft** is composed in Postgres (shared `main` base + the draft's overlay), so editing
and reading a draft never needs FalkorDB. **main** reads go through the live provider (FalkorDB), and a
publish only becomes visible through `/graph` once the projection worker catches up — so Tier 0 verifies a
publish via the versioning `/state` endpoint (Postgres, immediate), and Tier 1 verifies it through `/graph`.

---

## Tier 0 — Postgres-only automated tests (fastest signal)

Bring up just Postgres (the repo ships a test compose file):

```bash
docker compose -f docker-compose.test.yml up -d postgres
export GRAPHVER_E2E=1
export GRAPHVER_DB_URL=postgresql+asyncpg://synodic:synodic@localhost:5432/synodic   # = MANAGEMENT_DB_URL default
```

> **Tip:** If your development stack is already running, skip the container: its Postgres has the same address and credentials, and the suite is built to share it — `backend/tests/integration/conftest.py` cleans up the test graphs it pins.

Run the **HTTP draft-journey** test (drives the real `/graph` + `/versioning` routers in-process over ASGI;
no FalkorDB/Redis — the live provider and read cache are stubbed) plus the draft service/provider/engine suite:

```bash
cd backend
python -m pytest tests/integration/test_api_graph_draft_journey.py \
       tests/integration/test_versioning_draft_*.py -v
# or the whole versioned-graph suite (FalkorDB-gated *_falkor_live* / *_evict* will skip without FalkorDB):
python -m pytest tests/integration/ -v
```

Without `GRAPHVER_E2E=1` these tests skip rather than fail, so a green run with everything skipped means the variable didn't reach pytest.

What these cover:
- `test_api_graph_draft_journey.py` — **the end-to-end HTTP journey**: create graph → bulk-ingest import →
  open draft → `POST /graph/nodes/create?branchId=` / `/edges` → `POST /graph/nodes/query?branchId=`
  read-your-writes → isolation (no `branchId` hits the live provider) → unknown branch ⇒ 404 → publish →
  main reflects it. This is the frontend-facing seam.
- `test_versioning_draft_writes.py` / `test_versioning_draft_reader_engine.py` /
  `test_versioning_draft_read_routing.py` — the same behavior at the provider/engine layer (writes→`apply_ops`,
  reads compose base+overlay, branch selection rule).
- `test_versioning_api.py`, `test_versioning_e2e.py`, `test_versioning_bulk_ingest.py` — the versioning router +
  service journey (stage/checkpoint/publish/fork/PR, import).

> **Tip:** If you don't have a local Postgres, you can run an ephemeral cluster with `initdb`/`pg_ctl` and point `GRAPHVER_DB_URL` at it — the tests call `create_schema_and_partitions()` themselves (no Alembic needed).

---

## Tier 1 — full stack, manual journey

### 1. Bring the stack up

```bash
./dev.sh up      # postgres :5432, redis :6380, falkordb :6379, API :8000, frontend :5173
```

On the first run `./dev.sh` creates `.env.dev` from `.env.example`, and before the API starts, the one-shot
`upgrade` service brings the database schema up to date, including the `graphver` schema. `./dev.sh logs upgrade`
shows what it ran. (`upgrade heads` only lists the head revisions; it changes nothing.) If you run the API on
your machine instead of in Docker, apply the migrations yourself with `python -m backend.scripts.upgrade upgrade`
— [Developer Setup](/docs/setup#run-the-apps-on-your-machine-instead) has the full sequence.

Key env (all defaulted in `.env.example`): `MANAGEMENT_DB_URL` (+ optional decoupled `GRAPHVER_DB_URL`),
`FALKORDB_HOST`/`FALKORDB_PORT`, `REDIS_URL`/`CACHE_REDIS_URL`, `JWT_SECRET_KEY` (generated by `./dev.sh`), and
`LOCAL_DEV_FALKORDB_OVERRIDE=true` when you run the backend on the host against a containerized FalkorDB.

Sign in once at `http://localhost:5173` as `admin@nexuslineage.local` and choose a new password: the published
default `admin123` must be changed before the API answers anything else
([Developer Setup](/docs/setup#sign-in-for-the-first-time)). Use your new password in the commands below.

### 2. Run the journey in one command

```bash
pip install httpx
python scripts/draft_journey_smoke.py --base http://localhost:8000 \
    --email admin@nexuslineage.local --password '<your-password>'
```

This drives the **cohesive** path: provider + ontology + workspace + data source → versioned graph → ndjson
import → open draft → edit via `/graph/nodes/create?branchId=` + `/graph/edges` → read-your-writes via
`/graph/nodes/query?branchId=` → isolation check → publish → verify on main. It prints a `✓` line per step
and ends with `PASS`. (Its sibling, `scripts/versioning_smoke.py`, drives the older stage/checkpoint editing
path for comparison.)

### 3. …or by hand with `curl`

Auth is a cookie session with a CSRF token; capture the cookie jar on login and echo the CSRF cookie on
every write.

```bash
B=http://localhost:8000
# login → cookie jar (sets nx_access + nx_csrf)
curl -sc /tmp/cj.txt -X POST $B/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@nexuslineage.local","password":"<your-password>"}' >/dev/null
CSRF=$(awk '/nx_csrf/{print $7}' /tmp/cj.txt)
auth=(-b /tmp/cj.txt -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json')

# provider + ontology + workspace + data source  (capture ids from the JSON responses)
curl -s "${auth[@]}" -X POST $B/api/v1/admin/providers \
  -d '{"name":"local-falkor","providerType":"falkordb","host":"localhost","port":6379}'
# the main-path /graph read refuses a data source that has no ontology
curl -s "${auth[@]}" -X POST $B/api/v1/admin/ontologies -d '{
  "name":"demo-ontology","scope":"workspace",
  "entityTypeDefinitions":{
    "Domain":{"name":"Domain","hierarchy":{"level":0,"canContain":["Table"]}},
    "Table":{"name":"Table","hierarchy":{"level":1,"canBeContainedBy":["Domain"]}}},
  "relationshipTypeDefinitions":{
    "CONTAINS":{"name":"Contains","isContainment":true,"isLineage":false,"sourceTypes":["Domain"],"targetTypes":["Table"]},
    "LINEAGE":{"name":"Lineage","isContainment":false,"isLineage":true}}}'
curl -s "${auth[@]}" -X POST $B/api/v1/admin/workspaces \
  -d '{"name":"demo","dataSources":[{"providerId":"<PROVIDER_ID>","graphName":"demo","ontologyId":"<ONTOLOGY_ID>"}]}'
WS=<workspaceId>;  DS=<dataSourceId>

# versioned graph + import an existing one (ndjson)
curl -s "${auth[@]}" -X POST $B/api/v1/$WS/versioning/graphs \
  -d "{\"dataSourceId\":\"$DS\",\"workspaceId\":\"$WS\"}"     # → graphId, mainBranchId
printf '%s\n' \
  '{"kind":"node","id":"urn:t:root","urn":"urn:t:root","entityType":"Domain","displayName":"Root"}' \
  '{"kind":"node","id":"urn:t:child","urn":"urn:t:child","entityType":"Table","displayName":"Child"}' \
  '{"kind":"edge","id":"e_rc","edgeType":"CONTAINS","source":"urn:t:root","target":"urn:t:child"}' \
  | curl -s "${auth[@]}" -H 'content-type: application/x-ndjson' \
      -X POST "$B/api/v1/$WS/versioning/graphs/<GID>/bulk-ingest" --data-binary @-

# open a draft → branchId
curl -s "${auth[@]}" -X POST $B/api/v1/$WS/versioning/graphs/<GID>/branches -d '{}'

# EDIT on the draft via the normal graph endpoints
curl -s "${auth[@]}" -X POST "$B/api/v1/$WS/graph/nodes/create?dataSourceId=$DS&branchId=<BR>" \
  -d '{"entityType":"Table","displayName":"Draft Node","parentUrn":"urn:t:root"}'
# read it back on the draft
curl -s "${auth[@]}" -X POST "$B/api/v1/$WS/graph/nodes/query?dataSourceId=$DS&branchId=<BR>" \
  -d '{"query":{}}'
# the same read WITHOUT branchId returns main (no draft edit)

# publish → main, then verify on /graph (no branchId; reflects once projection catches up)
curl -s "${auth[@]}" -X POST $B/api/v1/$WS/versioning/graphs/<GID>/branches/<BR>/publish -d '{"message":"publish"}'
curl -s "${auth[@]}" -X POST "$B/api/v1/$WS/graph/nodes/query?dataSourceId=$DS" -d '{"query":{}}'
```

**Importing a *real* existing graph:** point the data source's provider at an existing FalkorDB/Neo4j graph and
call `POST /api/v1/$WS/graph/bootstrap?dataSourceId=$DS` (empty body) instead of `bulk-ingest` — it snapshots the
provider's current state into one `import` commit (idempotent). Use `bulk-ingest`/`sync` for file/ndjson loads.

---

## Status & coverage

| Layer | Covered by | Infra |
|---|---|---|
| HTTP `/graph?branchId=` (read **and** write) — the new seam | `test_api_graph_draft_journey.py` | Postgres |
| Provider writes on a draft (`apply_ops`) | `test_versioning_draft_writes.py` | Postgres |
| Engine reads on a draft / branch selection | `test_versioning_draft_reader_engine.py`, `test_versioning_draft_read_routing.py` | Postgres |
| Versioning router + service (stage/checkpoint/publish/fork/PR, import) | `test_versioning_api.py`, `test_versioning_e2e.py`, `test_versioning_bulk_ingest.py` | Postgres |
| Main-path reads via FalkorDB, projection, eviction | `test_versioning_falkor_live.py`, `*_evict*` | Postgres + FalkorDB |

### Known gaps / follow-ons
- **Permissions in the journey test.** The HTTP journey runs as one administrator. Draft reads and writes go
  through the same `/graph` routes and permission gates as any other request; those gates are covered in the
  unit suite (`backend/tests/test_data_plane_capability.py`). Add permission-varied cases to the journey test
  when you change how drafts are authorised.
- **Publish→FalkorDB projection visibility** is asynchronous; Tier 1 `/graph` main reads may briefly lag a
  publish (watch the `watermark` in `/versioning/.../state`). Tier 0 sidesteps this by asserting via `/state`.
- **Cached draft reads** (`/graph/.../children-with-edges`, `/trace/v2`, `/trace/expand`, `/nodes/top-level`)
  aren't in the automated HTTP test because they hit the Redis cache; test them with a real Redis (Tier 1), or
  use `fakeredis` (already a test dependency) in the harness.

> **Warning:** A publish becomes visible through `/graph` main reads only once the projection worker catches up (Tier 1) — those reads can briefly lag a publish. Assert immediate publish results via the versioning `/state` endpoint (Postgres) instead, as Tier 0 does.

---

## Where to next

- [Developer Setup](/docs/setup) — the full local stack this guide builds on.
- [Testing & CI](/docs/testing-and-ci) — which of these suites CI runs, and the unit suites around them.
- [Backend guide](/docs/backend) — the `/graph` and versioning routers, and the enable-VC bootstrap job.
- [Platform Services overview](/docs/services-overview) — the versioning projection worker's process role.
