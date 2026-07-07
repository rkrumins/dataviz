# 06 · API Reference — REST Surface & the Draft-Aware Graph Plane

> **Audience & scope:** integrators and backend/frontend engineers calling the Versioned Graph over
> HTTP. This is the contract; for the run/test harness see [`../VERSIONING_E2E.md`](../VERSIONING_E2E.md),
> for behavior semantics see [03 · Branching, Commits & Merge](03-branching-commits-merge.md).

**TL;DR.** Two workspace-scoped FastAPI routers own everything. The **versioning router**
(`/api/v1/{ws_id}/versioning`) is the *only* path between a client and the `graphver` Postgres store —
it delegates to `GraphVersioningService`. The **graph router** (`/api/v1/{ws_id}/graph`) is the
provider/engine read+write plane, made **draft-aware** by a single `?branchId=` query param. Auth is a
cookie session + CSRF; authorization reuses **data-source permissions** (a graph is 1:1 with a data
source); cross-tenant access returns **404**, never 403.

Router mounts: `api.py:245` (versioning, prefix `/{ws_id}/versioning`) and `api.py:252` (graph, prefix
`/{ws_id}/graph`). Wire shape is camelCase over snake_case Python (`_ApiModel(populate_by_name=True)`,
`versioning.py:439`).

---

## 1. Auth, RBAC & tenancy

### Session & CSRF
`POST /api/v1/auth/login {email,password}` sets `nx_access` (HttpOnly) and `nx_csrf` cookies. Persist
cookies; echo `nx_csrf` as the `X-CSRF-Token` header on **every write** (POST/PATCH/DELETE). GETs are
exempt. The server trusts the authenticated `User` / `PermissionClaims`; the router does not re-derive
identity.

### Permissions (RBAC)
Two permission strings gate the whole surface (`versioning.py:64-65`):

| Constant | Value | Applies to |
|---|---|---|
| `_READ` | `workspace:datasource:read` | all reads; **fork**; **open PR**; PR/commit inspection |
| `_MANAGE` | `workspace:datasource:manage` | all writes; **merge**; projection rebuild; branch admin |

> **Decision — governance by permission asymmetry.** Anyone who can *see* a graph may propose changes:
> **forking** (`POST /graphs/{gid}/forks`) and **opening a PR** (`POST /graphs/{gid}/pulls`) need only
> `_READ`. Landing changes on a shared `main` — **merge / publish** — needs `_MANAGE`. That single
> asymmetry is the review gate; there is no separate ACL system. Admin `system:admin` implies both.

### Tenant isolation → 404, not 403
Every `{graph_id}` route depends on `graph_in_workspace` (`versioning.py:280`), which resolves the
graph and asserts `workspace_id == {ws_id}`, raising **404** on mismatch so existence never leaks across
tenants. `pr_in_workspace` (`versioning.py:293`) additionally gates PR routes on participation
(author / reviewer / manager → else 404). `view_in_workspace` (`versioning.py:314`) resolves a view
from the **management** DB (a separate store from `graphver`).

### Domain → HTTP error map
Service domain exceptions are translated centrally by `_domain_errors()` (`versioning.py:330-349`):

| Exception | HTTP | Body `detail` |
|---|---|---|
| `MergeConflict` | **409** | `{type:"merge_conflict", conflicts:[…]}` |
| `OntologyViolation` | **422** | `{type:"ontology_violation", violations:[{entity_id,kind,reason,rule}]}` |
| `AccessDenied` | **403** | `{type:"access_denied", message}` |
| `ApprovalRequired` | **409** | `{type:"approval_required", pending:[…]}` |
| `NotUpToDate` | **409** | `{type:"not_up_to_date", branchId, behindBy, message}` |
| `ConcurrencyError` | **409** | `{type:"integrity", message}` |
| `ValueError` | **404** | `str(message)` |

> **Invariant.** A conflict or violation is **atomic**: the service raises before any partial write, so
> a 409/422 leaves the branch exactly as it was. Retry after resolving.

### Actor-name resolution
`graphver` stores raw user ids (it is provider- and management-DB-independent). Responses that carry
actor ids (`GraphResponse`, `BranchResponse`, `EntityHistoryResponse`, PR/commit lists) hang a
`userNames: {id → "First Last"}` map, filled by one batched, de-duplicated lookup per request against
the management DB (`_attach_user_names`, `versioning.py:879`).

---

## 2. REST catalog — `/api/v1/{ws_id}/versioning`

All paths below are relative to `/api/v1/{ws_id}/versioning`. "Gate" is the required permission.

### 2.1 Graph lifecycle & resolution
| Method · Path | Gate | Purpose / key fields |
|---|---|---|
| `POST /graphs` (`:902`) | `_MANAGE` | Create a versioned graph. `{dataSourceId, workspaceId, kind, baseOntologyId?, tenantId?, falkorGraphName?, falkorProvider?, ontologySpec?, ontologyEnforcement?}` → `{graphId, mainBranchId, genesisCommitId}` (201). `workspaceId` must equal the path; `falkorProvider` defaults to the DS's provider. |
| `GET /graphs/{gid}` (`:1159`) | `_READ` | Graph metadata (`GraphResponse`: `kind`, `forkParent…`, `mainHeadCommitSeq`, `userNames`). |
| `GET /resolve` (`:1189`) | `_READ` | `?dataSourceId&viewId` → `ResolveResponse{graphId, mainBranchId, mainHeadCommitSeq, myDraft?, kind}`. **Read-only — never opens a draft.** 404 when the DS has no versioned graph. |
| `POST /resolve` (`:1209`) | `_MANAGE` | `{dataSourceId, originatingViewId?}` → same shape, but **opens the caller's draft if absent** (this is the frontend `resolveAndOpenDraft`). |

> **Note.** "Enable version control" (**bootstrap**) and authoritative **resync** are on the *graph*
> router (§4), because they snapshot the live provider into the versioned base and need the
> `ContextEngine`.

### 2.2 Blank models (self-service, ontology-governed)
| Method · Path | Gate | Purpose / key fields |
|---|---|---|
| `GET /blank-graphs/name-check` (`:984`) | `_MANAGE` | `?providerId&graphName` → `{available, normalized, reason?}`. Validates slug `^[a-z0-9][a-z0-9_-]{2,63}$`, rejects reserved prefixes (`gv_/gvt_/blank_/__fork_`, `*_proj`), checks per-provider uniqueness + live `GRAPH.LIST`. |
| `POST /blank-graphs` (`:997`) | `_MANAGE` | `{name, description?, providerId, ontologyId, graphName?}` → `BlankGraphResponse{dataSourceId, graphId, mainBranchId, graphName, label}`. One call provisions a manual data source + a genesis-only **strict** `kind="blank"` graph + aggregation registration. Preflight: provider active/FalkorDB/permitted/**reachable**, ontology **published**, advisory-locked name check; **compensating** data-source delete if graph creation fails (no 2PC). |

### 2.3 Branches & drafts
| Method · Path | Gate | Purpose / key fields |
|---|---|---|
| `GET /graphs/{gid}/branches` (`:1168`) | `_READ` | `?limit&offset&viewId` → `[BranchResponse]`. Graph-wide by default; `viewId` narrows to that view's branches (**branch-per-view**). Viewer-scoped (non-managers see own + shared). |
| `POST /graphs/{gid}/branches` (`:1228`) | `_MANAGE` | `{name?, originatingViewId?, shared?}` → `{branchId}` (201). |
| `GET · POST · DELETE .../branches/{bid}/members[…]` (`:1243/1254/1268`) | `_READ` / `_MANAGE` / `_MANAGE` | Shared-branch collaborators: `{subjectType:"user\|group", subjectId, role:"viewer\|editor\|maintainer"}`. |
| `PATCH /graphs/{gid}/branches/{bid}` (`:1365`) | `_MANAGE` | `{name?, description?, isShared?}` (owner/maintainer); `""` clears. |
| `POST .../branches/{bid}/abandon` (`:1354`) | `_MANAGE` | Discard the draft → `BranchResponse`. |
| `POST .../branches/{bid}/rebase` (`:1380`) | `_MANAGE` | "Pull latest `main` into the draft." `{resolutions?}` → `{clean, conflicts, changes, baseCommitSeq}`; `clean:false` → resolve and resubmit. |

### 2.4 Changes → checkpoint → publish
| Method · Path | Gate | Purpose / key fields |
|---|---|---|
| `POST .../branches/{bid}/changes` (`:1283`) | `_MANAGE` | Bulk-stage edits. `{ops:[{op, entityKind, entityId?, payload?, ref?, changeReason?}]}` → `{assigned:{ref→entityId}, count}`. Resolves live `ontology_rules`. |
| `POST .../branches/{bid}/commit` (`:1301`) | `_MANAGE` | Checkpoint the draft. `{message?, resolutions?}` → `{commitId?, stagedChanges}`. Resolves live containment types + ontology rules. |
| `GET .../branches/{bid}/merge-preview` (`:1320`) | `_READ` | Dry-run publish → `{clean, conflicts, changes}`. |
| `POST .../branches/{bid}/publish` (`:1331`) | `_MANAGE` | Squash-publish draft → `main`. `{message, resolutions?}` → `{commitId}`. Auto-rebases if `main` moved and it's clean. Post-write: invalidate main read-cache, stamp view data-freshness, schedule in-process FalkorDB catch-up. |

### 2.5 Projection, Data health, rebuild & revert
| Method · Path | Gate | Purpose / key fields |
|---|---|---|
| `GET /graphs/{gid}/watermark` (`:1396`) | `_READ` | `WatermarkModel{committed, projected, fresh, status(idle\|projecting\|rebuilding\|evicted), target, lastError?, lastProjectedAt?, progressDone?, progressTotal?}`. Drives the "refreshing…" badge and the Data health tab. |
| `POST /graphs/{gid}/projection/rebuild` (`:1417`) | `_MANAGE` | Full replay Postgres→FalkorDB. **409** if no real target (unpinned/synthetic `gv_<id>`). Idempotent (`{started}` / `{alreadyRunning}`); self-heals a stranded status. |
| `POST /graphs/{gid}/projection/reconcile` (`:1456`) | `_MANAGE` | `{deep?}` → `DriftReportModel`. Request-scoped full scan; concurrent → 409; read-layer failure → 503. |
| `POST /graphs/{gid}/commits/{cid}/revert` (`:1488`) | `_MANAGE` | Apply the inverse of a `main` commit as a new `revert` commit. `{message?}` → `{commitId}`. Conflict-guarded (409 if a later commit touched the same entities). |

See [04 · Projection & Cache](04-projection-and-cache.md) for what these actually do.

### 2.6 State, history & diff
| Method · Path | Gate | Purpose |
|---|---|---|
| `GET .../branches/{bid}/state` (`:1509`) | `_READ` | `?asOfSeq` → `{nodes, edges, watermark}` (materialized, viewer-scoped). |
| `GET .../commits/{cid}/state` (`:1525`) | `_READ` | Time-travel: full state at a commit. |
| `GET .../entities/{eid}/history` (`:1541`) | `_READ` | `EntityHistoryResponse{versions, userNames}` — the per-entity revision timeline. |
| `GET .../branches/{bid}/diff` (`:1603`) | `_READ` | `?fromSeq&toSeq` → `{added, removed, modified}` (id-keyed field diff). |
| `GET .../branches/{bid}/diff-vs-main` (`:1618`) | `_READ` | Whole node/edge payloads with `before/after` — the shape the canvas overlay + Changes panel consume. |
| `GET .../branches/{bid}/diff-vs-main/summary · /children` (`:1633/1652`) | `_READ` | Hierarchical containment-tree diff: `{groups[DiffTreeNode], counts, entityCounts, edgeCounts, impact}` + lazy children by `containerKey`. |
| `GET .../commits/{cid}/diff/summary · /children` (`:1673/1691`) | `_READ` | Same, for a single commit (History drill-down). |

### 2.7 Commit-log & squash drill-down
| Method · Path | Gate | Purpose |
|---|---|---|
| `GET /graphs/{gid}/commits` (`:1556`) | `_READ` | `?branchId&originatingViewId&publishedOnly&limit&offset` → `CommitLogResponse`. `publishedOnly=true` = the view's `main` timeline (squash-publishes + shared genesis/import/revert); else raw draft commits. |
| `GET /graphs/{gid}/commits/{cid}/squashed` (`:1583`) | `_READ` | The raw draft commits folded into a squash — the "merged N commits" drill-down (reads stored `source_commit_ids`). |

### 2.8 Versioned graph read (canvas neighbors)
| Method · Path | Gate | Purpose |
|---|---|---|
| `GET /graphs/{gid}/graph/neighbors` (`:1712`) | `_READ` | `?urn&branchId&asOfSeq&depth&direction&edgeTypes&limit` → `GraphReadResponse{source:"falkordb"\|"postgres", watermark, nodes, edges}`. FalkorDB-first only for `main`@head when the projection is caught up (lease-pinned); **drafts and as-of always read Postgres**. |

### 2.9 Bulk-ingest & authoritative sync
| Method · Path | Gate | Purpose |
|---|---|---|
| `POST /graphs/{gid}/bulk-ingest` (`:1826`) | `_MANAGE` | ndjson body → one `import` commit; invalid lines reported, not fatal; idempotent on `idempotencyKey`. Day-0 / large-delta seeding. |
| `POST /graphs/{gid}/sync` (`:1859`) | `_MANAGE` | ndjson snapshot into `main`, `strategy: merge \| external_wins`, **3-way merge** (untouched drops cascade to containment subtree); idempotent. The authoritative re-sync path (see [10](10-authoritative-sources-datahub-openmetadata.md)). |

### 2.10 Imports & exports
See [08 · Import / Export](08-import-export.md) for the pipeline; the endpoints:

| Method · Path | Gate | Purpose |
|---|---|---|
| `POST /graphs/{gid}/imports` (`:1982`) | `_MANAGE` | `?format&reconcileMode(upsert\|replace)&branchId&viewId&idempotencyKey`, **body = the raw file** → **202** `{jobId, branchId, sourceUri, status:"running"}`. Opens/append a draft, streams to the object store, dispatches `run_import` in the background. |
| `GET /graphs/{gid}/imports` (`:2018`) | `_READ` | Import job history. |
| `GET /graphs/{gid}/imports/template` (`:2030`) | `_READ` | `?format` → a prepopulated starter file. (Declared **before** `/{job_id}` so the literal wins.) |
| `GET /graphs/{gid}/imports/{job_id}` (`:2053`) | `_READ` | Job status (camelCase). |
| `GET /graphs/{gid}/imports/{job_id}/preview` (`:2066`) | `_READ` | `{job, summary, sample, previewDownloadUrl, rejectedDownloadUrl}`. |
| `POST /graphs/{gid}/exports` (`:2087`) | `_READ` | `?format&asOfSeq&viewId&branchId&props&ids&types&idempotencyKey` → **202** `{jobId, resultUri, status}`. |
| `GET /graphs/{gid}/exports · /{job_id}` (`:2121/2131`) | `_READ` | Export job list / status. |
| `GET /graphs/{gid}/exports/{job_id}/download` (`:2144`) | `_READ` | `StreamingResponse`; 409 if not `completed`. |

> **Limitation.** The export **row/type scoping** params (`ids`/`types`) are wired end-to-end on the
> backend (`create_export → create_export_job → ExportWorker`), but the ExportDialog / client service
> send only `format`, `viewId`, `branchId`, and `props` — so row-scoped export is **reachable over
> HTTP but not surfaced in the UI**. Whole-DS, view-scoped, branch-vs-published, and extra-`props`
> columns are exercised everywhere. Details in [08 · Import / Export](08-import-export.md).

### 2.11 Forks
| Method · Path | Gate | Purpose |
|---|---|---|
| `POST /graphs/{gid}/forks` (`:2167`) | **`_READ`** | Copy-on-write fork. `{dataSourceId?}` → `{graphId, mainBranchId, forkBaseCommitSeq}` (201). |

### 2.12 Pull requests (fork → base)
| Method · Path | Gate | Purpose |
|---|---|---|
| `POST /graphs/{gid}/pulls` (`:2181`) | **`_READ`** | Open a fork PR. `{title?, description?, reviewers?}` → `{prId}` (201). |
| `GET /graphs/{gid}/pulls` (`:2199`) | `_READ` | `?limit&offset&viewId` → `[PrResponse]`. |
| `GET /pulls/{pr}` (`:2220`) | `_READ` + `pr_in_workspace` | Single PR (adds `sourceBranchOwner/Name`). |
| `PATCH /pulls/{pr}` (`:2231`) | `_MANAGE` | Edit title/description. |
| `GET /pulls/{pr}/preview · /diff · /diff/summary · /diff/children` (`:2243/2254/2266/2281`) | `_READ` | Merge preview + itemised / hierarchical "Files changed". |
| `POST /pulls/{pr}/approve · /close · /merge` (`:2300/2311/2322`) | `_MANAGE` | merge → `{commitId}` + base cache bump + FalkorDB catch-up. |

### 2.13 Draft merge requests (reviewed publish) & scoped PR lists
| Method · Path | Gate | Purpose |
|---|---|---|
| `POST /graphs/{gid}/branches/{bid}/merge-requests` (`:2343`) | `_MANAGE` | Open a reviewed draft→`main` MR → `{prId}`. |
| `GET /graphs/{gid}/merge-requests` (`:2363`) | `_READ` | Draft MRs + incoming fork PRs. |
| `GET /views/{view_id}/pull-requests` (`:2383`) | `_READ` + `view_in_workspace` | PRs whose source branch is attributed to this view. |
| `GET /views/{view_id}/pull-requests/count` (`:2402`) | `_READ` | `{fromView, onDataSource}` (active only). |
| `GET /data-sources/{ds_id}/pull-requests` (`:2420`) | `_READ` | All PRs on a data source (tenant-checked). |
| `GET /merge-requests/{pr}` (+ `PATCH`, `/preview`, `/diff`, `/diff/summary`, `/diff/children`) (`:2442-2520`) | `_READ` / `_MANAGE` | The **unified** PR read surface (works for both draft MRs and fork PRs — the service dispatches). |
| `POST /merge-requests/{pr}/approve · /close · /merge` (`:2523/2534/2545`) | `_MANAGE` | Merge resolves live containment + ontology rules from the **base** side, then `merge_mr`; base cache bump + view freshness + FalkorDB catch-up. |

---

## 3. Worked flows

### 3.1 Create → draft → change → checkpoint → publish

```bash
BASE=http://localhost:8000 ; WS=ws_demo
post(){ curl -b cookies.txt -s -H "x-csrf-token: $CSRF" -H 'content-type: application/json' -X POST "$@"; }

# 1) create a graph
GID=$(post $BASE/api/v1/$WS/versioning/graphs \
  -d '{"dataSourceId":"ds_demo","workspaceId":"'$WS'"}' | jq -r .graphId)

# 2) open a draft (branch-per-view: pass originatingViewId to attribute it)
BID=$(post $BASE/api/v1/$WS/versioning/graphs/$GID/branches \
  -d '{"name":"My edits","originatingViewId":"view_123"}' | jq -r .branchId)

# 3) stage ops (create returns ref→entityId in `assigned`)
post $BASE/api/v1/$WS/versioning/graphs/$GID/branches/$BID/changes -d '{
  "ops":[{"op":"create","entityKind":"node","ref":"A",
          "payload":{"displayName":"Alpha","entityType":"Table","urn":"urn:demo:alpha"}}]}'
# → {"assigned":{"A":"ent_01J…"},"count":1}

# 4) checkpoint, then squash-publish to main
post $BASE/api/v1/$WS/versioning/graphs/$GID/branches/$BID/commit  -d '{"message":"seed"}'
post $BASE/api/v1/$WS/versioning/graphs/$GID/branches/$BID/publish -d '{"message":"v1"}'
# → {"commitId":"cmt_01J…"}
```

The publish response's `commitId` is the new `main` head. A subsequent `GET .../watermark` shows
`committed` advance and `fresh` flip to `true` once the projector catches up.

### 3.2 The full HTTP lifecycle

```mermaid
sequenceDiagram
    participant C as Client
    participant V as /versioning router
    participant S as GraphVersioningService
    participant PG as Postgres (graphver)
    participant W as Projection worker
    participant F as FalkorDB

    C->>V: POST /graphs {dataSourceId}
    V->>S: create_graph()
    S->>PG: genesis commit + main branch + projection_state
    V-->>C: 201 {graphId, mainBranchId}

    C->>V: POST /branches {originatingViewId}
    V->>S: open_draft()
    S->>PG: draft branch @ base_commit_seq
    V-->>C: 201 {branchId}

    C->>V: POST /branches/{bid}/changes {ops}
    V->>S: stage_changes() (+ontology gate)
    S->>PG: working_changes rows
    C->>V: POST /branches/{bid}/commit
    V->>S: checkpoint()
    S->>PG: fold → version rows + commit
    C->>V: POST /branches/{bid}/publish
    V->>S: publish() → _apply_draft_squash()
    S->>PG: squash_publish commit; target_commit_seq++
    V-->>C: 200 {commitId}
    Note over V,W: publish schedules an in-process project_now
    W->>PG: read (projected, target]
    W->>F: MERGE nodes/edges; advance watermark
    C->>V: GET /watermark → {fresh:true}
```

---

## 4. The draft-aware graph plane — `/api/v1/{ws_id}/graph`

The versioning router owns the store; the **graph router** owns provider-backed reads and the unified
canvas save. Both become draft-aware through **one dependency**.

### `get_context_engine` — the `?branchId` seam (`graph.py:66`)
A `branchId` query param (`graph.py:70`) is threaded into
`ContextEngine.for_workspace(..., branch_id=branchId)` (`graph.py:92`). Every `/graph` read/write built
on this dependency automatically targets a **draft overlay** when `?branchId=br_…` is present, and
`main` otherwise. Omit it → main; pass `"main"` → explicit main. See
[04 · read providers](04-projection-and-cache.md).

### Per-branch cache scoping (`graph.py:155-205`)
`_cache_scope` includes `branch_id` → `CacheScope(ws, ds, branch)` (`graph.py:167`), so draft reads
(`/nodes/query`, children-with-edges, `trace/v2`, edges) cache per-branch and never collide with main.
`_invalidate_cache` bumps the generation and — **only for main writes** (`if not scope.branch_id`,
`graph.py:204`) — nudges the stats counts; drafts don't touch main stats until publish.

### `apply_graph_changes` — the unified draft save (`graph.py:1711`)
`POST /api/v1/{ws_id}/graph/changes?dataSourceId=…&branchId=…` (`branchId` **required**, `graph.py:1715`)
is the one atomic, server-merged commit the canvas uses. It:

1. Resolves the graph via the service, asserts `workspace_id == ws_id` (else 404).
2. Translates each `GraphChangeOp` to a service op: `create` mints/echoes `ref→entityId`; `delete`
   passes the id; **`update` forwards the RAW partial patch + `base_version`** — the endpoint no longer
   pre-merges; the service does the authoritative field-level merge (`graph.py:1751-1757`).
3. Calls `svc.apply_ops(graph_id, branch_id, ops, actor, message, containment_edge_types=…,
   ontology_rules=…)` (`graph.py:1764`).
4. Maps `OntologyViolation`→422, `MergeConflict`/`ConcurrencyError`→409.
5. Invalidates the draft branch's read cache (`graph.py:1785`) so the next read reflects the commit.
   Returns `{commitId, assigned}`.

> **Decision — patch semantics live in the service, not the client.** `update` ops carry only the
> changed fields plus a `base_version` OCC token; the service PATCHes onto current state (or raises a
> 409 on a same-field clash). This removed a whole class of silent field-loss on merge — see
> [03 · update = PATCH](03-branching-commits-merge.md).

### Ontology pushdown
`_resolve_containment_types` (`graph.py:1629`) supplies live containment types for the delete cascade;
`_resolve_ontology_rules` (`graph.py:1641`) supplies the rich `OntologyRules`, **`fail_closed`** for
blank models (422 `ontology_required` / 503 `ontology_unavailable`). See
[05 · Ontology Governance](05-ontology-governance.md).

### Cascade preview & bootstrap/resync
- `GET /nodes/{urn}/delete-impact?branchId=…` (`graph.py:1804`) previews the containment subtree + all
  incident edges a delete would remove, via the **same** helper the commit uses, so preview matches
  result.
- `POST /bootstrap` (`graph.py:105`) — "Enable version control": idempotent create-or-seed of the
  versioned base from the live provider, in one transaction.
- `POST /resync` (`graph.py:128`) — authoritative re-sync (`strategy: merge | external_wins`) via the
  service's 3-way merge. See [10](10-authoritative-sources-datahub-openmetadata.md).

> **Limitation — v1 trace is gone.** `POST /api/v1/{ws}/graph/trace` returns **410** with an RFC 8594
> `Sunset` header (`graph.py:288-301`); use `POST /api/v2/{ws}/graph/trace`.

---

## Related chapters

- **Behavior of every write** → [03 · Branching, Commits & Merge](03-branching-commits-merge.md)
- **What the projection/watermark/rebuild routes do** → [04 · Projection & Cache](04-projection-and-cache.md)
- **The 422 ontology contract** → [05 · Ontology Governance](05-ontology-governance.md)
- **How the frontend calls all of this** → [07 · Frontend Integration](07-frontend-integration.md)
- **Import/export endpoints in depth** → [08 · Import / Export](08-import-export.md)
- **Run/test harness & smoke script** → [`../VERSIONING_E2E.md`](../VERSIONING_E2E.md)
- **Glossary & suite index** → [README](README.md)
