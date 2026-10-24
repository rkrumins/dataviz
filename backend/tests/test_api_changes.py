"""``GET /api/v1/changes`` — the manifest that replaces nine idle polls.

Two things are being pinned here. The first is the authorization
boundary: a caller receives the topics their session implies and cannot
name anyone else's, no matter what they send. The second is the failure
posture, which is less obvious and matters more — when the registry
cannot answer, the endpoint must refuse rather than report zeros,
because zeros mean "everything you hold is stale" and would send every
connected client to refetch everything at exactly the wrong moment.
"""
from __future__ import annotations

import asyncio

import pytest
from httpx import AsyncClient

from backend.app.api.v1.endpoints import changes as changes_endpoint
from backend.app.changes import topics as change_topics
from backend.app.changes.registry import InMemoryChangeRegistry

FAKE_USER_ID = "usr_test000000"


@pytest.fixture
def registry(monkeypatch):
    reg = InMemoryChangeRegistry()
    monkeypatch.setattr(changes_endpoint, "get_registry", lambda: reg)
    return reg


async def test_manifest_returns_the_callers_topics(
    test_client: AsyncClient, registry
):
    resp = await test_client.get("/api/v1/changes")
    assert resp.status_code == 200
    topics = resp.json()["topics"]

    for topic in change_topics.GLOBAL_TOPICS:
        assert topic in topics
    assert change_topics.notifications_for(FAKE_USER_ID) in topics
    assert change_topics.permissions_for(FAKE_USER_ID) in topics
    assert change_topics.invite_activity_for(FAKE_USER_ID) in topics


async def test_unseen_topics_report_zero(test_client: AsyncClient, registry):
    """Every subscribed topic appears, so a client can diff the whole map."""
    resp = await test_client.get("/api/v1/changes")
    assert all(v == 0 for v in resp.json()["topics"].values())


async def test_a_bump_moves_exactly_one_topic(test_client: AsyncClient, registry):
    await registry.bump(change_topics.ANNOUNCEMENTS)

    topics = (await test_client.get("/api/v1/changes")).json()["topics"]

    assert topics[change_topics.ANNOUNCEMENTS] == 1
    assert topics[change_topics.FEATURES] == 0


async def test_topics_filter_narrows(test_client: AsyncClient, registry):
    resp = await test_client.get(
        f"/api/v1/changes?topics={change_topics.ANNOUNCEMENTS}"
    )
    assert resp.status_code == 200
    assert list(resp.json()["topics"]) == [change_topics.ANNOUNCEMENTS]


async def test_another_users_topic_cannot_be_requested(
    test_client: AsyncClient, registry
):
    """The filter can only shrink the set, never reach outside it.

    Asking for someone else's notification topic is not an error — it
    simply is not in the set this session may hear, so it falls out.
    Answering 403 here would confirm the topic exists, which is the only
    thing an attacker would learn.
    """
    victim = change_topics.notifications_for("usr_someone_else")

    resp = await test_client.get(f"/api/v1/changes?topics={victim}")

    assert resp.status_code == 200
    assert victim not in resp.json()["topics"]
    assert resp.json()["topics"] == {}


async def test_creating_an_announcement_moves_the_announcements_topic(
    test_client: AsyncClient, db_session, monkeypatch
):
    """The wiring, end to end: a real write reaches the real registry.

    The unit tests either side of this prove the registry counts and that
    a publish fires post-commit. This proves the two are connected at the
    call site — the failure mode being a bump site nobody ever added,
    which no amount of testing the machinery would catch.

    The explicit ``commit()`` stands in for the session dependency, which
    the test harness replaces with one that hands out its own transaction
    and never commits it (``conftest._override_get_db_session``). In
    production ``get_db_session`` commits in its teardown after the
    handler returns; here the test has to play that part, and it must,
    because "publishes on commit" is precisely what is under test.
    """
    from backend.app.changes import publish as publish_mod

    reg = InMemoryChangeRegistry()
    monkeypatch.setattr(publish_mod, "get_registry", lambda: reg)

    resp = await test_client.post(
        "/api/v1/admin/announcements",
        json={
            "title": "Scheduled maintenance",
            "message": "Back shortly.",
            "bannerType": "info",
            "isActive": True,
            "snoozeDurationMinutes": 0,
        },
    )
    assert resp.status_code == 201
    assert await reg.snapshot([change_topics.ANNOUNCEMENTS]) == {
        change_topics.ANNOUNCEMENTS: 0
    }, "announced before the commit"

    await db_session.commit()
    for _ in range(5):
        await asyncio.sleep(0)

    assert await reg.snapshot([change_topics.ANNOUNCEMENTS]) == {
        change_topics.ANNOUNCEMENTS: 1
    }, (
        "creating an announcement did not move the topic — the bump site "
        "is missing"
    )


async def test_registry_failure_is_503_not_a_manifest_of_zeros(
    test_client: AsyncClient, monkeypatch
):
    """Refuse rather than tell every client that everything changed."""

    class _Down:
        async def snapshot(self, topics):
            raise ConnectionError("redis is down")

    monkeypatch.setattr(changes_endpoint, "get_registry", lambda: _Down())

    resp = await test_client.get("/api/v1/changes")

    assert resp.status_code == 503
    assert resp.headers.get("Retry-After") == "5"


async def test_unavailable_claims_are_503_not_an_empty_answer(
    test_client: AsyncClient, registry, monkeypatch
):
    """"We could not find out" must not be served as "nothing changed".

    ``ws_available=False`` means no source could say what this session
    may see. Serving 200 with a partial manifest would present to the
    user as realtime quietly ceasing to work, with the client happily
    recording versions it was never entitled to trust.
    """
    from backend.app.auth.dependencies import get_permission_claims
    from backend.app.services.permission_service import PermissionClaims

    app = test_client._transport.app  # type: ignore[attr-defined]
    fixture_override = app.dependency_overrides[get_permission_claims]
    app.dependency_overrides[get_permission_claims] = lambda: PermissionClaims(
        sid="sess_test", global_perms=("system:admin",), ws_perms={},
        ws_available=False,
    )
    try:
        resp = await test_client.get("/api/v1/changes")
    finally:
        app.dependency_overrides[get_permission_claims] = fixture_override

    assert resp.status_code == 503


# ── A stream's lifetime, and the credential that opened it ────────────


def _lifetime_for(auth_method: str | None) -> float:
    """The ceiling the stream handler would pick for this caller.

    Mirrors the two lines in ``stream_changes`` rather than driving a real
    15-minute stream, which no suite can afford to wait out.
    """
    from backend.app.api.v1.endpoints import changes as c

    lifetime = c._MAX_STREAM_SECONDS
    if auth_method == "api_key":
        lifetime = min(lifetime, c._MAX_KEY_STREAM_SECONDS)
    return lifetime


def test_an_api_key_stream_ends_sooner_than_a_cookie_one():
    """A key is checked when the stream opens and never again.

    A cookie stream can afford fifteen minutes: the thing that goes stale
    is the access token, and a rotated token only means the client should
    reconnect. A key is different in kind — revoking it is how an operator
    stops a client, and a stream already running does not notice. So the
    window in which a REVOKED key keeps receiving events is exactly this
    ceiling, and the job stream next door already settled on 300s for the
    same reason ("a revoked key stops listening", aggregation.py).

    API keys landed on main while this branch was away;
    ``get_current_user`` accepts one and returns ``key.user``, so this
    endpoint inherited them silently.
    """
    from backend.app.api.v1.endpoints import changes as c

    assert _lifetime_for("api_key") == 300.0
    assert _lifetime_for(None) == c._MAX_STREAM_SECONDS
    assert _lifetime_for("api_key") < _lifetime_for(None)


def test_the_two_stream_ceilings_agree_on_a_key():
    """One answer, not two. If the job stream's bound moves, this should
    move with it rather than quietly becoming the looser of the pair."""
    from backend.app.api.v1.endpoints import aggregation, changes

    assert changes._MAX_KEY_STREAM_SECONDS == float(aggregation._KEY_STREAM_SECONDS)


def test_lowering_the_general_ceiling_still_binds_a_key(monkeypatch):
    """``min()``, not a branch: an operator who shortens every stream must
    not accidentally lengthen the key one."""
    from backend.app.api.v1.endpoints import changes as c

    monkeypatch.setattr(c, "_MAX_STREAM_SECONDS", 60.0)
    assert _lifetime_for("api_key") == 60.0
