"""A new data source seeded from a view package, on Postgres and a REAL FalkorDB.

The seed is the bootstrap job with ``origin: 'package'`` (``package_seed``): the package's data,
read from its upload in place, becomes the new source's first version on main — its entity ids
kept — and is projected into the new source's own, empty key before the head flips. Pinned here:

* a 3k+3k package exported from a versioned graph lands as commit seq 2 with the package's ids,
  the key claimed (``owns_falkor_graph``), FalkorDB holding what Postgres holds, every label's urn
  index built, and the publish hooks run (rollups queued, insights nudged);
* a crash after any unit of any phase resumes to the same end state, and of two workers holding
  the job only the newer epoch writes;
* a key that already holds data is refused (``target_not_empty``, nothing written to it) and so is
  an upload that is gone (``payload_missing``) — neither offers a resume;
* giving up during the projection purges what was copied, and the key the job claimed;
* two items sharing a type and urn are collapsed into one, in the copy, deterministically, and
  reported — their connections moved, a connection between the two dropped, repeats folded;
* the copy is INDEPENDENT of the graph it came from: another key, and purging it leaves the
  origin's untouched.

Needs Postgres (``GRAPHVER_E2E=1``) and FalkorDB:
  GRAPHVER_E2E=1 RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
    python -m pytest -q tests/integration/test_package_seed_job.py
"""
import asyncio
import json
import os

import pytest
from falkordb.asyncio import FalkorDB
from redis.asyncio import ConnectionPool
from sqlalchemy import func, select

from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning import config, db, models
from backend.app.services.versioning import package_seed
from backend.app.services.versioning.bootstrap_worker import (
    BootstrapRunner,
    abandon_bootstrap,
    bootstrap_status,
    create_bootstrap_job,
)
from backend.app.services.versioning.import_export import stream, uploads
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.import_export.snapshot import open_snapshot
from backend.app.services.versioning.job_lease import Lease
from backend.app.services.versioning.merkle import content_hash
from backend.app.services.versioning.models import (
    EdgeVersionORM,
    GraphORM,
    JobORM,
    NodeVersionORM,
    ProjectionStateORM,
)
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.purge_worker import PurgeRunner, create_purge_job
from backend.app.services.versioning.service import GraphVersioningService
from backend.app.services.view_transfer.package import write_package

pytestmark = [
    pytest.mark.skipif(not os.getenv("GRAPHVER_E2E") or os.getenv("RUN_FALKOR_LIVE") != "1",
                       reason="set GRAPHVER_E2E=1 and RUN_FALKOR_LIVE=1 with FalkorDB reachable"),
]


@pytest.fixture
async def falkor():
    """A FalkorDB handle on a pool of this test's own; the graphs it hands out are deleted after."""
    from backend.app.db.engine import close_db
    from backend.app.services.aggregation import redis_client
    from backend.app.services.aggregation.redis_client import close_redis

    # An earlier test's loop may still hold the management engine's pool and the bus client.
    await close_db()
    try:
        await close_redis()
    except Exception:                              # a client of a closed loop: just forget it
        redis_client._client = None
    pool = ConnectionPool(host=os.getenv("FALKORDB_HOST", "localhost"),
                          port=int(os.getenv("FALKORDB_PORT", "6379")), max_connections=8)
    handle, made = FalkorDB(connection_pool=pool), set()

    def graph(name=None):
        name = name or "gvt_seed_" + os.urandom(4).hex()
        made.add(name)
        return handle.select_graph(name)

    async def keys():
        return {k.decode() if isinstance(k, bytes) else k for k in await handle.list_graphs()}

    graph.keys = keys
    try:
        yield graph
    finally:
        for name in made:
            try:
                await handle.select_graph(name).delete()
            except Exception:                              # never created, or purged already
                pass
        await pool.disconnect()
        await db.dispose_engine()
        # What the job reached on this test's loop — the management engine (the ontology rules, a
        # purge's question of who reads a key), and the bus a full write's generation bump uses —
        # is let go before the loop closes, or the next test inherits connections of a dead loop.
        await close_db()
        await close_redis()


@pytest.fixture(autouse=True)
def _small_windows(monkeypatch):
    # Small windows: every phase crosses several, as a large package would.
    monkeypatch.setattr(config, "PACKAGE_SEED_WINDOW", 1000)
    monkeypatch.setattr(config, "PACKAGE_PROJECT_WINDOW", 1000)


class _Crash(BaseException):
    """The worker process dying: nothing catches it, the job stays running at its epoch."""


async def _take(job_id) -> Lease:
    async with db.graphver_session() as s:
        job = await s.get(JobORM, job_id)
        job.retry_count += 1
        job.status = "running"
        job.updated_at = models._now()
        return Lease(job_id=job.id, job_type=job.job_type, epoch=job.retry_count,
                     workspace_id=job.workspace_id, graph_id=job.graph_id)


async def _rows(client, cypher, params=None):
    return (await client.query(cypher, params or {})).result_set or []


def _node(eid, etype="Table", **payload):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": f"urn:{eid}", "entityType": etype, "displayName": eid, **payload}}


def _edge(eid, s, t, etype="FLOWS_TO"):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": s, "targetEntityId": t}}


async def _package(store, ie, data: bytes, nodes: int, edges: int) -> dict:
    """``data`` (NDJSON) as a format-2 package, uploaded in parts and checked: the upload record."""
    from backend.tests.test_view_transfer_package import BUNDLE

    async def chunks():
        yield data

    def manifest_of(parts):
        return {"format": "view-package", "formatVersion": 2, "scope": "source",
                "data": {"version": "published", "nodes": nodes, "edges": edges}, "parts": parts}
    raw = b"".join([c async for c in write_package(BUNDLE, chunks(), manifest_of)])
    record = await uploads.create_package(store, owner="bob", file_name="p.zip", size=len(raw))
    for n in range(record["parts"]):
        start = n * record["partBytes"]

        async def part(d=raw[start:start + uploads.part_size(record, n)]):
            yield d
        await uploads.put_part(store, record, n, part())
    job_id, _ = await ie.create_inspect_job(upload_id=record["uploadId"],
                                            source_uri=uploads.record_key(record))
    await ie.run_inspect(job_id)
    return await uploads.read_record(store, uploads.record_key(record))


async def _seed(record, key_name, *, nodes, edges):
    ds = "ds_seed_" + os.urandom(4).hex()
    res = await create_bootstrap_job(
        data_source_id=ds, workspace_id="ws_seed", actor="bob", falkor_graph_name=key_name,
        falkor_provider=None, origin="package", payload_uri=uploads.record_key(record),
        upload_id=record["uploadId"], ontology_enforcement="permissive",
        package={"integrity": "verified", "scope": "source",
                 "manifest": {"nodes": nodes, "edges": edges}})
    return ds, res["graph_id"], res["job_id"]


class _Hooks:
    def __init__(self):
        self.rollups, self.projected = [], []

    async def rollups_stale(self, graph_id):
        self.rollups.append(graph_id)

    async def on_projected(self, ds):
        self.projected.append(ds)


def _runner(falkor, store, hooks=None):
    hooks = hooks or _Hooks()
    factory = lambda name, _p=None: falkor(name)  # noqa: E731
    projector = FalkorProjector(factory, on_rollups_stale=hooks.rollups_stale,
                                on_projected=hooks.on_projected)
    return BootstrapRunner(factory, projector=projector, store=store), hooks


def _dying(runner, phases) -> set:
    """Make the worker die once right after the first unit of each of ``phases``; the phases it
    died in."""
    crashed: set = set()
    original = runner._run_phase

    async def dying(lease, fn, graph_id, phase):
        done = await original(lease, fn, graph_id, phase)
        if phase in phases and phase not in crashed:
            crashed.add(phase)
            raise _Crash(phase)
        return done
    runner._run_phase = dying
    return crashed


async def _drive(runner, job_id, crash_after=None):
    """Run the job to an end; with ``crash_after``, the worker dies once right after the first
    unit of each named phase, and another worker takes the job over — as often as it takes."""
    crashed = _dying(runner, crash_after) if crash_after else set()
    while True:
        try:
            return await runner.run_job(await _take(job_id)), crashed
        except _Crash:
            continue


async def _origin(svc, falkor, n: int):
    """A versioned graph of ``n`` nodes and ``n`` edges, projected into a real key of its own."""
    key = falkor().name
    ds = "ds_origin_" + os.urandom(4).hex()
    g = await svc.create_graph(data_source_id=ds, workspace_id="ws_dev", actor="alice",
                               falkor_graph_name=key, owns_falkor_graph=True)
    ops = [_node(f"ent_{i:05d}", ("Table", "Column", "Domain")[i % 3], properties={"i": i})
           for i in range(n)]
    ops += [_edge(f"edge_{j:05d}", f"ent_{j:05d}", f"ent_{(j * 7 + 1) % n:05d}",
                  ("FLOWS_TO", "CONTAINS")[j % 2]) for j in range(n)]
    await svc.apply_ops(graph_id=g["graph_id"], actor="alice", message="seed", ops=ops)
    await FalkorProjector(lambda name, _p=None: falkor(name)).project_graph(g["graph_id"])
    return g, key


async def _native(graph_id) -> bytes:
    snap = await open_snapshot(graph_id=graph_id)
    return b"".join([c async for c in stream.native_pages(snap, stream.Selection.of())])


async def _version_rows(graph_id):
    async with db.graphver_session() as s:
        nodes = dict((await s.execute(select(NodeVersionORM.entity_id, NodeVersionORM.content_hash)
                                      .where(NodeVersionORM.graph_id == graph_id))).all())
        edges = dict((await s.execute(select(EdgeVersionORM.entity_id, EdgeVersionORM.content_hash)
                                      .where(EdgeVersionORM.graph_id == graph_id))).all())
    return nodes, edges


async def _falkor_counts(client):
    n = (await _rows(client, "MATCH (n) RETURN count(n)"))[0][0]
    e = (await _rows(client, "MATCH ()-[r]->() RETURN count(r)"))[0][0]
    return n, e


# ── The seed, end to end, then crashed in every phase ────────────────────────

async def test_a_package_becomes_a_new_sources_first_version(falkor, tmp_path):
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    store = LocalFsObjectStore(tmp_path)
    ie = ImportExportService(versioning=svc, store=store)
    origin, origin_key = await _origin(svc, falkor, 3000)
    origin_nodes, origin_edges = await _version_rows(origin["graph_id"])
    record = await _package(store, ie, await _native(origin["graph_id"]), 3000, 3000)

    key = falkor().name
    ds, gid, job_id = await _seed(record, key, nodes=3000, edges=3000)
    runner, hooks = _runner(falkor, store)
    out, _ = await _drive(runner, job_id)
    assert out["status"] == "completed", await bootstrap_status(data_source_id=ds)

    status = await bootstrap_status(data_source_id=ds)
    assert status["origin"] == "package" and status["status"] == "completed"
    assert all(c["ok"] for c in status["report"]["checks"]), status["report"]["checks"]
    assert status["report"]["stored"] == {"nodes": 3000, "edges": 3000}
    meta = await svc.get_graph(gid)
    assert meta["main_head_commit_seq"] == 2
    nodes, edges = await _version_rows(gid)
    assert set(nodes) == set(origin_nodes) and set(edges) == set(origin_edges), \
        "the package's entity ids are kept"
    assert nodes == {e: h for e, h in origin_nodes.items()}, "payloads stored as they were"
    async with db.graphver_session() as s:
        ps = await s.get(ProjectionStateORM, gid)
        assert ps.owns_falkor_graph and ps.falkor_graph_name == key
        assert ps.projected_commit_seq == ps.target_commit_seq == 2
    client = falkor(key)
    assert await _falkor_counts(client) == (3000, 3000)
    indexed = {str(c) for row in await _rows(client, "CALL db.indexes()") for c in row
               if isinstance(c, str)}
    assert {"Table", "Column", "Domain"} <= indexed, indexed
    assert hooks.rollups == [gid] and hooks.projected == [ds], "the publish hooks ran"
    assert key != origin_key

    # The same package again, with the worker dying after the first unit of every phase.
    again_key = falkor().name
    ds2, gid2, job2 = await _seed(record, again_key, nodes=3000, edges=3000)
    runner, _ = _runner(falkor, store)
    out, crashed = await _drive(runner, job2, crash_after=set(package_seed.OWN_PHASES)
                                | {"heads", "merkle", "finalize"})
    assert out["status"] == "completed" and crashed == set(package_seed.OWN_PHASES) | {
        "heads", "merkle", "finalize"}
    assert await _version_rows(gid2) == (nodes, edges), "the same copy, crashes or not"
    assert await _falkor_counts(falkor(again_key)) == (3000, 3000)
    status = await bootstrap_status(data_source_id=ds2)
    assert all(c["ok"] for c in status["report"]["checks"]) and status["attempt"] > 9

    # INDEPENDENCE: purging the copy drops its own key, and leaves the origin's as it was.
    before = await _falkor_counts(falkor(origin_key))
    purge = await create_purge_job(graph_id=gid2, workspace_id="ws_seed", actor="bob",
                                   data_source_id=ds2)
    assert (await PurgeRunner(lambda name, _p=None: falkor(name)).run_job(await _take(purge)))[
        "status"] == "completed"
    assert again_key not in await falkor.keys()
    assert await _falkor_counts(falkor(origin_key)) == before == (3000, 3000)
    assert origin_key in await falkor.keys()


async def test_only_the_newest_holder_of_the_job_writes(falkor, tmp_path):
    await models.create_schema_and_partitions()
    store = LocalFsObjectStore(tmp_path)
    ie = ImportExportService(versioning=GraphVersioningService(), store=store)
    data = b"".join(json.dumps({"kind": "node", "entity_id": f"ent_{i}", "payload": {
        "urn": f"urn:{i}", "entityType": "T"}}).encode() + b"\n" for i in range(50))
    record = await _package(store, ie, data, 50, 0)
    ds, gid, job_id = await _seed(record, falkor().name, nodes=50, edges=0)
    stale = await _take(job_id)
    fresh = await _take(job_id)                    # taken over: a new epoch
    runner, _ = _runner(falkor, store)
    assert (await runner.run_job(stale))["status"] == "superseded"
    assert await _version_rows(gid) == ({}, {}), "the superseded worker's window rolled back"
    assert (await runner.run_job(fresh))["status"] == "completed"
    assert len((await _version_rows(gid))[0]) == 50


# ── Refused, given up ────────────────────────────────────────────────────────

async def test_an_occupied_key_or_a_vanished_upload_is_refused_without_a_resume(falkor, tmp_path):
    await models.create_schema_and_partitions()
    store = LocalFsObjectStore(tmp_path)
    ie = ImportExportService(versioning=GraphVersioningService(), store=store)
    data = json.dumps({"kind": "node", "entity_id": "ent_1", "payload": {
        "urn": "urn:1", "entityType": "T"}}).encode() + b"\n"
    record = await _package(store, ie, data, 1, 0)

    occupied = falkor()
    await occupied.query("CREATE (:Customer {urn: 'theirs'})")
    ds, gid, job_id = await _seed(record, occupied.name, nodes=1, edges=0)
    runner, _ = _runner(falkor, store)
    assert (await runner.run_job(await _take(job_id)))["status"] == "failed"
    status = await bootstrap_status(data_source_id=ds)
    assert (status["failure"]["code"], status["failure"]["action"]) == ("target_not_empty", None)
    assert await _rows(occupied, "MATCH (n) RETURN n.urn") == [["theirs"]], "never touched"
    async with db.graphver_session() as s:
        assert not (await s.get(ProjectionStateORM, gid)).owns_falkor_graph, "never claimed"

    marked = falkor()                              # an aggregation run's marker is not data
    await marked.query("MERGE (:_AggMeta {id: 'singleton'})")
    ds, gid, job_id = await _seed(record, marked.name, nodes=1, edges=0)
    assert (await runner.run_job(await _take(job_id)))["status"] == "completed", \
        await bootstrap_status(data_source_id=ds)

    ds, gid, job_id = await _seed(record, falkor().name, nodes=1, edges=0)
    await store.delete(uploads.record_key(record))
    assert (await runner.run_job(await _take(job_id)))["status"] == "failed"
    status = await bootstrap_status(data_source_id=ds)
    assert (status["failure"]["code"], status["failure"]["action"]) == ("payload_missing", None)


async def test_giving_up_during_the_projection_purges_the_copy_and_its_key(falkor, tmp_path):
    await models.create_schema_and_partitions()
    store = LocalFsObjectStore(tmp_path)
    ie = ImportExportService(versioning=GraphVersioningService(), store=store)
    data = b"".join(json.dumps({"kind": "node", "entity_id": f"ent_{i}", "payload": {
        "urn": f"urn:{i}", "entityType": "T"}}).encode() + b"\n" for i in range(2500))
    record = await _package(store, ie, data, 2500, 0)
    key = falkor().name
    ds, gid, job_id = await _seed(record, key, nodes=2500, edges=0)
    runner, _ = _runner(falkor, store)
    _dying(runner, {"project"})
    with pytest.raises(_Crash):                     # one window projected, then the worker is gone
        await runner.run_job(await _take(job_id))
    assert (await _falkor_counts(falkor(key)))[0] == 1000, "the key holds part of the copy"

    gone = await abandon_bootstrap(data_source_id=ds, actor="bob")
    assert gone["status"] == "cancelled" and gone["origin"] == "package"
    purge = PurgeRunner(lambda name, _p=None: falkor(name))
    assert (await purge.run_job(await _take(gone["purgeJobId"])))["status"] == "completed"
    assert key not in await falkor.keys(), "the key the job claimed went with it"
    async with db.graphver_session() as s:
        assert await s.get(GraphORM, gid) is None
        assert int(await s.scalar(select(func.count()).select_from(NodeVersionORM).where(
            NodeVersionORM.graph_id == gid))) == 0


# ── Two items, one type and urn ──────────────────────────────────────────────

async def test_items_sharing_a_type_and_urn_are_collapsed_and_reported(falkor, tmp_path):
    await models.create_schema_and_partitions()
    store = LocalFsObjectStore(tmp_path)
    ie = ImportExportService(versioning=GraphVersioningService(), store=store)

    def node(eid, urn, synced=None, etype="Table"):
        p = {"urn": urn, "entityType": etype, "displayName": eid}
        if synced:
            p["lastSyncedAt"] = synced
        return {"kind": "node", "entity_id": eid, "payload": p}

    def edge(eid, s, t, etype="FLOWS_TO"):
        return {"kind": "edge", "entity_id": eid,
                "payload": {"edgeType": etype, "sourceEntityId": s, "targetEntityId": t}}
    lines = [
        node("ent_old", "urn:dup", "2026-01-01T00:00:00Z"),   # collapsed into ent_new
        node("ent_new", "urn:dup", "2026-02-01T00:00:00Z"),   # kept: synced last
        node("ent_col", "urn:dup", etype="Column"),           # another type: its own item
        node("ent_x", "urn:x"), node("ent_y", "urn:y"),
        edge("e1", "ent_x", "ent_old"),                       # moved to ent_new
        edge("e2", "ent_old", "ent_new"),                     # joined the two copies: dropped
        edge("e3", "ent_old", "ent_y"), edge("e4", "ent_new", "ent_y"),   # moved onto e4: e4 kept
        edge("e7", "ent_x", "ent_y"), edge("e8", "ent_x", "ent_y"),       # the package's own parallels
        edge("e5", "ent_old", "ent_old"),                     # a genuine self-loop, moved
        edge("e6", "ent_col", "ent_y"),
    ]
    data = b"".join(json.dumps(x).encode() + b"\n" for x in lines)
    record = await _package(store, ie, data, 5, 8)
    key = falkor().name
    ds, gid, job_id = await _seed(record, key, nodes=5, edges=8)
    runner, _ = _runner(falkor, store)
    assert (await runner.run_job(await _take(job_id)))["status"] == "completed", \
        await bootstrap_status(data_source_id=ds)

    status = await bootstrap_status(data_source_id=ds)
    report = status["report"]
    checks = {c["key"]: c for c in report["checks"]}
    assert all(c["ok"] for c in report["checks"] if c["blocking"]), report["checks"]
    assert not checks["shared_identifiers_collapsed"]["ok"] and \
        not checks["shared_identifiers_collapsed"]["blocking"], "reported, never blocking"
    assert status["collapsed"] == {"nodes": 1, "byLabel": {"Table": 1}, "selfLoops": 1}, \
        "told as a graph bootstrap tells it"
    assert (report["package"]["nodes"], report["package"]["edges"]) == (4, 6)
    collapse = report["package"]["collapse"]
    assert (collapse["identifiers"], collapse["nodes"], collapse["selfLoops"], collapse["parallel"]) \
        == (1, 1, 1, 1)
    assert collapse["groups"] == [{"urn": "urn:dup", "label": "Table", "kept": "ent_new",
                                   "merged": ["ent_old"]}]
    assert report["stored"] == {"nodes": 4, "edges": 6}

    async with db.graphver_session() as s:
        stored = {r.entity_id: r for r in (await s.execute(select(EdgeVersionORM).where(
            EdgeVersionORM.graph_id == gid))).scalars().all()}
    assert sorted(stored) == ["e1", "e4", "e5", "e6", "e7", "e8"]
    assert (stored["e1"].source_entity_id, stored["e1"].target_entity_id) == ("ent_x", "ent_new")
    assert (stored["e5"].source_entity_id, stored["e5"].target_entity_id) == ("ent_new", "ent_new")
    for row in stored.values():
        assert row.payload["sourceEntityId"] == row.source_entity_id
        assert row.content_hash == content_hash(row.payload), "moved, and hashed again"
    client = falkor(key)
    assert await _falkor_counts(client) == (4, 5), "one relationship per (source, type, target)"
    assert await _rows(client, "MATCH (n:Table {urn: 'urn:dup'}) RETURN n.entityId") == [["ent_new"]]


# ── One request per upload ───────────────────────────────────────────────────

async def test_new_source_requests_for_one_upload_take_turns():
    """The per-upload lock of ``POST /packages/{id}/new-source`` on the real management database:
    a second request for the same upload waits for the first; another upload's does not."""
    from backend.app.api.v1.endpoints.view_transfer import _per_upload

    order = []

    async def hold(upload, label, secs):
        async with _per_upload(upload):
            order.append(f"{label}+")
            await asyncio.sleep(secs)
            order.append(f"{label}-")

    await asyncio.gather(hold("up_same", "a", 0.3), hold("up_same", "b", 0.0),
                         hold("up_other", "c", 0.0))
    assert order.index("a-") < order.index("b+") or order.index("b-") < order.index("a+")
    assert order.index("c+") < order.index("a-"), "another upload never waits"
    from backend.app.db.engine import close_db
    await close_db()
