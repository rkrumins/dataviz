"""A new data source from a view package, through the API — and what becomes of it later.

``POST /views/transfer/packages/{uploadId}/new-source`` provisions a managed data source on the
chosen FalkorDB provider and queues the job that seeds its first version from the upload in place
(``origin: 'package'``): 202, moving no data. It is safe to send again — the same ``requestId``, or
the same target, answers 200 with what the first request made, and finishes what it left undone
(a request that died after making the data source queues its job). One upload makes one source per
workspace. A request that fails to make the version store removes the data source IT made, never
one it found. Later: giving up removes the source; a purge never drops a key anything else reads
(and keeps it when it cannot ask); the reaper tombstones a source that never got its graph.

The graph version store and the job are faked at their boundary (``create_bootstrap_job``); the
per-upload lock and the graph-name claim are Postgres advisory locks, swapped here for in-process
equivalents (the live suite runs the real ones). The seed itself: ``test_package_seed_job.py``.
"""
from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from backend.app.api.v1.endpoints import view_transfer
from backend.app.db.models import OntologyORM, ProviderORM, WorkspaceDataSourceORM
from backend.app.services import managed_sources
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.versioning import bootstrap_worker, purge_worker
from backend.app.services.versioning.bootstrap_worker import BootstrapConflict
from backend.app.services.versioning.import_export import uploads
from backend.tests.test_view_transfer_import import (  # noqa: F401 — graph is a fixture
    _as, _user, _view, _workspace, graph,
)
from backend.tests.test_view_transfer_packages_api import (  # noqa: F401 — fixtures
    _package_file, _upload, services, small_parts,
)

pytestmark = pytest.mark.usefixtures("view_portability_enabled")

_TRANSFER = "/api/v1/views/transfer"
_RID = "nsr_" + "0" * 32
_OTHER_RID = "nsr_" + "1" * 32


class _Seeds:
    """``create_bootstrap_job``, recorded: one job per data source, as the real one keeps it."""

    def __init__(self):
        self.calls: list = []
        self.jobs: dict = {}
        self.fail = None

    async def create(self, **kw):
        self.calls.append(kw)
        if self.fail is not None:
            exc, self.fail = self.fail, None
            raise exc
        ds = kw["data_source_id"]
        if ds not in self.jobs:
            self.jobs[ds] = {"graph_id": f"g_{ds}", "job_id": f"job_{len(self.jobs) + 1}",
                             "status": "pending"}
        return dict(self.jobs[ds])


@pytest.fixture
def seeds(monkeypatch):
    from backend.app.providers.manager import provider_manager

    fake = _Seeds()
    monkeypatch.setattr(bootstrap_worker, "create_bootstrap_job", fake.create)
    locks: dict = {}
    taken: list = []

    @asynccontextmanager
    async def per_upload(upload_id):
        taken.append(upload_id)
        async with locks.setdefault(upload_id, asyncio.Lock()):
            yield

    async def claim(session, provider_id, graph_name):
        verdict = await managed_sources._graph_name_availability(
            session, provider_id, graph_name, suggest=True)
        if not verdict["available"]:
            raise HTTPException(status_code=422, detail={
                "type": "graph_name_unavailable", "message": verdict["reason"],
                "suggestion": verdict.get("suggestion")})
        return str(verdict["normalized"])

    async def no_keys(_provider_id):
        return []

    monkeypatch.setattr(view_transfer, "_per_upload", per_upload)
    monkeypatch.setattr(managed_sources, "claim_graph_name", claim)
    monkeypatch.setattr("backend.app.providers.falkor_graph_registry.list_graph_keys", no_keys)
    fake.locked = taken
    yield fake
    for key in [k for k in provider_manager.warmup_cache if str(k).startswith("prov_ns_")]:
        provider_manager.warmup_cache.pop(key, None)


async def _provider(db_session, kind="falkordb", ok=True, pid=None):
    from backend.app.providers.manager import provider_manager

    prov = ProviderORM(id=pid or f"prov_ns_{kind}_{len(provider_manager.warmup_cache)}",
                       name=f"{kind}-conn", provider_type=kind, host="h", port=6379)
    db_session.add(prov)
    await db_session.flush()
    provider_manager.warmup_cache[prov.id] = {"ok": ok, "reason": None if ok else "host not found"}
    return prov.id


async def _ready_upload(client, jobs, dev) -> str:
    upload = await _upload(client, await _package_file(client, await _view(client, dev)))
    await jobs.inspect_queued()
    return upload


def _ask(ws, provider, **over):
    return {"requestId": _RID, "workspaceId": ws, "providerId": provider, "label": "Finance copy",
            "graphName": "finance_copy", "ontologyId": None, **over}


async def _sources(db_session, ws):
    from sqlalchemy import select
    db_session.expire_all()
    return (await db_session.execute(select(WorkspaceDataSourceORM).where(
        WorkspaceDataSourceORM.workspace_id == ws,
        WorkspaceDataSourceORM.deleted_at.is_(None)))).scalars().all()


# ── Provisioning ─────────────────────────────────────────────────────────────


class _Aggregation:
    """The aggregation service as the app holds it: a trigger rolls the caller's session back when
    it has a transaction open, as the real one does."""

    def __init__(self):
        self.triggered: list = []

    async def trigger(self, ds_id, _req, _source, session):
        self.triggered.append(ds_id)
        await session.rollback()


async def test_a_new_source_is_provisioned_and_its_seed_queued(
        test_client, db_session, graph, services, small_parts, seeds, monkeypatch):
    from backend.app.main import app

    _versioning, jobs = services
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    prov = await _provider(db_session)
    upload = await _ready_upload(test_client, jobs, dev)
    stored = sorted(p for p in jobs.store._root.rglob("*") if p.is_file())
    agg = _Aggregation()
    monkeypatch.setattr(app.state, "aggregation_service", agg, raising=False)

    resp = await test_client.post(f"{_TRANSFER}/packages/{upload}/new-source", json=_ask(uat, prov))
    assert resp.status_code == 202, resp.text
    # A job dispatched now would run on the still-empty key and leave its marker there; the seed's
    # finalize queues the first rollup build instead.
    assert agg.triggered == [], "no aggregation before the copy is live"
    [ds] = await _sources(db_session, uat)
    assert resp.json() == {"dataSourceId": ds.id, "graphId": f"g_{ds.id}", "jobId": "job_1",
                           "status": "pending", "label": "Finance copy", "graphName": "finance_copy",
                           "ontologyId": None, "enforcement": "permissive", "requestId": _RID}
    assert (ds.provider_id, ds.graph_name, ds.source_mode, ds.catalog_item_id) == \
        (prov, "finance_copy", "managed", None)
    origin = json.loads(ds.extra_config)["origin"]
    assert {k: origin[k] for k in ("kind", "uploadId", "requestId")} == \
        {"kind": "viewPackage", "uploadId": upload, "requestId": _RID}
    assert origin["bundleHash"].startswith("sha256:") and origin["createdAt"]
    assert "sourceEnvironment" in origin and "sourceDataSource" in origin
    assert seeds.locked == [upload], "serialized per upload"

    [call] = seeds.calls
    assert {k: call[k] for k in ("data_source_id", "workspace_id", "falkor_graph_name",
                                 "falkor_provider", "origin", "upload_id", "payload_uri",
                                 "ontology_enforcement", "base_ontology_id")} == {
        "data_source_id": ds.id, "workspace_id": uat, "falkor_graph_name": "finance_copy",
        "falkor_provider": prov, "origin": "package", "upload_id": upload,
        "payload_uri": f"transfer-uploads/{upload}/upload.json", "ontology_enforcement": "permissive",
        "base_ontology_id": None}
    assert call["package"]["integrity"] == "verified" and call["package"]["scope"] == "view"
    assert call["package"]["manifest"] == {"nodes": 2, "edges": 0, "version": "published"}
    assert call["package"]["typeStats"]["entityTypeCounts"] == {"dataset": 2}
    assert call["coverage"] is None, "no semantic layer, nothing to cover"

    now = sorted(p for p in jobs.store._root.rglob("*") if p.is_file())
    assert [p.name for p in now if p not in stored] == ["new-source.json"], \
        "no data moved: only the hint beside the upload"
    hint = json.loads((jobs.store._root / "transfer-uploads" / upload / "new-source.json").read_text())
    assert hint["dataSourceId"] == ds.id and hint["requestId"] == _RID


async def test_asking_again_answers_with_what_the_first_made(
        test_client, db_session, graph, services, small_parts, seeds):
    _versioning, jobs = services
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    prov = await _provider(db_session)
    upload = await _ready_upload(test_client, jobs, dev)
    url = f"{_TRANSFER}/packages/{upload}/new-source"
    first = await test_client.post(url, json=_ask(uat, prov))
    assert first.status_code == 202

    again = await test_client.post(url, json=_ask(uat, prov))
    assert again.status_code == 200 and again.json() == first.json()
    # A fresh browser (another requestId) asking for the same target: the same source.
    same_target = await test_client.post(url, json=_ask(uat, prov, requestId=_OTHER_RID,
                                                        graphName="FINANCE_COPY"))
    assert same_target.status_code == 200 and same_target.json() == first.json()
    # Another target from the same upload, in the same workspace: refused, naming the first.
    other = await test_client.post(url, json=_ask(uat, prov, requestId=_OTHER_RID,
                                                 graphName="another_copy"))
    assert other.status_code == 409 and other.json()["detail"]["type"] == "upload_consumed"
    assert other.json()["detail"]["dataSourceId"] == first.json()["dataSourceId"]
    assert len(await _sources(db_session, uat)) == 1 and len(seeds.jobs) == 1


async def test_a_request_that_died_after_the_data_source_is_finished_by_the_retry(
        test_client, db_session, graph, services, small_parts, seeds):
    """The first request committed the data source and died before queueing its seed. The retry
    reuses that source and queues it; a failure then compensates nothing it didn't make."""
    _versioning, jobs = services
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    prov = await _provider(db_session)
    upload = await _ready_upload(test_client, jobs, dev)
    url = f"{_TRANSFER}/packages/{upload}/new-source"

    # What the first request left: its data source, committed, and nothing in the version store.
    await managed_sources.create_managed_data_source(
        db_session, uat, provider_id=prov, ontology_id=None, label="Finance copy",
        actor="usr_test000000", graph_name="finance_copy",
        origin={"kind": "viewPackage", "uploadId": upload, "requestId": _RID})
    [ds] = await _sources(db_session, uat)

    seeds.fail = RuntimeError("graphver is down")
    failed = await test_client.post(url, json=_ask(uat, prov))
    assert failed.status_code == 502 and failed.json()["detail"]["type"] == "provisioning_failed"
    assert [d.id for d in await _sources(db_session, uat)] == [ds.id], \
        "a data source this request found is never compensated away"

    retry = await test_client.post(url, json=_ask(uat, prov))
    assert retry.status_code == 200, retry.text
    assert retry.json()["dataSourceId"] == ds.id and retry.json()["jobId"] == "job_1"


async def test_a_failed_version_store_removes_the_data_source_this_request_made(
        test_client, db_session, graph, services, small_parts, seeds):
    versioning, jobs = services
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    prov = await _provider(db_session)
    upload = await _ready_upload(test_client, jobs, dev)
    url = f"{_TRANSFER}/packages/{upload}/new-source"

    seeds.fail = RuntimeError("boom")
    resp = await test_client.post(url, json=_ask(uat, prov))
    assert resp.status_code == 502 and resp.json()["detail"]["type"] == "provisioning_failed"
    assert await _sources(db_session, uat) == [], "nothing was kept"

    # A graph for it already exists (its job is the one to give up): not removed.
    ok = await test_client.post(url, json=_ask(uat, prov))
    ds_id = ok.json()["dataSourceId"]
    versioning.track(uat, ds_id)
    seeds.jobs.clear()
    seeds.fail = RuntimeError("boom")
    assert (await test_client.post(url, json=_ask(uat, prov))).status_code == 502
    assert [d.id for d in await _sources(db_session, uat)] == [ds_id]

    seeds.fail = BootstrapConflict("ds_has_other_job", "taken")
    resp = await test_client.post(url, json=_ask(uat, prov))
    assert resp.status_code == 409 and resp.json()["detail"]["type"] == "ds_has_other_job"


async def test_a_new_source_may_bind_a_draft_semantic_layer_it_can_see(
        test_client, db_session, graph, services, small_parts, seeds):
    _versioning, jobs = services
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    prov = await _provider(db_session)
    draft = OntologyORM(name="From the package", is_published=False,
                        entity_type_definitions=json.dumps({"dataset": {"name": "dataset"}}))
    gone = OntologyORM(name="Gone", deleted_at="2026-01-01T00:00:00+00:00")
    db_session.add_all([draft, gone])
    await db_session.flush()
    draft_id, gone_id = draft.id, gone.id
    upload = await _ready_upload(test_client, jobs, dev)
    url = f"{_TRANSFER}/packages/{upload}/new-source"

    for bad in ("bp_nope", gone_id):
        resp = await test_client.post(url, json=_ask(uat, prov, ontologyId=bad))
        assert resp.status_code == 422 and resp.json()["detail"]["type"] == "ontology_unknown"
    # One the caller can't see reads as one that isn't there.
    member = PermissionClaims(sid="s_m", ws_perms={uat: ("workspace:datasource:manage",)})
    with _as(_user("usr_test000000"), member):
        resp = await test_client.post(url, json=_ask(uat, prov, ontologyId=draft_id))
        assert resp.status_code == 422 and resp.json()["detail"]["type"] == "ontology_unknown"
    # Who may manage layers may bind a draft nothing reads yet ("Create from this package" made
    # it, and no source of theirs shows it them) — never a published one, nor one bound elsewhere.
    published = OntologyORM(name="Theirs", is_published=True)
    bound = OntologyORM(name="Bound", is_published=False)
    db_session.add_all([published, bound])
    await db_session.flush()
    db_session.add(WorkspaceDataSourceORM(workspace_id=dev, provider_id=prov, graph_name="other_g",
                                          ontology_id=bound.id))
    await db_session.flush()
    manager = PermissionClaims(sid="s_om", ws_perms={uat: ("workspace:datasource:manage",
                                                            "workspace:ontology:manage")})
    with _as(_user("usr_test000000"), manager):
        for unseen in (published.id, bound.id):
            resp = await test_client.post(url, json=_ask(uat, prov, ontologyId=unseen))
            assert resp.status_code == 422 and resp.json()["detail"]["type"] == "ontology_unknown"
        assert await _sources(db_session, uat) == [] and not seeds.calls
        resp = await test_client.post(url, json=_ask(uat, prov, ontologyId=draft_id))
        assert resp.status_code == 202, resp.text

    resp = await test_client.post(url, json=_ask(uat, prov, ontologyId=draft_id))
    assert resp.status_code == 200, "the same request again: what the first made"
    assert resp.json()["ontologyId"] == draft_id
    call = seeds.calls[0]
    assert call["base_ontology_id"] == draft_id
    assert call["coverage"]["coveredEntityTypes"] == ["dataset"]
    assert call["coverage"]["uncoveredEntityTypes"] == []


async def test_what_a_new_source_refuses(
        test_client, db_session, graph, services, small_parts, seeds, monkeypatch):
    _versioning, jobs = services
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    prov = await _provider(db_session)
    neo = await _provider(db_session, kind="neo4j")
    down = await _provider(db_session, ok=False)
    upload = await _upload(test_client, await _package_file(test_client, await _view(test_client, dev)))
    url = f"{_TRANSFER}/packages/{upload}/new-source"

    resp = await test_client.post(url, json=_ask(uat, prov))
    assert resp.status_code == 409 and resp.json()["detail"]["type"] == "not_inspected"
    await jobs.inspect_queued()
    assert (await test_client.post(url, json=_ask(uat, prov, requestId="nsr_short"))).status_code == 422
    assert (await test_client.post(url, json=_ask("ws_nope", prov))).status_code == 404
    resp = await test_client.post(url, json=_ask(uat, neo))
    assert resp.status_code == 422 and resp.json()["detail"]["type"] == "provider_unsupported"
    resp = await test_client.post(url, json=_ask(uat, down))
    assert resp.status_code == 422 and resp.json()["detail"]["type"] == "provider_unreachable"
    db_session.add(WorkspaceDataSourceORM(workspace_id=dev, provider_id=prov, graph_name="taken_name"))
    await db_session.flush()
    resp = await test_client.post(url, json=_ask(uat, prov, graphName="taken_name"))
    assert resp.status_code == 422 and resp.json()["detail"]["type"] == "graph_name_unavailable"
    assert resp.json()["detail"]["suggestion"] == "taken_name_2"
    resp = await test_client.post(url, json=_ask(uat, prov, graphName="gv_reserved"))
    assert resp.status_code == 422 and resp.json()["detail"]["type"] == "graph_name_unavailable"

    viewer = PermissionClaims(sid="s_v", ws_perms={uat: ("workspace:datasource:read",)})
    with _as(_user("usr_test000000"), viewer):
        assert (await test_client.post(url, json=_ask(uat, prov))).status_code == 403
    someone = PermissionClaims(sid="s_o", ws_perms={uat: ("workspace:datasource:manage",)})
    with _as(_user("usr_other"), someone):
        resp = await test_client.post(url, json=_ask(uat, prov))
        assert resp.status_code == 410 and resp.json()["detail"]["type"] == "upload_expired", \
            "someone else's upload reads as one that is gone"
    monkeypatch.setattr(uploads, "PACKAGE_TTL_SECONDS", 1800)        # half an hour left
    resp = await test_client.post(url, json=_ask(uat, prov))
    assert resp.status_code == 410 and resp.json()["detail"]["type"] == "upload_expired"
    assert await _sources(db_session, uat) == [] and not seeds.calls


async def test_giving_up_on_a_package_seed_removes_its_data_source(
        test_client, db_session, graph, services, small_parts, seeds, monkeypatch):
    _versioning, jobs = services
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    prov = await _provider(db_session)
    upload = await _ready_upload(test_client, jobs, dev)
    made = (await test_client.post(f"{_TRANSFER}/packages/{upload}/new-source",
                                   json=_ask(uat, prov))).json()

    async def abandon(**kw):
        return {"jobId": made["jobId"], "status": "cancelled", "purgeJobId": "p1",
                "origin": "package"}
    monkeypatch.setattr(bootstrap_worker, "abandon_bootstrap", abandon)
    resp = await test_client.post(
        f"/api/v1/{uat}/graph/bootstrap/abandon?dataSourceId={made['dataSourceId']}")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"jobId": made["jobId"], "status": "cancelled", "purgeJobId": "p1",
                           "origin": "package", "dataSourceRemoved": True}
    assert await _sources(db_session, uat) == []


# ── Later: purge and reaper ──────────────────────────────────────────────────


def _purge(ps, *, readers):
    """A purge's FalkorDB phase with its sessions faked; ``readers`` answers who else reads the
    key (an exception: the question can't be asked)."""
    from backend.app.services.versioning.models import JobORM, ProjectionStateORM

    job = SimpleNamespace(id="job1", data_source_id="ds_mine", summary={})
    deletes = []

    class _Session:
        async def get(self, model, _ident):
            return ps if model is ProjectionStateORM else job if model is JobORM else None

        async def scalar(self, *_a, **_k):
            return 0

    @asynccontextmanager
    async def sessions():
        yield _Session()

    asked = []

    async def key_in_use(provider, name, exclude_ds):
        asked.append((provider, name, exclude_ds))
        if isinstance(readers, Exception):
            raise readers
        return readers

    class _Client:
        async def delete(self):
            deletes.append(ps.falkor_graph_name)

    class _Lease:
        job_id = "job1"

        async def checkpoint(self, _s, **values):
            for k, v in values.items():
                setattr(job, k, v)

    runner = purge_worker.PurgeRunner(lambda _n, _p=None: _Client(), session_factory=sessions,
                                      key_in_use=key_in_use)
    return runner, _Lease(), job, deletes, asked


@pytest.mark.parametrize("readers, dropped, says", [
    ([], True, "dropped"),
    ([{"kind": "dataSource", "dataSourceId": "ds_other"}], False, "still read by 1"),
    ([{"kind": "catalogItem", "catalogItemId": "cat_1"}], False, "still read by 1"),
    (ConnectionError("management DB unreachable"), False, "could not check"),
])
async def test_a_purge_never_drops_a_key_something_else_reads(readers, dropped, says, monkeypatch):
    import backend.app.providers.graph_generation as generation

    async def bump(*_a, **_k):
        return None
    monkeypatch.setattr(generation, "bump_graph_generation", bump)
    ps = SimpleNamespace(falkor_graph_name="finance_copy", owns_falkor_graph=True,
                         falkor_provider="prov_1")
    runner, lease, job, deletes, asked = _purge(ps, readers=readers)
    await runner._phase_falkor(lease, "g1")
    assert asked == [("prov_1", "finance_copy", "ds_mine")], "asked of the key, the job's own excluded"
    assert deletes == (["finance_copy"] if dropped else [])
    assert says in job.summary["falkor"]["verdict"]


async def test_a_key_we_did_not_make_is_never_even_asked_about():
    ps = SimpleNamespace(falkor_graph_name="cust", owns_falkor_graph=False, falkor_provider=None)
    runner, lease, job, deletes, asked = _purge(ps, readers=[])
    await runner._phase_falkor(lease, "g1")
    assert (deletes, asked) == ([], []) and "PROTECTED" in job.summary["falkor"]["verdict"]


async def test_the_reaper_tombstones_a_package_source_that_never_got_its_graph(db_session):
    from backend.app.db.models import WorkspaceORM

    ws = WorkspaceORM(name="UAT")
    prov = ProviderORM(name="falkor", provider_type="falkordb")
    db_session.add_all([ws, prov])
    await db_session.flush()
    old, recent = "2020-01-01T00:00:00+00:00", "2999-01-01T00:00:00+00:00"

    def ds(name, created, kind="viewPackage"):
        row = WorkspaceDataSourceORM(workspace_id=ws.id, provider_id=prov.id, graph_name=name,
                                     created_at=created, extra_config=json.dumps(
                                         {"origin": {"kind": kind, "uploadId": "up_1"}}))
        db_session.add(row)
        return row
    orphan, seeded, young, other = (ds("orphan", old), ds("seeded", old), ds("young", recent),
                                    ds("other", old, kind="somethingElse"))
    await db_session.commit()

    @asynccontextmanager
    async def app_sessions():
        yield db_session

    class _Graphs:
        async def execute(self, _stmt):
            return SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: [seeded.id]))

    @asynccontextmanager
    async def gv_sessions():
        yield _Graphs()

    reaper = purge_worker.Reaper(app_session_factory=lambda: app_sessions(),
                                 graphver_session_factory=gv_sessions)
    assert await reaper._orphaned_package_sources() == 1
    for row in (orphan, seeded, young, other):
        await db_session.refresh(row)
    assert orphan.deleted_at is not None and orphan.deleted_by == "reaper"
    assert seeded.deleted_at is None and young.deleted_at is None and other.deleted_at is None
