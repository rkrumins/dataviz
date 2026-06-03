# RBAC

> Phase 5 role taxonomy, permission catalogue, and operator recipes.
> Last updated: 2026-06-03 (migration `20260603_1100_rbac_uplift`).

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
