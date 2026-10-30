# 17 · Forks You Can Work In, and Residency

> **Audience & scope:** engineers and reviewers of the fork work. What a fork is now that it is a
> data source of its own, how its settings follow its parent's, how it moves through the trash and
> between workspaces with its parent, and how a fork reads its parent commit by commit. The fork
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

**The views on a fork outlive its row.** When the row is deleted — its purge completes, the reaper
removes it, or its parent's permanent delete takes it — the views on it go to its nearest live
ancestor (its parent; up a fork of a fork), losing the fork's draft they were pinned to; one in the
trash stays there. With no ancestor left (a parent's permanent delete), they read the workspace's
default, as the parent's own views do.

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
- **Residency.** Which graphs stay loaded in FalkorDB is decided per graph — always, standard
  (evicted when idle) or coldline (loaded only when a request needs it) — and by each FalkorDB
  master's free memory. Postgres stays the source of truth: an evicted graph reads from it until
  it is loaded again.
