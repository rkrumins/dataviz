"""Canonical role-name constants — the backend's single source of truth
for every built-in role identifier.

Mirrors ``frontend/src/lib/roleNames.ts``. The two files must stay in
lock-step: migrations seed these literals into the ``roles`` table,
and code on both sides of the wire references them by name.

Prior to this module the strings were hardcoded in
``user_repo.GLOBAL_ASSIGNABLE_ROLES``, ``auth.py: _INVITE_GLOBAL_TIER``,
``idp_group_mapping_repo.FORBIDDEN_AUTO_ROLES``, and various inline
checks. A rename therefore meant a wide silent-bug-prone sweep; now
every caller imports from here.
"""
from __future__ import annotations

from enum import Enum


class RoleName(str, Enum):
    """Built-in role identifiers seeded by alembic migrations.

    ``str`` mixin so existing string comparisons keep working —
    ``RoleName.SUPER_ADMIN == "super_admin"`` is True. Use
    ``RoleName.<X>.value`` only when you need the bare string.
    """

    # ── Global platform tiers ──────────────────────────────────────
    SUPER_ADMIN = "super_admin"
    ORG_ADMIN = "org_admin"
    ORG_AUDITOR = "org_auditor"
    #: Default tier for any user without an explicit global role.
    USER = "user"

    # ── Workspace-scoped role templates ────────────────────────────
    WORKSPACE_ADMIN = "workspace_admin"
    WORKSPACE_DATA_ENGINEER = "workspace_data_engineer"
    WORKSPACE_MEMBER = "workspace_member"
    WORKSPACE_VIEWER = "workspace_viewer"


# Frozenset (not enum) because the most frequent operation is a
# membership test in hot paths (``role in GLOBAL_ASSIGNABLE_ROLES``).
GLOBAL_ASSIGNABLE_ROLES: frozenset[str] = frozenset({
    RoleName.USER.value,
    RoleName.ORG_AUDITOR.value,
    RoleName.ORG_ADMIN.value,
    RoleName.SUPER_ADMIN.value,
})
"""Roles assignable via ``PUT /admin/users/{id}/role``. Mirrors
``frontend/src/lib/roleNames.ts: GLOBAL_ASSIGNABLE_ROLES``."""


INVITE_GLOBAL_TIER: frozenset[str] = frozenset({
    RoleName.SUPER_ADMIN.value,
    RoleName.ORG_ADMIN.value,
})
"""Roles granted as a global binding (vs. workspace-scoped) by the
invite-token signup flow."""


PLATFORM_ADMIN_ROLES: frozenset[str] = frozenset({
    RoleName.SUPER_ADMIN.value,
    RoleName.ORG_ADMIN.value,
})
"""Platform admin tiers — used for the "Admin" badge / KPI counters
on the FE; mirrored in ``roleNames.ts``."""


WORKSPACE_TEMPLATE_ROLES: frozenset[str] = frozenset({
    RoleName.WORKSPACE_ADMIN.value,
    RoleName.WORKSPACE_DATA_ENGINEER.value,
    RoleName.WORKSPACE_MEMBER.value,
    RoleName.WORKSPACE_VIEWER.value,
})
"""Workspace role templates — assignable on the workspace-member
binding form."""


FORBIDDEN_AUTO_GRANT_ROLES: frozenset[str] = frozenset({
    RoleName.SUPER_ADMIN.value,
})
"""Roles that may never be granted via SSO group mapping or other
auto-grant flows. Backend guard in ``idp_group_mapping_repo``."""


#: Default platform tier — the implicit role for any user without an
#: explicit global ``role_binding``. Replaces ``user_repo.DEFAULT_PLATFORM_TIER``.
DEFAULT_PLATFORM_TIER: str = RoleName.USER.value
