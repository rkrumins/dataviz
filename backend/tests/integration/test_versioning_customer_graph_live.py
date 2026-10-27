"""A data source's own graph under version control: the platform never deletes what it didn't write.

Turning version control on for an external FalkorDB graph leaves that graph the customer's
(``owns_falkor_graph`` false) and makes the version history its system of record. Pinned here on a
REAL FalkorDB, because each of these is a statement about what the graph holds afterwards:

* Writes from outside the platform after enabling are drift, reported — never a reason to stop
  serving the live graph: a publish still lands and the projection stays fresh.
* A tracked item removed behind the platform's back comes back at the next publish (history wins
  for what it tracks), and nothing it doesn't track goes on the way.
* A rebuild writes what history holds and deletes nothing the platform didn't write: nodes without
  a urn, items written outside history, parallel relationships and their own ids.
* Editing an entity removes only the properties history removed, not ones written outside it.

Needs Postgres and FalkorDB, as ``test_bootstrap_falkor_live.py`` does:
  GRAPHVER_E2E=1 RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
    python -m pytest -q tests/integration/test_versioning_customer_graph_live.py
"""
import os

import pytest

from backend.app.services.versioning.bootstrap_worker import BootstrapRunner
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.service import GraphVersioningService
from backend.common.property_patch import PROP_DELETE
from backend.tests.integration.test_bootstrap_falkor_live import (  # noqa: F401 — fixtures
    _enable,
    _rows,
    _small_windows,
    _take,
    falkor,
    graph,
)

pytestmark = [
    pytest.mark.skipif(not os.getenv("GRAPHVER_E2E") or os.getenv("RUN_FALKOR_LIVE") != "1",
                       reason="set GRAPHVER_E2E=1 and RUN_FALKOR_LIVE=1 with FalkorDB reachable"),
]


async def _enabled(client, name) -> str:
    _ds, gid, job_id = await _enable(name)
    out = await BootstrapRunner(lambda _n, _p=None: client).run_job(await _take(job_id))
    assert out["status"] == "completed", out
    return gid


async def _publish(gid, *ops):
    await GraphVersioningService().apply_ops(graph_id=gid, actor="bob", message="edit",
                                             ops=list(ops))


async def _project(client, gid):
    res = await FalkorProjector(lambda _n, _p=None: client).project_graph(gid)
    assert res.get("verify_error") is None, res
    wm = await GraphVersioningService().projection_watermark(gid)
    assert wm["fresh"], ("reads stay on the live graph", wm)
    return wm


def _rename(urn, name):
    return {"op": "update", "entity_kind": "node", "entity_id": urn,
            "payload": {"displayName": name}}


async def test_outside_writes_are_drift_and_the_live_graph_keeps_serving(graph):
    name, client = graph
    await client.query("CREATE (:Table {urn: 'u1', displayName: 'one'}), "
                       "(:Table {urn: 'u2', displayName: 'two'})")
    await client.query("MATCH (a:Table {urn: 'u1'}), (b:Table {urn: 'u2'}) CREATE (a)-[:FLOWS]->(b)")
    gid = await _enabled(client, name)
    # Behind the platform's back: a node and a relationship the history never saw.
    await client.query("CREATE (:Table {urn: 'u3', displayName: 'loaded elsewhere'})")
    await client.query("MATCH (a:Table {urn: 'u3'}), (b:Table {urn: 'u1'}) CREATE (a)-[:FLOWS]->(b)")

    await _publish(gid, _rename("u1", "one renamed"))
    wm = await _project(client, gid)

    assert await _rows(client, "MATCH (n:Table {urn: 'u1'}) RETURN n.displayName") == [["one renamed"]]
    assert await _rows(client, "MATCH (n:Table {urn: 'u3'})-[:FLOWS]->() RETURN count(n)") == [[1]]
    assert wm["drift"]["outsideHistory"] == {"nodes": 1, "relationships": 1}, wm["drift"]


async def test_a_tracked_item_removed_behind_the_scenes_comes_back_and_nothing_else_goes(graph):
    name, client = graph
    await client.query("CREATE (:Table {urn: 'u1'}), (:Table {urn: 'u2'})")
    await client.query("MATCH (a:Table {urn: 'u1'}), (b:Table {urn: 'u2'}) CREATE (a)-[:FLOWS]->(b)")
    gid = await _enabled(client, name)
    await client.query("MATCH (n:Table {urn: 'u2'}) DETACH DELETE n")
    await client.query("CREATE (:Table {urn: 'u3'})")

    await _publish(gid, _rename("u1", "one"))
    await _project(client, gid)

    assert await _rows(client, "MATCH (:Table {urn: 'u1'})-[r:FLOWS]->(:Table {urn: 'u2'}) "
                               "RETURN count(r)") == [[1]], "history's node and edge are back"
    assert await _rows(client, "MATCH (n:Table {urn: 'u3'}) RETURN count(n)") == [[1]], "kept"


async def test_a_rebuild_deletes_nothing_the_platform_did_not_write(graph):
    name, client = graph
    await client.query("CREATE (:Table {urn: 'u1', displayName: 'one'}), (:Table {urn: 'u2'}), "
                       "(:Thing {name: 'no identifier'})")
    await client.query("MATCH (a:Table {urn: 'u1'}), (b:Table {urn: 'u2'}) "
                       "CREATE (a)-[:FLOWS {id: 'e1'}]->(b), (a)-[:FLOWS {id: 'e7'}]->(b)")
    gid = await _enabled(client, name)
    await client.query("CREATE (:Table {urn: 'u9', displayName: 'loaded elsewhere'})")
    svc = GraphVersioningService()

    assert await svc.request_projection_rebuild(gid)
    await _project(client, gid)

    assert await _rows(client, "MATCH (n:Thing) RETURN n.name") == [["no identifier"]]
    assert await _rows(client, "MATCH (n:Table {urn: 'u9'}) RETURN n.displayName") == [
        ["loaded elsewhere"]]
    assert sorted(r[0] for r in await _rows(
        client, "MATCH (:Table {urn: 'u1'})-[r:FLOWS]->(:Table {urn: 'u2'}) RETURN r.id")) == [
        "e1", "e7"], "both relationships, each keeping its own id"
    assert await _rows(client, "MATCH (n:Table {urn: 'u1'}) RETURN n.displayName") == [["one"]]


async def test_editing_an_entity_removes_only_what_history_removed(graph):
    name, client = graph
    await client.query("CREATE (:Table {urn: 'u1', displayName: 'one', owner: 'ana', tier: 'gold'})")
    gid = await _enabled(client, name)
    await client.query("MATCH (n:Table {urn: 'u1'}) SET n.etlNote = 'from the pipeline'")

    await _publish(gid, {"op": "update", "entity_kind": "node", "entity_id": "u1",
                         "payload": {"properties": {"tier": PROP_DELETE}}})
    await _project(client, gid)

    assert await _rows(client, "MATCH (n:Table {urn: 'u1'}) RETURN n.owner, n.tier, n.etlNote") == [
        ["ana", None, "from the pipeline"]]
