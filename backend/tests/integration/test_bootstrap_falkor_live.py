"""Enable version control on a REAL FalkorDB: the plans, the collapse, the counts.

The job's contract is pinned on a fake graph in ``test_bootstrap_job.py``; what only a real
FalkorDB can answer is pinned here:

* L1 — every windowed statement is an id-range SEEK (``NodeByIdSeek``), never a scan of the whole
  graph, and every statement of the duplicate collapse reaches its nodes through the label + urn
  INDEX — never a per-row id lookup under UNWIND, which FalkorDB answers with a full scan per row.
* L2 — a source with duplicate urns (one of them under two labels), ``:AGGREGATED`` rollups,
  parallel relationships with distinct ids, a genuine self-loop, an edge between two copies and
  a node with no urn: pause, decide, copy — with the collapse crashing once between moving the
  edges and deleting the copies — and the source graph ends up holding exactly what Postgres
  holds: one node per urn, one relationship per stored edge. Its counts match, and the verify
  after the next publish is clean.
* L3 — the rollups computed over the deleted copies are handed to the rebuild, and only then.

Needs Postgres (``GRAPHVER_E2E=1``) and FalkorDB:
  GRAPHVER_E2E=1 RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
    python -m pytest -q tests/integration/test_bootstrap_falkor_live.py
"""
import os

import pytest
from falkordb.asyncio import FalkorDB
from redis.asyncio import ConnectionPool

from backend.app.services.versioning import bootstrap_worker as bw
from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.bootstrap_worker import (
    BootstrapRunner,
    bootstrap_status,
    create_bootstrap_job,
    decide_duplicates,
)
from backend.app.services.versioning.job_lease import Lease
from backend.app.services.versioning.models import BranchORM, JobORM
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.reconcile import falkor_counts, pg_live_counts_projectable
from backend.app.services.versioning.service import GraphVersioningService
from sqlalchemy import select

pytestmark = [
    pytest.mark.skipif(not os.getenv("GRAPHVER_E2E") or os.getenv("RUN_FALKOR_LIVE") != "1",
                       reason="set GRAPHVER_E2E=1 and RUN_FALKOR_LIVE=1 with FalkorDB reachable"),
]


@pytest.fixture
async def falkor():
    """A FalkorDB handle on a pool of this test's own: each test runs its own event loop, and a
    pooled connection belongs to the loop that opened it. Graphs it hands out are deleted after."""
    pool = ConnectionPool(host=os.getenv("FALKORDB_HOST", "localhost"),
                          port=int(os.getenv("FALKORDB_PORT", "6379")), max_connections=4)
    handle, made = FalkorDB(connection_pool=pool), []

    def graph(name=None):
        made.append(handle.select_graph(name or "gvt_boot_" + os.urandom(4).hex()))
        return made[-1]

    try:
        yield graph
    finally:
        for g in made:
            try:
                await g.delete()
            except Exception:                              # never created: nothing to delete
                pass
        await pool.disconnect()
        await db.dispose_engine()
        # The job reads the data source's ontology through the management engine, whose pool is
        # cached per process: let go of it before this test's loop closes.
        from backend.app.db.engine import close_db
        await close_db()


@pytest.fixture
def graph(falkor):
    client = falkor()
    return client.name, client


@pytest.fixture(autouse=True)
def _small_windows(monkeypatch):
    # Tiny windows: every phase crosses several, as a large graph would.
    monkeypatch.setattr(config, "BOOTSTRAP_SCAN_WIDTH", 3)
    monkeypatch.setattr(config, "BOOTSTRAP_BACKFILL_PAUSE_MS", 0)


async def _rows(client, cypher, params=None):
    return (await client.query(cypher, params or {})).result_set or []


async def _plan(client, cypher, params):
    return " | ".join(line.strip() for line in (await client.explain(cypher, params)).plan)


async def _make_source(client):
    """The L2 source, by internal id:

    0 a  Table  a-old  synced 2026-01  (discarded: 2 is newer)
    1 b  Table
    2 a  Table  a-new  synced 2026-02  (kept)
    3 c  Column                        (kept: no times, lower id)
    4 c  Table                         (discarded — the same urn under another label)
    5 —  Thing  no urn                 (invisible: never copied)
    6 d  Domain
    """
    for props, label in (
            ({"urn": "urn:a", "displayName": "a-old", "lastSyncedAt": "2026-01-01T00:00:00Z"},
             "Table"),
            ({"urn": "urn:b", "displayName": "b"}, "Table"),
            ({"urn": "urn:a", "displayName": "a-new", "lastSyncedAt": "2026-02-01T00:00:00Z"},
             "Table"),
            ({"urn": "urn:c", "displayName": "c-column"}, "Column"),
            ({"urn": "urn:c", "displayName": "c-table"}, "Table"),
            ({"displayName": "no identifier"}, "Thing"),
            ({"urn": "urn:d", "displayName": "d"}, "Domain")):
        await client.query(f"CREATE (n:{label}) SET n = $p", {"p": props})
    ids = [r[0] for r in await _rows(client, "MATCH (n) RETURN ID(n) ORDER BY ID(n)")]
    assert ids == list(range(7)), ids
    for label in ("Table", "Column", "Domain"):
        await client.query(f"CREATE INDEX FOR (n:{label}) ON (n.urn)")
    for src, tgt, rel, props in (
            (0, 1, "FLOWS", {"id": "e1"}), (0, 1, "FLOWS", {"id": "e7"}),   # parallel, two ids
            (1, 0, "FLOWS", {"id": "e5"}),                                  # into a copy to go
            (0, 2, "FLOWS", {"id": "e3"}),                                  # between two copies
            (2, 2, "FLOWS", {"id": "e6"}),                                  # a genuine self-loop
            (4, 1, "OWNS", {"id": "e4"}),                                   # cross-label copy
            (6, 4, "CONTAINS", {"id": "e8"}),                               # into it
            (5, 0, "FLOWS", {}),                                            # from a urn-less node
            (6, 1, "FLOWS", {}), (6, 1, "FLOWS", {}),                       # parallel, no ids
            (0, 6, "AGGREGATED", {"weight": 2}), (6, 1, "AGGREGATED", {"weight": 1})):
        await client.query(f"MATCH (a), (b) WHERE ID(a) = $s AND ID(b) = $t "
                           f"CREATE (a)-[r:{rel}]->(b) SET r = $p", {"s": src, "t": tgt, "p": props})


class _CrashOnce:
    """The live client, except that its first delete of a discarded copy fails — after that
    window's edges were moved — as a dropped connection would."""

    def __init__(self, client):
        self._client, self.crashed = client, False

    async def query(self, cypher, params=None, timeout=None):
        if "DETACH DELETE" in cypher and not self.crashed:
            self.crashed = True
            raise ConnectionResetError("the graph service went away mid-collapse")
        return await self._client.query(cypher, params=params, timeout=timeout)

    async def ro_query(self, cypher, params=None, timeout=None):
        return await self._client.ro_query(cypher, params=params, timeout=timeout)


async def _take(job_id) -> Lease:
    async with db.graphver_session() as s:
        job = await s.get(JobORM, job_id)
        job.retry_count += 1
        job.status = "running"
        job.updated_at = models._now()
        return Lease(job_id=job.id, job_type=job.job_type, epoch=job.retry_count,
                     workspace_id=job.workspace_id, graph_id=job.graph_id)


async def _enable(name):
    await models.create_schema_and_partitions()
    ds = "ds_live_" + os.urandom(4).hex()
    res = await create_bootstrap_job(data_source_id=ds, workspace_id="ws_live", actor="alice",
                                     falkor_graph_name=name, falkor_provider=None)
    return ds, res["graph_id"], res["job_id"]


# ── L1: the plans ────────────────────────────────────────────────────────────

async def test_every_window_seeks_and_every_collapse_step_uses_the_urn_index(graph):
    _name, client = graph
    await _make_source(client)
    window = {"lo": 0, "hi": 3}
    for key in ("_PREFLIGHT_NODES", "_PREFLIGHT_EDGES", "_SCAN_NODES", "_SCAN_EDGES",
                "_COUNT_EDGES_IN_WINDOW", "_BACKFILL_NODES", "_BACKFILL_EDGES",
                "_COUNT_BACKFILL_EDGES"):
        plan = await _plan(client, getattr(bw, key), window)
        print(f"{key}: {plan}")
        assert "NodeByIdSeek" in plan and "All Node Scan" not in plan, (key, plan)

    rows = {"rows": [{"urn": "urn:a", "lid": 0, "wid": 2, "skip": [0, 2]}]}
    collapse = {
        "read out": bw._dupe_edges_cypher("Table", "out"),
        "read in": bw._dupe_edges_cypher("Table", "in"),
        "move keyed": bw._dupe_repoint_cypher("Table", "Table", "FLOWS", "out", True),
        "move keyless": bw._dupe_repoint_cypher("Table", "Column", "FLOWS", "in", False),
        "self-loop": bw._dupe_self_loop_cypher("Table", "Table", "FLOWS"),
        "delete": bw._dupe_delete_cypher("Table"),
        "sample": "UNWIND $urns AS u MATCH (n:`Table` {urn: u}) RETURN ID(n), labels(n), "
                  "properties(n)",
    }
    for key, cypher in collapse.items():
        plan = await _plan(client, cypher, {**rows, "urns": ["urn:a"]})
        print(f"{key}: {plan}")
        assert "Node By Index Scan" in plan, (key, plan)
        for scan in ("All Node Scan", "Node By Label Scan", "NodeByIdSeek"):
            assert scan not in plan, (key, plan)

    # The one full scan left, read once per run (and to re-check a source that waited).
    assert "All Node Scan" in await _plan(client, bw._MAX_NODE_ID, {})


# ── L2: pause, decide, copy, collapse — the source ends up as Postgres has it ─

async def test_a_collapse_leaves_the_source_graph_as_the_copy_has_it(graph):
    name, client = graph
    await _make_source(client)
    hooked = []

    async def hook(graph_id):
        hooked.append(graph_id)

    crashy = _CrashOnce(client)
    runner = BootstrapRunner(lambda _n, _p=None: crashy, on_rollups_stale=hook)
    ds, gid, job_id = await _enable(name)

    assert (await runner.run_job(await _take(job_id)))["status"] == "paused"
    status = await bootstrap_status(data_source_id=ds)
    dup = status["duplicates"]
    assert (dup["identifiers"], dup["extraCopies"], dup["sameType"], dup["crossType"]) == (2, 2, 1, 1)
    assert {(c["urn"], c["internalId"]) for c in dup["sample"] if c["kept"]} == {
        ("urn:a", 2), ("urn:c", 3)}
    assert len(await _rows(client, "MATCH (n) RETURN n")) == 7, "nothing touched while paused"

    await decide_duplicates(data_source_id=ds, fingerprint=dup["fingerprint"], actor="alice")
    out = await runner.run_job(await _take(job_id))
    assert out["status"] == "completed", out
    assert crashy.crashed, "the collapse was interrupted once, and resumed"

    status = await bootstrap_status(data_source_id=ds)
    assert all(c["ok"] for c in status["report"]["checks"]), status["report"]["checks"]
    assert status["report"]["stored"] == {"nodes": 4, "edges": 7}

    # One node per urn — the copies kept — and the urn-less node left alone.
    nodes = await _rows(client, "MATCH (n) RETURN ID(n), n.urn ORDER BY ID(n)")
    assert nodes == [[1, "urn:b"], [2, "urn:a"], [3, "urn:c"], [5, None], [6, "urn:d"]], nodes
    # Every relationship moved to the copy kept, keyed by its id: one per stored edge (the
    # parallel e1/e7 stay two), the edge between two copies gone with them, the rollup over a
    # deleted copy gone with it — and a relationship from the urn-less node moved too.
    rels = sorted(tuple(r) for r in await _rows(
        client, "MATCH (a)-[r]->(b) RETURN ID(a), type(r), ID(b), coalesce(r.id, '')"))
    assert rels == sorted([
        (2, "FLOWS", 1, "e1"), (2, "FLOWS", 1, "e7"), (1, "FLOWS", 2, "e5"),
        (2, "FLOWS", 2, "e6"), (3, "OWNS", 1, "e4"), (6, "CONTAINS", 3, "e8"),
        (5, "FLOWS", 2, ""), (6, "FLOWS", 1, "urn:d|FLOWS|urn:b"),
        (6, "FLOWS", 1, "urn:d|FLOWS|urn:b"), (6, "AGGREGATED", 1, "")]), rels

    # The counts agree: Postgres' projectable counts against the source counted as a graph the
    # projector does not own (urn-bearing nodes; distinct edge triples).
    async with db.graphver_session() as s:
        main_id = (await s.execute(select(BranchORM.id).where(
            BranchORM.graph_id == gid, BranchORM.kind == "main"))).scalars().one()
        pg = await pg_live_counts_projectable(s, gid, main_id)
    assert pg == (4, 6) and await falkor_counts(client, owned=False) == pg
    # (Counted as a graph the projector owns, the urn-less node and the parallel copies would
    # read as "extra entities" on every verify.)
    assert await falkor_counts(client) != pg
    assert hooked == [gid]

    # The next publish projects in place, and its verify is clean: the projector counts the
    # pinned source graph as the reconciler does (owns_falkor_graph=False).
    projector = FalkorProjector(lambda _n, _p=None: client)
    svc = GraphVersioningService()
    await svc.apply_ops(graph_id=gid, actor="bob", message="rename b", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "urn:b",
         "payload": {"urn": "urn:b", "entityType": "Table", "displayName": "b renamed"}}])
    res = await projector.project_graph(gid)
    assert res.get("verify_error") is None, res
    assert await _rows(client, "MATCH (n:Table {urn: 'urn:b'}) RETURN n.displayName") == [
        ["b renamed"]]


# ── L3: the rollups are handed to the rebuild only when copies were deleted ───

async def test_the_rollup_rebuild_is_queued_only_after_a_collapse(graph, falkor):
    name, client = graph
    for urn in ("urn:x", "urn:y"):
        await client.query("CREATE (:Table {urn: $u})", {"u": urn})
    await client.query("MATCH (a {urn: 'urn:x'}), (b {urn: 'urn:y'}) "
                       "CREATE (a)-[:FLOWS {id: 'f1'}]->(b), (a)-[:AGGREGATED {weight: 1}]->(b)")
    hooked = []

    async def hook(graph_id):
        hooked.append(graph_id)

    runner = BootstrapRunner(lambda _n, _p=None: client, on_rollups_stale=hook)
    _ds, _gid, job_id = await _enable(name)
    assert (await runner.run_job(await _take(job_id)))["status"] == "completed"
    assert hooked == [], "no copy was deleted: the rollups still describe the graph"

    dupes = falkor()
    other = dupes.name
    await dupes.query("CREATE (:Table {urn: 'urn:x'}), (:Table {urn: 'urn:x'}), "
                      "(:Table {urn: 'urn:y'})")
    await dupes.query("MATCH (a), (b {urn: 'urn:y'}) WHERE ID(a) = 1 "
                      "CREATE (a)-[:AGGREGATED {weight: 1}]->(b)")
    runner = BootstrapRunner(lambda _n, _p=None: dupes, on_rollups_stale=hook)
    ds, gid, job_id = await _enable(other)
    assert (await runner.run_job(await _take(job_id)))["status"] == "paused"
    fp = (await bootstrap_status(data_source_id=ds))["duplicates"]["fingerprint"]
    await decide_duplicates(data_source_id=ds, fingerprint=fp, actor="alice")
    assert (await runner.run_job(await _take(job_id)))["status"] == "completed"
    assert hooked == [gid], "copies were deleted: their rollups must be rebuilt"
    assert await _rows(dupes, "MATCH ()-[r:AGGREGATED]->() RETURN count(r)") == [[0]]
