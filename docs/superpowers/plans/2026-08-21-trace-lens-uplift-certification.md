# Trace & Lineage Focus at scale — certification record (2026-08-21)

Branch `feature/trace-focus-resilience` (19 commits on top of `main` @ `f3e7bd66`). Plan:
`~/.claude/plans/i-want-you-to-harmonic-lobster.md` (supersedes Stage 2 Tasks 2–4 of
`2026-08-21-trace-overlay-stage2.md`). Every number below was **measured on the dev stack** — the
backend probes with `scripts/trace_live_probe.py`, the browser runs with
`scripts/browser_probe_lens.mjs` / `scripts/browser_probe_trace.mjs` (chrome-headless-shell over CDP,
logging in through the app, the same requests the clients make).

**Estate:** `solidatus-test-large` (520k nodes; `object ⊃ group ⊃ attribute`, `FLOWS_TO` at attribute
grain), focus `urn:synodic:solidatus:object:OBJ-OqOh06l2` — a "table" with **2,935 lineage-bearing
columns, 17,567 hop-1 edges (10,359 down / 7,208 up), 1,824 partner containers**. Small control:
`solidatus-test` `OBJ-GD4jEypi` (51 columns).

## The three reports, before → after

| Report | Before (reproduced live, morning) | After (certified live, evening) |
|---|---|---|
| **1. Full flow parks at 1,000 nodes, "Keep walking" forever** | `FULL_WALK_NODE_BUDGET=1000`, +1 grant per click; per-anchor frontier drain (2,453 cursors after page 1). | No budget, no pedalling. Full flow on the wide table walks **hands-free to the one-time 50k checkpoint in 25 requests / 88 s** (was 52 req / 374 s mid-day, and unreachable in the morning), parks **once** with "Continue", narrates the whole way. |
| **2. One hop misses immediate partners** | Server page shipped **1,014 of 17,567** hop-1 edges, `upstreamUrns=984 / downstreamUrns=15`; client never paged; Lens drew ≤12 partner groups per direction. | Server pages are **degree-exact**: every shipped anchor is whole, both directions populated, `e:0` never minted, failures flagged (`timeout` / `seed_failed` / `nodes_failed`), `discovered ≤ max_nodes`. Seed drain of the table's hop 1: **17,567 / 17,567 edges, 20,212 nodes, COMPLETE vs Cypher truth** — 10 pages of 2k in 4.6 s, **2 pages of 10k in 2.5 s**. Lens One hop: **3 requests, complete in 7.1 s, 505 partner cards drawn, zero clicks** — no "Load more", no "Load everything", no "Load more contents". |
| **3. Table trace has gaps a column trace lacks** | Overlay seed looked only at edges touching the focus node — a table has none — so every partner table stayed hidden behind its closed lane root. | Partners are measured off the **focus side** (focus + contents); the way to each partner **card** opens (itself with contents, its parent for a leaf), the card stays closed with "N on this lineage". Tracing the table and tracing a column now agree (pinned on a raw-only table estate and on `Roots ⊃ Node ⊃ Node ⊃ Node`). Canvas trace of the wide table: **capsule from the first second, 50k checkpoint in 24 req / 46 s**, partner cards closed with counts. |

## What shipped (by commit, oldest first)

**Server — completeness contract** (`FalkorDBProvider.trace_closure`)
- `c1d44adf` degree-exact prefix walk: `_walk_anchors` / `_lineage_degrees` / `_expand_prefix` (LIMIT ΣD+1 drift check) / `_hub_page`; enumeration once per page (`cap = max_nodes+1`, inclusive-next `seedCursor`); fair direction shares; cursor-less `cut`/`depth` frontier entries with `TraceFrontierNode.reason`; timeouts follow the deadline (the six 1.5 s clamps are gone); no silent loss.
- `375421a5` `TRACE_MAX_NODES_HARD = 10000` (engine clamp, salvaged from `bb6bd866`).
- `5c060f36` `seedCursor` legal with `seedUrns` (a container card pages too); endpoint docstring states the contract.
- `ff2e5ccf` a `max_nodes` page is complete by contract → cached for the full TTL; `GRAPH_CACHE_MAX_PAYLOAD_BYTES` env.
- `4c682172` containment pair fetch bucketed by parent label (4.6 s → 0.8 s per page).
- `3622cf28` `scripts/trace_live_probe.py` — page / drain / Cypher truth / `--dump`.
- `4fdd05c9` `hiredis>=3.0` — the C parser (was ~1.2 s of pure-Python reply parsing per wide page, and the source of the event-loop-lag warnings). **Installed in the running container only — the image needs a rebuild.**

**Client — hands-free walk** (`useLensWalk`, `closure-adapter`, Lens)
- `fdda9f65` phase machine `loading → seeding → walking → done | checkpoint | error`; one hop drains seed pages + `cut` entries (bulk `seedUrns`), full flow drains `depth` too; `TRACE_CHECKPOINT_NODES = 50_000` asks once; request failsafe surfaces as an error; AbortController on close; narration chip; the strips that remain are Continue / Try again.
- `14ab39d4` everything fetched is drawn (`layoutView.pinned` = every model node in both modes).
- `20c9e96b`, `d06e8a27` layout correctness at scale (pins open the way to their entity; partner layers are chrome) and O(1)-indexed layout helpers (20k-node board: 61 s → 158 ms).
- `079f1ecb` C4: the camera holds while the walk lands cards and offers "Board grew · Fit"; zoom floor 25% → 2%; off-screen culling (paused for PNG export; off under vitest).
- `c5d772df` `boundaryHops` memoised per immutable subgraph — it was **25 s of every 60 s** in the browser profile (called per ⊕ pill per render, each a pass over 46k hops).
- `68046d62`, `be90eef9` adaptive pages: first request 600 nodes (first paint is a render, not a fetch), every continuation 10,000, bulk batches at the wire cap of 500.

**Canvas overlay — Part D** (`useTraceOverlay`, dock, capsule)
- `9f3ad3e8` seed from the focus side; per-wave additions derived (never a render-time write); nothing the reader closed re-opens.
- `779f290a` dock strip in native mode: checkpoint → Continue, failure → Try again; never "Reduce depth" (pure view scoping on this engine).
- `698edfcb` `TraceWalkIndicator` capsule on the driver's phases; `dab8740a` the browser probes.

## Measurements worth keeping

| Probe | Value |
|---|---|
| Wide table, hop 1, server drain at 2k / 6k / 10k pages | 10 pages 4.6 s / 4 pages 3.1 s / 2 pages 2.5 s; warm single page 493 ms; payload 2.5 MB → 234 KB gzipped |
| Lens One hop, browser | 3 requests, first cards ≈2.5 s from navigation, complete 7.1 s, 505 cards, Fit lands at zoom 0.05, zoomed in the DOM culls to ~200 cards |
| Lens Full flow to the 50k checkpoint, browser | 25 requests / 88 s (morning: parked at 1,000; mid-day: 52 req / 374 s → 235 s after C4 → 144 s after the memo → 88 s with big pages) |
| Canvas trace to the 50k checkpoint, browser | 24 requests / 46 s, capsule from t≈1 s |
| Backend suites | 30 new completeness tests + structural/wire/API/cache suites green; live gate (`tests/integration/test_trace_closure_live.py`, wide-table + ragged `Node` fixtures) 33 passed |
| Frontend | 3,006 tests / 318 files green; `tsc` 61 (baseline); eslint on the 16 changed files: 62 errors at `origin/main`, 62 at HEAD (none added) |

## Rulings honoured

No budgets, no pedalling; one hop loads **and draws** every immediate node with zero clicks; one-time
memory checkpoint at ~50k; boards grow (no partner-frame caps); the rule set is ontology-agnostic
(`Node ⊃ Node ⊃ Node → Node` with partners at different depths is covered by tests on both surfaces);
raw evidence wins. Never a percent or a spinner — counts tick.

## Evening additions (2026-08-21 → 22): fan-in bundles and the coarse first paint

**Fan-in bundles (Part H; `feat(lens): a wide band folds its cards into the containers they sit in`).**
The user's case: 100+ inputs and 100+ outputs — 200+ partner tables drawn one card each, "so tiny
when opened", sharing 18 databases. The morning's "draw everything" change had the Lens walk every
container through to the table grain. Now the judgement is the **band's**: past `BAND_BUDGET = 12`
top-level cards, each card folds into its own parent, which becomes a frame showing its strongest
`BUNDLE_WINDOW = 5` rows with "N more" behind; one level only; a host that also holds chrome is not
the grain to fold at; never above the focus; overrides the sticky walk-through in the grow direction
only. The rule reads parent pointers and the hop grain — no type, label or level — and is pinned on
three hierarchies (Domain→Department→Database→Table→Column, Root→Node→Node→Node, Data Domain→App→
Container→Container→Table→SchemaField). Density is the reader's **preference** (`lensDensity`,
persisted, v3 migration): **Overview** (hosts closed with counts — "start at the high level"),
**Grouped** (default, user ruling), **Every card**; separate from chain folding, which stays off by
default under the earlier ruling. Browser, wide table: Grouped draws **15 nodes at zoom 1.27**
(was 505 at 0.05); Overview 5 nodes; Every card the 505; the "17,567 connections" chip identical
across all three.

**Coarse first paint (Part G; four commits `feat(trace): the coarse page…` → `feat(lens,trace): …one
rule decides card or host`).** `grain: coarse` on the closure request asks the provider's rollup lane
(`trace_closure_coarse`) for every `:AGGREGATED` cell incident to the focus, both directions, with
each partner's ancestor chain and containment, weight and depth stamps on `properties`, no frontier,
no cursor; engine fallback to the fine walk (result says `grain`); 422 with a cursor or seeds; the
cache key separates grains and an old client's key is byte-identical. The driver fires the coarse
leg beside the fine first page — whichever lands first draws, the other merges without authority
(pinned: coarse-then-fine == fine-then-coarse), the phase stays `seeding` while the fine leg is out.
One accounting rule for both boards (`accountRollups` extracted from the canvas ledger;
`rollupResiduals` decides card vs host): a cell weighs W in degrees, crossings, bundles and neighbour
records, draws coarse ("≈W flows") wherever it is, a partner whose rows have not landed says
"≈W flows", the focal's orientation reads coarse partners as a "≈N" floor, and once the walk is done
every raw-backed cell is dropped — raw evidence wins. Live: the wide table's coarse page ships
**386 cells, Σweight 18,005 == Cypher truth, 85 ms cold / 20 ms warm**; a seeded cell estate proves
inner-first accounting reproduces the raw count (database/department residual 0 → hosts). Browser,
Lens one hop: **first cards 212 ms after the first request** (21 cards from the coarse page),
complete at 7.2 s in 4 requests. Canvas trace: narrates from ≈1.1 s, 50k checkpoint hands-free.

**Partner grain (2026-08-22, from the user's screenshots; commits `feat(lens): the density rung decides how
the partners LAND…` and `…shows its strongest five rows…`).** The Tableau one hop was at half zoom with six
tables per band — under any card budget, but every table opened to eight column rows: the cost was rows.
The density rung now says how a partner LANDS: **Overview** closed (the card, its count on its own line,
its chevron), **Grouped** the strongest `OPEN_PARTNERS_PER_BAND = 3` per band open to their strongest
`BUNDLE_WINDOW = 5` rows and the rest closed, **Every card** all open; a partner the reader opened stays
open at any rung with the full window. Two defects from the same screenshots: the focal said "Fed by 11
sources" over an empty upstream band (a container whose contents feed each other — Reach now counts
partners outside the focus side), and "One hop" drew a HOP 2 band (a 2/3 left in storage by the retired
depth control — v4 migrates it to 1). Browser, Tableau one hop: Grouped 27 nodes at zoom 0.60 (was 44 at
0.36), Overview 12 at 1.36, Every card 44 at 0.36.

Suites after both parts: frontend **3,083 tests / 322 files** green (`ActivityFeedList` flaked once
across midnight and passes alone); backend unit 233 + live gate 35 green; `tsc` 61; eslint on the
touched files clean.

**Siblings group under their parent (2026-08-22 morning, from the Executive Board Dashboard screenshots).**
Five fact tables sharing GOLD were five loose cards each saying "⋯› GOLD", because the bundle rule waited
for a band to pass a 12-card budget. The budget is gone: cards sharing a parent fold into a frame under it
whenever there are **two or more** of them, at Overview (host closed, one click shows the rows) and Grouped
(host open to its strongest five rows); a lone child stays a card — grouping one thing is a click for
nothing; Every card is untouched. Same screenshots, second defect: the "⋯› GOLD" crumb on a closed card was
the one crumb on the board that was not a button (frames, the focal and the peek all re-anchor on click) —
it is now, so the way UP the containment exists at every rung. Browser: dashboard at depth 2 — Grouped
21 nodes (GOLD one frame, five rows), Overview 11 (GOLD one card, one ×14 wire), Every card 36; Tableau one
hop — Grouped **14 nodes at zoom 1.36 (was 27 at 0.60)**, Overview 9 (was 12), Every card 44 unchanged.
Known and left: at a 1600 px window the Lens header's focal chip wraps over the NEXT control (present
before these changes).

Suites: frontend **3,084 tests / 322 files** green (the d3-drag jsdom error from the perf drag test is the
known pre-existing one); `tsc` 61; eslint on the touched files unchanged.

**The board says it is calculating (2026-08-22, user: "the loading state can be missed and the user might
confuse that for nothing happening").** The Lens's loading surfaces were ten pixels of muted header text and
a toast at the foot of a full-screen board. It now mounts the canvas trace's own capsule (`TraceWalkIndicator`)
at the top-centre of the board from the moment Focus opens — "Mapping the lineage of *Executive Board
Dashboard*" with the sounding line, then "Loading the immediate lineage · N nodes · M flows · K requests",
then one 600 ms beat of "Complete — N nodes · M flows" before it leaves by itself. Computing phases only:
the checkpoint and a failed step keep their strips (the capsule decides nothing on the Lens, and offers no
Cancel — the Lens's way out is its own close). The capsule grew three things for this: a `subject`, an
optional `onCancel`, and "mounted already `done` = quiet, a later wave re-arms" — which also stops the
canvas flashing "Complete" when a cached focus is re-traced. The header's narration stays as the quiet
record; the "Board grew · Fit" pill drops below the capsule while the walk runs. Before the first page
lands the Lens can only derive the focus's label from the URN, so the canvas now hands it the name it knows
(`focalLabelHint`) — the header and the capsule never open on `executive_board_dashboard_de06a1ba` when the
lens is opened from a card (a cold share-link open still can, until the canvas has loaded the node).
Browser (probe now records and screenshots the capsule): capsule in the DOM at 0.8 s from navigation, the
board's first cards at 1.28 s, "Complete — 36 nodes · 29 flows" at 1.3 s, then gone.

**Header wrap (same day).** At a 1,600 px window the Lens header's ~1,350 px control cluster crushed the
focal chip into a three-line stack over NEXT. The header row wraps: title first, controls under it when they
do not fit beside it, the close button anchored to the dialog's corner either way. Verified in the 1,600 px
screenshot; no jsdom pin (layout only).

**Four points from the user's own testing (2026-08-22 afternoon).**
1. *The header explains itself.* Every segmented control (NEXT · WALK · STEPS · DENSITY · direction ·
   Graph/List) and every group caption carries a styled popover — name in bold, one sentence of meaning —
   shown on hover/focus and wired as the control's `aria-describedby` (`lens/ControlTip.tsx`, CSS-only like
   the board's `IconTip`). The browser's `title` boxes are gone from those controls. Verified by hovering
   Grouped in the headless browser.
2. *Room between bands.* `BAND_GAP` 130 → 240: a frame is wider than a card by its padding and gutter, so
   the clear run from a frame to the next band was ~60 px for five wires and their ×N badges. Now plain cards
   get 240 px of wire and a busy frame (four gutter lanes) ≥ 120 px; pinned on the geometry. Two layout pins
   changed with it: the "too short for a badge" stub now holds one, and the ten-row fan finds a slot for
   every badge (the layout's honest `seamSlotted` signal is unchanged, the room is not).
3. *The focus first.* A new picture used to be fitted whole whatever its size. Now: a board that reads at its
   fit zoom (≥ `FOCUS_MIN_ZOOM` 0.75) is fitted whole as before; a larger one opens CENTRED ON THE FOCUS at a
   readable zoom (`useFrameCamera.frameFocus`: focus + one band either side, headroom of 140 px above a tall
   focal so its header lands under the capsule). A layout-mode switch (density · steps · direction) re-frames
   the focus the same way (`recenterKey`); the control stack gained "Center on the focus" (`LocateFixed`,
   top of the stack) = `camera.recenter()`; and when a hands-free walk ENDS the camera settles on the focus
   once — unless the reader moved the camera themselves (`onMoveStart` with an event), in which case the
   "Board grew · Fit" offer stays. Wide table: switching to Every card lands at zoom 0.98 centred on the focus
   (was 0.05, a sliver); Grouped/Overview 0.89 fitted whole.
4. *Progress you can read.* The capsule (both boards) gained the four stages every walk has — Focus · Picture
   · Flows · Drawn — as a stepper saying which one it is on; "N requests · M more to go" from the driver's
   own frontier count (a floor, never a percent); elapsed seconds after 3 s; a beat on the sounding line per
   page landed and a tick on every number that changes; a rotating line of guidance after 4 s (6 s per line,
   per board). Its clock is the interval itself (no wall-clock reads in render, no setState in effect bodies —
   the hooks lint forbids both). The Lens board under the first fetch shows `LensSkeleton`: the picture's
   ghost — sources → focus → consumers, shimmering — until the first cards exist. Wide table timeline: capsule
   at 0.8 s (skeleton under it), seeding at 1.6 s with counts, guidance at 5.2 s, "Complete — 20,212 nodes ·
   17,953 flows" at 7.9 s, gone at 8.6 s.

Suites: frontend **3,110 tests / 322 files** green (the known d3-drag jsdom error), `tsc` 61, eslint on
touched files at the HEAD counts (one pre-existing fast-refresh warning).

**Three more (2026-08-22, late afternoon).** (1) *The List body is retired*: the Graph | List toggle is
gone, `lensViewMode` migrates `'list' → 'graph'` (preferences v5), the list branch stays one release
behind the store for rollback and is marked `@deprecated`; the guided tour's step on it became a Density
step (`data-tour="lens-density"`). (2) *Docs*: the User Guide's Lens page (density/grouping, the capsule
and stages, Walk modes, Center on the focus, no depth control, no footer actions, no List) and the canvas
Trace section of Exploring the Graph; the Documentation section's Context Engine page gained the
`/trace/closure` contract (request/result fields, the six invariants, coarse first paint, caching) and the
Frontend reference lists the Lens/trace pipeline files. (3) *The Path names where you have been*: the trail
read each chip off the current model, so a focus you had left fell back to its URN fragment
(`gold_af963e43 › Snowflake › …`); the lens now remembers every name it has shown and asks the canvas
(`labelHintFor`) for stops it never drew. Frontend 3,113 tests green (`ShareViewDialog` flaked once under
the full run and passes alone — unrelated), `tsc` 61.

**Center on focus, findable (2026-08-22, evening).** It was one icon in the corner stack. Now: a labelled
**Center on focus** button in the header's navigation cluster (beside Back/Forward, right after the name),
explained on hover like every control; and on the board a solid pill — "Center on the focus" — that appears
exactly when the focal card has left the screen (`useFrameCamera.focusInView(viewport)` asked on every
React Flow `onMove`) and leaves when it is back; the stack icon stays. Browser: drag the board two screens
away → pill + header button present; click → focus centred at zoom 0.98, pill gone.

**A cold open lands on the focus (2026-08-22, evening; `08dcd9d3`).** Three camera causes of "the focus is
tiny until I click Center on focus": the empty board was stamped as framed (so the real first paint was held
as an arrival during the walk), React Flow's own fit-on-init framed the coarse first paint whole a beat before
the camera could, and the end-of-walk settle's timer was cancelled by the re-render `done` causes. Now: nothing
is framed until there is something to frame, no `fitView` prop, the edge is detected on `walking` alone and
remembered until the settle runs, and the settle fires after any held change (rows filling frames). Cold open
at Grouped on the wide table: settled at zoom 0.91, "Board grew" cleared.

**Wire bundles (2026-08-22, evening).** "500 incoming/outgoing edges simply turn into one thick mass" — seen
in Grouped, where wires land on rows. A pair of containers with more than `WIRE_BUNDLE_THRESHOLD` (12) wires
between them draws ONE bundle (Auto, the `lensWires` default; Bundled folds every pair; Every wire none): a
heavier stroke (log of its members), a user-space arrowhead, the sum as its badge. The members move to
`FocusGraph.bundledWires` and come back for the cone's anchor (hover), the selected or isolated card, a frame
(every row's wires), or a hovered bundle — a click pins them. React Flow marks unselectable edges `inactive`
(no pointer events), so a bundle carries its own hit path. Header: WIRES · Auto / Bundled / Every wire, each
explained. Wide table at Grouped: Every wire 108 wires; Auto/Bundled 4 (two bundles, ×423 and ×598/×701);
hovering a bundle fans out 53 members; the bundle fades to 0.28 beneath them.

**Two defects from the user's testing of the bundles (2026-08-22, late).** (1) *The header overflowed*: a
wrapped control cluster still ran past the dialog's edge and was clipped. It is now ONE row that never
overflows — `useToolbarOverflow` measures the row and each group and folds the least-used groups into a
**Display** menu (Radix Popover, z-[9999] above the Lens) in priority order `direction · density · wires ·
walk · steps · next`, so the day-to-day controls stay in reach; the title and navigation never shrink (the
groups fold instead). At 1,600 px: direction + Density + Wires inline, "Display 3"; at 2,000 px everything but
Steps/Next. (2) *Bundles vanished on Bundled/Auto*: the layout was right (17 bundles from the Snowflake focal),
but React Flow measures a node's handles once — a card that GAINS ports after mount (a focus that had no wires
of its own becoming a bundle's endpoint) kept an empty handle measurement and its edges were silently dropped.
`FocusNode` now calls `useUpdateNodeInternals` when `card.wired` flips (never on mount, never in a headless
DOM — jsdom lacks DOMMatrixReadOnly). Snowflake at Every card: Bundled 7 bundles on screen (11 wires) vs 51.

**The header, rebuilt as categories (2026-08-22, night).** Even folded, six captioned segmented groups
crowded the search box off the row ("I cannot even search anymore"). The header is now two rows: identity,
navigation and SEARCH (always) on the first; on the second, one **category chip** per axis — Direction ·
Density · Wires · Walk · Steps · Next — each showing its current value and opening a menu (`ViewControl`,
Radix Popover, `role=menu` of `menuitemradio`) where every option carries its name and a line of meaning,
the current one checked; the chip's own meaning is the hover (quieted while its menu is open), arrow keys
walk the options, Esc/outside closes. Six chips are ~900 px, so they fit on one row down to ~1,100 px; below
that the chips row folds its least-used categories into **More** (same `useToolbarOverflow`). Tests choose
options through `chooseView`/`viewValue` (`src/test/lensView.ts`); the tour anchors moved onto the chips.
Browser: 1,600 and 1,100 px — all six chips inline, search intact; the Density menu lists its three options
with meanings and the check on the current one.
Then the blank space: the Path trail moved from its own row into the first row's middle (flex, scrolls
sideways on a long walk) and the type chips onto the right of the chips row (flexible — they shrink and
scroll, never fold a category into More) — two rows where there were four, no blank band. 2,000 px:
name · Back · Center on focus · PATH GOLD › Tableau › Snowflake · search · help · share · close / six chips ·
six type chips.

**Direction first class + the status bar (2026-08-22, last).** Direction became an always-expanded segmented
control at the head of the controls row — "which side of the story is the question itself, not a setting" —
and never folds into More. The footer, one italic sentence of hints over a wide blank, is now a **status
bar**: gestures as keycaps on the left (dropping the least-critical caps at narrow widths rather than
clipping mid-word), a legend of what the four wire kinds mean in the middle, and live board facts on the
right ("27 cards · 21 wires · 2 bundles · 79%", the zoom read on move-end). The header's middle, blank
before a walk, now carries the Path's own empty state ("Double-click a card to focus it — your path appears
here"). Verified at 2,000 and 1,280 px.

**Browsing speed, measured and fixed (2026-08-22, night).** A new probe mode (`INTERACT=1`) records Event
Timing (input → paint, and how much of it was our handlers) plus a CPU profile over a scripted sweep: 80
hovers, 6 expands, 6 keystrokes on the wide table at Every card (505 cards).

| Interaction | Before | After |
|---|---|---|
| Expand a container (click handler) | **365 ms** mean, 737 ms worst | **52 ms** mean, 140 ms worst |
| Keystroke in the filter (input handler) | **325 ms** mean, 360 ms worst | **25 ms** mean, 50 ms worst |
| Worst input→paint over the window | 1,104 ms | 432 ms |
| Hover (handler) | ~0 ms | ~0 ms (already free — the subscription stores) |

Four changes, each measured: (1) **the filter is a post-pass** — `query` only ever set `dimmed`, so it left
the layout entirely (`applyQueryDimming` over the finished board; an empty filter returns the same object,
and an equivalence test pins that laying out WITH a query equals dimming a query-less layout); (2) **the
model's answers are cached against the model** — `ancestorsFor`/`subtreeFor` in a WeakMap (`model-cache.ts`)
rather than rebuilt inside every `buildFocusLayout` (98 + 66 ms per window); (3) **`projectLensEdges`
memoises its parent walk** and fills the whole chain per walk (168 → 136 ms on 17.5k hops); (4) **every
structural edit runs at transition priority** (`editView` → `startTransition`) and the filter's dimming
through `useDeferredValue`, so a click or a keystroke never blocks the next input. Perf suite gained a
ratio pin: dimming a board costs less than a quarter of laying it out.

**The mini map (same night).** Bottom-left, opposite the control stack: the focus in indigo, upstream cyan,
downstream amber, the viewport framed in the accent; pannable and zoomable, so it is a way to travel.
Offered once the board has ≥ 8 cards — below that a board is its own map.

**Spacing under exploration, and a richer map (2026-08-22, last).** Reported with three screenshots —
initial, one expansion, two — each worse than the last: the next band was drawn ON TOP of the focus column.
Cause: band x was a fixed pitch (`band * (CARD_W + BAND_GAP)`) while a frame is as wide as what it holds and
every level opened inside it widens it again. `layoutBands` now measures: walking out from the focus, each
band starts a full `BAND_GAP` past the right edge of the one inside it (an empty band still holds a column's
worth, and a board of ordinary cards keeps exactly the old geometry). The map of band positions is exposed
as `FocusGraph.bandX`, which the band labels and the extend ghost read so they agree with the cards. Pinned:
a plain board is unchanged; two nested opens keep ≥ `BAND_GAP` between every pair of bands; the exposed map
matches the cards. Browser, the reported scenario at Overview: partial card overlap 0 px at every step
(initial → one expansion → two).

The mini map became a **panel**: the app's own `glass-panel-subtle` chrome (the canvas behind the Lens uses
the same), a header that names it and folds it away, each card in the colour the board paints it (the same
`visualFor`), the focus in the lineage accent, the two sides on the node strokes, the viewport framed in the
accent — and **click a card to fly to it**.

## Not built, and why

- ~~Coarse first paint~~ — built in the evening on the user's call (see above).
- Phase 2 of the fan-in work: compact single-line cards + multi-column packing for Every card and for
  bands whose parents are themselves numerous; synthetic bundles by (entityType, edgeType) for
  partners with no shared container at all.
- **Merge coalescing (B6)** — two responses per round still mean two layouts. Remaining per-wave cost
  late in a 50k walk is ≈7 s, dominated by React rendering ~2,500 cards that sit inside the viewport
  at fit-all zoom (culling only helps zoomed in).
- `excludeUrns` is capped at 2,000 on the wire, so deep in a 50k walk the server re-ships nodes the
  client already holds (deduped on merge). A server-side "walked set" exclusion would cut that.

## Ops — DONE 2026-08-23

- ~~Rebuild the backend image so `hiredis` is durable~~ — done. The image now carries `hiredis 3.4.1`
  and the service reports `_HiredisParser`; `docs/SETUP.md` gained "After pulling: rebuild when Python
  dependencies change", because the failure mode is silent (the container keeps running without it).
- ~~`GRAPH_CACHE_MAX_PAYLOAD_BYTES=8388608` on dev~~ — done, and not only on dev: `docker-compose.yml`
  now sets it for every service with a cache client, so the stack's default is 8 MiB. Verified end to end:
  a 2,516,657-byte closure page is present in the cache Redis, where the 1 MiB cap used to drop it.
- The user's real environment runs code without this branch; none of this reaches them until the PR to
  `main` merges and deploys.
