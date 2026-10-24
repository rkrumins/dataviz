"""POST /{ws}/graph/search/native — a person's own read-only Cypher, end to
end through the app against a fake engine.

Who may run one: a holder of ``workspace:native-query:read`` with data source
access (every reading role has it, ``workspace:admin`` implies it, auditors
reach it as a ``:read``), or someone a view was shared with by a share that
opts in — for that view's own data source only. Never with an API key or the
switch off (an unreadable switch is off), never on a draft.

What every run gets: the guard and row cap before the engine, a 429 past the
person's rate or the source's concurrency, a refusal in plain words with a
request id and never a host, one activity record per run that reached the
guard — and no rows at all when that record can't be written.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import time

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.auth.dependencies import get_current_user, get_optional_user, get_permission_claims
from backend.app.common import activity_context
from backend.app.db.models import (
    GroupMemberORM,
    GroupORM,
    OutboxEventORM,
    ProviderORM,
    ResourceGrantORM,
    UserORM,
    ViewORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.services.feature_flags import feature_flags
from backend.app.services.native_query import service as native_service
from backend.app.services.native_query.settings import get_native_query_settings
from backend.app.services.permission_service import _WORKSPACE_CATEGORY_LEAVES, PermissionClaims
from backend.auth_service.interface import User
from backend.common.adapters import ProviderUnavailable
from backend.common.interfaces.native_query import (
    NativeQueryResult,
    NativeQuerySyntaxError,
    NativeQueryTimeout,
    NativeQueryTooLarge,
    NativeQueryWriteRefused,
)

WS = "ws_native"
DS = "ds_native"
DS_OTHER = "ds_native_other"
VIEW = "view_native"
URL = f"/api/v1/{WS}/graph/search/native"
READS = ("workspace:datasource:read", "workspace:view:read")


def person(user_id: str) -> User:
    return User(id=user_id, email=f"{user_id}@example.com", first_name="T", last_name="U",
                role="user", status="active", created_at="2024-01-01T00:00:00Z",
                updated_at="2024-01-01T00:00:00Z")


def claims_with(*perms: str, global_perms=(), key_scope=None) -> PermissionClaims:
    return PermissionClaims(sid=f"s_{id(perms)}", global_perms=tuple(global_perms),
                            ws_perms={WS: tuple(perms)} if perms else {}, key_scope=key_scope)


READER = claims_with(*READS, "workspace:native-query:read")


@contextlib.contextmanager
def signed_in(user: User, claims: PermissionClaims):
    """As ``user`` holding ``claims`` — attributed, as the real sign-in is."""
    from backend.app.main import app

    async def _current():
        activity_context.bind_actor(user.id)
        return user

    def _claims():
        return claims

    saved = {dep: app.dependency_overrides.get(dep)
             for dep in (get_current_user, get_optional_user, get_permission_claims)}
    app.dependency_overrides[get_current_user] = _current
    app.dependency_overrides[get_optional_user] = _current
    app.dependency_overrides[get_permission_claims] = _claims
    try:
        yield
    finally:
        for dep, fn in saved.items():
            if fn is None:
                app.dependency_overrides.pop(dep, None)
            else:
                app.dependency_overrides[dep] = fn


class FakeEngine:
    """A provider that answers native queries as a test says."""

    native_query_engine = "falkordb"

    def __init__(self, answer=None):
        self.answer = answer or NativeQueryResult(columns=["x"], rows=[[1], [2], [3]])
        self.calls = []

    async def run_readonly_cypher(self, query, *, row_cap, timeout_ms, max_reply_bytes):
        self.calls.append({"query": query, "row_cap": row_cap, "timeout_ms": timeout_ms,
                           "max_reply_bytes": max_reply_bytes})
        if isinstance(self.answer, BaseException):
            raise self.answer
        if callable(self.answer):
            return await self.answer()
        return self.answer


@pytest.fixture
def engine(monkeypatch):
    from backend.app.providers.manager import provider_manager

    holder = {"engine": FakeEngine()}

    async def provider_for(workspace_id, session, data_source_id=None):
        holder["asked"] = data_source_id
        return holder["engine"]

    monkeypatch.setattr(provider_manager, "get_provider_for_workspace", provider_for)
    return holder


@pytest.fixture(autouse=True)
def switch_on():
    feature_flags._cache = {"nativeQueryEnabled": True}
    feature_flags._cache_ts = time.monotonic()
    get_native_query_settings.cache_clear()
    native_service._bulkheads.clear()
    yield
    feature_flags.invalidate()
    get_native_query_settings.cache_clear()


@pytest.fixture(autouse=True)
def unlimited(monkeypatch):
    class Limiter:
        allow = True

        async def consume(self, scope, identity, limit):
            return self.allow

        async def retry_after_seconds(self, scope, identity, limit, consumed=False):
            return 17

    limiter = Limiter()
    monkeypatch.setattr(native_service, "get_account_limiter", lambda: limiter)
    return limiter


@pytest.fixture
async def estate(db_session):
    db_session.add(WorkspaceORM(id=WS, name="Native"))
    db_session.add(ProviderORM(id="prov_native", name="Native prov", provider_type="falkordb"))
    for ds, primary in ((DS, True), (DS_OTHER, False)):
        db_session.add(WorkspaceDataSourceORM(
            id=ds, workspace_id=WS, provider_id="prov_native", label=f"{ds} label",
            graph_name=ds, is_primary=primary,
        ))
    db_session.add(ViewORM(id=VIEW, name="Shared", workspace_id=WS, data_source_id=DS,
                           visibility="private", created_by="usr_native_author"))
    db_session.add(ViewORM(id="view_native_ent", name="Everyone", workspace_id=WS,
                           data_source_id=DS, visibility="enterprise",
                           created_by="usr_native_author"))
    await db_session.commit()


def share(db_session, subject_id, *, subject_type="user", can_query_source=True, view=VIEW):
    db_session.add(ResourceGrantORM(resource_type="view", resource_id=view,
                                    subject_type=subject_type, subject_id=subject_id,
                                    role_name="viewer", can_query_source=can_query_source))


async def records(db_session):
    rows = (await db_session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type == native_service.EVENT)
    )).scalars().all()
    return [json.loads(r.payload) for r in rows]


async def run(client, query="MATCH (n) RETURN n.x AS x", params=None, **body):
    return await client.post(URL, params=params or {}, json={"query": query, **body})


# ── who may run one ─────────────────────────────────────────────────────


async def test_a_reader_runs_a_query_and_gets_typed_rows(test_client: AsyncClient, db_session,
                                                         estate, engine):
    with signed_in(person("usr_reader"), READER):
        r = await run(test_client, limit=2)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["engine"] == "falkordb" and body["columns"] == ["x"]
    assert body["rows"] == [[1], [2]] and body["rowCount"] == 2
    assert (body["truncated"], body["truncatedReason"], body["limitApplied"]) == (True, "rows", 2)
    assert body["executedQuery"] == "MATCH (n) RETURN n.x AS x LIMIT 3"
    assert body["requestId"] and len(body["queryHash"]) == 16
    assert engine["engine"].calls[0]["row_cap"] == 3
    assert engine["asked"] == DS                          # the workspace's primary


@pytest.mark.parametrize("claims", [
    # What the resolver gives a workspace admin: every leaf workspace:admin implies.
    claims_with(*sorted(_WORKSPACE_CATEGORY_LEAVES)),
    claims_with(global_perms=("system:org-viewer",)),      # an auditor: a :read
    claims_with(global_perms=("system:org-admin",)),
])
async def test_admins_and_auditors_may(test_client: AsyncClient, db_session, estate, engine, claims):
    with signed_in(person("usr_admin"), claims):
        r = await run(test_client)
    assert r.status_code == 200, r.text


async def test_without_the_permission_it_is_refused_and_says_what_to_ask_for(
        test_client: AsyncClient, db_session, estate, engine):
    with signed_in(person("usr_plain"), claims_with(*READS)):
        r = await run(test_client)
    assert r.status_code == 403
    detail = r.json()["detail"]
    assert detail["code"] == "missing_permission"
    assert detail["permission"] == "workspace:native-query:read"
    assert detail["requestId"]
    assert engine["engine"].calls == []
    assert await records(db_session) == []


async def test_a_share_that_opts_in_lets_its_holder_query_that_views_source(
        test_client: AsyncClient, db_session, estate, engine):
    share(db_session, "usr_guest")
    await db_session.commit()
    with signed_in(person("usr_guest"), claims_with()):
        r = await run(test_client, params={"viewId": VIEW, "dataSourceId": DS})
    assert r.status_code == 200, r.text
    (record,) = await records(db_session)
    assert record["details"]["via"] == "grant" and record["details"]["viewId"] == VIEW


async def test_a_group_share_that_opts_in_counts_too(test_client: AsyncClient, db_session,
                                                    estate, engine):
    db_session.add(UserORM(id="usr_grouped", email="g@example.com", password_hash="x",
                           first_name="G", last_name="M", status="active",
                           created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z"))
    db_session.add(GroupORM(id="grp_native", name="Analysts"))
    db_session.add(GroupMemberORM(group_id="grp_native", user_id="usr_grouped"))
    share(db_session, "grp_native", subject_type="group")
    await db_session.commit()
    with signed_in(person("usr_grouped"), claims_with()):
        r = await run(test_client, params={"viewId": VIEW, "dataSourceId": DS})
    assert r.status_code == 200, r.text


@pytest.mark.parametrize("case", ["no opt-in", "org-wide view", "another source"])
async def test_a_share_without_the_opt_in_or_for_another_source_does_not(
        test_client: AsyncClient, db_session, estate, engine, case):
    if case == "no opt-in":
        share(db_session, "usr_guest", can_query_source=False)
        params = {"viewId": VIEW, "dataSourceId": DS}
    elif case == "org-wide view":
        params = {"viewId": "view_native_ent", "dataSourceId": DS}
    else:
        share(db_session, "usr_guest")
        params = {"viewId": VIEW, "dataSourceId": DS_OTHER}
    await db_session.commit()
    with signed_in(person("usr_guest"), claims_with()):
        r = await run(test_client, params=params)
    assert r.status_code == 403, r.text
    assert engine["engine"].calls == []


async def test_an_api_key_never_may(test_client: AsyncClient, db_session, estate, engine):
    class EveryKey:
        org_perms = ()

        def selects_workspace(self, ws_id):
            return True

    with signed_in(person("usr_keyed"), claims_with(*READS, "workspace:native-query:read",
                                                    key_scope=EveryKey())):
        r = await run(test_client)
    assert r.status_code == 403
    assert engine["engine"].calls == []


async def test_the_switch_off_refuses_everyone(test_client: AsyncClient, db_session, estate, engine):
    feature_flags._cache = {"nativeQueryEnabled": False}
    with signed_in(person("usr_reader"), READER):
        r = await run(test_client)
    assert r.status_code == 403
    assert r.json()["detail"]["type"] == "feature_disabled"


async def test_a_switch_that_cannot_be_read_is_off(test_client: AsyncClient, db_session, estate,
                                                  engine, monkeypatch):
    async def unreadable(key, default=None):
        return default                                    # what an outage falls back to

    monkeypatch.setattr(feature_flags, "is_enabled_self_session", unreadable)
    with signed_in(person("usr_reader"), READER):
        r = await run(test_client)
    assert r.status_code == 403
    assert r.json()["detail"]["feature"] == "nativeQueryEnabled"


async def test_a_draft_is_refused(test_client: AsyncClient, db_session, estate, engine):
    with signed_in(person("usr_reader"), READER):
        r = await run(test_client, params={"branchId": "br_123"})
    assert r.status_code == 501
    assert r.json()["detail"]["code"] == "native_query_unavailable"


async def test_an_engine_without_native_queries_is_refused(test_client: AsyncClient, db_session,
                                                          estate, engine):
    engine["engine"] = object()
    with signed_in(person("usr_reader"), READER):
        r = await run(test_client)
    assert r.status_code == 501


# ── what every run gets ─────────────────────────────────────────────────


async def test_the_guard_refuses_before_the_engine_and_says_where(test_client: AsyncClient,
                                                                  db_session, estate, engine):
    with signed_in(person("usr_reader"), READER):
        r = await run(test_client, "MATCH (n) DETACH DELETE n")
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert (detail["code"], detail["position"]) == ("native_query_refused", 10)
    assert engine["engine"].calls == []
    (record,) = await records(db_session)
    assert record["details"]["outcome"] == "native_query_refused"


@pytest.mark.parametrize("failure, status_code, code", [
    (NativeQuerySyntaxError("Invalid input 'R'", position=9), 400, "native_query_syntax"),
    (NativeQueryWriteRefused("The query writes"), 400, "native_query_write_refused"),
    (NativeQueryTooLarge("The answer is larger than 16 MiB"), 422, "native_query_too_large"),
    (NativeQueryTimeout("It ran past its 10s limit"), 504, "native_query_timeout"),
    (ProviderUnavailable(provider_name="x", reason="Error 111 connecting to 10.1.2.3:6379",
                         retry_after_seconds=30), 503, "unavailable"),
    (RuntimeError("redis://admin:hunter2@10.1.2.3:6379 exploded"), 500, "native_query_failed"),
])
async def test_each_failure_reads_plainly_and_never_names_a_host(
        test_client: AsyncClient, db_session, estate, engine, failure, status_code, code):
    engine["engine"] = FakeEngine(failure)
    with signed_in(person("usr_reader"), READER):
        r = await run(test_client)
    assert r.status_code == status_code
    detail = r.json()["detail"]
    assert detail["code"] == code and detail["requestId"]
    assert "10.1.2.3" not in r.text and "hunter2" not in r.text
    (record,) = await records(db_session)
    assert record["details"]["outcome"] == code


async def test_past_the_persons_rate_it_is_refused_with_when_to_retry(
        test_client: AsyncClient, db_session, estate, engine, unlimited):
    unlimited.allow = False
    with signed_in(person("usr_reader"), READER):
        r = await run(test_client)
    assert r.status_code == 429
    assert r.headers["retry-after"] == "17"
    assert r.json()["detail"]["code"] == "rate_limited"
    assert engine["engine"].calls == []


async def test_past_the_sources_concurrency_it_is_busy(test_client: AsyncClient, db_session,
                                                       estate, engine, monkeypatch):
    monkeypatch.setenv("NATIVE_QUERY_CONCURRENCY", "1")
    get_native_query_settings.cache_clear()
    gate = asyncio.Event()

    async def slow():
        await gate.wait()
        return NativeQueryResult(columns=["x"], rows=[[1]])

    engine["engine"] = FakeEngine(slow)
    from backend.app.common import bulkhead

    monkeypatch.setattr(bulkhead.Bulkhead, "__init__", _quick_bulkhead(bulkhead.Bulkhead.__init__))
    with signed_in(person("usr_reader"), READER):
        first = asyncio.ensure_future(run(test_client))
        await asyncio.sleep(0.2)
        second = await run(test_client)
        gate.set()
        assert (await first).status_code == 200
    assert second.status_code == 429
    assert second.json()["detail"]["code"] == "busy"


def _quick_bulkhead(init):
    def quick(self, kind, limit, *, wait_seconds, retry_after_seconds=5):
        init(self, kind, limit, wait_seconds=0.05, retry_after_seconds=retry_after_seconds)
    return quick


async def test_windows_line_breaks_run_as_plain_ones(test_client: AsyncClient, db_session,
                                                     estate, engine):
    with signed_in(person("usr_reader"), READER):
        r = await run(test_client, "MATCH (n)\r\nRETURN n.x AS x // all\r\n")
    assert r.status_code == 200, r.text
    assert r.json()["executedQuery"] == "MATCH (n)\nRETURN n.x AS x LIMIT 201 // all\n"


async def test_the_limits_are_held_to_the_servers(test_client: AsyncClient, db_session, estate,
                                                  engine, monkeypatch):
    monkeypatch.setenv("NATIVE_QUERY_MAX_ROWS", "50")
    monkeypatch.setenv("NATIVE_QUERY_MAX_TIMEOUT_MS", "5000")
    get_native_query_settings.cache_clear()
    with signed_in(person("usr_reader"), READER):
        r = await run(test_client, "MATCH (n) RETURN n LIMIT 1000", limit=5000, timeoutMs=60000)
    body = r.json()
    assert body["limitApplied"] == 50 and body["timeoutMs"] == 5000
    assert body["executedQuery"] == "MATCH (n) RETURN n LIMIT 51"
    assert engine["engine"].calls[0]["timeout_ms"] == 5000
    assert any("50 rows" in note for note in body["notes"])


def test_the_row_ceiling_leaves_room_for_the_row_past_it(monkeypatch):
    """A run reads one row past its limit to know more matched: 9,999 + 1
    stays inside the stock FalkorDB image's RESULTSET_SIZE (10,000), past
    which FalkorDB cuts a reply without saying so."""
    monkeypatch.setenv("NATIVE_QUERY_MAX_ROWS", "10000")
    get_native_query_settings.cache_clear()
    try:
        assert get_native_query_settings().max_rows == 9_999
    finally:
        get_native_query_settings.cache_clear()


async def test_an_answer_past_the_size_cap_is_cut_and_says_so(test_client: AsyncClient,
                                                              db_session, estate, engine,
                                                              monkeypatch):
    monkeypatch.setattr(native_service, "MAX_RESPONSE_BYTES", 1000)
    engine["engine"] = FakeEngine(NativeQueryResult(columns=["s"], rows=[["x" * 300]] * 10))
    with signed_in(person("usr_reader"), READER):
        r = await run(test_client)
    body = r.json()
    assert body["truncated"] is True and body["truncatedReason"] == "size"
    assert 0 < body["rowCount"] < 10


async def test_every_run_is_recorded_with_its_query(test_client: AsyncClient, db_session, estate,
                                                    engine):
    with signed_in(person("usr_reader"), READER):
        await run(test_client, "MATCH (n:Dataset) RETURN n.urn AS urn")
    (record,) = await records(db_session)
    assert record["actor_id"] == "usr_reader"
    assert (record["workspace_id"], record["data_source_id"]) == (WS, DS)
    assert record["target_label"] == f"{DS} label"
    details = record["details"]
    assert details["query"] == "MATCH (n:Dataset) RETURN n.urn AS urn"
    assert (details["outcome"], details["via"], details["rows"]) == ("ok", "permission", 3)


async def test_no_record_means_no_rows(test_client: AsyncClient, db_session, estate, engine,
                                       monkeypatch):
    async def broken(*args, **kwargs):
        raise RuntimeError("the outbox is down")

    monkeypatch.setattr(native_service, "record_for_request", broken)
    with signed_in(person("usr_reader"), READER):
        r = await run(test_client)
    assert r.status_code == 503
    assert r.json()["detail"]["code"] == "audit_unavailable"
    assert "rows" not in r.text


async def test_a_person_who_goes_away_cancels_the_query(db_session, estate):
    """The engine is cancelled when the person is no longer there."""
    cancelled = asyncio.Event()

    async def forever():
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    activity_context.bind_actor("usr_reader")
    run_info = native_service.NativeRun(
        workspace_id=WS, data_source_id=DS, data_source_label="x", user_id="usr_reader",
        engine="falkordb", via="permission", view_id=None, request_id="req_1",
    )
    from backend.common.models.search import NativeQueryRequest

    gone = iter([False, True])

    async def is_disconnected():
        return next(gone, True)

    with pytest.raises(native_service.NativeQueryFailure) as caught:
        await native_service.run_native_query(
            FakeEngine(forever), run_info, NativeQueryRequest(query="MATCH (n) RETURN n"),
            db_session, is_disconnected=is_disconnected,
        )
    assert caught.value.code == "cancelled"
    assert cancelled.is_set()
    (record,) = await records(db_session)
    assert record["details"]["outcome"] == "cancelled"
