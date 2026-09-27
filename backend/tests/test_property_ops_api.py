"""A property operation over HTTP: checked, started as a job, followed and stopped — and never
beside its draft's publish.

``POST …/branches/{bid}/property-ops`` takes the Property Manager's operation and its search,
checks both — a key a user can't own, a value its type can't hold, a path search, a view of another
data source — resolves the view's scope as a search does, and starts the job: 202 with it. While an
operation is being written into a draft, publishing, merging or pulling the draft answers 409.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from backend.app.api.v1.endpoints.versioning import get_import_export_service, get_versioning_service
from backend.app.services.advanced_search_service import AdvancedSearchService, ValidationError
from backend.app.services.view_scope import EffectiveViewScope
from backend.app.services.versioning import config
from backend.app.services.versioning.property_ops import CannotUndo, PropertyOpRunning, PublishRunning
from backend.common.models.search import SearchQuery

BASE = "/api/v1/ws1/versioning/graphs/g1/branches"
OWNER_FINANCE = {"kind": "property", "key": "owner", "op": "contains", "value": "finance"}


class _Versioning:
    def __init__(self):
        self.fork = False
        self.published, self.rebased, self.editable = [], [], []

    async def get_graph(self, graph_id):
        return {"graph_id": graph_id, "workspace_id": "ws1", "data_source_id": "ds1",
                "fork_parent_graph_id": "g0" if self.fork else None}

    async def assert_branch_editable(self, *, graph_id, branch_id, actor):
        self.editable.append(branch_id)
        if branch_id == "br_closed":
            raise ValueError(f"branch {branch_id} is merged")

    async def assert_branch_readable(self, *, graph_id, branch_id, viewer):
        return None

    async def branch_change_count(self, *, graph_id, branch_id):
        return 7

    async def publish(self, **kw):
        self.published.append(kw)
        return "cmt_1"

    async def rebase_draft(self, **kw):
        self.rebased.append(kw)
        return {"clean": True, "conflicts": [], "changes": {}, "incoming": {}, "base_commit_seq": 3,
                "already_up_to_date": True}

    async def get_pr(self, pr_id):
        return {"pr_id": pr_id, "target_graph_id": "g1", "source_branch_id": "br_busy", "actor": "someone"}


def _job(job_id, branch="br_1", **extra):
    return {"jobId": job_id, "kind": "apply", "status": "pending", "graphId": "g1",
            "branchId": branch, **extra}


class _Ops:
    def __init__(self):
        self.created, self.cancelled, self.undone = [], [], []
        self.jobs = {"vjob_1": _job("vjob_1"), "vjob_other": _job("vjob_other", branch="br_2"),
                     "vjob_undone": _job("vjob_undone"), "vjob_busy": _job("vjob_busy")}

    async def create(self, **kw):
        if kw["branch_id"] == "br_opbusy":
            raise PropertyOpRunning("vjob_live")
        if kw["branch_id"] == "br_publishing":
            raise PublishRunning("vjob_pub")
        self.created.append(kw)
        self.jobs["vjob_new"] = _job("vjob_new", branch=kw["branch_id"])
        return "vjob_new"

    async def get(self, job_id):
        return self.jobs.get(job_id)

    async def list(self, *, graph_id, branch_id, limit=20):
        return [j for j in self.jobs.values() if j["branchId"] == branch_id][:limit]

    async def cancel(self, job_id):
        self.cancelled.append(job_id)
        return {**self.jobs[job_id], "cancelRequested": True}

    async def create_undo(self, *, job_id, actor):
        if job_id == "vjob_undone":
            raise CannotUndo("already_undone", "The operation is undone already.")
        if job_id == "vjob_busy":
            raise PropertyOpRunning("vjob_live")
        self.undone.append((job_id, actor))
        self.jobs["vjob_undo"] = _job("vjob_undo", kind="undo", undoOf=job_id)
        return "vjob_undo"

    async def running(self, *, graph_id, branch_id):
        return "vjob_live" if branch_id == "br_busy" else None


class _Jobs:
    def __init__(self):
        self.property_ops = _Ops()
        self.started = []

    async def start_property_op(self, job_id):
        self.started.append(job_id)
        return "running"


@pytest.fixture
def services(monkeypatch):
    from backend.app.main import app

    svc, jobs = _Versioning(), _Jobs()
    scopes = []

    async def scope_for_operation(self, predicate, scope):
        scopes.append((self, predicate, scope))
        if scope.view_id == "v_missing":
            raise ValidationError("view_not_found: v_missing")
        if scope.view_id == "v_elsewhere":
            raise ValidationError("This view belongs to a different data source than the one being searched.")
        return SearchQuery(predicate=predicate, scope={"viewId": scope.view_id, "scopeMode": "view",
                                                       "rootUrns": ["urn:root"]}), "scope-h"

    monkeypatch.setattr(AdvancedSearchService, "scope_for_operation", scope_for_operation)
    app.dependency_overrides[get_versioning_service] = lambda: svc
    app.dependency_overrides[get_import_export_service] = lambda: jobs
    yield SimpleNamespace(svc=svc, jobs=jobs, ops=jobs.property_ops, scopes=scopes)
    app.dependency_overrides.pop(get_versioning_service, None)
    app.dependency_overrides.pop(get_import_export_service, None)


def _body(op, predicate=None, **extra):
    return {"viewId": "v1", "predicate": predicate or OWNER_FINANCE, "op": op, **extra}


async def test_an_operation_starts_a_job_on_the_resolved_scope(test_client, services):
    r = await test_client.post(f"{BASE}/br_1/property-ops", json=_body(
        {"kind": "set", "key": "gvId", "value": "9223372036854775807", "valueType": "number"},
        expectedCount=120))
    assert r.status_code == 202, r.text
    assert r.json()["jobId"] == "vjob_new" and services.jobs.started == ["vjob_new"]
    (created,) = services.ops.created
    assert created["op"] == {"kind": "set", "key": "gvId", "value": 2 ** 63 - 1}
    assert type(created["op"]["value"]) is int, "a 64-bit integer stays exact"
    assert (created["workspace_id"], created["data_source_id"], created["graph_id"], created["branch_id"],
            created["view_id"], created["scope_hash"], created["expected_count"]) == (
        "ws1", "ds1", "g1", "br_1", "v1", "scope-h", 120)
    assert created["query"].scope.root_urns == ["urn:root"], "the job runs on the resolved scope"
    (service, predicate, scope), = services.scopes
    assert (service._workspace_id, service._data_source_id, service._branch_id) == ("ws1", "ds1", "br_1")
    assert scope.view_id == "v1" and scope.scope_mode == "view"
    assert services.svc.editable == ["br_1"]


@pytest.mark.parametrize("op, written", [
    ({"kind": "set", "key": "reviewed", "value": "true", "valueType": "boolean"},
     {"kind": "set", "key": "reviewed", "value": True}),
    ({"kind": "set", "key": "score", "value": "0.25", "valueType": "number"},
     {"kind": "set", "key": "score", "value": 0.25}),
    ({"kind": "fillEmpty", "key": "owner", "value": "42", "valueType": "string"},
     {"kind": "fillEmpty", "key": "owner", "value": "42"}),
    ({"kind": "rename", "key": "owner", "newKey": "steward"},
     {"kind": "rename", "key": "owner", "newKey": "steward"}),
    ({"kind": "remove", "key": "owner", "value": "ignored"}, {"kind": "remove", "key": "owner"}),
])
async def test_the_value_is_written_as_its_type_says(test_client, services, op, written):
    r = await test_client.post(f"{BASE}/br_1/property-ops", json=_body(op))
    assert r.status_code == 202, r.text
    assert services.ops.created[0]["op"] == written


@pytest.mark.parametrize("op", [
    {"kind": "set", "key": "  ", "value": "x", "valueType": "string"},
    {"kind": "set", "key": "k" * 129, "value": "x", "valueType": "string"},
    {"kind": "set", "key": "urn", "value": "x", "valueType": "string"},
    {"kind": "remove", "key": "propertiesRaw"},
    {"kind": "rename", "key": "owner", "newKey": "owner"},
    {"kind": "rename", "key": "owner"},
    {"kind": "rename", "key": "owner", "newKey": "displayName"},
    {"kind": "set", "key": "owner", "value": "x"},
    {"kind": "set", "key": "owner", "value": "   ", "valueType": "string"},
    {"kind": "fillEmpty", "key": "owner", "valueType": "string"},
    {"kind": "set", "key": "size", "value": "abc", "valueType": "number"},
    {"kind": "set", "key": "size", "value": str(2 ** 63), "valueType": "number"},
    {"kind": "set", "key": "flag", "value": "yes", "valueType": "boolean"},
])
async def test_an_operation_that_cannot_be_written_is_refused(test_client, services, op):
    r = await test_client.post(f"{BASE}/br_1/property-ops", json=_body(op))
    assert r.status_code == 422, r.text
    assert services.ops.created == [] and services.jobs.started == []


async def test_a_search_that_cannot_be_used_is_refused(test_client, services):
    remove = {"kind": "remove", "key": "owner"}
    missing = await test_client.post(f"{BASE}/br_1/property-ops", json={**_body(remove), "viewId": "v_missing"})
    assert missing.status_code == 404, missing.text
    elsewhere = await test_client.post(f"{BASE}/br_1/property-ops", json={**_body(remove), "viewId": "v_elsewhere"})
    assert elsewhere.status_code == 422 and "different data source" in elsewhere.text
    assert services.ops.created == []


async def test_the_draft_must_take_it(test_client, services):
    remove = {"kind": "remove", "key": "owner"}
    closed = await test_client.post(f"{BASE}/br_closed/property-ops", json=_body(remove))
    assert closed.status_code == 404 and "merged" in closed.text, closed.text
    busy = await test_client.post(f"{BASE}/br_opbusy/property-ops", json=_body(remove))
    assert busy.status_code == 409 and busy.json()["detail"]["type"] == "property_op_running"
    assert busy.json()["detail"]["jobId"] == "vjob_live"
    publishing = await test_client.post(f"{BASE}/br_publishing/property-ops", json=_body(remove))
    assert publishing.status_code == 409 and publishing.json()["detail"]["type"] == "publish_running"
    services.svc.fork = True
    fork = await test_client.post(f"{BASE}/br_1/property-ops", json=_body(remove))
    assert fork.status_code == 409, fork.text
    assert services.ops.created == []


async def test_a_drafts_operations_are_listed_followed_and_stopped(test_client, services):
    listed = await test_client.get(f"{BASE}/br_1/property-ops")
    assert listed.status_code == 200, listed.text
    assert listed.json() == {"ops": [_job("vjob_1"), _job("vjob_undone"), _job("vjob_busy")],
                             "draftChanges": 7, "maxDraftChanges": config.PROPERTY_OP_MAX_DRAFT_CHANGES}
    one = await test_client.get(f"{BASE}/br_1/property-ops/vjob_1")
    assert one.status_code == 200 and one.json()["jobId"] == "vjob_1"
    for other in ("vjob_other", "vjob_missing"):
        assert (await test_client.get(f"{BASE}/br_1/property-ops/{other}")).status_code == 404
        assert (await test_client.post(f"{BASE}/br_1/property-ops/{other}/cancel")).status_code == 404
    stopped = await test_client.post(f"{BASE}/br_1/property-ops/vjob_1/cancel")
    assert stopped.status_code == 200 and stopped.json()["cancelRequested"] is True
    assert services.ops.cancelled == ["vjob_1"]


async def test_an_operation_is_undone_by_a_job(test_client, services):
    r = await test_client.post(f"{BASE}/br_1/property-ops/vjob_1/undo")
    assert r.status_code == 202, r.text
    assert r.json()["jobId"] == "vjob_undo" and r.json()["undoOf"] == "vjob_1"
    assert services.ops.undone == [("vjob_1", "usr_test000000")], "undone as the caller"
    assert services.jobs.started == ["vjob_undo"]

    undone = await test_client.post(f"{BASE}/br_1/property-ops/vjob_undone/undo")
    assert undone.status_code == 409 and undone.json()["detail"]["type"] == "already_undone", undone.text
    busy = await test_client.post(f"{BASE}/br_1/property-ops/vjob_busy/undo")
    assert busy.status_code == 409 and busy.json()["detail"]["type"] == "property_op_running"
    other = await test_client.post(f"{BASE}/br_1/property-ops/vjob_other/undo")
    assert other.status_code == 404
    assert services.jobs.started == ["vjob_undo"]


async def test_a_draft_being_written_is_not_published_merged_or_pulled(test_client, services):
    publish = await test_client.post(f"{BASE}/br_busy/publish", json={"message": "m"})
    assert publish.status_code == 409 and publish.json()["detail"]["type"] == "property_op_running", publish.text
    pull = await test_client.post(f"{BASE}/br_busy/rebase", json={})
    assert pull.status_code == 409 and pull.json()["detail"]["jobId"] == "vjob_live", pull.text
    merge = await test_client.post("/api/v1/ws1/versioning/merge-requests/mr_1/merge", json={"message": "m"})
    assert merge.status_code == 409, merge.text
    assert services.svc.published == [] and services.svc.rebased == []

    free = await test_client.post(f"{BASE}/br_1/publish", json={"message": "m"})
    assert free.status_code == 200, free.text


# ---------------------------------------------------------------------------
# The search it runs: checked as a search's, on the view's resolved scope
# ---------------------------------------------------------------------------

def _eff(roots=("urn:root",)):
    return EffectiveViewScope(
        view_id="v1", workspace_id="ws1", data_source_id="ds1", canvas_kind="graph",
        root_urns=tuple(roots), entity_type_allow_list=frozenset({"dataset"}),
        layer_allow_list=frozenset(), max_depth=12, scope_hash="scope-1")


def _service(eff=None):
    svc = AdvancedSearchService(None, session=None, workspace_id="ws1")

    async def resolve(requested):
        return eff or _eff()

    async def guard(scope):
        return None

    svc._resolve_scope = resolve
    svc._guard_view_data_source = guard
    return svc


def _scope(**extra):
    from backend.common.models.search import SearchScope
    return SearchScope.model_validate({"viewId": "v1", "scopeMode": "view", **extra})


def _predicate(p):
    from pydantic import TypeAdapter

    from backend.common.models.search import Predicate
    return TypeAdapter(Predicate).validate_python(p)


async def test_the_operations_search_runs_on_the_views_resolved_scope():
    query, scope_hash = await _service().scope_for_operation(_predicate(OWNER_FINANCE), _scope())
    assert scope_hash == "scope-1"
    assert query.scope.root_urns == ["urn:root"] and query.scope.entity_types == ["dataset"]
    assert query.predicate.key == "owner"


@pytest.mark.parametrize("predicate, why", [
    ({"kind": "property", "key": "size", "op": "gt", "value": "abc", "valueType": "number"}, "not a number"),
    ({"kind": "group", "op": "and", "children": [
        OWNER_FINANCE, {"kind": "path", "sourceUrns": ["urn:a"], "targetUrns": ["urn:b"]}]}, "path"),
    ({"kind": "group", "op": "and", "children": [OWNER_FINANCE] * 65}, "leaves"),
])
async def test_a_search_an_operation_cannot_use_is_refused(predicate, why):
    with pytest.raises(ValidationError, match=why):
        await _service().scope_for_operation(_predicate(predicate), _scope())


# ---------------------------------------------------------------------------
# The job's context: the published graph's search, once it has caught up
# ---------------------------------------------------------------------------

class _Watermark:
    def __init__(self, fresh):
        self.fresh = fresh

    async def projection_watermark(self, graph_id):
        return {"fresh": self.fresh}

    async def get_graph(self, graph_id):
        return {"graph_id": graph_id, "workspace_id": "ws1", "data_source_id": "ds1"}


@pytest.fixture
def hook(monkeypatch):
    from contextlib import asynccontextmanager

    from backend.app.api.v1.endpoints import graph as graph_mod
    from backend.app.api.v1.endpoints import versioning as ep
    from backend.app.db import engine as db_engine
    from backend.app.providers.manager import provider_manager
    from backend.app.services.context_engine import ContextEngine

    state = SimpleNamespace(svc=_Watermark(True), engine=None, bumped=[], admitted=[])

    @asynccontextmanager
    async def session():
        yield None

    async def for_workspace(ws, manager, sess, *, data_source_id=None, actor=None, branch_id=None):
        assert (ws, data_source_id, branch_id) == ("ws1", "ds1", None), "the published graph"
        return state.engine

    async def containment(sess, ws, ds):
        return ["CONTAINS"]

    async def rules(sess, ws, meta):
        return "rules"

    async def data_version(engine):
        return "7.ns"

    class _Cache:
        async def bump_generation(self, scope):
            state.bumped.append(scope)

    monkeypatch.setattr(ep, "get_versioning_service", lambda: state.svc)
    monkeypatch.setattr(ContextEngine, "for_workspace", for_workspace)
    monkeypatch.setattr(db_engine, "get_async_session", session)
    monkeypatch.setattr(ep, "_live_containment_types", containment)
    monkeypatch.setattr(ep, "_rules_for_meta", rules)
    monkeypatch.setattr(graph_mod, "_search_data_version", data_version)
    monkeypatch.setattr(ep, "get_graph_cache", lambda: _Cache())
    monkeypatch.setattr(provider_manager, "statement_admission",
                        lambda provider: state.admitted.append(provider) or "admit")
    return SimpleNamespace(state=state, run=ep._property_op_context)


JOB = {"jobId": "vjob_1", "graphId": "g1", "branchId": "br_1", "workspaceId": "ws1",
       "dataSourceId": "ds1", "actor": "alice", "scopeHash": "scope-h"}


class _Searchable:
    async def deep_search_scan(self, query, *, context, cap):
        return None


async def test_the_job_searches_the_published_graph_once_it_has_caught_up(hook):
    provider = _Searchable()
    hook.state.engine = SimpleNamespace(provider=provider)
    ctx = await hook.run(JOB)
    assert ctx.provider is provider and ctx.containment_edge_types == ["CONTAINS"]
    assert ctx.ontology_rules == "rules" and hook.state.admitted == [provider]
    assert (ctx.run_context.data_version, ctx.run_context.scope_hash) == ("7.ns", "scope-h")
    assert ctx.run_context.admit == "admit", "each statement is admitted as a search's"
    await ctx.on_written()
    (scope,) = hook.state.bumped
    assert (scope.workspace_id, scope.data_source_id, scope.branch_id) == ("ws1", "ds1", "br_1")


async def test_the_job_waits_while_the_published_graph_catches_up(hook):
    hook.state.svc.fresh = False
    assert await hook.run(JOB) is None
    hook.state.svc.fresh = True
    hook.state.engine = SimpleNamespace(provider=_Searchable(), _branch_id="br_main")   # stale again
    assert await hook.run(JOB) is None


async def test_an_undo_searches_nothing_so_it_does_not_wait(hook):
    hook.state.svc.fresh = False
    ctx = await hook.run({**JOB, "kind": "undo"})
    assert ctx is not None and ctx.provider is None and ctx.run_context is None
    assert ctx.containment_edge_types == ["CONTAINS"] and ctx.ontology_rules == "rules"


async def test_a_graph_that_cannot_be_searched_fails_the_job(hook):
    hook.state.engine = SimpleNamespace(provider=SimpleNamespace())
    with pytest.raises(RuntimeError, match="can't be searched"):
        await hook.run(JOB)
