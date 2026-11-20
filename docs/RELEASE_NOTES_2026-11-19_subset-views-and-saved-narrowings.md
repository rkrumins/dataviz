# Subset views that work like any view, every member on the canvas, saved and shared narrowings, and saving that never gives up — 2026-11-19

Four reports, following the [2026-11-18 release](RELEASE_NOTES_2026-11-18_trace-share-export-views.md):

1. **A narrowing couldn't be kept or handed on.** A `?narrow=` link asked the question again
   with nothing to say what had changed, dropped the reach into the tables a trace finds, and
   carried no names. Nothing could be saved, and nothing exported, from Narrow.
2. **Inside a subset view, the canvas's functions fell short.** A trace in a list or follow view
   drew nearly empty columns: it placed cards from the view's stored assignments, which a list
   view doesn't have, so every chain — the seed's too — counted as "outside this view". In a plain
   list view, layer filters (and Narrow and Search in a layer) found nothing, a capped layer
   offered no way to the rest, and a past revision silently showed only hand-placed entries.
   **Save search as view** failed inside a follow view; a following view didn't show the display
   rules it follows; a subset's data export silently covered the whole data source.
3. **Saving and opening large list views was fragile.** Every `/api/v1/views/**` request is cut
   at 30 seconds, but a list view's turn budgeted 100. A cut-off save said "That took too long"
   though the view existed; a cut-off turn kept its lease for up to 300 seconds, so everyone else
   was told "busy"; opening stopped on its first error; an update cleared the canvas.
4. **A list view drew its first 5,000 members a layer, and much of the canvas knew only what it
   had loaded.** Search results all landed under "Not on this canvas"; Show on canvas couldn't
   reach a member that wasn't loaded; Narrow filtered only loaded rows; a subset of a list view
   put everything in "Other". The wizard could turn a list view into a Graph view of the whole
   data source, and **Export → This view** of a view that held nothing exported the whole data
   source. A snapshot moved to another environment arrived empty. Two older bugs: a standalone
   FalkorDB was held to cluster timeouts (search 45 → 10 s), and a fresh install's upgrade
   skipped the version store, so graph reads answered 503.

> **Operator action:** one migration, `20261120_1000_saved_narrowings` — a new, empty table;
> nothing is backfilled. Four new settings and two new defaults, all safe (§7): the layer feeds
> lose their 5,000 and 2,000 ceilings (`0`: none) — set one only to bound a fleet. Saved
> narrowings are part of the `viewMembershipEnabled` preview, which ships off.
>
> **Behaviour changes:** **Export → This view** of a view that holds nothing answers `422
> view_holds_nothing` (it used to export the whole data source); `POST /views` with
> `membership` or `search` answers `422 made_by_its_route`; changing a list or subset view's
> layout type or entity scope answers `422 list_view_context_only`.

Companions: [`guide/EXPLORING_GRAPH.md`](guide/EXPLORING_GRAPH.md) (Save a narrowing with the
view), [`guide/MANAGING_VIEWS.md`](guide/MANAGING_VIEWS.md) (everything works inside a view made
from a query), [`guide/TROUBLESHOOTING.md`](guide/TROUBLESHOOTING.md),
[`API_GUIDE.md`](API_GUIDE.md), [`CONFIGURATION.md`](CONFIGURATION.md),
[`../CHANGELOG.md`](../CHANGELOG.md).

---

## 1. Saved and shared narrowings

- **Save** on the Narrowed bar keeps the narrowing with the view (`view_saved_narrowings`), for
  everyone who can read it, under a short link: `/views/{id}?narrowSaved={nid}`. It keeps the
  spec, the seeds' words and names, its counts and what it held — its URNs, sorted and gzipped
  (≤ 60,000 lines, ≤ 2 MiB).
- **Opening it** asks the spec again, reads what it held (`…/held`, with an `ETag`), and says
  *+N new · −M gone since 3 Nov* — *about* when either side was cut short.
- **The header** lists the view's saved narrowings (open, copy link, export; rename and remove
  for their saver or an editor). Limits: 200 per view, 50 per person per view.
- **Export** from the bar or a saved narrowing: every entity it shows with its parent and path,
  and the flows between them, through member sets.
- **Its saver's copy**: after saving, the entities and flows files are worked out on the server
  and kept gzipped in that browser's IndexedDB (`nx:narrowing-copy:v1:{id}`), to download without
  asking again. Same 500,000-row cap and oldest-first eviction as saved traces.
- **`?narrow=` links** keep `partnerHosts`/`partnerLineage`, carry up to 200 seed names, and are
  withheld past 7,000 characters (names are dropped first) — save it for a short link.
- A save is retried under its client-made id through `408/429/5xx`, so it saves once.

Saved narrowings are kept with the view, not its versions or packages; deleting the view deletes
them (`ON DELETE CASCADE`).

## 2. Every function inside a list, follow or subset view

- **Trace places by the server.** `POST /{ws}/graph/view-placements` answers where the view draws
  each entity: a member by its row (a fresh override on top), then a person's entry, then the
  nearest ancestor kept whole, then the view's layout (or the view it follows), then its fallback
  layer, else nowhere; for subsets, where its base places it, or by type. Cached per view, epoch,
  placement digest, URNs and data version. The canvas asks while a trace is on, 2,000 URNs a
  request, two at a time, asking again through a busy server; the dock says **Placing N…**, and
  only an entity placed nowhere is "outside this view". On 51,101 members, 1,721 placements answer
  in about 80 ms, each member in the layer its feed lists it in.
- **Layer filters in plain list views** narrow the search's roots to that layer's members — listed
  up to the root cap, above it read in bands — with the layer folded into the scope hash. Nested
  under `or`/`not` or in a rule, a layer is a list of at most 1,000 members, else 400.
- **A layer's menu** offers **Search in this layer** (with Undo) and **Export this layer…** (CSV or
  NDJSON) in every list, follow and subset view: `POST /{ws}/graph/view-members/export` mints a
  ten-minute token for (view, epoch, layer, caller), and `GET …/view-members/download` streams
  keyset pages of 5,000 with each member's parent and path — the answer readers see now, should
  the view move on meanwhile (`X-Members-Epoch`). A subset exports its layer's matches.
- **Save search as view** inside a follow view follows the view it follows; in a plain list view,
  the follow choice says why it can't be, in the server's terms. **Like** a following view copies
  the layers it is served.
- **Followed display rules**: the library answers the followed view's rules with `rulesFrom`; the
  property drawer shows them read-only, *From {name}*; rule writes answer `409 rules_followed`.
- **A past revision** of a list view says it shows only what was placed by hand.
- **A subset's data export** answers `422 subset_matches_export`; the export dialog offers **Export
  its matches**.

## 3. Every member on the canvas

- **A layer pages to its last member.** No ceiling unless an operator sets one: a first page of
  200, then 500 at a time as the reader scrolls, and one page looked ahead while the browser is
  idle (paused in a hidden tab). The header reads *1,200 of 50,820 loaded*; **Load more** reads
  *Load 500 more · 49,620 to go*. A fed layer sorts by name only — *Sorted by name as they
  load* — and says *No members*, shows ghosts while a page comes, or *Couldn't load this layer*.
  A subset's layer reads its matches a scan of `DEEP_SEARCH_VIEW_FEED_SESSION_ROWS` at a time,
  the next scan starting where the last ended.
- **Where the view draws it, loaded or not.** `view-placements` answers `inLayer` (how many
  containers an entity is drawn inside), a new source `inside` (under its member, in that
  member's layer) and, with `nodes: true`, up to 500 nodes ready to draw. One placement service
  per canvas merges what the canvas asks into requests of 2,000 (500 with nodes), two at a time,
  the reader's own asks first; a busy or unreachable server is asked again, then *Couldn't
  place N · Retry*.
- **Search** groups results under their layer — *Placing…* while it is asked, *Not on this canvas*
  if the view draws it nowhere — and a layer says *N matches not loaded*, with Narrow and Export.
  **Show on canvas**, the drawer and Lens load an unloaded member into its layer, open the rows
  it sits in and scroll to it.
- **Narrow** loads every member the narrowing holds into its layer, behind the reader, with
  progress on the chip (*· N not in this view*); clearing it stops the load.
- **A subset's partners** come in only where the view places them; lineage cues name an unloaded
  partner's layer; a trace inside the view draws each card where the server places it.
- **A subset of a list view** lists each layer's members and what is inside them; everything
  else is in Other (its count a lower bound until read to the end). Hiding a base layer of more
  than 1,000 members answers `422 hidden_layers_too_large`.
- **Search scope:** ancestor counts read a layer-narrowed search's session; a view made from a
  query gates search by container types only (layers place, they don't gate); the property
  catalog and Explain read members past the root cap; a subset of a list view counts as
  bounded; Explain names a follow view's served layers.
- **Many at once:** **Keep out** and **Always include** act on a multi-selection (2,000 at a
  time).

## 4. Views made from a query stay what they are

- **The wizard** offers a list or subset view only as a Context View, with the steps that apply
  to it; the server refuses the rest (`list_view_context_only`, `made_by_its_route`).
- **The Explorer** marks them *Made from a query* or *Subset of X*, with their member or match
  counts; previews and draft review count a list view's members.
- **Duplicate** makes a proper copy: `POST /views/{id}/duplicate` makes a list view again from
  its definition and layout, its members worked out afresh, and a subset again with its search.
  The same `Idempotency-Key` carries one copy on through `202`.
- **Moving a snapshot**: its view file carries its members (`rows-v1`, outside the definition
  hash, within the bundle's 250,000), and import writes them back. A file without them works out
  its first answer once, even frozen. An import into a list view pins its entries, as before.
- **A `source` layout** that names a list view places each member where that view's rows have it.
- **A save without a preview** keeps every copied layer; auto layout keeps Other.
- **Export → This view** of a view that holds nothing is refused, for every kind of view, and a
  scope that can't be resolved fails the export instead of widening it.
- **API keys** read list and subset views: members, placements, layer exports and downloads (the
  token checked against the key), member sets, and saved narrowings. Writes stay off.

## 5. Two older fixes

- **A standalone FalkorDB** is no longer held to cluster timeouts: `cluster-node-timeout` is read
  and applied only in cluster mode, so a search keeps its 45 s.
- **A fresh install** builds the version store (`graphver` schema and partitions) before it
  stamps head, so graph reads answer 200, and `verify-schema` checks those tables.

## 6. Saving and opening that never give up

| | Before | Now |
|---|---|---|
| One turn's budget | 100 s, inside a 30 s request tier | `LIVE_VIEW_TURN_SECS` (20 s), never more than the tier less 8 s; a page starts only if 1.5× the average page still fits |
| Saving a large view | Waited for every member; cut off, said "took too long" | Answers `201` as soon as the view exists, after a first turn of `LIVE_VIEW_CREATE_TURN_SECS` (5 s): `status: updating` with `placed` / `members`. The browser retries `408/429/502/503/504`/no answer with the same idempotency key, saying *Still saving — trying again in N s* |
| A turn cut off | Kept its lease up to 300 s: everyone else "busy" | Releases it at once (bounded to 3 s) — after its claim, inside a handler's release and during a renumber too; the next opener carries on |
| The graph busy on the first turn | Left the view `pending` | Reads as `updating` (`graph_busy`) and fills in |
| Applying | Inside the lock, with old epochs deleted inline | Its own resumable step: diff and counts worked out before locking; the sweeper deletes old epochs after `LIVE_VIEW_EPOCH_GRACE_SECS` (10 min), keeping the last one for readers paging through it |
| Opening | Stopped on its first error; never for a snapshot | Keeps asking while `running`/`busy` (1→8 s, jittered), retries transient errors without a cap, waits while the tab is hidden, stops on a refusal |
| An update landing | Cleared the canvas and re-read every layer | Swaps each layer's page in place |
| Is it up to date? | Opened an engine scope to check | Compares the cache's content generation first |
| A view-members page | Three graph reads in series | Nodes and chains in parallel; names only for new containers, remembered per process (50k) |
| Preview, then save | Worked the draft out three times | Shared through the graph cache (15 min); a miss at save samples 5,000 |

On a 51,101-member view: the save's `201` in 5–7 s with 26,000 placed; one opening turn of 4.3 s
placed the rest; the final members are exact.

## 7. Settings

| Setting | Default | What it does |
|---|---|---|
| `VIEW_MEMBERS_FEED_MAX_ROWS` | `0` (was `5000`) | A ceiling on the members one list view layer lists; `0`: none |
| `DEEP_SEARCH_VIEW_FEED_MAX_ROWS` | `0` (was `2000`) | A ceiling on the rows one subset layer lists; `0`: none |
| `DEEP_SEARCH_VIEW_FEED_SESSION_ROWS` | `5000` | Rows one scan of a subset layer keeps before the next scan starts where it ended |
| `LIVE_VIEW_TURN_SECS` | `20` | How long one request works on a list view before answering how far it got |
| `LIVE_VIEW_CREATE_TURN_SECS` | `5` | How long saving places members before it answers `201` |
| `LIVE_VIEW_EPOCH_GRACE_SECS` | `600` | How long the last answer's members are kept after a new one is swapped in |

## 8. Rollout and verification

1. Upgrade; `20261120_1000_saved_narrowings` runs (`alembic upgrade head`). Check `alembic
   heads` shows one head.
2. With `viewMembershipEnabled` on, save a large narrowing as a view: it opens at once with
   *Working out its members…* and fills in without blanking.
3. Trace inside it: cards land in its columns, and the dock's files are not empty.
4. Save a narrowing, open its short link in another session, and read *+N new · −M gone*.
5. Scroll a large layer of a list view to its end; search a member far down it and **Show on
   canvas**; duplicate the view.

### Measured in the browser (dev stack, FalkorDB, 51k entities)

| Journey | Result |
|---|---|
| Save a 50,980-member narrowing as a lineage-stages view | `201` in 5.0–5.4 s; opens at once with *Placing its members… 48,000 of 50,980*; members drawn 0.4–0.7 s after the banner goes, never blank after |
| Trace from a seed inside that list view | 2,581 rows placed: Starting points 1, Consumers 7, Impact 2,567, Other 6 |
| Trace inside a follow view (50,980 members) | 385 rows, every one in its layer |
| A capped layer (50,820 members) | Reached its 5,000-row cap by scrolling; **Search in this layer** finds exactly 50,820; **Export** downloads 50,820 rows, each with its path |
| Save a narrowing, open its short link in another session | Saved (`201`, 2,557 held); reopened reads *+1 new · −2 gone since 19 Nov* against a planted difference |
| Export from the Narrowed bar | 2,557 rows; every row but the seed's top container has a parent |

## 9. Known limitations

- Nested under `or`/`not` or in a rule, a layer filter's 1,000-URN form leaves out the insides of
  whole members.
- The canvas keeps every row it loads; nothing is evicted (`VITE_CANVAS_LOADED_SOFT_MAX` is a
  switch, off).
- **Keep out** and **Always include** aren't offered from search results yet, only from the canvas.
- A subset of a list view can't hide a base layer of more than 1,000 members.
- Restoring a version or a staged import can still change a list view's kind.
- The saver's browser copy stays in one browser; everyone else exports what it shows now.
