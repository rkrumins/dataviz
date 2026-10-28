"""Enable version control on a REAL FalkorDB: the plans, the collapse, the counts.

The job's contract is pinned on a fake graph in ``test_bootstrap_job.py``; what only a real
FalkorDB can answer is pinned here:

* L1 — every windowed statement is an id-range SEEK (``NodeByIdSeek``), never a scan of the whole
  graph, and every statement of the duplicate collapse reaches its nodes through the label + urn
  INDEX — never a per-row id lookup under UNWIND, which FalkorDB answers with a full scan per row.
* L2 — a source with duplicate urns (one of them under two labels), ``:AGGREGATED`` rollups,
  parallel relationships with distinct ids, a genuine self-loop, an edge between two copies and
  edges with no id: pause, decide, copy — with the collapse crashing once between moving the
  edges and deleting the copies — and the source graph ends up holding exactly what Postgres
  holds: one node per urn, one relationship per stored edge. Its counts match, and the verify
  after the next publish is clean.
* L3 — the rollups computed over the deleted copies are handed to the rebuild, and only then.
* L5 — a graph that keys its nodes by another property (``id``) gets ``urn`` stamped from it
  before the copy, so the copy holds every node and a publish lands on the node that is there; a
  node with no identifier at all stops the enable before anything is copied.
* L6 — an edge whose id is also a node's urn, re-keyed ``edge:<id>`` in history, keeps the graph's
  own id through an update, and a delete reaches it: every publish goes out fresh.
* L7 — something else keeps writing to the graph after the enable (a node, a relationship, a
  property on a node history holds): publishes still go out fresh, the outside writes are kept and
  counted (``external_drift``), and a Rebuild writes history back while deleting none of them.
  Bringing them into history reads the graph itself and commits those writes and nothing else:
  not the graph's spelling of a type, not the empty fields the projector writes. Over HTTP, the
  route finds the graph through the projection's pin, clears the flag and queues the summaries'
  rebuild.
* L4 — a graph that spells its types its own way (``:table``, ``:flows_to``) against an ontology
  that declares ``Table`` and ``FLOWS_TO`` keeps its spelling: history holds the declared one, and
  every publish after the enable lands on the graph's own labels and goes out fresh.

Needs Postgres (``GRAPHVER_E2E=1``) and FalkorDB:
  GRAPHVER_E2E=1 RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
    python -m pytest -q tests/integration/test_bootstrap_falkor_live.py
"""
import json
import os

import pytest
from falkordb.asyncio import FalkorDB
from redis.asyncio import ConnectionPool

from backend.app.providers.falkordb_provider import FalkorDBProvider
from backend.app.services.versioning import bootstrap_worker as bw
from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.bootstrap_worker import (
    BootstrapRunner,
    bootstrap_status,
    create_bootstrap_job,
    decide_duplicates,
    retry_bootstrap,
)
from backend.app.services.versioning.job_lease import Lease
from backend.app.services.versioning.models import BranchORM, GraphORM, JobORM, ProjectionStateORM
from backend.app.services.versioning.ontology import EdgeRule, EntityRule, OntologyRules
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.reconcile import (
    ProjectionReconciler,
    falkor_counts,
    pg_live_counts_projectable,
)
from backend.app.services.versioning.service import GraphVersioningService
from sqlalchemy import func, select

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
    5 e  Thing
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
            ({"urn": "urn:e", "displayName": "e"}, "Thing"),
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
            (5, 0, "FLOWS", {}),                                            # no id, into a copy
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
    assert status["report"]["stored"] == {"nodes": 5, "edges": 8}

    # One node per urn — the copies kept.
    nodes = await _rows(client, "MATCH (n) RETURN ID(n), n.urn ORDER BY ID(n)")
    assert nodes == [[1, "urn:b"], [2, "urn:a"], [3, "urn:c"], [5, "urn:e"], [6, "urn:d"]], nodes
    # Every relationship moved to the copy kept, keyed by its id: one per stored edge (the
    # parallel e1/e7 stay two), the edge between two copies gone with them, the rollup over a
    # deleted copy gone with it — and an id-less relationship into a copy moved too, stamped.
    rels = sorted(tuple(r) for r in await _rows(
        client, "MATCH (a)-[r]->(b) RETURN ID(a), type(r), ID(b), coalesce(r.id, '')"))
    assert rels == sorted([
        (2, "FLOWS", 1, "e1"), (2, "FLOWS", 1, "e7"), (1, "FLOWS", 2, "e5"),
        (2, "FLOWS", 2, "e6"), (3, "OWNS", 1, "e4"), (6, "CONTAINS", 3, "e8"),
        (5, "FLOWS", 2, "urn:e|FLOWS|urn:a"), (6, "FLOWS", 1, "urn:d|FLOWS|urn:b"),
        (6, "FLOWS", 1, "urn:d|FLOWS|urn:b"), (6, "AGGREGATED", 1, "")]), rels

    # The counts agree: Postgres' projectable counts against the source counted as a graph the
    # projector does not own (urn-bearing nodes; distinct edge triples).
    async with db.graphver_session() as s:
        main_id = (await s.execute(select(BranchORM.id).where(
            BranchORM.graph_id == gid, BranchORM.kind == "main"))).scalars().one()
        pg = await pg_live_counts_projectable(s, gid, main_id)
    assert pg == (5, 7) and await falkor_counts(client, owned=False) == pg
    # (Counted as a graph the projector owns, the parallel copies would read as "extra
    # entities" on every verify.)
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


async def _fresh(gid) -> bool:
    async with db.graphver_session() as s:
        ps, g = await s.get(ProjectionStateORM, gid), await s.get(GraphORM, gid)
        return ps.projected_commit_seq == g.main_head_commit_seq


# ── L5: a graph keyed by another property gets urns before the copy ──────────

async def test_a_graph_keyed_by_another_property_is_stamped_then_copied(graph, monkeypatch):
    """The data source names its nodes by ``id``. The enable stamps ``urn`` (and ``urnSource``)
    from it, as the summaries' conformance step does, then copies every node — before, the copy
    read ``urn`` alone and finished green with nothing in it. A publish then updates the node
    that is there."""
    name, client = graph
    for i in ("x1", "x2"):
        await client.query("CREATE (:Table {id: $i, name: $i})", {"i": i})
    await client.query("MATCH (a:Table {id: 'x1'}), (b:Table {id: 'x2'}) "
                       "CREATE (a)-[:FLOWS {id: 'f1'}]->(b)")
    provider = FalkorDBProvider(host=os.getenv("FALKORDB_HOST", "localhost"),
                                port=int(os.getenv("FALKORDB_PORT", "6379")), graph_name=name)
    provider.set_node_identity("id", "name")

    async def stamp(_job_id):
        return {"property": "id", "stamped": await provider.stamp_identity_urns()}

    monkeypatch.setattr(bw, "_stamp_identity", stamp)
    ds, gid, job_id = await _enable(name)
    out = await BootstrapRunner(lambda _n, _p=None: client).run_job(await _take(job_id))
    assert out["status"] == "completed", out
    status = await bootstrap_status(data_source_id=ds)
    assert status["report"]["stored"] == {"nodes": 2, "edges": 1}, status["report"]
    assert await _rows(client, "MATCH (n:Table) RETURN n.id, n.urn, n.urnSource ORDER BY n.id") == [
        ["x1", "x1", "id"], ["x2", "x2", "id"]]

    svc, projector = GraphVersioningService(), FalkorProjector(lambda _n, _p=None: client)
    await svc.apply_ops(graph_id=gid, actor="bob", message="rename x1", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "x1",
         "payload": {"urn": "x1", "entityType": "Table", "displayName": "x1 renamed"}}])
    res = await projector.project_graph(gid)
    assert res.get("verify_error") is None and await _fresh(gid), res
    assert await _rows(client, "MATCH (n:Table) RETURN n.id, n.displayName ORDER BY n.id") == [
        ["x1", "x1 renamed"], ["x2", "x2"]], "the node that was there, not a second copy"


async def test_a_node_with_no_identifier_stops_the_enable_before_the_copy(graph, monkeypatch):
    name, client = graph
    await client.query("CREATE (:Table {id: 'x1'}), (:Table {name: 'nameless'})")
    provider = FalkorDBProvider(host=os.getenv("FALKORDB_HOST", "localhost"),
                                port=int(os.getenv("FALKORDB_PORT", "6379")), graph_name=name)
    provider.set_node_identity("id", "name")

    async def stamp(_job_id):
        return {"property": "id", "stamped": await provider.stamp_identity_urns()}

    monkeypatch.setattr(bw, "_stamp_identity", stamp)
    ds, gid, job_id = await _enable(name)
    out = await BootstrapRunner(lambda _n, _p=None: client).run_job(await _take(job_id))
    assert out["status"] == "failed", out
    assert "1 item in the graph has no urn and no id to take one from" in out["error"], out
    async with db.graphver_session() as s:
        assert (await s.get(JobORM, job_id)).current_phase == "counting", "nothing was copied"
    # urn and urnSource on x1; displayName and nameSource, from its name, on the other.
    assert (await bootstrap_status(data_source_id=ds))["identityStamped"] == {
        "property": "id", "stamped": 4}

    # Starting over stamps nothing new, and still says what the graph was given.
    await retry_bootstrap(data_source_id=ds, mode="restart")
    out = await BootstrapRunner(lambda _n, _p=None: client).run_job(await _take(job_id))
    assert out["status"] == "failed", out
    assert (await bootstrap_status(data_source_id=ds))["identityStamped"] == {
        "property": "id", "stamped": 4}


# ── L6: an edge whose id is also a node's ─────────────────────────────────────

async def test_an_edge_whose_id_was_a_node_keeps_it_and_a_delete_reaches_it(graph):
    """Nodes and edges share one id space, so the copy re-keys an edge whose id is also a node's
    urn to ``edge:<id>``, while the graph still calls it ``<id>``. An update leaves the graph's id
    on it; a delete removes it and only it."""
    name, client = graph
    for urn in ("X", "Y", "urn:a", "urn:b"):
        await client.query("CREATE (:Table {urn: $u})", {"u": urn})
    await client.query("MATCH (a:Table {urn: 'urn:a'}), (b:Table {urn: 'urn:b'}) "
                       "CREATE (a)-[:FLOWS {id: 'X'}]->(b), (b)-[:OWNS {id: 'Y'}]->(a)")
    ds, gid, job_id = await _enable(name)
    out = await BootstrapRunner(lambda _n, _p=None: client).run_job(await _take(job_id))
    assert out["status"] == "completed", out
    assert (await bootstrap_status(data_source_id=ds))["rekeyedEdges"] == 2

    svc, projector = GraphVersioningService(), FalkorProjector(lambda _n, _p=None: client)
    for message, op in (
            ("weigh X", {"op": "update", "entity_kind": "edge", "entity_id": "edge:X",
                         "payload": {"properties": {"w": 2}}}),
            ("drop Y", {"op": "delete", "entity_kind": "edge", "entity_id": "edge:Y",
                        "payload": None})):
        await svc.apply_ops(graph_id=gid, actor="bob", message=message, ops=[op])
        res = await projector.project_graph(gid)
        assert res.get("verify_error") is None and await _fresh(gid), (message, res)

    rels = await _rows(client, "MATCH ()-[r]->() WHERE type(r) <> 'AGGREGATED' "
                               "RETURN type(r), r.id, r.properties")
    assert [r[:2] for r in rels] == [["FLOWS", "X"]], rels
    assert json.loads(rels[0][2]) == {"w": 2}
    assert await _rows(client, "MATCH (n:Table) RETURN n.urn ORDER BY n.urn") == [
        ["X"], ["Y"], ["urn:a"], ["urn:b"]], "only the edge was deleted"
    # The id the graph uses names the edge, never the node that shares it.
    named = await svc.resolve_edges(graph_id=gid, edge_ids=["X", "Y", "Z"])
    assert (named["X"][0], named["Y"]) == ("edge:X", None) and "Z" not in named, named


# ── L7: something else keeps writing to the graph ────────────────────────────

async def _drift(gid):
    async with db.graphver_session() as s:
        d = (await s.get(ProjectionStateORM, gid)).external_drift
    return d and {k: v for k, v in d.items() if k != "at"}


async def test_writes_from_outside_history_are_kept_flagged_and_survive_a_rebuild(graph):
    """An ETL keeps writing after the enable. Views keep reading FalkorDB — ETL data included —
    because every publish still goes out fresh; what history doesn't hold is counted, not
    deleted; the platform's own delete still lands; and a Rebuild deletes nothing it didn't
    write."""
    name, client = graph
    for urn in ("urn:a", "urn:b", "urn:c"):
        await client.query("CREATE (:Table {urn: $u, displayName: $u})", {"u": urn})
    await client.query("CREATE INDEX FOR (n:Table) ON (n.urn)")
    await client.query("MATCH (a:Table {urn: 'urn:a'}), (b:Table {urn: 'urn:b'}) "
                       "CREATE (a)-[:FLOWS {id: 'f1'}]->(b)")
    _ds, gid, job_id = await _enable(name)
    out = await BootstrapRunner(lambda _n, _p=None: client).run_job(await _take(job_id))
    assert out["status"] == "completed", out

    # The ETL, after the enable: a node, a relationship, and a property on a node history holds.
    await client.query("CREATE (:Table {urn: 'urn:etl', displayName: 'from the etl'})")
    await client.query("MATCH (a:Table {urn: 'urn:etl'}), (b:Table {urn: 'urn:a'}) "
                       "CREATE (a)-[:FLOWS {id: 'f9'}]->(b)")
    await client.query("MATCH (n:Table {urn: 'urn:a'}) SET n.owner = 'etl-team'")

    svc, projector = GraphVersioningService(), FalkorProjector(lambda _n, _p=None: client)
    for message, op in (
            ("rename a", {"op": "update", "entity_kind": "node", "entity_id": "urn:a",
                          "payload": {"urn": "urn:a", "entityType": "Table",
                                      "displayName": "a renamed"}}),
            ("delete c", {"op": "delete", "entity_kind": "node", "entity_id": "urn:c",
                          "payload": None})):
        await svc.apply_ops(graph_id=gid, actor="bob", message=message, ops=[op])
        res = await projector.project_graph(gid)
        assert res.get("verify_error") is None and await _fresh(gid), (message, res)
    assert await _drift(gid) == {"nodes": 1, "edges": 1, "via": "verify"}

    async def held():
        return (await _rows(client, "MATCH (n:Table) RETURN n.urn, n.displayName, n.owner "
                                    "ORDER BY n.urn"),
                await _rows(client, "MATCH ()-[r:FLOWS]->() RETURN r.id ORDER BY r.id"))

    assert await held() == ([["urn:a", "a renamed", "etl-team"], ["urn:b", "urn:b", None],
                             ["urn:etl", "from the etl", None]], [["f1"], ["f9"]])

    # A Rebuild writes history back into the graph and deletes nothing history doesn't hold.
    assert await svc.request_projection_rebuild(gid)
    res = await projector.project_graph(gid)
    assert res.get("verify_error") is None and await _fresh(gid), res
    assert await held() == ([["urn:a", "a renamed", "etl-team"], ["urn:b", "urn:b", None],
                             ["urn:etl", "from the etl", None]], [["f1"], ["f9"]])
    assert await _drift(gid) == {"nodes": 1, "edges": 1, "via": "verify"}

    # Gone from the graph, the flag clears with the next publish.
    await client.query("MATCH (n:Table {urn: 'urn:etl'}) DETACH DELETE n")
    await svc.apply_ops(graph_id=gid, actor="bob", message="rename b", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "urn:b",
         "payload": {"urn": "urn:b", "entityType": "Table", "displayName": "b renamed"}}])
    res = await projector.project_graph(gid)
    assert res.get("verify_error") is None and await _fresh(gid), res
    assert await _drift(gid) is None


async def test_bring_into_history_takes_in_what_the_graph_holds_and_nothing_else(graph,
                                                                               monkeypatch):
    """What the graph's other writers put there — a node, relationships, a property — goes into
    history as one sync commit read from the graph itself. Nothing the projector wrote reads back
    as a change: not the graph's own spelling of a type, not the empty fields it writes, not an
    edge whose id was a node's. A new edge the ETL gave a node's id is keyed ``edge:<id>``, as
    the enable keys it. The flag clears with the publish that follows."""
    name, client = graph
    for urn in ("urn:a", "urn:b", "X"):
        await client.query("CREATE (:table {urn: $u, displayName: $u, sourceSystem: 'dbt'})",
                           {"u": urn})
    await client.query("CREATE INDEX FOR (n:table) ON (n.urn)")
    await client.query("MATCH (a:table {urn: 'urn:a'}), (b:table {urn: 'urn:b'}) "
                       "CREATE (a)-[:flows {id: 'f1'}]->(b), (b)-[:flows {id: 'X'}]->(a)")
    rules = OntologyRules(entity_types={"Table": EntityRule()}, edge_types={"FLOWS": EdgeRule()},
                          edge_type_canonical={"FLOWS": "FLOWS"})

    async def declared(_job_id):
        return rules

    monkeypatch.setattr(bw, "_ontology_rules", declared)
    _ds, gid, job_id = await _enable(name)
    out = await BootstrapRunner(lambda _n, _p=None: client).run_job(await _take(job_id))
    assert out["status"] == "completed", out
    svc, projector = GraphVersioningService(), FalkorProjector(lambda _n, _p=None: client)
    await svc.apply_ops(graph_id=gid, actor="bob", message="rename a", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "urn:a",
         "payload": {"urn": "urn:a", "entityType": "Table", "displayName": "a renamed"}}])
    assert (await projector.project_graph(gid)).get("verify_error") is None

    # The ETL: a node, a relationship, one whose id is a node's, and a property.
    await client.query("CREATE (:table {urn: 'urn:etl', displayName: 'from the etl'})")
    await client.query("MATCH (e:table {urn: 'urn:etl'}), (a:table {urn: 'urn:a'}), "
                       "(b:table {urn: 'urn:b'}) "
                       "CREATE (e)-[:flows {id: 'f9'}]->(a), (e)-[:flows {id: 'urn:b'}]->(b)")
    await client.query("MATCH (n:table {urn: 'urn:b'}) SET n.owner = 'etl-team'")
    await svc.apply_ops(graph_id=gid, actor="bob", message="rename b", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "urn:b",
         "payload": {"urn": "urn:b", "entityType": "Table", "displayName": "b renamed"}}])
    assert (await projector.project_graph(gid)).get("verify_error") is None
    assert await _drift(gid) == {"nodes": 1, "edges": 2, "via": "verify"}

    provider = FalkorDBProvider(host=os.getenv("FALKORDB_HOST", "localhost"),
                                port=int(os.getenv("FALKORDB_PORT", "6379")), graph_name=name)
    provider.set_containment_edge_types([])
    res = await svc.resync_from_provider(graph_id=gid, provider=provider, actor="bob",
                                         ontology_rules=rules, holds_main=True)
    changed = []
    async with db.graphver_session() as s:
        for m in (models.NodeVersionORM, models.EdgeVersionORM):
            changed += [(m.__name__[:4], op, eid) for eid, op in (await s.execute(
                select(m.entity_id, m.op).where(m.graph_id == gid,
                                                m.commit_seq == res["commit_seq"]))).all()]
    changed.sort()
    assert changed == [("Edge", "create", "edge:urn:b"), ("Edge", "create", "f9"),
                       ("Node", "create", "urn:etl"), ("Node", "update", "urn:b")], changed
    b = await svc.entity_value(graph_id=gid, entity_id="urn:b")
    assert (b["entityType"], b["displayName"], b["properties"]) == (
        "Table", "b renamed", {"owner": "etl-team"}), b
    assert (await projector.project_graph(gid)).get("verify_error") is None and await _fresh(gid)
    assert await _drift(gid) is None
    assert (await _rows(client, "MATCH ()-[r:flows]->() RETURN r.id ORDER BY r.id")) == [
        ["X"], ["f1"], ["f9"], ["urn:b"]], "the graph's own ids, and no copies"


async def test_bring_into_history_over_http_reads_the_graph_and_clears_the_flag(graph,
                                                                               monkeypatch):
    """``POST /graph/resync`` as the UI sends it, with the real provider manager: it reads the
    data source's graph through the projection's pin — not whatever serves reads — brings the
    ETL's writes into history, clears the flag at once, and queues the summaries' rebuild."""
    from httpx import ASGITransport, AsyncClient

    from backend.app.db.engine import PoolRole, get_session_factory
    from backend.app.db.models import (
        OntologyORM, ProviderORM, WorkspaceDataSourceORM, WorkspaceORM,
    )
    from backend.app.providers.manager import provider_manager
    from backend.app.services import projection_target
    from backend.tests.integration.test_api_graph_draft_journey import _build_app

    name, client = graph
    for urn in ("urn:a", "urn:b"):
        await client.query("CREATE (:Table {urn: $u, displayName: $u})", {"u": urn})
    await client.query("CREATE INDEX FOR (n:Table) ON (n.urn)")
    await client.query("MATCH (a:Table {urn: 'urn:a'}), (b:Table {urn: 'urn:b'}) "
                       "CREATE (a)-[:FLOWS {id: 'f1'}]->(b)")
    tag = os.urandom(3).hex()
    ws, prov, ds, ont = f"ws_bih_{tag}", f"prov_bih_{tag}", f"ds_bih_{tag}", f"bp_bih_{tag}"
    async with get_session_factory(PoolRole.WEB)() as s:
        s.add_all([WorkspaceORM(id=ws, name=ws),
                   ProviderORM(id=prov, name=prov, provider_type="falkordb",
                               host=os.getenv("FALKORDB_HOST", "localhost"),
                               port=int(os.getenv("FALKORDB_PORT", "6379"))),
                   # The data source's own ontology: a deployment always resolves one (the
                   # system default is seeded at start-up, which this process never ran).
                   OntologyORM(id=ont, name=ont, is_published=True,
                               entity_type_definitions=json.dumps({"Table": {"name": "Table"}}),
                               relationship_type_definitions=json.dumps(
                                   {"FLOWS": {"name": "FLOWS", "is_lineage": True}}))])
        await s.flush()
        s.add(WorkspaceDataSourceORM(id=ds, workspace_id=ws, provider_id=prov, graph_name=name,
                                     ontology_id=ont))
        await s.commit()
    await models.create_schema_and_partitions()
    job = await create_bootstrap_job(data_source_id=ds, workspace_id=ws, actor="alice",
                                     falkor_graph_name=name, falkor_provider=prov)
    gid = job["graph_id"]
    out = await BootstrapRunner(lambda _n, _p=None: client).run_job(await _take(job["job_id"]))
    assert out["status"] == "completed", out

    await client.query("CREATE (:Table {urn: 'urn:etl', displayName: 'from the etl'})")
    await client.query("MATCH (e:Table {urn: 'urn:etl'}), (a:Table {urn: 'urn:a'}) "
                       "CREATE (e)-[:FLOWS {id: 'f9'}]->(a)")
    svc, projector = GraphVersioningService(), FalkorProjector(lambda _n, _p=None: client)
    await svc.apply_ops(graph_id=gid, actor="bob", message="rename a", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "urn:a",
         "payload": {"urn": "urn:a", "entityType": "Table", "displayName": "a renamed"}}])
    assert (await projector.project_graph(gid)).get("verify_error") is None
    assert await _drift(gid) == {"nodes": 1, "edges": 1, "via": "verify"}

    queued = []

    async def queue(ds_id, _key, _mode):
        queued.append(ds_id)

    monkeypatch.setattr(projection_target, "_queue_on_control_plane", queue)
    app, _G = _build_app()
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            r = await c.post(f"/api/v1/{ws}/graph/resync", params={"dataSourceId": ds})
    finally:
        await provider_manager.evict_data_source(prov, name)
    assert r.status_code == 200, r.text
    assert r.json()["applied"] == 2, r.json()
    assert await _drift(gid) is None and queued == [ds]
    assert (await projector.project_graph(gid)).get("verify_error") is None and await _fresh(gid)
    assert await _drift(gid) is None


# ── L4: a graph that spells its types its own way keeps that spelling ────────

async def test_a_graph_keeps_its_own_spelling_of_its_types(graph, monkeypatch):
    """An update lands on the node that is there, not on a second ``:Table`` copy; a delete finds
    it; a new relationship is a ``flows_to``; an edge's new property lands on it. Every publish is
    verified and goes out fresh, and the sync check finds nothing out of place."""
    name, client = graph
    for urn in ("urn:t1", "urn:t2", "urn:t3"):
        await client.query("CREATE (:table {urn: $u, displayName: $u})", {"u": urn})
    await client.query("CREATE INDEX FOR (n:table) ON (n.urn)")
    await client.query("MATCH (a:table {urn: 'urn:t1'}), (b:table {urn: 'urn:t2'}) "
                       "CREATE (a)-[:flows_to {id: 'f1', properties: $p}]->(b)",
                       {"p": json.dumps({"w": 1})})
    rules = OntologyRules(entity_types={"Table": EntityRule()}, edge_types={"FLOWS_TO": EdgeRule()},
                          edge_type_canonical={"FLOWS_TO": "FLOWS_TO"})

    async def declared(_job_id):
        return rules

    monkeypatch.setattr(bw, "_ontology_rules", declared)
    _ds, gid, job_id = await _enable(name)
    out = await BootstrapRunner(lambda _n, _p=None: client).run_job(await _take(job_id))
    assert out["status"] == "completed", out
    async with db.graphver_session() as s:
        assert (await s.get(ProjectionStateORM, gid)).physical_types == {
            "nodes": {"Table": "table"}, "edges": {"FLOWS_TO": "flows_to"}}

    svc, projector = GraphVersioningService(), FalkorProjector(lambda _n, _p=None: client)
    for message, op in (
            ("rename t1", {"op": "update", "entity_kind": "node", "entity_id": "urn:t1",
                           "payload": {"urn": "urn:t1", "entityType": "Table",
                                       "displayName": "t1 renamed"}}),
            ("delete t3", {"op": "delete", "entity_kind": "node", "entity_id": "urn:t3",
                           "payload": None}),
            ("t2 flows to t1", {"op": "create", "entity_kind": "edge", "entity_id": "f2",
                                "payload": {"sourceEntityId": "urn:t2", "targetEntityId": "urn:t1",
                                            "edgeType": "FLOWS_TO"}}),
            ("weigh f1", {"op": "update", "entity_kind": "edge", "entity_id": "f1",
                          "payload": {"properties": {"w": 2}}})):
        await svc.apply_ops(graph_id=gid, actor="bob", message=message, ops=[op])
        res = await projector.project_graph(gid)
        assert res.get("verify_error") is None, (message, res)
        assert await _fresh(gid), (message, res)

    assert await _rows(client, "MATCH (n:Table) RETURN count(n)") == [[0]]
    assert await _rows(client, "MATCH ()-[r:FLOWS_TO]->() RETURN count(r)") == [[0]]
    assert await _rows(client, "MATCH (n:table) RETURN n.urn, n.displayName ORDER BY n.urn") == [
        ["urn:t1", "t1 renamed"], ["urn:t2", "urn:t2"]]
    rels = await _rows(client, "MATCH (a)-[r:flows_to]->(b) "
                               "RETURN a.urn, r.id, b.urn, r.properties ORDER BY r.id")
    assert [r[:3] for r in rels] == [["urn:t1", "f1", "urn:t2"], ["urn:t2", "f2", "urn:t1"]], rels
    assert json.loads(rels[0][3]) == {"w": 2}
    report = await ProjectionReconciler(db.graphver_session, lambda _n, _p=None: client).reconcile(
        gid, deep=True)
    assert report.in_sync and not report.mismatched and not report.edge_mismatched, report


async def test_a_type_the_graph_spells_two_ways_stops_the_enable(graph, monkeypatch):
    """``table`` and ``TABLE`` are both the declared ``Table``: history can keep one spelling, and
    the projector would reach only the nodes under it. The checks stop the enable and say why;
    nothing becomes visible."""
    name, client = graph
    await client.query("CREATE (:table {urn: 'urn:a'}), (:TABLE {urn: 'urn:b'})")
    rules = OntologyRules(entity_types={"Table": EntityRule()})

    async def declared(_job_id):
        return rules

    monkeypatch.setattr(bw, "_ontology_rules", declared)
    ds, gid, job_id = await _enable(name)
    out = await BootstrapRunner(lambda _n, _p=None: client).run_job(await _take(job_id))
    assert out["status"] == "failed" and "spelled more than one way" in out["error"], out
    status = await bootstrap_status(data_source_id=ds)
    failed = [c for c in status["report"]["checks"] if not c["ok"]]
    assert [(c["key"], c["detail"]) for c in failed] == [
        ("one_spelling_per_type", "Table is spelled TABLE and table")], failed
    async with db.graphver_session() as s:
        assert (await s.get(GraphORM, gid)).main_head_commit_seq <= 1, "nothing became visible"


# ── a graph server that cuts replies short ───────────────────────────────────

async def test_a_server_that_cuts_replies_short_is_refused_before_anything_is_read(graph):
    """FalkorDB's RESULTSET_SIZE drops every row past it without a word (the stock image ships
    10000). Read through such a cap, the pre-flight sees part of each window, so duplicates go
    unseen and the copy fails on them later as "the source changed". The job must stop at the
    pre-flight instead — nothing ranked, nothing copied — and say what to change."""
    name, client = graph
    await _make_source(client)
    was = (await client.execute_command("GRAPH.CONFIG", "GET", "RESULTSET_SIZE"))[1]
    await client.execute_command("GRAPH.CONFIG", "SET", "RESULTSET_SIZE", 2)
    try:
        ds, gid, job_id = await _enable(name)
        out = await BootstrapRunner(lambda _n, _p=None: client).run_job(await _take(job_id))
    finally:
        await client.execute_command("GRAPH.CONFIG", "SET", "RESULTSET_SIZE", was)
    assert out["status"] == "failed", out
    assert "RESULTSET_SIZE" in out["error"]
    assert (await bootstrap_status(data_source_id=ds))["status"] == "failed"
    async with db.graphver_session() as s:
        assert (await s.get(JobORM, job_id)).current_phase == "counting"
        read = (await s.execute(select(func.count()).select_from(models.BootstrapNodeORM).where(
            models.BootstrapNodeORM.graph_id == gid))).scalar_one()
    assert read == 0, "nothing is read through a cap"
