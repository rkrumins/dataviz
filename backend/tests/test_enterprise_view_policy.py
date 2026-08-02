"""The platform ceiling on publishing.

Three controls now decide whether a view can go platform-wide, and they
nest: the deployment's ``enterpriseViewPolicy`` caps how open any
workspace may be, the workspace's own ``publish_policy`` decides within
that, and a restricted source overrides an open workspace. The
permission satisfies the last two outright — it does NOT satisfy the
first, because a ceiling only non-admins obey is not a ceiling.

The two rules that are easy to get wrong, and that this file exists to
hold down:

1. **Unpublishing is never blocked.** Both policies exist to slow down
   EXPOSING things. Applying them in reverse would mean a deployment
   switching to 'off' strands every view it already published with
   nobody able to close them.
2. **The reason travels with the refusal.** "Your organisation does not
   allow this" and "a workspace admin has to approve this" are
   different sentences; a UI given only a boolean shows the wrong one.
"""
from __future__ import annotations

import time

import pytest
from httpx import AsyncClient

from backend.app.db.models import ViewORM, WorkspaceORM
from backend.app.services.permission_service import PermissionClaims
from backend.tests.test_views_scoping_regressions import _auth, _user


WS = "ws_ceiling"

CREATOR = _user("usr_ceil_creator")
ADMIN = _user("usr_ceil_admin")

MEMBER_CLAIMS = PermissionClaims(sid="s_ceil_member", ws_perms={WS: (
    "workspace:view:create", "workspace:view:edit",
    "workspace:view:delete", "workspace:view:read",
)})
# The publish permission alone does not let you touch someone else's
# view: ``can_change_visibility`` (creator or workspace admin) is the
# base gate and fires first. So the publisher here is also a workspace
# admin — the shape a real "can publish" principal has.
PUBLISHER_CLAIMS = PermissionClaims(sid="s_ceil_pub", ws_perms={WS: (
    "workspace:admin",
    "workspace:view:create", "workspace:view:edit",
    "workspace:view:delete", "workspace:view:read",
    "workspace:view:publish",
)})


@pytest.fixture
def ceiling():
    """Set the platform ceiling for one test.

    Primes the flag service's cache rather than writing a row — the same
    thing conftest does for the seeded defaults, and the same way a gate
    sees the value at request time. Writing only the row would test the
    PREVIOUS value, because the service memoises.
    """
    from backend.app.services.feature_flags import feature_flags

    def _set(value: str):
        feature_flags._cache = {
            **(feature_flags._cache or {}), "enterpriseViewPolicy": value,
        }
        feature_flags._cache_ts = time.monotonic()

    yield _set
    feature_flags.invalidate()


async def _seed(db_session, *, policy="open", visibility="workspace",
                view_id="view_ceil"):
    ws = await db_session.get(WorkspaceORM, WS)
    if ws is None:
        db_session.add(WorkspaceORM(id=WS, name="Ceiling", publish_policy=policy))
    else:
        ws.publish_policy = policy
    db_session.add(ViewORM(
        id=view_id, name=view_id, workspace_id=WS,
        visibility=visibility, created_by=CREATOR.id,
    ))
    await db_session.commit()
    return view_id


async def _publish(client, view_id, visibility="enterprise"):
    return await client.put(
        f"/api/v1/views/{view_id}/visibility", json={"visibility": visibility},
    )


# ── 'request': the rule a workspace admin cannot opt out of ──────────

@pytest.mark.asyncio
async def test_request_ceiling_overrides_an_open_workspace(
    test_client: AsyncClient, db_session, ceiling,
):
    ceiling("request")
    vid = await _seed(db_session, policy="open", view_id="view_ceil_req")
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        r = await _publish(test_client, vid)
        env = await test_client.get(f"/api/v1/views/{vid}")
    assert r.status_code == 403, r.text
    access = env.json()["access"]
    assert access["canPublish"] is False
    # Not a wall: the member can still ask.
    assert access["canRequestPublish"] is True
    assert access["publishBlockedBy"] == "platform", (
        "the workspace is open — telling them to ask their workspace admin "
        "would send them to someone who cannot help"
    )


@pytest.mark.asyncio
async def test_request_ceiling_still_lets_a_publisher_publish(
    test_client: AsyncClient, db_session, ceiling,
):
    """'Always require approval' means a publisher approves it — and a
    publisher acting directly IS that approval."""
    ceiling("request")
    vid = await _seed(db_session, policy="open", view_id="view_ceil_pub")
    with _auth(user=ADMIN, claims=PUBLISHER_CLAIMS):
        r = await _publish(test_client, vid)
    assert r.status_code == 200, r.text
    assert r.json()["visibility"] == "enterprise"


# ── 'off': the tier is withdrawn ─────────────────────────────────────

@pytest.mark.asyncio
async def test_off_refuses_even_a_publisher(
    test_client: AsyncClient, db_session, ceiling,
):
    ceiling("off")
    vid = await _seed(db_session, policy="open", view_id="view_ceil_off")
    with _auth(user=ADMIN, claims=PUBLISHER_CLAIMS):
        r = await _publish(test_client, vid)
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["type"] == "feature_disabled"
    assert r.json()["detail"]["feature"] == "enterpriseViewPolicy"


@pytest.mark.asyncio
async def test_off_offers_no_request_because_nobody_could_answer_it(
    test_client: AsyncClient, db_session, ceiling,
):
    ceiling("off")
    vid = await _seed(db_session, policy="open", view_id="view_ceil_off2")
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        env = await test_client.get(f"/api/v1/views/{vid}")
    access = env.json()["access"]
    assert access["canPublish"] is False
    assert access["canRequestPublish"] is False
    assert access["enterpriseAvailable"] is False, "hide the tier, don't grey it out"
    assert access["publishBlockedBy"] == "platform"


@pytest.mark.asyncio
async def test_off_cannot_be_reached_through_the_request_queue(
    test_client: AsyncClient, db_session, ceiling,
):
    """A request filed while the tier was available must not survive its
    withdrawal as a way around it."""
    vid = await _seed(db_session, policy="request", view_id="view_ceil_queue")
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        asked = await test_client.post(f"/api/v1/views/{vid}/publish-request", json={})
    assert asked.status_code == 200, asked.text

    ceiling("off")
    with _auth(user=ADMIN, claims=PUBLISHER_CLAIMS):
        r = await test_client.post(f"/api/v1/views/{vid}/publish-request/approve")
    assert r.status_code == 403, r.text
    row = await db_session.get(ViewORM, vid)
    await db_session.refresh(row)
    assert row.visibility == "workspace"


@pytest.mark.asyncio
async def test_off_refuses_creating_one_directly(
    test_client: AsyncClient, db_session, ceiling,
):
    ceiling("off")
    await _seed(db_session, policy="open", view_id="view_ceil_seed")
    with _auth(user=ADMIN, claims=PUBLISHER_CLAIMS):
        r = await test_client.post("/api/v1/views/", json={
            "name": "Straight to everyone", "workspaceId": WS,
            "viewType": "custom", "visibility": "enterprise",
        })
    assert r.status_code == 403, r.text


# ── the direction that must never be blocked ─────────────────────────

@pytest.mark.asyncio
async def test_unpublishing_survives_the_tier_being_withdrawn(
    test_client: AsyncClient, db_session, ceiling,
):
    """The whole point of 'off' is less exposure. Blocking the way OUT
    would strand every already-published view permanently."""
    ceiling("off")
    vid = await _seed(
        db_session, policy="open", visibility="enterprise", view_id="view_ceil_down",
    )
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        r = await _publish(test_client, vid, visibility="workspace")
    assert r.status_code == 200, r.text
    assert r.json()["visibility"] == "workspace"


@pytest.mark.asyncio
async def test_a_published_view_keeps_working_when_the_tier_is_withdrawn(
    test_client: AsyncClient, db_session, ceiling,
):
    """Withdrawing the tier stops NEW publishing; it does not retire
    what is already out there, and the envelope must not claim the
    owner has lost the ability to close it."""
    ceiling("off")
    vid = await _seed(
        db_session, policy="open", visibility="enterprise", view_id="view_ceil_live",
    )
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        env = await test_client.get(f"/api/v1/views/{vid}")
    assert env.status_code == 200
    assert env.json()["visibility"] == "enterprise"
    assert env.json()["access"]["enterpriseAvailable"] is True


# ── the default is unchanged ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_the_default_ceiling_changes_nothing(
    test_client: AsyncClient, db_session, ceiling,
):
    ceiling("workspaces")
    vid = await _seed(db_session, policy="open", view_id="view_ceil_default")
    with _auth(user=CREATOR, claims=MEMBER_CLAIMS):
        r = await _publish(test_client, vid)
        env = await test_client.get(f"/api/v1/views/{vid}")
    assert r.status_code == 200, r.text
    assert env.json()["access"]["publishBlockedBy"] is None
