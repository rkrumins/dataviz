# 17 · Forks You Can Work In, and Residency

> **Audience & scope:** engineers and reviewers of the fork work. What a fork is now that it is a
> data source of its own, how its settings follow its parent's, how it moves through the trash and
> between workspaces with its parent, and how a fork reads its parent commit by commit. Then
> residency (§8–§17): which graphs FalkorDB holds, by class and by each master's memory, where a
> new key goes, adopting a customer's key, and the admin screens. The fork
> engine itself — copy-on-write reads, pull requests, merge — is in
> [03 · Branching, Commits & Merge](03-branching-commits-merge.md); the routes and their refusals are
> in [06 · API Reference](06-api-reference.md); every behaviour change is in the
> [CHANGELOG](../../CHANGELOG.md).

**Checked against the code on 2026-10-30 (`76acf1fe2`).**

**TL;DR.** Forking a graph now makes a data source as well as a graph: the fork's own row in
`workspace_data_sources`, in its parent's workspace and on its parent's provider. Views, the canvas
and every data-source read reach the fork by that id. Its governing settings are its parent's and
stay so. It goes to the trash, comes back and is purged with its graph, and moves with its parent.
It never has a FalkorDB graph of its own: it reads through version control. Each of its commits
records which parent commit it reads, so a fork can later take its parent's newer work without
rewriting its own history.

## 1. What a fork is now

Before this release a fork was a graph and nothing else. Its `dsfork_…` id was minted for the graph
row in `graphver` and stored nowhere in the management database, so the canvas, views and the
data-source routes could not name it. Now `POST /api/v1/{ws}/versioning/graphs/{gid}/forks` makes
both:

| | The fork's data source |
|---|---|
| Id | The fork graph's own `dsfork_…` id, so either names the other |
| Workspace and provider | Its parent data source's |
| `graphName` | Always `null`: a fork's row names no FalkorDB graph (`ck_ds_fork_no_key`) |
| `label` | `"<parent label> · <name>"`; `name` comes from the request body (1–80 characters), else `Fork` and the last six characters of its id |
| `forkOf` | `{dataSourceId, graphId}`: the data source and graph it was forked from. `null` on every other data source |
| Governing settings | Its parent's (§3) |
| `fork_of_data_source_id` | The parent data source, `ON DELETE RESTRICT`: a parent row goes only after its forks' rows |

A fork of a fork names its direct parent; the chain ends at a data source that is not a fork.

**Making one across two databases.** The data source lives in the management database and the
graph in `graphver`, with no transaction across them. The route follows the blank model's order.
Everything that would refuse the fork is checked first (`fork_preflight`: the parent graph is in
this workspace and not in the trash, its editing is not paused, and it is under its fork limit).
The parent's row is read `FOR SHARE`, so a move of it finishes first. Then the fork's row commits,
the fork graph is made, and a fork that could not be made takes its row with it. A crash between
the last two leaves a row with no graph; the reaper deletes it once it is ten minutes old (§4). The
activity log records `workspace.versioning.fork_created`.

**Where forks are listed.** `GET …/graphs/{gid}/forks` gives each fork's `dataSourceId` and
`label`. The workspace's data-source list leaves forks out unless asked
(`GET /api/v1/admin/workspaces/{ws}/data-sources?includeForks=true`), and so do the data-source
lists embedded in workspace answers, the workspace's default source and its last-source count: a
fork is reached through its graph, not picked as a workspace's source.

## 2. Reads and writes: no store of its own

A fork's data source reads and writes through version control, as any versioned source does, and
never through a FalkorDB graph of its own:

- **Reads.** `ContextEngine` recognises a fork's row before it builds a provider, and builds none.
  The fork's `main` reads through `VersionedBranchProvider` — its own rows over its parent's, at the
  parent commit each of its commits took (§5) — and a draft on it through `DraftOverlayProvider`
  over that.
- **Writes** are commits on the fork's drafts, or on its `main` for someone with publish, exactly as
  on any versioned source.
- **The provider registry** hands out, for a fork's row, its root parent's provider, read only
  (`fork_sources.ForkReadOnlyProvider`). Every write through it is refused, so nothing addressed to a
  fork reaches FalkorDB. A managed data source with no graph and no pin is refused too, instead of
  reading the provider's default graph.

Until reads move onto an overlay (§7), looking up by its URN an entity the fork has not changed
finds nothing through the fork's data source; its `gv:` id finds it.

What needs a data source's own graph store answers for a fork as follows:

| Request on a fork's data source | Answer |
|---|---|
| A write through the provider registry; an aggregation trigger; a dedicated rollup graph or projection mode; a projection move; bringing outside changes into history | **409** `fork_has_no_store` `{dataSourceId, message}`. Do it on the data source it was forked from |
| A native query | **501** `native_query_unavailable`: native queries read a graph's own published store, and a fork reads through its parent |
| Deep search | **501**: search reads a graph's own published store; search the parent, or browse the fork in the canvas |

The schedulers and scans that work per data source leave forks out: the probe and stats
schedulers, silent-source alerts, the reconcile sweeper, the aggregation and capacity views and the
status probes. A fork has no rollups of its own.

## 3. Settings follow the parent

A fork is governed as its parent is. These settings are copied from the parent's row when the fork
is made and are never the fork's own to change:

`ontologyId`, `isRestricted`, `accessLevel`, `identityProperty`, `nameProperty`, and the draft
policy (`draftDefaultVisibility`, `draftLevels`, `reviewSelfApproval`, `reviewSelfMerge`).

- **A change on the parent** — through `PUT /api/v1/admin/workspaces/{ws}/data-sources/{ds}`, or
  the versioning router's `PUT /data-sources/{ds}/drafts-policy` — is made on every fork of it,
  forks of forks too, in the same transaction.
- **A change on the fork's row** is refused: **409** `fork_settings_follow_parent` `{fields, message}`,
  naming the settings it would have changed. Nothing of the request is kept. The fork's label and
  its other fields stay its own to edit.
- **A view over a fork** is restricted when its root parent is.

## 4. Lifecycle: the row goes where the graph goes

The fork routes take the row along with the graph, after the graph:

| Step | Graph | Data source |
|---|---|---|
| `DELETE …/graphs/{fork}` | To the trash | Tombstoned (`deletedAt`, `deletedBy`) |
| `POST …/graphs/{fork}/restore` | Back from the trash | Live again |
| The fork's purge completes (after its undo window, or with its parent's purge) | Gone | Deleted |
| Its parent moves to another workspace | Moves with the parent's graph | Moves with the parent's row, in the same transaction, with the views on it; an undo brings both back |

The data-source routes never act on a fork's row on its own: delete, permanent delete, restore,
move, move preview and transfer requests answer **409** `use_fork_endpoints`.

**A parent's permanent delete** queues the purges of its trashed forks before its own, and deletes
their rows with its own. A live fork refuses it (**409** `live_forks`) before anything is queued —
also when the parent has nothing published, whose graph purge would not wait for its forks: the
fork's row names the parent's.

**The reaper keeps the two in step.** Each step above crosses two databases, so a crash can leave
the row behind its graph. On every pass, `Reaper.fork_rows`:

- gives a live fork graph with no row its row, made from its parent's as the fork route makes one,
  labelled `"<parent label> · Fork <last six of its id>"` — this is also how forks made before this
  release get theirs;
- tombstones a row whose graph is in the trash, and brings back one whose graph is live;
- deletes a row whose graph does not exist — never made, or purged — once it is ten minutes old
  (`ORPHAN_FORK_ROW_SECS`; a younger one may be a fork still being made).

It reads the rows before the graphs, so a trash or a restore in flight is only ever carried forward.

## 5. The per-commit parent base

A fork reads its parent's `main` at a base: its own rows over its parent's as they were at one
parent commit. Until now that base was one number on the graph, `fork_base_commit_seq`, fixed when
the fork was made. It is now per commit, in `graphver.fork_bases`:

| Column | Meaning |
|---|---|
| `fork_graph_id`, `fork_seq` | The fork, and the commit of it from which this base holds (primary key) |
| `parent_seq` | The commit of its parent's `main` the fork reads from `fork_seq` on |
| `created_at`, `created_by` | When the base was taken, and by whom |

`fork_graph` writes the first row, at the fork point: `fork_seq` and `parent_seq` are both its
`fork_base_commit_seq`. A read of the fork at commit S composes its parent at the `parent_seq` of
the latest row at or before S (`service.fork_base_at`), and before the first row, at S itself: up
to its fork point a fork shares its parent's history. Every as-of read follows it — the whole state,
the heads, the bounded values for the ids a save or a merge touches, what changed in a window, time
travel, restore and export — and a fork of a fork reads through both bases. A fork with no row
reads at its fork point, as it always did; the migration gives every fork that has a fork point its
row.

The point of the table is the next step: when a fork takes its parent's newer commits (Update from
parent, below), it adds a row instead of rewriting anything, and every earlier commit of the fork
still reads exactly what it read when it was made.

## 6. Upgrading

- **Two migrations.** `20261030_1100_gv_fork_bases` creates `graphver.fork_bases` and gives every
  existing fork its fork-point row. `20261030_1200_ds_fork_of` adds
  `workspace_data_sources.fork_of_data_source_id` (with its index) and `ck_ds_fork_no_key`. Both wait
  at most five seconds for their locks and are safe to run again. The second refuses to downgrade
  while fork rows exist: the code before it reads a data source that names no graph from the
  provider's default graph. Delete those rows first.
- **Existing forks** get their data source on the reaper's first pass after the upgrade, if their
  parent's data source still exists. A fork already in the trash gets none and is purged as before.
- **The data-source routes refuse fork rows** (`use_fork_endpoints`, `fork_settings_follow_parent`,
  `fork_has_no_store`): use the fork routes, and change settings on the parent.
- **Lists leave forks out** unless asked with `includeForks=true`. Every data-source answer carries
  `forkOf`.

## 7. Coming next

- **Overlay reads.** A fork's reads become an overlay on its parent's FalkorDB store, and new forks
  stop getting a FalkorDB copy of their own. Until then a fork reads through Postgres, as it does
  today.
- **Update from parent.** A fork takes its parent's newer commits as a new `fork_bases` row, and a
  fork's pull request merges only when it is up to date with its parent.
- **Residency** is §8–§17 below: classes, the capacity loop, loads, placement, Adopt and the
  admin screens.

## 8. Residency: which graphs FalkorDB holds

**Checked against the code on 2026-11-01 (`563134462`).**

FalkorDB holds a copy of each versioned graph's published `main` (doc 04); Postgres is the only
source of truth. Residency decides which copies FalkorDB keeps, per graph by a class and per
cluster master by memory. A graph evicted from FalkorDB loses nothing: its reads are served from
Postgres until it is loaded again.

| Class | Evicted | Loaded again |
|---|---|---|
| **Always** | Never | When it is not in FalkorDB (set to Always while evicted, its key lost, or waiting for room), queued by the next capacity pass until it fits |
| **Standard** (the default) | When unread for the Standard idle time (7 days), or earlier when its master is under memory pressure | On its next read |
| **Coldline** | When unread for the Coldline idle time (1 hour), and first under memory pressure | Only when a request needs FalkorDB (§10), or on a canvas read of a graph larger than the canvas-load threshold |

- **The idle clock starts when residency first runs.** A graph with no read on record is never idle:
  each pass starts the clock of up to 1000 such graphs (`last_read_at` = now). So on the day the flag
  is turned on every graph's idle time starts from that day, however long ago it was published, and
  a new graph's from its first pass.
- **Only keys the platform minted are ever evicted** (`owns_falkor_graph`): a customer's own graph,
  which version control was enabled on, behaves as Always until it is adopted (§16).
- **Forks are outside residency.** A fork has no key of its own to evict, load or count; its reads
  count for its root, whose key they read (§12), and the residency routes answer **409**
  `not_for_forks` for one. A fork the count budget evicted is reseeded by the poll as before.
- **Who sets the class.** System administrators only, on Admin → Infrastructure → Versioned graphs
  (§17) or `PUT /api/v1/admin/versioning/graphs/{gid}/residency {"class": "always" | "standard" |
  "coldline"}`. A new graph gets the policy's default class. Workspaces see the class and the state
  on the graph's watermark and its Versioning tab.
- **The flag.** None of this applies unless the deployment sets `GRAPHVER_RESIDENCY_ENABLED`
  (§14). Off, eviction is the per-provider count budget, as before, and an evicted graph is reseeded
  by the projection poll within seconds.

`graphver.projection_state` holds each graph's `residency`, `last_read_at`, `evicted_reason`
(`idle_standard`, `idle_coldline`, `pressure`, `lost` — its master lost the key — or `admin`, which
nothing writes yet), `size_bytes`, `size_measured_at` and `rehydrating_since`. Its `status` gains
`rehydrating` (a load in flight) and `waiting_capacity` (a load no master has room for yet).

## 9. The capacity loop

The projection lane runs one capacity pass every policy interval (60 seconds by default), under a
Postgres advisory lock so one worker leads; a pass another worker holds is skipped. A pass starts
idle clocks, gathers, asks a pure planner (`residency_plan.plan`, no I/O) and acts. The policy
preview (§11) and admission checks run the same planner.

**What it reads.** Every live graph that is not a fork and has a key of its own; every master of
each of their providers' topologies, from the client's slot map (a standalone or Sentinel instance
is one master) — not only those holding a versioned graph's key, since the one with the most room
often holds none; for each master, its used memory, `maxmemory` and whether it is forking for
persistence or loading its dataset, and the aggregation write governor's reservations on it; which
graphs hold a read lease; and, in batched reads of the management database, which keys another
data source or a catalog entry reads and which data sources have a rollup job pending or running.

**Sizes.** A graph's size is its measured `size_bytes`. A graph never measured has no size, not 0:
it is never a pressure candidate (its eviction would count as freeing nothing), and its load is
estimated from its nodes and edges at the main head as graphver counts them (rollups are not in
history), times the bytes-per-entity estimate — the data source's statistics only when graphver's
counts are missing. A load with neither waits (`unsized`). A pass that could not read the sizes plans
no pressure eviction.

**Idle eviction.** A Standard graph unread for longer than the Standard idle time goes
(`idle_standard`), a Coldline graph unread for longer than the Coldline idle time
(`idle_coldline`).

**Pressure eviction.** A master at or above the start mark (80 % of its `maxmemory`) evicts, in
order, the idle-longest Coldline graphs, then Standard graphs by oldest read, until its use once
they are gone is at or under the stop mark (70 %). Idle evictions in the same pass count toward
it. The plan keeps the next candidates in order: an eviction the evictor refuses frees nothing, and
the pass carries on down them until the stop mark is actually reached. A master without
`maxmemory` is never under pressure.

**Never evicted:** an Always graph (also by the count budget, flag on or off), a key the platform
did not mint, a key another data source or a catalog entry reads, a graph whose data source has a
rollup job pending or running (the job would write the dropped key back), a graph with a read lease
or a pass in flight (any status but `idle`), one that is not evictable at all (in the trash, at
genesis, or still having version control enabled), and anything on a master that cannot be read or
is loading its dataset (the drop would fail). With automatic eviction off (`evictionEnabled`),
nothing is evicted; loads and admission go on.

**An eviction** goes through `CacheManager.evict`, which takes the graph's projection lock,
re-checks all of the above (the rollup jobs and who reads the key in the management database, the
rest in its guarded UPDATE), drops the key and records the reason. After its compare-and-swap
commits it checks the read lease once more, and puts the graph back as it was when a read took it in
between (§12). A drop that fails puts the key in `retired_keys`, due at once, for the retire pass to
drop. The graph then stays evicted: `project_graph` refuses to project or reseed an evicted graph,
or one waiting for room, so none of its four callers (the poll, `project_now`, `rebuild_now`,
`ensure_rebuilt`) brings it back; the poll does not select it; a rebuild asked for becomes a request
for its load (§10).

**Measuring.** Each pass measures up to 16 resident keys that were never measured or were projected
since their last measurement, those it is about to evict first: `GRAPH.MEMORY USAGE`, else, for a
load the same worker started on a master that evicted nothing that pass, how much its used memory
grew. `GRAPH.MEMORY USAGE` answers in whole MiB, so a key under 1 MiB reads 0: that is recorded as
measured, with no size, and the graph keeps its estimate.

## 10. Loading a graph again

**What asks for a load:**

| What | Classes |
|---|---|
| A person's read of the graph (§12) | Standard, Always |
| A canvas read of a graph with more entities than the canvas-load threshold (its count, kept per head, else its last size over bytes per entity) | Coldline |
| A request only FalkorDB can answer — deep search, node degrees, a native query — which answers **503** `graph_loading` with `Retry-After` (the loop's interval) meanwhile | Any |
| Load now: `POST /api/v1/admin/versioning/graphs/{gid}/load` (recorded) | Any |
| Setting the class to Always (§8, admission-checked first), and an Always graph out of FalkorDB on every pass | Always |
| An operator's rebuild of the graph (`POST …/projection/rebuild`), a move of it (§15), a watermark reset that caught its load in flight | Any |

A request is kept in the order it was first made (a sorted set on the broker). A broker that loses
it loses nothing durable: the next read asks again, and a graph waiting for room or an Always graph
out of FalkorDB is queued again — once, keeping its place.

**Admission.** Requests are taken per provider, in the order they were made. Each goes to the
master of its provider with the most room free to take a load (§15) and starts when its estimate
times the headroom (×1.3) fits under that master's start mark after what is held there — the
aggregation write governor's reservations, and the estimate times the headroom of each load and full
projection (a rebuild, a move's reseed, a first seed) in flight on it. Fitting under the start mark
rather than under `maxmemory` is the hysteresis: a load never puts its master under pressure, so the
next pass never evicts what it just loaded. One load per master at a time; none on a master that is
forking for persistence, loading its dataset, or cannot be read. When the first request fits on no
master it waits (`waiting_capacity`, logged and counted), and the requests behind it wait their turn;
each pass tries again. Its reads stay on Postgres.

Always on a graph out of FalkorDB is checked the same way when it is set: **409**
`capacity_insufficient` `{master, shortfallBytes, message}` when its load would not fit, and
nothing changes; otherwise the class is set and its load asked for.

**The load.** An admitted load pins a fresh platform key placed on the chosen master (§15), marks the
graph `rehydrating` at watermark 0 with `rehydrating_since` (a compare-and-swap under the row's lock:
one load per graph), and nudges the projection lane, whose next pass — single-flight under the
graph's projection lock — is the load: a full seed of the key from Postgres, a page at a time above
`GRAPHVER_PROJECTION_RECONCILE_STREAMED_ABOVE` entities. The key the graph had goes to
`retired_keys`, for the retire pass to drop should its eviction not have. A graph whose rollups live
in a dedicated graph keeps its key — that graph is named from it — and its load first drops whatever
is in it (a rollup job may have written it back, summaries stamp and all). The graph stays
`rehydrating` through the seed, and its watermark is not fresh, so its reads stay on Postgres even
once the seed has published. It serves reads only once its key also holds the summaries its readers
need: a summaries build's stamp, or none needed (no lineage in its ontology, its rollups in a
dedicated key, no aggregation wired in). Each load asks for the build under its own idempotency key
(`gv-rollup-rebuild:<graph>:<seq>:load<epoch>.<attempt>` — the aggregation service answers a key it
saw within the hour with the job it already ran), and asks again under a new one every 10 passes it
goes without the stamp. Then the graph is `idle`, its eviction reason and `rehydrating_since` are
cleared, and its idle time starts again from the load. A load that fails is retried by the poll after
its backoff, still `rehydrating`. A load has no timeout: its reads stay on Postgres, and how long the
oldest one has been under way is reported (§13).

**Nothing writes to FalkorDB without admission.** With residency on:

- A move of a graph out of FalkorDB (evicted, waiting, or being loaded) changes only its pin and asks
  for its load again; a load in flight is fenced off (the epoch) and the graph evicted again, to wait
  its turn. A move of a graph in FalkorDB is admission-checked on its new key's master (§15).
- The watermark reset after a restore reseeds in place what FalkorDB holds; a load in flight it
  would have reseeded goes back to the queue instead. A graph out of FalkorDB is at watermark 0, and
  the reset never touches it.
- Liveness finding a platform key its master lost (a restart without its data) marks the graph
  evicted (`lost`) rather than lowering it to 0 for the poll to reseed at once: its load is admitted
  like any other, on its next read, or by the next pass for an Always graph. A customer's key and a
  fork are reseeded as before.

## 11. The policy: every value

Every value is changed live by a system administrator, with no redeploy, and stored on
`platform_settings` (migration `20261030_1400_residency_policy`). Unset is the environment's
default. `residency_policy.resolve` is the one reader: the saved value, else the default, clamped
to its range, with the pairs kept in order, memoized for up to 30 seconds per process, and never
raising. When the row cannot be read it returns the last policy it read (the defaults would turn
eviction back on where an administrator turned it off), or, with none yet, the defaults with
eviction off; loads go on.

| Value | Environment default | Default | Range | What it is |
|---|---|---|---|---|
| `evictionEnabled` | `GRAPHVER_EVICTION_ENABLED` | on | on, off | Whether the loop evicts at all |
| `defaultResidency` | — | `standard` | `always`, `standard`, `coldline` | The class a new graph gets (read only with residency on) |
| `standardIdleSecs` | `GRAPHVER_STANDARD_IDLE_SECS` | 604 800 (7 days) | 3 600 – 31 536 000 (1 hour – 365 days) | How long a Standard graph stays unread before it goes |
| `coldlineIdleSecs` | `GRAPHVER_COLDLINE_IDLE_SECS` | 3 600 (1 hour) | 300 – 604 800 (5 minutes – 7 days), and no longer than the Standard idle time | How long a Coldline graph stays unread before it goes |
| `highWaterPct` | `GRAPHVER_MASTER_HIGH_WATER_PCT` | 80 | 50 – 95 | The start mark: pressure eviction starts at this share of a master's memory, and a load must fit under it |
| `lowWaterPct` | `GRAPHVER_MASTER_LOW_WATER_PCT` | 70 | 30 – 90, and at least 5 under the start mark | The stop mark: pressure eviction stops here |
| `loadMarginPct` | `GRAPHVER_LOAD_MARGIN_PCT` | 130 (×1.3) | 100 – 300 | The headroom a load needs over its estimate |
| `bytesPerEntity` | `GRAPHVER_BYTES_PER_ENTITY` | 550 | 100 – 10 000 | The estimate per node or edge, for a graph never measured |
| `coldlineCanvasLoadAbove` | `GRAPHVER_COLDLINE_CANVAS_LOAD_ABOVE` | 500 000 | 0 – 100 000 000 | A Coldline graph with more entities than this loads on a canvas read |
| `capacityIntervalSecs` | `GRAPHVER_CAPACITY_SECS` | 60 | 15 – 600 | How often the loop runs |

Routes, under `/api/v1/admin/versioning`, `system:admin` only and never with an API key:

- `GET /residency-policy` → `{enabled, values: {<value>: {saved, default, effective}}, ranges:
  {<value>: {min, max}}, updatedBy, updatedAt}`. `enabled` is the deploy flag. `updatedBy` and
  `updatedAt` are the policy's own (`gv_policy_updated_by`, `gv_policy_updated_at`): who last
  changed a residency value, and when.
- `PUT /residency-policy` — partial: only the values named change, and `-1` clears one to its
  default. A value out of its range, of the wrong kind or unknown, or contradicting another
  (Coldline idle longer than Standard idle; a stop mark less than 5 points under the start mark) is
  **422** `invalid_residency_policy` `{field, message}`, and nothing is saved. Recorded as
  `platform.residency_policy.updated` with each changed value's before and after. The process that
  saved applies it at once; the others within 30 seconds.
- `POST /residency-policy/preview` — the planner on proposed values (as for `PUT`, refused as `PUT`
  refuses them) against current memory and graphs, acting on nothing: `{values, masters: [{endpoint,
  usedBytes, maxBytes, reservedBytes, usedAfterBytes, hold, evictions: [{graphId, dataSourceId,
  label, bytes, reason}], loads: [...], waits: [{..., reason, shortfallBytes}]}], evictions,
  evictedBytes, loads}`. Every master of each provider holding a versioned graph is listed.

## 12. Read tracking and the read lease

`ContextEngine` calls `residency.on_read` once for each engine it builds over a versioned graph,
before it reads the graph's watermark. Live exports and the v2 router build their engine with the
person's viewer, as the canvas does; a native query holds its graph (`residency.hold`) before it
reads the watermark. Only a person's read counts — a background job builds its engine with no
viewer — and it counts for the graph whose key serves it: a fork's root, for a fork, whose key a fork
reads through.

- **The read lease, first.** The read holds the graph's read lease (the one the neighbors route
  takes) for `GRAPHVER_TRACE_LEASE_TTL_SECS` (120 seconds) before it reads anything: refreshed at most
  every 30 seconds per graph per process, INCR and EXPIRE in one round trip, and never waited on
  for more than about 100 ms. The evictor checks the lease before its compare-and-swap and again
  after it commits: either it sees the read's lease and puts the graph back, or the read sees the
  evicted state and is served from Postgres. What this does not cover: a lease the broker did not
  take within 100 ms (that read goes on without one), and a lease lost from the broker before it
  lapses.
- **Last read.** Each process notes the graphs read in memory and writes them once a minute: one
  UPDATE of `last_read_at`, which never moves a read back and passes over a row another process's
  flush holds (rows in id order, `SKIP LOCKED`: two flushes never wait on each other). A process
  that stops loses at most a minute of reads.
- **A read of a graph out of FalkorDB** is served from Postgres and asks for its load (§10), never
  waiting on the broker more than about 100 ms. For the rest of the request the graph is known to be
  out (`residency.READING`), so deep search and node degrees answer **503** `graph_loading`
  `{retryAfter, message}` with `Retry-After`, and ask for the load; native queries answer **503**
  with code `graph_loading`.
- **Cost.** A person's read of a resident graph costs one small read of the graph's state (measured:
  1.4 ms here) and, at most every 30 seconds per graph per process, one broker round trip.

## 13. Health and metrics

- **The watermark** (`GET …/watermark`, and every route that returns one) carries `residency` (the
  class), `residencyState` (`resident`, `evicted`, `rehydrating` or `waiting_capacity`),
  `evictedReason`, `lastReadAt`, `sizeBytes` and, while it is being loaded, `rehydratingSince`. A
  graph being loaded reads `fresh: false` and `readRoute.main: "postgres"` until its load is done.
- **The fleet inventory** (`GET /api/v1/admin/versioning/graphs`) carries the same six on every row,
  and its `status` filter takes `rehydrating` and `waiting_capacity`.
- **The projection-lag probe** counts `rehydrating` and `waitingCapacity`, and leaves evicted
  graphs out of its worst list: they lag by design. The stats probe does not read a graph out of
  FalkorDB (it would record 0 nodes and 0 edges).
- **Metrics** (the projection lane, on the existing metrics backend; the standalone versioning
  worker serves them on `METRICS_PORT` when `METRICS_ENABLED`, and a port it cannot bind never stops
  it):

| Metric | Labels | What |
|---|---|---|
| `versioning_residency_master_used_bytes`, `versioning_residency_master_max_bytes` | `master` | Each master's used memory and `maxmemory`, as the last pass read them (every master of each provider) |
| `versioning_residency_graphs` | `residency`, `state` | Graphs per class and state |
| `versioning_residency_evictions_total` | `reason` | Evictions |
| `versioning_residency_loads_total` | `outcome` (`started`, `completed`) | Loads |
| `versioning_residency_load_waits_total` | `reason` (`capacity`, `queued`, `unmeasured`, `unsized`, or the master's hold: `fork`, `loading`, `memory`) | Loads that began to wait for room |
| `versioning_residency_oldest_rehydrating_seconds` | — | How long the oldest load in flight has been under way (0: none) — a load has no timeout |

## 14. Turning residency on

- **Two migrations.** `20261030_1300_gv_ps_residency` (graphver: the residency columns, their
  checks, and the two statuses) follows `20261030_1200_ds_fork_of`; with a separate
  `GRAPHVER_DB_URL` the versioning worker adds it on start. `20261030_1400_residency_policy`
  (management: the policy's values and who changed them last, all unset) follows it. Both wait at
  most five seconds for their locks and can be run again. Downgrading the first turns a graph
  waiting for room or being loaded into an evicted one at watermark 0, which the code before reseeds.
- **The flag, `GRAPHVER_RESIDENCY_ENABLED`**, is off by default: nothing changes until it is set
  (creating a graph does not even read the policy). Set it once every pod runs this release, on the
  API pods first and then on the versioning workers, so reads are recorded and leased before
  anything is evicted.
- **A mixed rollout**, while pods disagree: a worker without the flag runs the count budget (which
  never evicts an Always graph) and its poll reseeds every evicted and waiting graph at once,
  unadmitted; API pods without it record no reads and take no leases, so a worker with it idle-evicts
  graphs people are reading and nothing asks for them back, and their `project_now` reseeds without
  the gate. Keep the window short, in the order above.
- **With it on, the per-provider count budget is not used**: `GRAPHVER_FALKOR_MAX_RESIDENT`,
  `GRAPHVER_FALKOR_BUDGETS` and a provider's `falkorMaxResident` stop evicting; the capacity loop
  replaces that loop.
- **Give every master a `maxmemory`.** Without one there is no pressure to measure: idle eviction
  still runs, and loads are admitted without a limit.
- **Turning it off again** reseeds every evicted and waiting graph at once, without admission: make
  room first (Always on the graphs that must stay, or more memory), or it fills every master up to
  its `maxmemory`. A graph whose load had published its seed keeps reading `rehydrating` until its
  next projection pass, while its reads come from FalkorDB.

## 15. Placement: each new key on the master with the most room

A platform key's hash tag alone decides its cluster slot, so a new key is placed by choosing its
tag: on the master with the most room under its start mark after what is held there (the
aggregation governor's reservations, and the loads and full projections in flight), among those
free to take a load, the first of the graph's platform keys (`gvp_<gid>{<tag>.<n>}`, `n` rising)
that exists nowhere on the provider, is none of its retired keys, and hashes to that master's slots
(`keymigrate.placed_key`, at most 4096 tries; one master: simply the first free key). The master's
slots come from the client's slot map (`shard_capacity.master_slots`).

- **A reload after eviction** goes onto a fresh key placed this way (§10), whatever master its old
  key was on. A graph whose rollups live in a dedicated graph keeps its key.
- **A move without a key**, with residency on, is placed the same way (`residency.place_key`), and
  records the master in its `shard_map`; it is admission-checked on that master first (409
  `capacity_insufficient`), since the old key stands until the new one has caught up. A move with a
  key is checked on the master that key hashes to. A graph out of FalkorDB only changes its pin.
- **Adopt** (§16) places the platform key the same way.
- **A graph's first key** is not placed: a blank model's key is its data source's name
  (`blank_<ds>`, or the one its creator chose), and a converted source's is the customer's own until
  it is adopted. The first reload after an eviction places it.
- **Customer keys never move**, except by Adopt.

## 16. Adopt: a customer's key onto a platform key

`POST /api/v1/admin/versioning/graphs/{gid}/adopt` (system administrators; Admin → Infrastructure →
Versioned graphs → **Adopt…**): a graph that projects into the customer's own FalkorDB key moves
onto a fresh platform key on the same provider, by the reseed move of doc 14 §6 — seeded from
Postgres a page at a time, Postgres serving its reads until the new key catches up. From then the
platform owns the key (`owns_falkor_graph` true) and the graph's residency class applies: it can be
evicted, loaded and moved like any platform copy.

- **The customer's key is left exactly as it was**: never written, dropped, renamed or relabelled,
  and not added to `retired_keys`. Its external-changes flag (`external_drift`) is cleared, and kept
  in the audit record: the graph reads its own copy now, so **changes other tools keep making to the
  customer's key no longer show, and Bring into history no longer sees them**. The confirmation says
  so before anything changes. Bring in what the key holds first if it should be kept.
- With residency on, the key is placed on the provider's master with the most room and the seed is
  admission-checked first (409 `capacity_insufficient`); off, it is the first free platform key.
- Refused as a move is: an unpinned graph (409 `projection_not_adopted` `unpinned`), a key other
  data sources read (409 `projection_not_adopted` `shared`: they would go on reading a key nobody
  writes), a dedicated rollup graph (422 `projection_mode_unsupported`), a running rollup job (409
  `job_active`), a provider whose keys cannot be listed (503 `provider_unreachable`), version control
  still being enabled (409 `bootstrapping`); and a graph already on a platform key (409
  `already_adopted`), a fork (409 `not_for_forks`), an unknown graph (404).
- Recorded as `platform.versioning.projection_adopted` `{graphId, workspaceId, dataSourceId, from,
  to, externalDrift}`. The reseed is scheduled at once.

## 17. The admin screens

Admin → Infrastructure → **Versioned graphs** (system administrators; it opens from the projection
panel's **All versioned graphs**):

- **Each row** shows the graph's class and whether it is in memory as chips — **In memory**,
  **Evicted**, **Loading** (with when it started), **Waiting for room** — and, for a graph that is not
  a fork, a class selector (Always may be refused when its master has no room: the server's message
  shows on the row), **Load now** on a graph out of FalkorDB, and **Adopt…** on a customer's key,
  behind a confirmation that says what changes (§16). The state filter takes **Loading** and
  **Waiting for room**.
- **Residency & eviction** opens the policy card: every value with the one in force, its default and
  its unit, **Reset** (saves `-1`), each master's memory as a gauge with the start and stop marks
  drawn on it, who changed the values last and when, and a note when residency is off on the
  deployment. **Save** asks the planner first and confirms with what the next pass would do ("Saving
  evicts 12 graphs, 9.4 GB, on master 10.0.0.2:6379"); a value the server refuses shows next to the
  field it names.
- **The projection panel** counts graphs **loading** and **waiting for room**.

On the workspace side, a data source's **Versioning** tab (and the Data health tab) shows the graph's
class and whether it is in memory, read-only, and reads a graph being loaded or waiting for room as
such — never as "versions behind" — polling until it is back.
