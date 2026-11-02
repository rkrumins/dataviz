# 17 · Forks You Can Work In, and Residency

> **Audience & scope:** engineers and reviewers of the fork work. What a fork is now that it is a
> data source of its own, how its settings follow its parent's, how it moves through the trash and
> between workspaces with its parent, how it reads through its root's store with its own changes
> laid over it, how it reads its parent commit by commit, how it takes its parent's newer changes
> (Update from parent), and how its review merges once it has. Then residency (§10–§19): which
> graphs FalkorDB holds, by class and by each master's memory, where a new key goes, adopting a
> customer's key, and the admin screens. The fork engine itself — copy-on-write reads, pull
> requests, merge — is in [03 · Branching, Commits & Merge](03-branching-commits-merge.md); the
> routes and their refusals are in [06 · API Reference](06-api-reference.md); every behaviour
> change is in the
> [CHANGELOG](../../CHANGELOG.md).

**Checked against the code: §1–§9 on 2026-11-01 at `000a2ba64`, §10–§19 on 2026-11-02 at
`c29f05f08`.**

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

## Turning forks on

Forks are **off** on a new deployment and after an upgrade to this release. A system administrator
turns them on under **Admin → Features → Forks** (`forksEnabled`, in Lineage beside Version control,
which it needs); only a system administrator can change a switch there. It is a preview: Update from
parent (§8) is here, and the screens to work in a fork come next.

While it is off nothing new happens in a fork, and no parent graph is touched. Making a fork, any
change to a fork's graph or its drafts (opening, saving, checkpointing, publishing and pulling a
draft, writing its `main`, importing, reverting, restoring to a commit, and Update from parent) and
its reviews (opening, approving, editing, merging) answer **403** `feature_disabled`: "Forks are
turned off for this deployment. An administrator can turn them on under Admin → Features." So does
the job a large publish, update or merge on a fork runs as, when it runs after forks were turned
off: it fails with that answer, and a merge's review is handed back. What stays open:

- listing a graph's forks, and reading a fork: its data, its views and canvas, its history, and how
  its update and merge jobs went (`…/update-jobs/{jobId}`, `…/publish-jobs/{jobId}`);
- moving a fork to the trash and back, closing its review (a fork with a live one can't go to the
  trash), exporting and freezing it;
- the purge, the reaper, the backfill and every other background job, and the admin views.

Nothing is deleted: turned back on, every fork is as it was.

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

## Upgrading forks

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
- **Forks are off** until a system administrator turns them on ([Turning forks on](#turning-forks-on)).
  Until then existing forks stay readable and go to the trash and back, and take no change.
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

## Coming next for forks

- **The screens to work in a fork.** Forking a graph, seeing how far a fork is from its parent,
  updating it from its parent and proposing it back, from the data source's Versioning tab and the
  fork's own pages. Until then they are the routes' ([06](06-api-reference.md)).

## 10. Residency: which graphs FalkorDB holds

FalkorDB holds a copy of each versioned graph's published `main` (doc 04); Postgres is the only
source of truth. Residency decides which copies FalkorDB keeps, per graph by a class and per
cluster master by memory. A graph evicted from FalkorDB loses nothing: its reads are served from
Postgres until it is loaded again.

| Class | Evicted | Loaded again |
|---|---|---|
| **Always** | Never | When it is not in FalkorDB (set to Always while evicted, its key lost, or waiting for room), queued by the next capacity pass until it fits |
| **Standard** (the default) | When unread for the Standard idle time (7 days), or earlier when its master is under memory pressure | On its next read |
| **Coldline** | When unread for the Coldline idle time (1 hour), and first under memory pressure | Only when a request needs FalkorDB (§12), or on a canvas read of a graph larger than the canvas-load threshold |

- **The idle clock starts when residency is turned on.** Reads are not noted while it is off, so
  when the capacity leader starts the grace period after the switch is turned on (§16) it sets every
  graph's `last_read_at` to now: each graph's idle time starts from that moment, however long ago it
  was published or last read. A graph with no read on record is never idle: each pass starts the
  clock of up to 1000 such graphs, so a new graph's starts from its first pass.
- **Only keys the platform minted are ever evicted** (`owns_falkor_graph`): a customer's own graph,
  which version control was enabled on, behaves as Always until it is adopted (§18).
- **Forks are outside residency.** A fork has no key (§6): nothing of its own to evict, load or
  count, and no class (`residency` is null on its watermark, and the fleet inventory's fork rows
  carry no residency). It reads through its root's store (§2), so its reads count for its root, hold
  the root's read lease and ask for the root's load (§14); while the root is out of FalkorDB, or
  being loaded, the fork reads the root's Postgres, and its watermark shows the root's state. A
  fork past the ceiling (§2) reads its own rows and nothing of its root's: its reads hold nothing,
  count for nothing and ask for no load, and its deep search is its own **501**. The residency
  routes answer **409** `not_for_forks` for one.
- **Who sets the class.** System administrators only, on Admin → Infrastructure → Versioned graphs
  (§19) or `PUT /api/v1/admin/versioning/graphs/{gid}/residency {"class": "always" | "standard" |
  "coldline"}`. A new graph gets the policy's default class. Workspaces see the class and the state
  on the graph's watermark and its Versioning tab.
- **The switch.** None of this applies until a system administrator turns on **Graph residency**
  under Admin → Features (§16). Off, every graph stays loaded: nothing is evicted, and a graph still
  out of FalkorDB is brought back through admission as memory allows, reading from Postgres until it
  is.

`graphver.projection_state` holds each graph's `residency`, `last_read_at`, `evicted_reason`
(`idle_standard`, `idle_coldline`, `pressure`, `lost` when its master lost the key, `load_stalled`
when its load's ontology could not be read for more than 10 passes (§12), or `admin`, which nothing
writes yet), `size_bytes`, `size_measured_at` and `rehydrating_since`. Its `status` gains
`rehydrating` (a load in flight) and `waiting_capacity` (a load no master has room for yet).

## 11. The capacity loop

The projection lane runs one capacity pass every policy interval (60 seconds by default), under a
Postgres advisory lock so one worker leads; a pass another worker holds is skipped. A pass first
reads the Graph residency switch from the feature store (§16): unreadable, it does nothing; in the
grace period after it was turned on, and while it is off, it evicts nothing; off with nothing left
out of FalkorDB, it idles. Then it starts idle clocks, gathers, asks a pure planner
(`residency_plan.plan`, no I/O) and acts. The policy preview (§13) and admission checks run the
same planner.

**What it reads.** Every live graph that is not a fork and has a key of its own; every master of
each of their providers' topologies, from the client's slot map (a standalone or Sentinel instance
is one master) — not only those holding a versioned graph's key, since the one with the most room
often holds none; for each master, its used memory, `maxmemory` and whether it is forking for
persistence or loading its dataset, and the aggregation write governor's reservations on it; which
graphs hold a read lease (one the broker cannot answer for counts as held: an outage there evicts
nothing and fails no pass; each read waits at most about 100 ms, and once one goes unanswered the
pass asks no more, counting the rest as held); and, in batched reads of the management database,
which keys another data source or a catalog entry reads and which data sources have a rollup job
pending or running.

**Sizes.** A graph's size is its measured `size_bytes`. A graph never measured has no size, not 0:
it is never a pressure candidate (its eviction would count as freeing nothing), and its load is
estimated from its nodes and edges at the main head as graphver counts them (rollups are not in
history), times the bytes-per-entity estimate — the data source's statistics only when graphver's
counts are missing. A load with neither waits (`unsized`). A pass that could not read the sizes plans
no pressure eviction, and makes no room for a load (§12).

**Idle eviction.** A Standard graph unread for longer than the Standard idle time goes
(`idle_standard`), a Coldline graph unread for longer than the Coldline idle time
(`idle_coldline`).

**Pressure eviction.** A master at or above the start mark (80 % of its `maxmemory`) evicts, in
order, the idle-longest Coldline graphs, then Standard graphs by oldest read, until its use once
they are gone is at or under the stop mark (70 %). Idle evictions in the same pass count toward
it. The plan keeps the next candidates in order: an eviction the evictor refuses frees nothing, and
the pass carries on down them until the stop mark is actually reached. A master without
`maxmemory` is never under pressure.

**Never evicted:** an Always graph (the evictor refuses one, whatever asks), a key the platform
did not mint, a key another data source or a catalog entry reads, a graph whose data source has a
rollup job pending or running (the job would write the dropped key back), a graph with a read lease
or a pass in flight (any status but `idle`), one that is not evictable at all (in the trash, at
genesis, or still having version control enabled), and anything on a master that cannot be read or
is loading its dataset (the drop would fail). With automatic eviction off (`evictionEnabled`),
nothing is evicted; loads and admission go on.

**An eviction** goes through `CacheManager.evict`, which takes the graph's projection lock,
re-checks all of the above (the rollup jobs and who reads the key in the management database, the
rest in its guarded UPDATE, which also compares the watermark it read: liveness lowers one without
the projection lock), drops the key and records the reason. After its compare-and-swap commits it
checks the read lease once more, and puts the graph back as it was when a read took it in between
(§14). A drop that fails puts the key in `retired_keys`, due at once, for the retire pass, which
drops it: the graph's own row still names the key, but out of FalkorDB nothing writes or reads it,
and the retire pass holds the graph's projection lock. The graph then stays evicted: `project_graph` refuses to project or reseed an evicted graph,
or one waiting for room, so none of its four callers (the poll, `project_now`, `rebuild_now`,
`ensure_rebuilt`) brings it back; the poll does not select it; a rebuild asked for becomes a request
for its load (§12).

**Measuring.** Each pass measures up to 16 resident keys that were never measured or were projected
since their last measurement, those it is about to evict first: `GRAPH.MEMORY USAGE`, else, for a
load the same worker started on a master that evicted nothing that pass, how much its used memory
grew. `GRAPH.MEMORY USAGE` answers in whole MiB, so a key under 1 MiB reads 0: that is recorded as
measured, with no size, and the graph keeps its estimate.

## 12. Loading a graph again

**What asks for a load:**

| What | Classes |
|---|---|
| A person's read of the graph (§14) | Standard, Always |
| A canvas read of a graph with more entities than the canvas-load threshold (its count, kept per head, else its last size over bytes per entity) | Coldline |
| A request only FalkorDB can answer — deep search, node degrees, a native query — which answers **503** `graph_loading` with `Retry-After` (the loop's interval) meanwhile; on a fork, deep search and node degrees ask for its root's load, as on the root (once the root is in, deep search runs in the root's store with its note); a native query on a fork is **501** at once, whatever its root's state, and asks for nothing | Any |
| Load now: `POST /api/v1/admin/versioning/graphs/{gid}/load` (recorded) | Any |
| Setting the class to Always (§10, its room checked first), and an Always graph out of FalkorDB on every pass | Always |
| An operator's rebuild of the graph (`POST …/projection/rebuild`), a move of it (§17), a watermark reset that caught its load in flight | Any |
| The first seed of a key the platform owns: the projector's first pass over a new graph past genesis takes its turn here (`waiting_capacity`) rather than writing the whole graph at once; its wait is logged and counted as any other | Any |
| With the switch off, the capacity pass itself: every graph out of FalkorDB, until none is left (§16) | Any |

A request is kept in the order it was first made (a sorted set on the broker). A broker that loses
it loses nothing durable: the next read asks again, and a graph waiting for room or an Always graph
out of FalkorDB is queued again — once, keeping its place.

**Admission.** Requests are taken per provider, in the order they were made. Each goes to the
master of its provider with the most room free to take a load (§17) and starts when its estimate
times the headroom (×1.3) fits under that master's start mark after what is held there — the
aggregation write governor's reservations, and the estimate times the headroom of each load and full
projection (a rebuild, a move's reseed, a first seed) in flight on it. Fitting under the start mark
rather than under `maxmemory` is the hysteresis: a load never puts its master under pressure, so the
next pass never evicts what it just loaded. One load per master at a time; none on a master that is
forking for persistence, loading its dataset, or cannot be read. A request that does not fit
waits (`waiting_capacity`, logged and counted), and each pass tries again; its reads stay on
Postgres. One that room alone would let in on a master that is forking, loading its dataset or
taking a load now waits for that master (`queued`, or its hold), and nothing is evicted for it. For
the first of a provider's that fits on neither, **room is made** on the master it would go to, where
it falls shortest: graphs as pressure eviction picks them (recorded as `pressure`), but never an
Always graph, a leased one, or one read within the Coldline idle time — it would only come straight
back. So they are Standard graphs, by oldest read: a Coldline graph unread for longer than the
Coldline idle time has gone already, idle. Only as many go as make the room it lacks beyond what the
pass frees there already; none when they could not, nor in a pass that could not read sizes. Once
room is made, that master is the load's for the pass — no later load, and no route's new key, goes
there (§17) — and the next pass, with the room made, it loads first. When none can be made (nothing
there may go, or the load is larger than the master can hold under its start mark), the load holds
nothing: later requests that fit go ahead, on that master too, and the next of the provider's that
fits on neither may have room made instead. Later requests that fit on another master go ahead
either way. Beside masters with a limit, a master without one takes a load only when none of them
is free (§17): a load short of room on the master with a limit it would go to waits there, and has
room made there, rather than going to the one without. The policy preview shows these evictions.

Always on a graph out of FalkorDB has its room checked when it is set, on its provider's roomiest
master (or its own, when its key stays): **409** `capacity_insufficient` `{master, shortfallBytes,
reason, message}` when its load would not fit there, and nothing changes; otherwise the class is set
and its load asked for. Only room is checked: setting the class writes nothing, so a master forking
or taking a load now does not refuse it, and the load waits its turn. `reason` says why: `capacity`
(`shortfallBytes` short under the start mark), `unsized` (its size is not known) or `unmeasured`
(the master could not be read), each also in the message. A move and an Adopt, which write, are also
refused when the master takes a load already (`busy`) or holds (`fork`, `loading`, …).

**The load.** An admitted load pins a fresh platform key placed on the chosen master (§17), marks
the graph `rehydrating` at watermark 0 with `rehydrating_since` (a compare-and-swap under the row's
lock: one load per graph), and nudges the projection lane, whose next pass — single-flight under the
graph's projection lock — is the load: a full seed of the key from Postgres, a page at a time above
`GRAPHVER_PROJECTION_RECONCILE_STREAMED_ABOVE` entities. The key the graph had goes to
`retired_keys`, for the retire pass to drop should its eviction not have. A graph whose rollups live
in a dedicated graph keeps its key — that graph is named from it — and its load first drops whatever
is in it (a rollup job may have written it back, summaries stamp and all). The graph stays
`rehydrating` through the seed, and its watermark is not fresh, so its reads stay on Postgres even
once the seed has published. It serves reads only once its key also holds the summaries its readers
need: a summaries build's stamp, or none needed (no lineage in its ontology, its rollups in a
dedicated key, no aggregation wired in). An ontology that cannot be read (the management database
down) is not "no lineage": the load waits for the next pass. One whose ontology stays unreadable for
more than 10 passes in a row goes back to evicted (`load_stalled`, with a warning) and its key is
dropped (left to the retire pass when the drop fails): it is not idle, so nothing else would free
that memory. The next read asks for its load again. Each load asks for the build under its own
idempotency key (`gv-rollup-rebuild:<graph>:<seq>:load<epoch>.<attempt>` — the aggregation service
answers a key it saw within the hour with the job it already ran), and asks again under a new one
every 10 passes it goes without the stamp. Then the graph is `idle`, its eviction reason and
`rehydrating_since` are cleared, and its idle time starts again from the load. A load that fails is
retried by the poll after its backoff, still `rehydrating`. A load has no timeout, but for one whose
ontology stays unreadable (above): its reads stay on Postgres, and how long the oldest one has been
under way is reported (§15).

**Nothing writes to FalkorDB without admission.** A graph out of FalkorDB comes back only through a
load, whatever the switch says, and no projection pass reseeds one on its own. With residency on —
or its switch unreadable — new writes are admitted too:

- A move of a graph out of FalkorDB (evicted, waiting, or being loaded), on or off, changes only its
  pin and asks for its load again; a load in flight is fenced off (the epoch) and the graph evicted again, to wait
  its turn. A move of a graph in FalkorDB is admission-checked on its new key's master (§17). A move
  decides which of the two it is under the capacity lock, from the graph's state read there: a load
  that finishes meanwhile cannot turn it into a full copy that was never admitted.
- The watermark reset after a restore reseeds in place what FalkorDB holds; a load in flight it
  would have reseeded goes back to the queue instead, on or off. A graph out of FalkorDB is at watermark 0, and
  the reset never touches it. The reset itself is not admitted, and stays so: it rewrites, in place,
  keys the restored server already holds — the room they take is taken already — and a disaster
  recovery must not wait behind loads for it.
- A first seed is admitted: the projector's first pass over a key the platform owns is a load
  (above), and a new data source seeded from a view package admits its copy on its key's master
  before its first window, under the capacity lock, and reserves the copy's estimate there (in the
  aggregation write governor's ledger, which every pass counts) until the copy is verified or fails
  for good; a stopped worker's lapses within two minutes. While that master is forking, loading its
  dataset, taking a load or cannot be read, the seed waits, asking again every capacity interval;
  when the copy would not fit, or its size is not known, the job stops, resumable with nothing
  written, saying which master and how much more it needs.
- Liveness finding a platform key its master lost (a restart without its data) marks the graph
  evicted (`lost`) rather than lowering it to 0 for the poll to reseed at once: its load is admitted
  like any other, on its next read, or by the next pass for an Always graph. With residency off it is
  reseeded at once, as before residency. A customer's key is reseeded as before; the liveness check
  leaves forks out (§6).

## 13. The policy: every value

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

- `GET /residency-policy` → `{enabled, switch, values: {<value>: {saved, default, effective}},
  ranges: {<value>: {min, max}}, updatedBy, updatedAt}`. `enabled` is the Graph residency switch
  (Admin → Features); `switch` says where it is: `{enabled, onSince, evictionsFrom, phase: off |
  grace | on | reloading, reloading}` (§16). `updatedBy` and `updatedAt` are the policy's own
  (`gv_policy_updated_by`, `gv_policy_updated_at`): who last changed a residency value, and when.
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

## 14. Read tracking and the read lease

For each engine it builds over a versioned graph, `ContextEngine` holds the graph with residency on
(`residency.hold`) before it reads the graph's watermark, and then marks the read by that watermark
(`residency.mark`), whatever the switch says. Live exports and the v2 router build their engine with
the person's viewer, as the canvas does; a native query holds its graph before it reads the
watermark, and marks the read by it. Only a person's read counts — a background job builds its
engine with no viewer — and it counts for the graph whose key serves it. For a fork that is its
root: the fork's read plan names the root, reads the root's state, and says whether the fork reads
through the root's store (§2); only then is `residency.on_read` called, with the root and the plan:
with residency on the root is held and its state read again after the hold, and off the plan's
serves. A fork past the ceiling reads its own rows and calls nothing.

- **The read lease, first, with residency on.** The read holds the graph's read lease (the one the neighbors route
  takes) for `GRAPHVER_TRACE_LEASE_TTL_SECS` (120 seconds) before it reads anything: refreshed at most
  every 30 seconds per graph per process, INCR and EXPIRE in one round trip, and never waited on
  for more than about 100 ms. The evictor checks the lease before its compare-and-swap and again
  after it commits: either it sees the read's lease and puts the graph back, or the read sees the
  evicted state and is served from Postgres. What this does not cover: a lease the broker did not
  take within 100 ms (that read goes on without one), and a lease lost from the broker before it
  lapses.
- **Last read, with residency on.** Each process notes the graphs read in memory and writes them
  once a minute: one UPDATE of `last_read_at`, which never moves a read back and passes over a row
  another process's flush holds (rows in id order, `SKIP LOCKED`: two flushes never wait on each
  other). A process that stops loses at most a minute of reads.
- **A read of a graph out of FalkorDB**, whatever the switch says, is served from Postgres and asks
  for its load (§12), never waiting on the broker more than about 100 ms. For the rest of the
  request the graph is known to be out (`residency.READING`), so deep search and node degrees
  answer **503** `graph_loading` `{retryAfter, message}` with `Retry-After`, and ask for the load;
  native queries answer **503** with code `graph_loading`.
- **Cost.** A person's read of a graph costs no statement of residency's own, on or off: whether its
  key is in FalkorDB is read from the watermark the read loads anyway. A fork's read with residency
  on reads its root's state once more, after holding the root (one small read); off, the read plan's
  serves. With residency on, at most every 30 seconds per graph per process, one broker round trip.

## 15. Health and metrics

- **The watermark** (`GET …/watermark`, and every route that returns one) carries `residency` (the
  class), `residencyState` (`resident`, `evicted`, `rehydrating` or `waiting_capacity`; null for a
  graph with no key, and `rehydrating` too while a move, an Adopt or a first seed writes its key from
  nothing), `evictedReason`, `lastReadAt`, `sizeBytes` and, while it is being loaded,
  `rehydratingSince`. A
  graph being loaded reads `fresh: false` and `readRoute.main: "postgres"` until its load is done. A
  fork's are its root's (`readsThrough`), but for `residency`, null.
- **The fleet inventory** (`GET /api/v1/admin/versioning/graphs`) carries the same six on every row,
  null on a fork's, and its `status` filter takes `rehydrating` and `waiting_capacity`.
- **The projection-lag probe** counts `rehydrating` and `waitingCapacity`, and leaves evicted
  graphs out of its worst list: they lag by design. The stats probe does not read a graph out of
  FalkorDB (it would record 0 nodes and 0 edges), and never fails a freshness read over asking:
  when residency's state can't be read, it probes as with residency never on.
- **Check sync** (`POST …/projection/reconcile`) has nothing to compare on a graph out of FalkorDB:
  `skippedReason` says it is out ("its reads are on Postgres until it is loaded again") or being
  loaded ("check again once it is").
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

## 16. Turning residency on

Residency is off by default. A system administrator turns it on, and off, under **Admin → Features
→ Graph residency** (`residencyEnabled`, a preview in Lineage, needing **Version control**), with no
redeploy and no restart. Turning it on asks first, saying what it means, with **Read more** (this
section).

**What it changes.** On, FalkorDB keeps each graph by its class — Always, Standard or Coldline
(§10) — and by each master's memory (§11): what goes unread, or does not fit, is evicted, and loaded
again when something needs it (§12), each load admitted onto a master with room. Off, every graph
stays loaded, as before residency.

**Who reads the switch.**

- **The versioning worker**, at the start of every capacity pass, from the feature store itself
  (`residency_policy.switch_state`): on, off, or unreadable. Only the worker evicts graphs or brings
  them back, and it decides there; a switch it cannot read makes the pass do nothing.
- **The API**, through its flag cache (30 seconds), as every switch is read. On, a person's read
  holds its graph's read lease and is noted for `last_read_at` (§14), and a new graph gets the
  policy's class (off, Standard). A first seed, a move, an Adopt and a package seed are admitted
  with it on, and while it cannot be read (§12). The policy routes say `enabled`.
- **Reads never depend on it.** What only residency writes — `evicted`, `waiting_capacity`,
  `rehydrating` — means "not in FalkorDB" whatever the switch says: such a graph is read from
  Postgres, FalkorDB-only work answers **503** `graph_loading`, and a person's read asks for its
  load. An API process that sees the switch late is safe either way.

**The grace period.** The first capacity pass that sees the switch on writes when, on the platform
settings row (`gv_residency_on_since`), and starts every graph's idle clock, since reads are not
noted while the switch is off. Nothing is evicted for 90 seconds from then (`GRACE_SECS`: the flag
cache's 30 seconds three times over), by which time every API process takes read leases and notes
reads; loads and admission go on meanwhile. The grace period is the same for every worker, and
survives restarts and a change of leader. The leader keeps the switch's phase beside it
(`gv_residency_phase`: `grace`, `on`, `reloading`) and changes it once each time.

**Before you turn it on.**

- **Run this release on every pod.** One on an earlier release neither honours the switch nor reads
  a graph out of FalkorDB from Postgres.
- **Give every master a `maxmemory`.** Without one there is no pressure to measure: idle eviction
  still runs, loads are admitted without a limit, and placement ranks the master after every master
  whose room is known (§17).
- **Set the classes and values first** (§13, §19): Always on the graphs that must stay loaded, the
  idle times, and the start and stop marks.

**While a graph is out of FalkorDB**, its reads come from Postgres, more slowly; its watermark says
`fresh: false`, with `residencyState` `evicted`, `waiting_capacity` or `rehydrating`; deep search,
node degrees and native queries answer **503** `graph_loading` with `Retry-After` until its load is
done; and its Versioning and Data health tabs read it as evicted, waiting for room or loading (§15,
§19).

**Turning it off** evicts nothing more. The capacity pass then only loads: every graph out of
FalkorDB, through the load queue and admission, one load per master at a time, as room allows, until
none is left; then it idles. Until each is back it reads from Postgres, and no projection pass
reseeds one on its own. A graph that never fits waits (`waiting_capacity`) until memory is freed, so
make room first if many are out. Turned off and on again before the next pass, the switch is never
seen off by the leader: no new grace period starts, though API processes that saw it off took no
leases meanwhile.

**Where it is recorded.**

- Each change of the switch: its history (`feature_flag_changes`: who, when, from and to), and
  `platform.feature_flag.changed` in the activity log, which reads "Turned Graph residency on".
- What the leader then does, as the system's (no actor), filed under the switch, each once:
  `platform.residency.grace_started` `{onSince, evictionsFrom, graceSecs}`,
  `platform.residency.evictions_allowed` `{onSince}`, `platform.residency.turned_off`
  `{toBringBack}`, and `platform.residency.reload_finished`.
- Each graph evicted or loaded: `platform.versioning.graph_evicted` `{graphId, workspaceId,
  dataSourceId, master, bytes, reason}` — `idle_standard`, `idle_coldline`, `pressure` or
  `load_stalled` — and `platform.versioning.graph_loaded` `{graphId, workspaceId, dataSourceId,
  master, bytes, secs}`.

**On the card.** Residency & eviction (§19) says where the switch is: "Graph residency is on.
Evictions start at 10:42 (grace period).", "Graph residency is on.", "Graph residency is off. 12
graphs are being brought back as memory allows.", or, fully off, that an administrator can turn it
on and the values are kept. `GET /residency-policy` carries the same as `switch` (§13).

**The count budget is no longer used.** `GRAPHVER_FALKOR_MAX_RESIDENT`, `GRAPHVER_FALKOR_BUDGETS`,
`GRAPHVER_EVICT_SECS` and a provider's `falkor_max_resident` are not acted on, whether residency is
on or off: Graph residency replaces them (off, what the count budget evicted would only be loaded
back). A later release removes them.

**Migrations.** `20261030_1300_gv_ps_residency` (graphver: the residency columns, their checks, and
the two statuses) follows `20261030_1200_ds_fork_of`; with a separate `GRAPHVER_DB_URL` the
versioning worker adds it on start. `20261030_1400_residency_policy` (management: the policy's
values, who changed them last, and the leader's `gv_residency_on_since` and `gv_residency_phase`,
all unset) follows it, and `20261102_1000_feature_impact_on` (management:
`feature_definitions.impact_when_on`, what turning a switch on means) follows that. Each waits at
most five seconds for its locks and can be run again. Downgrading the first turns a graph waiting
for room or being loaded into an evicted one at watermark 0, which the code before reseeds.

## 17. Placement: each new key on the master with the most room

A platform key's hash tag alone decides its cluster slot, so a new key is placed by choosing its
tag: on the master with the most room under its start mark after what is held there (the aggregation
governor's reservations, and the loads and full projections in flight), among those free to take a
load — none that is forking for persistence, loading its dataset, unreadable, taking a load already,
or kept that pass for a waiting load whose room is being made there (§12) — the first of the graph's
platform keys (`gvp_<gid>{<tag>.<n>}`, `n` rising) that exists nowhere on the provider, is none of
its retired keys, and hashes to that master's slots (`keymigrate.placed_key`, at most 4096 tries;
one master: simply the first free key). When no key lands within the bound — a master that owns few
slots, after a reshard onto it — the next master with the most room is tried, by the routes and by a
pass's load alike. A master that sets no `maxmemory` has room unknown, not unlimited: it ranks after
every master whose room is known, and of masters without a limit the least used comes first. So
beside masters with a limit it takes a new key or a load only when none of them is free: a route's
new key goes on the master with a limit and is admission-checked there (**409**
`capacity_insufficient` when it is short), Always is room-checked there, and a load short of room
there waits there, with room made for it (§12). None is sent to the master without a limit instead.
The master's slots come from the client's slot map (`shard_capacity.master_slots`).

- **A reload after eviction** goes onto a fresh key placed this way (§12), whatever master its old
  key was on. A graph whose rollups live in a dedicated graph keeps its key.
- **A move without a key**, with residency on, is placed the same way (`residency.place_key`), and
  records the master in its `shard_map`; it is admission-checked on that master first (409
  `capacity_insufficient`), since the old key stands until the new one has caught up. A move with a
  key is checked on the master that key hashes to. A graph out of FalkorDB only changes its pin.
- **Adopt** (§18) places the platform key the same way, then admits its copy on that key's master.
- **Placement, admission and the commit are one step** for a move or an Adopt: they run under the
  capacity pass's leader lock (`residency.admitting`), so neither a load a pass starts nor another
  route's write is admitted between the check and the commit, whose `projection_state` row (a reseed
  at watermark 0) then reserves its room. A move takes the lock whatever the graph's state, and
  reads that state under it. A route waits up to 15 seconds for a pass to finish, then
  answers **503** `lock_busy`.
- **A graph's first key**: a blank model's is its data source's name (`blank_<ds>`, or the one its
  creator chose); with residency on its first seed is a load (§12), which places a fresh key. A
  converted source's is the customer's own until it is adopted.
- **Customer keys never move**, except by Adopt.

## 18. Adopt: a customer's key onto a platform key

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
- **The customer's key keeps its memory**: the graph takes the room of two copies until whoever owns
  that key clears it. The confirmation says so too.
- **The platform key is written in the ontology's spelling.** The customer's graph may spell a type
  its own way (`:table` for the ontology's `Table`, `:has` for `HAS`); the platform key holds the
  ontology's. A native query or a saved query written against the customer's spelling finds nothing
  on the platform key: write it in the ontology's. The confirmation says so.
- With residency on, the key is chosen first — placed on the provider's master with the most room
  among those free to take a load — and the copy admission-checked on that key's master (409
  `capacity_insufficient` with its `reason`); the choice, the check and the swap are one step against
  the capacity pass and any other move or Adopt (§17). Off, it is the first free platform key, and
  nothing is admitted.
- **A projection pass in flight** holds the graph's projection lock: Adopt takes it as a try, and
  while a pass writes the customer's key answers **409** `lock_busy` (retryable), changing nothing.
- Refused as a move is: an unpinned graph (409 `projection_not_adopted` `unpinned`), a key other
  data sources read (409 `projection_not_adopted` `shared`: they would go on reading a key nobody
  writes), a dedicated rollup graph (422 `projection_mode_unsupported`), a running rollup job (409
  `job_active`; checked again under the capacity lock, just before the commit, so one that starts
  while Adopt waits for the lock is caught), a provider whose keys cannot be listed (503
  `provider_unreachable`), version control still being enabled (409 `bootstrapping`); and a graph
  already on a platform key (409 `already_adopted`), a fork (409 `not_for_forks`), an unknown graph
  (404).
- Recorded as `platform.versioning.projection_adopted` `{graphId, workspaceId, dataSourceId, from,
  to, externalDrift}`. The reseed is scheduled at once.

## 19. The admin screens

Admin → Infrastructure → **Versioned graphs** (system administrators; it opens from the projection
panel's **All versioned graphs**):

- **Each row** shows the graph's class and whether it is in memory as chips — **In memory**,
  **Evicted**, **Loading** (with when it started), **Waiting for room** — and, for a graph that is not
  a fork, a class selector (Always may be refused when its master has no room: the server's message
  shows on the row), **Load now** on a graph out of FalkorDB, and **Adopt…** on a customer's key
  (not on a graph with no key), behind a confirmation that says what changes (§18); a refusal names
  its reason. A graph with no key shows no state chip. The state filter takes **Loading** and
  **Waiting for room**.
- **Residency & eviction** opens the policy card: every value with the one in force, its default and
  its unit, **Reset** (saves `-1`), each master's memory as a gauge with the start and stop marks
  drawn on it, who changed the values last and when, and where the Graph residency switch is (§16):
  on, in its grace period (when evictions start), bringing graphs back after it was turned off, or
  off. A duration's unit can be switched: the value is shown, or converted, in it. **Save**
  asks the planner first and confirms with what the next pass would do ("Saving evicts 12 graphs,
  9.4 GB and 2 of unknown size, on master 10.0.0.2:6379") and when: every server reads new values
  within 30 seconds, and the next capacity pass acts on them; a value the server refuses shows next
  to the field it names.
- **The projection panel** counts graphs **loading** and **waiting for room**.

On the workspace side, a data source's **Versioning** tab (and the Data health tab) shows the graph's
class and whether it is in memory, read-only, and reads a graph being loaded or waiting for room as
such — never as "versions behind" — polling until it is back: every 3 seconds while it loads and 15
while it waits, then once a minute after three minutes of either.
