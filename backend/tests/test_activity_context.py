"""The request's activity context: which request, and the reason a person gave.

Pins the capture half of the activity ledger:

* the ``X-Activity-Reason`` header is decoded, cleaned and bounded, and an
  absent or empty one is recorded as absent rather than invented;
* the context reaches the endpoint AND tasks it starts, and never outlives
  the request — a reason from one request must not attach itself to the next;
* the two outbox writers merge it under their own keys, never overwriting the
  ``reason`` (a failure reason) or ``request_id`` (an access-request id) that
  existing payloads already use;
* the recorder writes the canonical envelope, and ``record=False`` writes
  nothing.
"""
from __future__ import annotations

import asyncio
import json
from urllib.parse import quote

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from backend.app.common import activity_context
from backend.app.common.activity_context import (
    MAX_REASON_CHARS,
    ActivityContext,
    Provenance,
    clean_reason,
    parse_stated_reason,
    provenance_for,
    valid_correlation_id,
)
from backend.app.db.models import OutboxEventORM
from backend.app.db.repositories import outbox_event_repo, user_repo
from backend.app.middleware.request_id import REQUEST_ID_HEADER, RequestIdMiddleware
from backend.app.services.activity import recorder


# ── Parsing ──────────────────────────────────────────────────────────


def test_a_percent_encoded_reason_is_decoded():
    assert parse_stated_reason(quote("Upstream load finished — rerun")) == (
        "Upstream load finished — rerun"
    )


def test_absent_or_blank_reasons_are_none():
    assert parse_stated_reason(None) is None
    assert parse_stated_reason("") is None
    assert parse_stated_reason(quote("   \t\n ")) is None
    assert clean_reason(42) is None


def test_control_and_format_characters_are_stripped():
    # A bidi override would let a record read as something it does not say.
    raw = "fix‮evil\x00 \x1b[31mred​"
    assert clean_reason(raw) == "fix evil [31mred"


def test_whitespace_collapses_and_the_reason_is_capped():
    assert clean_reason("a \n\n  b\t c") == "a b c"
    long = "x" * (MAX_REASON_CHARS + 50)
    assert len(clean_reason(long)) == MAX_REASON_CHARS
    assert len(parse_stated_reason(quote(long))) == MAX_REASON_CHARS


def test_only_well_formed_correlation_ids_are_kept():
    assert valid_correlation_id("req_abc123") == "req_abc123"
    assert valid_correlation_id("my-custom-id.1:2") == "my-custom-id.1:2"
    assert valid_correlation_id("has space") is None
    assert valid_correlation_id("x" * 129) is None
    assert valid_correlation_id("<script>") is None
    assert valid_correlation_id(None) is None


# ── Propagation through the middleware ───────────────────────────────


def _app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(RequestIdMiddleware)

    @app.get("/ctx")
    async def ctx():
        here = activity_context.current()

        async def child():
            return activity_context.current()

        spawned = await asyncio.create_task(child())
        return {
            "correlation": here.correlation_id,
            "reason": here.stated_reason,
            "childReason": spawned.stated_reason,
        }

    return app


async def _get(app: FastAPI, headers: dict | None = None):
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://testserver") as c:
        return await c.get("/ctx", headers=headers or {})


async def test_the_endpoint_and_its_child_tasks_see_the_reason():
    res = await _get(_app(), {
        activity_context.REASON_HEADER: quote("Nightly load re-run"),
        REQUEST_ID_HEADER: "req_fromclient1",
    })
    body = res.json()
    assert body["reason"] == "Nightly load re-run"
    assert body["childReason"] == "Nightly load re-run"
    assert body["correlation"] == "req_fromclient1"
    assert res.headers[REQUEST_ID_HEADER] == "req_fromclient1"


async def test_a_reason_never_leaks_into_the_next_request():
    app = _app()
    await _get(app, {activity_context.REASON_HEADER: "first"})
    body = (await _get(app)).json()
    assert body["reason"] is None
    assert activity_context.current() == ActivityContext()


async def test_a_malformed_client_request_id_is_replaced():
    res = await _get(_app(), {REQUEST_ID_HEADER: "not ok; drop table"})
    generated = res.headers[REQUEST_ID_HEADER]
    assert generated.startswith("req_")
    assert res.json()["correlation"] == generated


def test_provenance_for_reads_the_bound_context():
    class _User:
        id = "usr_abc"

    token = activity_context.bind(ActivityContext("req_1", "why not"))
    try:
        prov = provenance_for(_User())
    finally:
        activity_context.reset(token)
    assert prov == Provenance(actor_id="usr_abc", stated_reason="why not", correlation_id="req_1")
    assert prov.without_recording().record is False


# ── The two outbox writers ───────────────────────────────────────────


async def _only_payload(db_session) -> dict:
    row = (await db_session.execute(select(OutboxEventORM))).scalars().one()
    return json.loads(row.payload)


async def test_create_outbox_event_merges_the_context(db_session):
    token = activity_context.bind(ActivityContext("req_42", "joining the data team"))
    try:
        await user_repo.create_outbox_event(
            db_session, "rbac.group.member_added",
            {"group_id": "grp_1", "user_id": "usr_2", "actor_id": "usr_1"},
        )
    finally:
        activity_context.reset(token)
    payload = await _only_payload(db_session)
    assert payload["stated_reason"] == "joining the data team"
    assert payload["correlation_id"] == "req_42"
    assert payload["group_id"] == "grp_1"


async def test_existing_reason_and_request_id_keys_are_never_touched(db_session):
    token = activity_context.bind(ActivityContext("req_42", "a person's why"))
    try:
        await user_repo.create_outbox_event(
            db_session, "rbac.access_request.approved",
            {"request_id": "ar_123", "reason": "bad_password"},
        )
    finally:
        activity_context.reset(token)
    payload = await _only_payload(db_session)
    assert payload["request_id"] == "ar_123"
    assert payload["reason"] == "bad_password"
    assert payload["stated_reason"] == "a person's why"


async def test_an_emitter_that_sets_the_key_wins(db_session):
    token = activity_context.bind(ActivityContext("req_42", "from the header"))
    try:
        await outbox_event_repo.emit(
            db_session, event_type="aggregation.job.triggered", aggregate_id="ds_1",
            payload={"stated_reason": "forwarded by the control plane"},
        )
        await db_session.flush()
    finally:
        activity_context.reset(token)
    payload = await _only_payload(db_session)
    assert payload["stated_reason"] == "forwarded by the control plane"
    assert payload["correlation_id"] == "req_42"


async def test_no_context_adds_nothing(db_session):
    await user_repo.create_outbox_event(db_session, "user.logged_in", {"user_id": "usr_1"})
    assert await _only_payload(db_session) == {"user_id": "usr_1"}


# ── The recorder ─────────────────────────────────────────────────────


async def test_the_recorder_writes_the_canonical_envelope(db_session):
    await recorder.record_activity(
        db_session,
        event_type="aggregation.job.triggered",
        provenance=Provenance("usr_9", "upstream fixed", "req_7"),
        workspace_id="ws_1", data_source_id="ds_1",
        target_type="data_source", target_id="ds_1", target_label="Sales lineage",
        details={"jobId": "agg_1"},
    )
    await db_session.flush()
    row = (await db_session.execute(select(OutboxEventORM))).scalars().one()
    assert row.event_version == recorder.ENVELOPE_VERSION
    assert row.aggregate_id == "ds_1"
    assert json.loads(row.payload) == {
        "actor_id": "usr_9", "workspace_id": "ws_1", "data_source_id": "ds_1",
        "target_type": "data_source", "target_id": "ds_1",
        "target_label": "Sales lineage", "stated_reason": "upstream fixed",
        "correlation_id": "req_7", "details": {"jobId": "agg_1"},
    }


async def test_record_false_writes_nothing(db_session):
    await recorder.record_activity(
        db_session, event_type="aggregation.job.triggered",
        provenance=Provenance("usr_9").without_recording(), target_id="ds_1",
    )
    await db_session.flush()
    assert (await db_session.execute(select(OutboxEventORM))).first() is None


async def test_best_effort_swallows_a_failed_write(db_session, monkeypatch):
    async def _boom(*_a, **_k):
        raise RuntimeError("outbox unavailable")

    monkeypatch.setattr(outbox_event_repo, "emit", _boom)
    await recorder.record_activity(
        db_session, event_type="workspace.versioning.enabled",
        provenance=Provenance("usr_9"), target_id="ds_1", best_effort=True,
    )
    with pytest.raises(RuntimeError):
        await recorder.record_activity(
            db_session, event_type="workspace.versioning.enabled",
            provenance=Provenance("usr_9"), target_id="ds_1",
        )


# ── Who is acting: every way of signing in names them ─────────────────


async def test_a_route_that_may_be_anonymous_still_names_who_signed_in(monkeypatch):
    """``get_optional_user`` is a sign-in like ``get_current_user``: what the
    request records is that person's. A route signing in only through it
    recorded its activity with nobody's name on it. A request with no live
    session is no one."""
    from starlette.requests import Request

    from backend.app.auth import dependencies as deps
    from backend.app.services.permission_service import PermissionClaims
    from backend.app.services.revocation_service import InMemoryBackend, RevocationService
    from backend.auth_service.cookies import ACCESS_COOKIE_NAME
    from backend.auth_service.core.tokens import create_access_token
    from backend.auth_service.interface import User

    class _Identity:
        async def validate_session(self, token):
            return User(id="usr_optional", email="o@p.q", first_name="O", last_name="P",
                        role="user", status="active") if token else None

    monkeypatch.setattr(deps, "_identity_service", lambda request: _Identity())
    monkeypatch.setattr(deps, "get_revocation_service", lambda: RevocationService(InMemoryBackend()))

    def _request(cookie: str) -> Request:
        return Request({
            "type": "http", "method": "GET", "path": "/api/v1/views",
            "headers": [(b"cookie", cookie.encode())] if cookie else [],
            "query_string": b"", "client": ("10.0.0.1", 1234),
        })

    async def _acting_as(cookie: str):
        # A task of its own, as each request is: nothing it binds leaks here.
        await deps.get_optional_user(_request(cookie))
        return activity_context.current_provenance()

    token = create_access_token(
        "usr_optional", "o@p.q", "user",
        extra=PermissionClaims(sid="sess_optional").to_jwt_dict(),
    )
    signed_in = await asyncio.create_task(_acting_as(f"{ACCESS_COOKIE_NAME}={token}"))
    assert signed_in is not None and signed_in.actor_id == "usr_optional"
    assert await asyncio.create_task(_acting_as("")) is None
