# S0 findings — what FalkorDB can do for uncapped, typed property search

The S0 spike measured the building blocks of the search engine before it is
built: which statement shapes FalkorDB 4.18 executes well, which it
executes wrongly, and what they cost on a million-node graph. Every
number below comes from the committed scripts, and every predicate in
them is compiled by the real compiler (`falkordb_deep_search._Compiler`),
so the timings are for the typed Cypher that production runs.

- Seed a graph: `backend/scripts/seed_search_bench.py`
- Measure it: `backend/scripts/bench_search_engine.py`

## Decisions

These are the choices the measurements support. Section 12 describes
the engine built on them.

1. **Scan a label in ID ranges, 50k nodes per chunk, two chunks at a
   time per interactive search.** A labelled `ID(n)` range is a seek
   (`Node By Label and ID Scan`). Chunk width does not change
   throughput (about 1M nodes/s per engine thread for a cheap
   predicate). Small chunks report progress sooner, cancel sooner, and
   never hold an engine thread for long. With 50k chunks, the p95
   chunk takes 60–185 ms; only property-name patterns take longer
   (527 ms).
2. **One statement per chunk returns the exact count and the ordered
   top-k.** Use `ORDER BY` on a `WITH`, then
   `count(*), collect(...)[..k]`. The collect holds at most one
   chunk's matches, so memory stays bounded. It was never slower than
   two separate statements, and was up to 1.9× faster.
3. **Every sort key is computed in Cypher, and Python merges the
   chunks' top-k by the same keys.** FalkorDB orders strings by bytes,
   exactly as Python orders `str`. It cannot order large integers,
   though: `ORDER BY`, `>`, `max` and `min` all wrap. So a number sorts
   by its sign first, then its value.
4. **A view's roots are sought by ID, never by an unlabelled
   `root.urn IN` anchor.**
   - Small subtrees are walked in one statement: a 104k-node subtree
     plus the predicate takes 172 ms.
   - Large ones are clamped per chunk with an upward containment check
     after the predicate.
   - A bounded walk decides which applies: 57 ms to learn that a
     subtree has more than 50k nodes.
5. **Rule counts run one `WHERE` count per rule.** Ten rules over
   949k nodes take 3.91 s at 4 concurrent. Summing all ten in one scan
   takes 38.15 s, because projections do not short-circuit.
6. **Membership uses boolean projections, each wrapped in
   `ANY(_z IN [0] WHERE …)`.** FalkorDB short-circuits inside the wrap.
   1,000 URNs × 10 rules take 36 ms (65 ms unwrapped).
7. **Two things need the P3 property catalogue at this scale.**
   Property-name patterns (`keys(n)`) cost 4.3 s per million nodes,
   and value suggestions 1.0–1.5 s. The catalogue resolves name
   patterns to concrete keys and serves top values. The live scan
   stays as a top-up.
8. **A list of node IDs is sought with
   `UNWIND $ids AS i MATCH (n) WHERE ID(n) = i`.** `ID(n) IN $list` is
   an all-node scan.

## 1. Environment

| | |
|---|---|
| Engine | FalkorDB 4.18.3 (module `graph` ver 41803) from `falkordblite` 0.10.0, on Redis 8.6.2. CI's live job pins 4.18.11. |
| Machine | 4 vCPU, 15 GB RAM, `THREAD_COUNT` 4 |
| Graph `bench_1m` | 1,000,000 nodes: Domain 50, Container 500, Dataset 50,000, SchemaField 949,450 |
| Edges | 999,950 `CONTAINS` (one parent each) and 474,725 `TRANSFORMS` |
| Memory | 1.09 GB used (graph 548 MB; SchemaField attributes 303 MB) |
| Seeding | 65 s |

Node IDs are dense and in creation order, so each label occupies a
contiguous band. SchemaField, for example, holds IDs 50,550–999,999.

Every node carries the platform fields the provider writes: `urn`,
`displayName`, `qualifiedName` and `searchableText`, with a range index
on `urn` per label. It also carries the typed user properties the
reported failures involve:

| Property | Values |
|---|---|
| `gvHash` | int64 across the whole range |
| `sourceId` | numeric text |
| `code` | zero-padded text |
| `score` | floats |
| `owner` | text; 5,000 values, Pareto-skewed |
| `labels` | lists |
| `mixed` | a number, or text |
| `updated` | ISO timestamps with and without offsets, some date-only |
| `isPii` | a boolean, or the text "true" / "false" |
| `tier` | text; missing on a fifth of nodes |
| `rowCount` | int (datasets only) |

To reproduce:

```sh
python -m backend.scripts.seed_search_bench --nodes 1000000 --graph bench_1m
python -m backend.scripts.bench_search_engine --graph bench_1m --width 50000
```

## 2. Assumptions checked

Plans were read with `GRAPH.EXPLAIN`.

| # | Assumption | Result | Consequence |
|---|---|---|---|
| A1 | A label-less `ID(n)` range is a seek | Yes: `NodeByIdSeek` | Gate mode is possible, but not needed (A2 holds) |
| A2 | A labelled `ID(n)` range is a seek | Yes: `Node By Label and ID Scan`. It stays a seek with extra predicates (`Filter` above it). | The per-label chunk scan |
| A1b | `ID(n) IN $list` seeks | **No**: `All Node Scan` + `Filter` | Use `UNWIND $ids AS i MATCH (n) WHERE ID(n) = i` (`NodeByIdSeek` per ID). 104k member IDs + predicate: 208 ms |
| A3 | Edges can be chunked by source-node ID | Yes: `NodeByIdSeek` / label-and-ID scan, then `Conditional Traverse` | P5b edge scans |
| A5 | Per-label `n.urn IN $param` is an index scan | Yes: `Node By Index Scan`, and also `UNWIND $u AS x MATCH (n:L {urn: x})` | Membership, root and visible lookups |
| A6 | The range index serves `=`, `IN` and ranges | Yes. `STARTS WITH` and `<>` are not served. A correlated `r.urn IN bucket` inside `CALL {}` is **not** served (label scan). | Only parameter lists, never correlated lists; typed comparisons use no index (P7) |
| A7 | Upward ancestry is affordable | 1,000 URNs, `<-[:CONTAINS*1..12]-`: 26 ms warm (80 ms cold) | Ancestor badges and scope clamps |
| A8 | Ordered top-k and count in one statement | Yes: `ORDER BY` on a `WITH`, then `collect` keeps the order. An `ORDER BY` on a `RETURN` after an aggregation is dropped. | Decision 2 |
| A9 | Conversions and text functions on every stored kind | Many sharp edges (section 3) | The typed compiler (`falkordb_typed_ops.py`) |
| A10/A11 | `keys(n)` and dynamic `n[$k]` work | Yes. `keys(n)` over every node costs 4.3 s per 1M. | P3 catalogue |
| A12 | Full-text indexes | `db.idx.fulltext.createNodeIndex` / `queryNodes` work; the index populates asynchronously | P5c stays optional |
| A13/A16 | Throughput with parallel chunks | ×4 concurrent ≈ 3.5× sequential on 4 threads (section 5). Not measured against canvas load. | 2 per interactive search, not 4 |
| A14 | Boolean projections for membership | Work. Wrapped in `ANY(_z IN [0] WHERE …)` they short-circuit and run 1.8× faster. | Decision 6 |
| A15 | Native edge properties | Not measured (P5b) | — |
| A17 | A label-bucketed root union | `UNWIND $buckets … CALL { WITH b MATCH (r:L) WHERE r.urn IN b }` is a label scan | Resolve roots per label with parameter lists, then seek them by ID |
| A18 | Collation parity with Python | Yes: `ORDER BY` and `>` on strings are byte-wise, identical to Python's `sorted(str)` (checked on ASCII, Latin-1, Greek, CJK, NBSP, İ) | Python can merge the chunk top-ks |

## 3. Engine behaviours

These shape the typed compiler. Each one broke a query before it was
handled. `falkordb_typed_ops.py`'s docstring and
`tests/test_typed_compiler.py` hold them as rules, and the live parity
test (`tests/integration/test_search_semantics_live.py`) checks 739+
comparisons against the Python reference evaluator.

**Evaluation**
- `CASE` evaluates every branch, so a guard must sit inside the
  function argument, not around the call.
- `AND` / `OR` short-circuit in a `WHERE` and inside
  `ANY(… WHERE …)`, but not in a `RETURN` or `WITH` projection.
- Comprehension variables are not scoped: a bare `p` or `s` reads a
  path query's own variable. Every compiled variable is `_`-prefixed.

**Conversion**
- `toString`, `toLower`, `size` and `STARTS WITH` raise on the wrong
  type and abort the whole query. `toStringOrNull` is total.
- `toJSON(float)` prints `%.15g`; `toJSON(vector)` raises.
- `toFloat` and `toFloatOrNull` parse text at 32-bit precision
  (`0.1` → `0.100000001490116`). They also accept hex, `nan` and
  `inf`, and return null on overflow. Numeric text is therefore read
  as digits: `toIntegerOrNull` of the integer part, plus
  `split(…, '.')` / 10^k.
- `toIntegerOrNull` follows `strtoll`: leading whitespace and a sign
  are allowed, overflow gives null, and `'1.'` → 1 and `'.5'` → 0.

**Comparison and ordering**
- Integer ordering subtracts, so it wraps at the int64 extremes. This
  affects `>`/`<` (`9223372036854775807 > -1` is false), `ORDER BY`,
  list comparison, and `max`/`min`. Over a list holding ±2^63, ±2^62,
  small integers and 1.5, `max` returned 1.5 and `min` −4.6e18.
  Equality is exact.
- Ordering by `[sign, value]` is correct, because two values of the
  same sign never overflow when subtracted.
- `IN` finds NaN equal to everything, and `=~` is unsupported.

**Grouping and ordering by kind**
- `GROUP BY` merges equal numbers (1 and 1.0), but keeps `true`, `1`
  and `"1"` apart.
- Mixed kinds sort as List < String < Boolean < Number < null.

**Text functions**
- `trim` strips spaces only, and `toLower` maps case per character.
- `substring(x, null)` raises, and `split` keeps empty parts.

**Query syntax**
- `EXISTS { MATCH … }` does not parse.
- A pattern comprehension in a `WHERE` next to a `MATCH` filter fails
  with "Unable to resolve filtered alias". Project it on a `WITH`
  first, or use `WITH n MATCH (n)<-[…]-(r) WHERE …`.

## 4. The predicates on 1M nodes

`bench_search_engine --width 50000`. Columns:

- **capped**: today's `MATCH (n) WHERE … WITH n LIMIT 10000`, which is
  fast only because it stops.
- **exact**: one statement counting every match.
- **chunks**: SchemaField in 50k ID ranges, each returning its exact
  count and ordered top-50; the per-chunk counts must add up to the
  exact label count.

| Predicate | Matches | Capped (10k) | Exact, one statement | Chunks × 1 | Chunks × 4 | Chunk p95 | Sums agree |
|---|---:|---:|---:|---:|---:|---:|:---:|
| name contains (text) | 11,111 | 212 ms | 1.33 s | 1.36 s | 406 ms | 124 ms | yes |
| gvHash = exact int64 | 1 | 748 ms | 703 ms | 817 ms | 204 ms | 68 ms | yes |
| gvHash = int64 (auto, as text) | 1 | 946 ms | 910 ms | 990 ms | 264 ms | 60 ms | yes |
| gvHash contains '74' | 167,163 | 61 ms | 962 ms | 1.40 s | 381 ms | 98 ms | yes |
| sourceId > 50000 (numeric text) | 500,886 | 72 ms | 2.04 s | 3.02 s | 792 ms | 185 ms | yes |
| score between 0.2 and 0.3 | 99,822 | 123 ms | 878 ms | 1.18 s | 319 ms | 75 ms | yes |
| updated within last 30 days | 9,573 | 1.72 s | 1.78 s | 2.00 s | 479 ms | 148 ms | yes |
| labels has all (pii, gold) | 22,578 | 1.14 s | 2.87 s | 2.81 s | 717 ms | 170 ms | yes |
| owner is one of 3 | 564,287 | 21 ms | 1.07 s | 2.30 s | 590 ms | 146 ms | yes |
| tier is empty | 199,846 | 42 ms | 694 ms | 1.19 s | 324 ms | 90 ms | yes |
| isPii is true (mixed kinds) | 180,765 | 38 ms | 609 ms | 1.03 s | 327 ms | 89 ms | yes |
| has a property named *own* | 1,000,000 | 47 ms | 4.28 s | 6.14 s | 2.36 s | 527 ms | yes |
| RAW `n.tier = 'gold'` | 266,796 | 22 ms | 322 ms | 886 ms | 262 ms | 64 ms | yes |
| RAW `n.score > 0.5` | 500,297 | 11 ms | 235 ms | 1.41 s | 436 ms | 100 ms | yes |

How to read it:

- **Every typed comparison finds its exact answer on a million nodes in
  0.2–0.8 s at 4 concurrent**, with every chunk under 200 ms at p95.
  The one exception is the property-name pattern, which needs P3.
- **The cap was never a speed-up for a selective predicate.** For
  `gvHash = X`, `updated within 30 days` and `labels has all`, the
  capped scan cost as much as the exact one, because it had to read
  the whole graph before 10k matches existed. The cap only made broad
  predicates look fast, by returning a wrong count.
- **Typed comparisons cost 1–3× a raw comparison.** Each stored kind
  takes its own `typeOf`-gated branch, and `WHERE` short-circuits the
  others.

Other statements:

| Statement | Time |
|---|---:|
| Membership: 1,000 on-screen URNs × 10 rules, plain projections | 65 ms |
| Membership: 1,000 on-screen URNs × 10 rules, each wrapped in `ANY(… WHERE …)` | 36 ms |
| 10 rule counts over SchemaField, one `WHERE` count per rule, 4 concurrent | 3.91 s |
| 10 rule counts in one SchemaField scan, summed in projections | 38.15 s |
| Value suggestions, `owner` q='' (top 25, complete) | 1.03 s |
| Value suggestions, `owner` q='ml' | 1.51 s |
| Value suggestions, `labels` q='' | 1.24 s |
| Value suggestions, `sourceId` q='12' | 1.46 s |
| Upward ancestry for 1,000 URNs | 26 ms |

On the first 100k SchemaField IDs, the ten rules cost:

| Form | Time |
|---|---:|
| Summed in one scan | 7.56 s |
| Each wrapped in `ANY(… WHERE …)` and summed | 4.10 s |
| Ten separate `WHERE` counts | 0.78 s |

Every form returned the same ten counts.

## 5. Chunk width and concurrency

`score between 0.2 and 0.3` over SchemaField:

| Width | × 1 total | × 2 total | × 4 total | Slowest chunk (× 4) | Chunks |
|---:|---:|---:|---:|---:|---:|
| 25,000 | 986 ms | 523 ms | 266 ms | 38 ms | 40 |
| 50,000 | 1,001 ms | 560 ms | 255 ms | 57 ms | 20 |
| 100,000 | 983 ms | 485 ms | 323 ms | 143 ms | 10 |
| 200,000 | 942 ms | 536 ms | 368 ms | 240 ms | 5 |
| 500,000 | 926 ms | 476 ms | 468 ms | 468 ms | 2 |

- Throughput does not depend on width, and concurrency scales up to
  the engine's threads.
- Wide chunks only lengthen the slowest chunk. That is the latency
  every other reader queues behind, and the granularity of progress
  and cancellation.
- 50k is the widest width whose slowest chunk stays well under 100 ms
  for a cheap predicate.
- Two in flight per search leaves the other threads to the canvas and
  to other searchers.

## 6. Count and top-k: one statement or two

SchemaField, 4 concurrent. Separate statements are a `count` and an
`ORDER BY … LIMIT 50`. One statement is
`ORDER BY` + `count(*), collect(…)[..50]`.

| Predicate | Width | Count | Top-50 | Both, one statement |
|---|---:|---:|---:|---:|
| owner is one of 3 (564k) | 200k | 369 ms | 351 ms | 806 ms |
| sourceId > 50000 (501k) | 200k | 701 ms | 774 ms | 1,114 ms |
| name contains (11k) | 200k | 487 ms | 481 ms | 490 ms |
| owner is one of 3 (564k) | 50k | 304 ms | 423 ms | 696 ms |
| sourceId > 50000 (501k) | 50k | 521 ms | 594 ms | 892 ms |
| name contains (11k) | 50k | 353 ms | 341 ms | 374 ms |

At 50k the single statement costs no more than the pair, and a
selective predicate costs half as much. The collect holds one chunk's
matches (at most 50k rows), so its memory is bounded by the width.
Projecting the sort keys on a `WITH` before `ORDER BY` costs the same
as ordering by the node's properties.

## 7. View scope: walking a subtree or clamping each chunk

The scope is the descendants of the view's roots (`CONTAINS*0..12`).
In `bench_1m` each Domain holds about 20k nodes. The predicate is
`score between 0.2 and 0.3`.

| Shape | 5 roots (104k subtree) | 50 roots (1M subtree) |
|---|---:|---:|
| Labelled walk, count the subtree | 127 ms | 1.28 s |
| Labelled walk + predicate, count | 172 ms | 1.73 s |
| Unlabelled root walk + predicate (today's shape) | 448 ms | 2.18 s |
| Walk returning member IDs | 225 ms | 2.64 s |
| Member-ID seeks, 50k per statement | 208 ms | 1.77 s |
| SchemaField chunks + `WITH n MATCH (n)<-[:CONTAINS*0..12]-(r) WHERE ID(r) IN $roots` | 1.15 s | 1.34 s |
| SchemaField chunks + the same check as a pattern comprehension | 2.09 s | 2.39 s |
| Bounded walk, `LIMIT 50,001` | — | 57 ms |
| Bounded walk, `LIMIT 300,001` | — | 400 ms |

(Chunk rows are sequential; ×4 divides them by about 3.5.)

- An unlabelled root anchor scans every node to find a handful of
  roots. That costs +0.28 s per million nodes before the walk starts.
- A walk costs in proportion to the subtree, and a clamped chunk scan
  in proportion to the label. So a small scope in a large graph should
  be walked, and anything else chunked.
- A walk bounded by `LIMIT` stops early, which makes it a cheap test
  of which case applies.
- The upward clamp runs only on nodes that already passed the
  predicate. It is exact for nested roots and for a containment graph
  that is not a tree, and chunks never double-count, because each
  node lives in exactly one ID range.

## 8. Against the targets

The plan's targets assume 8 vCPU and `THREAD_COUNT` 6. This machine
has 4 and 4.

| Operation | Target at 1M | Measured at 1M | Status |
|---|---|---|---|
| First response (provisional or final) | ≤ 0.5 s p95 | First 50k chunks return in 60–185 ms | Met, with the progressive response |
| Exact sorted page 1 + exact count | ≤ 1 s | 0.20–0.79 s; property-name pattern 2.36 s | Met, except name patterns (P3) |
| Membership, 1,000 URNs × 10 rules | ≤ 150 ms p95 | 36 ms | Met |
| 10 rule counts | ≤ 1.5 s | 3.91 s (949k nodes, 4 concurrent) | **Not met.** Cache per (rule, scope, data version); count the rules a user is looking at first; run counts in the background. |
| Value typeahead | ≤ 300 ms | 1.0–1.5 s | **Not met.** P3 catalogue top values. |
| Catalogue build, export, canvas regression | — | Not measured | P3, P6, load test |

At 10M nodes the costs scale linearly: exact page 1 plus count would
take about 2–8 s at 4 concurrent over 200 chunks of 50k. That is why
the engine reports progress and returns provisional hits.

## 9. Not measured, or still open

- **10M nodes.** The claims above are extrapolated linearly from 1M.
- **Interference with canvas reads while chunks run.** That is the
  load test's job (P7). The chunk width and the 2-per-search default
  are what keep it bounded.
- **Edge-property mirroring (A15)** and **full-text relevance (A12)**
  belong to P5.
- **Stability across FalkorDB versions.** CI's live job runs the
  parity suite on 4.18.11, and the ordering and short-circuit
  behaviours above should be re-checked there on every engine upgrade.

## 10. Relevance without regular expressions

FalkorDB has no regular expressions, so relevance cannot be ranked
the way `_score_hit` ranks it. Today's ranking scores each match by
tier (exact 100, prefix 60, word 40, substring 20) times a field
weight (displayName 1.0, qualifiedName 0.5, property 0.5,
description 0.4). The word tier uses `(?<!\w)`.

The engine computes the same tiers and weights in Cypher over
displayName, qualifiedName, description and the properties the
predicate compares. The one approximation is the word tier: it treats
a character as a word character when it is ASCII alphanumeric, `_`,
or a cased letter (`toLower(c) <> toUpper(c)`). Uncased scripts and
non-ASCII digits can therefore rank at the word tier where Python
would say substring.

The order is the Cypher key's. The `score` on each hit is still
computed in Python from the hydrated node, as today. A difference
between the two changes an annotation, never the order of the list or
which page a hit lands on.

## 11. Why sessions are driven by requests

The plan's engine keeps a search session's state in Redis. S0 settles
how its work gets done: **only while a request is waiting for it**.
There is no background runner.

1. The first request scans chunks until its wait budget is spent.
2. It commits each chunk's count and top-k to the session.
3. It returns the provisional page with its progress.
4. Each follow-up (`GET /search/sessions/{id}?wait=…`) takes the
   session's lease and continues from the chunks not yet done.

This buys four things:

- **Cancellation is free.** A client that stops asking stops the scan
  within one chunk (≤ 200 ms), so there is no idle timer.
- **Identical searches share work.** A second request for the same
  session finds the lease held and returns the newer state.
- **A crash loses at most one hop.** Progress is committed per chunk,
  and a lease that outlives its process expires.
- **Any process can continue any session**, because the state lives
  in Redis. Without Redis (quickstart) the state is process-local.

A session keeps whole pages of rows in order, at least 1,000. The pages
after the first are then slices of a finished session, not new scans. A
page past the rows it holds starts a keyset session after the last key
it has.

## 12. The engine as built (P2a)

The code is in `backend/app/providers/falkordb_search/`, and the
settings are `DEEP_SEARCH_ENGINE`, `DEEP_SEARCH_CHUNK_*`,
`DEEP_SEARCH_SESSION_*` and `DEEP_SEARCH_WALK_MAX`. Setting
`DEEP_SEARCH_ENGINE=legacy` restores the capped engine.

**Units**

The planner cuts each label into bands of about 50k of its nodes. Two
cheap reads size the bands:

- `db.meta.stats()` gives every label's count in about 1 ms;
- each label's first node ID comes from one `UNION ALL` statement (3 ms
  for four labels).

The first band starts at 0 and the last is open-ended, so the bands
cover the label even if the estimate is wrong. A band that runs out of
time or memory is split in half and retried; an open-ended band is cut
at its estimated end and stays open above it. A label with no nodes has
no band.

A range unit runs one statement:

```cypher
MATCH (n:L) WHERE ID(n) >= $_lo AND ID(n) < $_hi AND NOT (n:Earlier …)
  AND n.urn IS NOT NULL AND (<predicate>) <clamps> <withinHops>
WITH n, <keys> ORDER BY <keys>
WITH count(*) AS _c, collect([<keys>]) AS _rows
RETURN _c, _rows[..$_k]
```

The last key is always the urn, so a row never carries a node ID and
stays meaningful to hydrate whatever happens to the IDs. A walk unit
counts and ranks in two statements, because a subtree can be larger than
a chunk. A later page filters after the cursor's keys in one `WITH` and
orders in a second: a `WITH`'s `WHERE` applies after its `ORDER BY` and
`LIMIT`.

**Sort keys**

| Sort | Keys |
|---|---|
| relevance | the `_score_hit` score (section 10), descending; the display name; the urn |
| displayName / qualifiedName | the lower-cased text in `sortDir`; the urn ascending |
| a property | kind (numbers and booleans before text), sign, number, lower-cased text, each in `sortDir`; the urn ascending |

An exact-match leaf that every match must satisfy scores the same on
every row, so it becomes a constant rather than work per row. That
halved the slowest search below (`owner in 3`: 6.4 s → 3.4 s).

**Scope**

- **Visible URNs**: per-label `n.urn IN $_visible` index lookups.
- **View roots and `descendantOf` sets**:
  1. Each set is resolved to node IDs through the per-label urn index.
  2. A walk bounded at `min(walk_max, max(width, nodes ÷ 8))` sizes each
     set's subtree.
  3. The smallest set under the bound is walked in one unit, and the
     other sets clamp it.
  4. Otherwise, a set of up to 64 roots clamps range units.
  5. A larger set is walked in buckets of 32 roots, after dropping roots
     inside other roots. Containment is a tree, as
     `_get_ancestor_chain` already assumes.
- **`withinHops`**: the capped engine's continuation, after the clamps.
- **No roots**: the view's entity types, matched case-insensitively
  against the live searchable labels — or the ontology's types, or
  every label.

The plan lives in its session.

**Sessions**

- A session's id is a hash of the query (predicate, resolved scope and
  its hash, order, facets, rows kept), the data version, and the keyset
  position.
- It holds the pending units, the running count, and the merged rows.
- Each request takes the lease, runs units two at a time until its wait
  is spent, and commits. A request always runs at least one wave, so a
  client polling with no wait still makes progress.
- A client that sends `sessionId` finishes its session on the data it
  started on, and is told `stale` if the data has changed.
- A failed session is not kept, so the next request starts clean.

**Facets**

A search asking for facets gets the capped engine's statements for
them. They are computed once per session, in the background of the
request that claimed them. The page reports `running` until they land;
if they fail, the note in its diagnostics says why.

**Response**

- `status` (`running` / `complete`) and `countStatus` (`exact` /
  `lowerBound`).
- `progress` (`scanned`, `total`, `matched`), `sessionId`,
  `dataVersion` and `stale`.
- `truncated` and `deadlineExceeded` are set only when a request
  without `waitMs` runs out of time. The request can be sent again with
  its `sessionId` to finish.

**End to end on `bench_1m`**

Measured through `execute_session_search`: 2 chunks in flight, 4 engine
threads, `waitMs` 500, 50 hits hydrated per answer, polling with
`sessionId` until complete.

| Predicate (order) | Matches | First answer | Exact and complete | Requests |
|---|---:|---:|---:|---:|
| name contains `field_12` (relevance) | 11,111 | 643 ms | 2.41 s | 4 |
| gvHash = exact int64 (relevance) | 1 | 565 ms | 1.73 s | 3 |
| gvHash contains `74` (relevance) | 167,163 | 546 ms | 2.16 s | 4 |
| sourceId > 50000 (relevance) | 500,886 | 762 ms | 3.63 s | 5 |
| score between 0.2 and 0.3 (name) | 99,822 | 610 ms | 2.44 s | 4 |
| updated within 30 days (relevance) | 9,573 | 573 ms | 2.25 s | 4 |
| owner in 3 (relevance) | 564,287 | 595 ms | 3.43 s | 5 |
| tier is empty (name) | 199,846 | 843 ms | 2.05 s | 3 |
| any field contains `field_1` (relevance) | 111,111 | 1,369 ms | 4.71 s | 5 |

Ordering a match set costs more than counting it. On a 50k chunk with
30k matches:

| Work on the chunk | Time |
|---|---:|
| Count | 51 ms |
| Order by urn | 90 ms |
| Order by name | 168 ms |
| Order by relevance | 432 ms |

The relevance score's word tier is the dearest part, about 2 µs per
row per field. Running 4 chunks in flight instead of 2 roughly halves
every "complete" time above, at the cost of the engine threads that
canvas reads share.

Walking pages past the rows a session holds costs one full scan each:
about 1.2 s per page for 100k broad matches on 200k nodes. Taking every
match out of a large result is the export job's task (P6).
