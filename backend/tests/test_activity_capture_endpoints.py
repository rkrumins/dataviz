"""Every manual change a person makes is recorded once, as them, with their why.

Endpoint by endpoint: the change writes ONE outbox event in its own request —
the signed-in person as its actor, the reason they gave in ``X-Activity-Reason``,
the request's ``X-Request-ID`` as its correlation id — filed under the workspace
and the thing it changed, named as that thing was named at the time. Values
that are secrets are never recorded, only that they changed.

Aggregation and freshness operations are pinned in
``test_aggregation_job_provenance.py``; IdP group sync in
``test_sso_membership_events.py``.
"""
from __future__ import annotations

import json
import time
import types
from urllib.parse import quote

import pytest
from sqlalchemy import select

from backend.app.db.models import (
    OutboxEventORM,
    ProviderORM,
    UserORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.db.repositories import group_repo
from backend.app.services.activity import catalogue
from backend.app.services.feature_flags import feature_flags

ME = "usr_test000000"
WHY = "Quarterly clean-up, ticket OPS-42"
HEADERS = {"X-Activity-Reason": quote(WHY), "X-Request-ID": "req-capture-1"}


@pytest.fixture
async def estate(db_session):
    """One workspace, one provider, three sources (one in the trash)."""
    db_session.add_all([
        WorkspaceORM(id="ws_1", name="Finance"),
        ProviderORM(id="prov_1", name="Prod graph", provider_type="falkordb"),
        ProviderORM(id="prov_9", name="Old graph", provider_type="falkordb"),
        WorkspaceDataSourceORM(
            id="ds_1", workspace_id="ws_1", provider_id="prov_1",
            graph_name="g_fin", label="Ledger", is_primary=True,
        ),
        WorkspaceDataSourceORM(
            id="ds_2", workspace_id="ws_1", provider_id="prov_1",
            graph_name="g_bud", label="Budget",
        ),
        WorkspaceDataSourceORM(
            id="ds_3", workspace_id="ws_1", provider_id="prov_1",
            graph_name="g_old", label="Archive", deleted_at="2026-10-01T00:00:00+00:00",
        ),
    ])
    await db_session.commit()


@pytest.fixture
def no_side_stores(monkeypatch):
    """The version store, the stats stream and the discovery stream, faked."""
    from backend.app.api.v1.endpoints import workspaces
    from backend.app.services.versioning import bootstrap_worker, purge_worker
    from backend.insights_service import enqueue, scheduler

    async def _none(*a, **k):
        return None

    async def _true(*a, **k):
        return True

    async def _queued(*a, **k):
        return "msg-1"

    async def _bootstrap(**k):
        return {"job_id": "vjob_1", "graph_id": "vg_1", "status": "queued"}

    async def _retry(**k):
        return {"jobId": "vjob_1", "status": "queued"}

    async def _abandon(**k):
        return {"abandoned": True}

    async def _tick():
        return types.SimpleNamespace(providers=2, list_jobs=2, asset_jobs=5, dedup_skipped=1)

    monkeypatch.setattr(workspaces, "enqueue_stats_job_safe", _none)
    monkeypatch.setattr(purge_worker, "tombstone_graphs_for_data_source", _none)
    monkeypatch.setattr(purge_worker, "restore_graphs_for_data_source", _true)
    monkeypatch.setattr(bootstrap_worker, "create_bootstrap_job", _bootstrap)
    monkeypatch.setattr(bootstrap_worker, "retry_bootstrap", _retry)
    monkeypatch.setattr(bootstrap_worker, "abandon_bootstrap", _abandon)
    monkeypatch.setattr(enqueue, "enqueue_discovery_job_force", _queued)
    monkeypatch.setattr(scheduler, "trigger_discovery_tick_now", _tick)


@pytest.fixture
def versioning_on():
    feature_flags._cache = {"versioningEnabled": True}
    feature_flags._cache_ts = time.monotonic()
    yield
    feature_flags.invalidate()


async def _recorded(db_session, event_type: str) -> list[dict]:
    rows = (await db_session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type == event_type)
    )).scalars().all()
    return [json.loads(r.payload) for r in rows]


async def _only(db_session, event_type: str) -> dict:
    payloads = await _recorded(db_session, event_type)
    assert len(payloads) == 1, f"{event_type}: expected one event, got {len(payloads)}"
    payload = payloads[0]
    assert payload["actor_id"] == ME
    assert payload["stated_reason"] == WHY
    assert payload["correlation_id"] == "req-capture-1"
    return payload


def _filed_under(payload: dict, *, ws=None, ds=None, target=None, label=None) -> None:
    assert payload.get("workspace_id") == ws
    assert payload.get("data_source_id") == ds
    assert (payload.get("target_type"), payload.get("target_id")) == (target or (None, None))
    assert payload.get("target_label") == label


# ── Data sources ──────────────────────────────────────────────────────


DS = "/api/v1/admin/workspaces/ws_1/data-sources"


@pytest.mark.asyncio
@pytest.mark.parametrize("method, path, body, event_type, ds, label, details", [
    ("PUT", f"{DS}/ds_1", {"label": "General ledger"},
     "workspace.data_source.updated", "ds_1", "General ledger", {"fields": ["label"]}),
    ("DELETE", f"{DS}/ds_2", None,
     "workspace.data_source.removed", "ds_2", "Budget", {"permanent": False}),
    ("POST", f"{DS}/ds_3/restore", None,
     "workspace.data_source.restored", "ds_3", "Archive", None),
    ("POST", f"{DS}/ds_2/set-primary", None,
     "workspace.data_source.primary_set", "ds_2", "Budget", None),
    ("PATCH", f"{DS}/ds_1/projection-mode", {"mode": "dedicated"},
     "workspace.data_source.projection_changed", "ds_1", "Ledger",
     {"from": None, "to": "dedicated"}),
])
async def test_a_data_source_change_is_recorded_once_under_its_workspace(
    test_client, db_session, estate, no_side_stores,
    method, path, body, event_type, ds, label, details,
):
    resp = await test_client.request(method, path, json=body, headers=HEADERS)
    assert resp.status_code in (200, 204), resp.text

    payload = await _only(db_session, event_type)
    _filed_under(payload, ws="ws_1", ds=ds, target=("data_source", ds), label=label)
    assert payload.get("details") == details

    # A workspace admin sees it in their workspace's Activity, as data.
    projected = catalogue.project(event_type=event_type, payload=payload, event_version=2)
    assert (projected["category"], projected["audience"]) == ("data", "workspace")


@pytest.mark.asyncio
async def test_onboarding_a_source_records_it_and_who_added_it(
    test_client, db_session, estate, no_side_stores,
):
    resp = await test_client.post(
        DS, json={"providerId": "prov_1", "graphName": "g_pay", "label": "Payroll"},
        headers=HEADERS,
    )
    assert resp.status_code == 201, resp.text
    ds_id = resp.json()["id"]

    payload = await _only(db_session, "workspace.data_source.added")
    _filed_under(payload, ws="ws_1", ds=ds_id, target=("data_source", ds_id), label="Payroll")
    assert payload["details"] == {"providerId": "prov_1", "graphName": "g_pay"}
    row = await db_session.get(WorkspaceDataSourceORM, ds_id)
    assert row.created_by == ME


# ── Providers: the platform's, never a workspace's ────────────────────


@pytest.mark.asyncio
async def test_registering_changing_and_deleting_a_provider_records_no_secret(
    test_client, db_session, estate,
):
    created = await test_client.post(
        "/api/v1/admin/providers",
        json={
            "name": "Staging graph", "providerType": "falkordb",
            "host": "falkor.staging", "port": 6379,
            "credentials": {"password": "first-s3cret"},
        },
        headers=HEADERS,
    )
    assert created.status_code == 201, created.text
    provider_id = created.json()["id"]

    changed = await test_client.put(
        "/api/v1/admin/providers/prov_1",
        json={"name": "Production graph", "credentials": {"password": "second-s3cret"}},
        headers=HEADERS,
    )
    assert changed.status_code == 200, changed.text
    deleted = await test_client.delete("/api/v1/admin/providers/prov_9", headers=HEADERS)
    assert deleted.status_code == 204, deleted.text

    added = await _only(db_session, "provider.connection.created")
    _filed_under(added, target=("provider", provider_id), label="Staging graph")
    updated = await _only(db_session, "provider.connection.updated")
    _filed_under(updated, target=("provider", "prov_1"), label="Production graph")
    assert updated["details"] == {"fields": ["credentials", "name"]}
    removed = await _only(db_session, "provider.connection.deleted")
    _filed_under(removed, target=("provider", "prov_9"), label="Old graph")

    everything = json.dumps([added, updated, removed])
    assert "s3cret" not in everything
    assert catalogue.project(
        event_type="provider.connection.updated", payload=updated, event_version=2,
    )["audience"] == "platform"


# ── Version control: recorded beside a store that is not ours ─────────


GRAPH = "/api/v1/ws_1/graph"


@pytest.mark.asyncio
@pytest.mark.parametrize("path, event_type, details", [
    (f"{GRAPH}/bootstrap?dataSourceId=ds_1",
     "workspace.versioning.enabled", {"jobId": "vjob_1", "graphId": "vg_1"}),
    (f"{GRAPH}/bootstrap/retry?dataSourceId=ds_1&mode=restart",
     "workspace.versioning.retried", {"mode": "restart"}),
    (f"{GRAPH}/bootstrap/abandon?dataSourceId=ds_1",
     "workspace.versioning.abandoned", None),
])
async def test_a_version_control_step_is_recorded_once(
    test_client, db_session, estate, no_side_stores, versioning_on,
    path, event_type, details,
):
    resp = await test_client.post(path, headers=HEADERS)
    assert resp.status_code in (200, 202), resp.text

    payload = await _only(db_session, event_type)
    _filed_under(payload, ws="ws_1", ds="ds_1", target=("data_source", "ds_1"), label="Ledger")
    assert payload.get("details") == details


@pytest.mark.asyncio
async def test_collapsing_duplicates_is_recorded_once_with_what_it_removes(
    test_client, db_session, estate, no_side_stores, versioning_on, monkeypatch,
):
    """It removes copies from the source graph itself: a person's decision
    about their data, recorded with how much it removes — and a repeated
    decision, which changes nothing, records nothing more."""
    from backend.app.services.versioning import bootstrap_worker

    decisions = iter([{"jobId": "vjob_1", "already": False}, {"jobId": "vjob_1", "already": True}])

    async def _decide(**k):
        return next(decisions)

    async def _status(**k):
        return {"jobId": "vjob_1", "status": "running",
                "duplicates": {"identifiers": 3, "extraCopies": 5, "fingerprint": "fp_1"}}

    monkeypatch.setattr(bootstrap_worker, "decide_duplicates", _decide)
    monkeypatch.setattr(bootstrap_worker, "bootstrap_status", _status)
    for _ in range(2):
        resp = await test_client.post(
            f"{GRAPH}/bootstrap/decision?dataSourceId=ds_1", headers=HEADERS,
            json={"action": "collapse", "fingerprint": "fp_1"},
        )
        assert resp.status_code in (200, 202), resp.text

    payload = await _only(db_session, "workspace.versioning.duplicates_collapsed")
    _filed_under(payload, ws="ws_1", ds="ds_1", target=("data_source", "ds_1"), label="Ledger")
    assert payload["details"] == {"jobId": "vjob_1", "identifiers": 3, "extraCopies": 5}


@pytest.mark.asyncio
async def test_giving_up_on_a_package_source_names_it_before_it_goes(
    test_client, db_session, estate, no_side_stores, versioning_on, monkeypatch,
):
    """A data source made from a view package is removed when its copy is
    given up. The record is written first, while there is a source to name."""
    from backend.app.services.versioning import bootstrap_worker

    async def _abandon(**k):
        return {"status": "cancelled", "origin": "package"}

    monkeypatch.setattr(bootstrap_worker, "abandon_bootstrap", _abandon)
    resp = await test_client.post(f"{GRAPH}/bootstrap/abandon?dataSourceId=ds_1", headers=HEADERS)
    assert resp.status_code == 200, resp.text
    assert resp.json()["dataSourceRemoved"] is True

    payload = await _only(db_session, "workspace.versioning.abandoned")
    _filed_under(payload, ws="ws_1", ds="ds_1", target=("data_source", "ds_1"), label="Ledger")


@pytest.mark.asyncio
async def test_a_resync_is_recorded_once(test_client, db_session, estate, versioning_on, monkeypatch):
    from backend.app.api.v1.endpoints import graph
    from backend.app.main import app
    from backend.app.services.versioning.service import GraphVersioningService

    async def _resolve(self, **k):
        return {"graph_id": "vg_1"}

    async def _resync(self, **k):
        return {"commit_id": "c_1", "commit_seq": 7}

    monkeypatch.setattr(GraphVersioningService, "resolve_graph", _resolve)
    monkeypatch.setattr(GraphVersioningService, "resync_from_provider", _resync)
    engine = types.SimpleNamespace(provider=object(), _db_session=db_session)
    monkeypatch.setitem(app.dependency_overrides, graph.get_context_engine, lambda: engine)

    resp = await test_client.post(
        f"{GRAPH}/resync?dataSourceId=ds_1&strategy=external_wins", headers=HEADERS,
    )
    assert resp.status_code == 200, resp.text
    payload = await _only(db_session, "workspace.versioning.resynced")
    _filed_under(payload, ws="ws_1", ds="ds_1", target=("data_source", "ds_1"), label="Ledger")
    assert payload["details"] == {"strategy": "external_wins", "commitId": "c_1"}


# ── Ingestion outside aggregation: discovery and asset statistics ─────


INSIGHTS = "/api/v1/admin/insights"


@pytest.mark.asyncio
async def test_refreshing_an_assets_statistics_is_recorded(test_client, db_session, estate, no_side_stores):
    resp = await test_client.post(
        f"{INSIGHTS}/providers/prov_1/assets/g_fin/refresh", headers=HEADERS,
    )
    assert resp.status_code == 202, resp.text
    payload = await _only(db_session, "stats.asset.refresh_requested")
    _filed_under(payload, target=("asset", "prov_1:g_fin"), label="g_fin")
    assert payload["details"] == {"providerId": "prov_1", "queued": True}


@pytest.mark.asyncio
async def test_running_discovery_is_recorded_for_a_provider_and_for_all(
    test_client, db_session, estate, no_side_stores,
):
    one = await test_client.post(f"{INSIGHTS}/providers/prov_1/assets/refresh", headers=HEADERS)
    assert one.status_code == 202, one.text
    every = await test_client.post(f"{INSIGHTS}/discovery/trigger", headers=HEADERS)
    assert every.status_code == 202, every.text

    payloads = await _recorded(db_session, "stats.discovery.triggered")
    assert len(payloads) == 2
    on_provider = next(p for p in payloads if p.get("target_id"))
    _filed_under(on_provider, target=("provider", "prov_1"), label="Prod graph")
    on_everything = next(p for p in payloads if not p.get("target_id"))
    assert on_everything["details"] == {"providers": 2, "listJobs": 2, "assetJobs": 5}
    assert catalogue.summarize("stats.discovery.triggered", on_everything)[1] == (
        "Ran asset discovery on every provider"
    )


# ── Platform settings ─────────────────────────────────────────────────


@pytest.fixture
async def seeded_flags(db_session):
    from backend.app.db.seed_feature_registry import seed_feature_flags, seed_feature_registry

    await seed_feature_registry(db_session)
    await seed_feature_flags(db_session)
    await db_session.commit()


@pytest.mark.asyncio
async def test_a_flag_change_is_one_event_per_flag_that_moved(test_client, db_session, seeded_flags):
    current = (await test_client.get("/api/v1/admin/features")).json()
    resp = await test_client.patch(
        "/api/v1/admin/features",
        json={"version": current["version"], **current["values"], "traceEnabled": False},
        headers=HEADERS,
    )
    assert resp.status_code == 200, resp.text
    payload = await _only(db_session, "platform.feature_flag.changed")
    _filed_under(payload, target=("feature_flag", "traceEnabled"), label="traceEnabled")
    assert payload["details"] == {"key": "traceEnabled", "from": True, "value": False}


@pytest.mark.asyncio
async def test_platform_policy_changes_are_recorded(test_client, db_session):
    policy = await test_client.put(
        "/api/v1/profiling/policy",
        json={"alertsEnabled": False, "heartbeatSecs": 600}, headers=HEADERS,
    )
    assert policy.status_code == 200, policy.text
    identity = await test_client.put(
        "/api/v1/admin/platform/node-identity",
        json={"identityProperty": "uuid"}, headers=HEADERS,
    )
    assert identity.status_code == 200, identity.text

    assert (await _only(db_session, "platform.profiling_policy.updated"))["details"] == {
        "alertsEnabled": False, "heartbeatSecs": 600,
    }
    assert (await _only(db_session, "platform.node_identity.updated"))["details"] == {
        "from": {"identityProperty": None, "nameProperty": None},
        "to": {"identityProperty": "uuid", "nameProperty": None},
    }


# ── Groups: a person's hand, distinguished from the IdP's ─────────────


@pytest.mark.asyncio
async def test_adding_and_removing_a_group_member_by_hand_says_so(test_client, db_session):
    group = await group_repo.create_group(db_session, name="Analysts", description="")
    db_session.add(UserORM(
        id="usr_ana", email="ana@example.com", password_hash="x",
        first_name="Ana", last_name="Lyst", status="active",
    ))
    await db_session.commit()

    added = await test_client.post(
        f"/api/v1/admin/groups/{group.id}/members", json={"userId": "usr_ana"},
        headers=HEADERS,
    )
    assert added.status_code in (200, 201), added.text
    removed = await test_client.delete(
        f"/api/v1/admin/groups/{group.id}/members/usr_ana", headers=HEADERS,
    )
    assert removed.status_code == 204, removed.text

    for event_type in ("rbac.group.member_added", "rbac.group.member_removed"):
        payload = await _only(db_session, event_type)
        assert payload["via"] == "manual"
        assert (payload["group_id"], payload["user_id"]) == (group.id, "usr_ana")


# ── The stores and the statistics pipeline ────────────────────────────


@pytest.mark.asyncio
async def test_retrying_and_deleting_a_failed_statistics_message_is_recorded(
    test_client, db_session, monkeypatch,
):
    from backend.insights_service import redis_streams

    async def _redrive(msg_id):
        return types.SimpleNamespace(
            redriven_msg_id="2-0", original_stream="insights:discovery", redrive_count=1,
        )

    existed = {"1-0": True, "9-9": False}

    async def _delete(msg_id):
        return existed[msg_id]

    monkeypatch.setattr(redis_streams, "redrive_dlq_entry", _redrive)
    monkeypatch.setattr(redis_streams, "delete_dlq_entry", _delete)

    retried = await test_client.post(f"{INSIGHTS}/dlq/1-0/redrive", headers=HEADERS)
    assert retried.status_code == 200, retried.text
    payload = await _only(db_session, "stats.dlq.redriven")
    assert payload["details"] == {
        "messageId": "1-0", "redrivenMessageId": "2-0",
        "originalStream": "insights:discovery", "redriveCount": 1,
    }

    # Deleting is idempotent; only a deletion that removed something is one.
    for msg_id in ("1-0", "9-9"):
        resp = await test_client.delete(f"{INSIGHTS}/dlq/{msg_id}", headers=HEADERS)
        assert resp.status_code == 204, resp.text
    payload = await _only(db_session, "stats.dlq.deleted")
    assert payload["details"] == {"messageId": "1-0"}


@pytest.mark.asyncio
async def test_changing_statistics_admission_records_before_and_after(
    test_client, db_session, estate,
):
    first = await test_client.put(
        f"{INSIGHTS}/admission/prov_1", json={"bucket_capacity": 8, "refill_per_sec": 2},
        headers=HEADERS,
    )
    assert first.status_code == 200, first.text
    again = await test_client.put(
        f"{INSIGHTS}/admission/prov_1", json={"bucket_capacity": 8, "refill_per_sec": 2},
        headers=HEADERS,
    )
    assert again.status_code == 200, again.text   # unchanged: nothing to record
    payload = await _only(db_session, "stats.admission.updated")
    _filed_under(payload, target=("provider", "prov_1"), label="Prod graph")
    assert payload["details"] == {
        "from": None, "to": {"bucketCapacity": 8, "refillPerSec": 2},
    }


@pytest.mark.asyncio
async def test_dropping_a_sources_cached_reads_is_recorded_under_it(
    test_client, db_session, estate, monkeypatch,
):
    from backend.app.api.v1.endpoints import graph_store

    class _Cache:
        async def bump_generation(self, scope):
            return None

        async def purge_lkg_scope(self, scope):
            return 3

    monkeypatch.setattr(graph_store, "get_graph_cache", lambda: _Cache())
    resp = await test_client.post(
        "/api/v1/admin/graph-store/cache/refresh"
        "?workspaceId=ws_1&dataSourceId=ds_1&keepFallback=false",
        headers=HEADERS,
    )
    assert resp.status_code == 200, resp.text
    payload = await _only(db_session, "aggregation.source.cache_refreshed")
    _filed_under(payload, ws="ws_1", ds="ds_1", target=("data_source", "ds_1"))
    assert payload["details"] == {"keepFallback": False, "fallbackEntriesPurged": 3}
    # A workspace's admins see what was done to their source.
    assert catalogue._audience("aggregation.source.cache_refreshed", payload, "ws_1") == "workspace"


@pytest.mark.asyncio
async def test_changing_a_graph_store_nodes_limits_records_before_and_after(
    test_client, db_session, monkeypatch,
):
    from dataclasses import dataclass, field

    from backend.app.services.aggregation import graph_store_limits

    @dataclass
    class _Applied:
        previous: dict = field(default_factory=dict)
        applied: dict = field(default_factory=dict)
        applied_to: list = field(default_factory=list)

    async def _apply(session, endpoint, patch):
        return _Applied(
            previous={"TIMEOUT_MAX": 60_000, "QUERY_MEM_CAPACITY": None},
            applied={"TIMEOUT_MAX": 300_000},
            applied_to=["falkor-0"],
        )

    monkeypatch.setattr(graph_store_limits, "apply_graph_store_limits", _apply)
    resp = await test_client.patch(
        "/api/v1/admin/graph-store/falkor-0/limits", json={"timeoutMaxMs": 300_000},
        headers=HEADERS,
    )
    assert resp.status_code == 200, resp.text
    payload = await _only(db_session, "aggregation.graph_store.limits_changed")
    _filed_under(payload, target=("graph_store_node", "falkor-0"), label="falkor-0")
    assert payload["details"] == {
        "changes": [{"field": "timeoutMaxMs", "from": 60_000, "to": 300_000}],
        "appliedTo": ["falkor-0"],
    }
