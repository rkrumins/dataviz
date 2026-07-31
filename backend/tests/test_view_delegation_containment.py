"""The delegation bridge, as wired to the routes that actually paint a canvas.

Two separate defects, and the order they were fixed in matters.

The bridge shipped wired to ``canvas`` and ``context_models``, neither of
which the frontend calls to render a view — it calls four reads on the
``graph`` router, and every one of them was gated on plain
``workspace:datasource:read``. So a delegate opened a view and painted
nothing: verbatim the failure ``view_delegation.py`` was written to remove.

Switching the bridge on would have been a mistake on its own, because two of
its clamps were wrong in the widening direction:

  * the entity-type clamp returned ``[]`` for a request disjoint from the
    view's allow-list, and ``[]`` means "no filter" downstream — so asking for
    a type the view does not contain escaped the filter entirely;
  * ``expand`` applied no entity-type clamp at all, and its root check
    returned early for views with no explicit roots, so one in-scope container
    was a doorway to the rest of the workspace's graph.

The clamps are fixed first, then the routes are wired. These tests pin both
halves, plus the invariant that ordinary members are untouched.
"""
from __future__ import annotations

import contextlib

import pytest
from fastapi import HTTPException
from httpx import AsyncClient

from backend.app.auth.dependencies import (
    get_current_user,
    get_optional_user,
    get_permission_claims,
)
from backend.app.auth.view_delegation import ViewDelegation
from backend.app.db.models import (
    ViewORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.view_scope import EffectiveViewScope

WS = "ws_finance"


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


def _scope(*, roots=(), entity_types=()) -> EffectiveViewScope:
    return EffectiveViewScope(
        view_id="view_public",
        workspace_id=WS,
        data_source_id="ds_fin",
        canvas_kind="reference",
        root_urns=tuple(roots),
        entity_type_allow_list=frozenset(entity_types),
        layer_allow_list=frozenset(),
        max_depth=3,
        scope_hash="hash123",
    )


def _delegation(scope: EffectiveViewScope) -> ViewDelegation:
    return ViewDelegation(
        view_id="view_public", workspace_id=WS,
        data_source_id="ds_fin", scope=scope, reason="tier:public",
    )


async def _seed(session):
    session.add(WorkspaceORM(id=WS, name="Finance"))
    session.add(WorkspaceDataSourceORM(
        id="ds_fin", workspace_id=WS, provider_id="prv_x", graph_name="fin",
    ))
    session.add(ViewORM(
        id="view_public", name="Public", workspace_id=WS,
        data_source_id="ds_fin", visibility="public", created_by="usr_owner",
        config="{}",
    ))
    await session.commit()


OUTSIDER = PermissionClaims(sid="s_out", ws_perms={})
MEMBER = PermissionClaims(
    sid="s_mem", ws_perms={WS: ("workspace:datasource:read",)},
)


# ── the entity-type clamp must narrow, never widen ───────────────────

def test_disjoint_entity_types_are_refused_not_emptied():
    """``[]`` means "no entity filter" downstream, so returning it for a
    disjoint request turned the clamp into a full-graph scan at exactly the
    input that should have narrowed it to nothing."""
    from backend.app.api.v1.endpoints.canvas import _delegate_entity_types

    delegation = _delegation(_scope(entity_types=["Table", "Column"]))
    with pytest.raises(HTTPException) as exc:
        _delegate_entity_types(delegation, ["__nothing__"])
    assert exc.value.status_code == 403
    assert exc.value.detail["error"] == "outside_view_scope"


def test_overlapping_entity_types_narrow_to_the_intersection():
    from backend.app.api.v1.endpoints.canvas import _delegate_entity_types

    delegation = _delegation(_scope(entity_types=["Table", "Column"]))
    assert _delegate_entity_types(delegation, ["Table", "Dashboard"]) == ["Table"]


def test_an_unconstrained_view_passes_the_request_through():
    """A view with no entity-type allow-list constrains nothing by type —
    that is its author's choice, not a hole."""
    from backend.app.api.v1.endpoints.canvas import _delegate_entity_types

    delegation = _delegation(_scope())
    assert _delegate_entity_types(delegation, ["Anything"]) == ["Anything"]


def test_members_are_never_clamped():
    from backend.app.api.v1.endpoints.canvas import _delegate_entity_types

    assert _delegate_entity_types(None, ["Anything"]) == ["Anything"]
    assert _delegate_entity_types(None, None) is None


# ── expand must be bounded by types when it has no roots ─────────────

@pytest.mark.asyncio
async def test_expand_refuses_a_node_outside_the_views_entity_types():
    """The root check returned early for a view with no explicit roots, and
    expand applied no type clamp — so a view restricted to ``Table`` let a
    delegate walk into a ``Column`` and onward through the graph."""
    from backend.app.api.v1.endpoints.canvas import _assert_expandable

    class _Engine:
        async def get_node(self, urn):
            return type("N", (), {"urn": urn, "entity_type": "Column"})()

    delegation = _delegation(_scope(entity_types=["Table"]))
    with pytest.raises(HTTPException) as exc:
        await _assert_expandable(_Engine(), delegation, "urn:some-column")
    assert exc.value.status_code == 403
    assert exc.value.detail["error"] == "outside_view_scope"


@pytest.mark.asyncio
async def test_expand_allows_a_node_of_an_allowed_type():
    from backend.app.api.v1.endpoints.canvas import _assert_expandable

    class _Engine:
        async def get_node(self, urn):
            return type("N", (), {"urn": urn, "entity_type": "Table"})()

    delegation = _delegation(_scope(entity_types=["Table"]))
    await _assert_expandable(_Engine(), delegation, "urn:a-table")  # no raise


@pytest.mark.asyncio
async def test_expand_still_honours_explicit_roots():
    """When the view declares roots, containment decides — unchanged."""
    from backend.app.api.v1.endpoints.canvas import _assert_expandable

    class _Engine:
        async def get_ancestors(self, urn):
            return []

    delegation = _delegation(_scope(roots=["urn:root"]))
    with pytest.raises(HTTPException):
        await _assert_expandable(_Engine(), delegation, "urn:elsewhere")


@pytest.mark.asyncio
async def test_a_wholly_unconstrained_view_is_still_expandable():
    """No roots and no types means the view IS the data source — which is
    what its author published. Only that case is unbounded."""
    from backend.app.api.v1.endpoints.canvas import _assert_expandable

    await _assert_expandable(object(), _delegation(_scope()), "urn:anything")


# ── the bridge reaches the routes a canvas actually calls ────────────

@pytest.mark.asyncio
async def test_delegate_reaches_a_canvas_read_route(
    test_client: AsyncClient, db_session,
):
    """`/metadata/entity-types` is one of the four reads a view's canvas
    issues. Before wiring, an outsider naming a public view still got the
    typed 403 and painted nothing."""
    from backend.app.api.v1.endpoints.graph import get_context_engine
    from backend.app.main import app
    from backend.app.services.context_engine import ContextEngine

    await _seed(db_session)

    class _Provider:
        async def get_distinct_values(self, prop, **kw):
            return ["Table"]

    async def _engine():
        return ContextEngine(provider=_Provider())

    app.dependency_overrides[get_context_engine] = _engine
    try:
        with _as("usr_outsider", OUTSIDER):
            resp = await test_client.get(
                f"/api/v1/{WS}/graph/metadata/entity-types",
                params={"viewId": "view_public"},
            )
    finally:
        app.dependency_overrides.pop(get_context_engine, None)
    assert resp.status_code == 200, resp.text


@pytest.mark.asyncio
async def test_delegation_does_not_reach_a_write_route(
    test_client: AsyncClient, db_session,
):
    """The allow-list is default-closed. The graph router carries /save,
    /nodes/create, /edges and /commands/batch alongside the four reads, and a
    ?viewId= must not buy any of them."""
    await _seed(db_session)
    with _as("usr_outsider", OUTSIDER):
        resp = await test_client.post(
            f"/api/v1/{WS}/graph/save",
            params={"viewId": "view_public"},
            json={},
        )
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "missing_permission"


@pytest.mark.asyncio
async def test_member_is_unaffected_by_the_allow_list(
    test_client: AsyncClient, db_session,
):
    """A member holds the permission outright and takes the fast path, so the
    allow-list never applies to them — including on the write routes."""
    from backend.app.api.v1.endpoints.graph import get_context_engine
    from backend.app.main import app
    from backend.app.services.context_engine import ContextEngine

    await _seed(db_session)

    class _Provider:
        async def get_distinct_values(self, prop, **kw):
            return ["Table"]

    async def _engine():
        return ContextEngine(provider=_Provider())

    app.dependency_overrides[get_context_engine] = _engine
    try:
        with _as("usr_member", MEMBER):
            resp = await test_client.get(
                f"/api/v1/{WS}/graph/metadata/entity-types",
            )
    finally:
        app.dependency_overrides.pop(get_context_engine, None)
    assert resp.status_code == 200, resp.text
