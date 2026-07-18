# Follow-up: external-degree signal for curated Views

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
