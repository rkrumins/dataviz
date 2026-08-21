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

## Not built, and why

- **Coarse first paint from `:AGGREGATED` rollups (plan A7/B5/C3/D5).** Re-checked against the
  numbers after the fine path landed: the canvas trace paints at ≈1.2 s and the Lens at ≈2.5 s, and
  the Lens's cost is the render of page 1, not the fetch (server 0.3–0.5 s). A coarse page would
  paint the partner-table picture ≈1 s earlier on the Lens at the cost of a second wire grain in the
  Lens layout (raw-wins accounting per pair, residuals, staleness of a derived cell). The small first
  page (`be90eef9`) took most of that gain for one line. Worth revisiting only if a real estate shows
  a first paint the reader waits on.
- **Merge coalescing (B6)** — two responses per round still mean two layouts. Remaining per-wave cost
  late in a 50k walk is ≈7 s, dominated by React rendering ~2,500 cards that sit inside the viewport
  at fit-all zoom (culling only helps zoomed in).
- `excludeUrns` is capped at 2,000 on the wire, so deep in a 50k walk the server re-ships nodes the
  client already holds (deduped on merge). A server-side "walked set" exclusion would cut that.

## Ops before this reaches the user's environment

- Rebuild the backend image so `hiredis` is durable (it is installed in the running dev container only).
- `GRAPH_CACHE_MAX_PAYLOAD_BYTES=8388608` on dev so wide pages are cacheable (today's 1 MiB cap leaves
  every 2.5 MB page uncached).
- The user's real environment runs code without this branch; none of this reaches them until the PR to
  `main` merges and deploys.
