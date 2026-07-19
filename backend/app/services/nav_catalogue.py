"""Centralised navigation visibility catalogue (RBAC Phase 16).

The single source of truth for **which permission unlocks which UI
section**. Mirrors the backend ``requires(...)`` gates on the matching
endpoints and is served to the frontend via ``GET /me/nav`` so the FE
no longer hardcodes (and can no longer drift from) these mappings.

Design notes:
  * A *section* is unlocked by reusing the existing functional
    permission its features need — there are no dedicated ``nav:*``
    permissions. Granting ``system:groups:manage`` to any role
    therefore makes that role see Admin › Groups automatically.
  * The catalogue is static (changes only on deploy); it is NOT
    personalised. The frontend evaluates each spec against the
    caller's own permission claims client-side, exactly as it did
    when these specs lived in ``frontend/src/lib/navPermissions.ts``.
  * Backend enforcement stays in ``requires(...)`` on each endpoint.
    ``backend/tests/test_nav_catalogue.py`` asserts every entry here
    matches the live route gate, so the two can't silently diverge.

Spec kinds (mirrors the FE ``NavPermissionSpec`` union):
  * ``always``       — every authenticated user.
  * ``perm``         — single global permission required.
  * ``anyPerm``      — any of N permissions satisfies (global checks,
    plus workspace-scoped perms matched in ANY workspace bucket).
  * ``workspaceAny`` — perm held in ANY workspace bucket.
"""
from __future__ import annotations

from typing import Union

from backend.common.models.rbac import (
    NavCatalogueResponse,
    NavSection,
    NavSpecAlways,
    NavSpecAnyPerm,
    NavSpecPerm,
    NavSpecWorkspaceAny,
)

NavSpec = Union[NavSpecAlways, NavSpecPerm, NavSpecAnyPerm, NavSpecWorkspaceAny]


# Top-level left-rail sidebar. Keyed by ``NavigationTab`` (matches the
# FE ``NAV_ITEMS_CONFIG`` ids and the route paths in ``routes.tsx``).
#
# ``ingestion`` and ``schema`` list the global shortcuts
# (``system:admin``, ``system:org-admin``) PLUS the underlying
# workspace-scoped perm so the section shows for a member who holds it
# in any one workspace.
_SIDEBAR: dict[str, tuple[str, NavSpec]] = {
    "dashboard":  ("Dashboard",     NavSpecAlways()),
    "explore":    ("Explore",       NavSpecAlways()),
    "workspaces": ("Workspaces",    NavSpecAlways()),
    # Phase 18: Ingestion and Semantic Layers open to any workspace-bound
    # user holding the matching workspace:*:read perm. Their pages render
    # filtered results (workspace-scoped); edit affordances are gated
    # separately by the manage perm at the component level.
    "ingestion":  ("Ingestion",     NavSpecAnyPerm(perms=["system:admin", "system:org-admin", "workspace:provider:read", "workspace:datasource:manage"])),
    "schema":     ("Semantic Layers", NavSpecAnyPerm(perms=["system:admin", "system:org-admin", "workspace:ontology:read"])),
    "admin":      ("Administration", NavSpecAnyPerm(perms=["system:admin", "system:groups:manage"])),
}

# Admin sub-nav. Keyed by the route segment (matches
# ``AdminPage.adminGroups[].items[].path`` + the ``/admin`` route
# children). Most entries require ``system:admin``; the exceptions mirror
# the delegated permission their backend surface actually enforces so a
# non-super-admin who holds that perm can reach the page:
#   ``groups`` — ``system:groups:manage`` (delegated groups admin)
#   ``audit``  — ``system:audit:read``   (the ``org_auditor`` role)
_ADMIN_SECTIONS: dict[str, tuple[str, NavSpec]] = {
    "overview":      ("Global Overview", NavSpecPerm(perm="system:admin")),
    "infrastructure": ("Infrastructure", NavSpecPerm(perm="system:admin")),
    "redis":         ("Redis & Graph Store", NavSpecPerm(perm="system:admin")),
    "branding":      ("Branding",        NavSpecPerm(perm="system:admin")),
    "features":      ("Features",        NavSpecPerm(perm="system:admin")),
    "announcements": ("Announcements",   NavSpecPerm(perm="system:admin")),
    "users":         ("User Management", NavSpecPerm(perm="system:admin")),
    "groups":        ("Groups",          NavSpecPerm(perm="system:groups:manage")),
    "permissions":   ("Permissions",     NavSpecPerm(perm="system:admin")),
    "sso":           ("SSO",             NavSpecPerm(perm="system:admin")),
    "audit":         ("Audit Log",       NavSpecPerm(perm="system:audit:read")),
}


def _to_sections(raw: dict[str, tuple[str, NavSpec]]) -> dict[str, NavSection]:
    return {
        key: NavSection(key=key, label=label, spec=spec)
        for key, (label, spec) in raw.items()
    }


def get_catalogue() -> NavCatalogueResponse:
    """Return the full nav catalogue (sidebar + admin sub-sections)."""
    return NavCatalogueResponse(
        sidebar=_to_sections(_SIDEBAR),
        admin_sections=_to_sections(_ADMIN_SECTIONS),
    )
