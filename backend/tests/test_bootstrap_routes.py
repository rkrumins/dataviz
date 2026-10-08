"""The bootstrap routes answer a refused user action with a 409 the UI can act on.

What a person may do to an enablement job depends on its state: retry only a job that has
stopped, resume only what can resume (an integrity failure needs a fresh read), enable again
only once an abandoned attempt has been cleaned up. ``bootstrap_worker`` decides; the route
must carry the decision through as ``{type, message[, action]}`` — not a 500, not a bare string
the UI would have to parse.
"""
import time

import pytest
from httpx import AsyncClient

from backend.app.db import models as _models
from backend.app.services.feature_flags import feature_flags
from backend.app.services.versioning import bootstrap_worker
from backend.app.services.versioning.bootstrap_worker import BootstrapConflict

WS = "ws_boot_routes"
DS = "ds_boot_routes"


@pytest.fixture(autouse=True)
def _flag_on():
    feature_flags._cache = {"versioningEnabled": True}
    feature_flags._cache_ts = time.monotonic()
    yield
    feature_flags.invalidate()


@pytest.fixture()
async def _data_source(db_session):
    db_session.add(_models.WorkspaceDataSourceORM(
        id=DS, workspace_id=WS, label="Mine", graph_name="my_graph", provider_id="default"))
    await db_session.commit()


def _refusing(kind, **extra):
    async def refuse(**_kw):
        raise BootstrapConflict(kind, "refused", **extra)
    return refuse


_DECISION = {"action": "collapse", "fingerprint": "f" * 32}


@pytest.mark.parametrize("path, target, kind, extra", [
    (f"/api/v1/{WS}/graph/bootstrap?dataSourceId={DS}",
     "create_bootstrap_job", "cleanup_in_progress", {}),
    (f"/api/v1/{WS}/graph/bootstrap/retry?dataSourceId={DS}&mode=restart",
     "retry_bootstrap", "job_active", {}),
    (f"/api/v1/{WS}/graph/bootstrap/retry?dataSourceId={DS}&mode=resume",
     "retry_bootstrap", "resume_not_possible", {"action": "restart"}),
    (f"/api/v1/{WS}/graph/bootstrap/decision?dataSourceId={DS}",
     "decide_duplicates", "not_awaiting_decision", {}),
    (f"/api/v1/{WS}/graph/bootstrap/decision?dataSourceId={DS}",
     "decide_duplicates", "stale_decision", {"fingerprint": "e" * 32}),
])
async def test_a_refused_action_is_a_409_the_ui_can_act_on(
    test_client: AsyncClient, _data_source, monkeypatch, path, target, kind, extra,
):
    monkeypatch.setattr(bootstrap_worker, target, _refusing(kind, **extra))
    resp = await test_client.post(path, json=_DECISION if "decision" in path else None)
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == {"type": kind, "message": "refused", **extra}


async def test_enabling_again_reports_a_failed_job_with_what_can_be_done(
    test_client: AsyncClient, _data_source, monkeypatch,
):
    failure = {"code": "integrity", "action": "restart", "phase": "validate", "reason": "x"}

    async def existing(**_kw):
        return {"graph_id": "g1", "job_id": "j1", "status": "failed", "failure": failure}
    monkeypatch.setattr(bootstrap_worker, "create_bootstrap_job", existing)
    resp = await test_client.post(f"/api/v1/{WS}/graph/bootstrap?dataSourceId={DS}")
    assert resp.json() == {"jobId": "j1", "graphId": "g1", "status": "failed",
                           "failure": failure}


async def test_abandon_reports_the_purge_it_queued(
    test_client: AsyncClient, _data_source, monkeypatch,
):
    seen = {}

    async def abandon(**kw):
        seen.update(kw)
        return {"jobId": "j1", "status": "cancelled", "purgeJobId": "p1"}
    monkeypatch.setattr(bootstrap_worker, "abandon_bootstrap", abandon)
    resp = await test_client.post(f"/api/v1/{WS}/graph/bootstrap/abandon?dataSourceId={DS}")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"jobId": "j1", "status": "cancelled", "purgeJobId": "p1"}
    assert seen["actor"] != "system", "the purge records who abandoned the job"


# ── duplicate identifiers: the list, the decision, and who else reads the graph ──

@pytest.fixture()
async def _shared(db_session, _data_source):
    """Three more data sources on the same physical graph — one in this workspace (as its
    dedicated projection key), one live and one deleted in another — and one on another graph."""
    db_session.add_all([
        _models.WorkspaceDataSourceORM(id="ds_our_reader", workspace_id=WS, label="Ours",
                                       graph_name="my_graph_3", dedicated_graph_name="my_graph",
                                       provider_id="default"),
        _models.WorkspaceDataSourceORM(id="ds_other_reader", workspace_id="ws_other",
                                       label="Theirs", graph_name="my_graph",
                                       provider_id="default"),
        _models.WorkspaceDataSourceORM(id="ds_gone_reader", workspace_id="ws_other",
                                       label="Gone", graph_name="my_graph", provider_id="default",
                                       deleted_at="2026-10-01T00:00:00+00:00"),
        _models.WorkspaceDataSourceORM(id="ds_elsewhere", workspace_id=WS, label="Elsewhere",
                                       graph_name="my_graph_2", provider_id="default"),
    ])
    await db_session.commit()


def _paused(**over):
    async def status(**_kw):
        return {"jobId": "j1", "status": "needs_decision", "phase": "awaiting_decision",
                "duplicates": {"identifiers": 1, "extraCopies": 1, "fingerprint": "f" * 32,
                               "sample": [], "decision": None, "sharedWith": []}, **over}
    return status


async def test_the_status_says_who_else_reads_the_graph_a_collapse_changes(
    test_client: AsyncClient, _shared, monkeypatch,
):
    monkeypatch.setattr(bootstrap_worker, "bootstrap_status", _paused())
    resp = await test_client.get(f"/api/v1/{WS}/graph/bootstrap/status?dataSourceId={DS}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["duplicates"]["sharedWith"] == [
        {"dataSourceId": "ds_our_reader", "name": "Ours"}]
    # Another workspace's reader is counted, never named: a workspace does not learn another's
    # data sources.
    assert resp.json()["duplicates"]["sharedWithOtherWorkspaces"] == 1
    assert "Theirs" not in resp.text and "ds_other_reader" not in resp.text


async def test_resolve_carries_a_job_paused_for_a_decision(
    test_client: AsyncClient, _shared, monkeypatch,
):
    """A pause can last days; for all of it the graph is parked at genesis, and without the job
    the UI would read it as versioned (export its empty main, edit into a 409)."""
    from backend.app.api.v1.endpoints.versioning import get_versioning_service
    from backend.app.main import app

    class _Versioning:
        async def resolve_graph(self, **_kw):
            return {"graph_id": "g1", "main_branch_id": "main1", "main_head_commit_seq": 1}

    monkeypatch.setattr(bootstrap_worker, "bootstrap_status", _paused())
    app.dependency_overrides[get_versioning_service] = _Versioning
    try:
        resp = await test_client.get(f"/api/v1/{WS}/versioning/resolve?dataSourceId={DS}")
    finally:
        app.dependency_overrides.pop(get_versioning_service, None)
    assert resp.status_code == 200, resp.text
    boot = resp.json()["bootstrap"]
    assert boot["status"] == "needs_decision"
    assert boot["duplicates"]["sharedWith"] == [{"dataSourceId": "ds_our_reader", "name": "Ours"}]
    assert boot["duplicates"]["sharedWithOtherWorkspaces"] == 1


async def test_the_duplicate_list_comes_in_pages_and_as_a_download(
    test_client: AsyncClient, _data_source, monkeypatch,
):
    seen = {}

    async def page(**kw):
        seen.update(kw)
        return {"items": [{"urn": "urn:a", "copy": 1, "kept": True}], "next": "c2"}

    async def csv_rows(**_kw):
        async def rows():
            yield "urn,copy,kept,reason,label,internal_id,last_synced_at\r\n"
            yield "urn:a,1,yes,kept,Table,2,\r\n"
        return rows()

    monkeypatch.setattr(bootstrap_worker, "duplicate_page", page)
    monkeypatch.setattr(bootstrap_worker, "duplicates_csv", csv_rows)
    base = f"/api/v1/{WS}/graph/bootstrap/duplicates?dataSourceId={DS}"
    resp = await test_client.get(base + "&after=c1&limit=50")
    assert resp.status_code == 200, resp.text
    assert resp.json()["next"] == "c2" and (seen["after"], seen["limit"]) == ("c1", 50)
    resp = await test_client.get(base + "&format=csv")
    assert resp.status_code == 200 and resp.headers["content-type"].startswith("text/csv")
    assert "attachment" in resp.headers["content-disposition"]
    assert resp.text.splitlines()[1] == "urn:a,1,yes,kept,Table,2,"
    assert (await test_client.get(base + "&limit=501")).status_code == 422


async def test_a_view_link_does_not_reach_the_whole_duplicate_list(
    test_client: AsyncClient, db_session, _data_source, monkeypatch,
):
    """The graph router admits a view-capability caller (``require_ds_read_or_view``). The list
    enumerates the whole data source — more than a view's reach, as the graph export decides — so
    it takes workspace read membership of its own."""
    from backend.app.services.permission_service import PermissionClaims
    from backend.tests.test_views_scoping_regressions import _auth, _user

    db_session.add_all([
        _models.WorkspaceORM(id=WS, name="Boot routes"),
        _models.ViewORM(id="view_boot_ent", name="ent", workspace_id=WS, data_source_id=DS,
                        visibility="enterprise", created_by="usr_author"),
    ])
    await db_session.commit()

    async def page(**_kw):
        return {"items": [], "next": None}
    monkeypatch.setattr(bootstrap_worker, "duplicate_page", page)
    monkeypatch.setattr(bootstrap_worker, "bootstrap_status", _paused())
    url = f"/api/v1/{WS}/graph/bootstrap/duplicates?dataSourceId={DS}&viewId=view_boot_ent"
    with _auth(user=_user("usr_outsider"), claims=PermissionClaims(sid="s_outsider")):
        status = await test_client.get(
            f"/api/v1/{WS}/graph/bootstrap/status?dataSourceId={DS}&viewId=view_boot_ent")
        assert status.status_code == 200, "the link does reach the graph router"
        assert (await test_client.get(url)).status_code == 403
    member = PermissionClaims(sid="s_member", ws_perms={WS: ("workspace:datasource:read",)})
    with _auth(user=_user("usr_member"), claims=member):
        assert (await test_client.get(url)).status_code == 200


async def test_no_duplicates_is_a_404(test_client: AsyncClient, _data_source, monkeypatch):
    async def none(**_kw):
        raise LookupError("enabling version control found no duplicate identifiers here")
    monkeypatch.setattr(bootstrap_worker, "duplicate_page", none)
    resp = await test_client.get(f"/api/v1/{WS}/graph/bootstrap/duplicates?dataSourceId={DS}")
    assert resp.status_code == 404


async def test_a_decision_is_202_with_the_job_and_200_when_already_recorded(
    test_client: AsyncClient, _shared, monkeypatch,
):
    calls = []

    async def decide(**kw):
        calls.append(kw)
        return {"jobId": "j1", "already": len(calls) > 1}

    monkeypatch.setattr(bootstrap_worker, "decide_duplicates", decide)
    monkeypatch.setattr(bootstrap_worker, "bootstrap_status", _paused(status="pending"))
    path = f"/api/v1/{WS}/graph/bootstrap/decision?dataSourceId={DS}"
    first = await test_client.post(path, json=_DECISION)
    assert first.status_code == 202, first.text
    assert first.json()["jobId"] == "j1"
    assert first.json()["duplicates"]["sharedWith"] == [
        {"dataSourceId": "ds_our_reader", "name": "Ours"}]
    assert calls[0]["fingerprint"] == "f" * 32 and calls[0]["actor"] != "system"
    assert (await test_client.post(path, json=_DECISION)).status_code == 200
    bad = await test_client.post(path, json={"action": "keep_all", "fingerprint": "f" * 32})
    assert bad.status_code == 422 and len(calls) == 2
