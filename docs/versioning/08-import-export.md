# 08 — Import / Export

> **Audience & scope.** Engineers building or operating bulk data flows into and out of a versioned
> graph, and architects assessing how bulk CRUD stays safe at scale. Covers the import/export
> vertical end to end: the draft-based thesis, the parse→resolve→apply pipeline, identity &
> idempotency, reconcile modes, the tabular column model, format adapters, view-scoped export, the
> object store, and the honest limits. See [`README.md`](README.md) for the glossary and
> [03 — Branching, Commits & Merge](03-branching-commits-merge.md) for the draft/`apply_ops`
> primitives this builds on.

**TL;DR.** Bulk import/export is deliberately **not** a separate write path — it is *the manual
draft flow at scale*. Every import opens (or appends to) the user's working **draft** branch; a
worker parses the file, resolves each row against the draft's composed state, and applies the
changes via the same `apply_ops` the canvas uses. The result is **reviewed and published through the
normal draft diff/PR workflow** — the import/export service never writes `main` itself. Export is
symmetric: it materializes a branch's state to a downloadable, re-importable artifact (a backup),
lossless enough that an unchanged round-trip resolves to **zero changes**.

---

## 1. The thesis: bulk = the manual flow at scale

The design goal was that loading 50,000 rows should be **governed exactly like editing one node**:
isolated on a draft, validated against the ontology, previewed, reviewed, and published — never a
privileged side-door that mutates the shared graph directly.

> **Decision.** An import **opens/append s a draft and applies rows via `apply_ops(branch_id=draft)`**,
> then hands off to the existing review/publish/PR flow. `ImportExportService` *never writes `main`*
> (`import_export/service.py:6-7`; `import_worker.py:1-14`). Consequences: repeated imports **stack on
> one draft** like successive manual edits; a bad import is discarded by abandoning the draft; every
> imported change shows up in the same Changes panel and diff as hand edits; and the import worker
> reuses the engine's ontology gate, edge integrity, cascade-delete, and 3-way merge for free.

The vertical is **independent of the aggregation/ingestion worker** — it copies that stateless
worker *pattern* (a `graphver.jobs` row with traceability metadata, resumable phases) but imports
none of it and drives the versioning service instead (`import_worker.py:1-6`).

```mermaid
graph LR
    subgraph Client
      F["File (csv/tsv/ndjson/json/xlsx)"]
    end
    subgraph Import["Import (async job on a DRAFT)"]
      EP["POST /imports<br/>(file = raw body,<br/>opts = query params)"]
      OS[("Object store<br/>ws/ds/graph/job/source.ext")]
      P["parse → normalize<br/>→ import_rows (cursor)"]
      R["resolve_rows<br/>match + field-diff + ontology gate"]
      A["apply_ops(branch=draft)<br/>in IMPORT_COMMIT_WINDOW windows"]
    end
    subgraph Review["Existing draft workflow"]
      D["draft-vs-main diff<br/>+ Changes panel"]
      PUB["Publish / MR / PR"]
    end

    F --> EP --> OS --> P --> R --> A --> D --> PUB

```

> **Invariant.** Imported changes are **committed on the draft, not staged** — the worker calls
> `apply_ops`, which writes version rows and a commit. So the review handoff is the **Changes**
> (committed diff) surface, not the unsaved staged-changes panel. See
> [07 — Frontend Integration](07-frontend-integration.md).

---

## 2. Job model & dispatch

A job is a row in `graphver.jobs` (`job_type ∈ ingest | export`) carrying full traceability —
workspace, data source, provider, graph, the draft `branch_id`, `reconcile_mode`, `import_format`,
`scope_view_id`, `field_scope` (export options / import field allow-list), `source_uri`/`result_uri`
artifact keys, `as_of_seq`, and a `summary` JSON tally (see the `JobORM` definition in
[02 — Data Model](02-data-model.md)). Staging rows live in the plain (non-partitioned) `import_rows`
table, keyed by `job_id` + `row_index`.

**Create.** `ImportExportService.create_import_job` (`service.py:61-106`) opens a fresh `"Import"`
draft via `open_draft` when no `branch_id` is supplied, or **stacks onto an existing draft** when one
is (`service.py:86-88`). It inserts the `JobORM` row and mints a self-describing `source_uri`
(`{ws}/{ds}/{graph}/{job}/source.<fmt>`) for the caller to stream the upload into
(`service.py:102-105`).

**Dispatch.** The endpoint streams the uploaded file into the object store, then schedules the
worker via FastAPI `BackgroundTasks` (`versioning.py:2012-2013`). `run_import_safe` / `_run_safe`
(`service.py:108-122`) wrap the run so any exception marks the job `failed` with an
`error_message` — the failure is durable on the job row.

> **Limitation — in-process dispatch.** v1 runs imports/exports on **FastAPI `BackgroundTasks`**
> inside the web process, not a real async dispatcher (`service.py:9-11`). Two consequences to know:
> a `uvicorn --reload` (or any process restart) **mid-import kills the job** — it never reaches
> `completed` and its `summary` stays null; and a very large import competes with request handling.
> A Redis/Postgres dispatcher (mirroring the aggregation worker) slots in behind the same
> `run_import_safe` call without touching the pipeline. Tracked in
> [09 — Scale, Limits & Roadmap](09-scale-limits-and-roadmap.md).

The service is wired as a singleton (`get_import_export_service`, `versioning.py:1964-1972`) with two
injected resolvers so the worker stays decoupled from the management DB: a **scope resolver**
(view-scope for scoped export/replace) and an **ontology resolver** (live valid types for the
per-row gate).

---

## 3. The import pipeline (parse → resolve → apply)

`ImportWorker.run` (`import_worker.py:100-116`) executes three phases, all parameters read from the
`JobORM` row.

### 3a. Parse

`_parse` (`import_worker.py:151-169`) streams `source_uri` from the object store through the format
adapter's `parse`, calls `normalize(raw, kind)` per record, and bulk-inserts `ImportRowORM` rows in
2,000-row flushes (`_PARSE_BATCH`) — **the whole file is never buffered** (except the buffered
formats; see §5). Records whose `kind` is neither `node` nor `edge` are skipped, never fatal
(`import_worker.py:159-160`).

Before parsing a non-xlsx file, `_reject_binary` (`import_worker.py:136-149`) sniffs the first chunk
for a ZIP (`PK\x03\x04`) or OLE (`\xd0\xcf\x11\xe0`) magic and fails fast with a friendly *"this is
an Excel workbook — Save As CSV"* message — a very common mistake that would otherwise parse into
garbage rows. xlsx is exempt (it *is* a PK zip and its adapter reads it natively).

### 3b. Resolve

`_resolve_and_build` (`import_worker.py:175-206`) loads the staged rows, fetches the draft's
composed state as **match indexes** via `entity_indexes(graph, branch)`, and calls `resolve_rows`
(`resolve.py:125-228`) — a **pure, deterministic** function (the id minter is injected) that returns
`(ops, resolutions)`.

Two passes, so an edge can reference a node created earlier in the same file
(`resolve.py:1-9, 149-150`):

- **Nodes** match an existing entity by **`entity_id` → `urn` → `qualifiedName`** (`_match_node`,
  `resolve.py:231-239`); no match ⇒ mint a new `entity_id` and register it in the local indexes for
  later edges (`resolve.py:180-188`).
- **Edges** resolve each endpoint through those node indexes
  (`entity_id` → `qualifiedName` → `urn`, `_resolve_endpoint`, `resolve.py:242-252`) and key on the
  `(source_eid, target_eid, edge_type)` triple — the same keying `sync_ingest` uses
  (`resolve.py:205`).

> **Invariant — partial acceptance.** An unresolvable or ontology-invalid row is **quarantined**
> (`resolved_op = "invalid"` + a human reason), never aborting the batch (`resolve.py:14, 154-164`).
> The tally lands on `job.summary` and the reasons on the `import_rows` row.

### 3c. Apply

Accepted ops are applied to the draft in `IMPORT_COMMIT_WINDOW`-sized windows (default 50,000) via
`apply_ops(graph_id, ops=window, actor, branch_id=draft, message="import")`
(`import_worker.py:198-200`). Each window is one commit on the draft — so a huge import becomes a
sequence of ordinary checkpoints, and the engine's referential-integrity, edge-integrity,
cascade-delete, and ontology gates all apply. The resolutions are persisted back onto `import_rows`
(`_persist_resolutions`, `import_worker.py:208-217`), and `job.summary` tallies
`{new, updated, unchanged, deleted, invalid}`.

---

## 4. Identity & idempotency (a round-trip is a no-op)

The single most important correctness property: **re-importing an unchanged export changes nothing.**
Two mechanisms deliver it.

- **Stable identity, not fragile keys.** Matching prefers the stable `entity_id`, then the mutable
  `urn`, then `qualifiedName` — `qualifiedName` is a *field*, not an identity, so a rename doesn't
  fork the entity. (Glossary: `entity_id` in [`README.md`](README.md).)
- **Type-tolerant, field-level diff.** `_changed_fields` / `_changed_props` (`resolve.py:41-84`)
  compare each provided field against the current stored value with `_scalar_eq`
  (`resolve.py:31-38`), which treats `5 == "5"` and `True == "True"` — essential because CSV
  stringifies everything. `tags` compare as an unordered set. If nothing genuinely changed, the row
  resolves to **`unchanged`** and emits **no op**; an update carries **only the changed fields** (a
  PATCH), never a full-payload replace.

> **Decision — sparse edits scale.** Because matching is by identity and updates are field-level
> patches, a minimal file changes only the rows and columns it contains: absent columns leave fields
> untouched, absent rows leave entities untouched. You can update one property on 1 of 10,000
> entities by importing a one-row, one-column file — this is what makes "edit in Excel, re-import"
> viable at scale.

---

## 5. The tabular column model (each property is its own column)

Import/export uses **one shared flat schema across every format** (`rowmodel.py:1-19`):

| Group | Columns |
|-------|---------|
| **Locked identity** | `entity_id`, `urn`, `baseVersion` (= content hash / OCC token) — greyed/locked, do not edit |
| **Node core** | `entityType`, `displayName`, `qualifiedName`, `description`, `sourceSystem`, `layerAssignment`, `tags` |
| **Edge core** | `edgeType`, `sourceQualifiedName`, `targetQualifiedName`, `source_entity_id`, `target_entity_id`, `confidence` |
| **Properties** | one dynamic **`prop.<name>`** column per property + a `properties_json` **overflow** column |
| **Op** | `_op` — blank/`upsert` (default) or `delete` |

> **Decision — properties are tabular, not a JSON blob.** Every property is its **own `prop.<name>`
> column** (`column_order`, `export_worker.py:51-80`) — like a spreadsheet — so 10–50 properties are
> 10–50 editable columns, not one bulky JSON cell. `properties_json` is demoted to a pure overflow
> column, emitted only for genuinely nested/complex values (`rowmodel.py:121-129`). Export columns
> are the **union** of properties entities actually have **plus** any the ontology defines for the
> present types (`schema_props`) **plus** any the user asked to add — so a defined-but-empty property
> is still a fillable column.

**`normalize`** (`rowmodel.py:83-118`) turns a flat record into a normalized row: **empty cells are
dropped** (a blank means "leave unchanged" — PATCH semantics, `rowmodel.py:90-107`); `tags`/
`confidence` are coerced; and an **unexpected `_op` value** is flagged `invalid` with a
column-shift hint rather than silently swallowed as an upsert (`rowmodel.py:89-98`) — the fix for
the classic "a property value slid into the `_op` slot and my edit vanished" bug.

**Deleting a property** is explicit (an empty cell never deletes). A `\N` / `\NULL` token in a
`prop.<name>` cell, or a `null` in `properties_json`, becomes the **`PROP_DELETE` sentinel**
(`"__nx_prop_delete__"`, `rowmodel.py:60-80`) which flows through the update patch to
`service._patch_payload`, removing the key. The sentinel uses a plain ASCII marker (not a NUL byte,
which Postgres JSONB rejects) and is stripped from `create` payloads, where it is meaningless
(`resolve.py:55-65`).

---

## 6. Reconcile modes: upsert vs replace

| Mode | Absent-entity behavior | Default? |
|------|------------------------|----------|
| **`upsert`** | Never deletes on absence — only creates/updates the rows in the file. | Yes (safe) |
| **`replace`** | The file is the **authoritative snapshot for its scope**: every existing in-scope entity that no file row matched is **deleted**. | Opt-in |

Replace deletes are computed by `_append_replace_deletes` (`import_worker.py:70-90`): `universe −
matched` → `delete` ops (edges first, then nodes; `apply_ops` cascades containment/incident edges).
Derived deletes aren't file rows, so they're counted separately into `summary["deleted"]`.

> **Invariant — scoped replace can't nuke the data source.** For a **view-scoped** replace,
> `_view_scope_eids` (`import_worker.py:41-67`) restricts the deletable universe to the view's own
> entities — the same rule as export scope: each assigned URN plus its containment descendants (when
> the assignment inherits children), edges in-scope only when both endpoints are. `None` scope ⇒
> whole graph. Because the review dialog always passes the active `viewId`, a replace from a view is
> view-scoped by default. Whole-DS replace is still available and is guarded by a prominent
> "N entities will be deleted" callout before publish.

Replace is always **reviewed on the draft before publish** — the delete-on-absence set is visible in
the diff, so a mistaken scope is caught before it touches `main`.

---

## 7. Format adapters

A `FormatAdapter` (`formats.py:21-28`) converts one file format ↔ raw column-dict records; the
pipeline, staging, reconcile, and diff never change when a format is added. The registry
(`formats.py:152-158`, resolved by `get_adapter`, `:161-166` — unknown format ⇒ `ValueError` ⇒ HTTP
422) ships five:

| Format | Adapter | Streaming? | Notes |
|--------|---------|-----------|-------|
| `ndjson` | `NdjsonAdapter` | ✅ | One JSON object per line — the canonical large-scale format |
| `csv` / `tsv` | `DelimitedAdapter` | ✅ | Quote-aware via stdlib `csv`; cells must not contain raw newlines (nested values go in `properties_json`) |
| `json` | `JsonAdapter` | ❌ (buffered) | A single `[{…}]` array — human-scale only |
| `xlsx` | `XlsxAdapter` (lazy) | ❌ (buffered) | A real workbook; needs `openpyxl`, registered lazily so a missing lib never breaks the others |

**Encoding robustness.** `decode_bytes` (`formats.py:31-42`) strips a UTF-8 BOM (Excel "CSV UTF-8")
and falls back UTF-8 → cp1252 so Windows/Excel exports never crash the import; `_lines`
(`formats.py:58-69`) reassembles lines across byte-chunk boundaries and tolerates CRLF. Content-based
detection on the client (`detectFormat`, `importExportApiService.ts:181-197`) sniffs the first bytes
(PK → xlsx) rather than trusting a possibly-missing extension.

**The xlsx workbook** (`xlsx_adapter.py`) is the strategic fix for flat-CSV column-shift fragility:
separate **Nodes** and **Edges** sheets (kind comes from the *sheet*, not a column, so a stray value
can't shift into `_op`, `:34-40`), greyed **locked identity** columns (`_LOCKED`, `:17, 116-117`),
an `_op` dropdown data-validation (`:124-128`), and an **Instructions** sheet (`:139-161`). Adding a
property is typing under a new `prop.<name>` header — nothing shifts.

---

## 8. Export

`ExportWorker.run` (`export_worker.py:198-239`) materializes a branch's state and streams it to the
`result_uri` artifact through the chosen adapter, then records a `{nodes, edges, bytes}` summary.

- **Branch vs published.** A `branch_id` (a working draft) exports the draft's **composed state**
  (main + committed + draft ops, `:210-213`); omitting it defaults to **published `main`**
  (`:205-208`). This is what lets a user export their in-progress branch, edit it in Excel, and
  re-import onto the same branch.
- **As-of.** `as_of_seq` gives a point-in-time snapshot (materialized via the engine's time-travel
  read).
- **View-scoped export.** When a `viewId` is given, `filter_to_scope` (`export_worker.py:144-159`)
  restricts to the view's entity set. The **authoritative source is the view's
  `context_model.instance_assignments`** — the explicit physical-entity → logical-layer placements —
  resolved server-side by `_resolve_export_view_scope` (`versioning.py:1906-1937`): the assigned URNs
  (entries with a real `layerId`) plus their containment descendants (when `inheritsChildren`, the
  default). Edges are kept only when **both** endpoints are in scope. Fail-open ⇒ whole data source.
  A type/layer allow-list is the fallback for views not defined by explicit assignments
  (`_keep_from_filters`, `:128-141`).
- **Row-scoped export.** `filter_to_selection` (`export_worker.py:162-182`) keeps only an explicit
  `entity_id`/`urn` set and/or entity-type set (intersection), composing after view scope.
- **Add-property columns.** `props` emits extra empty `prop.<name>` columns to fill (`:219-222`).

**The options plumbing is consistent end to end** (verified against the current tree): the
`create_export` endpoint declares `props`/`ids`/`types` and passes
`extra_props`/`select_ids`/`select_types` (`versioning.py:2095-2116`) → `create_export_job` packs
them into an `options` dict stored in `field_scope` (`service.py:208-221`) → `run_export` passes
`options=` to `ExportWorker` (`service.py:239`) → the worker reads `options.get("props"/"ids"/"types")`
(`export_worker.py:191-196`).

> **Limitation — the UI exposes a subset.** The **backend** supports `props` + row-scope (`ids` /
> `types`) + view-scope + branch-vs-published + as-of. The **ExportDialog / client service** currently
> send only `format`, `viewId`, `branchId`, and `props` (`importExportApiService.ts:135-151,
> 200-212`) — so **row-scoped export (`ids`/`types`) is API-only today**, not surfaced in the dialog.
> Row-scope is fully wired server-side; surfacing it in the UI is the remaining step. (An earlier
> analysis flagged a `TypeError` in this plumbing; it is **not present in the current code** — the
> three layers' kwargs line up.)

> **Limitation — export buffers the read.** v1 `materialize_state`s the whole branch state, then
> streams the write (`export_worker.py:9-10`). Fine for human-scale exports; a keyset-streaming read
> for multi-million-node graphs is a follow-up that swaps `materialize_state` for
> `reconcile._stream_pg_nodes` without changing the rest.

**Lossless round-trip.** `records_from_state` → `denormalize_node`/`denormalize_edge`
(`rowmodel.py:132-168`) spill scalar props to `prop.*` and nested to `properties_json`, mirroring the
projector's native-vs-`propertiesRaw` split, so an unchanged export re-imports to a zero diff. A
whole-data-source export is therefore a faithful **backup**; the identity columns let a re-import
restore or clone the graph.

---

## 9. Object store & artifacts

All import/export blobs (uploaded source, export result, preview/rejected reports) are stored under a
self-describing `{workspace}/{data_source}/{graph}/{job}/{name}` key (`storage_key`,
`object_store.py:25-27`), attributable to their origin at a glance. Everything streams at a 1 MiB
chunk size, so a 5M-row file is never buffered whole (`LocalFsObjectStore`,
`object_store.py:75-100`); a path-escape guard rejects keys that resolve outside the root
(`:67-73`).

> **Limitation — local only in v1.** `get_object_store` returns a filesystem store rooted at
> `IMPORT_STORE_ROOT`; `OBJECT_STORE_BACKEND=s3|gcs` raises `NotImplementedError`
> (`object_store.py:121-133`). Cloud backends implement the same `ObjectStore` Protocol and differ
> only in `upload_target` (a presigned PUT vs the backend-streamed blob), so callers don't change —
> but the presigned path is modeled, not yet backed (`UploadTarget`, `:37-49`).

---

## 10. Preview, templates & the dialogs

- **Preview.** `get_preview` (`service.py:124-145`) returns the job summary plus a bounded sample of
  **changed** rows only (`status != "unchanged"`, capped at `PREVIEW_SAMPLE_LIMIT` = 200) with a
  human label per row — a real "T0 · updated / orders · new / row 13 · invalid: <reason>" preview,
  not noise. The **full field-level diff is the draft-vs-main diff** served by the existing
  versioning endpoints ([06 — API Reference](06-api-reference.md)).
- **Starter template.** `GET /imports/template` (`versioning.py:2030-2050`, declared *before*
  `/imports/{job_id}` so the literal path wins) returns a prepopulated file — the column schema plus
  a few real rows from the graph, or worked examples when it's empty (`build_template`,
  `service.py:251-273`).
- **The dialogs** (`frontend/src/features/import-export/{ImportDialog,ExportDialog}.tsx`, client
  service `importExportApiService.ts`): the ImportDialog drag-drops a file, content-detects its
  format, offers upsert/replace (replace warns, and when view-scoped notes only the view's entities
  can be deleted), uploads, polls the job (`pollJob`, `:215-228`), and shows a
  New/Updated/Deleted/Needs-fixing summary + changed-row preview with a "Review changes" handoff to
  the draft's Changes panel. The ExportDialog offers format, branch-vs-published (when on a draft),
  view-vs-whole-DS (when in a view), and "add property columns"; `exportAndDownload`
  (`:200-212`) creates → polls → downloads with a correct `.<format>` filename
  (`triggerBrowserDownload`, `:169-177`). See [07 — Frontend Integration](07-frontend-integration.md).

---

## 11. Limitations & open items (candid)

- **In-process `BackgroundTasks` dispatch**, not a durable async dispatcher — a process restart
  mid-import kills the job (`service.py:9-11`). Highest-priority hardening item.
- **Export buffers the read** (`materialize_state` before streaming the write) — keyset streaming is
  the 5M+ follow-up (`export_worker.py:9-10`); **JSON and xlsx are buffered** on both parse and write
  (`formats.py:120-122`, `xlsx_adapter.py:26-32`), so they're human-scale formats — use ndjson/csv
  for millions.
- **Object store is local-only**; S3/GCS and the presigned-upload path are stubbed
  (`object_store.py:121-133`).
- **Row-scoped export is API-only** — the UI sends only `props` (`importExportApiService.ts:135-151`).
- **`auto_publish` and a custom draft `name`** exist on `JobORM` / `create_import_job`
  (`service.py:75-77`) but the `create_import` endpoint doesn't expose them — imports always flow
  through the manual review/publish path (the draft is named "Import").
- **`idempotency_key` is stored on import/export jobs but not deduped in the workers** — job-level
  idempotency for these paths is a designed follow-up (the ndjson `bulk-ingest`/`sync` paths dedup at
  the service level, separately; see [10 — Authoritative Sources](10-authoritative-sources-datahub-openmetadata.md)).
- **`INLINE_IMPORT_MAX` (5,000) two-tier threshold** exists in config as the intended
  "stage small imports client-side, run large ones async" split, but the endpoint currently always
  dispatches the async worker.
- **Staging retention.** `import_rows` and artifacts are meant to be GC'd after a terminal job
  (`STAGING_GC_DAYS` = 7); confirm the sweeper is wired before relying on automatic cleanup — see
  the retention discussion in [09 — Scale, Limits & Roadmap](09-scale-limits-and-roadmap.md).

---

## Related chapters

- [03 — Branching, Commits & Merge](03-branching-commits-merge.md) — `apply_ops`, drafts, cascade
  delete, `_patch_payload` (where `PROP_DELETE` lands), and the 3-way merge imports inherit.
- [05 — Ontology Governance](05-ontology-governance.md) — the commit-boundary gate the per-row
  ontology check complements.
- [06 — API Reference](06-api-reference.md) — the import/export REST routes, auth, and the
  draft-vs-main diff that is the full import preview.
- [07 — Frontend Integration](07-frontend-integration.md) — the Import/Export dialogs and the
  committed-changes review handoff.
- [09 — Scale, Limits & Roadmap](09-scale-limits-and-roadmap.md) — the async-dispatcher, streaming,
  and retention roadmap.
