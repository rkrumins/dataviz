# Subset views that work like any view, saved and shared narrowings, and saving that never gives up — 2026-11-19

Three reports, following the [2026-11-18 release](RELEASE_NOTES_2026-11-18_trace-share-export-views.md):

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

> **Operator action:** one migration, `20261120_1000_saved_narrowings` — a new, empty table;
> nothing is backfilled. Three new settings, all with safe defaults (§4). Saved narrowings are
> part of the `viewMembershipEnabled` preview, which ships off.

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
- **A capped layer** offers **Search in this layer** and **Export**: `POST
  /{ws}/graph/view-members/export` mints a ten-minute token for (view, epoch, layer, caller), and
  `GET …/view-members/download` streams keyset pages of 5,000 with each member's parent and path.
- **Save search as view** inside a follow view follows the view it follows; in a plain list view,
  the follow choice says why it can't be, in the server's terms. **Like** a following view copies
  the layers it is served.
- **Followed display rules**: the library answers the followed view's rules with `rulesFrom`; the
  property drawer shows them read-only, *From {name}*; rule writes answer `409 rules_followed`.
- **A past revision** of a list view says it shows only what was placed by hand.
- **A subset's data export** answers `422 subset_matches_export`; the export dialog offers **Export
  its matches**.

## 3. Saving and opening that never give up

| | Before | Now |
|---|---|---|
| One turn's budget | 100 s, inside a 30 s request tier | `LIVE_VIEW_TURN_SECS` (20 s), never more than the tier less 8 s; a page starts only if 1.5× the average page still fits |
| Saving a large view | Waited for every member; cut off, said "took too long" | Answers `201` as soon as the view exists, after a first turn of `LIVE_VIEW_CREATE_TURN_SECS` (5 s): `status: updating` with `placed` / `members`. The browser retries `408/429/502/503/504`/no answer with the same idempotency key, saying *Still saving — trying again in N s* |
| A turn cut off | Kept its lease up to 300 s: everyone else "busy" | Releases it at once (bounded to 3 s); the next opener carries on |
| Applying | Inside the lock, with old epochs deleted inline | Its own resumable step: diff and counts worked out before locking; the sweeper deletes old epochs after `LIVE_VIEW_EPOCH_GRACE_SECS` (10 min), keeping the last one for readers paging through it |
| Opening | Stopped on its first error; never for a snapshot | Keeps asking while `running`/`busy` (1→8 s, jittered), retries transient errors without a cap, waits while the tab is hidden, stops on a refusal |
| An update landing | Cleared the canvas and re-read every layer | Swaps each layer's page in place |
| Is it up to date? | Opened an engine scope to check | Compares the cache's content generation first |
| A view-members page | Three graph reads in series | Nodes and chains in parallel; names only for new containers, remembered per process (50k) |
| Preview, then save | Worked the draft out three times | Shared through the graph cache (15 min); a miss at save samples 5,000 |

On a 51,101-member view: the save's `201` in 5–7 s with 26,000 placed; one opening turn of 4.3 s
placed the rest; the final members are exact.

## 4. Settings

| Setting | Default | What it does |
|---|---|---|
| `LIVE_VIEW_TURN_SECS` | `20` | How long one request works on a list view before answering how far it got |
| `LIVE_VIEW_CREATE_TURN_SECS` | `5` | How long saving places members before it answers `201` |
| `LIVE_VIEW_EPOCH_GRACE_SECS` | `600` | How long the last answer's members are kept after a new one is swapped in |

## 5. Rollout and verification

1. Upgrade; `20261120_1000_saved_narrowings` runs (`alembic upgrade head`). Check `alembic
   heads` shows one head.
2. With `viewMembershipEnabled` on, save a large narrowing as a view: it opens at once with
   *Working out its members…* and fills in without blanking.
3. Trace inside it: cards land in its columns, and the dock's files are not empty.
4. Save a narrowing, open its short link in another session, and read *+N new · −M gone*.

## 6. Known limitations

- A cancellation between claiming and starting a turn, or during an epoch change, isn't released
  early; the 300 s lease is the backstop there.
- `/search/ancestor-counts` re-resolves a list view's scope without its layer, so badges for a
  layer-narrowed search don't find that search's session.
- A layer-narrowed search also finds what is under that layer's members (as listed roots always
  have); the nested 1,000-URN form leaves out the insides of whole members.
- `view-placements` and the layer export are not on the API-key surface, as `/view-members` isn't.
- A graph-busy error during the save's first turn still leaves the view pending (`graph_busy`),
  not `updating`.
- The saver's browser copy stays in one browser; everyone else exports what it shows now.
