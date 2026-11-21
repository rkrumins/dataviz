"""A data source's history, as anyone who can read the source sees it.

It reads the activity ledger, so these pin what makes it safe to show every reader: only
an allow-list of changes to the source itself (never an aggregation run, a query someone
ran, another source's events or anything platform-wide), with nobody's email, no request
correlation, no API key, no payload and no details; a page at a time, newest first, at
most fifty; only for a source that is live in the workspace asked about — and what
happened to it before it moved there stays in its history.
"""
from __future__ import annotations

import json
import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient

from backend.app.db.models import OutboxEventORM
from backend.app.services.activity import catalogue
from backend.app.services.feature_flags import feature_flags
from backend.app.services.outbox_relay import drain_once
from tests.common import discussions_world as w

URL = f"/api/v1/admin/workspaces/{w.WS}/data-sources/{w.DS}/activity/events"
NOW = datetime.now(timezone.utc)


@pytest.fixture
async def world(db_session):
    await w.seed(db_session)


@pytest.fixture
def on():
    feature_flags._cache = {**(feature_flags._cache or {}), "dataSourceMetadataEnabled": True}
    feature_flags._cache_ts = time.monotonic()


def _emit(db_session, event_type: str, payload: dict, *, minutes_ago: float, version: int = 2) -> None:
    db_session.add(OutboxEventORM(
        id=f"evt_{uuid.uuid4().hex[:12]}", event_type=event_type, event_version=version,
        aggregate_type="data_source", aggregate_id=payload.get("data_source_id") or "agg",
        payload=json.dumps(payload), processed=False,
        created_at=(NOW - timedelta(minutes=minutes_ago)).isoformat(),
    ))


def _on(ds: str = w.DS, ws: str | None = w.WS, **extra) -> dict:
    """A recorder envelope about ``ds``, filed under ``ws``."""
    base = {"actor_id": w.BEN, "data_source_id": ds, "target_type": "data_source", "target_id": ds,
            "target_label": "General ledger", "correlation_id": "req_0123456789abcdef", "api_key_id": "key_1",
            "stated_reason": "tidying up", "details": {"fields": ["label"]}}
    return {**base, **({"workspace_id": ws} if ws else {}), **extra}


async def _relay(db_session) -> None:
    await db_session.flush()
    while await drain_once(db_session):
        pass
    await db_session.commit()


async def _get(client, db_session, uid=w.ADA, url=URL, **params):
    with w.acting(uid, await w.claims_for(db_session, uid)):
        return await client.get(url, params=params)


@pytest.mark.asyncio
async def test_only_safe_changes_to_this_source_and_nothing_personal(world, on, db_session, test_client: AsyncClient):
    # What the history shows: changes to the source, here and in the workspace it came from.
    _emit(db_session, "workspace.data_source.added", _on(ws=w.OPS), minutes_ago=50)          # before it moved
    _emit(db_session, "workspace.datasource.moved", {
        "actor_id": w.WALT, "data_source_id": w.DS, "from_workspace_id": w.OPS, "to_workspace_id": w.WS,
    }, minutes_ago=40, version=1)
    _emit(db_session, "workspace.data_request.connected", {
        "request_id": "dr_1", "workspace_id": w.WS, "title": "Ledger", "actor_id": w.WALT, "data_source_id": w.DS,
    }, minutes_ago=30, version=1)
    _emit(db_session, "workspace.data_source.updated", _on(), minutes_ago=20)
    _emit(db_session, "workspace.data_source.trust_changed",
          _on(details={"trustStatus": {"from": None, "to": "certified"}}), minutes_ago=10)
    # What it never shows.
    _emit(db_session, "aggregation.job.triggered", _on(), minutes_ago=9)                     # an operation
    _emit(db_session, "workspace.data_source.native_query_run", _on(), minutes_ago=8)         # a query someone ran
    _emit(db_session, "workspace.data_source.updated", _on(ds=w.DS_OPS, ws=w.OPS), minutes_ago=7)  # another source
    _emit(db_session, "workspace.data_source.updated", _on(ws=None), minutes_ago=6)           # platform audience
    await _relay(db_session)

    r = await _get(test_client, db_session)
    assert r.status_code == 200, r.text
    events = r.json()["events"]
    assert [e["eventType"] for e in events] == [
        "workspace.data_source.trust_changed", "workspace.data_source.updated",
        "workspace.data_request.connected", "workspace.datasource.moved", "workspace.data_source.added",
    ]
    assert events[0]["summary"] == "Certified General ledger"
    assert r.json()["nextCursor"] is None
    for e in events:
        assert (e["correlationId"], e["apiKeyId"], e["apiKeyName"], e["payload"], e["details"]) == (
            None, None, None, None, {})
        assert e["actor"]["email"] is None and e["actor"]["name"]
        assert e["subject"] is None or e["subject"]["email"] is None


@pytest.mark.asyncio
async def test_the_allow_list_is_changes_to_a_source_its_workspace_may_read():
    assert set(catalogue.SOURCE_HISTORY_TYPES) == {
        *(f"workspace.data_source.{verb}" for verb in (
            "added", "updated", "removed", "restored", "primary_set", "projection_changed", "contacts_changed",
            "moved", "move_undone", "metadata_changed", "trust_changed")),
        "workspace.datasource.moved", "workspace.data_request.connected", "workspace.versioning.enabled",
    }
    for event_type in catalogue.SOURCE_HISTORY_TYPES:
        out = catalogue.project(event_type=event_type, payload={"workspace_id": "ws_1", "to_workspace_id": "ws_1"})
        assert out["audience"] == catalogue.AUDIENCE_WORKSPACE, event_type


@pytest.mark.asyncio
async def test_pages_walk_the_history_newest_first_at_most_fifty_at_a_time(
    world, on, db_session, test_client: AsyncClient,
):
    for i in range(35):
        _emit(db_session, "workspace.data_source.updated", _on(), minutes_ago=100 - i)
    await _relay(db_session)

    first = (await _get(test_client, db_session)).json()
    assert len(first["events"]) == 30 and first["nextCursor"]        # thirty unless asked
    seen, cursor = [], None
    while True:
        params = {"limit": 8, **({"cursor": cursor} if cursor else {})}
        page = (await _get(test_client, db_session, **params)).json()
        seen += [e["id"] for e in page["events"]]
        cursor = page["nextCursor"]
        if not cursor:
            break
    assert len(seen) == len(set(seen)) == 35
    assert seen[:30] == [e["id"] for e in first["events"]]

    assert (await _get(test_client, db_session, limit=51)).status_code == 422
    assert (await _get(test_client, db_session, limit=0)).status_code == 422
    assert (await _get(test_client, db_session, cursor="x" * 201)).status_code == 422
    assert (await _get(test_client, db_session, cursor="not-a-cursor")).status_code == 400


@pytest.mark.asyncio
async def test_only_a_reader_of_the_workspace_the_source_is_in_reads_it(world, on, db_session, test_client):
    assert (await _get(test_client, db_session, w.EVE)).status_code == 403          # can't read Finance
    # Eve reads Ops, but the ledger is not in Ops; Ada reads Finance, but Ops's source isn't there.
    in_ops = f"/api/v1/admin/workspaces/{w.OPS}/data-sources/{w.DS}/activity/events"
    assert (await _get(test_client, db_session, w.EVE, in_ops)).status_code == 404
    ops_source = f"/api/v1/admin/workspaces/{w.WS}/data-sources/{w.DS_OPS}/activity/events"
    assert (await _get(test_client, db_session, w.ADA, ops_source)).status_code == 404


@pytest.mark.asyncio
async def test_the_history_is_off_with_the_switch(world, db_session, test_client: AsyncClient):
    r = await _get(test_client, db_session)
    assert r.status_code == 403 and r.json()["detail"]["type"] == "feature_disabled"
