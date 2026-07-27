# Changelog

Release history for {brand}. Notable changes, newest first. Dates are release dates.

Sections follow [Keep a Changelog](https://keepachangelog.com): **Added**, **Changed**,
**Deprecated**, **Removed**, **Fixed**, **Security**. Anything that requires action on upgrade
is called out under **Upgrading**, and anything we know is still wrong is under **Known
limitations** — a changelog that only lists good news is not worth reading.

---

## [Unreleased] — View visibility rebuilt

Visibility decided which Views you could *find*. It did not decide who could *read* them, and it
did not carry access to the data they showed. Four reported problems, one root cause.

### Security

- **Private Views were readable by every member of their workspace.** Read access passed if any
  of three independent layers passed, and one of them was "holds `workspace:view:read` in this
  workspace" — checked without reference to the tier. `private` and `workspace` were therefore
  the same tier for anyone inside the workspace. The behaviour was codified as intended in the
  test suite; that test is now inverted.
- **`GET /views/facets` had no authentication at all**, and returned every creator's display name
  and **email address** plus tags spanning private Views — an anonymous directory dump.
- **`GET /views/stats` was an anonymous oracle.** Unrestricted filters plus counts meant
  `?visibility=private&createdBy=<victim>&search=<term>` narrowed to specific private View names,
  descriptions and tags.
- **`/views/popular` returned every workspace-tier View to every caller**, member or not, and the
  endpoint deliberately routed around the access filter.
- **`total`/`hasMore` counted the unfiltered set** while rows were filtered afterwards, so
  `total - len(items)` was an exact count of what a caller was denied.
- **Favouriting had no access check** — an existence oracle for arbitrary View ids, and a way to
  write into an owner's activity timeline and inflate a View's trending rank.
- **`PUT /views/{id}` could set `visibility`** behind the weaker edit gate, bypassing the
  creator-or-workspace-admin rule the dedicated route enforces.

### Added

- **Public tier.** Reaches every signed-in account, workspace access or not. Authenticated-only —
  no anonymous access, no share tokens.
- **Enterprise Views can now actually be opened.** Reading a View carries a delegated, read-only
  grant to the data that View shows, confined to its saved scope. Previously the View opened to
  an empty canvas because every data call behind it 403'd.
- **"Why can I see this?"** Every View reports which rule granted you access, on its badge.
- **"Who will be able to see this?"** Hovering a tier in the share dialog shows who would gain
  access before you apply it.
- **Time-bound shares.** Per-View shares can expire, like workspace access already could.
- **Tier changes are audited** — `rbac.view.visibility_widened` / `_narrowed` reach
  `auth_audit_log`, where the `org_auditor` role looks. Promotion was previously the only
  access-widening mutation with no security trail.
- Confirmation before a bulk change that widens access, with per-View outcomes instead of
  "Some views could not be updated".

### Changed

- Authorization moved from a Python loop at one endpoint into a SQL predicate applied by the
  repository, so counts and pagination describe the authorized population and every future query
  is filtered by default. A contract test fails the build if a View-returning function stops
  requiring a read scope.
- `enterprise` now means "holds a binding in some workspace" rather than "is authenticated" —
  which is what `public` means. There was previously no tier between "this workspace" and
  "everyone".
- "Shared with me" reads actual shares instead of approximating them as a tier filter.
- The tier vocabulary had 5 backend and ~15 frontend definitions, already drifted in wording and
  spelling. Both sides now have one.

### Removed

- `context_models.visibility` — same column and CHECK as Views, no reader or writer anywhere.
- The `isPublic` boolean on the frontend View type. It collapsed the tier on the way in and
  expanded it back on the way out, so opening a Workspace View in the wizard silently promoted
  it to the whole organisation.
- `RBAC_ENFORCE_VIEWS` no longer covers reads. With authorization in the query there is no
  legacy behaviour to fall back to — an unscoped read is a full table dump, not a legacy mode.

### Upgrading

Two migrations: `20260727_1200_view_public_tier` (widens the Views tier CHECK, drops the dead
`context_models.visibility`) and `20260727_1300_grant_expiry`.

**Users will lose access to Views they can see today.** This is the fix, but it is still an
access removal. Run the read-only report first to see who is affected:

```
python -m backend.scripts.report_private_view_exposure
```

- Every `private` View that was de-facto workspace-shared becomes invisible to teammates. Owners
  who intended those to be shared should set them to **Workspace**.
- Accounts with no workspace binding lose `enterprise` Views and keep only `public` ones.

`GET /views/` `total` and `hasMore` change meaning — they become accurate, so paging shifts for
non-admins.

### Known limitations

- Delegated data access covers the canvas render path and read-only context-model templates.
  Node-detail drill-down on the main graph router is not delegable yet, so a non-member opening
  a shared View can paint and expand it but not open every side panel.
- `/views/facets` and `/views/stats` are scoped to the caller but still aggregate globally
  within that scope; they are not additionally narrowed by the caller's other active filters.

---

## [0.2.0] — 2026-07-19 — Versioned Graph: rollback, admin flag, and enable-VC at scale

Version control for a data graph becomes usable on a *real* graph: you can turn it on for a
data source you already have, undo a change you already published, and switch the whole feature
off for a deployment that doesn't want it.

Verified end to end against a live **7.7M-entity** graph (2,083,216 nodes / 5,009,794 edges).

### Added

**Roll back a change you already published.** Two different operations, because they answer two
different questions:

- **Undo this change** — reverses one published revision and *keeps* everything that came after
  it. If later work touched the same items, it can't be undone in isolation; the dialog says so,
  names how many items collide, and offers the way out.
- **Restore the graph to this point** — resets the graph to how it looked at a chosen revision.
  It cannot conflict, by construction, which is exactly why it's the escape hatch when an undo
  can't proceed. Shows the exact impact before you commit to it.

Both add a **new revision**. History is never rewritten, and nothing is destroyed. Available
from the history timeline and from a merged pull request.

**Turn on version control for a data source you already have.** Previously this had to happen
in a single request and was not viable on a large graph. It is now a background job:

- Runs asynchronously — you keep working while it copies.
- **Resumable.** A killed worker picks up exactly where it stopped; it does not start over.
- **Proves itself.** When it finishes you get an integrity report — every item and connection
  counted against the source, every item type and relationship type checked for survival, no
  duplicate identifiers, no dropped connections, and a random sample re-read from the source and
  compared byte-for-byte. On the 7.7M graph: *"scanned 2,083,216 of 2,083,216 items · 5,009,794
  of 5,009,794 connections · 64 of 64 re-checked items match exactly · zero data loss."*
- **Invisible until proven.** Nothing becomes live until the checks pass, so a failed copy leaves
  your data source reading exactly as it did before. There is nothing to undo.
- Live progress with a time-remaining estimate, and — if something goes wrong — a plain-language
  reason plus Resume / Start over / Give up, and a downloadable report.

**An admin switch for the whole feature.** `Admin → Features → Version control`. Turn it off and
the versioning UI disappears and the server refuses versioning writes. Existing versioned graphs
stay **viewable, read-only** — nothing is deleted and nothing is hidden from you permanently.

**Enable-version-control jobs are visible to operators.** `/admin/infrastructure` gains a panel
for copies that are running, stalled, or failed. This matters more than it sounds: a graph being
copied deliberately parks its projection watermark, which made it read as *healthy and in sync*
to every other probe — so a copy that failed days ago, while silently blocking writes to its data
source, showed up as green.

### Changed

**Breaking — API.**

| Endpoint | Before | Now |
|---|---|---|
| `POST /{ws}/graph/bootstrap` | synchronous; returned the result | **`202` + `{jobId, graphId, status}`**; poll `GET /{ws}/graph/bootstrap/status` |
| `POST /{ws}/graph/bootstrap` | no permission check | requires **`workspace:datasource:manage`** |
| `POST /{ws}/graph/resync` | `workspace:datasource:read` | requires **`workspace:datasource:manage`** (see *Security*) |
| canvas write-through | silently enabled version control for you | raises a typed **"enable version control first"** error |

**New endpoints:** `GET /{ws}/graph/bootstrap/status`, `POST /{ws}/graph/bootstrap/retry`,
`POST /{ws}/graph/bootstrap/abandon`, `POST /{ws}/versioning/graphs/{gid}/commits/{cid}/restore`,
`GET  /{ws}/versioning/graphs/{gid}/commits/{cid}/restore-preview`, and the public
`GET /api/v1/features/values` (UI booleans only — no schema, no admin hints, no secrets).

**A data source on a non-FalkorDB provider is now refused up front** with `422
provider_unsupported`, instead of being accepted with a `202` and failing later. The copy is
FalkorDB-shaped end to end; accepting it and failing afterwards left the data source **write-
blocked behind a job that could never succeed**.

**New commit kind `restore` and new job type `bootstrap`** — both require the migrations below.

### Security

**`POST /{ws}/graph/resync` was a write gated on read.** The graph router's blanket dependency is
`workspace:datasource:read`, and that route added nothing on top — so anyone who could merely
*look* at a data source could commit a `sync` to its main branch, overwriting source-authoritative
fields across the whole graph and, with `strategy=external_wins`, deliberately clobbering other
people's edits. It now requires `manage`, like every other write on that router.

Tenant isolation was already sound here (cross-workspace requests already 404'd), so this is a
privilege bug, not a cross-tenant one.

*Also noted, not fixed:* `POST /{ws}/graph/vocab-alignment/confirm` is in the same state — a write
with no permission dependency beyond the router's read.

### Upgrading

**Migrations are mandatory.** Run `alembic upgrade head`. The runtime's `create_all` never ALTERs
an existing table, so an existing database will **not** self-heal:

- `20260713_1200_restore_kind` — allows `commits.kind = 'restore'`.
- `20260713_1400_jobs_bootstrap` — allows `jobs.job_type = 'bootstrap'`. **Widen-only**
  (`required ∪ present`): `graphver.jobs` is a shared, multi-producer table, and a CHECK rebuilt
  from a hard-coded allow-list has wedged Alembic on it before.

**The worker must be running.** Enabling version control is now a job, claimed by the versioning
worker (`python -m backend.app.services.versioning`, or `GRAPHVER_PROJECTION_INPROCESS=1` in dev).
Without it, jobs sit in `pending` forever.

**New tuning knobs** — all optional, all sized for a 10M-entity graph. Full table with defaults and
rationale in [`docs/VERSIONING_E2E.md`](/docs/versioning-e2e#tuning-all-optional-defaults-are-sized-for-a-10m-entity-graph):

`GRAPHVER_BOOTSTRAP_SCAN_WIDTH`, `_SCAN_MIN_WIDTH`, `_EDGE_TARGET`, `_WINDOW`, `_SAMPLE_K`,
`_MERKLE_MAX`, `_RETRY_BUDGET_SECS`, `_RETRY_MAX_DELAY_SECS`, `GRAPHVER_INGEST_POLL_SECS`,
`_STALE_SECS`, `_HEARTBEAT_SECS`, `GRAPHVER_RESYNC_MAX_ENTITIES`.

### Known limitations

**Re-sync holds the whole graph in memory, several times over.** Measured: **2.03 GB of RSS to
compute 808 changes** on a 478,430-entity graph — in one HTTP request, on the web tier. It scales
linearly, so a 7.7M-entity graph would ask for roughly **30 GB** and take the API process down,
along with every request in flight on it.

This is **pre-existing** and untouched by this work. But this release is what makes graphs that
large versionable in the first place, so it now ships behind a guard rather than a crash: re-sync
**refuses** above `GRAPHVER_RESYNC_MAX_ENTITIES` (default 250,000) with `422
graph_too_large_to_sync`, quoting the item count and the memory it would need. Refusing beats an
OOM on every axis — an OOM kills unrelated requests and explains nothing.

The design that removes the guard entirely is written out in
[`docs/versioning/11-resync-at-any-scale.md`](https://github.com/rkrumins/dataviz/blob/main/docs/versioning/11-resync-at-any-scale.md).

**Enabling version control is FalkorDB-only.** Other providers are refused with a clear `422`.

**The integrity fingerprint (Merkle root) is deferred above 1,000,000 entities** rather than built
in memory. The integrity checks still run in full, and the report says when it was deferred.

### Verification

The 7.7M-entity run, end to end:

| | |
|---|---|
| copied | 2,083,216 nodes / 5,009,794 edges — **exact match to source** |
| containment (`HAS`) | 2,083,200 → 2,083,200 |
| lineage (`FLOWS_TO`) | 2,926,594 → 2,926,594 |
| duplicate rows | **0**, across a SIGKILL and three resumes |
| sampled items re-read and hash-compared | 64 / 64 identical |
| peak worker memory | **468 MiB** — sized by the window, not the graph |
| projection | fast-forwarded; the source graph was never dropped or reseeded |
