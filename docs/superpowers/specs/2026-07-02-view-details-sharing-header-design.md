# View Details & Sharing from the Context View Header — Design

**Date:** 2026-07-02 · **Status:** Approved (user, this date)

## Context

View metadata editing and view sharing are fully built server-side (`PUT /views/{id}`,
`PUT /views/{id}/visibility`, `GET/POST/DELETE /views/{id}/grants`, 3-layer access model in
`backend/app/services/view_access.py`) and sharing even has a complete frontend dialog
(`frontend/src/components/views/ShareViewDialog.tsx`) — but none of it is reachable from the
Context View canvas; only the Explorer page wires it. This feature surfaces both from
`ContextViewHeader`, gated by view-level rights, without any backend change.

Distinct permission families (deliberate):
- **Edit view details** = `workspace:view:edit` OR creator (backend also honors explicit
  editor grants — the JWT claims can't see grants client-side, so grant-only editors won't
  see the affordance in v1; the backend remains the enforcer).
- **Manage sharing** = creator OR `workspace:admin` OR `system:admin` (mirrors
  `view_grants.py::can_manage_view_grants`).
- Both are independent of canvas Edit mode (`workspace:datasource:manage` + draft): view
  metadata is not graph data, so the title menu behaves identically on Published and drafts.

## Components

1. **`header/ViewTitleMenu.tsx`** (new): the header title gains a subtle chevron ONLY when
   the user has ≥1 capability (`canEditView || canShareView`); otherwise the title stays a
   plain label (calm-view principle). Menu items, individually gated:
   - "Edit details…" (`canEditView`) → `onEditViewDetails()`
   - "Share…" (`canShareView`) → `onShareView()`
   - Read-only visibility row ("Private / Workspace / Enterprise" badge) when known.
2. **`EditViewDetailsDialog`** (new, small — follow `features/ontology/components/dialogs/EditDetailsDialog.tsx`
   conventions): fields name, description, tags. On open, fetch `GET /views/{id}` (the
   in-store `ViewConfiguration` lacks description/tags/visibility); save via existing
   `viewApiService.updateView`; on success update `useSchemaStore.updateView` (local) so the
   header refreshes instantly + toast.
3. **Share** — mount the existing `ShareViewDialog` unchanged from the canvas; seed
   `currentVisibility` from the same `GET /views/{id}` fetch; refresh after changes.
4. **Inline rename** — double-click the title (when `canEditView`) swaps to an input
   (`LayerHierarchyPanel` input-swap precedent; no contentEditable). Enter/blur commits via
   the same update path; Escape cancels; empty/unchanged input is a no-op.

## Architecture / data flow

Header stays 100% prop-driven (store-free): new props `canEditView: boolean`,
`canShareView: boolean`, `viewVisibility?: 'private'|'workspace'|'enterprise'`,
`onRenameView?: (name: string) => void`, `onEditViewDetails?: () => void`,
`onShareView?: () => void`. Dialog state + API calls + store refresh live in
`ContextViewCanvas` (which already owns `activeView`, `activeWorkspaceId`, toasts).
Capability derivation in the canvas: `canEditView = usePermission('workspace:view:edit', wsId)
|| activeView.createdBy === currentUserId`; `canShareView = activeView.createdBy === me ||
usePermission('workspace:admin', wsId) || system:admin` (via existing auth-store helpers).

## Error handling

Backend 403 (e.g. grant-revoked mid-session, RBAC_ENFORCE_VIEWS on) → error toast with the
server detail; dialog stays open with fields intact. Fetch failure on dialog open → toast +
close. Rename failure → revert title to previous name + toast.

## Testing

Vitest specs (existing header patterns): plain viewer → no chevron/menu; `canEditView` only →
menu shows Edit details, not Share; `canShareView` → Share visible; rename: double-click
swaps input, Enter fires `onRenameView`, Escape cancels; dialog: fetch-on-open seeds fields,
save calls `updateView` + store update; menu absent entirely when both capabilities false.

## Out of scope (recorded)

- Public share-links (tokenized anonymous access) — rejected for v1 (new backend feature).
- Advanced Search UX improvements — recommendation delivered separately; not in this build.
- Surfacing grant-based editor capability client-side (needs an effective-access endpoint).
