# 17 · Forks You Can Work In, and Residency

> **Audience & scope:** engineers and reviewers of the fork work. What a fork is now that it is a
> data source of its own, how its settings follow its parent's, how it moves through the trash and
> between workspaces with its parent, and how a fork reads its parent commit by commit. Then
> residency (§8–§14): which graphs FalkorDB holds, by class and by each master's memory. The fork
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
- **Residency** is §8–§14 below. Still to come for it: adopting a customer's key onto a platform
  key, placing each new key on the master with the most free memory, and the admin screens.

## 8. Residency: which graphs FalkorDB holds

**Checked against the code on 2026-10-30 (`531869bc1`).**

FalkorDB holds a copy of each versioned graph's published `main` (doc 04); Postgres is the only
source of truth. Residency decides which copies FalkorDB keeps, per graph by a class and per
cluster master by memory. A graph evicted from FalkorDB loses nothing: its reads are served from
Postgres until it is loaded again.

| Class | Evicted | Loaded again |
|---|---|---|
| **Always** | Never | When it is not in FalkorDB (set to Always while evicted, or waiting for room), on every capacity pass until it fits |
| **Standard** (the default) | When unread for the Standard idle time (7 days), or earlier when its master is under memory pressure | On its next read |
| **Coldline** | When unread for the Coldline idle time (1 hour), and first under memory pressure | Only when a request needs FalkorDB (§10), or on a canvas read of a graph larger than the canvas-load threshold |

- **Only keys the platform minted are ever evicted** (`owns_falkor_graph`): a customer's own graph,
  which version control was enabled on, behaves as Always.
- **Forks are outside residency.** A fork has no key of its own to evict, load or count; its reads
  count for its root, whose key they read (§12), and the residency routes answer **409**
  `not_for_forks` for one.
- **Who sets the class.** System administrators only:
  `PUT /api/v1/admin/versioning/graphs/{gid}/residency {"class": "always" | "standard" | "coldline"}`.
  A new graph gets the policy's default class. Workspaces see the class and the state on the
  graph's watermark (§13).
- **The flag.** None of this applies unless the deployment sets `GRAPHVER_RESIDENCY_ENABLED`
  (§14). Off, eviction is the per-provider count budget, as before, and an evicted graph is reseeded
  by the projection poll within seconds.

`graphver.projection_state` holds each graph's `residency`, `last_read_at`, `evicted_reason`
(`idle_standard`, `idle_coldline`, `pressure`, or `admin`, which nothing writes yet),
`size_bytes` and `size_measured_at`. Its `status` gains `rehydrating` (a load in flight) and
`waiting_capacity` (a load its master has no room for yet).

## 9. The capacity loop

The projection lane runs one capacity pass every policy interval (60 seconds by default), under a
Postgres advisory lock so one worker leads; a pass another worker holds is skipped. A pass gathers,
asks a pure planner (`residency_plan.plan`, no I/O) and acts. The policy preview (§11) runs the
same planner on proposed values.

**What it reads.** Every live graph that is not a fork and has a key of its own; its key's master,
from the key's cluster slot and the provider client's slot map (a standalone or Sentinel instance
is one master); and for each such master, one `read_shard_memory` (used memory, `maxmemory`, and
whether it is forking for persistence or loading its dataset), the aggregation write governor's
reservations on it, and which graphs hold a read lease. A master that holds no versioned graph's
key is not read. A graph's size is its measured `size_bytes`, else its nodes plus edges (rollups
included, from its data source's statistics) times the bytes-per-entity estimate.

**Idle eviction.** A Standard graph unread for longer than the Standard idle time goes
(`idle_standard`), a Coldline graph unread for longer than the Coldline idle time
(`idle_coldline`). Its last read is `last_read_at`, else its last projection; a graph with neither
is never idle.

**Pressure eviction.** A master at or above the start mark (80 % of its `maxmemory`) evicts, in
order, the idle-longest Coldline graphs, then Standard graphs by oldest read, until its use once
they are gone is at or under the stop mark (70 %). Idle evictions in the same pass count toward
it. A master without `maxmemory` is never under pressure.

**Never evicted:** an Always graph, a key the platform did not mint, a graph with a read lease or a
pass in flight (any status but `idle`), and one that is not evictable at all (in the trash, at
genesis, or still having version control enabled). With automatic eviction off (`evictionEnabled`),
nothing is evicted; loads and admission go on.

**An eviction** goes through `CacheManager.evict`, which takes the graph's projection lock,
re-checks all of the above in its guarded UPDATE (an Always graph included, whatever the plan
said), asks whether anything else reads the key, drops it, and records the reason. The graph then
stays evicted: `project_graph` refuses to project or reseed an evicted graph, or one waiting for
room, so none of its four callers (the poll, `project_now`, `rebuild_now`, `ensure_rebuilt`) brings
it back; the poll does not select it; a rebuild asked for becomes a request for its load (§10). A
move of an evicted graph changes only its pin, and the move's catch-up asks for its load, which
seeds the new key once admitted. A fork is outside all this: one the count budget evicted (before
the flag was set, or on a pod without it) is reseeded by the poll as before.

**Measuring.** Each pass measures up to 16 resident keys that were never measured or were
projected since their last measurement, those it is about to evict first: `GRAPH.MEMORY USAGE`
(which includes the key's rollups), else, for a load the same worker started, how much its
master's used memory grew across the load.

## 10. Loading a graph again

**What asks for a load:**

| What | Classes |
|---|---|
| A person's read of the graph (§12) | Standard, Always |
| A canvas read of a graph with more entities than the canvas-load threshold (its statistics, else its last size over bytes per entity) | Coldline |
| A request only FalkorDB can answer — deep search, node degrees, a native query — which answers **503** `graph_loading` with `Retry-After` (the loop's interval) meanwhile | Any |
| Load now: `POST /api/v1/admin/versioning/graphs/{gid}/load` | Any |
| Setting the class to Always (§8, admission-checked first) | Always |
| An operator's rebuild of the graph (`POST …/projection/rebuild`) | Any |

A request is kept in the order it was first made (a sorted set on the broker). A broker that loses
it loses nothing durable: the next read asks again, a graph already waiting for room rejoins the
queue at its end, and so does an Always graph that is not in FalkorDB.

**Admission.** Each pass takes, per master, the first request: it starts when the graph's estimate
times the headroom (×1.3) fits under the master's start mark after what is held there — the
aggregation write governor's reservations, and the estimate times the headroom of each load and
full projection (a rebuild, a move's reseed, a first seed) in flight on it. Fitting under the start
mark rather than under `maxmemory` is the hysteresis: a load never puts its master under pressure,
so the next pass never evicts what it just loaded. One load per master at a time; none while the
master forks for persistence, loads its dataset, or cannot be read. A load that does not fit marks
the graph `waiting_capacity` (logged as a warning, counted), and the requests behind it wait too;
each pass tries again, in request order. Its reads stay on Postgres.

Always on a graph out of FalkorDB is checked the same way when it is set: **409**
`capacity_insufficient` `{master, shortfallBytes, message}` when its load would not fit, and
nothing changes; otherwise the class is set and its load asked for.

**The load.** An admitted load marks the graph `rehydrating` at watermark 0 (a status CAS: one
load per graph) and nudges the projection lane, whose next pass — single-flight under the graph's
projection lock — is the load: a full seed of its own key from Postgres, a page at a time above
`GRAPHVER_PROJECTION_RECONCILE_STREAMED_ABOVE` entities. The graph stays `rehydrating` through it,
and its watermark is not fresh, so its reads stay on Postgres even once the seed has published.
It serves reads only once its key also holds the summaries its readers need: a summaries build's
stamp, or none needed (no lineage in its ontology, its rollups in a dedicated key, no aggregation
wired in). The capacity loop checks on each pass and asks for the build once per watermark meanwhile.
Then the graph is `idle`, its eviction reason is cleared and its idle time starts again from the
load. A load that fails is retried by the poll after its backoff, still `rehydrating`.

## 11. The policy: every value

Every value is changed live by a system administrator, with no redeploy, and stored on
`platform_settings` (migration `20261030_1400_residency_policy`). Unset is the environment's
default. `residency_policy.resolve` is the one reader: the saved value, else the default, clamped
to its range, with the pairs kept in order, memoized for up to 30 seconds per process, and never
raising (a row it cannot read gives the defaults).

| Value | Environment default | Default | Range | What it is |
|---|---|---|---|---|
| `evictionEnabled` | `GRAPHVER_EVICTION_ENABLED` | on | on, off | Whether the loop evicts at all |
| `defaultResidency` | — | `standard` | `always`, `standard`, `coldline` | The class a new graph gets |
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
  `updatedAt` are the platform settings row's, which every platform setting shares.
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
  evictedBytes, loads}`.

## 12. Read tracking and the read lease

`ContextEngine` calls `residency.on_read` once for each engine it builds over a versioned graph.
Only a person's read counts — a background job builds its engine with no viewer — and it counts
for the graph whose key serves it: a fork's root, for a fork, whose key a fork reads through.

- **Last read.** Each process notes the graphs read in memory and writes them once a minute: one
  UPDATE of `last_read_at`, which never moves a read back. A process that stops loses at most a
  minute of reads.
- **The read lease.** A read FalkorDB serves takes the graph's read lease (the one the neighbors
  route takes) for `GRAPHVER_TRACE_LEASE_TTL_SECS` (120 seconds, the longest a trace may run): the
  loop and `CacheManager.evict` skip a leased graph, so a graph mid-read is never evicted. The
  engine has no end of request to release it at; the lease lapses 120 seconds after the graph's
  last such read.
- **A read of a graph out of FalkorDB** is served from Postgres and asks for its load (§10). For the
  rest of the request the graph is known to be out (`residency.READING`), so deep search and node
  degrees answer **503** `graph_loading` `{retryAfter, message}` with `Retry-After`, and ask for the
  load; native queries answer **503** with code `graph_loading`.

## 13. Health and metrics

- **The watermark** (`GET …/watermark`, and every route that returns one) carries `residency` (the
  class), `residencyState` (`resident`, `evicted`, `rehydrating` or `waiting_capacity`),
  `evictedReason`, `lastReadAt` and `sizeBytes`. A graph being loaded reads `fresh: false` and
  `readRoute.main: "postgres"` until its load is done.
- **The fleet inventory** (`GET /api/v1/admin/versioning/graphs`) carries the same five on every
  row, and its `status` filter takes `rehydrating` and `waiting_capacity`.
- **The projection-lag probe** counts `rehydrating` and `waitingCapacity`, and leaves evicted
  graphs out of its worst list: they lag by design.
- **Metrics** (the projection lane, on the existing metrics backend; the standalone versioning
  worker serves them on `METRICS_PORT` when `METRICS_ENABLED`):

| Metric | Labels | What |
|---|---|---|
| `versioning_residency_master_used_bytes`, `versioning_residency_master_max_bytes` | `master` | Each master's used memory and `maxmemory`, as the last pass read them |
| `versioning_residency_graphs` | `residency`, `state` | Graphs per class and state |
| `versioning_residency_evictions_total` | `reason` | Evictions |
| `versioning_residency_loads_total` | `outcome` (`started`, `completed`) | Loads |
| `versioning_residency_load_waits_total` | `reason` (`capacity`, `queued`, `unmeasured`, or the master's hold: `fork`, `loading`, `memory`) | Loads that began to wait for room |

## 14. Turning residency on

- **Two migrations.** `20261030_1300_gv_ps_residency` (graphver: the residency columns, their
  checks, and the two statuses) follows `20261030_1200_ds_fork_of`; with a separate
  `GRAPHVER_DB_URL` the versioning worker adds it on start. `20261030_1400_residency_policy`
  (management: the policy's values, all unset) follows it. Both wait at most five seconds for their
  locks and can be run again. Downgrading the first turns a graph waiting for room or being loaded
  into an evicted one at watermark 0, which the code before reseeds.
- **The flag, `GRAPHVER_RESIDENCY_ENABLED`**, is off by default: nothing changes until it is set. Set
  it on every API and versioning worker pod at once, and only once all of them run this release: a
  pod without it reseeds an evicted graph within seconds and loads without admission.
- **With it on, the per-provider count budget is not used**: `GRAPHVER_FALKOR_MAX_RESIDENT`,
  `GRAPHVER_FALKOR_BUDGETS` and a provider's `falkorMaxResident` stop evicting; the capacity loop
  replaces that loop.
- **Give every master a `maxmemory`.** Without one there is no pressure to measure: idle eviction
  still runs, and loads are admitted without a limit.
- **Turning it off again** brings everything back: the poll reseeds every evicted graph, as before.
