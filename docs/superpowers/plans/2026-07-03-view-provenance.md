# View Provenance (createdBy / lastModifiedBy) — Spec + Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Two tasks, backend first.

**Goal:** Capture who last modified a view, resolve BOTH creator and modifier to real user display names server-side, and stop every surface that shows a raw user id.

**Context (verified reconnaissance, 2026-07-02):** `views.created_by` stores the auth user id and IS name-resolved by the API (`createdByName`/`createdByEmail` via a batched `UserORM` JOIN in `view_repo.py:_batch_enrich_rows`/`_get_creator_info`) — Explorer renders it. Gaps: (1) NO `updated_by` column exists; `PUT /views/{id}` resolves the user for RBAC (`views.py:436`) but never records them (`view_repo.update_view:403-446` stamps only `updated_at`); same for `update_visibility` (`view_repo.py:1018-1031`). (2) Admin `WorkspaceViewsSection.tsx:119-121` renders raw `view.createdBy` despite `createdByName` being on the object. (3) `viewToViewConfig` (`viewApiService.ts:418`) has a fake-id fallback `createdBy ?? 'user'`. (4) Unresolvable creators (NULL / `"anonymous"` sentinel from `views.py:119-121` / deleted users) fall back to displaying the raw id (`CreatorHoverCard.tsx:55`, `ExplorerListRow.tsx:228-236`).

**Out of scope (explicit):** favourite stamping (not an edit; pin flows through PUT so it's covered), usage tracking (`lastOpenedAt`/open counts — net-new feature, not approved), view revision history, backfilling legacy `updated_by` (unknowable — NULL; UI falls back).

## Global Constraints

- Migration style: idempotent raw SQL per `backend/alembic/versions/20260702_1900_insights_split.py` (`ADD COLUMN IF NOT EXISTS` / `DROP COLUMN IF EXISTS`); filename `YYYYMMDD_HHMM_slug.py`; ALSO add the column to `ViewORM` so `create_all` covers fresh DBs (see `20260615_1200_branch_description.py` docstring convention). VERIFY the current alembic head from the newest file in `backend/alembic/versions/` before setting `down_revision` — do not trust this doc.
- `updated_by` stores the same value convention as `created_by` (`_user_id(user)` — the principal id, `"anonymous"` sentinel when unauthenticated). Name resolution happens ONLY server-side in the existing enrichment layer; both ids resolved in ONE batched query (dedupe).
- Response field naming follows `ViewResponse`'s existing alias conventions (`backend/common/models/management.py:817-823`): `updatedBy`, `updatedByName`, `updatedByEmail`.
- UI: when a name can't be resolved, display **"Unknown"** — never a raw id as the primary label. The raw id may remain as secondary/mono detail (e.g. CreatorHoverCard footer, title attrs). Plain business language, existing design tokens.
- CONCURRENT SESSION: stage exact paths; `git diff --cached` hunk-verify every file before each commit; never `git add -A`. If HEAD moves mid-task, re-verify your files and continue. Volume flakiness: "working directory was deleted" → re-issue once; path fully gone → BLOCKED.
- Commit footer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Baselines: 2 pre-existing vitest failures (GraphProviderContext, RegistryConnections); 79 pre-existing tsc errors; pydantic deprecation warnings in backend test output.

---

### Task P1: Backend — `updated_by` capture + resolution

**Files:**
- Create: `backend/alembic/versions/20260703_0010_view_updated_by.py`
- Modify: `backend/app/db/models.py` (~647, beside `created_by`), `backend/app/db/repositories/view_repo.py` (`update_view` ~403-446, `update_visibility` ~1018-1031, `_get_creator_info` ~101-121, `_to_response` ~124-167, `_to_enriched_response` ~170-196, `_batch_enrich_rows` ~225-329), `backend/app/api/v1/endpoints/views.py` (`update_view` ~446 pass the actor), `backend/common/models/management.py` (`ViewResponse` ~817-823)
- Test: locate the existing views repo/endpoint test file(s) (search `backend/tests` for views tests) and extend following their conventions; if none fits, create `backend/tests/test_view_provenance.py` mirroring the closest management-DB test's fixtures.

**Interfaces (Task P2 relies on):** API `ViewResponse` gains `updatedBy: str|None`, `updatedByName: str|None`, `updatedByEmail: str|None` (camelCase aliases). Semantics: `updatedBy` NULL until the first post-migration edit; names NULL whenever unresolvable.

**Steps:** (TDD: write the failing repo/API tests first)
- [ ] Tests: (1) `update_view` with `user_id="usr_x"` → row.updated_by stamped + response carries `updatedByName` resolved from a seeded user; (2) `update_visibility` stamps it too; (3) freshly created view → `updatedBy is None`; (4) unresolvable id (no matching user) → `updatedBy` echoed, names None; (5) batch list path resolves creator AND modifier names in responses.
- [ ] RED run → implement: migration; ORM column `updated_by = Column(Text, nullable=True)`; repo signature `update_view(..., user_id: Optional[str] = None)` stamping `row.updated_by = user_id` when not None; endpoint passes `user_id=_user_id(user)`; `update_visibility` stamps from its existing `user_id` param; generalize creator-info resolution to resolve a set of ids (single batched query in `_batch_enrich_rows`; `_get_creator_info` → a two-id variant or a small `_resolve_user_ids(session, ids) -> dict[str, tuple[name,email]]` reused by both paths); extend `_to_response`/`_to_enriched_response` + `ViewResponse`.
- [ ] GREEN → run the touched backend test files + (if quick) the broader views test module; command + output in report.
- [ ] Commit: `feat: record and resolve who last modified a view`.

### Task P2: Frontend — surface provenance, kill raw-id displays

**Files:**
- Modify: `frontend/src/services/viewApiService.ts` (`View` type ~:35 add `updatedBy?/updatedByName?/updatedByEmail?`; `viewToViewConfig` ~:418 — replace the `?? 'user'` fake-id fallback with `?? ''` AFTER grepping its consumers — known: `ContextViewCanvas` creator equality, `ViewEditor.tsx:102` placeholder — and confirming '' is safe for each), `frontend/src/components/canvas/context-view/EditViewDetailsDialog.tsx` (provenance footer from its existing `getView` fetch), `frontend/src/components/admin/workspace/WorkspaceViewsSection.tsx` (~119-121 render `createdByName ?? 'Unknown'`, keep the id in a `title` attr), `frontend/src/components/explorer/CreatorHoverCard.tsx` (~:55 primary label falls back to `'Unknown'`, never the id; id stays in the mono footer), `frontend/src/components/explorer/ExplorerListRow.tsx` (~228-236 same 'Unknown' rule; leave sort-key fallbacks in `useExplorerViews.ts` alone — invisible).
- Test: extend `__tests__/EditViewDetailsDialog.test.tsx` (footer renders "Created by <name>" + "Last edited by <name>" from mocked getView; renders 'Unknown' + em-dash/absent-edit states); extend/add specs for the two Explorer/admin displays only if spec files already exist for them (don't scaffold new harnesses for legacy components — note coverage instead).

**Provenance footer spec (dialog):** quiet single- or two-line footer under the form, ink-muted: `Created by {createdByName ?? 'Unknown'} · {formatted createdAt}`; when `updatedBy` present: `· Last edited by {updatedByName ?? 'Unknown'} · {formatted updatedAt}`. Use whatever date-formatting helper the codebase already uses near views (search; plain `toLocaleDateString` acceptable if none).

**Steps:** tests-first for the dialog footer → RED → implement all display fixes → GREEN → full `npx vitest run` + `npx tsc --noEmit` vs baselines → commit: `feat: show view provenance with resolved names; stop raw user-id displays`.
