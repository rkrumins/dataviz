"""Enable version control on a graph that doesn't line up with the platform's model — on a REAL FalkorDB.

Each case is a source the copy used to accept and then leave out of step with the live graph, so a
later edit landed beside an item instead of on it, or a delete never reached it:

* Types spelled differently from the semantic layer only by letter case (``table`` / ``Table``):
  refused before anything is copied, every mismatch listed, the graph untouched.
* A graph keyed by another property (``identityProperty`` ``id``): its identifiers (and its mapped
  display names) are filled in, marked with where they came from, and the graph is copied whole.
* A relationship whose own id is an item's urn: re-keyed in the copy, and in the graph to match.
* A graph already under version control through another data source: refused — two histories
  cannot both be its system of record.
* A source-provided ``entityId`` that is not the node's urn: corrected to the identity the copy uses.

Needs Postgres and FalkorDB, as ``test_bootstrap_falkor_live.py`` does.
"""
import os

import pytest

from backend.app.services.versioning import bootstrap_worker as bw
from backend.app.services.versioning import models
from backend.app.services.versioning.bootstrap_worker import (
    BootstrapConflict,
    BootstrapRunner,
    bootstrap_status,
    create_bootstrap_job,
)
from backend.app.services.versioning.ontology import EdgeRule, EntityRule, OntologyRules
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.service import GraphVersioningService
from backend.tests.integration.test_bootstrap_falkor_live import (  # noqa: F401 — fixtures
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


async def _job(client, name, **kw):
    await models.create_schema_and_partitions()
    ds = "ds_align_" + os.urandom(4).hex()
    res = await create_bootstrap_job(data_source_id=ds, workspace_id="ws_live", actor="alice",
                                     falkor_graph_name=name, falkor_provider=None, **kw)
    out = await BootstrapRunner(lambda _n, _p=None: client).run_job(await _take(res["job_id"]))
    return ds, res["graph_id"], out


@pytest.fixture
def declared(monkeypatch):
    """The data source's semantic layer: it declares ``Table`` and ``HAS``."""
    rules = OntologyRules(entity_types={"Table": EntityRule()},
                          edge_types={"HAS": EdgeRule(is_containment=True)},
                          containment_edge_types=frozenset({"HAS"}),
                          edge_type_canonical={"HAS": "HAS"})

    async def _rules(_job_id):
        return rules

    monkeypatch.setattr(bw, "_ontology_rules", _rules)
    return rules


async def test_a_spelling_that_differs_only_by_case_is_refused_and_listed(graph, declared):
    name, client = graph
    await client.query("CREATE (:table {urn: 'urn:t1'}), (:table {urn: 'urn:t2'}), "
                       "(:Table {urn: 'urn:t3'})")
    await client.query("MATCH (a {urn: 'urn:t1'}), (b {urn: 'urn:t2'}) CREATE (a)-[:has]->(b)")

    ds, _gid, out = await _job(client, name)

    assert out["status"] == "failed", out
    status = await bootstrap_status(data_source_id=ds)
    assert status["failure"]["action"] == "restart"
    assert status["spelling"] == [
        {"kind": "label", "graph": "table", "declared": "Table", "count": 2},
        {"kind": "relationship", "graph": "has", "declared": "HAS", "count": 1},
    ], status["spelling"]
    assert "`table`" in status["error"] and "`has`" in status["error"], status["error"]
    # Refused before anything was copied: the graph is exactly as it was.
    assert await _rows(client, "MATCH (n) WHERE n.entityId IS NOT NULL RETURN count(n)") == [[0]]
    assert await _rows(client, "MATCH ()-[r]->() WHERE r.id IS NOT NULL RETURN count(r)") == [[0]]


async def test_an_id_keyed_graph_gets_its_identifiers_and_is_copied_whole(graph):
    name, client = graph
    await client.query("CREATE (:Table {id: 'a', title: 'Alpha'}), (:Table {id: 7, title: 'Seven'}), "
                       "(:Table {urn: 'native', displayName: 'Native', id: 'z'})")
    await client.query("MATCH (a:Table {id: 'a'}), (b:Table {id: 7}) CREATE (a)-[:FLOWS]->(b)")

    ds, gid, out = await _job(client, name,
                              identity={"identityProperty": "id", "nameProperty": "title"})

    assert out["status"] == "completed", out
    status = await bootstrap_status(data_source_id=ds)
    assert status["report"]["stored"] == {"nodes": 3, "edges": 1}, status["report"]
    assert status["identityStamp"] == {"identityProperty": "id", "nameProperty": "title",
                                       "identifiers": 2, "names": 2}, status["identityStamp"]
    rows = sorted(await _rows(client, "MATCH (n:Table) RETURN n.urn, n.urnSource, n.displayName, "
                                      "n.nameSource, n.entityId"))
    assert rows == [["7", "id", "Seven", "title", "7"], ["a", "id", "Alpha", "title", "a"],
                    ["native", None, "Native", None, "native"]], "a native urn is never replaced"

    # The next edit lands on that node, not beside it.
    await GraphVersioningService().apply_ops(graph_id=gid, actor="bob", message="rename", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "7", "payload": {"displayName": "7!"}}])
    res = await FalkorProjector(lambda _n, _p=None: client).project_graph(gid)
    assert res.get("verify_error") is None, res
    assert await _rows(client, "MATCH (n:Table {urn: '7'}) RETURN count(n), n.displayName") == [
        [1, "7!"]]


async def test_a_relationship_whose_id_is_an_items_is_rekeyed_in_the_graph_too(graph):
    name, client = graph
    await client.query("CREATE (:Table {urn: 'n1'}), (:Table {urn: 'n2'}), (:Table {urn: 'n3'})")
    await client.query("MATCH (a {urn: 'n1'}), (b {urn: 'n2'}) CREATE (a)-[:FLOWS {id: 'n3'}]->(b)")

    _ds, gid, out = await _job(client, name)

    assert out["status"] == "completed", out
    assert await _rows(client, "MATCH ()-[r:FLOWS]->() RETURN r.id") == [["edge:n3"]]
    await GraphVersioningService().apply_ops(graph_id=gid, actor="bob", message="drop", ops=[
        {"op": "delete", "entity_kind": "edge", "entity_id": "edge:n3", "payload": None}])
    res = await FalkorProjector(lambda _n, _p=None: client).project_graph(gid)
    assert res.get("verify_error") is None, res
    assert await _rows(client, "MATCH ()-[r:FLOWS]->() RETURN count(r)") == [[0]]


async def test_a_graph_already_under_version_control_elsewhere_is_refused(graph):
    name, client = graph
    await client.query("CREATE (:Table {urn: 'u1'})")
    _ds, _gid, out = await _job(client, name)
    assert out["status"] == "completed", out

    with pytest.raises(BootstrapConflict) as refused:
        await create_bootstrap_job(data_source_id="ds_other_" + os.urandom(3).hex(),
                                   workspace_id="ws_other", actor="bob",
                                   falkor_graph_name=name, falkor_provider=None)
    assert refused.value.detail["type"] == "graph_already_versioned"


async def test_a_source_entity_id_that_is_not_its_urn_is_corrected(graph):
    name, client = graph
    await client.query("CREATE (:Table {urn: 'u1', entityId: 'from an old export'})")

    _ds, _gid, out = await _job(client, name)

    assert out["status"] == "completed", out
    assert await _rows(client, "MATCH (n:Table) RETURN n.entityId") == [["u1"]]
