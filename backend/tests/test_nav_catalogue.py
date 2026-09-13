"""Drift guard for the nav-visibility catalogue (RBAC Phase 16).

``backend/app/services/nav_catalogue.py`` is the single source of
truth for which permission unlocks which UI section, served to the
frontend via ``GET /me/nav``. Backend *enforcement* stays in the
``requires(...)`` gates on each endpoint. These tests assert the two
agree, so a catalogue entry can never silently diverge from the gate
that actually enforces it.

How it works: walk the live FastAPI route graph, read the
``required_permission`` tag that ``requires(...)`` attaches to its
dependency (Phase 16), treat ``require_admin`` as ``system:admin``,
and for each catalogue section assert its permission is genuinely
enforced on that section's backend surface.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException, status
from fastapi.routing import APIRoute
from httpx import AsyncClient

from backend.app.auth.dependencies import (
    get_current_user,
    get_permission_claims,
    require_admin,
)
from backend.app.main import app
from backend.app.services.nav_catalogue import get_catalogue
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User


# ── Route introspection ─────────────────────────────────────────────

def _dependant_gate_perms(dependant) -> set[str]:
    """Permissions enforced on a route's dependant, via ``requires(...)`` tags
    and the ``require_admin`` ⇒ ``system:admin`` equivalence."""
    perms: set[str] = set()
    stack = [dependant]
    while stack:
        dep = stack.pop()
        call = getattr(dep, "call", None)
        tagged = getattr(call, "required_permission", None)
        if tagged:
            perms.add(tagged)
        if call is require_admin:
            perms.add("system:admin")
        stack.extend(dep.dependencies)
    return perms


def _iter_route_gates():
    """Yield ``(full_path, dependant)`` for every mounted APIRoute.

    WORKS ON BOTH ROUTER SHAPES, because FastAPI has had both and this test
    reaches into internals to see the gates at all.

    Some versions include routers lazily: children do not flatten into
    ``app.routes`` but sit under ``_IncludedRouter`` wrappers, and their
    absolute paths and merged dependants are only materialised through
    ``effective_candidates()`` / ``effective_low_priority_routes()``. Others —
    0.136.1, the pinned one — flatten every child back into ``app.routes`` as
    a plain ``APIRoute`` carrying its absolute path, with any
    router-``include``-level ``dependencies=[Depends(requires(...))]`` already
    folded into ``route.dependant``.

    The wrapper is looked up with ``getattr`` rather than named directly:
    referring to a private symbol that a supported version does not define
    turned both callers into an ``AttributeError`` at import of the walk, which
    is a test failing for a reason that has nothing to do with what it checks."""
    import fastapi.routing as _fr

    # Absent on versions that flatten (0.136.1 and friends). `None` makes the
    # isinstance check below simply never match, and the flattened branch
    # handles everything.
    _IncludedRouter = getattr(_fr, "_IncludedRouter", None)

    def _emit(ctx):
        original = getattr(ctx, "original_route", None)
        if isinstance(original, APIRoute):
            path = getattr(ctx, "path", "") or ""
            dependant = getattr(ctx, "dependant", None) or original.dependant
            yield path, dependant

    def _walk(routes):
        for route in routes:
            if _IncludedRouter is not None and isinstance(route, _IncludedRouter):
                for cand in route.effective_candidates():
                    if isinstance(cand, _IncludedRouter):
                        yield from _walk([cand])
                    else:
                        yield from _emit(cand)
                for cand in route.effective_low_priority_routes():
                    yield from _emit(cand)
            elif isinstance(route, APIRoute):
                yield route.path, route.dependant

    yield from _walk(app.routes)


def _perms_under(prefixes: tuple[str, ...]) -> set[str]:
    """Union of every gate permission enforced on any route whose path
    contains one of ``prefixes``."""
    found: set[str] = set()
    for path, dependant in _iter_route_gates():
        if any(p in path for p in prefixes):
            found |= _dependant_gate_perms(dependant)
    return found


# A representative backend route surface per admin section. The
# section's catalogue permission must be enforced on at least one route
# under these prefixes.
_ADMIN_SECTION_ANCHORS: dict[str, tuple[str, ...]] = {
    "overview":      ("/admin/stats-polling",),
    "redis":         ("/admin/redis",),
    "infrastructure": ("/admin/system/status",),
    "branding":      ("/admin/branding",),
    "features":      ("/admin/features",),
    "telemetry":     ("/admin/telemetry",),
    "announcements": ("/admin/announcements",),
    "users":         ("/admin/users",),
    "groups":        ("/admin/groups",),
    "permissions":   ("/admin/roles", "/admin/permissions"),
    "sso":           ("/admin/idp-providers", "/admin/idp-group-mappings", "/admin/sso-config"),
    "audit":         ("/admin/audit",),
}

# The sidebar entries are ``anyPerm`` unions of two universal global
# shortcuts (system:admin / system:org-admin, present on every gate as
# implications) PLUS the real workspace-scoped permission that gates
# the section's surface. We assert that workspace-scoped leg is enforced
# somewhere — that's the entry's substantive gate.
#
# Phase 18: Ingestion + Semantic Layers now lean on the new
# read-tier perms (workspace:provider:read / workspace:ontology:read).
_SIDEBAR_WORKSPACE_LEG: dict[str, str] = {
    "ingestion": "workspace:provider:read",
    "schema":    "workspace:ontology:read",
}


# ── Drift assertions ────────────────────────────────────────────────

def test_admin_sections_match_backend_gates():
    catalogue = get_catalogue()
    for key, section in catalogue.admin_sections.items():
        spec = section.spec
        assert spec.kind == "perm", f"{key}: expected a single-perm spec"
        anchors = _ADMIN_SECTION_ANCHORS[key]
        enforced = _perms_under(anchors)
        assert spec.perm in enforced, (
            f"Catalogue says /admin/{key} needs {spec.perm!r}, but no route "
            f"under {anchors} enforces it. Enforced perms there: "
            f"{sorted(enforced)}. Update the catalogue or the route gate."
        )


def test_sidebar_workspace_legs_are_enforced():
    catalogue = get_catalogue()
    for key, expected_perm in _SIDEBAR_WORKSPACE_LEG.items():
        section = catalogue.sidebar[key]
        assert section.spec.kind == "anyPerm"
        assert expected_perm in section.spec.perms, (
            f"Sidebar {key!r} catalogue entry lost its workspace leg "
            f"{expected_perm!r}: {section.spec.perms}"
        )
        # The leg must be a real, enforced permission somewhere in the app.
        all_perms = _perms_under(("/",))
        assert expected_perm in all_perms, (
            f"Sidebar {key!r} references {expected_perm!r} but no route "
            f"enforces it — dead gate."
        )


def test_catalogue_covers_admin_route_segments():
    """Every admin section the catalogue gates has a backend anchor, and
    vice-versa — catches a section added to one side but not the other."""
    catalogue = get_catalogue()
    assert set(catalogue.admin_sections) == set(_ADMIN_SECTION_ANCHORS), (
        "Admin sections in the catalogue and the test anchor map diverged. "
        "Add the new section to both."
    )


# ── Endpoint contract ───────────────────────────────────────────────

@pytest.mark.asyncio
async def test_me_nav_returns_catalogue(test_client: AsyncClient):
    user = User(
        id="usr_navtest",
        email="nav@example.com",
        first_name="Nav",
        last_name="Test",
        role="user",
        status="active",
        created_at="2024-01-01T00:00:00Z",
        updated_at="2024-01-01T00:00:00Z",
    )

    async def _ovr_user():
        return user

    def _ovr_claims():
        return PermissionClaims(sid="sess_nav")

    app.dependency_overrides[get_current_user] = _ovr_user
    app.dependency_overrides[get_permission_claims] = _ovr_claims
    try:
        r = await test_client.get("/api/v1/me/nav")
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(get_permission_claims, None)

    assert r.status_code == 200, r.text
    body = r.json()
    assert "sidebar" in body and "adminSections" in body
    # Spot-check the round-trip of each spec kind.
    assert body["sidebar"]["dashboard"]["spec"]["kind"] == "always"
    assert body["adminSections"]["groups"]["spec"] == {
        "kind": "perm",
        "perm": "system:groups:manage",
    }
    assert body["sidebar"]["ingestion"]["spec"]["kind"] == "anyPerm"
    assert "workspace:datasource:manage" in body["sidebar"]["ingestion"]["spec"]["perms"]


@pytest.mark.asyncio
async def test_me_nav_requires_auth(test_client: AsyncClient):
    async def _ovr_user():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated"
        )

    app.dependency_overrides[get_current_user] = _ovr_user
    try:
        r = await test_client.get("/api/v1/me/nav")
    finally:
        app.dependency_overrides.pop(get_current_user, None)
    assert r.status_code == 401


def test_the_route_walk_actually_finds_gates():
    """The walker must never yield nothing, or this whole file goes vacuous.

    Every other test here asks "what permissions guard the routes under
    ``/admin/x``" and asserts something about the answer. A walk that returns
    an empty set makes each of those a comparison against nothing, and the file
    passes while checking that no gate anywhere is what the catalogue says it
    is.

    It has already failed for a reason of exactly that kind: the walk named
    ``fastapi.routing._IncludedRouter`` directly, and on the pinned FastAPI —
    which flattens routers instead of wrapping them — that attribute does not
    exist, so two tests died with an ``AttributeError`` about routing internals
    rather than anything to do with navigation.
    """
    gates = list(_iter_route_gates())
    assert len(gates) > 100, (
        f"only {len(gates)} routes walked — the app mounts hundreds, so the "
        f"walk is not seeing the router shape this FastAPI uses"
    )
    assert all(isinstance(path, str) and path.startswith("/") for path, _ in gates), (
        "paths must be absolute, or `_perms_under` matches the wrong routes"
    )
    # A gate this test suite reasons about elsewhere, resolved end to end.
    assert "system:audit:read" in _perms_under(("/admin/audit",))
