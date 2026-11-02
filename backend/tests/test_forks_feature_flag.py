"""Forks are opt-in: ``forksEnabled`` (Admin → Features) ships off, and a fork is read-only while it is.

While the switch is off nothing new happens in a fork: none is made, nothing is written to a fork's
graph or its drafts, and the reviews a fork opens are neither opened, approved nor merged. Winding
one down still works — listing and reading it, moving it to the trash and back, closing its review —
and nothing is deleted, so turning the switch back on restores every fork as it was.

These drive the gates over HTTP with the versioning store stubbed (``get_versioning_service``), so
they need no database server. The same flows against Postgres are in
``integration/test_forks_feature_flag.py``.
"""
from __future__ import annotations

import time
from types import SimpleNamespace

import pytest

from backend.app.api.v1.endpoints import graph as G
from backend.app.api.v1.endpoints import versioning as V
from backend.app.config.feature_wiring import FEATURE_WIRING
from backend.app.config.features_seed import REFUSAL_MESSAGES, SEED_DEFINITIONS
from backend.app.services.feature_flags import FeatureDisabledError, feature_flags

WS = "ws_fk"
REFUSAL = ("Forks are turned off for this deployment. "
           "An administrator can turn them on under Admin → Features.")
#: ``g1`` is a data source's graph and ``f1`` its fork.
_GRAPHS = {
    "g1": {"graph_id": "g1", "workspace_id": WS, "data_source_id": "ds_p", "fork_parent_graph_id": None},
    "f1": {"graph_id": "f1", "workspace_id": WS, "data_source_id": "dsfork_f1",
           "fork_parent_graph_id": "g1"},
}
#: A fork's review into its parent (``pr_f``: no source graph, as ``open_pr`` stores one), a draft's
#: review on the fork (``pr_df``), and a draft's review on the parent (``pr_d``).
_PRS = {
    "pr_f": {"pr_id": "pr_f", "graph_id": "f1", "source_graph_id": None, "source_branch_id": "br_fm",
             "target_graph_id": "g1", "actor": "u_other", "reviewers": None},
    "pr_df": {"pr_id": "pr_df", "graph_id": "f1", "source_graph_id": "f1", "source_branch_id": "br_fd",
              "target_graph_id": "f1", "actor": "u_other", "reviewers": None},
    "pr_d": {"pr_id": "pr_d", "graph_id": "g1", "source_graph_id": "g1", "source_branch_id": "br_d",
             "target_graph_id": "g1", "actor": "u_other", "reviewers": None},
}


class _Store:
    """The versioning store as far as the gates read it. Anything else the route asks of it is
    recorded in ``reached`` — the request got past every gate — and refused as unknown."""

    def __init__(self):
        self.reached: list[str] = []

    async def get_graph(self, graph_id):
        return _GRAPHS.get(graph_id)

    async def get_pr(self, pr_id):
        return dict(_PRS[pr_id]) if pr_id in _PRS else None

    async def assert_branch_readable(self, **_kw):
        return None

    def __getattr__(self, name):
        async def _reached(*_args, **_kwargs):
            self.reached.append(name)
            raise ValueError(f"{name}: not in this store")
        return _reached


@pytest.fixture
def store():
    from backend.app.main import app

    s = _Store()
    app.dependency_overrides[V.get_versioning_service] = lambda: s
    yield s
    app.dependency_overrides.pop(V.get_versioning_service, None)


def _refused(resp) -> bool:
    """The forks switch's own 403, word for word."""
    return resp.status_code == 403 and resp.json().get("detail") == {
        "type": "feature_disabled", "feature": "forksEnabled", "message": REFUSAL}


def _not_by_forks(resp) -> bool:
    detail = resp.json().get("detail") if resp.headers.get("content-type", "").startswith(
        "application/json") else None
    return not (isinstance(detail, dict) and detail.get("feature") == "forksEnabled")


_V = f"/api/v1/{WS}/versioning"


# ── the switch ───────────────────────────────────────────────────────────────────────────────
def test_forks_ship_off_in_the_lineage_category_beside_version_control():
    defs = [d for d in SEED_DEFINITIONS if d["category_id"] == "lineage"]
    forks = next(d for d in defs if d["key"] == "forksEnabled")
    assert (forks["name"], forks["type"], forks["default_value"]) == ("Forks", "boolean", "false")
    order = [d["key"] for d in sorted(defs, key=lambda d: d["sort_order"])]
    assert order[:2] == ["versioningEnabled", "forksEnabled"]
    assert "Version control" in forks["admin_hint"]
    assert "parent" in forks["impact_when_off"]
    assert REFUSAL_MESSAGES["forksEnabled"] == REFUSAL
    wiring = FEATURE_WIRING["forksEnabled"]
    # A preview, so it may ship off; still enforced by the server, never by the UI alone.
    assert (wiring.stage, wiring.posture) == ("experimental", "capability")
    assert wiring.enforced_server_side and wiring.depends_on == ("versioningEnabled",)


# ── off by default: nothing new happens in a fork ────────────────────────────────────────────
async def test_making_a_fork_is_refused_while_forks_are_off(test_client, store):
    for parent in ("g1", "f1"):                  # a data source's graph, and a fork of a fork
        assert _refused(await test_client.post(f"{_V}/graphs/{parent}/forks", json={}))
    assert store.reached == []


@pytest.mark.parametrize("method, path", [
    ("POST", "/graphs/f1/branches"),
    ("POST", "/graphs/f1/branches/br_fd/changes"),
    ("POST", "/graphs/f1/branches/br_fd/commit"),
    ("POST", "/graphs/f1/branches/br_fd/publish"),
    ("POST", "/graphs/f1/branches/br_fd/rebase"),
    ("PATCH", "/graphs/f1/branches/br_fd"),
    ("POST", "/graphs/f1/branches/br_fd/abandon"),
    ("POST", "/graphs/f1/commits/c1/revert"),
    ("POST", "/graphs/f1/commits/c1/restore"),
    ("POST", "/graphs/f1/bulk-ingest"),
    ("POST", "/graphs/f1/imports"),
    ("POST", "/graphs/f1/pulls"),
    ("POST", "/graphs/f1/branches/br_fd/merge-requests"),
    ("POST", "/pulls/pr_f/approve"),
    ("POST", "/pulls/pr_f/merge"),
    ("PATCH", "/pulls/pr_f"),
    ("POST", "/merge-requests/pr_f/approve"),
    ("POST", "/merge-requests/pr_f/merge"),
    ("POST", "/merge-requests/pr_df/approve"),
    ("POST", "/merge-requests/pr_df/merge"),
])
async def test_a_change_to_a_fork_is_refused_while_forks_are_off(test_client, store, method, path):
    assert _refused(await test_client.request(method, _V + path, json={}))
    assert store.reached == []


async def test_no_draft_opens_on_a_fork_while_forks_are_off(test_client, store):
    assert _refused(await test_client.post(f"{_V}/resolve", json={"dataSourceId": "dsfork_f1"}))
    assert store.reached == []
    resp = await test_client.post(f"{_V}/resolve", json={"dataSourceId": "ds_p"})
    assert _not_by_forks(resp) and store.reached == ["resolve_graph"]


# ── off: reading and winding a fork down still work ──────────────────────────────────────────
@pytest.mark.parametrize("method, path, reached", [
    ("GET", "/graphs/g1/forks", "list_forks"),
    ("GET", "/graphs/f1/commits", "commit_log_page"),
    ("GET", "/graphs/f1/branches", "list_branches"),
    ("GET", "/pulls/pr_f/preview", "preview_pr"),
    ("DELETE", "/graphs/f1", "delete_fork"),
    ("POST", "/graphs/f1/restore", "restore_fork"),
    ("POST", "/merge-requests/pr_f/close", "close_pr"),
    ("POST", "/pulls/pr_f/close", "close_pr"),
    ("POST", "/graphs/f1/lifecycle/freeze", None),
    ("POST", "/graphs/f1/exports", None),
])
async def test_reading_and_winding_down_a_fork_still_work_while_forks_are_off(
        test_client, store, method, path, reached):
    resp = await test_client.request(method, _V + path, json={})
    assert _not_by_forks(resp), resp.text
    if reached:
        assert store.reached[:1] == [reached]


async def test_reviews_and_drafts_of_a_data_source_are_none_of_its_business(test_client, store):
    for path in ("/pulls/pr_d/approve", "/merge-requests/pr_d/merge", "/graphs/g1/branches"):
        assert _not_by_forks(await test_client.post(_V + path, json={}))


# ── on: the same requests pass ───────────────────────────────────────────────────────────────
@pytest.fixture
def _a_parent_row(db_session):
    async def make():
        from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM, WorkspaceORM

        db_session.add_all([WorkspaceORM(id=WS, name="Forks"),
                            ProviderORM(id="prov_fk", name="P", provider_type="falkordb")])
        await db_session.flush()
        db_session.add(WorkspaceDataSourceORM(id="ds_p", workspace_id=WS, provider_id="prov_fk",
                                              graph_name="sales", label="Sales"))
        await db_session.commit()
    return make


async def test_with_forks_on_a_fork_is_made(test_client, store, forks_on, _a_parent_row, monkeypatch):
    from backend.app.services.activity import recorder

    async def _record(*_a, **_kw):
        return True

    async def fork_preflight(**_kw):
        return None

    async def fork_graph(**kw):
        return {"graph_id": "f_new", "data_source_id": kw["data_source_id"],
                "main_branch_id": "br_m", "fork_base_commit_seq": 3}

    monkeypatch.setattr(recorder, "record_for_request", _record)
    store.fork_preflight, store.fork_graph = fork_preflight, fork_graph
    await _a_parent_row()
    resp = await test_client.post(f"{_V}/graphs/g1/forks", json={"name": "Plan"})
    assert resp.status_code == 201, resp.text
    assert resp.json()["dataSourceId"].startswith("dsfork_")


@pytest.mark.parametrize("path, reached", [
    ("/graphs/f1/branches/br_fd/publish", "branch_change_count"),
    ("/graphs/f1/pulls", "open_pr"),
    ("/merge-requests/pr_f/merge", "branch_change_count"),
    ("/merge-requests/pr_df/approve", "approve_pr"),
])
async def test_with_forks_on_a_fork_takes_changes(test_client, store, forks_on, path, reached):
    assert _not_by_forks(await test_client.post(_V + path, json={"message": "m"}))
    assert store.reached[:1] == [reached]


# ── /graph writes, a queued publish, a view import ───────────────────────────────────────────
def _forks(on: bool) -> None:
    feature_flags._cache = {**(feature_flags._cache or {}), "forksEnabled": on}
    feature_flags._cache_ts = time.monotonic()


async def test_a_canvas_write_to_a_fork_is_refused_while_forks_are_off():
    claims = SimpleNamespace(key_scope=None)
    for writes_main in (True, False):            # its main, or a draft on it
        engine = SimpleNamespace(_writes_main=writes_main, _data_source_id="dsfork_f1")
        with pytest.raises(FeatureDisabledError) as refused:
            await G.require_main_writer(ws_id=WS, engine=engine, claims=claims)
        assert (refused.value.feature, refused.value.message) == ("forksEnabled", REFUSAL)
    # Any other data source's draft is left to the route's other gates.
    await G.require_main_writer(
        ws_id=WS, engine=SimpleNamespace(_writes_main=False, _data_source_id="ds_p"), claims=claims)
    _forks(True)
    await G.require_main_writer(
        ws_id=WS, engine=SimpleNamespace(_writes_main=False, _data_source_id="dsfork_f1"), claims=claims)


async def test_a_draft_save_on_a_fork_is_refused_while_forks_are_off(test_client, db_session, monkeypatch):
    """``POST /graph/changes`` — the canvas's save into a draft — on a fork's draft."""
    from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
    from backend.app.main import app
    from backend.app.services.versioning.service import GraphVersioningService

    db_session.add_all([WorkspaceORM(id=WS, name="Forks"),
                        ProviderORM(id="prov_fk", name="P", provider_type="falkordb")])
    await db_session.flush()
    db_session.add(WorkspaceDataSourceORM(id="dsfork_f1", workspace_id=WS, provider_id="prov_fk"))
    await db_session.commit()

    async def by_source(_self, data_source_id):
        return _GRAPHS["f1"] if data_source_id == "dsfork_f1" else None

    applied = []

    async def apply_ops_detailed(_self, **kw):
        applied.append(kw)
        raise ValueError("not in this store")

    monkeypatch.setattr(GraphVersioningService, "get_graph_by_data_source", by_source)
    monkeypatch.setattr(GraphVersioningService, "apply_ops_detailed", apply_ops_detailed)
    app.dependency_overrides[G.get_context_engine] = lambda: SimpleNamespace(
        _writes_main=False, _data_source_id="dsfork_f1")
    try:
        resp = await test_client.post(
            f"/api/v1/{WS}/graph/changes", params={"dataSourceId": "dsfork_f1", "branchId": "br_fd"},
            json={"ops": [{"op": "create", "kind": "node", "payload": {"entityType": "Table"}}]})
        assert _refused(resp) and applied == []
    finally:
        app.dependency_overrides.pop(G.get_context_engine, None)


async def test_a_queued_publish_on_a_fork_is_refused_when_its_job_runs(monkeypatch):
    """A large draft publishes, and a large draft's review merges, as a job: queued while forks
    were on, it refuses as the route would once they are off, and publishes nothing."""
    store = _Store()
    monkeypatch.setattr(V, "get_versioning_service", lambda: store)
    for job in ({"graphId": "f1", "branchId": "br_fd", "actor": "u", "workspaceId": WS},
                {"graphId": "f1", "branchId": "br_fd", "actor": "u", "workspaceId": WS,
                 "mergeRequestId": "pr_df"}):
        assert await V._publish_from_job(job) == {"error": {"status": 403, "detail": {
            "type": "feature_disabled", "feature": "forksEnabled", "message": REFUSAL}}}
    assert store.reached == []


async def test_a_view_import_into_a_forks_draft_is_refused_while_forks_are_off():
    from backend.app.api.v1.endpoints import view_transfer as T
    from backend.app.services.view_transfer import importing

    class _Source:
        async def get_graph_by_data_source(self, data_source_id):
            return _GRAPHS["f1"]

    from backend.app.services.permission_service import PermissionClaims

    claims = PermissionClaims(sid="", global_perms=("system:admin",))
    with pytest.raises(FeatureDisabledError):
        await T._draft_graph(_Source(), importing.Target(WS, "dsfork_f1"), claims)
