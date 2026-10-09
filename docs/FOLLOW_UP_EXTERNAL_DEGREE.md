# Follow-up: external-degree signal for curated Views

> **Status (2026-10-09): shipped, in a different shape.** What exists is
> `POST /api/v1/{ws_id}/graph/nodes/degree`, not the endpoint proposed below.
> It returns each URN's *total* lineage degree, in and out, whether or not the
> partner is in the view; a URN missing from the answer means unknown, not
> zero. It takes an optional `includeRollups`, sits behind the response cache,
> and answers `501` for a reader that cannot count (a versioned branch, or a
> draft on one). The client asks for 400 URNs at a time, after an 800 ms
> settle.
>
> On the canvas those totals drive each card's lineage ports. The "N↑ M↓
> outside this view" chip, the per-card cue and the Preview action count
> something else: the partners the canvas places outside the view. They show
> on curated views with `showMissingConnectionIndicators` on, and Preview also
> needs the `externalLineagePreview` display preference. The proposed "add the
> partners to the view" action was not built. Of the known limits at the end,
> the 200 top-level cap is gone (roots now page) and `searchChildren` no longer
> exists; the parallel-edge dedup still holds.

## Problem

Views are subsets of a Data Source. A curated view hydrates edges only
among its assigned URNs, so lineage whose other endpoint lives OUTSIDE
the view is mostly never fetched — the canvas cannot distinguish
"this node has no upstream" from "this node's upstream isn't in this
view". The Missing Connections toggle (Display → Lineage) governs the
alerts for out-of-view links that DO arrive (aggregated edges, detail
expansions), but per-node awareness of unfetched external lineage needs
backend support.

## Proposed design (additive, no breaking changes)

**Endpoint** — `POST /api/v1/graph/lineage/external-degree`

```json
// request
{ "urns": ["urn:a", "urn:b", ...], "edgeTypes": ["FLOWS_TO", ...] }
// response
{ "degrees": { "urn:a": { "in": 3, "out": 0 }, ... } }
```

**Provider query (FalkorDB)** — edges with EXACTLY one endpoint in the
request set, counted per in-set node and direction:

```
MATCH (a)-[r]->(b)
WHERE a.urn IN $urns XOR b.urn IN $urns
  AND type(r) IN $edgeTypes
RETURN CASE WHEN a.urn IN $urns THEN a.urn ELSE b.urn END AS urn,
       CASE WHEN a.urn IN $urns THEN 'out' ELSE 'in' END AS dir,
       count(r) AS n
```

Chunk the URN set (mirror `/edges/between` slot bounds); response-cache
by (sorted-urns-hash, edgeTypes).

**Frontend** — fetch once per hydration settle for loaded URNs; render a
quieter, visually distinct per-node cue (e.g. hollow/dashed tab) meaning
"has lineage outside this view", alongside the existing in/out
indicators, gated by the same `showMissingConnectionIndicators`
preference. Tooltip: "N upstream / M downstream connections outside this
view". Optional click-through: offer to add the external partners to the
view (assignment flow) or run a Trace.

## Related known limits (documented in code)

- `PER_TYPE_LIMIT = 200` top-level cap for open views (no top-level
  load-more) — `frontend/src/hooks/useGraphHydration.ts`.
- `searchChildren` 200-match cap.
- Parallel same-type edges dedup to one canvas edge (`source|type|target`
  id) — rare in lineage; revisit only if a real ontology hits it.
