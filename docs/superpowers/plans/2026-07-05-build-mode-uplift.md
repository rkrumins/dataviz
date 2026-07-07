# Build Mode Uplift — type-derived layer assignment + interaction fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make "Build your model" (Build Mode) place entities in the correct type-named column, and fix the Outline/Grid interaction gaps, so a non-technical user can build a full `Layer → Object → Group → Attribute` model at scale and have every entity land where its type belongs.

**Architecture:** Today Build Mode stamps ONE layer (the column it was opened from) onto the entire batch, and a hard rule makes containment children inherit the parent's column — so a mixed-type batch collapses into one column. Fix: derive each row's layer from its TYPE at apply-time (auto-by-type, per the user's decision), with an explicit per-row Layer override in the Grid, and relax the inherit-parent rule for a child whose type maps to a DIFFERENT layer so it breaks out to its own column. Reuse the existing durable-render plumbing (node `layerAssignment` stamp + optimistic `assignEntityToLayer`, FIX-T1/T2/T3).

**Tech Stack:** React/TypeScript/Zustand; vitest. Build Mode under `frontend/src/components/canvas/create/buildmode/`.

## Global Constraints

- **ONTOLOGY-AGNOSTIC — works for ANY schema.** Nothing may hard-code type or layer names. The `Layer→Object→Group→Attribute` case is ONE example; the same code must work for `Domain→Application→Database→Table→Column`, `System→Database→Table`, or any hierarchy of any depth, and for any view's column set. ALL placement/legality decisions derive at runtime from (a) the view's own layer config (`sortedLayers[].entityTypes`) and (b) the schema/ontology (`rootEntityTypes`, `canBeContainedBy`, `builderAllowedChildTypeIds`). Do NOT assume a column-per-type: a view may have fewer columns than types (some types share a column or hit the fallback), a column may hold multiple types, and a type may map to no column. Handle all three gracefully.
- **Auto-by-type is the default** placement: `typeId → layerId` derived from `sortedLayers[].entityTypes` (reuse `resolveLayerAssignment`/`layerRules`, `useLayerAssignment.ts:78-115`). If a type maps to multiple layers, pick deterministically (first in `sortedLayers`). Fall back to the Build-open layer (`buildLayerId`) when a type maps to no layer.
- **Per-row Grid override wins** over auto-by-type when set.
- **Relax the inherit-parent-layer rule** (`useLayerAssignment.ts:198-205`) ONLY for a child whose type maps to a different layer than its parent — do not otherwise change containment inheritance (avoid side effects on non-Build flows).
- Durable render must survive reload in a closed-scope Context Model view (stamp node `layerAssignment` per row, mirror FIX-T3).
- No hard-coded type/layer names — derive from view config + ontology (`builderAllowedChildTypeIds`, `sortedLayers`).
- `ContextViewCanvas.tsx` is being edited by a concurrent session — keep edits there to the ~6 wiring lines (`:2162-2164` buildLayerId, `:2631` BuildPanel prop, `:2632-2638` onRowStaged). Never `git add -A`; stage only task files; `git diff --cached` before commit; never bare `git stash`. Commit trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- The external volume can unmount mid-session — on "file does not exist", STOP + report BLOCKED. Commit promptly once green.

---

### Task 1: Type-derived per-row layer resolver (CORE)
**Files:** `buildmode/stageBuildRows.ts` (single `opts.layerId` → `layerIdForRow` resolver; per-row durable stamp `:94,188-192,220-233`), a small pure `buildmode/resolveRowLayer.ts` (typeId→layerId map from `sortedLayers[].entityTypes`, override-aware), `useLayerAssignment.ts:198-205` (relax inherit for cross-layer-type children), `ContextViewCanvas.tsx` (~6 wiring lines: build the type→layer map, pass a resolver, per-row `assignEntityToLayer` in `onRowStaged`). **Test:** `buildmode/__tests__/resolveRowLayer.test.ts` + extend `stageBuildRows.test.ts`.
- [ ] Failing tests — use MULTIPLE ontology fixtures to prove genericity (no type/layer names hard-coded): (a) `Layer→Object→Group→Attribute` with a column per type; (b) `Domain→Application→Database→Table→Column`; (c) `System→Database→Table` with FEWER columns than types (prove fallback + a column holding 2 types). For each: `resolveRowLayer(row, {typeLayerMap, overrides, fallback})` returns the type's layer; override wins; fallback when a type maps to no column; deterministic pick when a type maps to >1 layer. `planBuildStaging` stamps EACH row's own `layerAssignment` (not one for all). A nested child whose type maps to a different layer keeps its own layer (not the parent's).
- [ ] Run → FAIL.
- [ ] Implement resolver + per-row stamp + relax the inherit rule (guard: only when child's type maps to a different, existing layer).
- [ ] Run → PASS; existing stageBuildRows/useLayerAssignment tests green.
- [ ] Commit `fix(buildmode): per-row type-derived layer assignment`.

### Task 2: Grid explicit Layer override column
**Files:** `buildmode/BuildGrid.tsx` (add a "Layer" column with a picker; store override on the row), `buildmode/buildRow.ts` (+`layerId?` field), `buildRowsStore` action. **Test:** extend BuildGrid/buildRow tests.
- [ ] Failing test: setting a row's Layer override makes `resolveRowLayer` return it (override wins); clearing falls back to type-derived.
- [ ] Run → FAIL.
- [ ] Implement the Layer column (default shows the auto-by-type target, editable), thread `layerId` override into the resolver.
- [ ] Run → PASS.
- [ ] Commit `feat(buildmode): per-row Layer override column in Grid`.

### Task 3: Outline — Enter to reach a new top-level entity
**Files:** `buildmode/BuildOutline.tsx:84-101` (`onNameKeyDown`), `buildmode/buildRow.ts` (updateRow parentId=null path if needed). **Test:** extend outline/buildRow tests.
- [ ] Failing test: Enter on an EMPTY row at depth>0 outdents one level; a second Enter on an empty root-level row starts a new top-level row (`parentId: null`).
- [ ] Run → FAIL.
- [ ] Implement Enter-on-empty outdent + double-Enter-to-root.
- [ ] Run → PASS.
- [ ] Commit `feat(buildmode): Enter on empty row climbs to a new top-level entity`.

### Task 4: Outline — per-row type change (shared type picker)
**Files:** extract `TypePickerPopover` from `BuildGrid.tsx:75-126` → `buildmode/TypePickerPopover.tsx` (shared); mount in `BuildOutline.tsx:166-168`; options via `builderAllowedChildTypeIds` for the row's parent; write `updateRow(row.id,{typeId})`. **Test:** picker options are ontology-legal for the parent; selecting writes typeId.
- [ ] Failing test: Outline row type picker offers only legal child types of the row's parent; selecting Attribute on a Group-under-Group row retypes it.
- [ ] Run → FAIL.
- [ ] Extract shared picker; mount in Outline; wire updateRow.
- [ ] Run → PASS; Grid still uses the shared picker (no regression).
- [ ] Commit `feat(buildmode): change a row's type in the Outline`.

### Task 5: Grid — make selection useful + harden checkbox
**Files:** `buildmode/BuildGrid.tsx:254-262` (checkbox onChange-driven), header select-all, a delete-selected action (works at size≥1, not only ≥2). **Test:** toggling selects; select-all; delete-selected removes rows.
- [ ] Failing test: clicking a row checkbox toggles its selection; a single selected row exposes a delete action; select-all selects all.
- [ ] Run → FAIL.
- [ ] Drive toggle from `onChange` (capture shift via mousedown ref); add select-all + delete-selected (make single-select actionable).
- [ ] Run → PASS.
- [ ] Commit `fix(buildmode): Grid selection works for one row + select-all/delete`.

### Task 6: Grid — duplicate cascades to the whole subtree
**Files:** `buildmode/buildRow.ts` (+pure `duplicateSubtree(rows,id)` — collect via `descendantIds` `buildGridSelection.ts:40-53`, mint fresh ids, re-thread `parentId`, insert block after the anchor's subtree), `buildRowsStore` action, `BuildGrid.tsx:517-523` (`handleDuplicate`). **Test:** duplicating a top-most row clones all descendants with new ids + preserved structure.
- [ ] Failing test: `duplicateSubtree` on a 3-level row returns a parallel subtree, distinct ids, parentIds re-threaded to the clones, inserted after the original subtree.
- [ ] Run → FAIL.
- [ ] Implement + wire `handleDuplicate`.
- [ ] Run → PASS.
- [ ] Commit `fix(buildmode): duplicate a row clones its whole subtree`.

### Task 7: Paste — finish the adapter (reuses the resolver)
**Files:** `buildmode/BuildPanel.tsx:210-217` (replace the "coming soon" stub), a Paste view using `outlineParser.ts` → BuildRow[] → preview → apply through the same `stageBuildRows` + type-derived resolver. **Test:** parse an indented list → rows with inferred types + per-type layers in the preview.
- [ ] Failing test: pasting an indented list yields BuildRow[] with legal types and each row's type-derived layer target shown.
- [ ] Run → FAIL.
- [ ] Implement Paste view (textarea → live `parseIndentedOutline` preview → Apply), sharing the resolver so placement matches Outline/Grid.
- [ ] Run → PASS.
- [ ] Commit `feat(buildmode): finish Paste adapter with type-derived placement`.

### Task 8: UX guidance
**Files:** `BuildPanel.tsx` (shortcut legend Enter/Tab/Shift+Tab; a footer "these land in \<columns\>" reflecting the type-derived targets), `BuildOutline.tsx:103-118` + `BuildGrid.tsx:534-549` (clearer empty states explaining modes + placement). Plain-language per the app standard.
- [ ] Add the legend + placement footer + empty-state guidance (no test — visual; verify tsc/lint).
- [ ] Commit `feat(buildmode): clearer Build Mode guidance + placement hint`.

### Final: whole-uplift review + user live test
- Review with the invariants: each type lands in its column (auto-by-type); override wins; cross-layer child breaks out; no regression to non-Build containment inheritance; Enter/type-change/checkbox/duplicate/paste all work; durable on reload.
- Hand to user for live test on their real ontology.

## Self-Review (author)
- Auto-by-type default + Grid override (T1/T2) — user's decision. ✔
- Inherit-rule relaxed only for cross-layer-type children (T1) — scoped, no broad side effect. ✔
- Enter-to-top-level (T3), Outline type change (T4), Grid selection (T5), duplicate cascade (T6), Paste (T7), guidance (T8). ✔
- Durable render reuses FIX-T3 stamp + assignEntityToLayer. ✔
- ContextViewCanvas edits minimized (concurrency). ✔
