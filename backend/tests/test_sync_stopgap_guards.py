"""A re-sync that would undo people's work, or delete most of a graph, is refused.

Until the source shadow (INGEST S1) becomes a sync's merge base, the base is main as it stood
at the last import or sync, human edits included. A second sync after people curated main
therefore reads their edits as drift and reverts them, and deletes what they created
(AUTOVSHUMAN-01). A snapshot that is missing rows reads as "the source deleted them"
(BOOTSTRAP-3). Both are refused with a 409; only a workspace admin may override, with ``force``
or ``allowMassDelete``. The database cases are in integration/test_sync_curation_guard.py.
"""
from __future__ import annotations

import pytest

from backend.app.api.v1.endpoints.versioning import get_versioning_service
from backend.app.auth.dependencies import get_permission_claims
from backend.app.services.permission_service import KeyScope, PermissionClaims
from backend.app.services.versioning.errors import CurationAtRisk, MassDeleteBlocked
from backend.app.services.versioning.service import GraphVersioningService

WS = "ws_sync_guard"
_MANAGER = PermissionClaims(                  # a sync advances main, so it needs publish too
    sid="sess_test",
    ws_perms={WS: ("workspace:datasource:read", "workspace:datasource:manage",
                   "workspace:datasource:publish")})
_HUMAN = ("cmt_1", 3, "squash_publish", "alice", "2026-10-01T00:00:00Z")


# ── service: the resync pre-check ────────────────────────────────────────────

class _NoSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


def _resync_svc(human, calls):
    svc = GraphVersioningService()

    async def _syncable(_gid):
        return None

    async def _main(_s, _gid):
        return "br_main"

    async def _last(_s, _gid, _main_id):
        return 5

    async def _human(_s, _gid, _main_id, last_seq):
        calls.append(("human", last_seq))
        return human

    async def _sync(**kw):
        calls.append(("sync", kw))
        return {"commit_id": "c9"}

    svc._assert_syncable = _syncable                                # type: ignore[assignment]
    svc._session = _NoSession                                       # type: ignore[assignment]
    svc._main_branch_id = _main                                     # type: ignore[assignment]
    svc._last_sync_seq = _last                                      # type: ignore[assignment]
    svc._human_commit_in_sync_base = _human                         # type: ignore[assignment]
    svc.sync_ingest = _sync                                         # type: ignore[assignment]
    return svc


async def test_resync_refuses_curation_risk_before_paging(monkeypatch):
    """A guaranteed refusal must not first page the whole provider."""
    from backend.app.providers import versioned_bootstrap

    async def _paged(*_a, **_kw):
        raise AssertionError("the provider was paged before the curation check")
    monkeypatch.setattr(versioned_bootstrap, "collect_provider_rows", _paged)
    calls: list = []
    with pytest.raises(CurationAtRisk) as refused:
        await _resync_svc(_HUMAN, calls).resync_from_provider(
            graph_id="g1", provider=object(), actor="u1")
    assert refused.value.detail["lastHumanCommit"]["id"] == "cmt_1"
    assert calls == [("human", 5)]


async def test_resync_force_skips_precheck_and_passes_flags(monkeypatch):
    from backend.app.providers import versioned_bootstrap

    async def _rows(*_a, **_kw):
        return {"nodes": [], "edges": []}
    monkeypatch.setattr(versioned_bootstrap, "collect_provider_rows", _rows)
    calls: list = []
    await _resync_svc(_HUMAN, calls).resync_from_provider(
        graph_id="g1", provider=object(), actor="u1",
        allow_curation_risk=True, allow_mass_delete=True)
    assert [c[0] for c in calls] == ["sync"]
    assert calls[0][1]["allow_curation_risk"] is True
    assert calls[0][1]["allow_mass_delete"] is True


# ── routes: only a workspace admin may override ──────────────────────────────

class _Versioning:
    def __init__(self, raises=None):
        self.calls = []
        self.raises = raises

    async def get_graph(self, graph_id):
        return {"graph_id": graph_id, "workspace_id": WS, "data_source_id": "ds1",
                "provider_id": None}

    async def sync_ingest(self, **kw):
        self.calls.append(kw)
        if self.raises is not None:
            raise self.raises
        return {"commit_id": None, "applied": 0, "rejected": [], "idempotent_replay": False,
                "overrides": []}


@pytest.fixture
def app():
    from backend.app.main import app as _app
    yield _app
    _app.dependency_overrides.pop(get_versioning_service, None)


def _install(app, svc, claims=None):
    app.dependency_overrides[get_versioning_service] = lambda: svc
    if claims is not None:
        app.dependency_overrides[get_permission_claims] = lambda: claims


def _needs_admin(resp):
    assert resp.status_code == 403, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "needs_admin" and detail["error"] == "missing_permission"
    assert detail["permission"] == "workspace:admin"
    assert detail["scope"] == {"type": "workspace", "id": WS}


@pytest.mark.parametrize("flag", ["force", "allowMassDelete"])
async def test_sync_route_override_requires_workspace_admin(test_client, app, flag):
    svc = _Versioning()
    _install(app, svc, _MANAGER)
    _needs_admin(await test_client.post(
        f"/api/v1/{WS}/versioning/graphs/g1/sync?{flag}=true", content=b""))
    assert svc.calls == []


@pytest.mark.parametrize("flag", ["force", "allowMassDelete"])
async def test_an_api_key_cannot_override(test_client, app, flag):
    """Keys can never hold workspace:admin, so scripted callers cannot override either. Nor can
    they hold publish, so they are refused a sync before the override is looked at."""
    svc = _Versioning()
    _install(app, svc, PermissionClaims(
        sid="", ws_perms={WS: ("workspace:datasource:read", "workspace:datasource:manage")},
        key_scope=KeyScope(key_id="k", data="write", all_resources=True)))
    resp = await test_client.post(f"/api/v1/{WS}/versioning/graphs/g1/sync?{flag}=true", content=b"")
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"]["permission"] == "workspace:datasource:publish"
    assert svc.calls == []


async def test_unknown_workspace_grants_answer_503_not_403():
    """No source could say what the caller holds in this workspace: ask again, not 'you may not'."""
    from types import SimpleNamespace

    from fastapi import HTTPException

    from backend.app.api.v1.versioning_gate import sync_override_gate

    with pytest.raises(HTTPException) as refused:
        await sync_override_gate(
            SimpleNamespace(path_params={"ws_id": WS}), force=True, allowMassDelete=False,
            user=SimpleNamespace(id="u1"),
            claims=PermissionClaims(sid="sess_test", ws_available=False))
    assert refused.value.status_code == 503


async def test_without_a_flag_a_manager_syncs_and_an_admin_override_passes(test_client, app):
    svc = _Versioning()
    _install(app, svc, _MANAGER)
    resp = await test_client.post(f"/api/v1/{WS}/versioning/graphs/g1/sync", content=b"")
    assert resp.status_code == 200, resp.text
    assert resp.json()["overrides"] == []
    assert (svc.calls[0]["allow_curation_risk"], svc.calls[0]["allow_mass_delete"]) == (False, False)

    _install(app, svc, PermissionClaims(sid="sess_test", ws_perms={
        WS: (*_MANAGER.ws_perms[WS], "workspace:admin")}))
    resp = await test_client.post(
        f"/api/v1/{WS}/versioning/graphs/g1/sync?force=true&allowMassDelete=true", content=b"")
    assert resp.status_code == 200, resp.text
    assert (svc.calls[1]["allow_curation_risk"], svc.calls[1]["allow_mass_delete"]) == (True, True)


@pytest.mark.parametrize("exc, kind", [
    (CurationAtRisk("x", last_human_commit={"id": "cmt_1"}), "curation_at_risk"),
    (MassDeleteBlocked(900, 500, "x", live=1_000), "mass_delete_blocked"),
])
async def test_a_refused_sync_is_409(test_client, app, exc, kind):
    _install(app, _Versioning(raises=exc))
    resp = await test_client.post(f"/api/v1/{WS}/versioning/graphs/g1/sync", content=b"")
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["type"] == kind
    if kind == "curation_at_risk":
        assert detail["lastHumanCommit"]["id"] == "cmt_1"
    else:
        assert (detail["deletes"], detail["live"], detail["limit"]) == (900, 1_000, 500)


async def _seed_source(db_session):
    from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM, WorkspaceORM

    # The data-plane gate checks that dataSourceId belongs to the path workspace first.
    db_session.add(WorkspaceORM(id=WS, name="Sync guard WS"))
    db_session.add(ProviderORM(id="prov_sg", name="P", provider_type="falkordb"))
    db_session.add(WorkspaceDataSourceORM(
        id="ds_x", workspace_id=WS, provider_id="prov_sg", graph_name="g_x"))
    await db_session.commit()


@pytest.mark.parametrize("flag", ["force", "allowMassDelete"])
async def test_resync_route_override_requires_workspace_admin(
        test_client, app, db_session, monkeypatch, flag):
    """The refusal comes before the route builds a provider or resolves the graph."""
    await _seed_source(db_session)

    async def _resolve(*_a, **_kw):
        raise AssertionError("the route resolved the graph before checking the override")
    monkeypatch.setattr(GraphVersioningService, "resolve_graph", _resolve)
    _install(app, _Versioning(), _MANAGER)
    _needs_admin(await test_client.post(f"/api/v1/{WS}/graph/resync?dataSourceId=ds_x&{flag}=true"))


async def test_resync_records_the_overrides_it_used(monkeypatch):
    from backend.app.api.v1 import versioning_gate
    from backend.app.api.v1.endpoints import graph as graph_ep
    from backend.app.services.versioning import service as svc_mod

    seen = {}

    class _Svc:
        async def resolve_graph(self, **_kw):
            return {"graph_id": "g1"}

        async def resync_from_provider(self, **kw):
            seen.update(kw)
            return {"commit_id": "c1", "overrides": ["curation_at_risk"]}

    async def _record(_session, action, _ds, details):
        seen["record"] = (action, details)
    monkeypatch.setattr(svc_mod, "GraphVersioningService", _Svc)
    monkeypatch.setattr(graph_ep, "_record_versioning", _record)
    await graph_ep.resync_versioned_graph_endpoint(
        ws_id="ws1", dataSourceId="ds1", strategy="merge", _gate=None, _perm=None, user=None,
        overrides=versioning_gate.SyncOverrides(force=True, allow_mass_delete=False),
        engine=type("_E", (), {"provider": None})(), session=None)
    assert (seen["allow_curation_risk"], seen["allow_mass_delete"]) == (True, False)
    assert seen["record"] == ("workspace.versioning.resynced",
                              {"strategy": "merge", "commitId": "c1",
                               "overrides": ["curation_at_risk"]})
