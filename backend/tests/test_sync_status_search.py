"""The search lane of a view's sync status (``GET /graph/sync-status``).

The lane says whether search works on the view's data, on evidence: the
graph store the data source runs on (only FalkorDB runs search), whether it
is answering — the in-memory breaker and warmup state the provider status
reads, no I/O — and the latest search's outcome, which the search route
records. ``_sync_search`` is called directly over real rows.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints import graph as graph_mod
from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.services.node_identity import invalidate_global_defaults_cache


async def _seed(session: AsyncSession, *, provider_type: str = "falkordb",
                is_active: bool = True, name_property: str | None = None) -> None:
    session.add(ProviderORM(id="prov_s", name="P", provider_type=provider_type,
                            is_active=is_active))
    session.add(WorkspaceORM(id="ws_s", name="W"))
    session.add(WorkspaceDataSourceORM(id="ds_s", workspace_id="ws_s", provider_id="prov_s",
                                       graph_name="g", name_property=name_property))
    await session.flush()


@pytest.fixture(autouse=True)
def _fresh_platform_defaults():
    invalidate_global_defaults_cache()
    yield
    invalidate_global_defaults_cache()


@pytest.fixture
def evidence(monkeypatch):
    """What the lane reads besides the rows: breaker states, the warmup
    cache and the latest search's outcome — each set per test."""
    state = {"breakers": {}, "warmup": {}, "outcome": None}
    monkeypatch.setattr(graph_mod.provider_manager, "report_provider_states",
                        lambda: state["breakers"])
    monkeypatch.setattr(graph_mod.provider_manager, "warmup_cache", state["warmup"],
                        raising=False)

    async def _read(ws_id, data_source_id):
        assert (ws_id, data_source_id) == ("ws_s", "ds_s")
        return state["outcome"]

    monkeypatch.setattr(graph_mod, "read_search_outcome", _read)
    return state


async def test_a_graph_answering_real_traffic_and_a_search_that_answered(
    db_session: AsyncSession, evidence,
):
    await _seed(db_session)
    evidence["breakers"]["prov_s:g"] = "healthy"
    evidence["outcome"] = {"at": "2026-10-01T10:00:00+00:00", "ok": True}

    lane = await graph_mod._sync_search(db_session, "ws_s", "ds_s")

    assert lane.supported and lane.status == "ready"
    assert lane.checked_at                      # a breaker verdict is observed now
    assert (lane.last_search_at, lane.last_search_ok, lane.last_search_reason) == (
        "2026-10-01T10:00:00+00:00", True, None)
    assert lane.name_property == "name"         # the platform default


async def test_names_are_read_from_the_sources_display_name_property(
    db_session: AsyncSession, evidence,
):
    """What a name search matches on a node with no displayName is what the
    data source's Display-name property says — the lane tells the reader."""
    await _seed(db_session, name_property="assetName")

    lane = await graph_mod._sync_search(db_session, "ws_s", "ds_s")

    assert lane.name_property == "assetName"


async def test_a_graph_that_is_not_answering_and_the_failure_it_caused(
    db_session: AsyncSession, evidence,
):
    await _seed(db_session)
    evidence["breakers"]["prov_s:g"] = "unavailable"
    evidence["outcome"] = {"at": "2026-10-01T10:00:00+00:00", "ok": False,
                           "reason": "The graph store was not answering"}

    lane = await graph_mod._sync_search(db_session, "ws_s", "ds_s")

    assert lane.status == "unavailable"
    assert lane.last_search_ok is False
    assert lane.last_search_reason == "The graph store was not answering"


async def test_a_warmup_verdict_is_dated_by_its_own_probe(db_session: AsyncSession, evidence):
    await _seed(db_session)
    probed = time.time() - 40
    evidence["warmup"]["prov_s"] = {"ok": True, "checked_at": probed}

    lane = await graph_mod._sync_search(db_session, "ws_s", "ds_s")

    assert lane.status == "ready"
    assert lane.checked_at == datetime.fromtimestamp(probed, tz=timezone.utc).isoformat()
    assert lane.last_search_at is None          # nobody has searched yet


async def test_nothing_observed_yet_is_unknown_not_ready(db_session: AsyncSession, evidence):
    await _seed(db_session)

    lane = await graph_mod._sync_search(db_session, "ws_s", "ds_s")

    assert (lane.status, lane.checked_at) == ("unknown", None)


async def test_a_graph_store_that_does_not_run_search_says_so(db_session: AsyncSession, evidence):
    await _seed(db_session, provider_type="neo4j")
    evidence["breakers"]["prov_s:g"] = "healthy"

    lane = await graph_mod._sync_search(db_session, "ws_s", "ds_s")

    assert lane.supported is False


async def test_an_unknown_data_source_has_no_lane(db_session: AsyncSession, evidence):
    assert await graph_mod._sync_search(db_session, "ws_s", "missing") is None


def test_the_lane_goes_out_in_the_wire_spelling():
    doc = graph_mod.SyncStatusResponse(
        kind="external", data_source_id="ds_s", checked_at="now",
        search=graph_mod._SyncSearch(
            supported=True, status="ready", name_property="name", checked_at="t0",
            last_search_at="t1", last_search_ok=True,
        ),
    ).model_dump(by_alias=True)
    assert doc["search"] == {
        "supported": True, "status": "ready", "nameProperty": "name", "checkedAt": "t0",
        "lastSearchAt": "t1", "lastSearchOk": True, "lastSearchReason": None,
    }
