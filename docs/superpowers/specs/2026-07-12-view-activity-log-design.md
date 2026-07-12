# Per-View Activity Log — Design

**Goal:** Give every view a full, premium "who changed what, when" activity timeline — surfaced consistently across all view surfaces — backed by a durable per-view log that also emits to the shared platform Event Log without coupling to it.

## Decisions (confirmed with user)

- **Events captured:** everything — `created`, `updated` (with field-level diff), `visibility_changed`, `shared` / `unshared`, `favourited` / `unfavourited`, `deleted`, `restored`.
- **Diff detail:** field-level for `updated` (name, description, layout/view type, filters, tags) and before→after for `visibility_changed`.
- **Wiring:** reachable everywhere — the shared view overflow menu (`ViewCardOverflowMenu`, so Explorer **and** the workspace Views tab get it), embedded as a tab in the Explorer preview drawer, and a panel on the full view page.
- **Event Log integration (don't couple, capture consistently):** each mutation ALSO emits `visualization.view.<verb>` to the shared outbox (`outbox_event_repo.emit`) in the same transaction. The per-view timeline reads ONLY its own dedicated table, never the outbox — so the read path has zero dependency on the event-log system.

## Architecture

Mirror the proven `ontology_audit_log` pattern (dedicated per-entity audit table + a `_record_audit` helper called at each mutation + a `get_audit_log` reader + a `GET /{id}/audit` endpoint).

### Backend

**Table `view_activity_log`** (`ViewActivityLogORM`, new in `db/models.py`), mirrors `OntologyAuditLogORM`:
- `id` (`val_<uuid12>`), `view_id` (indexed), `workspace_id` (indexed — scoping/auth), `action`, `actor` (principal id), `summary`, `changes` (JSON, nullable), `created_at`.
- Indexes: `view_id`, `(view_id, created_at)`, `created_at`. CHECK constraint on the action enum.

**Recorder `record_view_activity(session, *, view, action, actor, summary=None, changes=None)`** in a new small module `db/repositories/view_activity_repo.py` (keeps `view_repo.py` lean). In one transaction it:
1. `session.add(ViewActivityLogORM(...))` — the durable timeline row.
2. `outbox_event_repo.emit(session, event_type=f"visualization.view.{action}", aggregate_id=view.id, aggregate_type="view", payload={workspaceId, actor, summary, changes})` — shared Event Log, consistent capture. `emit` only `session.add`s (no I/O), so it never fails at call time for a valid event type.

Action → event-type verb map keeps both in sync (e.g. `visibility_changed` → `visualization.view.visibility_changed`). All satisfy the `<domain>.<entity>.<verb>` contract (`visualization` is an existing valid domain; `view` examples are in the outbox docstring).

**Hook points** (all funnel through `view_repo.py` except grants):
- `create_view` → `created`
- `update_view` → `updated` + field diff (compare old vs new: name, description, view_type, config-derived layout/filters, tags). Skip when nothing meaningful changed. `update_view_layout` (node positions) is NOT logged (too granular / high-frequency).
- `update_visibility` → `visibility_changed`, `changes={from,to}`
- `delete_view` → `deleted`; `restore_view` → `restored`
- `favourite_view` / `unfavourite_view` → `favourited` / `unfavourited` (actor = the favouriting user)
- `view_grants.create_grant` / `delete_grant` → `shared` / `unshared`, summary names the subject

**Reader `get_view_activity(session, view_id, *, action=None, limit=50, offset=0)`** → newest first; resolves `actor` → display name/email via the existing `view_repo.resolve_user_ids` batch resolver.

**Endpoint `GET /api/v1/views/{view_id}/activity`** in `views.py`: gated by the existing `view_access` read check (whoever can read the view sees its history); returns `list[ViewActivityEntry]` (pydantic: `id, action, actor, actorName, actorEmail, summary, changes, createdAt`). Optional `?action=` + `?limit`/`?offset`.

**Backfill anchor:** if a view has no activity rows (legacy), the reader synthesizes a terminal `created` entry from `created_at`/`created_by` (and a `updated`/`data_published` anchor from `updated_by`/`data_updated_by`) labelled "recorded before activity tracking" so the timeline is never blank.

**Migration:** Alembic revision creating `view_activity_log` (+ indexes). SQLite tests get it via `Base.metadata.create_all`.

### Frontend

**Service:** `viewApiService.getViewActivity(viewId, opts?)` → `ViewActivityEntry[]` (+ a React Query hook `useViewActivity(viewId, enabled)` with a short staleTime).

**`ViewActivityTimeline`** (premium, reusable): day-grouped vertical timeline; each entry = action icon (created=Plus, updated=Pencil, visibility=Eye/Lock, shared=Share2, favourited=Heart, deleted=Trash2, restored=RotateCcw) in a tinted node, actor avatar + name, human summary, relative time (exact on hover), and an expandable field-diff ("Renamed A→B", "Layout graph→hierarchy", "private→workspace"). A calm "Changes only / All activity" filter tames favourite/share noise; consecutive favourites collapse. Loading skeleton + empty state.

**`ViewActivityDrawer`** (reusable slide-over, `Backdrop` + framer-motion, `max-w-lg`) hosting the timeline for one view.

**Wiring:**
- `ViewCardOverflowMenu` — add an "Activity" item → opens `ViewActivityDrawer`. Inherited by Explorer cards AND the workspace Views tab cards/rows.
- `ExplorerPreviewDrawer` — add a Details | Activity tab hosting the timeline inline.
- `ViewPage` — an Activity panel/affordance.

## Out of scope / follow-ups
- Routing `visualization.view.*` into `auth_audit_log` (the RBAC/security audit UI) — the outbox emit makes it available; wiring the relay is a separate call.
- Data-freshness (`data_updated_*`) events from the versioning publish/merge fan-out — a nice future source; not hooked here.

## Verification
- Backend: pytest — recording on each mutation, endpoint returns entries newest-first, auth (non-reader 403), backfill anchor for legacy views, and that a `visualization.view.*` outbox row is emitted alongside.
- Frontend: `tsc` at baseline, production build; timeline renders entries/diffs/empty state.
