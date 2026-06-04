# RBAC

> Phase 7 enterprise hardening folded into Phase 5/6 taxonomy.
> Last updated: 2026-06-04 (Phase 7 — session-kill on revoke,
> time-bound bindings, audit log, custom-role picker filter,
> workspace deletion cascade). The Phase-5 migration
> `20260603_1100_rbac_uplift` is unchanged.

## TL;DR

* Five built-in roles. Two global, three workspace-scoped.
* Permissions are namespaced by category — `system:*` or `workspace:*`.
  The resolver only emits perms whose category matches the binding's
  scope; cross-category leaves are silently dropped.
* `workspace:admin` auto-implies every other `workspace:*` permission
  in the same workspace. Operators don't enumerate.
* `system:org-admin` is a global shortcut for any workspace-scoped
  check — the `org_admin` tier acts in every workspace without
  per-workspace bindings.

## The five roles

| Role               | Scope     | Carries (after resolve)                                  | When to bind                                                    |
|--------------------|-----------|----------------------------------------------------------|-----------------------------------------------------------------|
| `super_admin`      | global    | `system:admin` (implies everything)                      | Platform owner / SRE break-glass. Bind sparingly.               |
| `org_admin`        | global    | `system:org-admin`, `system:workspaces:create`, `system:groups:manage`, `workspace:*` (via shortcut) | Org-wide operator who curates workspaces but doesn't own users / SSO. |
| `workspace_admin`  | workspace | `workspace:admin` (auto-implies all `workspace:*`)       | Workspace owner who manages members + settings.                 |
| `workspace_member` | workspace | `workspace:view:*`, `workspace:datasource:*`             | Standard contributor — edit views + manage data sources.         |
| `workspace_viewer` | workspace | `workspace:view:read`, `workspace:datasource:read`       | Read-only auditor / executive who shouldn't be able to edit.    |

The two **global** roles live at `scope_type='global'`, `scope_id=NULL`.
The three **workspace** roles are stored at global scope too (they're
templates that bind to any workspace), but binding them only emits
workspace-category perms thanks to the resolver's filter.

## Permission catalogue

| ID                              | Category  | Carried by (built-in roles)        |
|---------------------------------|-----------|------------------------------------|
| `system:admin`                  | system    | `super_admin`                      |
| `system:org-admin`              | system    | `super_admin`, `org_admin`         |
| `system:users:manage`           | system    | `super_admin`                      |
| `system:groups:manage`          | system    | `super_admin`, `org_admin`         |
| `system:workspaces:create`      | system    | `super_admin`, `org_admin`         |
| `workspace:admin`               | workspace | `super_admin`, `org_admin`, `workspace_admin` |
| `workspace:datasource:manage`   | workspace | `super_admin`, `org_admin`, `workspace_admin`*, `workspace_member` |
| `workspace:datasource:read`     | workspace | + `workspace_viewer`               |
| `workspace:view:create`         | workspace | `super_admin`, `org_admin`, `workspace_admin`*, `workspace_member` |
| `workspace:view:edit`           | workspace | (same)                             |
| `workspace:view:delete`         | workspace | (same)                             |
| `workspace:view:read`           | workspace | + `workspace_viewer`               |

\* `workspace_admin` only stores `workspace:admin` in
`role_permissions`. The other `workspace:*` perms come from the
resolver's auto-implication rule — see *Auto-implication* below.

## Resolver behaviour

### 1. Category × scope filter

Every binding's permissions are filtered against the binding's scope:

* `binding.scope_type='global'` → only `category='system'` perms land
  in `global_perms`.
* `binding.scope_type='workspace'` → only `category='workspace'` perms
  land in `ws_perms[scope_id]`.

So binding `super_admin` at workspace scope (legal but unusual)
produces a workspace bucket with `{workspace:admin,
workspace:view:read, ...}` — but never `system:admin`. And binding
`workspace_member` at global scope produces nothing — the filter drops
the workspace:* perms because the binding is global.

### 2. `workspace:admin` auto-implication

After folding bindings, any workspace bucket containing
`workspace:admin` is unioned with the full catalogue of `workspace:*`
leaves. Operators bind `workspace_admin` once; the resolver does the
rest. Custom roles that bundle only `workspace:admin` get the same
treatment.

### 3. `system:org-admin` global shortcut

`has_permission(claims, perm, workspace_id=ws)` short-circuits to
`True` when both:

* `perm` is workspace-scoped (`workspace_id is not None`)
* `system:org-admin` ∈ `claims.global_perms`

This lets `org_admin` act in every workspace without per-workspace
bindings or large `ws_perms` claims.

### 4. `system:admin` system-wide shortcut

`has_permission` returns `True` unconditionally when `system:admin` ∈
`claims.global_perms`. The `super_admin` tier holds it.

## 403 body

When a check fails, the endpoint raises a structured 403:

```json
{
  "detail": {
    "error": "missing_permission",
    "permission": "workspace:datasource:read",
    "scope": {"type": "workspace", "id": "ws_finance"},
    "message": "Missing permission: workspace:datasource:read"
  }
}
```

The `message` field preserves the legacy text so existing scrapers
keep working. New consumers should read `permission` and `scope`.

The FE access-denied modal extracts the scope id to render
"Access denied in *Finance*" rather than the opaque slug.

## Operator recipes

### "I want admin in workspace X"

Bind `workspace_admin` to the user at `scope_type='workspace',
scope_id=<X>`. The user can now do every `workspace:*` action in X
and nothing in any other workspace.

### "I want X to manage every workspace but not touch users / SSO"

Bind `org_admin` at global scope. The user gets the cross-workspace
shortcut + workspace creation + group management, but not user
administration or SSO config.

### "I want X to be platform owner"

Bind `super_admin` at global scope. The user gets `system:admin`
which short-circuits every check.

### "I want a user to read everything in finance but not edit"

Bind `workspace_viewer` at `scope_type='workspace', scope_id=<finance>`.

### "I want a user to be admin in finance AND a viewer in marketing"

Two bindings:

* `workspace_admin` @ scope=`(workspace, finance)`
* `workspace_viewer` @ scope=`(workspace, marketing)`

The resolver folds them into one claim with two workspace buckets:

```json
{
  "global": [],
  "ws": {
    "finance":   ["workspace:admin", "workspace:view:*", "workspace:datasource:*"],
    "marketing": ["workspace:view:read", "workspace:datasource:read"]
  }
}
```

The TopBar role badge flips between "Workspace Admin" and "Viewer" as
the user navigates between `/workspaces/finance` and
`/workspaces/marketing`.

## Custom roles

`role_repo.create_role` accepts any name not in the built-in set, any
permission set from the catalogue, and a scope (`global` or
`workspace`). Tied-scope roles (`scope_type='workspace',
scope_id=<X>`) are only bindable in workspace X — the canonical
example is an "Alpha auditor" who can only be a viewer in workspace
Alpha.

The resolver applies the same category × scope filter to custom
roles; bundling `system:users:manage` into a workspace-scoped custom
role will silently emit nothing when bound at workspace scope. Bundle
permissions whose category matches the role's scope.

## Phase 6 hardening — global role assignment

The admin "Change role" flow had a dual-store footgun: it wrote to
`user_roles` only, leaving `role_bindings` empty. The user's display
role flipped but the resolver returned empty claims, so the freshly
promoted "super_admin" 403'd on every permission check.

Phase 6 fix: `user_repo.set_global_role(session, user_id, role_name)`
writes both tables in one transaction. The endpoint at
`PUT /admin/users/{user_id}/role` and the bootstrap admin path in
`main.py` both go through it. Backed by a regression test
(`test_change_role_writes_both_user_roles_and_role_bindings`).

The `ChangeRoleRequest` DTO now restricts `role` to the **globally
assignable** set:

* `super_admin`
* `org_admin`

Workspace-tier roles (`workspace_admin` / `workspace_member` /
`workspace_viewer`) are bound via the workspace-members endpoint,
not here — they need a workspace context, and the resolver's category
filter would drop them anyway. The AdminUsers UI dropdown enforces
the same restriction and hides `super_admin` when the caller lacks
`system:admin`.

## Phase 6 hardening — view-grants router gate

`/views/{view_id}/grants` previously enforced its "creator or
workspace admin" rule inline. A regression that deleted the inline
`_ensure_can_manage_grants()` call would silently open the endpoint;
the grep-coverage tests in `test_rbac_endpoint_coverage.py` wouldn't
catch it because they look for router-level `requires(...)`.

Phase 6 promotes the check to a router-level FastAPI dependency
`can_manage_view_grants` that:

1. Loads the view (404 on miss).
2. Allows the creator.
3. Allows a workspace admin of the view's workspace.
4. Allows `system:admin`.
5. Otherwise 403s with the structured Phase-5 body.

The dep returns the loaded view so handlers don't re-query. The
inline helper `_ensure_can_manage_grants` stays as a pure function
so the rule lives in one place.

## Phase 6 hardening — denial audit

Every `requires()` 403 emits a `user.access_denied` outbox event,
sampled hourly per `(user, permission, scope)` to avoid drowning
the audit signal under a hostile scripted scan. The sampling uses
the existing revocation backend (Redis in prod, in-memory in tests).
Emission is wrapped in try/except so the 403 is never blocked by an
outbox or Redis failure — the audit is best-effort.

Payload shape:

```json
{
  "event_type": "user.access_denied",
  "payload": {
    "user_id": "usr_alice",
    "permission": "workspace:datasource:read",
    "scope": {"type": "workspace", "id": "ws_finance"},
    "hour_bucket": 484321
  }
}
```

Operators wire this into their SIEM or log aggregator to drive
"access-denied spikes" alerts.

## Phase 7 hardening — session-kill on demote

Pre-Phase-7, an admin who fired a contractor and revoked their
workspace binding left the contractor's JWT valid for up to
`JWT_EXPIRY_MINUTES` (default 5 min). For enterprise security
postures that's too slow.

Phase 7 wires `revocation_service.revoke_all_user_sessions` into
every mutation that narrows access:

* `DELETE /admin/workspaces/{ws}/members/{binding}` — user binding
  → revoke that user's sessions; group binding → revoke every group
  member's sessions.
* `PUT /admin/users/{id}/role` — revoke target user's sessions.
* `PUT /admin/roles/{name}` — revoke every user bound to that role
  (direct + via group). Emits `rbac.role.cascade_revoked` with the
  affected user count.

Every kill is best-effort: a Redis outage logs and continues — the
JWT TTL is still the safety net.

## Phase 7 hardening — time-bound bindings

Contractor / temp access / on-call rotations need bindings that
auto-expire. The `RoleBindingORM.expires_at` column has always
existed and the resolver always honoured it; Phase 7 surfaces it
through the admin API and UI.

* `POST /admin/workspaces/{ws}/members` accepts:
  * `expiresAt` (ISO timestamp) OR
  * `expiresIn` (duration shortcut: `"24h"` / `"7d"` / `"2w"` —
    accepts `h`/`d`/`w` units, capped at 365 days).
  Setting both is a 422.
* `PUT /admin/workspaces/{ws}/members/{binding}/expiry` — extend,
  change, or clear (empty body → permanent) the expiry without
  re-creating the binding.
* `WorkspaceMembers` UI gains an "Access duration" picker
  (Permanent / 24h / 7d / 30d / 90d) on the add-member modal and a
  countdown badge on the member list.

Recipe: "Give a contractor 30-day access" → bind workspace_member
with `expiresIn: "30d"`. Audit log shows the bind + the expiry.

## Phase 7 hardening — audit log lens

Every Phase 5+ RBAC mutation already wrote to the outbox. Phase 7
gives operators + compliance a UI:

* `GET /api/v1/admin/audit` (gated `system:admin`) — filter by
  event type prefix (`rbac.role.*`), actor, target user / role,
  workspace, timestamp window. Cursor pagination (50/page default,
  500 max).
* `GET /api/v1/admin/audit/event-types` — distinct event types
  for the FE filter dropdown.
* `/admin/audit` — admin page with KPI strip by category
  (workspace bindings / role lifecycle / permissions / user
  lifecycle) and a click-to-expand JSON payload table.

Compliance recipe: "Who promoted Alice last week?" → filter
`targetUserId=alice`, `eventType=user.role_changed`,
`fromTs=<7-days-ago>`.

## Phase 7 hardening — custom-role permission picker

The resolver silently drops cross-category permissions
(`system:*` perms in a workspace-scoped role's bundle, vice versa
— see the category × scope filter). Pre-Phase-7 the create-role
modal showed all perms; operators got confused when "I bundled
system:users:manage into this workspace role" did nothing.

Phase 7: the picker filters by the role's selected scope.
Workspace roles see `workspace:*` + `resource:*` only; global
roles see `system:*` + `resource:*` only. Switching scope mid-edit
clears any silently-invalid selections.

## Phase 13 — Standard vs Custom roles + Groups in invites

The Phase-11 invite modal had two rough edges in the wild:

* **Legacy system roles got mis-classified as Custom.** The
  classifier used a hardcoded name list (`super_admin / org_admin /
  workspace_admin / workspace_member / workspace_viewer`) — but a
  dev DB where the Phase-5 migration never ran still has rows for
  `admin / user / viewer` with `is_system=true`. Those legacy rows
  fell into "Custom Roles" with the generic Sparkles icon.
* **No way to add the new user to Groups.** Workspaces were
  reachable via workspace-tier roles, but operators couldn't onboard
  a user into `Engineering` + `Data Platform` in one step.

Phase 13:

* **Classify by `isSystem`, not by name.** Any role with
  `is_system=true` lands in "Standard Roles" — the legacy ones and
  any future system additions. Operator-created roles stay in
  "Custom Roles". Smart icon/colour fallback (`getRoleVisual`) picks
  a sensible visual for any role without a curated entry:
  privileged → Shield/amber, workspace-scoped → UserCog/sky, global
  system → Globe/slate, else Sparkles/emerald.

* **Groups multi-select on invite.** Admin picks zero or more
  groups from the live catalogue; on signup, the new user is added
  to each via `group_repo.add_member`. Group memberships span every
  workspace the group is bound to.

* **Security rule:** any invite that attaches groups is
  email-bound. Group bindings can reach across workspaces in ways
  the inviter doesn't see at mint time — we won't let a forwarded
  shareable link grant that. Protected groups (IdP-managed) are
  refused at the create step.

* **Live invite summary.** Above the Generate Link button, a small
  receipt narrates the invite in plain English ("Activate a new
  account, grant Workspace Admin in Finance, add to groups
  Engineering, Data Platform. Email-bound to ada@x.com. Link
  expires in 30d.") — adapts live as the form changes.

* **No-role hero card** sits above the role catalogue as a clear
  "skip this step" affordance rather than a stray role in the list.

* **Signup banner** mentions groups: "You'll join the Engineering
  and Data Platform groups."

## Phase 11 — Invite By Link supports all roles (tiered)

Invites are no longer limited to the global admin tiers. An admin can
now mint an invite for **any** role — workspace tiers
(`workspace_member`, `workspace_viewer`, `workspace_admin`) and
custom roles — with the workspace bound on signup.

**Two link classes, by privilege:**

* **Shareable link** (no email pin, reusable until expiry) — for
  **non-privileged** roles: `workspace_member`, `workspace_viewer`,
  custom roles with no admin/manage perm, or **no role** (a plain
  activated account). "Everyone on the team use this link to join
  Finance as Viewer."
* **Email-bound link** (token pins a target email, reusable until
  expiry but only that address can accept) — **required** for
  **privileged** roles: `super_admin`, `org_admin`,
  `workspace_admin`, and any custom role carrying `workspace:admin`
  or a `system:*` perm. A forwarded link can't escalate an
  unintended identity. (This tightens Phase 6 — admin invites now
  need a target email.)

**Privileged** = the role's permission bundle includes
`workspace:admin` or any `system:*`. Computed from
`role_permissions`, so custom roles classify automatically.

**Token** (`create_invite_token`) carries optional `workspace_id`
and `email`. **Signup** (`auth.py`) honours every role: global tiers
via `set_global_role`; everything else via a `role_binding` at the
right scope, re-validated for bindability at signup time. Email-bound
invites reject a mismatched signup email.

### The access model invites respect

> **A user has no access to any workspace unless explicitly granted
> a binding in that workspace.** Invites don't change this.

* A **plain invite** (no role) → activated account, zero bindings →
  no workspace access at all.
* A **non-privileged global** custom role → shareable, gets a
  global binding, but the resolver's category × scope filter drops
  any workspace perms bundled in it → still no workspace access.
* Only an explicit **workspace binding** (`workspace_member` /
  `viewer` / `admin` / custom workspace role) grants access to that
  one workspace.
* Only `super_admin` (`system:admin`) and `org_admin`
  (`system:org-admin`) cross workspaces — via the resolver
  short-circuits, not via per-workspace bindings.

Regression coverage:
`test_invite_roles.py::test_plain_invite_user_has_no_workspace_access`
and `::test_custom_global_role_grants_no_workspace_access` prove it.

## Phase 10 — promoted admin sees admin UI without re-login

Pre-Phase-10 a real bug: an admin promoted to `super_admin` while
logged in had to manually log out and log back in before the admin
UI worked. Two compounding root causes:

1. **Revocation only fired on `requires(...)` routes.**
   `get_current_user` — the base auth dep used by every other
   protected endpoint, including those gated by `require_admin` —
   never consulted the revoked-sid set. So a stale JWT survived
   indefinitely on `require_admin` routes (`auth/dependencies.py`
   carried an explicit "does NOT consult revocation" docstring).

2. **`require_admin` had a legacy DTO-role fallback.** The
   `user.role` field on the User DTO is re-read from `user_roles`
   on every `validate_session`, so post-promotion it correctly
   showed `super_admin`. `require_admin` accepted the DTO role
   AND let the user in even when the JWT's `system:admin` claim
   was missing — but every endpoint gated by `requires(...)` then
   403'd because the claim wasn't there. The user saw a half-
   functional admin page.

**Phase 10 fix:**

* Revocation moves into `get_current_user`. Every authenticated
  request now consults the set. A revoked session → 401 → silent
  refresh → fresh JWT with re-resolved claims → request retried
  → admin works. Fail-open on Redis outage (an incident must
  not lock every authenticated user out); `requires(...)` keeps
  its fail-closed probe for sensitive permissions.
* `require_admin` is simplified to require the `system:admin`
  claim. The legacy DTO-role path is gone — Phase 6's
  `set_global_role` made the two stores agree by construction,
  so any state where DTO says admin but claim doesn't is a
  stale-JWT state that should silent-refresh, not be accepted.
* `requires(...)` drops its duplicate revocation block (now done
  upstream in `get_current_user`); keeps the fail-closed probe
  for sensitive permissions like `system:admin` /
  `workspace:admin`.
* Frontend `tryRefresh` calls `useAuthStore.refreshPermissions()`
  after a successful silent refresh. The route guards
  (`RequirePermission`) and TopBar admin cog react to the new
  claims without an explicit page reload.

End-to-end: admin promotes user U mid-session. U's next request
401's (revoked sid), silent-refresh runs, new JWT minted with
`system:admin`, FE permissions re-hydrate, admin nav appears,
admin functions work. No manual re-login.

## Phase 9 — audit log first-class on a quiet system

The Phase-8 default filter hid login/logout as "noise", which made
the audit page look blank on fresh systems. Phase 9 also found
several events that **weren't being emitted at all** — failed
logins, session revocations, workspace lifecycle.

**New events emitted:**

| Event | Severity | Fired by |
|-------|----------|----------|
| `user.login_failed` | warning | both raise paths in `auth_service.service.login` (best-effort, rollback-safe via `_emit_audit`) |
| `user.session_revoked` | critical | `revoke_subject_sessions` / `revoke_role_sessions` — one per affected user, carries `reason` (workspace_binding_revoked / role_changed / role_permissions_updated) |
| `rbac.workspace.created` | info | `POST /admin/workspaces` |
| `rbac.workspace.updated` | info | `PUT /admin/workspaces/{id}` |
| `rbac.workspace.deleted` | critical | `DELETE /admin/workspaces/{id}` (fires before the cascade event so the timeline reads in order) |

**Three-mode scope filter** (replacing the two-mode Phase-8 toggle):

| Mode | Surfaces | Hides |
|------|----------|-------|
| **Security** (default) | logins, logouts, failed logins, session revocations, every RBAC mutation, SSO config changes | password chrome, signup chrome, access-denied noise |
| **Activity** | the above PLUS signup / password / access-request chrome | per-request access-denied spam only |
| **Everything** | the unfiltered firehose | nothing |

`user.logged_in` / `user.logged_out` moved off the noise list —
they're first-class security signal now.

**Operator recipes:**

* "Who tried to brute-force Alice's account?" — set scope to
  Security, filter `eventType=user.login_failed`. The email + reason
  appear in the summary.
* "Did Bob's revoked binding kill his session?" — Security mode,
  filter `targetUserId=bob`. Two rows appear:
  `rbac.workspace.member_revoked` and `user.session_revoked`
  with `reason=workspace_binding_revoked`.
* "Why is the new workspace missing?" — Security mode, filter
  `eventType=rbac.workspace.*`. Created / updated / deleted events
  show with actor + workspace name.

## Phase 8 hardening — audit-log usability

The Phase-7 audit endpoint worked but the page was operationally
useless: 30+ `user.logged_in` rows dominated the view, every cell
showed opaque slugs, the layout escaped the admin sidebar, and the
`/admin/users/search` typeahead crashed (500 on real query, 422 on
empty). Phase 8 closes those gaps.

* **Default filter is now `category=security`** — operationally noisy
  events (`user.logged_in`, `user.access_denied`,
  `user.created`, `user.password_reset_*`,
  `user.reset_token_generated`, `user.invite_created`,
  `rbac.access_request.created`) are excluded. Toggle to
  `category=all` for the full firehose when debugging.

* **Severity + human summary** — every audit row now carries
  `severity` (`info` / `warning` / `critical`) and `summary` (a
  one-line sentence) computed from the `event_type` catalogue. The
  FE renders a coloured dot + the sentence; the raw `event_type`
  stays visible underneath as a small monospace caption. Unknown
  events fall back to `info` + the raw type so a new backend event
  still renders without a catalogue entry.

* **Time range chips** — `Last 24h / 7d / 30d / All time`. Defaults
  to 7d (wide enough for incident review, narrow enough to scan).

* **Layout fix** — `AdminAudit.tsx` swapped its
  `absolute inset-0` wrapper for the standard
  `max-w-6xl mx-auto p-8` pattern so it sits inside the admin
  sidebar layout like every other admin page.

* **Clickable entities** — `actorId` / `targetUserId` /
  `workspaceId` cells are now hyperlinks (`/admin/users#<id>` and
  `/workspaces/<id>`) so an operator can drill from "who did this?"
  to the affected user / workspace in one click.

* **SSO search fixes** — `/admin/users/search` accepts empty `q`
  (returns `[]` instead of 422) and runs the four underlying scans
  sequentially (a single AsyncSession can't service concurrent
  `execute(...)` calls; the `asyncio.gather` crashed the SSO admin
  page).

## Phase 7 hardening — workspace deletion cascade

Deleting a workspace used to leave behind:

* `RoleBindingORM` rows pointing at the dead workspace (covered
  by `delete_scope_bindings`).
* Custom `RoleORM` rows scoped to the dead workspace, which
  couldn't be bound anywhere else. Phase 7 cascades these too via
  `role_repo.delete_workspace_scoped_roles`.

A `rbac.workspace.roles_cascaded` outbox event lists the removed
bindings + roles so the audit log shows the cascade.

## Migration map (Phase 5)

Renames:

| Old              | New                                              |
|------------------|--------------------------------------------------|
| `admin` (global) | `super_admin`                                    |
| `admin` (ws)     | `workspace_admin`                                |
| `user`           | `workspace_member`                               |
| `viewer`         | `workspace_viewer`                               |
| `users:manage`   | `system:users:manage`                            |
| `groups:manage`  | `system:groups:manage`                           |
| `workspaces:create` | `system:workspaces:create`                    |

Net adds:

* Role `org_admin` (global)
* Permission `system:org-admin` (category=system)

Net drops:

* Legacy `(role='user', scope='global')` rows from Phase 1's backfill
  are deleted with a WARNING log per row (those rows were always
  malformed — `user` is a workspace-scoped role).

The migration is reversible: `downgrade()` renames everything back and
drops the new permission + role, but the dropped legacy `user@global`
bindings stay gone (best-effort restore).

## Where to look in the code

| Concern                                | File                                                          |
|----------------------------------------|---------------------------------------------------------------|
| Resolver (DB → claims)                 | `backend/app/services/permission_service.py:resolve`          |
| Claim-time checks                      | `backend/app/services/permission_service.py:has_permission`   |
| FastAPI `requires(...)` factory         | `backend/app/auth/dependencies.py`                            |
| Role bindability                       | `backend/app/db/repositories/role_repo.py`                    |
| Permission catalogue / categories      | `backend/app/db/repositories/permission_repo.py`              |
| Frontend `checkPermission`             | `frontend/src/store/auth.ts`                                  |
| Workspace-aware role badge             | `frontend/src/components/layout/TopBar.tsx`                   |
| Migration                              | `backend/alembic/versions/20260603_1100_rbac_uplift.py`       |
| Regression tests                       | `backend/tests/test_rbac_phase5.py`                           |

## Related docs

* [SSO_INTEGRATION.md](./SSO_INTEGRATION.md) — IdP → role-binding
  reconciliation pulls roles from this taxonomy. The Phase-5 rename
  is reflected in section §11.5.
* [SSO.md](./SSO.md) — operator-facing SSO posture; cross-references
  the role names here.
