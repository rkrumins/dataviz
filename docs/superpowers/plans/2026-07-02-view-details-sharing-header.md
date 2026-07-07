# View Details & Sharing from the Context View Header — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users with view-level rights rename a view inline, edit its details (name/description/tags), and manage sharing (visibility + grants) directly from the Context View header.

**Architecture:** Frontend-only. A new prop-driven `ViewTitleMenu` in the header raises callbacks; `ContextViewCanvas` owns capability derivation, the two dialogs (new small `EditViewDetailsDialog`, existing `ShareViewDialog` reused verbatim), API calls (`viewApiService`), and schema-store refresh. Spec: `docs/superpowers/specs/2026-07-02-view-details-sharing-header-design.md`.

**Tech Stack:** React 18 + TS, Zustand, Tailwind (tokens: `text-ink`, `canvas-elevated`, `glass-border`, `accent-lineage`, `font-display`), framer-motion, lucide-react, Vitest/@testing-library.

## Global Constraints

- Header components stay 100% store-free (props + callbacks only) — dialogs/API/store live in `ContextViewCanvas`.
- Calm-view principle: a user with NO view-level capability sees a plain title — no chevron, no menu, no hover affordance.
- Edit-view rights ≠ canvas Edit mode: the title menu behaves identically on Published and drafts; do NOT gate any of it on `isDraft`/`canManage`.
- Capability rules (client-side mirror; backend remains enforcer): `canEditView = usePermission('workspace:view:edit', wsId) || view.createdBy === currentUserId`; `canShareView` mirrors ExplorerPage's existing Share gating (which mirrors backend `can_manage_view_grants`: creator OR workspace admin OR system admin) — READ ExplorerPage.tsx (~:369, :858) and reuse its exact logic/helpers rather than inventing new checks.
- No backend changes. No new dependencies. Reuse `ShareViewDialog` UNMODIFIED (adapt the caller, not the dialog; if its props genuinely can't be satisfied from the canvas, stop and escalate).
- Inline rename uses the input-swap pattern (`LayerHierarchyPanel.tsx:275,362-374` precedent) — NO contentEditable.
- Existing conventions: dialog markup per `features/ontology/components/dialogs/EditDetailsDialog.tsx` + name/description field markup per `components/views/ViewEditor.tsx:286,297`; toasts via `useToast`.
- CONCURRENT SESSION RULE: stage exact paths only; run `git diff --cached` before every commit and verify every hunk is yours; never `git add -A`. Volume flakiness: "working directory was deleted" → re-issue once; path fully gone → report BLOCKED.
- Commit footer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Verification baseline: 2 pre-existing vitest failures (GraphProviderContext, RegistryConnections) and 79 pre-existing tsc errors are NOT yours to fix.

---

### Task 1: ViewTitleMenu + inline rename in the header (prop-driven)

**Files:**
- Create: `frontend/src/components/canvas/context-view/header/ViewTitleMenu.tsx`
- Modify: `frontend/src/components/canvas/context-view/ContextViewHeader.tsx` (title block, ~lines 240-268; props interface ~30-130)
- Test: `frontend/src/components/canvas/context-view/__tests__/ViewTitleMenu.test.tsx`; extend `__tests__/ContextViewHeader.test.tsx`

**Interfaces:**
- Produces (Task 2 relies on these exact names): new optional `ContextViewHeaderProps`:

```ts
  // View-level capabilities + metadata actions (independent of isDraft/canManage —
  // view metadata is not graph data; see spec).
  canEditView?: boolean            // default false
  canShareView?: boolean           // default false
  viewVisibility?: 'private' | 'workspace' | 'enterprise'
  onRenameView?: (name: string) => void
  onEditViewDetails?: () => void
  onShareView?: () => void
```

- `ViewTitleMenu` props: `{ viewName: string; subline: string; canEditView: boolean; canShareView: boolean; viewVisibility?: 'private'|'workspace'|'enterprise'; onRenameView?: (name: string) => void; onEditViewDetails?: () => void; onShareView?: () => void; syncStatus: ...; onRetrySync?: () => void }` — it absorbs the whole current title block (icon, h2, subline incl. the saving spinner + retry button) so the header shell just renders `<ViewTitleMenu …/>`.

**Steps:**

- [ ] **Step 1: Write failing specs** (`ViewTitleMenu.test.tsx`) — render with plain props:
  1. `canEditView=false, canShareView=false` → title renders as plain text; NO chevron button (query by role/button absence), double-click does NOT swap to an input.
  2. `canEditView=true` → chevron present; click opens menu; "Edit details…" fires `onEditViewDetails`; "Share…" absent.
  3. `canShareView=true` → "Share…" fires `onShareView`; visibility row shows "Workspace" when `viewVisibility='workspace'`.
  4. Inline rename: with `canEditView`, double-click the title → input appears pre-filled; type new name + Enter → `onRenameView('New name')` called once and input closes; Escape → no call, original title restored; committing an unchanged or empty/whitespace name → no call.
  5. Menu closes on Escape/outside click (follow the popover conventions in `header/DisplayMenu.tsx`).
- [ ] **Step 2: Run specs, verify they fail** (`cd frontend && npx vitest run src/components/canvas/context-view/__tests__/ViewTitleMenu.test.tsx` → all fail: component doesn't exist).
- [ ] **Step 3: Implement `ViewTitleMenu.tsx`.** Chevron: `LucideIcons.ChevronDown w-3.5`, rendered only when `canEditView || canShareView`; low-contrast (`text-ink-muted/50`), raised on group-hover; `aria-label="View options"`. Menu: small popover panel styled like `DisplayMenu`'s shell (`bg-canvas-elevated/95 backdrop-blur-xl` etc.), items with icons `PenLine` (Edit details…), `Share2` (Share…), visibility row with `Lock`/`Building2`/`Globe` per tier, plain-language labels ("Private — only people it's shared with", "Workspace — everyone in this workspace", "Enterprise — the whole organisation"; keep the row label short, put the long form in `title`). Inline rename: `isRenaming` state; double-click on the `<h2>` (only when `canEditView`) swaps to `<input>` with the current name selected (`autoFocus`, `onFocus={e => e.target.select()}`); Enter/blur commits via `onRenameView(trimmed)` iff trimmed non-empty and ≠ current; Escape cancels. The h2 gets `title` hint "Double-click to rename" only when `canEditView`.
- [ ] **Step 4: Slim `ContextViewHeader.tsx`** — replace the inline title block with `<ViewTitleMenu …/>`, add the six new props (defaults preserving current behavior), pass through. Extend `ContextViewHeader.test.tsx`: default props (no capabilities) render a plain title — regression-pins the calm-view rule at the header level.
- [ ] **Step 5: Run the two spec files + `npx tsc --noEmit` (no NEW errors) → green. Full `npx vitest run` once.**
- [ ] **Step 6: Commit** (exact paths; hunk check): `feat: view title menu with inline rename in Context View header` + footer.

### Task 2: Canvas wiring — capabilities, EditViewDetailsDialog, ShareViewDialog

**Files:**
- Create: `frontend/src/components/canvas/context-view/EditViewDetailsDialog.tsx`
- Modify: `frontend/src/components/canvas/context-view/ContextViewCanvas.tsx` (header wiring region ~1990s + dialog mounts near other panels)
- Test: `frontend/src/components/canvas/context-view/__tests__/EditViewDetailsDialog.test.tsx`

**Interfaces:**
- Consumes Task 1's header props (exact names above).
- `EditViewDetailsDialog` props: `{ open: boolean; viewId: string; onClose: () => void; onSaved: (updated: { name: string; description?: string; tags?: string[] }) => void }`. Internally: on open, `viewApiService.getView(viewId)` seeds name/description/tags (loading state while fetching; fetch failure → toast + `onClose`); Save → `viewApiService.updateView(viewId, { name, description, tags })` with `isSaving` state; 4xx/5xx → error toast with server detail, dialog stays open; success → `onSaved(fields)` + `onClose`. Check `viewApiService.ts` for the exact fn names/signatures (`getView`/`updateView`, `ViewUpdateRequest` at ~:69) and reuse them — do not add new service functions unless one is genuinely missing (if missing, add following the file's conventions).

**Steps:**

- [ ] **Step 1: Write failing dialog specs** (mock `@/services/viewApiService` + toast):
  1. Opens → shows loading, then fields seeded from mocked `getView` (name/description/tags).
  2. Edit name + Save → `updateView` called with exactly the changed payload; `onSaved` receives the fields; dialog closes.
  3. `updateView` rejects → error toast, dialog stays open, fields intact.
  4. Cancel → no `updateView` call.
- [ ] **Step 2: Run → fail (component missing).**
- [ ] **Step 3: Implement the dialog** per `EditDetailsDialog.tsx` conventions (centered modal, overlay, framer-motion scale-in, `z-[70]`); name input + description textarea markup per `ViewEditor.tsx:286,297`; tags as a simple comma-separated input or chip input ONLY if a chip-input component already exists (search first; comma-separated is acceptable v1 — note choice).
- [ ] **Step 4: Wire `ContextViewCanvas`:**

```ts
// Capabilities (see Global Constraints; reuse ExplorerPage's helpers/logic for share)
const currentUserId = /* auth store — find the existing selector ExplorerPage/auth uses */
const canEditView = usePermission('workspace:view:edit', activeWorkspaceId ?? undefined)
  || (!!activeView?.createdBy && activeView.createdBy === currentUserId)
const canShareView = /* mirror ExplorerPage's Share gating exactly */
// State: viewDetailsOpen, shareOpen, shareSeed ({id,name,visibility} | null)
// onRenameView: optimistic — useSchemaStore.getState().updateView(viewId,{name}) then
//   viewApiService.updateView(viewId,{name}); on failure revert store to previous name + error toast.
// onEditViewDetails: setViewDetailsOpen(true)
// onSaved: useSchemaStore.getState().updateView(viewId, fieldsSubsetTheStoreKnows) // name/description
// onShareView: fetch getView(viewId) → setShareSeed({id,name,visibility}) → setShareOpen(true);
//   fetch failure → toast. Render <ShareViewDialog> with EXACTLY the props ExplorerPage:858 passes.
// viewVisibility: keep the last fetched value in state (undefined until first Share open — fine;
//   menu hides the row when undefined).
```

  Pass all six new props into `<ContextViewHeader …/>`.
- [ ] **Step 5: Verify** — dialog specs + Task 1 specs + full `npx vitest run` (baseline failures only) + `npx tsc --noEmit` (no NEW errors).
- [ ] **Step 6: Commit**: `feat: edit view details and share a view from the Context View canvas` + footer.

---

## Self-review notes (done)

- Spec coverage: title menu ✓ (T1), inline rename ✓ (T1), details dialog + fetch-on-open ✓ (T2), share reuse + visibility threading ✓ (T2), capability rules ✓ (T2 + Global Constraints), error handling ✓ (T2 steps 1.3/interfaces + rename revert), calm-view ✓ (T1 tests 1 + header regression), tests ✓.
- No placeholders; type names consistent across tasks (six prop names repeated verbatim).
- Grant-only editors not seeing affordances = documented v1 limitation (spec, out of scope).
