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
| **CSV**, **JSON** | The browser, at once | What the dock shows — the sides being read, the hop limits, the seeds still in it — every entity, open or not; hosts as each row's path. JSON adds the flows between them and the membership spec that found them, built as Blob parts (never one 50,000-row string). |
| **Everything it reaches…** | The server (§3) | Every source and consumer, inside the view or not, up to a million; flows on request. CSV, NDJSON or JSON. |
| **Save as view…** | The server (§4) | A view of everything the trace reaches, laid out as lineage stages, provenance `trace`. |
| **Save trace** | The browser | The recipe and a gzipped, columnar copy of the results, in IndexedDB. |

**Saved traces** are per user and view, kept until removed (100 per view). Each one's results are
a record of their own, so listing them reads none: strings once each, repeated values in tables,
the seeds that reach a row as one bitmask, gzipped (`hooks/lib/traceSnapshot.ts`). Reopening one
runs it against live data and, once it has landed, says what moved: *+N new · −M gone since
saved*, downloadable as CSV. Short of space, the oldest give up their results and keep their
recipes; with no IndexedDB they last for the visit. They are listed in the dock's panel and in the
header's trace launcher, which now opens for saved traces even with no history.

## 3. What changed — member sets: a scope resolved in full, a step at a time

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

## 5. What changed — Advanced Search

**Export → With their sources & consumers…** exports a search's matches with what they feed and are
fed by, as far as you choose (1–25 hops or the whole way) and optionally with what is inside those —
through a member set, so neither the matches nor what they reach is capped at 5,000.

<!-- §5.1 in-view search above the root cap: filled in when that lands. -->

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
* **Save as view…** on a trace of more than 5,000: the sheet reports progress, the view opens, its
  layers page as they scroll.
* The live tests: `RUN_FALKOR_LIVE=1 python -m pytest tests/integration/test_member_sets_live.py
  tests/integration/test_member_views_live.py -q` (run by CI's live FalkorDB job).

## 9. Known limitations and follow-ups

* **Neo4j and Spanner have no closure walk**, so member sets (and therefore **Everything it
  reaches…** and list views with lineage) answer 501 on them, as Narrow already did.
* **The canvas's own Narrow still starts from a search's first 5,000 matches** and holds 50,000
  members; a view saved from it, and an export, start from every match.
* **A layer lists 5,000 members on the canvas**; search the view, or export it, for the rest.
* **Saved traces are in one browser.** They do not follow a person between machines.
* **URN seeds stay at 5,000 per spec** (a trace has at most 25); only query seeds are unlimited.
* **Member sets are not on the API-key surface yet**, so scripts using an API key can't reach them.
* **Edges inside a container seed** are kept only when both ends are members.
* `tests/test_data_source_transfers.py::test_a_move_refused_for_a_job_names_every_kind_of_job_in_words`
  fails on the commit this work started from (job type `save` has no words); it is untouched here.
