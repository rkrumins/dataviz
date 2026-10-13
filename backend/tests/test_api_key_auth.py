"""API keys on the wire: authenticated as their owner, held to what they cover.

Runs through the real auth dependencies — no override of ``get_current_user``
or ``get_permission_claims`` anywhere in this file — and a client that carries
no CSRF cookie, so the middleware runs as it does for a script. The world and
the client live in ``tests/common/api_key_world.py``.
"""
from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.exc import OperationalError

from backend.app.auth import api_key_auth
from backend.app.db.models import (
    ApiKeyORM,
    NotificationORM,
    OutboxEventORM,
    RoleBindingORM,
    UserIdentityORM,
    UserORM,
)
from backend.app.db.repositories import api_key_repo
from backend.app.services import api_key_service, api_key_usage
from backend.app.services.aggregation.models import AggregationJobORM
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.revocation_service import get_revocation_service
from backend.auth_service.cookies import ACCESS_COOKIE_NAME
from backend.auth_service.core import api_keys
from backend.auth_service.core.tokens import create_access_token
from tests.common.api_key_world import (
    OTHER,
    OWNER,
    api_key_app,
    days_ago,
    error,
    mint,
    prime,
    user_row,
)


@pytest.fixture()
async def client(db_session, monkeypatch):
    async with api_key_app(db_session, monkeypatch) as http:
        yield http


# ── Acting as the owner ─────────────────────────────────────────────


async def test_a_key_acts_as_its_owner(client, db_session):
    key = await mint(db_session, views="read")
    response = await client.get("/api/v1/views/v_a_mine", headers=key.headers)
    assert response.status_code == 200, response.text
    assert response.json()["id"] == "v_a_mine"


async def test_a_key_writes_without_csrf_and_the_change_names_the_key(client, db_session):
    key = await mint(db_session, views="write")
    response = await client.put(
        "/api/v1/views/v_a_mine", json={"name": "Renamed by a script"}, headers=key.headers,
    )
    assert response.status_code == 200, response.text
    events = (await db_session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type.like("visualization.view.%"))
    )).scalars().all()
    assert events, "the edit should be on the record"
    assert {json.loads(e.payload).get("api_key_id") for e in events} == {key.id}


async def test_a_key_request_never_rides_a_browser_session(client, db_session):
    """Cookies are dropped from a key request: someone else's session riding
    along neither widens it nor is touched by it."""
    other = create_access_token(
        user_id=OTHER, email=f"{OTHER}@example.com", role="workspace_member",
        extra={"sid": "sess_other"},
    )
    key = await mint(db_session, views="read")
    cookies = {ACCESS_COOKIE_NAME: other}

    # The other person's own private view: their session would open it.
    theirs = await client.get("/api/v1/views/v_a_theirs", headers=key.headers, cookies=cookies)
    assert theirs.status_code in (403, 404)

    # A route that reads the session cookie itself: the cookie alone signs
    # the other person in, and beside a key it is simply not there.
    alone = await client.get("/api/v1/auth/me", cookies=cookies)
    assert alone.status_code == 200 and OTHER in alone.text
    me = await client.get("/api/v1/auth/me", headers=key.headers, cookies=cookies)
    assert me.status_code == 401 and OTHER not in me.text


async def test_a_key_write_from_a_foreign_page_is_refused(client, db_session):
    key = await mint(db_session, views="write")
    response = await client.put(
        "/api/v1/views/v_a_mine", json={"name": "x"},
        headers={**key.headers, "Origin": "https://evil.example"},
    )
    assert response.status_code == 403
    assert error(response) == "csrf_failed"


# ── Refused keys ────────────────────────────────────────────────────


async def _refused(client, headers, code):
    response = await client.get("/api/v1/views/v_a_mine", headers=headers)
    assert response.status_code == 401, response.text
    assert error(response) == code
    assert 'error="invalid_token"' in response.headers["www-authenticate"]
    return response


async def test_a_malformed_or_unknown_key_is_refused(client):
    await _refused(client, {"Authorization": "Bearer nxpat_nonsense"}, "invalid_api_key")
    stranger = api_keys.generate().token
    await _refused(client, {"Authorization": f"Bearer {stranger}"}, "invalid_api_key")


async def test_an_invalid_key_is_refused_even_where_anonymous_is_fine(client):
    """``GET /views/{id}`` serves anonymous callers; a bad key is still a 401,
    never a quiet fall back to anonymous."""
    stranger = api_keys.generate().token
    response = await client.get(
        "/api/v1/views/v_a_ws", headers={"Authorization": f"Bearer {stranger}"},
    )
    assert response.status_code == 401


async def test_revoked_and_expired_keys_are_refused(client, db_session):
    revoked = await mint(db_session, views="read")
    await api_key_repo.revoke(db_session, revoked.id, by=OWNER, reason="owner")
    await db_session.commit()
    await _refused(client, revoked.headers, "api_key_revoked")

    expired = await mint(db_session, views="read", expires_at=days_ago(1))
    await _refused(client, expired.headers, "api_key_expired")


async def test_the_maximum_lifetime_applies_to_keys_that_already_exist(client, db_session):
    key = await mint(db_session, views="read")
    (await db_session.get(ApiKeyORM, key.id)).created_at = days_ago(40)
    await db_session.commit()
    assert (await client.get("/api/v1/views/v_a_mine", headers=key.headers)).status_code == 200
    prime(apiKeyMaxLifetime="30")
    await _refused(client, key.headers, "api_key_expired")


async def test_a_suspended_owners_keys_stop_at_once(client, db_session):
    key = await mint(db_session, views="read")
    (await db_session.get(UserORM, OWNER)).status = "suspended"
    await db_session.commit()
    await _refused(client, key.headers, "api_key_owner_inactive")


async def test_an_sso_owner_who_stops_signing_in_has_their_keys_paused(client, db_session):
    db_session.add(user_row("usr_sso", password=False))
    db_session.add(RoleBindingORM(
        subject_type="user", subject_id="usr_sso", role_name="workspace_member",
        scope_type="workspace", scope_id="ws_a",
    ))
    identity = UserIdentityORM(
        user_id="usr_sso", provider_id="idp_corp", external_id="sub-1",
        last_login_at=days_ago(40),
    )
    db_session.add(identity)
    await db_session.commit()
    key = await mint(db_session, "usr_sso", views="read")

    await _refused(client, key.headers, "owner_reauth_required")

    # Signing in again resumes the key; nothing was revoked.
    identity.last_login_at = days_ago(1)
    await db_session.commit()
    assert (await client.get("/api/v1/views/v_a_ws", headers=key.headers)).status_code == 200

    # And the window is the admin's to choose.
    identity.last_login_at = days_ago(40)
    await db_session.commit()
    prime(apiKeySsoSignInWindow="off")
    assert (await client.get("/api/v1/views/v_a_ws", headers=key.headers)).status_code == 200


async def test_an_owner_nobody_can_sign_in_as_has_no_working_keys(client, db_session):
    db_session.add(user_row("usr_nobody", password=False))
    await db_session.commit()
    key = await mint(db_session, "usr_nobody", views="read")
    await _refused(client, key.headers, "owner_reauth_required")


async def test_a_key_limited_to_networks_is_refused_elsewhere(client, db_session):
    # The test transport connects from 127.0.0.1.
    outside = await mint(db_session, views="read", allowed_cidrs=["10.0.0.0/8"])
    await _refused(client, outside.headers, "api_key_ip_not_allowed")
    inside = await mint(db_session, views="read", allowed_cidrs=["127.0.0.0/8"])
    assert (await client.get("/api/v1/views/v_a_mine", headers=inside.headers)).status_code == 200


async def test_a_key_outside_its_networks_is_on_the_record_even_asking_about_itself(
    client, db_session,
):
    """A key may describe or end itself from anywhere — but presented from
    outside its networks it is in someone else's hands, whatever it asks."""
    key = await mint(db_session, views="read", allowed_cidrs=["10.0.0.0/8"])
    described = await client.get("/api/v1/api-keys/self", headers=key.headers)
    assert described.status_code == 200 and described.json()["status"] == "ip_not_allowed"
    misuse = (await db_session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type == "identity.api_key.misuse")
    )).scalars().all()
    assert [json.loads(e.payload)["reason"] for e in misuse] == ["ip_not_allowed"]

    # And ending itself says where from.
    assert (await client.delete("/api/v1/api-keys/self", headers=key.headers)).status_code == 204
    revoked = (await db_session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type == "identity.api_key.revoked")
    )).scalars().one()
    assert json.loads(revoked.payload)["client_ip"] == "127.0.0.1"


async def test_a_dead_key_looping_never_locks_out_its_neighbours(client, db_session, monkeypatch):
    """Behind one NAT, an integration retrying a revoked key is charged to
    that key — not to the address the healthy integrations share. Keys
    nobody issued are what the address pays for."""
    monkeypatch.setattr(api_key_auth, "RATELIMIT_API_KEY_FAILURES_PER_IP", "2/minute")
    dead = await mint(db_session, views="read")
    await api_key_repo.revoke(db_session, dead.id, by=OWNER, reason="owner")
    await db_session.commit()
    healthy = await mint(db_session, views="read")

    for _ in range(3):
        await _refused(client, dead.headers, "api_key_revoked")
    assert (await client.get("/api/v1/views/v_a_mine", headers=healthy.headers)).status_code == 200

    for _ in range(2):
        stranger = api_keys.generate().token
        await _refused(client, {"Authorization": f"Bearer {stranger}"}, "invalid_api_key")
    guessing = await client.get("/api/v1/views/v_a_mine", headers=healthy.headers)
    assert guessing.status_code == 429


async def test_a_revoked_key_presented_again_is_misuse_recorded_once_and_told_to_its_owner(
    client, db_session,
):
    key = await mint(db_session, views="read")
    await api_key_repo.revoke(db_session, key.id, by=OWNER, reason="owner")
    await db_session.commit()
    for _ in range(3):
        await _refused(client, key.headers, "api_key_revoked")

    events = (await db_session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type == "identity.api_key.misuse")
    )).scalars().all()
    assert len(events) == 1, "sampled: one record per key, reason and hour"
    assert events[0].aggregate_type == "user" and events[0].aggregate_id == OWNER
    payload = json.loads(events[0].payload)
    assert payload["key_id"] == key.id and payload["reason"] == "revoked"
    assert key.token not in events[0].payload

    notes = (await db_session.execute(
        select(NotificationORM).where(NotificationORM.user_id == OWNER)
    )).scalars().all()
    assert [n.kind for n in notes] == ["api_key_misuse"]


async def test_a_lookup_that_cannot_answer_is_503_never_401(client, db_session, monkeypatch):
    key = await mint(db_session, views="read")

    async def _down(*_args, **_kwargs):
        raise OperationalError("SELECT", {}, Exception("connection refused"))

    monkeypatch.setattr(api_key_repo, "find_for_auth", _down)
    response = await client.get("/api/v1/views/v_a_mine", headers=key.headers)
    assert response.status_code == 503
    assert response.headers.get("retry-after")


async def test_switching_keys_off_stops_every_key(client, db_session):
    key = await mint(db_session, views="read")
    prime(apiKeysEnabled=False)
    await _refused(client, key.headers, "api_keys_disabled")


async def test_no_key_is_honoured_while_authorization_is_switched_off(
    client, db_session, monkeypatch,
):
    key = await mint(db_session, views="read")
    monkeypatch.setenv("RBAC_ENFORCE_VIEWS", "false")
    response = await client.get("/api/v1/views/v_a_mine", headers=key.headers)
    assert response.status_code == 503


# ── The surface ─────────────────────────────────────────────────────


async def test_endpoints_off_the_surface_are_refused(client, db_session):
    key = await mint(db_session, views="write", data="write")
    for path in ("/api/v1/users/me", "/api/v1/admin/users", "/api/v1/views/audience"):
        response = await client.get(path, headers=key.headers)
        assert response.status_code == 403, path
        assert error(response) == "api_key_not_allowed", path
        assert 'error="insufficient_scope"' in response.headers["www-authenticate"]


async def test_a_read_only_key_only_reads(client, db_session):
    key = await mint(db_session, views="read", data="read")
    response = await client.put("/api/v1/views/v_a_mine", json={"name": "x"}, headers=key.headers)
    assert response.status_code == 403
    assert error(response) == "api_key_read_only"
    create = await client.post(
        "/api/v1/ws_a/graph/nodes/create?dataSourceId=ds_a", json={}, headers=key.headers,
    )
    assert error(create) == "api_key_read_only"
    # A search is a POST that changes nothing: through every gate.
    search = await client.post(
        "/api/v1/ws_a/graph/search?dataSourceId=ds_a", json={"query": "orders"},
        headers=key.headers,
    )
    assert search.status_code == 418, search.text


# ── Views: honoured by every path, held to the selection ────────────


async def test_a_key_on_one_granted_view_edits_that_view_and_nothing_else(client, db_session):
    """A workspace viewer with an editor grant on one view: a key limited to
    that view edits it — and reaches nothing else in the workspace."""
    key = await mint(db_session, views="write", resources={"views": ["v_b_granted"]})

    assert (await client.get("/api/v1/views/v_b_granted", headers=key.headers)).status_code == 200
    edit = await client.put(
        "/api/v1/views/v_b_granted", json={"description": "kept current by CI"},
        headers=key.headers,
    )
    assert edit.status_code == 200, edit.text

    sibling = await client.get("/api/v1/views/v_b_other", headers=key.headers)
    assert sibling.status_code == 403 and error(sibling) == "api_key_out_of_scope"

    listed = await client.get("/api/v1/views/", headers=key.headers)
    assert listed.status_code == 200
    assert [v["id"] for v in listed.json()["items"]] == ["v_b_granted"]

    created = await client.post(
        "/api/v1/views/",
        json={"name": "new", "workspaceId": "ws_b", "viewType": "graph", "config": {}},
        headers=key.headers,
    )
    assert created.status_code == 403


async def test_the_workspace_feed_needs_the_whole_workspace(client, db_session):
    key = await mint(db_session, views="read", resources={"views": ["v_a_ws"]})
    response = await client.get("/api/v1/views/workspace/ws_a/activity", headers=key.headers)
    assert response.status_code == 403 and error(response) == "api_key_out_of_scope"


# ── Data: the capability gate, held to the selection ────────────────


async def test_a_key_on_one_data_source_must_name_it(client, db_session):
    key = await mint(db_session, data="read", resources={"dataSources": ["ds_a"]})

    ok = await client.get("/api/v1/ws_a/graph/stats?dataSourceId=ds_a", headers=key.headers)
    assert ok.status_code == 200, ok.text

    # The workspace's primary is not this key's to assume…
    unnamed = await client.get("/api/v1/ws_a/graph/stats", headers=key.headers)
    assert unnamed.status_code == 403 and error(unnamed) == "api_key_out_of_scope"

    # …and a sibling source in the same workspace stays closed, although the
    # owner's role reads it and the key's claims hold the workspace.
    sibling = await client.get("/api/v1/ws_a/graph/stats?dataSourceId=ds_a2", headers=key.headers)
    assert sibling.status_code == 403 and error(sibling) == "api_key_out_of_scope"


async def test_a_view_key_reads_its_views_data_and_only_that(client, db_session):
    key = await mint(db_session, views="read", resources={"views": ["v_a_ws"]})
    through = "/api/v1/ws_a/graph/stats?viewId=v_a_ws"

    assert (await client.get(f"{through}&dataSourceId=ds_a", headers=key.headers)).status_code == 200
    other = await client.get(f"{through}&dataSourceId=ds_a2", headers=key.headers)
    assert other.status_code == 403 and error(other) == "api_key_out_of_scope"


async def test_writing_data_needs_the_source_itself_not_a_view_of_it(client, db_session):
    key = await mint(
        db_session, views="read", data="write",
        resources={"views": ["v_a_ws"], "dataSources": ["ds_a2"]},
    )
    write = "/api/v1/ws_a/graph/nodes/create"
    # Through the view: refused, a view opens reads only.
    through_view = await client.post(
        f"{write}?viewId=v_a_ws&dataSourceId=ds_a", json={}, headers=key.headers,
    )
    assert through_view.status_code == 403 and error(through_view) == "api_key_out_of_scope"
    # On the source the key covers: through every gate to the handler.
    covered = await client.post(f"{write}?dataSourceId=ds_a2", json={}, headers=key.headers)
    assert covered.status_code == 418, covered.text


async def test_a_resource_named_against_the_wrong_workspace_is_not_found(client, db_session):
    key = await mint(db_session, views="read", data="read")
    response = await client.get("/api/v1/ws_b/graph/stats?dataSourceId=ds_a", headers=key.headers)
    assert response.status_code == 404


async def test_a_graph_is_held_to_the_key_by_its_data_source(client, db_session):
    key = await mint(db_session, data="read", resources={"dataSources": ["ds_a"]})
    mine = await client.get("/api/v1/ws_a/versioning/graphs/g_a", headers=key.headers)
    assert mine.status_code == 200, mine.text
    sibling = await client.get("/api/v1/ws_a/versioning/graphs/g_a2", headers=key.headers)
    assert sibling.status_code == 403 and error(sibling) == "api_key_out_of_scope"


async def test_a_view_never_opens_the_routes_about_its_data_source(client, db_session):
    """A view opens reads of the data it renders, named with
    ``dataSourceId`` — not the routes about that source itself (its
    readiness, jobs, pull requests), which name it in the path."""
    key = await mint(
        db_session, views="read", data="read",
        resources={"views": ["v_a_ws"], "dataSources": ["ds_a2"]},
    )
    for path in (
        "/api/v1/admin/data-sources/ds_a/readiness?viewId=v_a_ws",
        "/api/v1/admin/data-sources/ds_a/aggregation-jobs?viewId=v_a_ws",
        "/api/v1/ws_a/versioning/data-sources/ds_a/pull-requests?viewId=v_a_ws",
    ):
        response = await client.get(path, headers=key.headers)
        assert response.status_code == 403, (path, response.text)
        assert error(response) == "api_key_out_of_scope", path
    covered = await client.get(
        "/api/v1/ws_a/versioning/data-sources/ds_a2/pull-requests", headers=key.headers,
    )
    assert covered.status_code == 418, covered.text


async def test_a_forks_pull_request_needs_the_parents_data_source_too(client, db_session):
    """A fork's pull request lands in its parent graph (g_fork renders ds_a;
    its parent g_a2 renders ds_a2)."""
    pulls = "/api/v1/ws_a/versioning/graphs/g_fork/pulls"
    fork_only = await mint(db_session, data="write", resources={"dataSources": ["ds_a"]})
    refused = await client.post(pulls, json={}, headers=fork_only.headers)
    assert refused.status_code == 403 and error(refused) == "api_key_out_of_scope"

    both = await mint(db_session, data="write", resources={"dataSources": ["ds_a", "ds_a2"]})
    assert (await client.post(pulls, json={}, headers=both.headers)).status_code == 418


async def test_a_draft_is_reached_through_its_own_graph_only(client, db_session):
    """Naming a graph the key covers does not open a draft of another graph."""
    key = await mint(db_session, data="read", resources={"dataSources": ["ds_a"]})
    graph = "/api/v1/ws_a/versioning/graphs/g_a/branches"
    for route in ("merge-preview", "view-changes"):
        elsewhere = await client.get(f"{graph}/br_a2/{route}", headers=key.headers)
        assert elsewhere.status_code == 404, (route, elsewhere.text)
    assert (await client.get(f"{graph}/br_a/merge-preview", headers=key.headers)).status_code == 418
    assert (await client.get(f"{graph}/br_a/view-changes", headers=key.headers)).status_code == 200


async def test_a_job_stream_is_held_to_its_source_and_a_keys_stream_ends(
    client, db_session, monkeypatch,
):
    from backend.app import jobs
    from backend.app.api.v1.endpoints import aggregation

    db_session.add(AggregationJobORM(id="agg_a", data_source_id="ds_a"))
    db_session.add(AggregationJobORM(id="agg_a2", data_source_id="ds_a2"))
    await db_session.commit()

    class _Silent:
        """A job that never says anything again."""

        def stream(self, _scope, _from_seq):
            return self._forever()

        async def _forever(self):
            await asyncio.Event().wait()
            yield  # pragma: no cover — never reached

    monkeypatch.setattr(jobs, "get_consumer", lambda: _Silent())
    monkeypatch.setattr(aggregation, "_KEY_STREAM_SECONDS", 0.05)
    key = await mint(db_session, data="read", resources={"dataSources": ["ds_a"]})
    events = "/api/v1/admin/data-sources/ds_a/aggregation-jobs/{}/events"

    # Another source's job, named under the source the key covers.
    smuggled = await client.get(events.format("agg_a2"), headers=key.headers)
    assert smuggled.status_code == 404, smuggled.text
    # Its own job streams — and a key's stream ends by itself, so the client
    # reconnects and the key is checked again.
    own = await asyncio.wait_for(client.get(events.format("agg_a"), headers=key.headers), 10)
    assert own.status_code == 200 and own.headers["content-type"].startswith("text/event-stream")


async def test_an_org_wide_owners_key_over_everything_lists_every_workspace(client, db_session):
    """Its claims hold the owner's organisation-wide reach as a shortcut,
    not a list of every workspace — so the workspace list must not be read
    from that list alone."""
    from backend.app.db.models import WorkspaceORM

    db_session.add(WorkspaceORM(id="ws_c", name="ws_c"))
    db_session.add(RoleBindingORM(
        subject_type="user", subject_id=OWNER, role_name="super_admin",
        scope_type="global", scope_id=None,
    ))
    await db_session.commit()
    everything = await mint(db_session, views="read", data="read")
    listed = await client.get("/api/v1/admin/workspaces", headers=everything.headers)
    assert listed.status_code == 200, listed.text
    assert {"ws_a", "ws_b", "ws_c"} <= {w["id"] for w in listed.json()}
    unbound = await client.get("/api/v1/admin/workspaces/ws_c", headers=everything.headers)
    assert unbound.status_code == 200, unbound.text

    # A key on a selection lists only what it covers, whoever its owner is.
    one = await mint(db_session, views="read", data="read", resources={"workspaces": ["ws_a"]})
    listed = await client.get("/api/v1/admin/workspaces", headers=one.headers)
    assert [w["id"] for w in listed.json()] == ["ws_a"]
    assert (await client.get("/api/v1/admin/workspaces/ws_c", headers=one.headers)).status_code in (403, 404)


# ── A key's claims follow its owner ─────────────────────────────────


async def test_losing_a_role_reaches_the_key_within_the_claims_window(client, db_session):
    key = await mint(db_session, views="read")
    assert (await client.get("/api/v1/views/v_a_ws", headers=key.headers)).status_code == 200

    await db_session.execute(delete(RoleBindingORM).where(
        RoleBindingORM.subject_id == OWNER, RoleBindingORM.scope_id == "ws_a",
    ))
    await db_session.commit()
    # Within the window the cached claims still answer: the documented bound
    # (``CLAIMS_TTL_SECONDS``), not touching the owner's sessions at all…
    assert (await client.get("/api/v1/views/v_a_ws", headers=key.headers)).status_code == 200
    # …and once it has passed, the key has lost the role with its owner.
    for key_id, entry in list(api_key_service._claims_cache.items()):
        api_key_service._claims_cache[key_id] = dataclasses.replace(entry, expires_at=0.0)
    assert (await client.get("/api/v1/views/v_a_ws", headers=key.headers)).status_code in (403, 404)


async def test_a_busy_key_never_touches_its_owners_sessions(client, db_session, monkeypatch):
    """The claims cache used to register itself as a session of the owner,
    which kept the owner's session index alive — and growing — for as long
    as a key was busy."""
    recorded = []
    monkeypatch.setattr(
        get_revocation_service(), "record_session",
        lambda *a, **kw: recorded.append(a) or _noop(),
    )
    key = await mint(db_session, views="read")
    for _ in range(3):
        assert (await client.get("/api/v1/views/v_a_mine", headers=key.headers)).status_code == 200
    assert recorded == []


async def _noop():
    return None


async def test_keys_arriving_together_resolve_their_claims_once(db_session, monkeypatch):
    calls = []
    release = asyncio.Event()

    async def slow_resolve(session, user_id, scope):
        calls.append(scope.key_id)
        await release.wait()
        return PermissionClaims(sid="", global_perms=(), ws_perms={}, key_scope=scope)

    monkeypatch.setattr(api_key_service.permission_service, "resolve_for_api_key", slow_resolve)
    api_key_service.reset_for_tests()
    row = ApiKeyORM(
        id="apk_flight", user_id=OWNER, kind="personal", name="n", token_prefix="p",
        token_hash="h", permissions='{"views":"read"}', resources='"all"',
    )
    waiters = [
        asyncio.create_task(api_key_service.claims_for_key(db_session, row)) for _ in range(5)
    ]
    await asyncio.sleep(0)
    release.set()
    results = await asyncio.gather(*waiters)
    assert calls == ["apk_flight"]
    assert all(r is results[0] for r in results)
    api_key_service.reset_for_tests()


# ── Limits, records, headers ────────────────────────────────────────


async def test_a_key_has_its_own_rate_limit(client, db_session, monkeypatch):
    monkeypatch.setattr(api_key_auth, "RATELIMIT_API_KEY", "2/minute")
    key = await mint(db_session, views="read")
    for _ in range(2):
        assert (await client.get("/api/v1/views/v_a_mine", headers=key.headers)).status_code == 200
    limited = await client.get("/api/v1/views/v_a_mine", headers=key.headers)
    assert limited.status_code == 429
    assert int(limited.headers["retry-after"]) >= 1
    # Another key is not held back by this one.
    other = await mint(db_session, views="read")
    assert (await client.get("/api/v1/views/v_a_mine", headers=other.headers)).status_code == 200


async def test_the_access_log_names_the_key_and_never_the_token(client, db_session, caplog):
    key = await mint(db_session, views="read")
    with caplog.at_level(logging.INFO):
        response = await client.get("/api/v1/views/v_a_mine", headers=key.headers)
    assert response.status_code == 200
    access = [r for r in caplog.records if r.name == "synodic.access"]
    assert access and access[-1].authMethod == "api_key"
    assert access[-1].apiKeyId == key.id and access[-1].userId == OWNER
    for record in caplog.records:
        assert key.token not in record.getMessage()
        assert key.token not in json.dumps(record.__dict__, default=str)


async def test_a_client_can_see_its_keys_expiry_coming(client, db_session):
    expires = (datetime.now(timezone.utc) + timedelta(days=10)).isoformat()
    key = await mint(db_session, views="read", expires_at=expires)
    response = await client.get("/api/v1/views/v_a_mine", headers=key.headers)
    assert response.headers["x-api-key-expires-at"] == expires


async def test_use_is_stamped_on_the_key_not_on_the_person(client, db_session):
    key = await mint(db_session, views="read")
    assert (await client.get("/api/v1/views/v_a_mine", headers=key.headers)).status_code == 200
    row = await db_session.get(ApiKeyORM, key.id)
    await db_session.refresh(row)
    assert row.last_used_at and row.last_used_ip == "127.0.0.1"
    owner = await db_session.get(UserORM, OWNER)
    await db_session.refresh(owner)
    assert owner.last_seen_at is None


async def test_every_request_a_key_makes_is_counted_by_what_became_of_it(client, db_session):
    from backend.app.api.v1.endpoints import graph as graph_endpoints
    from backend.app.main import app

    key = await mint(db_session, views="write", data="read")
    assert (await client.get("/api/v1/views/v_a_mine", headers=key.headers)).status_code == 200
    wrote = await client.put("/api/v1/views/v_a_mine", json={"name": "x"}, headers=key.headers)
    assert wrote.status_code == 200
    assert (await client.get("/api/v1/views/v_gone", headers=key.headers)).status_code == 404
    assert (await client.get("/api/v1/users/me", headers=key.headers)).status_code == 403

    def _explode():
        raise RuntimeError("the handler fell over")

    app.dependency_overrides[graph_endpoints.get_context_engine] = _explode
    raised = await client.post(
        "/api/v1/ws_a/graph/search?dataSourceId=ds_a", json={"query": "x"}, headers=key.headers,
    )
    assert raised.status_code == 500

    # Neither a key nobody issued nor a request without one is anyone's usage.
    stranger = api_keys.generate().token
    await client.get("/api/v1/views/v_a_mine", headers={"Authorization": f"Bearer {stranger}"})
    await client.get("/api/v1/views/v_a_ws")

    # A key that has stopped still counts what calls it — how its owner
    # learns something still depends on it.
    expired = await mint(db_session, views="read", expires_at=days_ago(1))
    assert (await client.get("/api/v1/views/v_a_mine", headers=expired.headers)).status_code == 401

    today = datetime.now(timezone.utc).date().isoformat()
    # requests, writes, refused, errors
    assert api_key_usage.recorder._pending == {
        (key.id, today): [5, 1, 1, 2], (expired.id, today): [1, 0, 1, 0],
    }


# ── Imports that name a view ────────────────────────────────────────


async def test_an_import_may_only_name_a_view_the_caller_can_edit(client, db_session):
    """Pre-existing, for people too: an import's ``viewId`` has the worker
    write into that view's layout, and the view was never checked."""
    imports = "/api/v1/ws_a/versioning/graphs/g_a/imports"
    # May change data, not views: an import may not rewrite a view for it.
    data_only = await mint(db_session, views="read", data="write")
    refused = await client.post(f"{imports}?viewId=v_a_mine", content=b"", headers=data_only.headers)
    assert refused.status_code == 403, refused.text

    full = await mint(db_session, views="write", data="write")
    elsewhere = await client.post(f"{imports}?viewId=v_b_other", content=b"", headers=full.headers)
    assert elsewhere.status_code == 404
    mine = await client.post(f"{imports}?viewId=v_a_mine", content=b"", headers=full.headers)
    assert mine.status_code == 418, mine.text


async def test_the_import_view_check_holds_for_a_browser_session_too(client, db_session):
    from types import SimpleNamespace

    from backend.app.api.v1.endpoints.versioning import _check_import_view
    from backend.app.services.permission_service import resolve

    owner = SimpleNamespace(id=OWNER)
    claims = await resolve(db_session, OWNER)
    with pytest.raises(HTTPException) as other_workspace:
        await _check_import_view(db_session, "ws_a", "v_b_other", owner, claims)
    assert other_workspace.value.status_code == 404
    # Only a viewer in ws_b, with no grant on this view.
    with pytest.raises(HTTPException) as not_editable:
        await _check_import_view(db_session, "ws_b", "v_b_other", owner, claims)
    assert not_editable.value.status_code == 403
    # An editor grant is enough.
    await _check_import_view(db_session, "ws_b", "v_b_granted", owner, claims)


def test_single_flight_never_shares_a_keys_answer_with_its_owners_session():
    from types import SimpleNamespace

    from backend.app.api.v1.endpoints.views import _flight_principal
    from backend.app.services.permission_service import PermissionClaims, key_scope_from_profile

    user = SimpleNamespace(id=OWNER)
    session_claims = PermissionClaims(sid="s1", global_perms=(), ws_perms={})
    key_claims = PermissionClaims(
        sid="", global_perms=(), ws_perms={},
        key_scope=key_scope_from_profile(
            "apk_1", kind="personal", permissions={"views": "read"}, resources="all",
        ),
    )
    assert _flight_principal(user, session_claims) != _flight_principal(user, key_claims)
