# Change streams: automation that lands many small changes as few commits, with nothing lost

> **Status: phase 1 built, phase 2 proposed.**
> - **Built (phase 1):** the audit trail (§3.6), people first (§3.5), history that reads well
>   (§3.7, its phase 1 part) and the fixes (§3.8). Each says what was built, and where.
> - **Proposed (phase 2):** the streams themselves (§3.1–§3.4) and revert a run. Nothing marked
>   NEW exists yet.
>
> This is the HTTP-push answer to the gap doc 12 left open: doc 12 specifies Kafka ingestion and
> lists "an HTTP push endpoint" as a non-goal (12:68, 12:1082). Where the two meet, this doc follows
> doc 12's contracts (doc 15), so the Kafka path can later feed the same core.

## 1. The problem, as the code had it before phase 1

An API key or service account that sends small, frequent changes has three ways in. All three are
wrong for a stream.

| Path | What N small changes become | Cost per change |
|---|---|---|
| Graph routes with no draft (`/graph/nodes/create`, `/graph/edges`, …) | **N main commits.** `/graph/commands/batch` makes one per *command* | Each one takes `_lock_graph`, does about 25 round trips, writes Merkle rows, nudges projection and bumps the cache |
| An import with `autoPublish` per run (what the reference connector does) | N drafts, N publish jobs, **N `squash_publish` commits**, and N inbox notices to the account's managers | Each run is a whole job pipeline |
| `/sync` | N commits, each **O(whole graph)**, refused above 250k entities | It deletes whatever the snapshot leaves out, so it is not a delta API |

What follows from that:

- **People's publishes livelock.** Every main commit puts every open draft behind main. Publish and
  merge then hard-block with `not_up_to_date` until the person pulls (03:306-314). A stream that
  commits every few seconds means people can never publish. This is the open item at 09:384-385.
- **History becomes unreadable.** It shows thousands of one-entity commits, with no
  People/Automation filter (`ViewHistoryTimeline` has none).
- **The audit trail has holes.** Commits store an actor and nothing else: no API key, run, request
  id or source record (`models.py:557-606`). No commit, publish, merge, import, sync, revert or
  restore writes an activity event, so the ledger's `api_key_id` column is never filled for content
  changes. A publish rewrites each entity's revision to name the publisher (`service.py:10023`). An
  import job keeps no actor at all.
- **Projection pays a whole-graph cost per pass.** `_verify_and_heal` counts the whole graph in
  Postgres and FalkorDB whenever a pass reaches main's head (`projection.py:874-880`). Frequent
  small commits mean frequent full counts.

## 2. Goals

1. **Nothing is lost.** A change is durable before it is acknowledged. Every accepted change ends in
   exactly one recorded outcome — applied, unchanged, kept-people's-value or refused with reasons —
   and nothing is ever dropped. A change that can't be applied yet is *held* (doc 12 G1).
2. **Exactly once.** Sending the same batch again is safe (`batchKey`), and so is a worker crashing
   mid-flush. A commit and its batches' outcomes are written in one transaction.
3. **Few commits.** Changes arriving over a window become one `ingest` commit per stream per flush,
   bounded in size.
4. **A complete audit trail, never compacted by default.** It answers:
   - for every change: who, with which key, in which run, from which source record, and what
     became of it;
   - for every commit: which changes it holds;
   - for every entity: which change last set it.
5. **People come first.**
   - Automation never overwrites a person's edit *silently*.
     - Under the default `source_wins`, the source system is the truth for what it sends, and each
       batch's outcome records whose value it replaced.
     - Under `keep_people`, a person's value is kept (10:182-184).
   - It never blocks a person's publish when they touched different entities.
   - History separates People from Automation.
6. **Faster than today at any rate.** Accepting a batch is an insert, with no graph lock. The
   per-commit fixed cost is paid once per window, not once per change.
7. **The same governance.** A key still never holds publish: a stream lands on main only where its
   owner — the person or the service account — holds Publisher, re-checked at every flush.

## 3. Design

```
 connector ──POST batch──▶ accept: validate, insert stream_batches(pending), 202 ──▶ nudge
                                     (no graph lock; durable before acked)          │
                                                                                     ▼
 people ──draft/publish──▶ main ◀── one `ingest` commit per window ◀── stream flusher (worker)
                            ▲        + batch outcomes + shadow,           fold → resolve →
                            │        one transaction                       no-clobber merge
              publish/merge past automation-only, non-overlapping commits: no pull needed
```

### 3.1 A stream (NEW: `graphver.change_streams`)

A stream is a named, long-lived lane of machine changes into one versioned graph, owned by one
principal.

| Field | Meaning |
|---|---|
| `id`, `graph_id`, `workspace_id`, `data_source_id`, `name` | `name` is unique per graph among live streams |
| `owner` | The person or service account the stream applies as. It is the key's account at creation, and keys push only into their own account's streams |
| `target` | `main`, or later `review` (§6) |
| `flush_after_ms` | Flush this long after the oldest pending batch arrived. Default 300 000 (5 minutes), from `STREAM_FLUSH_AFTER_MS`; settable per stream from 1 000 to 3 600 000 |
| `flush_max_rows` | Flush as soon as this many rows are pending (default 5 000; at most `SYNC_PUBLISH_MAX_CHANGES`) |
| `on_conflict` | `source_wins` (default) or `keep_people` (§3.4) |
| `state` | `active`, `paused` (by its owner or an admin), `held` (by the system, with `held_reason`) or `retired` |
| `next_seq`, `applied_seq` | Batches accepted, and the highest batch with an outcome. The difference is the backlog |
| `last_flush_at`, `last_commit_id`, `last_error`, counters | For health |

### 3.2 A batch: the durable change log and the audit sink (NEW: `graphver.stream_batches`, hash-partitioned by graph)

One row per accepted push, kept forever by default:

- `seq`, assigned under the stream's row lock and gap-free per stream;
- `batch_key`, the client's idempotency key, unique per stream;
- `actor`, `api_key_id`, `correlation_id` (from the request), `run_id` and `source_ref` (the
  client's own pointer: system, offsets, record ids);
- `received_at`, and `rows` in import record format v1 (the published contract,
  `backend/common/schema/import-record.v1.json`), with `row_count` and `content_hash`;
- `status` (`pending` → `applied` | `unchanged` | `partial` | `refused`), plus `commit_id`,
  `applied_at` and `outcome`: tallies, per-row reasons, and the fields kept for people.

The ledger is where the per-change audit trail lives (doc 15 §11, one audit sink per fact). A
`stream_batches` row and the commit it went into answer every question in §2.4. The commit is the
sink for *what* changed; the batch is the sink for *who asked, from where*.

### 3.3 Accepting a batch (NEW: `POST /{ws}/versioning/graphs/{gid}/streams/{sid}/batches`)

1. Same gates as an import into a draft: `requires(manage)`, `graph_in_workspace` (which holds a key
   to its data sources), and the stream must be the caller's.
2. Body: `{batchKey, runId?, sourceRef?, records:[…]}` (JSON) or NDJSON with query parameters. At
   most 8 MiB and `IMPORT_COMMIT_WINDOW` rows.
3. Records are parsed and normalized as an import does (`_normalize_page`). A malformed batch is
   `422` with row reasons, and nothing is stored. There is no graph read and no graph lock.
4. One short transaction: lock the stream row, take `seq = next_seq`, insert the batch. Then nudge
   the flusher (Redis, best-effort — a poll covers a lost nudge). Answer `202 {batchId, seq,
   status, backlog}`.
5. A `batchKey` sent again answers with its batch (`200`). The same key with different content is
   `409 batch_key_reused`.
6. Backpressure: past `STREAM_MAX_PENDING_ROWS` pending in the stream (default 200 000), `429` with
   `Retry-After`. A `paused` or `held` stream still accepts up to that cap: held, never dropped. A
   `retired` stream answers `410`.

### 3.4 The flusher (NEW: a worker loop, single-flight per stream)

It runs when a stream is due: `flush_after_ms` has passed since its oldest pending batch, its pending
rows reach `flush_max_rows`, or someone calls `POST …/streams/{sid}/flush` (`?wait=true` answers
with the commit). It runs one stream at a time, under `pg_try_advisory_lock('gvstream:'+sid)`.

1. **Still allowed?**
   - The owner must hold publish in the workspace, read live as `require_publish_for_main` reads
     it.
   - The data source's policy must allow merging one's own changes.
   - The graph must be writable.
   - Otherwise the stream goes `held` with the reason, its batches stay pending, and its managers
     are told once.
2. **Take a window.** Pending batches in `seq` order, up to `flush_max_rows` rows.
3. **Fold.** Rows naming the same pointer (urn, entity id, qualifiedName, or an edge's ends and
   type) are folded in batch order, last writer wins per field. A delete followed by an upsert
   upserts; an upsert followed by a delete deletes. If two rows still name one *new* entity by
   different pointers — which only resolution can tell — the window ends before the later batch,
   which goes in the next window.
4. **Resolve** against main, exactly as an import window does: `ImportWorker._node_lookups` /
   `_edge_lookups` and the pure `resolve_rows`, with the ontology's per-row gate. Rows that are
   refused are recorded, not fatal.
5. **No-clobber merge against the shadow** (NEW: `graphver.stream_assertions`, hash-partitioned:
   per stream and entity, the fields the stream last asserted).
   - For each path a row sets: if main still holds what the stream last said (or the stream never
     said anything there), the stream's value applies.
   - If main changed since then — a person, another stream, a revert — and the source changed it
     too, that is a conflict:
     - `source_wins` (the default) takes the stream's value, and records in the batch's outcome
       whose value it replaced (`replaced`), so the overwrite is never silent;
     - `keep_people` keeps main's value and records it in the outcome as `kept`.
   - If the source didn't change the path, main's value stays — under either setting.
   - A delete of an entity someone changed since the stream last asserted it is applied under
     `source_wins` (recorded as `replaced`) and kept under `keep_people`.
   - The shadow records what the source said, whatever the outcome.
   - This is doc 12 §6's three-way merge (base = shadow, ours = main, theirs = assertion), limited to
     the paths a row carries. A first contact applies, as an upsert import does today.
6. **Write one commit.**
   - It goes through `apply_ops(…, allow_main=True, kind='ingest', on_commit=…)`, the same write
     path, gates (ontology, edge integrity, OCC heads) and lock as every main write.
   - Rows the write gate refuses are set aside and the rest retried (the import's `_quarantine`, up
     to 4 rounds).
   - `on_commit`, inside the same transaction:
     - sets each batch's outcome and `commit_id`, refusing if any batch is no longer `pending`
       (another flusher won);
     - upserts the shadow and advances the stream's `applied_seq`.
   - The commit carries:
     - `actor` = the owner, `actor_kind='service'` for a service account or `'human'` for a
       personal key;
     - `stream_id`;
     - `source_ref = {batchSeqFrom, batchSeqTo, batches, rows, runIds[≤20], apiKeyIds}`;
     - message `"<stream name>: N changes from M batches"`.
   - Each entity's version row carries `change_reason = 'stream:<sid>#<seq>'`, the batch that last
     set it.
7. **After.**
   - Nudge projection once, bump the read cache once, record one activity event (§3.6).
   - A window where every row came out unchanged writes no commit: its batches turn `unchanged`.
8. **Adaptive window.** While projection lags more than 5 minutes behind, or the graph lock is
   contended, `flush_after_ms` doubles, up to twice the stream's own setting (doc 12:800).

### 3.5 People are not blocked by automation (BUILT: the publish and merge gate)

A draft behind main used to have to pull before it published. Now publish, merge and a queued
publish job (`GraphVersioningService._pull_needed`) let it land without a pull when **every** main
commit since the draft's base is automation's (`provenance.is_automation`: a service account, the
platform, or any API key), and none of them:

- changed an entity the draft changes; or
- met the draft at an edge:
  - an edge made or changed onto a node the draft deletes (deleting the node would delete that
    edge too);
  - a node deleted under an edge the draft makes.

A new edge onto a node the other side only renamed merges cleanly, and lands. `_compute_merge_bounded`
already merges such a draft exactly: base, ours and theirs over the changed set, then
`_hydrate_merge_neighborhood` for cascades and dangling edges. The squash re-runs ontology and
integrity against current main.

Otherwise it answers `409 not_up_to_date` with a `reason`:

| `reason` | When | What the person is told |
|---|---|---|
| `people` | Anyone made any other commit since the base, as before | Get their changes in and check them, then publish |
| `overlap` | Automation changed what the draft changes, or met it at an edge | See what automation changed, keep the values you want |
| `size` | The draft is above `SQUASH_PAGED_ABOVE` | A draft this large publishes only up to date |

A fork's main still pulls whenever it moved, because it also moves with its parent.

- **Freshness** (`GET …/branches/{id}/freshness`) says `behindByPeople`, `pullRequired` and
  `pullReason`. For a draft of up to 10 000 changes it also checks the overlap on each poll, so the
  canvas can say "Published moved — automation only, nothing you changed" before anyone presses
  Publish.
- **A review** (`_pr_meta`) says `behindByPeople` and `pullRequired` from the cheap count. Merging
  finds an overlap and says why.

This is doc 12's D2 gate, without its structural heuristics.

### 3.6 Audit, for automation and for people alike (BUILT: every commit)

- **Every commit records how it was made.** It records:
  - `commits.actor_kind`: `human`, `service` or `system`;
  - `api_key_id`: only when the request's actor is the commit's;
  - `correlation_id`.

  These are read from the request's activity context (`provenance.commit_provenance`), and added by
  migration `20261110_1000_gv_commit_prov`. A commit from before them is classed from its actor.
- **Jobs keep their request's provenance.** `jobs.provenance` (`provenance.snapshot`) is kept by the
  ingest, publish, export and fork jobs, and by enabling version control. Their runners bind it
  again (`provenance.bound`), so a worker's commit names the key and request that queued it.
- **A publish credits each entity to its editor.** Each entity's version row on main names whoever
  edited it in the draft (`_editors`). The commit's actor is still the publisher, and its
  `contributors` everyone who edited. Before, every revision named the publisher (the go-live
  review's HISTORY-1).
- **Every commit that advances main writes one activity event**, under its data source
  (`main_activity`). It carries the commit, its kind and counts, `actorKind`, `automation`, and the
  commit's own actor, API key and request.

  | Event | Commit |
  |---|---|
  | `workspace.versioning.published` | A publish, a review's merge, a fork's merge (`squash_publish`) |
  | `workspace.versioning.main_edited` | A write straight to main (`edit`) |
  | `workspace.versioning.ingested` | A bulk ingest (`import`) |
  | `workspace.versioning.synced` | A snapshot sync or re-sync (`sync`) |
  | `workspace.versioning.reverted` / `restored` | `revert` / `restore` |
  | `workspace.versioning.stream_flushed` | A stream's flush (phase 2) |

  The event is noted where main's head moves, and written only once that transaction commits
  (`db.after_commit` on the graphver session). An attempt that rolls back and is retried leaves
  nothing, and a failure to record never fails the commit. Turning version control on and updating
  a fork from its parent keep the events they already had. The events filter and export like the
  rest.
- **History APIs say what they store.**
  - The commit log takes `origin=people|automation`; default: everything.
  - Each entry carries `actorKind`, `apiKeyId`, `correlationId`, `automation` and `changeReason`.
  - The response names each key (`apiKeyNames`), and so does a squash's drill-down.
  - Phase 2 adds `streamId` and `sourceRef`, and NEW `GET …/commits/{cid}/batches`, which lists the
    batches a commit holds. Entity history will then show the batch that set each revision.
- **Retention:** batches are kept for as long as their commits (forever). Doc 12's compaction stays
  unbuilt: coalescing removes the commit volume it was meant to cure. If it is built later, it
  archives first (`history_export`, 14:664).

### 3.7 History that reads well (UI)

**Built in phase 1:**
- The history timeline has an Everyone / People / Automation filter, and says which it is showing.
- Each automated commit shows chips: Service account, Platform, and the API key, named. A key
  chip's tooltip gives the request.
- Consecutive commits of one automation through one key, on one day, collapse into one row that
  opens to its commits: "Snowflake sync · 42 commits · 1,240 changes · 09:00–11:30" (doc 12:753).
- The data source's Versioning tab shows the same chips, and its "N changes" count now reads the
  right stats.
- A draft behind Published is told why it matters (§3.5):
  - a calm note when automation alone moved Published, on nothing it changed;
  - "get the latest first" when a person did, or automation changed what it changes.

  Each "What changed" list says who made every commit. A refused publish or merge says which,
  and what to do next.

**Phase 2:**
- Runs collapse per stream, and a commit row shows its stream chip. "N batches" opens the batch
  list, where each batch shows run id, key, source ref, outcome and the fields it replaced or kept.
- The data source's Versioning tab gets a **Streams** panel per stream:
  - owner, state, held reason, backlog and lag, last flush and commit;
  - pause, resume, flush now and retire;
  - a batch browser filtered by status and run.
- Entity history shows "set by Snowflake sync (batch #812, run 2026-11-09T09)".

### 3.8 Fixed on the way (BUILT)

- `/graph/commands/batch` writes **one** commit per request on a versioned graph, not one per
  command.
  - The versioned providers hold each command's write in a request-scoped batch (`write_batch`),
    and the route commits them together. What a command created can be read back or deleted by a
    later one.
  - A busy or paused graph lands none of them, so the batch can be sent again as it was.
  - A batch the store refuses as a whole runs again command by command, as before, so each result
    says whether that command landed.
- Projection's whole-graph count verify runs at most every `PROJECTION_VERIFY_INTERVAL_SECS` per
  graph (default 300; `0` verifies every pass), not on every pass that reaches main's head.
  - It always runs on a full seed, on a pass that dropped a write, for a key with drift on record,
    and on a graph whose last verify healed or failed.
  - A delta dropped silently between verifies is caught by the next verify.
- The Versioning tab reads `stats.create/update/delete`. It read `created/updated/deleted`, so "N
  changes" never showed.

## 4. Why not the alternatives

- **Batch in the client.** It puts the window, idempotency, crash safety and audit in every
  connector, and still needs one of the three wrong paths above.
- **Buffer the existing write-through routes in memory.** A process restart would lose changes. A
  durable buffer *is* the batch ledger.
- **One long-lived automation draft, published on a timer.** Merged drafts can't reopen (an
  invariant). One import runs per draft. A big draft blocks on `publishing`. And the squash credits
  the publisher. A stream keeps a draft's audit without a draft's lifecycle. Review-target streams
  (§6) use drafts where a review is actually wanted.
- **Compact history after the fact (doc 12 D3).** It is destructive, cannot be undone, and breaks
  revert for compacted ranges. Coalescing at the source gets the same storage win while keeping
  every change.

## 5. Security and governance

- Streams follow doc 13 and RBAC → *Who publishes data*:
  - creating one, pushing to it and reading its batches need manage on the data source, and a key
    must cover that data source;
  - landing on main needs the owner's publish, checked at every flush;
  - a data source whose policy has someone else merge refuses `target=main` (`review_required`).
- New key-callable routes join `api_key_surface.SURFACE` and the reviewed snapshot (ADR-027).
- Streams are per owner. A key pushes only into its own account's streams, and reads only those
  streams' batches. Workspace admins see every stream on their data sources, and can pause or
  retire one.
- A service account's held or refused batches notify its managers, deduplicated per stream per day.
  A successful flush notifies nobody.

## 6. Phases

| Phase | Ships |
|---|---|
| **1 — Audit and people first (built)** | §3.6 commit provenance, job provenance, original editor on publish, and activity events for every main-advancing commit; §3.5 gate with its reasons; commit-log `origin` filter, and History's People/Automation filter, chips and runs; guided "behind Published" states; §3.8 fixes |
| **2 — Streams to main** | §3.1–§3.4 tables, API, flusher, shadow and no-clobber (`source_wins` by default); **revert a run** (inverse ops from the batch ledger, as one `revert` commit); Streams panel and batch drill-down; reference connector `--stream`; docs |
| 3 — Later | Review-target streams (a standing draft and merge request per stream, reopened after each merge); outbound change feed and webhooks per commit; doc 12 field policies and guardrails; the Kafka transport on the same ledger and flusher; retention tiers with archive-first |

## 7. Decisions

1. **The default `on_conflict` is `source_wins`.** A stream's source system is the truth for what
   it sends. Every overwrite of a person's value is recorded in the batch's outcome, and
   `keep_people` stays available per stream.
2. **The flush window is configurable, and 5 minutes by default** (`STREAM_FLUSH_AFTER_MS`, and per
   stream).
3. **Two pull requests:** phase 1 first, then phase 2.
4. **Original editor on publish ships in phase 1. Revert a run ships in phase 2**, because it needs
   the batch ledger.
