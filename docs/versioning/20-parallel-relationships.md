# Parallel relationships: several of one type between the same two items

> **Status: proposed (follow-up).** Today the platform keeps one relationship per source, type and
> target. Nothing in §4 exists yet. Both directions (A→B beside B→A) and several different types
> between one pair are already supported (§2).

## 1. The question

Should one pair of items be able to hold more than one relationship of the same type, in the same
direction? For example, Orders feeds Revenue twice: once by the nightly batch job, once by the
streaming job, each with its own schedule and SQL.

## 2. What the platform does today

**Allowed, and kept apart everywhere**
- **Both directions.** A→B and B→A of one type are separate relationships with different ids.
  Every key is directional:
  - the save check (`service.py` `_validate_edge_integrity`);
  - the projector's `EdgeKey` (`projection_reconcile.py`);
  - import ids (`import_export/resolve.py` `edge_pointer_id`);
  - roll-up keys.

  The one exception is containment: B→A is refused as a loop. The Context View draws a pair held
  both ways as one two-way line.
- **Several different types between one pair** are separate relationships with their own lines.

**Refused or collapsed: several of one type in one direction**

| Layer | What happens | Where |
|---|---|---|
| Saving | Refused: "These entities are already connected by this relationship." | `service.py` `_validate_edge_integrity` |
| Drawing | Refused with the same message; drag-connect ids are `e-<source>-<target>-<TYPE>` | `ontologyPreflightService.ts` `validateDrawnEdge`, `GraphCanvas.tsx` |
| Reversing | Refused when the other way already holds that type | `useCanvasInteractions.ts` `reverseEdge` |
| Import and sync | An edge without its own id is identified by the triple; one edge per triple | `resolve.py` `edge_pointer_id`, `edge_to_eid`; `snapshot.py` `edges_between` |
| FalkorDB | `MERGE (a)-[r:T]->(b)` keeps one relationship per triple; reconcile deletes extra copies on platform keys; counts are distinct triples | `projection.py` `_edge_merge_cypher`, `_scan_projection`, `_drop_stale_edges`; `reconcile.py` |
| Enabling version control | Copies that differ are held for review and resolved into one | `bootstrap_worker.py` `_connection_groups`, `_settle`, `_resolved` |
| Canvas and drawer | Lines fold copies into one, listing members; lookups fall back to the triple | `GraphCanvas.tsx`, `useEdgeProjection.ts`, `useRelationshipRecord.ts` `pickRelationship` |

This is deliberate. An edge with no id of its own is still the same edge when a file sends it
again (doc 18). Matching, roll-ups and the enable review all rely on it.

## 3. When a model needs more than one

**Real cases**
- Two pipelines writing the same table, each with its own job, schedule and SQL.
- An external graph that already holds copies (the enable review pauses on these today).
- Memberships or ownerships that overlap in time, each with its own dates.

**How to model them today**
- **A process between two tables is an item in its own right:** dataset → job → dataset, through
  produces and consumes relationships. Each job carries its own properties, and lineage still runs
  through it.
- **Each occurrence of an event (each call, payment or run) is an item,** not a relationship.
  Relationships describe how items stand to each other; occurrences pile up.
- **Several values on one connection** go on one relationship as a list property (`jobs: [...]`).
- **Changes over time** are already kept by version history: one relationship, many versions.

## 4. Proposed design: an opt-in per relationship type, told apart by a key

A relationship type may allow several between the same two items, each told apart by the value of
one of its fields: its key, for example `job_id` or `valid_from`.

- **Identity becomes (source, type, target, key value).** It stays deterministic, so imports, sync
  and Bring into history still know which relationship a row means.
- **Never eligible:** containment (one parent, no loops) and roll-ups.
- **Off by default.** Types that don't allow it behave exactly as today, byte for byte.

### 4.1 The setting and the save check
- **Ontology:** `RelationshipTypeDefEntry` gains `parallel: {keyProperty}` at the extension point
  in `backend/app/ontology/models.py`. It passes through `ontology/resolver.py` as `bidirectional`
  does.
- **Editor:** `RelationshipTypeEditor.tsx` offers "Several between the same two items, told apart
  by [field]", choosing from the type's fields. It refuses this on containment types.
- **Discriminator:** at each write, `edge_versions.discriminator` (the column exists, unused for
  identity) is set from the key's value.
- **Save check:** `_validate_edge_integrity` keys on (source, target, TYPE, discriminator) for such
  types. It refuses a second relationship with the same value, and one with no value ("needs
  <key> to tell it apart").

### 4.2 Identity and matching
- **Derived ids:** the discriminator joins the triple in `edge_pointer_id`, `_derived_edge_id`, the
  sync fallback id, the reader's fallback id (`_edge_from_row`) and `source|TYPE|target` lookups
  (`property_job.py`).
- **Matching maps** key on triple plus discriminator: `edge_to_eid`, `edges_between`,
  `entity_indexes` and `_heads_by_edge_triple`.
- **Ambiguous rows:** a row that matches several live relationships without an id or a key value
  is refused as `ambiguous_identity`, as doc 12 specifies.

### 4.3 FalkorDB, for parallel types only
- **Writes:** `MERGE (a)-[r:T {id: item.eid}]->(b)` in the projector and in the provider's writers.
  Other types keep today's MERGE.
- **EdgeKey** gains a discriminator part (None for other types). It applies through
  `_expected_projection`, `_scan_projection`, `diff_projection`, `_write_missing`,
  `_held_fingerprints`, `_drop_stale_edges` and `_delete_edges_by_key`.
- **Verify counts** use distinct (source, type, target, discriminator).
- **Index:** one relationship index on `r.id` per parallel type.

### 4.4 Roll-ups
- Weight counts every lineage relationship, parallel ones included. The batch job and the write
  hook already do.
- `plan_rollup_deltas` and `rollup_health` key on triple plus discriminator.

### 4.5 Enabling version control
- For parallel types, copies with distinct key values land as separate relationships, with no
  review.
- Copies with the same key value but different content, or with no key value, are still reviewed.

### 4.6 The UI
- **Drawing** a second relationship of a parallel type asks for its key value. Drag-connect gets a
  generated id and is staged like every other draw.
- **Lookups** go by id. `pickRelationship` never guesses between several, and the connection
  view, trace export and neighbour lists key by id.
- **Folded lines** say "2 × Feeds", and each member is labelled by its key value.
- **Graph canvas:** lines between one pair are drawn apart. Today, different types between one pair
  overlap there.

## 5. Tests the follow-up needs
- **Save check:** same key value refused, missing key value refused, containment never eligible.
- **Ids and matching** with a discriminator, and `ambiguous_identity`.
- **Projector:** writes, reconcile and verify counts with parallel heads; other types unchanged
  (pinning tests).
- **Roll-up weights** with parallel lineage.
- **Enable** keeping keyed copies apart.
- **UI:** drawing, identity by id, labels.
- **Live FalkorDB:** two relationships of one type between one pair survive a rebuild.

## 6. Open questions
1. Should the key be one field, or may it be several (`job_id` plus `run_type`)?
2. When a type is switched to parallel with relationships already saved, are existing ones given an
   empty key value or asked for one?
3. Does a folded line's weight in traces count relationships or connected pairs?
