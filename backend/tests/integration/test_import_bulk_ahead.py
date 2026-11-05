"""A bulk import's windows resolved ahead of their writes land what one window at a time lands — on
live Postgres.

A bulk import has ``IMPORT_BULK_CONCURRENCY`` windows in hand: it writes one while the next ones are
looked up and matched (``ImportWorker._bulk_phase``). A window ahead that names what a window written
since it began names — the same urn, file id, qualifiedName, key value, entity or edge — is matched
again in its turn. Proven on a file whose windows lean on each other in every way a row can: one
window at a time and four at once, with the lookups' timing shuffled, give the same ``main``, the
same outcome for every row and the same tallies; such windows are matched again, and a file whose
windows share nothing matches none again.
"""
import asyncio
import json
import os
import random
import re
import shutil
import tempfile

import pytest
from sqlalchemy import select

from backend.app.services.storage.object_store import LocalFsObjectStore, storage_key
from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.import_export import import_worker
from backend.app.services.versioning.import_export.import_worker import ImportWorker
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.models import ImportResultORM
from backend.app.services.versioning.service import GraphVersioningService

_ONTOLOGY = {"node_types": ["Table"], "edge_types": ["LINEAGE", "CONTAINS"],
             "keys": {"Table": ["ext"]}, "unique": {"Table": ["code"]}}


def _n(name, urn=None, **fields):
    props = {f"prop.{k}": fields.pop(k) for k in ("ext", "code") if k in fields}
    row = {"kind": "node", "entityType": "Table", "displayName": name, **fields, **props}
    if urn:
        row["urn"] = f"urn:p:{urn}"
    return row


def _e(src, tgt, etype="LINEAGE", **fields):
    ends = {}
    for end, name in (("source", src), ("target", tgt)):
        if name.startswith("F-"):
            ends[f"{end}_entity_id"] = name
        else:
            ends[f"{end}Urn"] = f"urn:p:{name}"
    return {"kind": "edge", "edgeType": etype, **ends, **fields}


# Two rows a window. Each comment says what one window at a time makes of the window's rows.
_LEANING = [
    _n("a", "a", qualifiedName="q.a"), _n("b", "b", code="C1"),                   # new, new
    _n("s1-new", "s1"), _n("c", qualifiedName="q.c", entity_id="F-c"),           # main's s1 renamed; new
    _n("a", "a"), _n("c", entity_id="F-c"),                                       # a and c again, as they are
    _n("a2", qualifiedName="q.a"), _n("d", "d", code="C1"),                       # a, said otherwise; C1 is b's
    _n("e", "e", ext="K1"), _n("k0-new", ext="K0"),                               # new; main's k0 by its key
    _n("e2", ext="K1"), _n("f", "f"),                                             # e by its key, said otherwise; new
    _n("b", "b", code="C2"), _n("g", "g", entity_id="F-g"),                       # b, said otherwise; new
    _n("g", entity_id="F-g"), _n("h", "h", qualifiedName="q.c"),                  # g by its file id; new, as c is called
    _n("c3", qualifiedName="q.c"), _n("i", "i"),                                  # q.c is two nodes' now; new
    _e("a", "b"), _e("s1", "s2"),                                                 # new; main's
    _e("a", "b"), _e("a", "f", "CONTAINS"),                                       # again; new
    _e("b", "f", "CONTAINS"), _e("a", "b", "lineage"),                            # f's second parent; again
    _e("f", "a", "CONTAINS"), _e("F-c", "g"),                                     # a loop; new, by c's file id
    _e("F-c", "g", confidence=0.5), _e("e", "h"),                                 # again, said otherwise; new
]
# What main holds before the file: s1 -> s2, and k0 with key K0.
_SEED = [{"op": "create", "entity_kind": "node", "entity_id": eid,
          "payload": {"urn": f"urn:p:{name}", "entityType": "Table", "displayName": name, **extra}}
         for eid, name, extra in (("S1", "s1", {}), ("S2", "s2", {}),
                                  ("K0", "k0", {"properties": {"ext": "K0"}}))] + [
    {"op": "create", "entity_kind": "edge", "entity_id": "S12",
     "payload": {"edgeType": "LINEAGE", "sourceEntityId": "S1", "targetEntityId": "S2"}}]
# Windows that share nothing: every row names its own node or edge.
_APART = [*(_n(f"t{i}", f"t{i}") for i in range(12)), *(_e(f"t{i}", f"t{i + 1}") for i in range(11))]


async def _graph(svc):
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    await svc.apply_ops(graph_id=G["graph_id"], actor="u", message="seed", ops=_SEED)
    return G["graph_id"], G["main_branch_id"]


async def _load(svc, store, lines, *, concurrency, seed=None):
    """``lines`` bulk-imported into a fresh graph seeded with ``_SEED``, ``concurrency`` windows in
    hand (each lookup delayed at random by ``seed``): its tallies, every row's outcome and ``main``,
    each named as the file names it, and how many windows were matched again."""
    gid, main = await _graph(svc)
    key = storage_key("ws1", gid, os.urandom(4).hex(), "source.ndjson")

    async def body():
        yield ("\n".join(json.dumps(x) for x in lines) + "\n").encode()

    await store.put_stream(key, body())
    ie = ImportExportService(versioning=svc, store=store)
    job = await ie.create_import_job(workspace_id="ws1", data_source_id=gid, graph_id=gid, actor="u",
                                     import_format="ndjson", source_uri=key, bulk=True)

    async def judged():
        return ["CONTAINS"], None

    worker = ImportWorker(svc, store, ontology=_ONTOLOGY, bulk_check=judged)
    calls = {"resolved": 0, "landed": 0}
    rng = random.Random(seed)
    resolve, resolve_ahead, land = worker._resolve_window, worker._resolve_ahead, worker._land_window

    async def shuffled(*args):
        if seed is not None:
            await asyncio.sleep(rng.random() / 50)
        return await resolve(*args)

    async def counted_resolve(*args):
        calls["resolved"] += 1
        return await resolve_ahead(*args)

    async def counted_land(*args):
        calls["landed"] += 1
        return await land(*args)

    worker._resolve_window, worker._resolve_ahead, worker._land_window = shuffled, counted_resolve, counted_land
    was = config.IMPORT_BULK_CONCURRENCY
    config.IMPORT_BULK_CONCURRENCY = concurrency
    try:
        tallies = await worker.run(job["job_id"])
    finally:
        config.IMPORT_BULK_CONCURRENCY = was

    state = await svc.materialize_state(graph_id=gid, branch_id=main)
    name = {eid: p["displayName"] for eid, p in state["nodes"].items()}
    name.update({p["urn"]: p["displayName"] for p in state["nodes"].values()})
    edges = {eid: (name[p["sourceEntityId"]], name[p["targetEntityId"]], p["edgeType"])
             for eid, p in state["edges"].items()}

    def named(text):           # the ids a graph made, as the file names them
        return re.sub(r"(urn:uuid:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[A-Z]\w*\d\b",
                      lambda m: str(name.get(m.group(0), edges.get(m.group(0), m.group(0)))), text)

    async with db.graphver_session() as s:
        results = (await s.execute(select(
            ImportResultORM.row_index, ImportResultORM.resolved_op, ImportResultORM.matched_entity_id,
            ImportResultORM.reasons).where(ImportResultORM.job_id == job["job_id"])
            .order_by(ImportResultORM.row_index))).all()
    outcomes = [(i, op, name.get(eid) or edges.get(eid) or (eid and "?"), [named(r) for r in reasons or []])
                for i, op, eid, reasons in results]
    nodes = {p["displayName"]: {k: v for k, v in p.items() if k != "urn"} for p in state["nodes"].values()}
    links = {edges[eid]: {k: v for k, v in p.items() if k not in ("sourceEntityId", "targetEntityId")}
             for eid, p in state["edges"].items()}
    return tallies, outcomes, (nodes, links), calls["resolved"] - calls["landed"]


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    root = tempfile.mkdtemp(prefix="import-bulk-ahead-")
    try:
        store = LocalFsObjectStore(root)
        tallies, outcomes, state, _ = await _load(svc, store, _LEANING, concurrency=1)
        op = {i: (o, label, reasons) for i, o, label, reasons in outcomes}
        # The file does lean on itself the ways the comments say, one window at a time:
        assert op[2][:2] == ("update", "s1-new") and op[9][:2] == ("update", "k0-new")
        assert (op[4][:2], op[5][:2]) == (("unchanged", "a"), ("unchanged", "c"))
        assert op[6][0] == "invalid" and "already names this node" in op[6][2][0]
        assert op[7][0] == "invalid" and op[7][2] == ["code 'C1' is already used by b"], op[7]
        assert op[10][0] == op[12][0] == "invalid", (op[10], op[12])
        assert op[14][:2] == ("unchanged", "g")
        assert op[16][0] == "invalid" and "more than one entity" in op[16][2][0], op[16]
        assert op[21][0] == "create" and op[22][0] == "invalid", "f takes one containment parent"
        assert op[24][0] == "invalid", "and no loop"
        assert op[26][0] == "invalid" and "already names this edge" in op[26][2][0], op[26]
        assert tallies["invalid"] == 8, tallies

        for seed in (1, 2, 3):
            got = await _load(svc, store, _LEANING, concurrency=4, seed=seed)
            assert got[:3] == (tallies, outcomes, state), f"four at once (seed {seed}) differs"
            assert got[3] >= 3, f"windows that lean on one landed since they began are matched again: {got[3]}"

        apart = await _load(svc, store, _APART, concurrency=1)
        got = await _load(svc, store, _APART, concurrency=4, seed=4)
        assert got[:3] == apart[:3] and got[3] == 0, "windows that share nothing are matched once"
    finally:
        shutil.rmtree(root, ignore_errors=True)
        await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")
def test_windows_resolved_ahead_land_what_one_at_a_time_lands(monkeypatch):
    monkeypatch.setattr(config, "IMPORT_COMMIT_WINDOW", 2)
    monkeypatch.setattr(import_worker, "_PARSE_BATCH", 2)
    asyncio.run(_run())
