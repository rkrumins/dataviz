"""What views do when the workspace grants cannot be read at all.

Per-workspace grants no longer ride in the access token — they are
unbounded in tenant size and a cookie over 4096 bytes is discarded by the
browser silently — so they live in the session store, read back on each
request via Redis, then Postgres. When neither answers, ``PermissionClaims``
carries an empty ``ws_perms`` with ``ws_available=False``: the map is not
an answer about the user, it is the absence of one.

Every tier below ``public`` is decided against that map, so reading it as
"the user holds nothing" turns an outage into a wrong answer — and, on the
list routes, a *quiet* one. The predicate would still run, the query would
still succeed, and the caller would get 200 OK with rows missing. Nothing
in the response would say so.

These tests pin the alternative: refuse to answer. They also pin the
inverse, which is the part that keeps the guard honest — a caller whose
access is decided by the token alone must be unaffected, or the first
Redis blip takes the whole product down.
"""
from __future__ import annotations

import contextlib

import pytest
from httpx import AsyncClient

from backend.app.auth.dependencies import (
    get_current_user,
    get_optional_user,
    get_permission_claims,
)
from backend.app.db.models import (
    ContextModelORM,
    ViewORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.services import view_access
from backend.app.services.permission_service import PermissionClaims

WS = "ws_finance"
TEMPLATES = "/api/v1/{ws}/context-models/templates"


@contextlib.contextmanager
def _as(user_id: str, claims: PermissionClaims):
    from backend.app.main import app

    user = type("U", (), {"id": user_id, "email": f"{user_id}@example.com"})()

    async def _user():
        return user

    def _claims():
        return claims

    prev = {
        dep: app.dependency_overrides.get(dep)
        for dep in (get_current_user, get_optional_user, get_permission_claims)
    }
    app.dependency_overrides[get_current_user] = _user
    app.dependency_overrides[get_optional_user] = _user
    app.dependency_overrides[get_permission_claims] = _claims
    try:
        yield
    finally:
        for dep, original in prev.items():
            if original is None:
                app.dependency_overrides.pop(dep, None)
            else:
                app.dependency_overrides[dep] = original


async def _seed(session):
    session.add(WorkspaceORM(id=WS, name="Finance"))
    session.add(WorkspaceDataSourceORM(
        id="ds_fin", workspace_id=WS, provider_id="prv_x", graph_name="fin",
    ))
    session.add(ContextModelORM(id="cm_tpl", name="Quick Start", is_template=True))
    for tier in ("private", "workspace", "enterprise", "public"):
        session.add(ViewORM(
            id=f"view_{tier}", name=tier.title(), workspace_id=WS,
            data_source_id="ds_fin", visibility=tier, created_by="usr_owner",
            config="{}",
        ))
    await session.commit()


#: What ``get_permission_claims`` hands back when nothing could answer.
#: Note it is indistinguishable from ``UNBOUND`` below on ``ws_perms``
#: alone — the flag is the only thing that tells them apart, which is the
#: whole reason it exists.
UNKNOWN = PermissionClaims(sid="s_unknown", ws_perms={}, ws_available=False)
#: A user who genuinely holds no workspace bindings. Same empty map.
UNBOUND = PermissionClaims(sid="s_unbound", ws_perms={})
#: Decided entirely by the token's global claims.
SYSADMIN = PermissionClaims(
    sid="s_admin", global_perms=("system:admin",), ws_perms={},
    ws_available=False,
)


# ── list routes refuse rather than under-report ──────────────────────

@pytest.mark.asyncio
async def test_list_refuses_instead_of_returning_a_short_list(
    test_client: AsyncClient, db_session,
):
    """The failure this whole file exists for.

    Without the guard this is a 200 carrying only the ``public`` view —
    a page that looks entirely normal and is missing three rows the user
    may well be entitled to.
    """
    await _seed(db_session)
    with _as("usr_member", UNKNOWN):
        resp = await test_client.get("/api/v1/views/")
    assert resp.status_code == 503
    assert resp.json()["detail"] == "Authorization temporarily unavailable"


@pytest.mark.asyncio
async def test_the_same_empty_map_is_a_200_when_it_is_an_answer(
    test_client: AsyncClient, db_session,
):
    """``UNBOUND`` and ``UNKNOWN`` carry identical ``ws_perms``.

    If the guard keyed off emptiness rather than the flag, every user with
    no bindings would get a 503 forever. They get their ``public`` view.
    """
    await _seed(db_session)
    with _as("usr_unbound", UNBOUND):
        resp = await test_client.get("/api/v1/views/")
    assert resp.status_code == 200
    assert {v["id"] for v in resp.json()["items"]} == {"view_public"}


@pytest.mark.asyncio
async def test_system_admin_is_unaffected(test_client: AsyncClient, db_session):
    """Their reach comes from ``global_perms``, which travels in the token.

    The store being down cannot make this answer wrong, so refusing would
    be a self-inflicted outage rather than caution.
    """
    await _seed(db_session)
    with _as("usr_admin", SYSADMIN):
        resp = await test_client.get("/api/v1/views/")
    assert resp.status_code == 200
    assert len(resp.json()["items"]) == 4


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/api/v1/views/facets", "/api/v1/views/stats"])
async def test_aggregations_refuse_too(
    test_client: AsyncClient, db_session, path: str,
):
    """Facets and stats are built from the same predicate.

    Aggregates are the worse leak of the two: a caller cannot tell a short
    list from a complete one, but they *really* cannot tell a short count
    from a real one.
    """
    await _seed(db_session)
    with _as("usr_member", UNKNOWN):
        resp = await test_client.get(path)
    assert resp.status_code == 503


# ── the evaluator says which kind of "no" it means ───────────────────

@pytest.mark.asyncio
async def test_read_decision_marks_the_denial_indeterminate(db_session):
    await _seed(db_session)
    view = await db_session.get(ViewORM, "view_workspace")

    ctx = await view_access.ViewerContext.build(
        db_session, user=type("U", (), {"id": "usr_member"})(), claims=UNKNOWN,
    )
    decision = await view_access.read_decision(db_session, ctx, view)
    assert decision.allowed is False
    assert decision.indeterminate is True


@pytest.mark.asyncio
async def test_a_real_denial_is_not_indeterminate(db_session):
    """The distinction has to cut both ways to be worth anything."""
    await _seed(db_session)
    view = await db_session.get(ViewORM, "view_workspace")

    ctx = await view_access.ViewerContext.build(
        db_session, user=type("U", (), {"id": "usr_unbound"})(), claims=UNBOUND,
    )
    decision = await view_access.read_decision(db_session, ctx, view)
    assert decision.allowed is False
    assert decision.indeterminate is False


@pytest.mark.asyncio
async def test_anonymous_callers_are_never_indeterminate(db_session):
    """They have no workspace reach to be uncertain about, so a store
    outage tells us nothing new about them."""
    await _seed(db_session)
    view = await db_session.get(ViewORM, "view_public")

    ctx = await view_access.ViewerContext.build(
        db_session, user=None, claims=UNKNOWN,
    )
    scope = await view_access.build_read_scope(db_session, ctx)
    assert scope.indeterminate is False
    decision = await view_access.read_decision(db_session, ctx, view)
    assert decision.indeterminate is False


# ── delegation must not silently demote a member ─────────────────────

@pytest.mark.asyncio
async def test_delegation_refuses_rather_than_confining_a_member(
    test_client: AsyncClient, db_session,
):
    """The subtlest consequence of the split.

    ``requires_ws_read_or_view_delegate`` starts with a bare
    ``has_permission(...)`` fast path, so unreadable grants make a genuine
    member fail it. Falling through, they would be confined to one view's
    scope and served a *partial* graph with a 200 — a wrong answer wearing
    a success code, which is worse than either a 403 or an empty canvas.
    """
    await _seed(db_session)
    with _as("usr_member", UNKNOWN):
        resp = await test_client.get(
            TEMPLATES.format(ws=WS), params={"viewId": "view_public"},
        )
    assert resp.status_code == 503
    assert resp.json()["detail"] == "Authorization temporarily unavailable"


@pytest.mark.asyncio
async def test_delegation_still_works_when_grants_are_known(
    test_client: AsyncClient, db_session,
):
    """The outsider the delegation path was built for is unaffected."""
    await _seed(db_session)
    with _as("usr_outsider", UNBOUND):
        resp = await test_client.get(
            TEMPLATES.format(ws=WS), params={"viewId": "view_public"},
        )
    assert resp.status_code == 200
