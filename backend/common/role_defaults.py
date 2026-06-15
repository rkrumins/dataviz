"""Canonical default permission bundles for the built-in system roles.

This module is the **single source of truth** for what each seeded role
*should* contain. It mirrors the ``branding`` pattern (defaults in code,
overrides in the DB): the migration chain seeds these bundles once, the
``role_permissions`` table is the runtime source of truth thereafter, and
an admin can edit a system role's bundle live. Two operations read these
defaults back:

  * **Reset to default** — re-apply ``SYSTEM_ROLE_DEFAULTS[name]`` to a
    system role, discarding any admin customisation.
  * **"Modified?" detection** — diff a system role's live bundle against
    its default so the UI can flag customised built-ins and enable reset.

Because the values are seeded by migrations but consumed here, the two
must not drift. ``tests/test_system_role_editing.py`` pins this with a
parity check (Postgres-gated) that runs the real migration chain against a
scratch DB and asserts the seeded ``role_permissions`` equal these bundles.

The bundles below were captured from a fully-migrated database (head:
``role_expansion``). ``super_admin``'s ``system:admin`` short-circuits
the resolver, so its explicit grants exist only to render the role matrix
honestly — keep them in lock-step with the resolver's expectations.
"""
from __future__ import annotations

from dataclasses import dataclass

from backend.common.roles import RoleName


@dataclass(frozen=True)
class SystemRoleDefault:
    """The seeded baseline for one built-in role."""

    description: str
    scope_type: str  # always "global" today — templates bind into any scope
    permissions: frozenset[str]


# Seeded baseline for every role with ``is_system=true``. Note there is no
# ``user`` entry: that name is the *implicit* default platform tier
# (``RoleName.USER``) and has no row in the ``roles`` table — the uplift
# migration removed it. Keys are the canonical ``RoleName`` literals.
SYSTEM_ROLE_DEFAULTS: dict[str, SystemRoleDefault] = {
    RoleName.SUPER_ADMIN.value: SystemRoleDefault(
        description=(
            "Platform owner. Carries system:admin; implies every "
            "permission, every scope."
        ),
        scope_type="global",
        permissions=frozenset({
            "system:admin",
            "system:audit:read",
            "system:bindings:read",
            "system:groups:manage",
            "system:org-admin",
            "system:org-viewer",
            "system:users:manage",
            "system:workspaces:create",
            "workspace:admin",
            "workspace:catalog:manage",
            "workspace:catalog:read",
            "workspace:datasource:manage",
            "workspace:datasource:read",
            "workspace:ontology:manage",
            "workspace:ontology:read",
            "workspace:provider:read",
            "workspace:view:create",
            "workspace:view:delete",
            "workspace:view:edit",
            "workspace:view:read",
        }),
    ),
    RoleName.ORG_ADMIN.value: SystemRoleDefault(
        description=(
            "Cross-workspace operator — manage every workspace + create "
            "new ones, but no user/SSO admin."
        ),
        scope_type="global",
        permissions=frozenset({
            "system:groups:manage",
            "system:org-admin",
            "system:workspaces:create",
            "workspace:admin",
            "workspace:catalog:manage",
            "workspace:catalog:read",
            "workspace:datasource:manage",
            "workspace:datasource:read",
            "workspace:ontology:manage",
            "workspace:ontology:read",
            "workspace:provider:read",
            "workspace:view:create",
            "workspace:view:delete",
            "workspace:view:edit",
            "workspace:view:read",
        }),
    ),
    RoleName.ORG_AUDITOR.value: SystemRoleDefault(
        description=(
            "Read-only operator across the whole tenancy. Sees every "
            "workspace + every binding + the audit log; cannot mutate."
        ),
        scope_type="global",
        permissions=frozenset({
            "system:audit:read",
            "system:bindings:read",
            "system:org-viewer",
        }),
    ),
    RoleName.WORKSPACE_ADMIN.value: SystemRoleDefault(
        description=(
            "Workspace administrator — settings, members, deletion, and "
            "every workspace permission (via auto-implication)."
        ),
        scope_type="global",
        permissions=frozenset({
            "workspace:admin",
        }),
    ),
    RoleName.WORKSPACE_DATA_ENGINEER.value: SystemRoleDefault(
        description=(
            "Owns data products inside a workspace (datasources, ontology, "
            "catalog, views) without managing members or workspace settings."
        ),
        scope_type="global",
        permissions=frozenset({
            "workspace:catalog:manage",
            "workspace:catalog:read",
            "workspace:datasource:manage",
            "workspace:datasource:read",
            "workspace:ontology:manage",
            "workspace:ontology:read",
            "workspace:provider:read",
            "workspace:view:create",
            "workspace:view:delete",
            "workspace:view:edit",
            "workspace:view:read",
        }),
    ),
    RoleName.WORKSPACE_MEMBER.value: SystemRoleDefault(
        description="Standard workspace member — manage views and data sources.",
        scope_type="global",
        permissions=frozenset({
            "workspace:catalog:read",
            "workspace:datasource:manage",
            "workspace:datasource:read",
            "workspace:ontology:read",
            "workspace:provider:read",
            "workspace:view:create",
            "workspace:view:delete",
            "workspace:view:edit",
            "workspace:view:read",
        }),
    ),
    RoleName.WORKSPACE_VIEWER.value: SystemRoleDefault(
        description=(
            "Read-only access to the bound workspace's views + data sources."
        ),
        scope_type="global",
        permissions=frozenset({
            "workspace:catalog:read",
            "workspace:datasource:read",
            "workspace:ontology:read",
            "workspace:provider:read",
            "workspace:view:read",
        }),
    ),
}


# The permission floor that an admin can never strip from a system role —
# enforced in the repo (``update_role``) and surfaced to the UI so the
# checkboxes render locked-on. ``super_admin`` must always retain the two
# permissions that gate the Permissions admin surface itself, otherwise an
# edit could lock every operator out of RBAC administration with no UI path
# back (``system:admin`` gates the mutating endpoints; ``system:bindings:read``
# gates the read/list endpoints that render the page).
PROTECTED_PERMISSIONS: dict[str, frozenset[str]] = {
    RoleName.SUPER_ADMIN.value: frozenset({
        "system:admin",
        "system:bindings:read",
    }),
}


def default_permissions(role_name: str) -> frozenset[str]:
    """Default permission set for a system role, or empty for unknown /
    custom roles."""
    spec = SYSTEM_ROLE_DEFAULTS.get(role_name)
    return spec.permissions if spec else frozenset()


def locked_permissions(role_name: str) -> frozenset[str]:
    """Permissions that must always remain granted to ``role_name``."""
    return PROTECTED_PERMISSIONS.get(role_name, frozenset())
