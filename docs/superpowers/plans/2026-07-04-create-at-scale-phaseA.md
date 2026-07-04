# Create-at-Scale — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the by-hand create-at-scale journey — guided-canvas-first plus a dedicated "Build Mode" panel (outline/grid/paste over one shared row model) that stages hundreds–thousands of ontology-correct entities into the existing draft flow, staying fast (O(n) staging, virtualization) and crash-safe.

**Architecture:** A pure `BuildRow` model is the single source three thin input adapters edit; a pure `validateBuildRows` pass auto-fixes (type inference, insert-parent, auto-promote — reusing the shipped `ontologyPreflightService` planners); a pure/near-pure `stageBuildRows` commits the whole set in ONE O(n) pass into the existing `stagedChangesStore` + canvas store. The Build panel mounts on all three canvases via the existing `useHierarchyBuilderStore`. Runs on the existing per-op save (Phase B swaps in the one-commit batch).

**Tech Stack:** React 18 + TypeScript + Zustand + framer-motion + Tailwind; `@tanstack/react-virtual` (already a dep, used in `LayerColumn`); vitest. Backend untouched in Phase A.

## Global Constraints

- **Reuse, don't rebuild:** `typesValidForNode(node: RetypeNode, ctx: RetypeContext)`, `planRetype(rootNode, newType, ctx): RetypePlan`, `containmentChains(entityTypes, rootEntityTypes, opts?)`, `allowedChildTypeIds(parentType, entityTypes, rootEntityTypes, hierarchyMap)`, `deriveContainmentEdges`, `deriveConnectableEdges`, `sameId`, `findEntityType` — all in `frontend/src/services/ontologyPreflightService.ts`. **Verify each signature in-file before calling** (they have been revised mid-project).
- **Staged flow:** stage via the SAME `useStageEntityCreation.stageEntity` shape (temp urn `urn:staged:<type>:<id>`, optimistic node with `isPending:'create'`, a `create_entity` change with apply/discard). Layer assignment is the caller's job via a per-row callback (mirror duplicate's `onNodeCopied`).
- **Draft guard:** any path that stages MUST `await ensureDraftOpen()` first (the builder store already does this in `open()`).
- **Pure logic is pure:** `buildRow.ts`, `validateBuildRows.ts`, and the planning half of `stageBuildRows` take data in, return data out — no store/React imports — so they unit-test without mocks. Graph/ontology context is passed in.
- **Case-insensitive** type/edge id comparison via the shipped `sameId`.
- **tsc gate:** `cd frontend && npx tsc -b --pretty false 2>&1 | grep -c "error TS"` must not rise above the current baseline (~66). The 2 named pre-existing vitest failures (`GraphProviderContext`, `RegistryConnections`) are the only allowed failures.
- **Premium UI:** match the existing idiom exactly — `glass-panel`, `border-glass-border`, `bg-canvas-elevated/95`, `accent-primary`, `text-ink`/`text-ink-muted`, `font-display`, framer-motion, `DynamicIcon` with `visual.icon`/`visual.color`, plain language on the default path. The source of truth for styling is `HierarchyBuilderPanel.tsx` / `FlatTreeItem.tsx` / `LayerColumn.tsx` — UI tasks MATCH these; do not invent a new visual language.
- **Strict scope per task:** stage only the task's own files; `git diff --cached` before commit; never bare `git stash`; the tree is shared (check `git status` — unrelated uncommitted work must not be staged). Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

All new files under `frontend/src/components/canvas/create/build/` (a focused sub-module) unless noted:
- `buildRow.ts` — `BuildRow` types + pure row operations (create/insertSibling/insertChild/outdent/remove/reindexDepths/parentOf). **Task 1.**
- `validateBuildRows.ts` — pure validation + auto-fix. **Task 2.**
- `stageBuildRows.ts` — O(n) planning (`planBuildStaging`, pure) + a thin hook (`useStageBuildRows`) that commits the plan. **Task 3.**
- `buildRowsStore.ts` — Zustand store holding the working `BuildRow[]` + edits (the adapters mutate this). **Task 4.**
- `BuildPanel.tsx` — the canvas-docked shell: tabs (Outline/Grid/Paste), header counts, Apply. **Task 5.**
- `BuildOutline.tsx` / `BuildGrid.tsx` / `BuildPaste.tsx` — the three adapters. **Tasks 6/7/8.**
- `__tests__/*.test.ts(x)` alongside.

Modified:
- `hierarchyBuilderStore.ts` — add `surface: 'rail' | 'build'` + `openBuild()`; extend `BuilderMode` with `'grid'`. **Task 4.**
- `ContextViewCanvas.tsx`, `GraphCanvas.tsx`, `HierarchyCanvas.tsx` — mount `BuildPanel` gated on `surface==='build'`; add a "Build" entry + guided empty-state CTA. **Task 5.**
- `stagedChangesStore.ts` — add `stageMany(changes)` (single O(1) push of a batch). **Task 3.**
- `HierarchyCanvas.tsx` — virtualize the tree. **Task 9.**
- `StagedChangesPanel.tsx` — virtualize the change list. **Task 10.**
- `HierarchyCanvas.tsx` (drag-connect) + a collapse-level control. **Task 11.**
- `buildRowsStore.ts` persistence + `BuildPanel` recover prompt. **Task 12.**

---

### Task 1: `BuildRow` model + pure row operations

**Files:**
- Create: `frontend/src/components/canvas/create/build/buildRow.ts`
- Test: `frontend/src/components/canvas/create/build/__tests__/buildRow.test.ts`

**Interfaces:**
- Produces:
```ts
export interface BuildFix { field: 'type' | 'parent' | 'promote'; note: string }
export interface BuildIssue { message: string }
export interface BuildRow {
  id: string                 // stable client id
  name: string
  typeId: string | null
  parentId: string | null    // another BuildRow.id, or null for a root
  depth: number              // derived from parent chain
  description?: string
  tags?: string[]
  properties?: Record<string, unknown>
  status: 'valid' | 'fixed' | 'error'
  issues: BuildIssue[]
  fixes: BuildFix[]
}
export function makeRow(partial: { id: string; name?: string; typeId?: string | null; parentId?: string | null }): BuildRow
export function reindexDepths(rows: BuildRow[]): BuildRow[]  // recompute depth from parentId chains
export function insertSiblingAfter(rows: BuildRow[], afterId: string, row: BuildRow): BuildRow[]
export function insertChildOf(rows: BuildRow[], parentId: string, row: BuildRow): BuildRow[]
export function outdent(rows: BuildRow[], id: string): BuildRow[]   // reparent to grandparent
export function removeRow(rows: BuildRow[], id: string): BuildRow[] // removes row + its descendants
export function childrenOf(rows: BuildRow[], id: string | null): BuildRow[]
```
- Consumes: nothing (pure, no imports beyond a tiny id helper — use `crypto.randomUUID()` for ids; it's available in the app).

- [ ] **Step 1: Write the failing tests**
```ts
import { describe, it, expect } from 'vitest'
import { makeRow, reindexDepths, insertChildOf, insertSiblingAfter, outdent, removeRow, childrenOf, type BuildRow } from '../buildRow'

const rows = (): BuildRow[] => [
  makeRow({ id: 'a', name: 'A', parentId: null }),
  makeRow({ id: 'b', name: 'B', parentId: 'a' }),
  makeRow({ id: 'c', name: 'C', parentId: 'b' }),
]
describe('buildRow', () => {
  it('reindexDepths derives depth from the parent chain', () => {
    const r = reindexDepths(rows())
    expect(r.map(x => x.depth)).toEqual([0, 1, 2])
  })
  it('insertChildOf adds a child and depth reindexes', () => {
    const r = reindexDepths(insertChildOf(rows(), 'a', makeRow({ id: 'd', name: 'D' })))
    expect(r.find(x => x.id === 'd')!.parentId).toBe('a')
    expect(r.find(x => x.id === 'd')!.depth).toBe(1)
  })
  it('insertSiblingAfter shares the parent of the anchor', () => {
    const r = insertSiblingAfter(rows(), 'b', makeRow({ id: 'd', name: 'D' }))
    expect(r.find(x => x.id === 'd')!.parentId).toBe('a')
  })
  it('outdent reparents to the grandparent', () => {
    const r = reindexDepths(outdent(rows(), 'c'))
    expect(r.find(x => x.id === 'c')!.parentId).toBe('a')
    expect(r.find(x => x.id === 'c')!.depth).toBe(1)
  })
  it('removeRow removes the row and its descendants', () => {
    const r = removeRow(rows(), 'b')
    expect(r.map(x => x.id)).toEqual(['a'])
  })
  it('childrenOf returns direct children in order', () => {
    expect(childrenOf(rows(), 'a').map(x => x.id)).toEqual(['b'])
    expect(childrenOf(rows(), null).map(x => x.id)).toEqual(['a'])
  })
})
```
- [ ] **Step 2: Run to verify they fail** — `cd frontend && npx vitest run src/components/canvas/create/build/__tests__/buildRow.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement `buildRow.ts`** — pure array transforms; `reindexDepths` walks each row's `parentId` chain (guard cycles with a visited set, cap at rows.length); `removeRow` computes the descendant set via `childrenOf` recursion; `makeRow` defaults `status:'valid'`, `issues:[]`, `fixes:[]`, `typeId:null`, `parentId:null`, `depth:0`.
- [ ] **Step 4: Run to verify PASS.**
- [ ] **Step 5: Commit** — `git add` the two files; `feat(build): BuildRow model + pure row operations`.

---

### Task 2: `validateBuildRows` — auto-fix + status

**Files:**
- Create: `frontend/src/components/canvas/create/build/validateBuildRows.ts`
- Test: `frontend/src/components/canvas/create/build/__tests__/validateBuildRows.test.ts`

**Interfaces:**
- Consumes: `BuildRow` (Task 1); `allowedChildTypeIds`, `containmentChains`, `deriveContainmentEdges`, `planRetype`, `findEntityType`, `RetypeContext` (ontologyPreflightService — verify sigs).
- Produces:
```ts
export interface BuildOntologyCtx {
  entityTypes: EntityTypeSchema[]           // from useViewEntityTypes()
  rootEntityTypes: string[]                 // useViewRootEntityTypes()
  hierarchyMap: Record<string, { canContain?: string[]; canBeContainedBy?: string[] }>  // useViewEntityTypeHierarchyMap()
  relationshipTypes: RelationshipTypeSchema[]
  containmentEdgeTypes: string[]
}
// Pure: returns a NEW rows array — types inferred, missing parents inserted,
// leaf parents auto-promoted, each row's status/issues/fixes set.
export function validateBuildRows(rows: BuildRow[], ctx: BuildOntologyCtx): BuildRow[]
export interface BuildValidationSummary { valid: number; fixed: number; errors: number }
export function summarize(rows: BuildRow[]): BuildValidationSummary
```

**Auto-fix algorithm (top-down over depth-ordered rows):**
1. **Type inference** — if `typeId` is null: candidates = `allowedChildTypeIds(parentType, entityTypes, rootEntityTypes, hierarchyMap)`; 1 → assign (fix `{field:'type'}`); >1 → pick lowest `hierarchy.level` then name; 0 → leave null, mark error.
2. **Containment check + auto-promote** — if the row has a parent and the parent's `typeId` cannot contain this row's `typeId` (`deriveContainmentEdges(parentType, childType,…).some(allowed)` is false): try to auto-promote the PARENT via `planRetype` to a type that (a) still fits ITS parent and (b) can contain this child; if found and `plan.ok`, apply the parent's new type (fix `{field:'promote'}`). (Reuses the type-change planner.)
3. **Insert missing parent** — if the row is a root (or its parent still can't contain it) and a `containmentChains` path exists that would place this type under an allowed ancestor, synthesize the missing intermediate `BuildRow`(s) (fix `{field:'parent'}`), re-link, `reindexDepths`.
4. Any row still not placeable → `status:'error'`, plain-language `issues` (e.g. `"A Column can't sit directly under a Domain."`).
Fail-open: unknown ontology data → treat permissively, never throw.

- [ ] **Step 1: Write failing tests** — using a small default-ontology-shaped fixture (`domain`→`dataPlatform`→`container`→`dataset`, `group` self-nesting, `attribute` leaf):
```ts
// (a) infers a single-allowed child type
// (b) auto-promotes an attribute-typed parent to group when a child is added under it
// (c) inserts a missing parent level (dataset pasted at root -> gets domain/dataPlatform/container chain or nearest)
// (d) marks a genuinely-illegal nesting as error with a plain-language message
// (e) summarize() counts valid/fixed/errors
```
Write concrete fixtures + assertions on `typeId`, `parentId`, `status`, `fixes[].field`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** per the algorithm; build the `RetypeContext` for `planRetype` from the in-progress rows (adjacency from `childrenOf`/parent lookups on the BuildRow array + the ctx schema arrays).
- [ ] **Step 4: Run → PASS**; tsc ≤ baseline.
- [ ] **Step 5: Commit** — `feat(build): validateBuildRows auto-fix (infer/promote/insert-parent)`.

---

### Task 3: `stageBuildRows` — O(n) batch staging

**Files:**
- Create: `frontend/src/components/canvas/create/build/stageBuildRows.ts`
- Modify: `frontend/src/store/stagedChangesStore.ts` (add `stageMany`)
- Test: `frontend/src/components/canvas/create/build/__tests__/stageBuildRows.test.ts`

**Interfaces:**
- Produces:
```ts
// PURE planner: BuildRow[] -> the exact optimistic nodes, containment edges, and
// create_entity changes to commit, with temp urns threaded parent->child. No store access.
export interface BuildStagingPlan {
  nodes: LineageNode[]                 // canvas nodes (isPending:'create')
  edges: LineageEdge[]                 // containment edges (isPending:'create')
  changes: StagedChange[]              // create_entity changes (apply/discard)
  rowUrn: Map<string, string>          // BuildRow.id -> temp urn
}
export function planBuildStaging(rows: BuildRow[], opts: { rootParentUrn: string | null; containmentEdgeTypeFor: (parentType: string, childType: string) => string }): BuildStagingPlan
// Hook that commits the plan in ONE pass and reports per-row for layer assignment.
export function useStageBuildRows(): {
  stageBuildRows: (rows: BuildRow[], opts: { rootParentUrn: string | null; onRowStaged?: (rowId: string, urn: string) => void }) => Promise<Map<string, string>>
}
```
- Consumes: `BuildRow`; `stageMany` (new); `deriveContainmentEdges` for the edge type; `ensureDraftOpen`.

**The O(n) win:** today per-row `stageEntity` does a full-canvas parent `find` + full-array-copy `addNodes`/`stage` per row → O(n²). `planBuildStaging` resolves parents via a `Map<rowId, tempUrn>` (O(1)), builds the nodes/edges/changes arrays ONCE, and `stageBuildRows` commits with ONE `addNodes(plan.nodes)` + ONE `addEdges(plan.edges)` + ONE `stageMany(plan.changes)`. Temp urns generated with `crypto.randomUUID()`-based ids in the existing `urn:staged:<type>:<id>` shape. Each change's `apply`/`discard` mirrors `useStageEntityCreation` exactly (createNode with `properties`/`tags`/`containmentEdgeType`, temp-id resolution). `onRowStaged(rowId, urn)` fires per row so the caller assigns layers (ContextView) — mirrors duplicate's `onNodeCopied`.

- [ ] **Step 1: Failing test** — 3-level `BuildRow[]` (domain→platform→dataset) → assert `planBuildStaging` returns 3 nodes, 2 containment edges (parent temp urn → child temp urn), 3 create_entity changes, and `rowUrn` distinct per row; assert child edges reference the PARENT's temp urn from `rowUrn` (threading correct). Add a `stageMany` store test: staging N changes results in `changes.length === N` with a single state update.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `stageMany` (`set(s => ({ changes: [...s.changes, ...batch] }))`) + `planBuildStaging` (pure) + `useStageBuildRows` (await ensureDraftOpen; build plan; one addNodes/addEdges/stageMany; fire onRowStaged; return rowUrn).
- [ ] **Step 4: Run → PASS**; tsc ≤ baseline.
- [ ] **Step 5: Commit** — `feat(build): O(n) stageBuildRows batch staging + stageMany`.

---

### Task 4: `buildRowsStore` + builder-store surface/mode extension

**Files:**
- Create: `frontend/src/components/canvas/create/build/buildRowsStore.ts`
- Modify: `frontend/src/components/canvas/create/hierarchyBuilderStore.ts`
- Test: `frontend/src/components/canvas/create/build/__tests__/buildRowsStore.test.ts`

**Interfaces:**
- `buildRowsStore` (Zustand): `{ rows: BuildRow[]; setRows; addSibling(afterId); addChild(parentId); updateRow(id, patch); removeRow(id); reset() }` — the adapters (Tasks 6-8) mutate this; every mutation runs `reindexDepths`. Kept separate from `hierarchyBuilderStore` (open/scope) for single responsibility.
- `hierarchyBuilderStore`: extend `BuilderMode = 'outline' | 'paste' | 'grid'`; add `surface: 'rail' | 'build'` (default `'rail'`) to state + `open()` opts; add `openBuild(opts?)` = `open({ ...opts })` with `surface:'build'`. `close()` resets `surface` to `'rail'`. Existing `open()` callers are unchanged (default `'rail'`).

- [ ] **Step 1: Failing tests** — buildRowsStore: `addChild` sets parentId + reindexes depth; `updateRow` patches name/type; `removeRow` drops descendants. Builder store: `openBuild()` sets `isOpen && surface==='build'`; `open()` keeps `surface==='rail'`; `close()` resets to `'rail'`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** both; buildRowsStore ops delegate to `buildRow.ts` pure fns then `reindexDepths`.
- [ ] **Step 4: Run → PASS**; tsc ≤ baseline.
- [ ] **Step 5: Commit** — `feat(build): buildRows store + builder surface/mode extension`.

---

### Task 5: `BuildPanel` shell + canvas mounting + guided entry

**Files:**
- Create: `frontend/src/components/canvas/create/build/BuildPanel.tsx`
- Modify: `ContextViewCanvas.tsx`, `GraphCanvas.tsx`, `HierarchyCanvas.tsx`

**Interfaces:**
- Consumes: `buildRowsStore`, `hierarchyBuilderStore` (`surface`), `useStageBuildRows`, `validateBuildRows`/`summarize`, the view-scoped schema hooks (`useViewEntityTypes`, `useViewRootEntityTypes`, `useViewEntityTypeHierarchyMap`, `useViewRelationshipTypes`, `useViewContainmentEdgeTypes`).
- `BuildPanel` props: `{ onClose(): void; onRowStaged?(rowId, urn): void }`.

**Behavior:** a canvas-docked panel (wider than the 400px rail — e.g. a `motion.div` sized `min(720px, 55vw)`, same glass shell as `HierarchyBuilderPanel.tsx`), containing: header ("Build your model" + plain subtitle + scope banner reusing the rail's "Adding inside X"); a **tab strip** Outline / Grid / Paste (mounts Task 6/7/8; default tab = `hierarchyBuilderStore.initialMode`); a live **summary bar** from `summarize(validateBuildRows(rows, ctx))` ("998 valid · 12 auto-fixed · 2 to fix" + an auto-fix disclosure listing `fixes`); and a footer **Apply** button → `stageBuildRows(validatedRows, { rootParentUrn: parentUrn, onRowStaged })` then `buildRowsStore.reset()` + `close()`. Gate the existing `EntityDrawer` behind `!buildOpen` on each canvas (creation takes the surface), consistent with the rail.

**Mounting (each canvas):** add `const buildOpen = useHierarchyBuilderStore(s => s.isOpen && s.surface === 'build')` and, next to the existing `HierarchyBuilderPanel` mount, `{buildOpen && <BuildPanel onClose={() => useHierarchyBuilderStore.getState().close()} onRowStaged={...canvas layer assignment...} />}`. For ContextViewCanvas, `onRowStaged` reuses the exact `onEntityStaged` layer resolution (`nodeLayerMap`/`sortedLayers`/`assignEntityToLayer` via the `duplicateWiringRef` pattern). GraphCanvas/HierarchyCanvas pass no layer callback.

**Guided entry:** add a "Build" affordance beside each canvas's existing "Add entities" entry, and an **expand ⤢** on `HierarchyBuilderPanel` → `useHierarchyBuilderStore.getState().openBuild({ parentUrn, layerId })` carrying current scope. Update the blank-canvas empty state (`BuilderEmptyState`) to show "Add your first entity" (→ `open()`, guided) as primary and a quieter "Build a lot at once" (→ `openBuild()`).

**Verification:** no unit test (UI wiring). tsc ≤ baseline; eslint clean on touched files; manual: "Build" opens the panel on each canvas; Apply stages rows that appear in the correct ContextView layers; closing keeps the canvas intact.
- [ ] Steps: read `HierarchyBuilderPanel.tsx` + each canvas's builder mount → build `BuildPanel` shell (tabs stubbed to placeholders until 6-8) → wire mounts + entries → verify tsc/eslint/manual → commit `feat(build): BuildPanel shell + canvas mounting + guided entry`.

---

### Task 6: `BuildOutline` adapter (keyboard outliner)

**Files:** Create `build/BuildOutline.tsx`; may extract shared keyboard logic from `useHierarchyOutline.ts` (do NOT break the existing rail — keep `useHierarchyOutline`'s public API intact; factor shared helpers only if clean).

**Behavior:** renders `buildRowsStore.rows` as an indented outline (type chip via `DynamicIcon`, name input); keyboard: Enter=`addSibling`, Tab=`addChild`, Shift+Tab=`outdent`, on the active row. Live type inference shown from `validateBuildRows`. Reuse the row visuals from `FlatTreeItem`/`HierarchyBuilderPanel`. **Verification:** manual keyboard flow builds a nested tree in the store; tsc ≤ baseline. Commit `feat(build): outline adapter`.

---

### Task 7: `BuildGrid` adapter (virtualized spreadsheet)

**Files:** Create `build/BuildGrid.tsx`; Test `build/__tests__/BuildGrid.test.tsx` (light — a render + one edit assertion).

**Behavior:** a **virtualized** table (`@tanstack/react-virtual`, as in `LayerColumn.tsx:441`) over `buildRowsStore.rows`; columns Name / Type (typeahead with `DynamicIcon`) / Parent (row-name typeahead) / Description; row actions add-sibling/add-child/duplicate/delete; **fill-down** (set a column for a multi-row selection) and **paste-into-cell**. Indentation reflects `depth`. Every edit → store mutation → `reindexDepths`. **Verification:** vitest render mounts 1000 rows without mounting 1000 DOM rows (assert only a window renders); manual fill-down. tsc ≤ baseline. Commit `feat(build): virtualized grid adapter`.

---

### Task 8: `BuildPaste` adapter (parse + preview)

**Files:** Create `build/BuildPaste.tsx`. Reuse the existing `parseIndentedOutline` (`create/outlineParser.ts`) + a TSV split.

**Behavior:** a textarea → on paste/parse, produce `BuildRow[]` (map parsed rows: indent→parent chain, `Type: Name` prefix→typeId), load them into `buildRowsStore`, and show the same live validation summary + a **virtualized** preview list with per-row status/fix badges and inline correction. "Add N items" commits to the store (then the user hits Apply in the shell). **Verification:** unit test the paste→BuildRow mapping (reuse/extend `outlineParser` tests); virtualized preview; tsc ≤ baseline. Commit `feat(build): paste adapter + preview`.

---

### Task 9: Virtualize `HierarchyCanvas`

**Files:** Modify `frontend/src/components/canvas/HierarchyCanvas.tsx`.

**Behavior:** the tree renders every node via recursive `.map` today (mounts N components). Flatten the visible (expanded) tree into an ordered array and render via `@tanstack/react-virtual` (mirror `LayerColumn.tsx`), preserving expand/collapse, per-row actions, drag, and the inline "+add". **Verification:** render a 1000-node fixture → assert only a windowed subset mounts; existing HierarchyCanvas behavior (expand/collapse/add/duplicate) unchanged. tsc ≤ baseline; the 2 named vitest failures only. Commit `perf(hierarchy): virtualize the tree render`.

---

### Task 10: Virtualize the staged-changes review list

**Files:** Modify `frontend/src/components/versioning/StagedChangesPanel.tsx` (confirm path).

**Behavior:** it renders one framer-motion `ChangeRow` per change (`:306-317`) — unusable at 1000s. Keep the type grouping; **virtualize** each group's rows (`@tanstack/react-virtual`), and drop the per-row `AnimatePresence` to a group-level transition so 1000 rows don't each animate. (Grouped SUMMARY headline is Phase B; this task is the virtualization so review is at least usable.) **Verification:** render 1000 staged changes → windowed mount; existing filter/discard behavior intact. tsc ≤ baseline. Commit `perf(versioning): virtualize staged-changes review list`.

---

### Task 11: On-canvas lineage parity + collapse-level control

**Files:** Modify `HierarchyCanvas.tsx` (drag-connect wiring) + add a small collapse-level control to each canvas header.

**Behavior:** (a) wire drag-connect on HierarchyCanvas to match GraphCanvas/ContextView (it's the one canvas missing it) — reuse `useEdgeConnect`/`EdgeTypePickerPopover`/`interactions.stageEdgeCreate`; the click-based `CreateLinkPopover` already works, this adds the drag handle for parity. (b) Add "Collapse all / Expand to level N" controls driving the existing `expandedNodes` set, so a large model stays navigable. **Verification:** manual — drag-connect stages a lineage edge on HierarchyCanvas; collapse-all/expand-level works. tsc ≤ baseline. Commit `feat(canvas): HierarchyCanvas drag-connect parity + collapse-level controls`.

---

### Task 12: Draft resilience (local persistence + recover)

**Files:** Modify `buildRowsStore.ts` (add persistence) + `BuildPanel.tsx` (recover prompt).

**Behavior:** persist `buildRowsStore.rows` to `localStorage` keyed by `draftId + branch + viewId` (debounced), cleared on Apply/reset. On BuildPanel open, if persisted rows exist for the current key, show a "Recover your unsaved work? (N rows)" prompt → restore or discard. This is in-progress-authoring safety BEFORE Apply (staged changes already persist to the draft after Apply). Do NOT persist across a different branch/draft (scope the key; validate on restore). **Verification:** unit test the persist/restore keying (mock localStorage) incl. the wrong-branch guard; manual reload mid-build restores. tsc ≤ baseline. Commit `feat(build): draft-resilience local persistence + recover prompt`.

---

## Final

After Task 12: dispatch the whole-branch code review (`requesting-code-review`), then `superpowers:finishing-a-development-branch`. Carry the Minor findings from the per-task reviews into the final triage.

## Self-Review (author checklist — done)

- **Spec coverage:** shared row model (T1), auto-fix (T2), O(n) staging (T3), Build Mode surface + guided-first (T4/T5), three adapters (T6/7/8), virtualization ×3 (T7/T9/T10), lineage parity + navigation (T11), draft resilience (T12). Grouped-summary review + one-commit batch + batch undo + bulk ops are correctly deferred to Phase B/C per the spec. ✔
- **Type consistency:** `BuildRow`, `BuildOntologyCtx`, `BuildStagingPlan`, `validateBuildRows`, `stageBuildRows`, `planBuildStaging`, `stageMany`, `surface`/`BuilderMode` used consistently across tasks. ✔
- **No placeholders in logic tasks** (T1-T4 carry full test + impl detail); UI tasks (T5-T12) specify files/interfaces/integration/reference-components/verification and explicitly defer exact markup to the named existing premium components (the styling source of truth), per Global Constraints. ✔
- **Signatures:** verified against `ontologyPreflightService.ts` + `hierarchyBuilderStore.ts` + `useStageEntityCreation.ts` this session; implementers must re-verify before calling (Global Constraint). ✔
