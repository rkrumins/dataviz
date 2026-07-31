"""Six ways a `private` view still leaked after visibility became authoritative.

PR #342 made the tier decide who reaches a view, and moved that decision into
the SQL the list endpoints run. What it did not do is revisit every *other*
route that had already loaded a view by id, or that answered a question
*about* a view without asking whether the caller could see it.

Six of them had their own rule:

  * ``visibility-preview`` gated on read, then returned the workspace's member
    roster — so opening one ``public`` view bought you the directory.
  * the workspace activity feed gated on ``workspace:view:read`` and returned
    every view's history, private ones included.
  * ``ViewScopeResolver`` checked tenancy and nothing else, so naming any view
    id returned its curated composition.
  * import and export resolved their ``?viewId=`` by raw primary key in a
    background worker — no workspace check at all, which made import a
    cross-tenant *write*.
  * the grants router answered 404 for absent and 403-naming-the-workspace for
    forbidden, which is an existence oracle over every view on the platform.

Each test below pins the closed behaviour and fails against the old code.
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
    RoleBindingORM,
    UserORM,
    ViewActivityLogORM,
    ViewORM,
    WorkspaceORM,
)
from backend.app.services.permission_service import PermissionClaims

WS = "ws_finance"
OTHER_WS = "ws_marketing"


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
    session.add(WorkspaceORM(id=OTHER_WS, name="Marketing"))
    # A roster to leak: three bound users, two of them with no name set so
    # resolve_user_ids falls back to their email address.
    for i, (uid, first) in enumerate(
        [("usr_alice", "Alice"), ("usr_bob", ""), ("usr_carol", "")]
    ):
        session.add(UserORM(
            id=uid, email=f"{uid}@acme.com", first_name=first, last_name="",
            password_hash="x",
        ))
        session.add(RoleBindingORM(
            subject_type="user", subject_id=uid, role_name="workspace_member",
            scope_type="workspace", scope_id=WS,
        ))
    session.add(ViewORM(
        id="view_public", name="Public One", workspace_id=WS,
        visibility="public", created_by="usr_owner", config="{}",
    ))
    session.add(ViewORM(
        id="view_private", name="Q3 Board Comp Model", workspace_id=WS,
        visibility="private", created_by="usr_owner", config="{}",
    ))
    await session.commit()


#: An outsider: no binding anywhere. Reaches `public` and nothing else.
STRANGER = PermissionClaims(sid="s_stranger", ws_perms={})
#: A plain member of WS. Reaches `workspace`, not someone else's `private`.
MEMBER = PermissionClaims(
    sid="s_member", ws_perms={WS: ("workspace:view:read",)},
)
#: Manage rights in the OTHER workspace only.
OTHER_ADMIN = PermissionClaims(
    sid="s_other", ws_perms={OTHER_WS: ("workspace:admin", "workspace:datasource:manage")},
)


# ── 1. visibility-preview handed out the workspace roster ────────────

@pytest.mark.asyncio
async def test_visibility_preview_refuses_a_mere_reader(
    test_client: AsyncClient, db_session,
):
    """Reading a public view must not reveal who is in its workspace.

    The endpoint answers "who gains access if I promote this?" — a question
    only the person who can perform the promotion has cause to ask.
    """
    await _seed(db_session)
    with _as("usr_stranger", STRANGER):
        resp = await test_client.get(
            "/api/v1/views/view_public/visibility-preview",
            params={"tier": "workspace"},
        )
    assert resp.status_code == 403
    body = resp.text
    assert "acme.com" not in body, "member emails leaked in the refusal body"


@pytest.mark.asyncio
async def test_visibility_preview_still_works_for_the_owner(
    test_client: AsyncClient, db_session,
):
    """The guard must not break the feature for whom it exists."""
    await _seed(db_session)
    owner = PermissionClaims(sid="s_owner", ws_perms={WS: ("workspace:admin",)})
    with _as("usr_owner", owner):
        resp = await test_client.get(
            "/api/v1/views/view_public/visibility-preview",
            params={"tier": "workspace"},
        )
    assert resp.status_code == 200
    assert resp.json()["addedCount"] == 3


# ── 2. the workspace activity feed carried private views ─────────────

@pytest.mark.asyncio
async def test_workspace_activity_hides_private_view_history(
    test_client: AsyncClient, db_session,
):
    """A workspace member reads the feed and must not see a private view's
    name or the summary lines describing who it was shared with."""
    await _seed(db_session)
    for vid, summary in [
        ("view_private", 'Renamed to "Q3 Board Comp Model"'),
        ("view_public", "Created"),
    ]:
        db_session.add(ViewActivityLogORM(
            view_id=vid, workspace_id=WS, action="updated",
            actor="usr_owner", summary=summary,
        ))
    await db_session.commit()

    with _as("usr_member", MEMBER):
        resp = await test_client.get(f"/api/v1/views/workspace/{WS}/activity")
    assert resp.status_code == 200
    body = resp.json()
    view_ids = {e["viewId"] for e in body}
    assert "view_private" not in view_ids
    assert "Q3 Board Comp Model" not in resp.text
    # Anti-vacuity: the feed is not simply empty.
    assert "view_public" in view_ids


# ── 3. the scope resolver authorized nothing but tenancy ─────────────

@pytest.mark.asyncio
async def test_scope_resolver_refuses_a_view_the_caller_cannot_read(db_session):
    """`/search/explain` returned a private view's root URNs and entity-type
    allow-list to anyone with data-source read in the workspace."""
    from backend.app.services import view_access
    from backend.app.services.view_scope import ViewNotFound, ViewScopeResolver
    from backend.common.models.search import SearchScope

    await _seed(db_session)
    ctx = await view_access.ViewerContext.build(
        db_session, user=type("U", (), {"id": "usr_member"})(), claims=MEMBER,
    )
    resolver = ViewScopeResolver(db_session)
    with pytest.raises(ViewNotFound):
        await resolver.resolve(
            workspace_id=WS,
            requested=SearchScope(view_id="view_private"),
            viewer=ctx,
        )


@pytest.mark.asyncio
async def test_scope_resolver_still_resolves_a_readable_view(db_session):
    """The refusal must key on access, not fail closed for everyone."""
    from backend.app.services import view_access
    from backend.app.services.view_scope import ViewScopeResolver
    from backend.common.models.search import SearchScope

    await _seed(db_session)
    ctx = await view_access.ViewerContext.build(
        db_session, user=type("U", (), {"id": "usr_member"})(), claims=MEMBER,
    )
    scope = await ViewScopeResolver(db_session).resolve(
        workspace_id=WS,
        requested=SearchScope(view_id="view_public"),
        viewer=ctx,
    )
    assert scope.view_id == "view_public"


# ── 4/5. import and export resolved ?viewId= by raw primary key ──────

@pytest.mark.asyncio
async def test_import_layout_writer_refuses_a_cross_workspace_view(
    db_session, monkeypatch,
):
    """The worker-side backstop: a member of one workspace must not be able to
    merge their URNs into another workspace's view config.

    Checked at the writer as well as the route because the writer runs in the
    background with no caller to authorize against — so it opens its own
    session, which the fixture stands in for here.
    """
    import contextlib as _ctx

    from backend.app.api.v1.endpoints.versioning import (
        _write_view_import_assignments,
    )

    await _seed(db_session)

    @_ctx.asynccontextmanager
    async def _fake_session():
        yield db_session

    monkeypatch.setattr(
        "backend.app.db.engine.get_async_session", _fake_session,
    )
    result = await _write_view_import_assignments(
        OTHER_WS, "ds_other", "view_private", [], [],
    )
    assert result == {"added": 0}


@pytest.mark.asyncio
async def test_export_scope_refuses_a_cross_workspace_view(db_session):
    """Same backstop on the export side — a foreign view must not shape this
    workspace's export scope."""
    from backend.app.api.v1.endpoints.versioning import _resolve_export_view_scope

    await _seed(db_session)
    assert await _resolve_export_view_scope(
        OTHER_WS, "ds_other", "view_private",
    ) is None


@pytest.mark.asyncio
async def test_scope_view_gate_refuses_a_view_in_another_workspace(db_session):
    """The request-time gate, which is the primary defence — the caller gets a
    404 rather than a silently-ignored write."""
    from fastapi import HTTPException

    from backend.app.api.v1.endpoints.versioning import _assert_scope_view_usable

    await _seed(db_session)
    user = type("U", (), {"id": "usr_other"})()
    with pytest.raises(HTTPException) as exc:
        await _assert_scope_view_usable(
            db_session, view_id="view_private", workspace_id=OTHER_WS,
            user=user, claims=OTHER_ADMIN, need_edit=True,
        )
    assert exc.value.status_code == 404


# ── 6. the grants router distinguished absent from forbidden ─────────

@pytest.mark.asyncio
async def test_grants_does_not_confirm_a_private_view_exists(
    test_client: AsyncClient, db_session,
):
    """404 for a view the caller cannot read, identical to a view that does not
    exist — and the body must not name the workspace it lives in."""
    await _seed(db_session)
    with _as("usr_stranger", STRANGER):
        real = await test_client.get("/api/v1/views/view_private/grants")
        absent = await test_client.get("/api/v1/views/view_nonexistent/grants")

    assert real.status_code == absent.status_code == 404
    assert WS not in real.text, "the refusal named the view's workspace"
