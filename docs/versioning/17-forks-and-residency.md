# 17 · Forks You Can Work In, and Residency

> **Audience & scope:** engineers and reviewers of the fork work. What a fork is now that it is a
> data source of its own, how its settings follow its parent's, how it moves through the trash and
> between workspaces with its parent, how it reads through its root's store with its own changes
> laid over it, how it reads its parent commit by commit, how it takes its parent's newer changes
> (Update from parent), and how its review merges once it has. The fork engine itself — copy-on-write
> reads, pull requests, merge — is in
> [03 · Branching, Commits & Merge](03-branching-commits-merge.md); the routes and their refusals are
> in [06 · API Reference](06-api-reference.md); every behaviour change is in the
> [CHANGELOG](../../CHANGELOG.md).

**Checked against the code on 2026-11-01 (`000a2ba64`).**

**TL;DR.** Forking a graph now makes a data source as well as a graph: the fork's own row in
`workspace_data_sources`, in its parent's workspace and on its parent's provider. Views, the canvas
and every data-source read reach the fork by that id. Its governing settings are its parent's and
stay so. It goes to the trash, comes back and is purged with its graph, and moves with its parent.
It never has a FalkorDB graph of its own: it reads its root's published store with its own changes
laid over it, as a draft reads main's, so a fork costs FalkorDB nothing. Each of its commits records
which parent commit it reads, so a fork takes its parent's newer work — Update from parent, one
commit — without rewriting its own history; what both changed is merged there, conflicts and all.
Its review then merges only up to date with its parent: a copy of its own changes, with nothing
left to resolve. Either runs as a job when it is large.

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
`label`, and how far a live one is from the graph (§7). The workspace's data-source list leaves
forks out unless asked (`GET /api/v1/admin/workspaces/{ws}/data-sources?includeForks=true`), and so
do the data-source lists embedded in workspace answers, the workspace's default source and its
last-source count: a fork is reached through its graph, not picked as a workspace's source. The trash
never lists one: a fork comes back with its graph (`POST …/graphs/{fork}/restore`).

## 2. Reads: through its root's store, with its changes over it

A fork's `main` is read as a draft is: through a store with a patch set laid over it
(`DraftOverlayProvider`). The store is its **root's**, the graph up `fork_parent_graph_id` that is
no fork — a fork of a fork reads the same one:

- the root's own FalkorDB provider, which `ContextEngine` builds from the root's data source, while
  the root's projection holds its head in the key it publishes;
- otherwise the root's Postgres reader (`VersionedBranchProvider` on the root's `main`): a root
  still catching up, evicted or in the trash, or whose provider cannot be built. The reads are the
  same, only slower.

Ontology and node identity still come from the fork's own row (its parent's settings, §3), and who
may read is the fork's to decide: the root's store is read on its behalf.

**The patch set** (`branch_overlay_delta` on a fork's `main`) describes the fork's value at its
head against the root's at the root's head, for every entity either side changed since they parted:
the fork's own changes, each fork between it and the root up to the base the level below reads it
at, and the root's changes since the outermost base (§5). It is bounded by those changes, never by
the graph:

| The entity at the fork's head | In the patch set |
|---|---|
| Live, and not at the root's head | Created |
| Live, with another value than the root's | Modified: the fork's value |
| Gone, and live at the root's head | Removed |
| The root's value | Nothing: the root's store serves it |

**Lazy.** The patch set is built from content hashes and version-row columns alone. A read loads the
fork's value of just what it serves, for that request (`overlay_payloads`, which reads through the
layers: the fork's own row, or its parent's at the base): a page of what the root has costs a page
of payloads, however much the fork changed. A listing serves the nodes the fork created that it
lists on its first page, all of them, as a draft's does (`compose_page`), so a fork that created
many nodes at its top level, or a listing with no filter, loads each of those on every request
([09](09-scale-limits-and-roadmap.md) §4.1).

**Cached, then extended.** A process keeps a patch set per fork head, base and root head. When only
the root moved, the next one is the last one extended by what the root changed since, instead of
built again; a commit on the fork, or a new base, builds it again. A fork's delta keeps its patch
set for that, compact: each entry's fields as a tuple. The deltas kept, drafts' and forks', hold at
most `GRAPHVER_OVERLAY_CACHE_ENTRIES` entries together (default 400,000; the coldest go first, and
the newest is kept whatever its size). An entry holds about 1.2 KB (measured: 0.74 KB a draft's,
0.87 KB a fork's, before allocator slack and the chains a rollup read keeps), so the default holds
under 512 MB in each web process; an evicted delta is built again on its next read, 2 to 6 s for
50,000 to 145,000 entries.

**The ceiling.** A fork whose patch set would classify more than `GRAPHVER_FORK_REWIND_MAX`
entities (default 200,000, counted cheaply as an upper bound) is read from its own layered rows in
Postgres instead (`VersionedBranchProvider` on its `main`): the same data, slower, and search does
not reach it. The count is kept per version of the fork (its head, the base each layer reads, its
root's head), so a request at an unchanged version does not count again. Its fork-list item and
its watermark say `readsFrom: "postgres"`, its read route says Postgres, and the fork list
recommends an update from its parent where that would bring it back under (§7).

**A draft on a fork** overlays the fork's `main` in turn: its own patch set against the fork's
`main` at its branch point.

**Edges are counted where they run.** An edge the overlay holds as a value of its own — one the
fork or a draft changed, or the root changed after the base — is served with that value and counted
once, against where its store holds it now: an edge still between the same ends as the same type
moves no rollup, degree or child count; one whose ends moved counts where it runs now, and no
longer where the store has it. A flow the overlay added goes on the rollups under its ends'
containers on the overlay's own state; one it removed comes off where the store counted it. The
chains that place them are looked up once per patch set, in one batched walk, and kept with it:
a rollup read or a degree read with rollups runs no query per flow, however many the root changed.

**Listings follow the overlay's moves.** A child the overlay took away from a parent, its edge from
there removed or moved elsewhere, is not listed there though the store lists it; it is listed where
the overlay has it. A node the overlay took every parent edge from, and gave none, is at the top
level.

**What a request costs.** One session reads the fork's version, its ceiling decision, its root and
the root's store as its `projection_state` row says it is now, which is read every time: an eviction
moves the store without moving any seq the version holds. The overlay is handed the version, so its
first read does not read it again (21 statements a request, where the root's own takes 17). Its reads
of the root's FalkorDB store take that shard's admission slots, as the root's own do. Its cached
answers are keyed by the root store's version it read against (the root's committed and projected
seqs), so one built across a root publish is not served after it.

**Writes** are commits on the fork's drafts, or on its `main` for someone with publish, exactly as
on any versioned source. **The provider registry** hands out, for a fork's row, its root parent's
provider, read only (`fork_sources.ForkReadOnlyProvider`): every write through it is refused, so
nothing addressed to a fork reaches FalkorDB. A managed data source with no graph and no pin is
refused too, instead of reading the provider's default graph.

**Lookups find what a fork inherited.** The Postgres reads — a node by its URN, the listings, a
neighbourhood — take the fork's rows over its parent's, so an entity the fork never changed is
found by its URN. The neighbours route never reads FalkorDB for a fork.

**Search and native queries.** Deep search on a fork runs in the root's store, as a draft's runs in
main's: the fork's own changes are not in its answer, and its scope notes say so ("the fork's own
changes are not searchable yet: results come from the parent data source's published graph"; on a
draft on a fork, the draft's changes and the fork's). While the root's projection lags, or past the
ceiling, it answers **501**, as on a stale `main`. Native queries on a fork are **501**
`native_query_unavailable`: run them on the parent.

**What the overlay does not cover yet.**

- **Listings serve every node the fork created that they list**, on their first page, loading each
  for every request, as a draft's do ([09](09-scale-limits-and-roadmap.md) §4.1).
- **Each root commit costs CPU in each process reading the fork.** The patch set is extended from
  Postgres by the root's window, but each process indexes the whole of it again on its next read:
  1.3 to 2 s for 145,000 entries, holding the interpreter. Each fork commit builds it again (4.6 to
  6.2 s at that size).
- **A trace follows the root's later flows**, as a draft's follows main's: a node reached only
  through a flow the root added since the fork point stays in the fork's trace, and one reachable
  only through a flow the root deleted since does not appear.
- **A customer key's outside changes show on a fork**, as on a draft: entities another writer put
  in the root's key that no history holds (`externalDrift`) are read through.

**Stats.** A fork's counts are not polled: they are not its root's plus its patch set, and counting
it in Postgres would compose the whole graph. A stats read of a fork's data source answers
`status: "unavailable"` with `missing_fields: ["not_available_for_a_fork"]`, and its schema read
answers from the fork's ontology, with no refresh to follow.

What needs a data source's own graph store answers for a fork as follows:

| Request on a fork's data source | Answer |
|---|---|
| A write through the provider registry; an aggregation trigger; a dedicated rollup graph or projection mode; a projection move; bringing outside changes into history | **409** `fork_has_no_store` `{dataSourceId, message}`. Do it on the data source it was forked from |
| Making it the workspace's default (`POST …/data-sources/{ds}/set-primary`) | **409** `fork_not_primary`: a fork is never a workspace's default |
| A native query | **501** `native_query_unavailable`: native queries read a graph's own published store, and a fork reads through its parent |

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

**The views on a fork outlive its row.** When the row is deleted — its purge completes, the reaper
removes it, or its parent's permanent delete takes it — the views on it go to its nearest live
ancestor (its parent; up a fork of a fork), losing the fork's draft they were pinned to; one in the
trash stays there. With no ancestor left (a parent's permanent delete), they read the workspace's
default, as the parent's own views do.

**A parent's permanent delete** queues the purges of its trashed forks before its own, and deletes
their rows with its own. A live fork refuses it (**409** `live_forks`) before anything is queued —
also when the parent has nothing published: a fork reads through its parent's graph whatever it
holds, so the parent's purge waits for its forks too, and the reaper leaves it standing. A fork
whose parent's graph is gone all the same (an earlier release purged one under its forks) answers
**404**.

**The reaper keeps the two in step.** Each step above crosses two databases, so a crash can leave
the row behind its graph. On every pass, `Reaper.fork_rows`:

- gives a live fork graph with no row its row, made from its parent's as the fork route makes one,
  labelled `"<parent label> · Fork <last six of its id>"` — this is also how forks made before this
  release get theirs;
- tombstones a row whose graph is in the trash, and brings back one whose graph is live;
- deletes a row whose graph does not exist — never made, or purged — once it is ten minutes old
  (`ORPHAN_FORK_ROW_SECS`; a younger one may be a fork still being made), one at a time, a fork's
  fork before its fork: a row another fork's row still names is left for a later pass.

It puts each row right under the row's lock, from its graph as it is then, so a trash or a restore
in flight is only ever carried forward. A parent's row past its undo window waits while its forks'
rows still name it, and goes on the pass after theirs.

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

When a fork takes its parent's newer commits (Update from parent, §8), it adds a row instead of
rewriting anything, and every earlier commit of the fork still reads exactly what it read when it
was made: time travel to before an update reads the old base.

## 6. No FalkorDB copy

A fork used to be projected into `<parent key>__fork_<id>`: a second copy of its parent, built in one
pass, read by almost nothing, and kept for the fork's undo window after it was trashed. Now:

- **`fork_graph` pins no key.** The fork's `projection_state` row stays, naming none and owning none.
- **The projector never projects a fork,** whatever its row says: a pass skips it (`skipped:
  "fork"`), the poll loop leaves forks out, and neither a rebuild nor an eviction's reseed touches
  one. `POST …/projection/rebuild` on a fork answers its **409** for a graph with no target.
- **A fork's watermark is its root's** (`GET …/watermark`): the revisions, freshness and state of
  the store it reads through, with `readsThrough` naming the root's graph and no key, provider or
  ownership of its own. Its read route says where its reads come from: `falkordb` while the root's
  projection holds its head, `postgres` otherwise and past the ceiling (`readsFrom`), and the
  canvas chip says so ("far from its parent"). A fork whose parent's graph is gone answers **404**.
  The fleet inventory counts every fork as behind on nothing, one still pinned to an old copy
  included, and the liveness check leaves forks out.
- **Check sync** (`POST …/projection/reconcile`) has nothing of a fork's to compare:
  `skippedReason: "a fork reads through its parent's graph"`.

**Copies earlier releases made** stay, and every process running this release ignores them, until
`GRAPHVER_DROP_FORK_COPIES=true`. Then the versioning reaper drops each on its pass, by the purge's
rules for a key: ours, the name minted for the fork, the projector's marker in it, nothing else
projecting into it or reading it; and clears the fork's pin. A copy it keeps (shared, read by
another data source, or not ours) keeps its pin, and is asked about again on the next pass. It is
off by default because a pod still running an earlier release reads and projects them: turn it on
once every pod runs this one.

## 7. How far a fork is from its parent

Each live fork in `GET …/graphs/{gid}/forks` says:

| Field | Meaning |
|---|---|
| `ahead` | The entities it changed since its last merged review, or since its fork point |
| `behind` | The entities its parent changed that it has not taken in: the parent's window since the base the fork agrees with (§9: the base it reads, past its own merged reviews). 0 right after an update, or a merge with nothing else landed since |
| `updateRecommended` | What Update from parent can fix: `behind` reaches `GRAPHVER_FORK_REWIND_WARN` (default 50,000), or the fork's reads are past the ceiling and taking in its parent's changes — moving its base past its own merged reviews too — would bring them back under it (a fork of the root whose own changes alone fit). A fork of a fork past the ceiling on its parent's own history is not told to update: that would only add to it |
| `readsFrom` | `overlay`, or `postgres` past `GRAPHVER_FORK_REWIND_MAX` (§2) |
| `countsCapped` | A count stopped at the ceiling: it is at least that |

A fork in the trash says none of it (`null`).

## 8. Update from parent

`POST …/graphs/{fork}/update-from-parent` (`update_fork_from_parent`) takes the parent's changes
into the fork: the parent's `main` from the base the fork agrees with at its head (`B`) to the
parent's head (`P`, read once). At `P` already, it answers `upToDate` and writes nothing — unless
the fork reads its parent from below `B`, as it does right after its review merged: then it writes
a `sync_parent` commit with no rows that moves the base the fork reads to `B` (`upToDate: false`,
`wrote: 0`), so its reads stop counting its own merged changes twice toward the ceiling (§2). It
writes the fork's `main`, as a publish writes a graph's, so it takes `workspace:datasource:publish`.

**What it takes.** Most of the parent's changes need nothing written: the fork has no row of them,
so they show through once its base moves. What the fork has rows of and the parent changed in
`(B, P]` — found in SQL, the parent's window joined to the fork's heads, never the window's ids in
the process — goes through the 3-way merge: base the parent at `B`, ours the fork at its head,
theirs the parent at `P`. The parent at `B` is the last value both agreed on, after an earlier
update that merged the entity too. It writes only what the fork would read otherwise after the
move: merged values, and the cascades.

**Conflicts.** Fields both changed, differently, answer **409 `fork_update_conflicts`**
`{conflicts, seeds}`: a pull's conflicts (`entity_id`, `path`, `base`, `ours`, `theirs`, `kind`,
with `delete/modify` when one side deleted what the other changed), and the fork's own value of
each entity to resolve from. Nothing is written. Send it again with `resolutions`
(`{entityId: payload | null}`): each settles only the conflicting fields, as a pull's does, and
`null` deletes the entity. A resolution settles a conflict the update raised and nothing else: one
for an entity in no conflict answers **422 `resolutions_without_conflict`** `{ids}`, and nothing is
written.

**The gate.** What it writes — merged and resolved values, and the cascades — faces the gate every
write does, by the fork's ontology, judged against the fork as the update leaves it: nothing created
untyped, no duplicate, second parent or loop among what it writes, and under strict enforcement no
undeclared type. A refusal is **422 `ontology_violation`**, and nothing is written; a resolution
that brings back a node the fork deleted carries its type.

**Cascades, both ways.** A node the parent deleted in the window takes the fork's own edges on it
with it, or, when the fork changed the node, is a `delete/modify` conflict. An edge the parent drew
or pointed in the window at a node the fork deleted is deleted on the fork. The candidates come from
SQL over the window; each is judged at what the fork reads after the update. Containment
descendants are not cascaded: a column the fork made under a table the parent deleted stays, with
no parent, as a draft's pull leaves it — unless the fork's ontology says its type sits inside a
parent, which makes it a `structure` conflict (below).

**What would break the hierarchy.** Each side's changes can be sound alone and break the fork's
hierarchy together: the fork moved a column from T1 to T2, the parent moved it from T1 to T3, and
after the update it would sit in both. The update judges what it would leave the fork holding as
the gate judges a write: an edge it brings in — the parent's, drawn or pointed elsewhere, that the
fork reads new after the move, or a merged one — that duplicates an edge, gives a node a second
parent or closes a loop with the fork's own; and, under strict enforcement, a node it leaves outside
every parent its type needs. The candidates come from SQL, the window joined to the fork's edges (the
parent's edges into a node one of the fork's edges points at, and, while the fork has containment
links of its own, the parent's new containment links, which a loop may run through however far from
the fork's). Each is a conflict too, `kind: "structure"`, whole-entity (`path: []`), on the entity
the update brings in, with the gate's words as its `reason`: settled like the others, by a
resolution for it (`null` drops the parent's link on the fork). They are judged once the field
conflicts are settled, so they may come in a second answer.

**History.** One commit on the fork's `main`, kind `sync_parent`, message `Update from <the parent
data source's label>@P`, written with no rows too, so history shows the update; its `stats` are
the rows it wrote (create, update, delete, and the same as `rebased`) with `from_seq` and `to_seq`.
With it, in the same transaction, the fork's `fork_bases` row `(that commit, P)`: a read before it
keeps the old base. An update is not taken back by a commit of the fork's own: reverting a
`sync_parent` commit, or restoring the fork (or previewing a restore) to a commit before its latest
update, answers **409 `crosses_update`** — the fork read another parent commit then, and the rows a
revert or restore wrote would be the parent's older values as the fork's own, proposed back at its
next merge. Fork again from that point instead. A restore since the latest update works as on any
graph.

**Locks.** The fork's graph lock only. What it reads of the parent are rows at seqs up to `P`, and
those never change once `P` is the parent's head, so it waits on no publish of the parent and a
large update holds none up. A path that holds both graphs' locks takes the parent's first.

**Its review's approvals.** A `sync_parent` commit that wrote no rows is not content, as a pull that
rewrote nothing is not: the fork's open review keeps its approvals. One that wrote rows makes them
stale.

**Drafts on the fork** read as behind after the update (their base is the fork's head before it)
and take it with Pull latest, as any change to the fork's `main`.

**Large updates run as jobs.** The route counts first, in SQL: what the update would merge, the
edges its cascades may delete and the parent's edges its hierarchy check judges, each query
stopping past the threshold (`fork_update_size`), and an update it runs in the request takes the
parent's head it was sized at: a publish of the parent in between is the next update's. Past
`GRAPHVER_SYNC_PUBLISH_MAX_CHANGES` (20,000) it queues a `fork_update` job on the versioning
worker's transfer lane: **202** `{jobId, graphId, status}`, pinned to the parent's head now. It is
fenced as a publish job: the fork's lifecycle and move locks shared, the fork writable and still in
the workspace, and one update of a fork pending or running at a time (**409 `job_active`**). Poll
`GET …/graphs/{fork}/update-jobs/{jobId}`: what the route would have answered (`commitId`,
`parentSeq`, `wrote`, `upToDate`), or its refusal — conflicts fail the job, with them in `error` (past
100, the first 100, the seeds of their entities, and `total`); the caller resolves them and asks
again. Run again after its update landed, a job answers up to date, writes nothing, and runs again
what an update sets off (the fork's canvas reads and its views' "data updated").

The activity log records `workspace.versioning.fork_updated` `{forkParentGraphId, parentSeq,
wrote}` for an update that ran, or `{…, jobId}` when it was queued (the person's action; what the
job did is on the job).

**What it costs.** Measured with `backend/scripts/bench_fork_sync.py` on a root of 100,000 nodes and
100,000 edges: an update taking 100,000 parent changes, 1,000 of them changed by the fork too, is
sized in 0.05–0.08 s and runs in 0.25–0.35 s, writing those 1,000 rows, at a peak of 88 MB resident
(79 MB before it). Only what both changed is read into the process; the window is joined in SQL.

## 9. Merging a fork

**Up to date first.** A fork's review merges only when the fork is up to date with its parent, as a
draft publishes only up to date with `main`: both merge routes (`/pulls/{pr}/merge`,
`/merge-requests/{pr}/merge`) answer **409 `not_up_to_date`** `{reason: "parent_moved", behind,
graphId}`, "update from parent first", otherwise. The check is made under the parent's lock, of the
head the merge takes. A review refused so is not marked: it merges once the fork has updated.

**The base a fork agrees with** (`_fork_agreed_base`) is the base it reads, past each squash of its
own reviews that landed right after it. A review merged up to date wrote the fork's own values,
which the fork has already: so a fork that has just merged is up to date (nothing else landed), its
`behind` is 0, and its next update merges from after its own merge — what it merged is not its
parent's change for it to take, nor a conflict with what it changed since. It still reads its parent
from before its merge, its merged changes counted twice toward the ceiling, until an update moves
that base (§8); `updateRecommended` says so once that is what puts its reads past the ceiling.

**What a merge writes.** Update from parent settled conflicts on the fork's side, so the merge is a
copy, with nothing to resolve (`resolutions` is not used): the fork's own changes since its last
merged review — its rows in `(merge base, head]`, never the parent's window — each its value at the
head the merge takes against the parent's, every difference a change. The merge base is the head
its last merged review took (`merged_source_seq`), else the fork point; an update does not move it,
so an edit made before an update is still proposed after it. `_squash_fork` plans it from content
hashes and copies the rows from the fork's version rows inside Postgres (the fork is the source
graph), in the narrow squash's order and with its gates: the gate every write shares (the review's
own view of what it writes), the parent's ontology (a strict one refuses; a permissive one's
findings are kept on the review, the first 100 and their total), the reviewers' approvals before the
first row. Past `GRAPHVER_SQUASH_PAGED_ABOVE` (200,000) changes it goes `GRAPHVER_SQUASH_PAGE`
(20,000) at a time, in the same one commit. The preview, diff and summary show the same changes,
against the parent at the base the fork agrees with, with no conflicts.

So the rules hold: a change taken from the parent is never proposed back (only the fork's rows are,
and a merged one differs only by the fork's part); a fork edit made before an update is still
proposed after it; a conflict settled in an update is not raised again at the merge; and updates and
merges interleaved converge — after each merge the parent is the fork at the head it took.

**Large reviews merge as jobs.** A review whose fork changed more than
`GRAPHVER_SYNC_PUBLISH_MAX_CHANGES` entities since its last merged review is merged by a `fork_merge`
job on the transfer lane, from either route: **202** `{jobId, graphId, status}` (`graphId`: the
parent; poll `GET …/graphs/{parent}/publish-jobs/{jobId}`). It is queued only approved and up to
date, under the parent's lifecycle and move locks (shared) and the review's row lock; it pins the
fork's head, and holds the review `merging`, so no other merge of it gets past (**409 `job_active`**)
until the job ends. Where the data source's policy has someone else merge, whoever opened the review
gets **403 `self_merge`** before anything is queued. The job merges the head it pinned, by the
parent's rules as they are when it runs, and its reviewers' approvals as they stand then: a content
commit on the fork after the job was queued makes them stale, as on any review, though the job
merges the head it pinned — it is refused (**409 `approval_required`**) for the reviewers to look
again. Run again after its merge landed, it answers with the review's merge; so too when its merge
is refused because a superseded attempt of it merged the review first. Refused (the parent moved
since, say), it fails with the route's answer and hands the review back at once (`approved`, or
`mergeable`); one whose job died is handed back by the versioning worker's reaper
(`release_merging`). While it is `merging` the review is neither closed nor given other reviewers
(**409 `job_active`**); the reviews inbox and lists show it as Merging, among those in progress, and
the overview counts it open. In history an update is "Update from parent".

**What it costs.** On the same bench, merging a review of 100,000 changes (renames, new columns in
tables, flow edits) as a job takes 18.8 s at a peak of 299 MB resident (98 MB before it); paged
(`GRAPHVER_SQUASH_PAGED_ABOVE` at 50,000, pages of 20,000), 18.7 s at 287 MB. Most of what the
merge holds is the parent commit's Merkle tree, built in memory up to `GRAPHVER_BOOTSTRAP_MERKLE_MAX`
(1,000,000) changes as a draft's paged publish builds it: with it left unset the paged merge peaks
at 159 MB, in 15.1 s.

## 10. Upgrading

- **The migration for Update from parent and merging.** `20261101_1000_gv_fork_sync` lets
  `commits.kind` hold `sync_parent`, `merge_requests.status` hold `merging`, and `jobs.job_type` hold
  `fork_update` and `fork_merge`. Each check is rebuilt once, while it lacks its value, waiting at
  most five seconds for its lock; it is safe to run again, and widen-only: the downgrade narrows
  nothing. A separate `GRAPHVER_DB_URL` gets the same from the worker's start.
- **A fork behind its parent no longer merges.** Its review answered with a 3-way merge before, and
  `merge_conflict` at the merge; now it answers **409 `not_up_to_date`** `{reason: "parent_moved"}`,
  and the conflicts surface at Update from parent. Clients that merge forks update them first, and
  handle **202** from a merge route for a large review.
- **A fork's review records no conflicts** (`status` is `mergeable` when it opens), and its merge
  ignores `resolutions`.
- **The migrations for bases and data sources.** `20261030_1100_gv_fork_bases` creates
  `graphver.fork_bases` and gives every
  existing fork its fork-point row. `20261030_1200_ds_fork_of` adds
  `workspace_data_sources.fork_of_data_source_id` (with its index) and `ck_ds_fork_no_key`. Both wait
  at most five seconds for their locks and are safe to run again. The second refuses to downgrade
  while fork rows exist: the code before it reads a data source that names no graph from the
  provider's default graph. Delete those rows first.
- **Existing forks** get their data source on the reaper's first pass after the upgrade, if their
  parent's data source still exists. A fork already in the trash gets none and is purged as before.
- **The data-source routes refuse fork rows** (`use_fork_endpoints`, `fork_settings_follow_parent`,
  `fork_has_no_store`, `fork_not_primary`): use the fork routes, and change settings on the parent.
- **Lists leave forks out** unless asked with `includeForks=true`; the trash always does. Every
  data-source answer carries `forkOf`.
- **Free the old fork copies' memory**: set `GRAPHVER_DROP_FORK_COPIES=true` once every pod runs this
  release (§6). Until then they stay, unread.
- **New settings**: `GRAPHVER_FORK_REWIND_MAX` (200,000) and `GRAPHVER_FORK_REWIND_WARN` (50,000)
  (§2, §7), and `GRAPHVER_OVERLAY_CACHE_ENTRIES` (400,000), which bounds the overlay deltas each
  process keeps, drafts' as well as forks', at about 1.2 KB an entry: under 512 MB a process. Lower
  it where a process has less to spare (§2).

## 11. Coming next

- **Residency.** Which graphs stay loaded in FalkorDB is decided per graph — always, standard
  (evicted when idle) or coldline (loaded only when a request needs it) — and by each FalkorDB
  master's free memory. Postgres stays the source of truth: an evicted graph reads from it until
  it is loaded again.
