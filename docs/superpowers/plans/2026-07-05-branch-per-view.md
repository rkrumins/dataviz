# Branch-Per-View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A draft/edit branch is isolated per **(data source, owner, view)** — dozens of views on one data source each get their own draft — while all branches/PRs/commits stay on the one versioned graph so Data-Source-level aggregation (all PRs/commits across all views) is preserved and gains a per-view slice.

**Architecture:** Docs-aligned (VERSIONING_E2E §3: a versioned graph is 1:1 with a data source; VERSIONING_DRAFTS_LINEAGE_AND_MERGE: branches live on the graph). We do NOT create per-view graphs. We ACTIVATE the existing `originating_view_id` attribution (already threaded through `open_draft` / `/resolve` models / a claim-if-null block): make `resolve_graph` FILTER drafts by view, always thread the viewId from the frontend, scope the frontend branch store by view, reset draft state on view-switch, and add a per-view filter to the Changes & Reviews aggregate queries (which stay graph-keyed by default). Supersedes the separate cross-view created-delta leak (per-view branches make the delta view-scoped for free).

**Tech Stack:** FastAPI + SQLAlchemy async + Postgres (graphver) backend; React + Zustand frontend; pytest (`GRAPHVER_E2E=1`) + vitest.

## Global Constraints

- **Graph stays 1:1 with data source.** Never create a per-view graph. Branches, PRs, commits remain on `graph_id`. Only the DRAFT-RESOLUTION lookup and the per-view FILTER change.
- **Aggregation is preserved, additive.** The branch-list / PR-list / commit-log queries stay graph-keyed by DEFAULT (Data-Source rollup shows every view). A per-view slice is an OPTIONAL `originating_view_id` filter — never the only result. This is a first-class test.
- **Core invariants (each a test):** (a) View A's draft edits are INVISIBLE in View B on the same source; (b) the Data-Source PR/commit/branch lists still show ALL views' activity; (c) a view with no open draft opens in PUBLISHED (read) mode; (d) an empty-view draft reads === main (the DraftOverlayProvider empty-delta identity — do not break it).
- **Back-compat, zero data loss:** legacy drafts with `originating_view_id IS NULL` are claim-filled by the first view that opens them (the existing block at `service.py:3049-3052`) — extend, don't replace. No destructive migration.
- Backend tests follow `backend/tests/test_versioning_*` / `integration/test_versioning_*` patterns (run with `GRAPHVER_E2E=1`, live Postgres). Frontend follows `branchStore` test patterns. `git status` before every commit; stage only the task's files; never bare `git stash`; commit trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- `backend/app/services/versioning/service.py` — `resolve_graph` draft filter (the crux); `open_draft_if_absent` per-view; `commit_log` already has `originating_view_id` param (`:2543`); verify branch-list + PR-list filters. **Tasks 1, 2.**
- `backend/app/api/v1/endpoints/versioning.py` — GET+POST `/resolve` thread `viewId`; branch-list / PR-list / commit-log endpoints accept optional `viewId` query. **Task 2.**
- `frontend/src/store/branchStore.ts` — scope `(ws, ds)` → `(ws, ds, viewId)`. **Task 3.**
- `frontend/src/features/versioning/model/ensureDraftOpen.ts` + the view-load resolve — always pass `viewId`. **Task 3.**
- The view-switch/navigation reset + default-Published. **Task 4.**
- `frontend/src/features/versioning/components/ViewVersioningPanel.tsx` (+ the PR/commit list components) — dual-scope (this view / whole data source). **Task 5.**

---

### Task 1: `resolve_graph` filters drafts by view (the crux)

**Files:** Modify `backend/app/services/versioning/service.py` (`resolve_graph` ~3032-3060, `open_draft`/`open_draft_if_absent` path). **Test:** `backend/tests/integration/test_versioning_branch_per_view.py` (new).

**Current behavior (read it):** `resolve_graph`'s draft query filters `graph_id == graph_id, owner == actor, kind=='draft', status=='open'` — NO view filter — and returns the most-recent (`order_by(created_at.desc()).first()`). A claim-if-null block adopts the caller's view if the found draft has none.

**Change:** when `originating_view_id` is provided, resolve the draft belonging to THAT view:
1. Prefer a draft with `originating_view_id == originating_view_id` (this view's own draft).
2. Else, if a draft with `originating_view_id IS NULL` exists, claim it (existing block — keep) and use it.
3. Else (only drafts belonging to OTHER views exist) → treat as NO draft for this view: if `open_draft_if_absent`, open a NEW draft for this view; otherwise return `my_draft=None` (⇒ the view opens Published).
When `originating_view_id` is None (a legacy/no-view caller), keep the current behavior (most-recent owner draft) — so nothing breaks for callers not yet passing a view.

**Interfaces produced:** `resolve_graph(..., originating_view_id, open_draft_if_absent)` now returns the view-scoped draft (or None). Signature unchanged; behavior view-aware.

- [ ] **Step 1: Failing test** — with a live graph + two view ids `v1`,`v2`, same owner:
```python
# open a draft resolving as v1, stage a change; then resolve as v2:
#   - v2 gets a DIFFERENT draft (or None if not opening) — NOT v1's draft with the change
#   - v1 resolves back to ITS draft (the staged change visible)
#   - a legacy draft with originating_view_id=None is claimed by the first resolver's view
```
Write concrete assertions on the returned `graph_id`/draft ref + that v2's resolved draft id != v1's.
- [ ] **Step 2: Run → FAIL** (today v2 gets v1's draft).
- [ ] **Step 3: Implement** the view-scoped draft selection (prefer-view → claim-null → open-new/none), preserving the None-view legacy path.
- [ ] **Step 4: Run → PASS.** Also run the existing `integration/test_versioning_draft_read_routing.py` + core versioning suite — no regressions.
- [ ] **Step 5: Commit** `fix(versioning): resolve drafts per originating_view_id (branch-per-view)`.

### Task 2: Thread viewId through `/resolve` + per-view filter on aggregate lists

**Files:** Modify `backend/app/api/v1/endpoints/versioning.py` (GET + POST `/resolve`; branch-list, PR-list `GET /graphs/{gid}/pulls`, commit-log endpoints). **Test:** extend `test_versioning_branch_per_view.py`.

**Changes:**
1. **GET `/resolve` must accept + pass `viewId`** (POST already does via `originatingViewId`). The investigation found the GET sends no view → it can't resolve the right view's draft on view-load. Add a `viewId` query param → pass as `originating_view_id` to `resolve_graph`.
2. **Aggregate lists stay graph-keyed (default) + optional `viewId` filter:** the branch-list, PR-list, and commit-log endpoints add an OPTIONAL `viewId` query param. Omitted ⇒ graph-wide (all views — the Data-Source rollup, UNCHANGED). Provided ⇒ filter by `originating_view_id`. `commit_log` already takes `originating_view_id` (`service.py:2543`) — wire the endpoint param through; add the same optional filter to branch-list + PR-list (PRs/branches carry `originating_view_id`).

- [ ] **Step 1: Failing tests** — (a) `GET /resolve?viewId=v2` after a v1 draft exists → resolves NOT-in-draft (Published) for v2; (b) `GET /pulls` (no viewId) lists PRs from BOTH v1 and v2; `GET /pulls?viewId=v1` lists only v1's; (c) commit-log same dual behavior.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the viewId query threading + optional filters (default graph-wide).
- [ ] **Step 4: Run → PASS**; existing versioning API tests green.
- [ ] **Step 5: Commit** `feat(versioning): viewId on /resolve + optional per-view filter on branch/PR/commit lists`.

### Task 3: Frontend branch-store scoped by view

**Files:** Modify `frontend/src/store/branchStore.ts` (`branchIdForScope` :79-83, `useEffectiveBranchId` :137-140, `setResolved.sameScope` :85-99), `frontend/src/features/versioning/model/ensureDraftOpen.ts` (:45-47) + the view-load resolve call. **Test:** `frontend/src/store/__tests__/branchStore.perView.test.ts` (new) + extend `stagedChangesStore.scope.test.ts` if needed.

**Change:** extend the branch-store scope key from `(workspaceId, dataSourceId)` to `(workspaceId, dataSourceId, viewId)`:
- `branchIdForScope(ws, ds, viewId)` and `useEffectiveBranchId(ws, ds, viewId)` include viewId.
- `setResolved.sameScope` compares viewId too, so switching views is `!sameScope` ⇒ branch state clears (feeds Task 4).
- `ensureDraftOpen` + the initial view-load resolve ALWAYS pass the current `viewId` (POST body `originatingViewId`, GET `?viewId=`).
- `isDraft` (= `!!effectiveBranchId`) becomes per-view automatically.

- [ ] **Step 1: Failing tests** — `branchIdForScope` differs for the same (ws,ds) with different viewId; `setResolved` for view v2 does not return v1's branchId; `sameScope` false across views.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the viewId-scoped keys + pass viewId on resolve.
- [ ] **Step 4: Run → PASS**; tsc ≤ baseline; full vitest = the 2 named pre-existing failures.
- [ ] **Step 5: Commit** `fix(versioning): scope frontend branch store by view (branch-per-view)`.

### Task 4: View-switch resets draft state → default Published

**Files:** Modify the ContextView / view-navigation load path (where `activeView`/`dataSourceId` changes; `ContextViewCanvas.tsx` reads `effectiveBranchId` at ~:475). Reuse `branchStore.reset()`/`switchToMain()`.

**Change:** on navigating to a DIFFERENT view, draft/edit state must not carry over. With Task 3's viewId-scoped `sameScope=false`, `setResolved` already clears branch state on view change; ensure the view-load then resolves the NEW view (GET `/resolve?viewId=`) — which returns Published (no draft) unless that view has its own open draft. Verify the header renders View (read) mode, not Edit, until the user explicitly enters edit for THIS view.

- [ ] Steps: trace `ContextViewCanvas` view-change effect; confirm/one-line-fix that a view switch re-resolves for the new view and defaults `isDraft=false` unless that view has a draft; manual + a small hook test if extractable. Commit `fix(versioning): view switch defaults to Published unless that view has its own draft`.

### Task 5: Changes & Reviews — dual scope (this view / whole data source)

**Files:** Modify `frontend/src/features/versioning/components/ViewVersioningPanel.tsx` + the PR-list / commit-list / branch-list child components + `frontend/src/services/versioningApiService.ts` (pass optional `viewId`).

**Change:** the Changes & Reviews panel (tabs Changes / Commits / PRs / Data health) gains a **This view ⟷ Whole data source** scope toggle (reuse the existing "This view / Whole graph" attribution pattern from the versioning-metadata work). "This view" passes `viewId` to the list APIs (per-view slice); "Whole data source" omits it (all views). Apply to PRs, commits, and branches. Default per the existing UX; both always reachable.

- [ ] Steps: read ViewVersioningPanel + the existing view/whole-graph toggle; wire the scope toggle to pass/omit `viewId` on the PR/commit/branch fetches; verify both slices render (this view's PRs vs all data-source PRs). tsc ≤ baseline; a component test asserting the toggle changes the API `viewId` arg. Commit `feat(versioning): dual-scope Changes & Reviews (this view / whole data source)`.

### Final: E2E invariants + whole-fix review

- **Invariant tests (backend integration + frontend):** (a) View A edit invisible in View B same source; (b) Data-Source PR/commit/branch lists show all views; (c) no-draft view opens Published; (d) empty-view draft === main (run existing `test_draft_overlay_provider.py` empty-delta identity — must stay green).
- Backend suite `GRAPHVER_E2E=1 pytest backend/tests/test_versioning_*.py backend/tests/integration/test_versioning_*.py -q` green.
- Whole-fix code review (requesting-code-review) with the four invariants + "aggregation stays graph-wide by default" as the review lens.
- Update `docs/VERSIONING_DRAFTS_LINEAGE_AND_MERGE.md` / `VERSIONING_E2E.md` with the per-view draft-resolution semantics.

## Self-Review (author)
- Docs alignment: graph 1:1 data source preserved; branches on graph; only resolution keyed by view. ✔
- Aggregation additive (default graph-wide + optional view filter) — Task 2 + Task 5, tested. ✔
- Back-compat: claim-if-null extended not replaced (Task 1). ✔
- Invariants a-d each have a task/test. ✔
- Supersedes cross-view leak: per-view branch ⇒ per-view delta. ✔
- Type consistency: `originating_view_id` (backend) / `originatingViewId`/`viewId` (API) / `viewId` (frontend scope) used consistently. ✔
