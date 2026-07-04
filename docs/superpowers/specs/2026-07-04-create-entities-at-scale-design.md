# Create Entities at Scale — Design Spec

**Date:** 2026-07-04
**Status:** Approved (design) — pending implementation plan
**Goal:** Let any user — technical or not — create hundreds to thousands of entities by hand, with correct containment hierarchies and lineage edges, through a modern, premium, guided experience that stays fast at scale.

## Scope

**In scope (this spec):** the by-hand, on-canvas creation journey at scale — guided visual canvas building + a dedicated "Build Mode" panel for volume, the shared model behind them, ontology-correct containment + lineage, validation with auto-fix, and the performance work (O(n) staging, chunked transactional save, virtualization) that makes 1000s feasible.

**Explicitly out of scope (separate specs/tracks):**
- **File import/export (CSV/Excel)** — designed strategically as its own later spec. This design leaves a clean seam (the shared row model) for it to plug into.
- **Type-change Phase 2/3** — already has an approved spec (`2026-07-04-entity-type-change-crud-design.md`); its planners (`typesValidForNode`/`planRetype`) are *reused* here for auto-fix but its UI is a parallel track.
- **P2 trust gaps** (delete confirmation, HierarchyCanvas drag-connect parity, 3-store layer consolidation) — folded into their own small plan.

## Design principles

1. **Three acts, three modalities.** Creating nodes/hierarchy, connecting edges, and refining are different gestures; each is made native:
   - **Structure** (nodes + containment) → structured & fast: keyboard outline + spreadsheet grid + paste.
   - **Connect** (lineage edges between the relevant nodes) → visual & spatial: draw on the canvas (drag-connect or click-Link), only ontology-valid types offered.
   - **Refine** → direct manipulation on the canvas: drag-to-reparent, inline rename, retype.
2. **Guided-canvas-first.** A new user's default first touch is the visual canvas — click "+" under a node to grow the tree, drag to reparent, draw edges. **Build Mode is the accelerator** they reach for when they know they have volume, one click away — never the only door.
3. **One engine, two views.** Build Mode is today's Hierarchy Builder engine promoted to a spacious surface. Same store, same staged-draft flow, same canvas result — not a parallel system.
4. **Progressive disclosure.** Non-technical users see plain language, guided visuals, hidden edge jargon, auto-fix. Power users get keyboard outline, paste, bulk grid edit, explicit type/edge control — one disclosure deeper.
5. **Ontology-correct always.** Containment edge types auto-picked from the ontology; lineage limited to `deriveConnectableEdges`; auto-fix keeps every staged row valid.

## User journey

1. **Blank canvas → "Build your model."** Guided entry: an inviting empty state with "Add your first entity" (visual) and a quieter "Build a lot at once" (→ Build Mode).
2. **Structure.** Either grow the tree visually (inline "+" add-child, watch it appear) or open Build Mode and type/paste/grid the skeleton (100s in seconds). Auto-fix keeps it valid; a live "998 valid · 12 auto-fixed · 2 to fix" counter shows state.
3. **Apply.** Nodes animate into place (ELK); for large batches an Apply progress bar runs the chunked save; the Build panel recedes.
4. **Connect.** On the live canvas, draw lineage between the just-created nodes — drag a handle or click "Link", pick a target, choose from ontology-valid link types (plain language).
5. **Refine + Save.** Drag-reparent, rename, retype, add details; review the staged changes; Save (draft) → publish/merge.

## Architecture

### 1. Shared row model (the spine)

A normalized in-memory model, the single source both the canvas and Build Mode edit:

```ts
interface BuildRow {
  id: string                     // client row id (stable within the session)
  name: string
  typeId: string | null          // resolved ontology type; null until inferred
  parentRef: { rowId: string } | { urn: string } | null  // containment parent
  description?: string
  tags?: string[]
  properties?: Record<string, unknown>
  depth: number                  // derived; for outline/grid indentation
  status: 'valid' | 'fixed' | 'error'
  issues: BuildIssue[]           // plain-language, per-row
  fixes: BuildFix[]              // what auto-fix changed (for transparency)
}
```

Three **thin input adapters** edit the same `BuildRow[]`:
- **Outline adapter** — the existing keyboard outliner logic (`useHierarchyOutline` evolves to operate on `BuildRow[]`): Enter=sibling, Tab=child, Shift+Tab=outdent.
- **Grid adapter** — a virtualized spreadsheet: columns name / type / parent / description; fill-down, multi-select bulk-edit, duplicate-row, paste-into-cell.
- **Paste adapter** — `parseIndentedOutline` / TSV → `BuildRow[]`.

Downstream (validation, preview, staging, save) is written **once** and shared.

### 2. Validation + auto-fix (pure; reuses Phase-2 planners)

`validateBuildRows(rows, ontologyCtx): BuildRow[]` — pure, debounced, incremental. Reuses `allowedChildTypeIds`, `deriveContainmentEdges`, `containmentChains`, and the type-change planners (`typesValidForNode`, `planRetype`) to:
- infer a missing `typeId` (single allowed → auto; else best-by-level);
- **auto-insert missing parent levels** (containment chain gap → synthesize the intermediate `BuildRow`);
- **auto-promote** a leaf-typed parent to a container type (`planRetype` auto-promote);
- mark each row `valid` | `fixed` (with a `fixes` note) | `error` (plain-language, inline-fixable).

Errors never block valid rows. The header summarizes "N valid · M auto-fixed · K to fix"; auto-fix is transparent (the panel and a toast state exactly what changed).

### 3. Persistence at scale (the core fix)

**Client O(n) staging** — replace per-row `stageEntity` (currently O(n²): per-row parent lookup over all nodes + full-array-copy store reducers) with a single `stageBuildRows(rows)` pass:
- resolve parents via a `Map` index (O(1) each);
- build the new canvas nodes + containment edges arrays **once**;
- one `stagedChangesStore` batch insert + one `addNodes`/`addEdges`.

**Chunked transactional save** — `create_entity` is currently routed *around* the atomic `/changes` commit (each a separate HTTP call, no rollback). Fix: fold node-creates into the batched `/changes` commit, committed server-side in **chunks (~500 ops/transaction)** with:
- a **progress stream** (per-chunk callback → Apply progress bar);
- **per-chunk atomicity** — a failing chunk rolls back; prior chunks persist; a clear report lists the failed rows with reasons;
- temp-urn → real-urn remapping preserved across chunks (children reference parents staged earlier in the same batch).

### 4. Client performance

- **Virtualize** the Build grid/outline and the paste preview (`@tanstack/react-virtual`, already used in `ContextViewCanvas`'s `LayerColumn`).
- **Virtualize HierarchyCanvas** (the one canvas that renders every node today).
- **Defer full ELK layout** until Apply — authoring never triggers a relayout per keystroke; on Apply, one ELK pass animates the batch into place.

### 5. Integration with the existing canvas (ContextViewCanvas + shared)

Build Mode is additive and reuses the existing rich flow — verified integration points in `ContextViewCanvas.tsx`:
- **Same store.** `useHierarchyBuilderStore` gains `mode: 'rail' | 'build'`. Every existing entry point (header +Add `:2351`, per-layer "+" `:2476/:2604`, inline add-child `handleAddChildEntity :1253`, command palette `:2632`) keeps opening the **rail** for quick in-context adds. A new **"Build"** affordance + a rail **expand ⤢** open the same store in `build` mode. Scope (`layerId`/`parentUrn`) carries over.
- **Same staged flow → same layers.** Build rows stage through the same `stageEntity`/`stagedChangesStore`; the same `onEntityStaged (:2524) → assignEntityToLayer (:2532)` path places each entity in the correct ContextView column (identical to the rail and to duplicate's per-node `onNodeCopied`). LayerColumns render staged nodes live — no new render path.
- **Containment = parentRef.** Auto-picked containment edge type from the ontology (jargon hidden), same rule the rail enforces.
- **Lineage = existing machinery.** `CreateLinkPopover → interactions.stageEdgeCreate(s,t,e) (:2656/:428)`, validated by `deriveConnectableEdges`. Drawn on-canvas (primary) or via an optional "Links" step in Build Mode calling the same `stageEdgeCreate`.
- **Free on the other canvases.** Because the machinery lives in the shared `create/` module, GraphCanvas and HierarchyCanvas inherit Build Mode exactly as they share the Hierarchy Builder today.

### 6. UX / premium bar

Spacious canvas-docked Build panel (not the 400px rail); glass/premium idiom (`glass-panel`, `accent-primary`, `font-display`); ontology-driven icons/colors everywhere (`DynamicIcon`, `visual.icon`/`visual.color`); plain language on the default path; keyboard-first + mouse-friendly; live counts; ELK entrance animation; Apply progress bar; transparent auto-fix. Guided-canvas empty state leads; Build Mode is one click away.

## Error handling

- **Validation:** auto-fix safe cases, flag the rest inline (plain-language, per-row), never block valid rows.
- **Save:** per-chunk atomicity + a failed-rows report; the draft is never left silently half-applied without the user knowing which rows failed and why.
- **Fail-open ontology:** unknown/edge-case ontology data degrades to permissive (consistent with existing preflight helpers), never a hard crash mid-authoring.

## Testing

- **Pure units:** `BuildRow` model ops; `validateBuildRows` (type inference, insert-parent, auto-promote, error cases); `stageBuildRows` O(n) planner; the save chunker (chunk boundaries, temp-urn threading across chunks).
- **Integration:** paste 1000 rows → validate → stage → assert one O(n) staging pass and ⌈N/500⌉ transactional save calls; partial-failure → correct report + valid chunks persisted.
- **Backend:** chunked commit endpoint atomicity + partial-failure semantics + `entityType` round-trip at batch scale.
- **Perf smoke:** render 1000-row grid + 1000-node HierarchyCanvas without jank (virtualization present).

## Phasing

- **Phase A — the by-hand journey (first).** Shared `BuildRow` model + input adapters (outline/grid/paste) + `validateBuildRows` (auto-fix) + Build panel + virtualization (Build panel + HierarchyCanvas) + O(n) `stageBuildRows` + guided-canvas-first empty state + on-canvas lineage parity. Delivers scale authoring on the existing per-op save.
- **Phase B — scale persistence.** Chunked transactional bulk save + progress + backend batch-commit endpoint + partial-failure report.
- **Later (separate spec):** CSV/Excel import-export onto the shared row model.
- **Parallel tracks:** type-change Phase 2/3 (own spec) + P2 trust gaps (own plan).

## Risks

1. **`useHierarchyOutline` refactor onto `BuildRow`** touches the shipped Hierarchy Builder — mitigate by making the row model a superset and migrating behind the same public hook API; existing rail behavior must be unchanged.
2. **Chunked-save temp-urn threading** across transaction boundaries (a child in chunk 2 referencing a parent committed in chunk 1) — the chunker must order parents-before-children and carry the remap; covered by an integration test.
3. **Backend batch endpoint** is new surface — atomicity + partial-failure semantics must be explicit and tested; coordinate with the versioning `/changes` commit path (and the separately-found gap that retype validation isn't on that path).
4. **Deferred ELK** must not leave the canvas visually stale mid-authoring — preview cheaply, full layout on Apply.
