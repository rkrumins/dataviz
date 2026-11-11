"""An import reconciled in memory (the ``importInMemoryReconcile`` switch) ends as imports always have.

The same file is imported into two copies of the same graph: once the usual way — every row staged
whole, then resolved by its window — and once in memory, each batch decided before it is staged
(live Postgres; windows of two rows, so batches, windows and the rows that name one another fall
apart). Both must leave the same draft, the same tallies and progress, and every row of the file
resolved the same way. The cases are those a decision made before the windows could get wrong:

* a full snapshot sent again with a few nodes changed, one left out, two added (a replace);
* rows naming one entity twice, unchanged then changed, and changed then unchanged;
* a new node taking the qualifiedName an existing one is found by;
* an edge whose end the same file deletes, and edges listed before the nodes they name;
* a view-scoped replace;
* a worker that dies part-way through either pass, its job resumed by another;
* a file that is mostly new (deciding stops early), and an empty graph (nothing is decided).

In memory, the rows that change nothing are staged slim: not whole, and already resolved.
"""
from __future__ import annotations

import asyncio
import os
import shutil
import tempfile

import pytest
from sqlalchemy import func, select

from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.import_export import import_worker
from backend.app.services.versioning.import_export.import_worker import ImportWorker
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.models import ImportRowORM
from backend.app.services.versioning.service import GraphVersioningService
from backend.tests.integration.test_import_windows import (_Crash, _edge, _graph, _import_job,
                                                           _node, _row)

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")


def _switch(on: bool):
    async def switch() -> bool:
        return on
    return switch


def _table(urn, name, qname, **more):
    return {"kind": "node", "urn": urn, "entityType": "Table", "displayName": name,
            "qualifiedName": qname, **more}


def _link(src, tgt, etype="LINEAGE", **more):
    return {"kind": "edge", "edgeType": etype, "sourceUrn": src, "targetUrn": tgt, **more}


async def _outcome(svc, gid, branch_id, job_id):
    """The draft (nodes by the urn the file named them by, edges by their ends' urns and type,
    each with its whole payload), every row's resolution in file order, and the job's progress."""
    state = await svc.materialize_state(graph_id=gid, branch_id=branch_id)
    async with db.graphver_session() as s:
        made = dict((await s.execute(
            select(ImportRowORM.matched_entity_id, ImportRowORM.raw["urn"].astext)
            .where(ImportRowORM.job_id == job_id, ImportRowORM.kind == "node",
                   ImportRowORM.resolved_op == "create"))).all())
        rows = [(r.row_index, r.kind, r.resolved_op, r.status, r.reasons) for r in (await s.execute(
            select(ImportRowORM).where(ImportRowORM.job_id == job_id)
            .order_by(ImportRowORM.row_index))).scalars()]
    name = {eid: made.get(eid) or p.get("urn") for eid, p in state["nodes"].items()}
    nodes = {name[eid]: {k: v for k, v in p.items() if k != "urn"} for eid, p in state["nodes"].items()}
    edges = {(name.get(p["sourceEntityId"]), name.get(p["targetEntityId"]), p["edgeType"]):
             {k: v for k, v in p.items() if k not in ("sourceEntityId", "targetEntityId")}
             for p in state["edges"].values()}
    job = await _row(job_id)
    return nodes, edges, rows, (job.status, job.processed, job.total, job.progress)


async def _slim(job_id) -> int:
    """The job's unchanged rows staged slim: without the fields only their window would read."""
    async with db.graphver_session() as s:
        return (await s.execute(select(func.count()).select_from(ImportRowORM).where(
            ImportRowORM.job_id == job_id, ImportRowORM.status == "unchanged",
            ~ImportRowORM.raw.has_key("displayName")))).scalar_one()


async def _same(svc, ie, store, seed, lines, *, mode="upsert", scope=None):
    """``lines`` imported into two graphs seeded with ``seed``, the usual way and in memory: the
    same in every way. Returns the in-memory worker and its job, to see what it decided."""
    results = []
    for in_memory in (False, True):
        import_worker._in_memory_switch = _switch(in_memory)
        gid = await _graph(svc, seed)
        job = await _import_job(ie, store, gid, lines, mode=mode)
        worker = ImportWorker(svc, store, scope=scope)
        summary = await worker.run(job["job_id"])
        results.append((summary, await _outcome(svc, gid, job["branch_id"], job["job_id"])))
    (usual, usual_outcome), (memory, memory_outcome) = results
    assert memory == usual, (memory, usual)
    for part, (a, b) in zip(("nodes", "edges", "rows", "progress"), zip(memory_outcome, usual_outcome)):
        assert a == b, f"{part} differ:\n in memory: {a}\n usual:     {b}"
    return worker, job


_SEED = [*(_node(f"ent_{i}", f"urn:{i}", f"q{i}", f"N{i}") for i in range(12)),
         *(_edge(f"edg_{i}", f"ent_{i}", f"ent_{i + 1}") for i in range(11))]


async def _snapshot(svc, ie, store) -> None:
    """The graph sent again whole, a few rows different, as a replace: what's unchanged is staged
    slim, and the rest is reconciled as before — the node left out deleted, with its edges."""
    lines = [*(_table(f"urn:{i}", f"N{i}" + ("!" if i in (3, 7) else ""), f"q{i}")
               for i in range(12) if i != 5),
             _table("urn:12", "N12", "q12"), _table("urn:13", "N13", "q13"),
             *(_link(f"urn:{i}", f"urn:{i + 1}") for i in range(13)),
             {"kind": "node", "urn": "urn:never-there", "entityType": "Table", "_op": "delete"}]
    worker, job = await _same(svc, ie, store, _SEED, lines, mode="replace")
    assert worker._decided["node"][1] >= 8 and worker._decided["edge"][1] >= 8, worker._decided
    assert await _slim(job["job_id"]) >= 16


async def _twice(svc, ie, store) -> None:
    """A row naming an entity a row before it named is left to its window, whichever way round."""
    for lines in (
        [_table("urn:1", "N1", "q1"), _table("urn:2", "N2", "q2"), _table("urn:3", "N3", "q3"),
         _table("urn:1", "renamed", "q1")],
        [_table("urn:1", "renamed", "q1"), _table("urn:2", "N2", "q2"), _table("urn:3", "N3", "q3"),
         _table("urn:1", "N1", "q1")],
        [_link("urn:1", "urn:2"), _link("urn:2", "urn:3"), _link("urn:3", "urn:4"),
         _link("urn:1", "urn:2", confidence=0.5)],
    ):
        await _same(svc, ie, store, _SEED, lines)


async def _taken_qname(svc, ie, store) -> None:
    """A new node takes the qualifiedName an existing node is found by: a later row naming it by
    that name names neither, in memory as in its window."""
    lines = [_table("urn:new", "W", "q4"), _table("urn:pad", "P", "pad"),
             {"kind": "node", "entityType": "Table", "displayName": "N4", "qualifiedName": "q4"}]
    await _same(svc, ie, store, _SEED, lines)


async def _gone_end(svc, ie, store) -> None:
    """An edge whose end the same file deletes is decided once the node windows are in."""
    lines = [_link("urn:1", "urn:2"), _link("urn:2", "urn:3"),
             {"kind": "node", "urn": "urn:2", "entityType": "Table", "_op": "delete"},
             _table("urn:3", "N3", "q3"), _link("urn:3", "urn:4")]
    await _same(svc, ie, store, _SEED, lines)


async def _edges_first(svc, ie, store) -> None:
    """Edges listed before the nodes they name, some made by later rows (test_import_windows)."""
    seed = [_node("ent_A", "urn:A", "a", "A"), _node("ent_B", "urn:B", "b", "B"),
            _edge("edg_AB", "ent_A", "ent_B")]
    lines = [
        {"kind": "edge", "edgeType": "LINEAGE", "sourceQualifiedName": "d", "targetUrn": "urn:E"},
        _table("urn:A", "A2", "a"), _table("urn:D", "D", "d"), _link("urn:A", "urn:B"),
        _table("urn:B", "B", "b"), _table("urn:E", "E", "e"),
        {"kind": "edge", "edgeType": "LINEAGE", "sourceQualifiedName": "a", "targetQualifiedName": "d"},
        _link("urn:X", "urn:A"),
    ]
    await _same(svc, ie, store, seed, lines)


async def _view_replace(svc, ie, store) -> None:
    seed = [_node("ent_A", "urn:A", "a"), _node("ent_B", "urn:B", "b"), _node("ent_C", "urn:C", "c"),
            _node("ent_X", "urn:X", "x"),
            _edge("edg_AB", "ent_A", "ent_B", "CONTAINS"), _edge("edg_BC", "ent_B", "ent_C", "CONTAINS"),
            _edge("edg_XA", "ent_X", "ent_A")]
    scope = {"assigned_urns": ["urn:A"], "inherit_urns": ["urn:A"], "containment_types": ["CONTAINS"]}
    lines = [_table("urn:A", "n", "a"), _table("urn:B", "n", "b"), _link("urn:A", "urn:B", "CONTAINS")]
    await _same(svc, ie, store, seed, lines, mode="replace", scope=scope)


async def _resumed(svc, ie, store) -> None:
    """A worker dies part-way through a pass: the next one stages the rest of the pass whole (what
    the first knew of the rows before is gone with it), and the import ends as the usual one."""
    lines = [*(_table(f"urn:{i}", f"N{i}" + ("!" if i == 6 else ""), f"q{i}") for i in range(12)),
             *(_link(f"urn:{i}", f"urn:{i + 1}") for i in range(11))]
    import_worker._in_memory_switch = _switch(False)
    gid = await _graph(svc, _SEED)
    ref_job = await _import_job(ie, store, gid, lines)
    ref = await ImportWorker(svc, store).run(ref_job["job_id"])
    want = await _outcome(svc, gid, ref_job["branch_id"], ref_job["job_id"])

    import_worker._in_memory_switch = _switch(True)
    for prefix, nth in (("mparse", 2), ("eparse", 2)):
        gid = await _graph(svc, _SEED)
        job = await _import_job(ie, store, gid, lines)
        first = ImportWorker(svc, store)
        flush, calls = first._flush_decided, []

        async def dying(job_id, snap, kind, rows, summary, processed, cursor, **values):
            if cursor.startswith(prefix):
                calls.append(cursor)
                if len(calls) == nth:
                    raise _Crash(f"died staging {cursor}")
            return await flush(job_id, snap, kind, rows, summary, processed, cursor, **values)

        first._flush_decided = dying
        with pytest.raises(_Crash):
            await first.run(job["job_id"])
        row = await _row(job["job_id"])
        assert (row.status, row.last_cursor.partition(":")[0]) == ("running", prefix), row.__dict__
        second = ImportWorker(svc, store)
        assert await second.run(job["job_id"]) == ref
        assert not second._deciding.get("node" if prefix == "mparse" else "edge"), "resumed: decides nothing"
        got = await _outcome(svc, gid, job["branch_id"], job["job_id"])
        assert got[:3] == want[:3], (prefix, got, want)
        assert got[3][0] == "completed" and got[3][1:3] == want[3][1:3], got[3]


async def _mostly_new(svc, ie, store) -> None:
    """A file that mostly adds stops deciding once that shows, and stages the rest whole."""
    original = import_worker._DECIDE_PROBE_ROWS
    import_worker._DECIDE_PROBE_ROWS = 4
    try:
        lines = [*(_table(f"urn:new{i}", f"New{i}", f"new{i}") for i in range(8)), _table("urn:1", "N1", "q1")]
        worker, _job = await _same(svc, ie, store, _SEED, lines)
        assert worker._deciding["node"] is False and worker._decided["node"] == [4, 0], worker._decided
    finally:
        import_worker._DECIDE_PROBE_ROWS = original


async def _empty_graph(svc, ie, store) -> None:
    """A first load into an empty graph is all new: it runs the usual way, deciding nothing."""
    import_worker._in_memory_switch = _switch(True)
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="u"))["graph_id"]
    job = await _import_job(ie, store, gid, [_table("urn:1", "N1", "q1"), _link("urn:1", "urn:1")])
    worker = ImportWorker(svc, store)
    await worker.run(job["job_id"])
    assert worker._decided == {} and (await _row(job["job_id"])).last_cursor.startswith("edge:")


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    root = tempfile.mkdtemp(prefix="import-in-memory-")
    switch = import_worker._in_memory_switch
    try:
        store = LocalFsObjectStore(root)
        ie = ImportExportService(versioning=svc, store=store)
        for case in (_snapshot, _twice, _taken_qname, _gone_end, _edges_first, _view_replace,
                     _resumed, _mostly_new, _empty_graph):
            await case(svc, ie, store)
    finally:
        import_worker._in_memory_switch = switch
        shutil.rmtree(root, ignore_errors=True)


def test_an_import_reconciled_in_memory_ends_as_the_usual_one(monkeypatch):
    monkeypatch.setattr(config, "IMPORT_COMMIT_WINDOW", 2)
    monkeypatch.setattr(import_worker, "_PARSE_BATCH", 2)
    asyncio.run(_run())
