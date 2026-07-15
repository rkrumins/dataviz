# Layer-scoped search for the Context View canvas

**Date:** 2026-07-14
**Status:** Approved design, pre-implementation
**Surface:** `frontend/src/components/canvas/context-view/` + `backend/app/providers/falkordb_deep_search.py`

## Context

A Context View lays entities out in layer columns (Source / Staging / Refinery / …).
Two shapes make the current search useless:

- A layer with **1000+ assigned entities**. Curated views load *every* assigned root into
  the browser (no cap, no paging — `useGraphHydration.ts:419-432`), so the column renders
  fine, but there is no way to find one entity among a thousand.
- An entity with **1000+ children** (a wide table, a large schema). The only tool today is a
  per-node "search children" box that caps results at 200 with no paging, no truncation
  notice, and — worst — **destructively deletes the parent's loaded children from the canvas
  store** to display matches (`useGraphHydration.ts:900-977`).

Under the hood the global Advanced Search *already* returns incomplete results on large views
and says nothing: `useAdvancedSearch.ts:366-382` truncates the search scope to the first 256
root URNs with only a `console.warn`. Matches under root #257+ are silently invisible. This is
the literal "search breaks down at scale."

**Goal:** one clear, fast, honest search primitive scoped to a layer column (or to a focused
container within it), correct at 10 entities and at 10,000, that never overwhelms the UI and
never lies about completeness.

## Why layer membership must be resolved in the frontend

Layer membership is **per-view**: the same entity can be in "Staging" in view A and "Bronze"
in view B. It is computed frontend-side from three inputs (`useLayerAssignment.ts`):

1. view-config assignments (`referenceLayout.assignments`, URN → `{layerId}`) — authoritative,
2. type/rule assignments (`layer.entityTypes` / `layer.rules`),
3. containment inheritance — descendants inherit their ancestor's layer (the HARD RULE at
   `useLayerAssignment.ts:188-190`), so a column's content is its assigned roots **plus their
   entire subtrees**. Plus live unsaved drags the backend has never seen.

The backend's apparent layer support cannot express this and is not used:

- `SearchScope.layerAssignment` (`search.py:575`) is accepted and **never compiled** into the
  candidate Cypher — a dead field.
- `AggregationSpec by='layer'` has a working executor (`_run_aggregation_layer`) that is
  **unreachable** because `'layer'` is absent from the `AggregationKind` literal
  (`search.py:443-450`); Pydantic rejects it at validation. The fallback error message even
  advertises `'layer'` as supported.
- `LayerPredicate` (`_visit_layer`, `falkordb_deep_search.py:441-444`) compiles to
  `n.layerAssignment = $p` — a denormalised per-node hint that misses rule-assigned nodes and
  inherited descendants. It returns the wrong set for any real layer.

**These three are flagged as broken estate. This work does not extend them; it recommends
deleting them separately.** Layer scope is resolved in the frontend and passed to the backend
as an explicit URN set.

## Architecture — one primitive, two tiers

Layer search is **one scoped Advanced Search query**, not a new engine. The scope is a URN set
computed on the client:

```
scopeRoots(layerId, localFocusId) =
  localFocusId  ? [focusedNode.urn]                       // "inside Orders (Data)"
                : Array.from(nodesByLayer.get(layerId),   // "in <Layer>"
                             n => n.urn)
```

This single expression makes the scope chip follow the existing focus breadcrumb, and it is why
searching inside a 1000-child entity comes free — a focused container is just a one-URN scope.

### Tier 1 — instant, local (zero network)

Filter loaded nodes where `nodeLayerMap.get(id) === layerId` (or, when focused, descendants of
`localFocusId`) by case-insensitive substring on `displayName` + `typeId`. Curated views hold
every assigned root in memory, so this tier is **complete for the layer's own top-level
entities** and renders on each keystroke under a "Top level" group, pinned first.

### Tier 2 — authoritative, server (progressive)

The same `POST /search/advanced` the panel already uses:

```ts
{
  predicate: { kind: 'group', op: 'and', children: [{ kind:'text', target:'name',
               match:'substring', value: q }] },
  scope:   { viewId, scopeMode: 'view', rootUrns: scopeRoots },
  options: { results:'both', pageSize: 1000,
             aggregations: [{ by:'parent', maxBuckets:200, sampleHitsPerBucket:3 }],
             includeAncestorPath: true },
}
```

Debounced 250 ms, one `AbortController` per column (stale response can never overwrite a fresh
one). Results **append below** the local "Top level" group as parent-grouped rows with exact
counts; the pinned local group never moves. Merge by URN, server row wins on conflict.

### The hard invariant

**Search results never touch the canvas store.** They live entirely in `useLayerSearch` state.
This is the single property today's per-node search violates, and the direct cause of the
store-corruption. Clicking a result reveals it via `useRevealSearchHit` (bounded single-spine
walk — already correct, unchanged).

## Components

| New | Responsibility | Depends on |
|---|---|---|
| `useLayerSearch(layerId, scopeRoots, viewId)` | debounce, abort, local tier, server tier, merge/dedupe by URN, cursor paging. Returns `{ status, localGroup, serverGroups, totalCount, truncated, loadMore, error }` | `useGraphProvider`, `useLayerAssignment` (`nodesByLayer`/`nodeLayerMap`) |
| `LayerSearchBox` | header input + scope chip ("in Staging" / "in Orders (Data)") + result count + clear | `useLayerSearch` |
| `LayerSearchResults` | virtualized grouped list that replaces the tree while a query is active; group headers with counts; "Load more" row (click-driven, **no IntersectionObserver**) | `useLayerSearch`, `useRevealSearchHit` |

**Deleted (retire the redundant, broken surface):** the per-node "Search children" magnifier
(`FlatTreeItem.tsx:614-627`, only importer of `onToggleSearch`), `SearchBoxItem.tsx` (imported
only by `LayerColumn.tsx`), `activeSearchNodes` + `childSearchQueries`
state in `LayerColumn.tsx`, the `searchChildren` hook and its destructive store-replace
(`useGraphHydration.ts:900-977`), and the `!activeQuery` clause in the load-more gate
(`LayerColumn.tsx:302`) now that nothing sets `childSearchQueries`.

## The scale contract — two backend correctness fixes

Both are about *not lying*, and both are needed for layer search to be correct on the large
layers it exists to serve.

### a. Apply the candidate cap AFTER the scope filter

`_build_candidate_cypher` (`falkordb_deep_search.py:828-830`) emits, unconditionally today:

```
MATCH (n) WHERE <predicate> WITH n LIMIT <candidate_cap>   -- cap applied here
<scope_continuation: MATCH (root)-[...]->(n) WHERE root.urn IN $roots>
```

So a broad predicate matching 50k nodes graph-wide is chopped to an arbitrary `candidate_cap`
(5000) **before** the layer/scope filter runs — real in-scope matches vanish silently. The
`scope_pre_filter` shape that would fix this (`_build_scope_pre_filter:1103`) is defined but
**never wired** — line 1358 calls `_build_candidate_cypher` without it. So this defect is
unconditional on *every* scoped search, global and layer alike.

**Fix:** wire the pre-filter (root-anchored) shape into the compile path when a scope URN set is
present, so candidates are scope-clamped *before* the cap:

```
MATCH (root)-[:<ctypes>*0..D]->(n) WHERE root.urn IN $roots
WITH DISTINCT n WHERE <predicate>
WITH n LIMIT <candidate_cap>          -- cap now applies to in-scope candidates only
```

`truncated` (`candidateCount >= cap`) becomes an honest signal. The index-first scan is
preserved for unscoped searches (no scope set → existing `MATCH (n)` shape).

### b. Raise the root-URN cap; delete the client-side truncation

`scope.rootUrns` is capped at 256 (`_enforce_root_urns_cap`, `search.py:577-601`), and
`useAdvancedSearch.ts:366-382` silently slices to the first 256. A 1000-entity layer blows
straight through.

**Fix:** raise `DEEP_SEARCH_SCOPE_ROOT_URNS_CAP` to a value that covers a realistic large layer
(target **5000**, env-tunable), and **delete** the client-side `SAFE_ROOT_URN_CAP` slice.
Above the raised cap, return a real error the UI can render as an honest wall — never a silent
slice.

## Data flow

```
keystroke
  → useLayerSearch debounces 250 ms, aborts any in-flight request
  → Tier 1: filter nodeLayerMap/nodesByLayer locally → render "Top level" group NOW
  → Tier 2: POST /search/advanced { scope.rootUrns: scopeRoots, results:'both', by:'parent' }
       → on resolve (not aborted): dedupe vs local by URN, append server groups below
       → cursor present → "Load 100 more (N remaining)" click-driven row
  → click a result → useRevealSearchHit(urn, ancestorPath)   // store untouched
```

## Error handling

- Server tier fails → keep the local tier; banner *"Couldn't search inside — showing N
  top-level matches only. Retry."* Never destroys local results.
- Scope over the raised cap (backend error) → *"This layer has 1,240 entities — too large to
  search exhaustively. Focus into a container to search inside it."* Honest wall, points at the
  focus affordance that resolves it.
- Zero matches → *"No matches in Staging."* + *"Search all layers →"* seeding the global panel
  with the same predicate.
- Provider not remote (e.g. static provider) → local tier only, no error (mirrors
  `useAdvancedSearch`).

## Testing

**`useLayerSearch`:** debounce coalesces bursts to one request; a stale (aborted) response never
overwrites a fresh one; local + server merge dedupes by URN; `loadMore` appends (never
replaces); provider-error path preserves the local group.

**`LayerSearchResults`:** renders grouped rows with counts; auto-expands nothing; **constructs
zero `IntersectionObserver`s** (same guard as the load-more fix — regression pin against the
runaway class).

**Backend (the test that fails today):** scope = 2 root URNs whose subtree holds 5 matches, a
predicate matching 10,000 nodes graph-wide, `candidate_cap = 100` → **must return all 5**. With
the post-filter shape it returns a subset of the 100 graph-wide candidates that happen to fall
in scope, i.e. loses matches. Plus: 5000 root URNs is accepted (not 422) under the raised cap;
`truncated` is true only when in-scope candidates exceed the cap.

## Explicitly out of scope

- Repairing/removing `SearchScope.layerAssignment`, `by='layer'`, and `LayerPredicate` (flagged
  broken estate — separate change).
- Open (`'all'`) views' per-type `PER_TYPE_LIMIT=200` load truncation — a distinct
  hydration-scale issue, not search.
- Any change to `useRevealSearchHit` (already correct).

## Files touched

- **New:** `frontend/src/hooks/useLayerSearch.ts`,
  `frontend/src/components/canvas/context-view/LayerSearchBox.tsx`,
  `frontend/src/components/canvas/context-view/LayerSearchResults.tsx` (+ tests).
- **Edit:** `LayerColumn.tsx` (mount search box in header; render results in place of tree while
  active; delete per-node search state + the `!activeQuery` gate),
  `ContextViewCanvas.tsx` (drop `onSearchChildren` wiring),
  `useGraphHydration.ts` (delete `searchChildren`),
  `useAdvancedSearch.ts` (delete `SAFE_ROOT_URN_CAP` truncation),
  `falkordb_deep_search.py` (wire pre-filter scope shape),
  `deep_search/settings.py` (raise `scope_root_urns_cap` default).
- **Delete:** `SearchBoxItem.tsx`.
