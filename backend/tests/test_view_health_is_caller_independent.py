"""Health describes the view, not the person asking about it.

The reported bug: a view set to **Public** showed a red "Source deleted" badge
to a second account in another browser, and clicking it gave a full-screen
"View Cannot Load — The workspace for this view no longer exists." Nothing had
been deleted; the owner's own browser showed the same view as healthy.

The client was computing health itself, by looking the view's workspace up in
the store behind ``GET /workspaces`` — which returns only the workspaces the
caller holds a binding in. ``enterprise`` and ``public`` exist precisely for
people who hold no such binding, so for exactly the audience those tiers were
built for the lookup always missed, and a miss was rendered as a deletion.

These tests pin the property that makes that class of bug impossible: two
callers must get the same answer for the same view. If health is ever a
function of the caller again, the first test here fails.
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
    ViewORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.services.permission_service import PermissionClaims

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


async def _seed(session, *, ds_deleted=False, ws_active=True):
    session.add(WorkspaceORM(id=WS, name="Finance", is_active=ws_active))
    session.add(WorkspaceDataSourceORM(
        id="ds_fin", workspace_id=WS, provider_id="prv_falkor",
        graph_name="fin", label="Nexus Lineage", is_active=True,
        deleted_at="2026-07-01T00:00:00Z" if ds_deleted else None,
    ))
    session.add(ViewORM(
        id="view_public", name="Impact Analysis", workspace_id=WS,
        data_source_id="ds_fin", visibility="public", created_by="usr_owner",
        config="{}",
    ))
    await session.commit()


#: The reporter's second account: signed in, no binding in the view's
#: workspace. Reaches the view only through its `public` tier.
OUTSIDER = PermissionClaims(sid="s_out", ws_perms={})
#: The owner's account.
OWNER = PermissionClaims(sid="s_own", ws_perms={WS: ("workspace:admin",)})


@pytest.mark.asyncio
async def test_two_callers_get_identical_health_for_one_view(
    test_client: AsyncClient, db_session,
):
    """The regression, stated directly.

    A member and a non-member read the same healthy public view. Every field
    describing the view's own world must match.
    """
    await _seed(db_session)

    with _as("usr_owner", OWNER):
        as_owner = (await test_client.get("/api/v1/views/view_public")).json()
    with _as("usr_outsider", OUTSIDER):
        as_outsider = (await test_client.get("/api/v1/views/view_public")).json()

    for field in (
        "healthStatus", "healthReason", "providerId",
        "workspaceName", "dataSourceName",
        "workspaceIsActive", "dataSourceIsActive",
    ):
        assert as_owner[field] == as_outsider[field], (
            f"{field} differed by caller: "
            f"owner={as_owner[field]!r} outsider={as_outsider[field]!r}"
        )


@pytest.mark.asyncio
async def test_a_healthy_public_view_reads_healthy_to_a_non_member(
    test_client: AsyncClient, db_session,
):
    """The user's screenshot, inverted into an assertion."""
    await _seed(db_session)
    with _as("usr_outsider", OUTSIDER):
        body = (await test_client.get("/api/v1/views/view_public")).json()

    assert body["healthStatus"] == "healthy"
    assert body["healthReason"] is None
    # And the canvas has what it needs to actually paint.
    assert body["providerId"] == "prv_falkor"
    assert body["workspaceName"] == "Finance"
    assert body["dataSourceName"] == "Nexus Lineage"


@pytest.mark.asyncio
async def test_the_list_agrees_with_the_detail_route(
    test_client: AsyncClient, db_session,
):
    """The Explorer card and the view page must not disagree — they are
    separate code paths (batched vs per-row enrichment) and the card was the
    one showing the false warning."""
    await _seed(db_session)
    with _as("usr_outsider", OUTSIDER):
        detail = (await test_client.get("/api/v1/views/view_public")).json()
        listed = (await test_client.get("/api/v1/views/")).json()["items"]

    card = next(v for v in listed if v["id"] == "view_public")
    for field in ("healthStatus", "healthReason", "providerId", "workspaceName"):
        assert card[field] == detail[field], f"{field} differs list vs detail"


@pytest.mark.asyncio
async def test_a_genuinely_deleted_source_is_still_reported(
    test_client: AsyncClient, db_session,
):
    """The guard must not be a blanket 'always healthy'. A real deletion is
    still broken — and the reason names the data source, where the old card
    labelled every failure "Source deleted" regardless of cause.
    """
    await _seed(db_session, ds_deleted=True)
    with _as("usr_outsider", OUTSIDER):
        body = (await test_client.get("/api/v1/views/view_public")).json()

    assert body["healthStatus"] == "broken"
    assert "data source" in body["healthReason"].lower()


@pytest.mark.asyncio
async def test_an_inactive_workspace_is_a_warning_not_a_deletion(
    test_client: AsyncClient, db_session,
):
    """Three distinct states — deleted, inactive, fine — must stay distinct."""
    await _seed(db_session, ws_active=False)
    with _as("usr_outsider", OUTSIDER):
        body = (await test_client.get("/api/v1/views/view_public")).json()

    assert body["healthStatus"] == "warning"
    assert "workspace" in body["healthReason"].lower()
