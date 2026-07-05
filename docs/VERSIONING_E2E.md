# Versioned Graph — End-to-End Testing Guide

> 📚 **Part of the [Versioned Graph documentation suite](versioning/README.md).** This guide is the
> hands-on run/test companion; see the suite for the full architecture, engine, projection, API,
> frontend, and design reference.

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
| Admin login | `admin@synodic.local` / `admin123` |

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
    --email admin@synodic.local --password admin123
```

It logs in, then runs the whole MVP over HTTP and prints a green checklist:

```
create graph → open draft → stage → checkpoint → read state
            → publish to main → history + diff
            → fork (copy-on-write) → diverge → open PR → preview → merge → verify
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
  -d '{"email":"admin@synodic.local","password":"admin123"}' >/dev/null
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

`…` = `workspace:datasource` (a versioned graph is 1:1 with a data source).

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
```
