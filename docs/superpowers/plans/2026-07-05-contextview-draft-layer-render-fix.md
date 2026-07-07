# ContextView Draft Layer-Render Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Entities created in a Context Model view's draft (via Build Mode or any create path) render in their correct column immediately — fixing the "committed to the draft but invisible in the canvas" bug — by making the node's durable `layerAssignment` the canonical signal, scoped leak-safely to the branch's created-node delta.

**Architecture:** A closed-scope Context Model view today loads ONLY the URNs in its persisted `entityAssignments` and resolves layers ONLY from them (`useGraphHydration.ts:211-247`, `useLayerAssignment.ts:64-70`), deliberately ignoring the node's *global* `layerAssignment` to avoid cross-view leakage. Fix: compute the **branch-created-node delta** (entities created in this draft) and (a) union it into the closed-scope load set and (b) honor the node's `layerAssignment` in closed-scope **only for delta nodes** — leak-safe because arbitrary global-property nodes are never pulled in. Every create path stamps that durable `layerAssignment`.

**Tech Stack:** React + Zustand + TypeScript; existing staged-changes/versioning stores; vitest.

## Global Constraints

- **LEAK-SAFETY IS NON-NEGOTIABLE.** In closed-scope, the node `layerAssignment` may be honored ONLY for nodes in the branch-created-delta set. Never honor the global node property for arbitrary nodes in a closed-scope view — that reintroduces the cross-view leak the current code prevents (`useLayerAssignment.ts:64-70`).
- **Do not disturb existing precedence.** Open-scope resolution (the tuned tier order from commits f683568/cb57868) and the persisted-`entityAssignments` path must behave EXACTLY as today for all non-delta entities. The fix is purely ADDITIVE (a new delta-scoped tier in closed-scope + a load union).
- **Regression guard (mandatory):** a Context Model view with persisted assignments and NO branch-created entities must render byte-identically to today (same nodes, same columns). This must be a test.
- **Delta source:** the branch-created-node delta = the URNs of `create_entity` staged/committed changes for the active branch (from `stagedChangesStore`/the versioning draft state). Validate layer ids against the view's own layers (reuse the existing "valid layer ids in this view" guard, `useLayerAssignment.ts:12`).
- tsc baseline (~65-66) must not rise; the 2 named pre-existing vitest failures only. `git status` before each commit; stage only the task's files; never bare `git stash`; commit trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Branch-created-delta selector + leak-safe closed-scope resolve

**Files:** Create `frontend/src/hooks/useBranchCreatedDelta.ts` (or a selector in the versioning model) + test; Modify `frontend/src/hooks/useLayerAssignment.ts`.

**Interfaces:**
- Produces: `useBranchCreatedDelta(): Set<string>` — URNs created (`create_entity`) in the active branch's draft (read from `stagedChangesStore` committed+staged changes for the current scope). Pure-derivable → extract the set computation as a pure `branchCreatedUrns(changes): Set<string>` and unit-test it.
- `useLayerAssignment` gains, in its CLOSED-SCOPE branch only: if `nodeId ∈ delta` AND the node's `layerAssignment` is a valid layer id in this view → resolve to that layer. Else current behavior (entityAssignments / default) unchanged.

- [ ] Step 1: Failing tests — (a) `branchCreatedUrns` extracts exactly the create_entity target urns; (b) a resolve test: closed-scope view, node in delta with valid `layerAssignment` → resolves to that layer; node NOT in delta with the same `layerAssignment` → NOT resolved there (leak-safety); persisted `entityAssignments` node → unchanged.
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement the pure `branchCreatedUrns` + `useBranchCreatedDelta` + the delta-scoped closed-scope tier in `useLayerAssignment`.
- [ ] Step 4: Run → PASS; **add + run the regression test** (persisted-assignments view, empty delta → identical resolution to pre-change). tsc ≤ baseline.
- [ ] Step 5: Commit `fix(contextview): honor node layerAssignment for branch-created entities in closed-scope`.

### Task 2: Draft load unions the created-node delta

**Files:** Modify `frontend/src/hooks/useGraphHydration.ts` (the `assignedUrns`/`hasExplicitAssignments` block ~:211-247).

**Change:** in a draft, the closed-scope load set becomes `assignedUrns ∪ branchCreatedDelta` (load the entities you created this branch even though they're not yet in persisted `entityAssignments`). Guard: only in a draft/branch context; on `main`/published the delta is empty so behavior is unchanged. Reuse `useBranchCreatedDelta` from Task 1.

- [ ] Steps: read the hydration block; union the delta into the by-URN load; verify (manual: the 6 committed entities now fetch; a no-delta view loads exactly as before). tsc ≤ baseline. If the delta URNs need a `getNodes(urns)` fetch, batch them with the existing assigned fetch. Commit `fix(contextview): load branch-created entities in draft closed-scope`.

### Task 3: Create path stamps durable layerAssignment

**Files:** Modify the Build Mode create path — `frontend/src/components/canvas/create/buildmode/stageBuildRows.ts` and/or `ContextViewCanvas.tsx onRowStaged` (~:2547-2563).

**Change:** when Build Mode stages an entity scoped to a layer (ContextView), the created entity's durable `layerAssignment` must be set so it persists (goes into the `create_entity`'s `properties`/node data → `createNode` stamps it, matching how the rail's `useHierarchyOutline` stamps it — verify that mechanism and reuse it). Today `onRowStaged` writes only the session `referenceModelStore`; ADD durable stamping so Task 1's resolve has a value to read after reload. Keep the session assignment too (optimistic display).

- [ ] Steps: find how the rail persists `layerAssignment` at create (`useHierarchyOutline` → `createNode`); replicate for `stageBuildRows`/`onRowStaged` (stamp `layerAssignment` into the created node so it round-trips). Add a test if a pure helper is extractable. Verify E2E: Build Mode create scoped to "Objects" → entity has durable `layerAssignment` → renders under Objects after save+reload. Commit `fix(build): stamp durable layerAssignment on Build-Mode-created entities`.

### Task 4: Backend bulk/import endpoint parity (assess + coordinate)

The user's in-progress bulk/import endpoint (`d438575`/`bdb37ca`) creates entities server-side and was the reported repro path. It must ALSO set the entity's `layerAssignment` for created entities to land in a column. **Do NOT rewrite the user's in-progress endpoint blindly.** First READ it and report: does it accept/set `layerAssignment`? Then either add the minimal stamping (if the shape is clear and additive) or REPORT what the endpoint needs so the user can wire it. With Tasks 1+2, backend-created entities will at least LOAD (delta union) and, once they carry `layerAssignment`, resolve to the right column.

- [ ] Steps: read the import/export endpoint + its request model; report the gap + the minimal change; implement only if additive + unambiguous, else escalate.

### Final: End-to-end verification + whole-fix review

- E2E against the user's exact repro: in the "Global / Untitled Context Model" draft, create objects scoped to the "Objects" layer (Build Mode) → they render under Objects (not 0/0); a created `layer` entity renders under Layers. Save + reload → still correct.
- Regression: an existing curated view with persisted assignments + no new entities renders identically.
- Whole-fix code review (requesting-code-review) across Tasks 1-4, with the leak-safety + no-open-scope-regression constraints as the review lens.

## Self-Review (author)
- Leak-safety: node property honored ONLY for delta nodes (Task 1) — ✔ constraint + test.
- Additive: open-scope + persisted-assignment paths untouched; regression test mandated — ✔.
- Delta drives BOTH load (Task 2) and resolve (Task 1) from one source (`useBranchCreatedDelta`) — ✔ consistent.
- Every create path stamps the signal (Task 3 frontend; Task 4 backend) — ✔.
