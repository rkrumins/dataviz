# Traces you can hand on, take away and keep, and views of a quarter of a million members — 2026-11-18

Two reports arrived together:

1. **A trace of many entities was a dead end.** Someone traces the 20 tables they selected, reads
   the result in the dock — and can do nothing else with it. A link carried one entity, so Share
   was withheld for a combined trace. There was no way to download what the trace showed, no way
   to make a view of it, and no way to keep it for later.
2. **A view of a search's sources and consumers stopped at 5,000.** Advanced Search found 50,000
   matches; Narrow brought in their sources and consumers; **Save as view** refused anything over
   5,000 entries. There was no export of a search's matches *with* their lineage either.

Both had to work on graphs with millions of nodes and edges, versioned or not.

This documents what caused each, what changed at every layer, the values that moved, how to roll
it out, how to verify it, and what is deliberately not in this release.

> **Operator action:** two database migrations run with the upgrade
> (`20261118_1000_member_sets`, `20261118_1100_view_members`). The second **moves** the members of
> every view made from a query out of its layout into a table of its own and marks each such view
> to be worked out again on its next open. `viewMembershipEnabled` ships off, so few such views
> exist. See [§6](#6-rollout).

Companions, each authoritative for what it covers:

* [`guide/EXPLORING_GRAPH.md`](guide/EXPLORING_GRAPH.md) — the user guide: sharing a combined
  trace, **Take a trace with you**, saved traces, and keeping a narrowing as a view.
* [`guide/MANAGING_VIEWS.md`](guide/MANAGING_VIEWS.md) and
  [`guide/TROUBLESHOOTING.md`](guide/TROUBLESHOOTING.md) — looking after a list view.
* [`CONFIGURATION.md`](CONFIGURATION.md) — every new setting, generated from the code.
* [`../CHANGELOG.md`](../CHANGELOG.md) — the per-change record.

---

## 1. What was wrong

### 1.1 A combined trace had nowhere to go

The share token (`hooks/lib/traceShareCodec.ts`) held one `urn`. Offering it for a combined trace
would have handed over the first seed's trace as if it were the picture, so Share, and the link
icon on a combined history row, were withheld. Nothing else existed: the dock had no export, and
the only way to keep a trace was the history — a trail of recipes, capped at 50, that fills and
forgets on its own.

### 1.2 A list view's members lived in its layout

A view made from a query (a *list view*) wrote every member, and every container drawn around
them, into `views.config` (a TEXT column) as `assignedBy: "query"` assignments. Three things then
capped it at 5,000:

* **Search.** Every assignment with a layer became a search root, and a search refuses more than
  `DEEP_SEARCH_SCOPE_ROOT_URNS_CAP` (5,000) roots. `pipeline.entry_limit()` was that cap.
* **Every read of every view.** `GET /views/` returns each row's whole config, and opening a view
  loads it: 50,000 assignments is megabytes on every list page and every open.
* **The canvas.** A curated view loaded every assigned URN, 100 to a request, before drawing.

And the resolver behind it (`view_membership.py`) held its state in one process, answered inside
one 100-second request, stopped at 50,000 members, and took a search's first 5,000 matches as its
starting points.

---

## 2. What changed — the trace dock

**Share carries every seed.** A combined trace writes a `v:2` token holding up to 25 seeds; one
seed is still the `v:1` token byte for byte, so every link already handed out keeps working, and
an older client given a `v:2` link opens the view rather than quietly tracing its first seed. A
link that would pass 7,000 characters (nginx's default request line is 8 KB — a longer one is a
414) leaves the open cards out and says so; the seeds, sides and hop limits always travel. History
rows of a combined trace share too.

**Export & save** is one new control on the dock:

| Choice | Where it is worked out | What it holds |
| --- | --- | --- |
| **CSV**, **JSON** | The browser, at once | What the dock shows — the sides being read, the hop limits, the seeds still in it — every entity, open or not, with the layer it is drawn in and where it sits (§2.1); hosts as each row's path. JSON adds the flows between them and the membership spec that found them, built as Blob parts (never one 50,000-row string). |
| **Everything it reaches…** | The server (§3) | Every source and consumer, inside the view or not, up to a million, with where each sits (§2.1); flows on request. CSV, NDJSON or JSON. |
| **Save as view…** | The server (§4) | A view of everything the trace reaches — a subset that follows the view it was traced in (§4.1) — provenance `trace`. |
| **Save trace** | The browser | The recipe and a gzipped, columnar copy of the results, in IndexedDB. |

**Saved traces** are per user and view, kept until removed (100 per view). Each one's results are
a record of their own, so listing them reads none: strings once each, repeated values in tables,
the seeds that reach a row as one bitmask, gzipped (`hooks/lib/traceSnapshot.ts`). Reopening one
runs it against live data and, once it has landed, says what moved: *+N new · −M gone since
saved*, downloadable as CSV. Short of space, the oldest give up their results and keep their
recipes; with no IndexedDB they last for the visit. They are listed in the dock's panel and in the
header's trace launcher, which now opens for saved traces even with no history.

### 2.1 Where each entity sits, in every export

Every row of the dock's files, of a saved trace's and of a member set's download says where the
entity sits: `parentUrn`, `parentName`, `parentType`, and the whole chain of containers from the
top down to it — `path` as names and `pathUrns` as URNs. CSV joins them (`A / B`, `a; b`); JSON and
NDJSON keep arrays. An entity at the top of the graph has empty parent cells and an empty path.

* **The dock** reads the chain from the containment the trace loaded, once per container
  (memoised, cycle-guarded), so 50,000 rows cost one pass. Its `layer` column is the layer the row
  is drawn in.
* **A saved trace** stores them in its columnar snapshot (inner `v: 2`). Traces saved before keep
  their lane path, with empty parent cells, rather than a guess.
* **Flows say where both ends sit.** A flow row is `source, target, type` (first, as before), then
  for each end its name, type, parent (URN, name, type) and path (names and URNs) — and, in the
  dock's files, the layer it is drawn in. The dock's CSV is now two files, the entities and
  `…-flows.csv`; the dock's JSON `edges`, a saved trace's files and the server's flows file
  (`part=edges`, and a JSON document's `edges`) carry the same. The server reads the ends' names
  and types from the set's rows and their chains as it does for members, one page of flows at a
  time, one names cache across a document's nodes and flows.
* **The server's download** asks the graph for the chains of each 1,000 rows in one admitted
  statement (`get_ancestor_chains`, which FalkorDB, its drafts and versioned branches all
  implement) and names the containers it hasn't already seen in one more. A provider that can't say
  leaves the cells empty. It has no `layer`: a member set isn't drawn in a view.

 What changed — member sets: a scope resolved in full, a step at a time

One new primitive behind everything large: a **member set** (`services/member_sets/`,
`POST /{ws}/graph/member-sets`) — a membership spec resolved completely, however long it takes.

* **Resumable by construction.** Its walk state lives in rows (`member_sets`, `member_set_rows`,
  `member_set_edges`), not in a process. Each request moves it on for up to `waitMs` (10 s by
  default) and answers with how far it got; any replica can take the next step. A step commits in
  the same transaction as its rows, fenced on a lease and a step counter, so a crash or a takeover
  writes nothing and the step is simply done again; every write is idempotent (shortest hops win).
* **One walker.** The step logic is the Narrow resolver's, extracted (`walk.py`) and run over
  either an in-memory store (Narrow, unchanged) or the SQL store. Two fixes came with it: each
  closure step now asks for `TRACE_MAX_NODES_HARD` (10,000) nodes instead of the clamped 2,000
  (about five times fewer statements), and a node found again nearer keeps its shorter distance.
* **Bounded.** One graph statement per step under per-statement admission, one fair-share token
  per request; a step that times out halves its batch and grows back. Memory is the step's, never
  the set's. Query seeds page through the search past the old 5,000.
* **Shared.** The set's key is (scope, spec, boundary, data version, edges): a hundred people
  asking the same question move one set on; a request that finds another moving it waits on it
  holding nothing.
* **Downloaded whole.** `GET …/member-sets/{id}/download` streams CSV, NDJSON or JSON from the rows,
  5,000 to a read, with a download token bound to the person and to this purpose. No object store,
  no versioning worker: it works on every deployment, versioned graph or not.
* **Kept a day.** A sweeper expires complete sets after `MEMBER_SET_TTL_HOURS` (24) and abandoned
  ones after 15 minutes, deleting rows in batches.

Measured on a real FalkorDB (`tests/integration/test_member_sets_live.py`): twenty seeds whose
lineage fans out six hops and meets — **51,101 members, 51,123 flows — in 6 three-second requests,
16 closure steps, 24 s**, every member at its shortest distance, every flow kept, the file holding
every row.

## 4. What changed — views of a quarter of a million members

* **Members live in `view_members`**, keyed (view, epoch, urn), never in the layout. The layout
  keeps only what people placed by hand. `GET /views/` and every open stay small however large the
  view.
* **Worked out from member sets.** Making, previewing and refreshing a list view resolve its sources
  as member sets. While they resolve, `POST /views/from-members` and `/graph/members/plan` answer
  **202** `{status: "resolving", sets}` and make nothing (the same `Idempotency-Key` is sent
  again); refresh answers `running`, and opening the view carries a run on.
* **Placed a page at a time** (1,000 members), resumable at the same epoch, and swapped in
  atomically: readers see the old members until the new ones are complete. The mass-removal hold,
  exclusions, Always include, snapshots, versions and view files keep working.
* **The limit is `LIVE_VIEW_MAX_MEMBERS` (250,000), members only.** Containers drawn around them no
  longer count; they are drawn from each member's ancestor path.
* **The canvas pages them.** `POST /{ws}/graph/view-members` serves one layer a page at a time in
  name order (signed keyset cursor, exact counts), up to `VIEW_MEMBERS_FEED_MAX_ROWS` (5,000) a
  layer; the canvas reads it exactly as it reads a subset view's feed. With `viewMembershipEnabled`
  off a list view still shows the members it last had, as the switch promises.

Measured on a real FalkorDB (`tests/integration/test_member_views_live.py`): the 51,101-member set
above saved as a view — three answers of 202, the view ready in 32 s, its record a few kilobytes,
every layer paged in name order with exact counts.

### 4.1 A trace saved as a view follows the view it was traced in

The first build made a trace's view a list view laid out as lineage stages, or with a one-off copy
of the view's layers. Readers asked for the trace's own view — the same layers and layout, with the
trace as the question that fills it. A subset view (`config.search`) can't express a trace: it
reaches one lineage step, never 25 or "all". So the content stays a list of members, and the layout
gains a kind that borrows the subset's machinery:

* **`layout.kind: "follow"`, `sourceViewId`.** The view stores no layers. Every read serves it the
  followed view's layers live (`search_views.served_config`, keyed by the new `followed_base()`),
  plus *Other matches* unless that view has a `showUnassigned` layer. Renames, new layers and a new
  order show at once.
* **What the trace shows.** The trace's spec keeps each seed whole (`children: "all"`): the trace
  draws a seed with everything inside it, and a seed of 10,000 columns is still one member. Its
  file (**Everything it reaches…**) lists what is inside the seeds, two levels down, so the server's
  rows hold every row of the dock's own CSV.
* **Placed by the followed view** (`source_placer` with identity links, the shared placement engine
  the canvas conformance cases pin): its rules, its scope and what people placed in it by hand —
  an entity's contents going with it — re-placed on every run.
  The applied answer records the followed view's placement digest, so a change to how it places
  things (a type moved, a rule, a layer removed) places the members again on the next open.
* **It is a subset.** `subset_of` is set; it is listed under the base's **Subsets** (now shown when
  either `searchViewsEnabled` or `viewMembershipEnabled` is on); its chip reads *Subset of X ·
  Auto-updating · N*. Layer edits, groups and a custom order are not offered, and a layout write
  carrying layers answers 422.
* **People place members on top of it.** A move to another served layer, and Always include, are
  kept on the view (`membership.overrides`, its own assignments) and win over the followed view's
  placement on every run. The client saves them with `layers: []`; entries are checked against
  the layers the view is served (`other-matches` included), and one whose layer the followed view
  deletes is placed, and served, in the fallback layer. Not yet on a draft (its overlay is still
  checked against stored layers), so the canvas offers no moves there.
* **In-view search reads its layers.** A layer filter resolves against the followed view's
  placement, opened to every entity, with the view's own entries and moves over it; "Other matches"
  is its fallback layer. The scope hash changes when the followed view's placement does.
* **It says when it is out of date.** A published layout write that changes a view's placement
  digest (layout save, draft promote, staged import, version restore, import over it) marks its
  follow views `pending` (`{"reason": "base_changed"}`) in one statement — not snapshots, not one a
  run holds. A rename marks nothing. The next open re-places them.
* **Refusals.** A subset (or a view that follows one) can't be followed — follow its base:
  `422 base_is_subset`. A view made from a query can't be: `422 base_is_list`. Saving from inside a
  subset follows the subset's base, which also fixes "This view has no layers to copy".
* **Its base gone**: the view keeps its members, its status is `source_missing` (`base_missing`),
  it shows no layers, and the canvas says why.
* **Members nest.** With **Show where they sit**, each member row carries `in_layer` — how many of
  its nearest containers are drawn in its layer too — computed while placing and shipped by the
  member feed as `inLayer`, with a full `ancestorPath`. List views of any layout now draw their
  members inside their containers, as subset views do. The column is added to the unreleased
  `20261118_1100_view_members` migration, with a guarded `add_column` for a database that already
  ran it.

### 4.2 Preview and Save as view answered 422 on an older server

The sheet sent `waitMs` (10,000) with every preview and save. A server from before it accepted the
field refused the body (`extra_forbidden`), so the preview never appeared and saving failed. The
server already waits 10 seconds by default, so no client sends it now. The request bodies the
browser builds are pinned in `backend/tests/fixtures/membership_requests.json`: the frontend test
builds each one exactly, and the backend test validates each against the models (which forbid
unknown fields). A field reaches a request only once every deployed server accepts it.

## 5. What changed — Advanced Search

**Export → With their sources & consumers…** exports a search's matches with what they feed and are
fed by, as far as you choose (1–25 hops or the whole way) and optionally with what is inside those —
through a member set, so neither the matches nor what they reach is capped at 5,000.

### 5.1 Searching inside a view of more members than a search lists as roots

A search inside a list view reads its members as roots while there are no more than
`DEEP_SEARCH_SCOPE_ROOT_URNS_CAP` (5,000) of them, as before. Above that it used to refuse; now its
roots are what people placed by hand and the members kept whole, and every other member is read
from `view_members` in bands of about 2,000 under its graph label — the engine's URN-list statement,
run per band, split when a band runs out of time. A session keeps the bands, never the URNs, so it
does not grow with the view. Nothing is counted twice: a band leaves out whatever sits under the
roots. Counts, progressive results, search exports, a subset view made on such a view, Narrow's
query seeds and display rules all read the same scope, and the answer says so: *This view has N
members: the search reads the members themselves, and everything inside the ones kept whole.*
FalkorDB (and its drafts) only; other providers keep the honest refusal.

## 6. Rollout

1. Deploy. The migrations run with the upgrade; both are additive DDL with a data step in the
   second (batched per view). `alembic downgrade` of the second writes members back into layouts
   and refuses if any view holds more than 5,000.
2. Nothing else is required. Every new behaviour sits behind switches that already exist:
   `traceEnabled` (trace, sharing, saved traces), `graphExportEnabled` (**Everything it reaches…**,
   a search's sources & consumers), `viewMembershipEnabled` (making and updating list views).
3. Postgres growth to expect: about 100 bytes a member-set row while a set is kept (a day), and
   about 100 bytes a view member for as long as the view exists.

## 7. Values

| Setting | Default | What it bounds |
| --- | --- | --- |
| `MEMBER_SET_MAX_MEMBERS` | 1,000,000 | Members one member set holds; past it, `member_cap`. |
| `MEMBER_SET_MAX_EDGES` | 2,000,000 | Flows one set keeps when asked for them; past it, `edge_cap`. |
| `MEMBER_SET_MAX_DURATION_S` | 7,200 | How long one set may take across all its requests; past it, `deadline`. |
| `MEMBER_SET_TTL_HOURS` | 24 | How long a complete set is kept to be listed and downloaded. |
| `LIVE_VIEW_MAX_MEMBERS` | 250,000 | Members one list view holds; past it, `over_cap`. |
| `VIEW_MEMBERS_FEED_MAX_ROWS` | 5,000 | Members one layer of a list view lists on the canvas; past it, `capped`. |

In code: share links carry at most 25 seeds and 7,000 characters; a browser keeps 100 saved traces
a view and snapshots of up to 500,000 rows.

## 8. Verifying it worked

* Select two or more entities, trace them, **Share → Copy link**, open the link elsewhere: every
  seed traces.
* **Export & save → CSV**: one row per entity the dock shows. **Save trace**, reload, open it from
  **Saved in this browser**.
* **Everything it reaches…** on a large trace: the dialog reports stages and counts, then downloads.
* **Save as view…** on a trace of more than 5,000: **Follow** is chosen, the sheet reports
  progress, the view opens reading *Subset of <view>*, with that view's layers, and pages them as
  they scroll. Rename a layer in the view it follows: the subset shows the new name.
* **Export & save → CSV**: `parentUrn`, `parentName`, `parentType`, `path` and `pathUrns` are
  filled for every entity inside a container.
* The live tests: `RUN_FALKOR_LIVE=1 python -m pytest tests/integration/test_member_sets_live.py
  tests/integration/test_member_views_live.py -q` (run by CI's live FalkorDB job).

## 9. Known limitations and follow-ups

* **Neo4j and Spanner have no closure walk**, so member sets (and therefore **Everything it
  reaches…** and list views with lineage) answer 501 on them, as Narrow already did.
* **The canvas's own Narrow still starts from a search's first 5,000 matches** and holds 50,000
  members; a view saved from it, and an export, start from every match.
* **A layer lists 5,000 members on the canvas**; search the view, or export it, for the rest.
* **Inside a view of more than 5,000 members**, a search reads the members themselves (and inside
  the ones kept whole), not inside every member. Facets other than "inside", Connections searches,
  the property catalog, explain and aggregate-only searches still refuse there, and say why.
* **Saved traces are in one browser.** They do not follow a person between machines.
* **URN seeds stay at 5,000 per spec** (a trace has at most 25); only query seeds are unlimited.
* **Member sets are not on the API-key surface yet**, so scripts using an API key can't reach them.
* **Edges inside a container seed** are kept only when both ends are members.
* **A view that follows another** re-places its members on its next open after the followed view
  changes how it places things (it says **Waiting to update** meanwhile). Members can't be moved in
  it on a draft yet. A layer filter in it counts the followed view's hand placements and its own
  moves towards the 1,000 a layer filter follows. Following a view made from a query is refused
  for now.
* **`in_layer` in a stages layout** depends on which members share a page, so it can differ by
  page size there (any other layout gives the same rows at any page size).
* `tests/test_data_source_transfers.py::test_a_move_refused_for_a_job_names_every_kind_of_job_in_words`
  fails on the commit this work started from (job type `save` has no words); it is untouched here.
