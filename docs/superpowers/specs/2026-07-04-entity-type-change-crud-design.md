# Entity Type-Change & Re-structuring CRUD — Design Spec

**Date:** 2026-07-04
**Status:** Approved design, pre-plan
**Branch context:** dataviz — Context View / Hierarchy Builder entity authoring

## Context & Problem

Users build ontology-typed entity hierarchies by hand (Domain → Data Platform → Container → Dataset → Column, or blank Group/Object/Attribute models). Two authoring needs are unmet today:

1. **Promotion on add-child.** A leaf type (e.g. `Attribute`, `Column` — `hierarchy.canContain` empty) cannot hold children, so the "+ add child" affordance is disabled. When a user has an Attribute and now wants a child under it, the entity must *become* a container type (e.g. `Group`) first. There is no way to do that in the product.

2. **Fixing the level after the fact.** A user builds `Table → Columns` then realises they meant `Database → Tables` (or vice-versa). Correcting this requires either changing entity *types* in place or inserting a missing parent level. Neither is supported.

Both reduce to a single missing primitive: **changing an entity's type in place.** Today the backend forbids it — `backend/app/ontology/mutation_validator.py` documents `existing_entity_type` as *"type changes disallowed."* Reparenting (`useReparentNode.reparent`) and containment-edge retyping (`retypeContainment`) already exist and are ontology-validated; only the entity-type change is absent.

## Goals

- A single, reusable, ontology-validated primitive for changing an entity's type, with an automatic, **user-confirmed, editable** cascade when the change invalidates descendants.
- Three flows built on that primitive, optimised for a seamless-but-transparent experience:
  - **Auto-promote on add-child** — hitting "+" on a leaf offers to convert it, telling the user exactly what changes.
  - **Manual "Change type"** — a deliberate control (drawer + context menu) with the confirm-preview.
  - **Insert missing parent ("Wrap in…")** — create + reparent, no type change.
- Correctness by construction: recursive containment (`Group→Group`, `container→container`), lineage-edge endpoint constraints, and cycle safety all handled.

## Non-Goals

- No changes to how *lineage* edges are drawn/created (covered by `CreateLinkPopover`).
- No bulk import/paste changes (the outline/paste flow already exists).
- Bulk multi-select retype/move is **phase 3**, deferred from the first cut.
- The stubbed drawer `PATCH /nodes/{urn}` endpoint is not the persistence path here — type changes ride the existing `/changes` draft-op path.

## Architecture — Approach A (shared pure planner + staged change + backend re-validation)

### Component 1 — The planner (pure, in `frontend/src/services/ontologyPreflightService.ts`)

No React, no stores — mirrors the existing `allowedChildTypeIds` / `deriveContainmentEdges` helpers and reuses them.

```ts
// Types this node could legally become, given its parent, children, and incident edges.
export function typesValidForNode(node: GraphNodeView, ctx: OntologyContext): string[]

// Given a node and a target type, compute the full ripple.
export function planRetype(rootNode: GraphNodeView, newType: string, ctx: RetypeContext): RetypePlan

export interface RetypePlan {
  changes:   RetypeChange[]   // root + each cascaded descendant, ordered parent-before-child
  conflicts: RetypeConflict[] // descendants with no valid re-level → blocks apply
  ok:        boolean          // conflicts.length === 0
}
export interface RetypeChange   { nodeId: string; urn: string; name: string; fromType: string; toType: string; editable: boolean }
export interface RetypeConflict { nodeId: string; name: string; reason: string }
```

`ctx` supplies the view-scoped ontology (entityTypes, hierarchyMap, rootEntityTypes, relationshipTypes, containmentEdgeTypes) plus a way to read the node's parent type, child nodes, and incident edges from the canvas store — passed in, not imported, to keep the planner pure and testable.

**Validity of a single (node, candidateType) pair** — candidate is valid iff ALL hold:
- **Parent side:** `candidateType.canBeContainedBy` admits the node's parent type (or node is root / parent is a layer). Case-insensitive (per shipped `sameId`/`findEntityType`).
- **Child side:** for every current child, `candidateType.canContain` admits the child's type — OR that child is itself included in the cascade with a re-leveled type that fits.
- **Edge side:** every incident lineage/containment edge's `sourceTypes`/`targetTypes` still admit `candidateType` in its role (reuse `deriveConnectableEdges`/`deriveContainmentEdges` endpoint logic).
- **Cycle:** re-leveling introduces no containment cycle (reuse the existing forward-only containment orientation).

**Re-level algorithm (`planRetype`) — per-node nearest-valid, top-down:**
1. Set the root's `toType = newType`.
2. Walk descendants top-down. For each node:
   - If its current type is still a valid child of its (possibly-retyped) parent → leave unchanged and **prune** (do not descend; its subtree is unaffected).
   - Else propose a `toType` from the candidates that ARE valid children of the proposed parent (hard constraint). Prefer, in order: (i) a type whose containment role mirrors the node's current one (the emergent "uniform level-shift" for chain-shaped subtrees), then (ii) deterministic tie-break by `hierarchy.level` then name. Set `editable: true` so the user can override in the preview.
   - If no candidate is a valid child → `conflict` (blocks apply).
3. Output `changes` ordered parent-before-child; `ok = conflicts.length === 0`.

The hard constraint (valid child of the proposed parent) makes the plan well-defined for branching subtrees; the preference only orders ties, and the editable preview + conflict list cover anything the heuristic gets "wrong."

Deterministic, side-effect-free, fully unit-testable.

### Component 2 — Staging + the backend gate (data flow)

- A retype stages an `update_entity` staged change with `after.entityType = toType` per affected node (root + cascade), grouped as one reviewable batch. Reuses `stagedChangesStore` + the existing op path — `stagedChangesToOps` already emits `entityType` for `update_entity`.
- Persistence rides `POST /changes` (draft), the same path the layer-move + cache-invalidation fixes use; top-level node fields round-trip through `_patch_payload` → `_graphnode_dict`. (**Phase-1 must verify** `entityType` specifically round-trips AND that the projector correctly re-projects a node whose type changed — see Risks.)
- **Backend gate:** `mutation_validator.validate_node_mutation` changes from rejecting any `entity_type != existing_entity_type` to *validating* the change: new type vs parent `can_contain`, vs each child's `can_be_contained_by`, vs incident-edge endpoint constraints, and cycle safety. Case-insensitive, fail-open when no ontology (matching current conventions). Backend is the authoritative save-time gate; the client planner is the instant preview.

### Component 3 — The three flows (UI)

1. **Auto-promote on add-child.** The leaf "+ add child" gate flips from disabled to enabled-with-hint when a promotion target exists. Click → the Hierarchy Builder opens scoped to the node with a transparent banner: *"Adding a child will change **{name}** from {Attribute} → {Group}."* One confirm stages the promotion (`update_entity`) + the child create together. Target type = the **minimal** type T with `T.canContain ⊇ desiredChildType` and `T.canBeContainedBy ⊇ parentType`; if several, pick minimal-by-level and expose a change affordance.
2. **Manual "Change type."** A control in `EntityDrawer` (next to the existing reparent/retype-containment selects) and in `CanvasContextMenu` → a type picker limited to `typesValidForNode` ∪ types whose `planRetype` yields `ok || resolvable`. If the choice needs a cascade, render the **confirm-preview** (editable rows, conflicts surfaced) → apply stages all changes.
3. **Insert missing parent ("Wrap in…").** A `CanvasContextMenu`/drawer action → pick a type that `canContain` the current node and fits its current parent → create the new node + reparent the selection under it. Composed from existing create (`useStageEntityCreation`) + `useReparentNode.reparent`; no type change.

## Error Handling

- **Unresolvable descendant:** listed in the preview under conflicts; apply disabled with *"these N can't be re-leveled — remove them or choose a different type."*
- **Invalid vs parent / broken lineage edge:** the target is either absent from the picker or the preview blocks with a plain-language reason naming the offending relationship (reuse the humanized reason strings).
- **Draft guard:** every operation stages into the draft via `ensureDraftOpen`; fully undoable before save; discard cascades already handle staged `update_entity`.
- **Backend rejection:** if a staged type change fails backend re-validation on save, surface it in the existing changes-review error path (same as other staged failures).

## Phasing (three shippable slices)

1. **Foundation:** backend `mutation_validator` type-change validation + the pure planner (`typesValidForNode`, `planRetype`). No UI. Verify `/changes` entityType round-trip + projector re-type. Fully unit-tested (TDD).
2. **Headline flows:** auto-promote-on-add-child + manual "Change type" (drawer + context menu) with the editable confirm-preview.
3. **Conveniences:** "Wrap in…" insert-parent + bulk multi-select retype/move.

Each slice is independently useful and independently reviewable.

## Testing Strategy (TDD)

- **Planner (deep unit coverage):** promotion-target selection; uniform up-shift and down-shift; branching subtree; recursive `Group→Group`; unresolvable conflict; edge-constraint breakage; already-valid pruning; deterministic tie-break.
- **Backend `mutation_validator`:** accept a valid shift; reject bad-parent, bad-child, cycle, broken-edge; case-insensitive; fail-open without ontology.
- **Flow wiring:** light integration — auto-promote stages promotion+child atomically; change-type cascade stages the whole batch; wrap-in creates+reparents.

## Key Files

- `frontend/src/services/ontologyPreflightService.ts` (+ tests) — planner.
- `backend/app/ontology/mutation_validator.py` (+ `backend/tests/test_mutation_validator.py`) — allow+validate type change.
- `frontend/src/features/versioning/model/stagedChangesToOps.ts` — confirm `update_entity` entityType op (already present).
- `frontend/src/components/canvas/create/` (builder auto-promote), `frontend/src/components/panels/EntityDrawer.tsx` + `frontend/src/components/canvas/CanvasContextMenu.tsx` (Change type / Wrap in…), `frontend/src/components/canvas/context-view/FlatTreeItem.tsx` (leaf "+" gate).
- A new `RetypePreview` component for the confirm-preview.

## Risks / To-Verify During Planning

- **Projector re-type:** changing a node's `entityType` may require the FalkorDB projector to relabel/re-kind the node, not just patch a field. Phase 1 must confirm a type change round-trips through projection, not only through the draft payload. If the projector keys on type/label, this is the highest-risk item.
- **`/changes` update-op persistence for `entityType`:** verified for `layerAssignment` (top-level merge); confirm `entityType` specifically is not filtered.
- **Layer re-assignment on retype:** a re-leveled node may fall under a different layer rule; ensure the shipped layer-assignment path recomputes (mostly automatic given `layerAssignment`/rule precedence).
- **Undo of a cascade batch:** confirm the staged-changes discard/undo treats the cascade batch coherently.
