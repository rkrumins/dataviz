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
    # The PRIVILEGED audiences. `system:analytics:read` is the dedicated one and
    # leads for that reason; the other three are the implications kept for
    # deployments whose roles were customised before it existed — auditors
    # (system:audit:read) and cross-workspace operators (system:org-admin) do
    # not imply each other, and system:admin implies both.
    #
    # Every one of these must appear here, because this list is what the client
    # reads as "privileged" (`useAnalyticsAccess`). Omitting the dedicated
    # permission did not merely hide the nav item: the route guard refused a
    # holder of it outright, with a panel explaining that the section was not
    # open on this deployment — which was false, and the server would have
    # served them the full document.
    #
    # This spec is not the whole story any more. `analyticsPublicEnabled` opens
    # a redacted version of the section to everyone else, and a feature flag is
    # not a permission — the catalogue has no way to say "or the flag is on".
    # So the flag is OR-ed in at the two places that consume this: the sidebar
    # item and the route guard, both through `useAnalyticsAccess`. What stays
    # true here is that holding any of these three ALWAYS grants access,
    # whatever the flag says.
    "analytics":  ("Analytics",     NavSpecAnyPerm(perms=["system:analytics:read", "system:admin", "system:org-admin", "system:audit:read"])),
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
    "telemetry":     ("Telemetry",       NavSpecPerm(perm="system:audit:read")),
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
