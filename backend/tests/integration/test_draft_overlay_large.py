"""A 20k+20k draft's overlay is built without a payload and reads exactly like the draft (live Postgres).

``branch_overlay_delta`` used to load the payload of every node and edge the draft created or
changed — the first read of a large draft did that in the web process. Now it reads version-row
columns only (skeletons), and a read loads the values of what it serves. Proven on a draft that
creates 20,000 nodes under twenty parents (and their 20,000 containment edges), changes main nodes,
deletes main lineage and adds its own:

* building the patch set issues no statement that reads a version payload;
* the overlay over main's reader serves, node for node and edge for edge, what the draft's own
  Postgres reader (the full payload path) serves — single nodes, every page of a parent's
  children, a node's edges, search;
* a read loads the payloads of exactly what it serves: one node for one node, a parent's new
  children for the page they are served on, nothing for a later page.
"""
import asyncio
import os
import re

import pytest
from sqlalchemy import event

from backend.app.providers import draft_overlay_provider
from backend.app.providers.draft_overlay_provider import DraftOverlayProvider
from backend.app.providers.versioned_branch_provider import VersionedBranchProvider
from backend.common.models.graph import EdgeQuery
from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService

CONT = ["CONTAINS"]
PARENTS = 20
PER_PARENT = 1000                       # 20k created nodes, 20k containment edges
WINDOW = 10_000


def _node(eid, typ, name, **props):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": typ, "displayName": name, "qualifiedName": f"q.{eid}",
                        "properties": props}}


def _edge(eid, src, tgt, typ):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": typ, "sourceEntityId": src, "targetEntityId": tgt,
                        "confidence": 0.5, "properties": {"via": eid}}}


class _Counting:
    """The service, counting what overlay reads load."""

    def __init__(self, svc):
        self._svc, self.loads = svc, []

    def __getattr__(self, name):
        return getattr(self._svc, name)

    async def overlay_payloads(self, *, kind="node", **kw):
        self.loads.append((kind, sorted(kw["entity_ids"])))
        return await self._svc.overlay_payloads(kind=kind, **kw)


def _node_view(n):
    props = {k: v for k, v in (n.properties or {}).items() if k != "childCount"}
    return (n.urn, n.entity_type, n.display_name, n.qualified_name, tuple(sorted(props.items())), n.version)


def _edge_view(e):
    return (e.id, e.source_urn, e.target_urn, e.edge_type, e.confidence,
            tuple(sorted((e.properties or {}).items())), e.version)


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="alice"))["graph_id"]
    seed = []
    for p in range(PARENTS):
        seed += [_node(f"P{p}", "Schema", f"parent {p}")]
        for c in range(5):
            seed += [_node(f"P{p}.m{c}", "Table", f"main {p}.{c}", rank=c),
                     _edge(f"cm{p}.{c}", f"P{p}", f"P{p}.m{c}", "CONTAINS")]
    seed += [_edge(f"ml{p}", f"P{p}.m0", f"P{p}.m1", "LINEAGE") for p in range(PARENTS)]
    await svc.apply_ops(graph_id=gid, actor="alice", message="seed", ops=seed, containment_edge_types=CONT)
    main = await svc.main_branch_id(gid)

    draft = await svc.open_draft(graph_id=gid, owner="alice")
    created = [f"P{i % PARENTS}.n{i}" for i in range(PARENTS * PER_PARENT)]
    nodes = [_node(u, "Table", f"new {i}", i=i) for i, u in enumerate(created)]
    edges = [_edge(f"cn{i}", f"P{i % PARENTS}", u, "CONTAINS") for i, u in enumerate(created)]
    edges += [_edge(f"nl{i}", created[i], created[i + PARENTS], "LINEAGE") for i in range(100)]
    for batch in (nodes, edges):
        for start in range(0, len(batch), WINDOW):
            await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", containment_edge_types=CONT,
                                ops=batch[start:start + WINDOW])
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", containment_edge_types=CONT, ops=[
        *({"op": "update", "entity_kind": "node", "entity_id": f"P{p}.m2",
           "payload": {"displayName": f"main {p}.2 edited", "properties": {"edited": True}}}
          for p in range(PARENTS)),
        *({"op": "delete", "entity_kind": "edge", "entity_id": f"ml{p}", "payload": None}
          for p in range(0, PARENTS, 2))])

    # ── the patch set reads no payload ──
    statements = []

    def record(conn, cursor, statement, params, context, executemany):
        statements.append(statement)

    engine = db.get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", record)
    try:
        delta = await svc.branch_overlay_delta(graph_id=gid, branch_id=draft)
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert statements, "the build was observed"
    payload_reads = [s for s in statements if re.search(r"\bpayload\b", s, re.IGNORECASE)]
    assert not payload_reads, payload_reads[:3]
    assert len(delta["nodesUpsert"]) == len(created) and len(delta["nodesModified"]) == PARENTS
    assert len(delta["edgesUpsert"]) == len(edges) and len(delta["edgesRemove"]) == PARENTS // 2
    assert all(d.get("lazy") for d in delta["nodesUpsert"] + delta["edgesUpsert"])

    # ── the overlay reads like the draft itself ──
    counting = _Counting(svc)
    base = VersionedBranchProvider(svc, graph_id=gid, branch_id=main)
    overlay = DraftOverlayProvider(base, svc=counting, graph_id=gid, branch_id=draft)
    reference = VersionedBranchProvider(svc, graph_id=gid, branch_id=draft)
    for p in (overlay, reference):
        p.set_containment_edge_types(CONT)

    for urn in (created[7], created[-1], "P3.m2", "P3.m4", "P3"):
        counting.loads.clear()
        got, want = await overlay.get_node(urn), await reference.get_node(urn)
        assert _node_view(got) == _node_view(want), (urn, got, want)
        assert counting.loads in ([], [("node", [urn])]), counting.loads   # at most itself
    assert counting.loads == [], "an untouched main node loads nothing"

    parent = "P3"
    want = await reference.get_children_with_edges(parent, edge_types=CONT, limit=5000)
    pages, offset, cursor = [], 0, None
    for page_no in range(100):
        counting.loads.clear()
        page = await overlay.get_children_with_edges(parent, edge_types=CONT, limit=2, offset=offset,
                                                     cursor=cursor)
        pages.append(page)
        loaded = {e for _k, ids in counting.loads if _k == "node" for e in ids}
        served = {c.urn for c in page.children}
        assert loaded <= served, (page_no, sorted(loaded - served)[:5])
        if page_no == 0:
            assert {u for u in served if ".n" in u} <= loaded, "the new children it serves were loaded"
        else:
            assert not {u for u in loaded if ".n" in u}, "a later page loads no new child"
        if not page.has_more:
            break
        offset, cursor = page.next_offset, page.next_cursor
    got = {_node_view(c) for page in pages for c in page.children}
    assert got == {_node_view(c) for c in want.children}, (len(got), len(want.children))
    assert pages[0].total_children == want.total_children == 5 + PER_PARENT
    assert {_edge_view(e) for page in pages for e in page.containment_edges} == \
        {_edge_view(e) for e in want.containment_edges}

    for urns in ([created[0]], [created[PARENTS]], ["P0.m0", "P1.m0"], ["P3.m2"]):
        counting.loads.clear()
        q = EdgeQuery(anyUrns=urns, limit=5000)
        got, want = await overlay.get_edges(q), await reference.get_edges(q)
        assert {_edge_view(e) for e in got} == {_edge_view(e) for e in want}, (urns, got, want)
        assert {e for k, ids in counting.loads if k == "edge" for e in ids} <= {e.id for e in got}

    counting.loads.clear()
    last = len(created) - 1                          # "new 19999": no other name contains it
    fresh = DraftOverlayProvider(base, svc=counting, graph_id=gid, branch_id=draft)   # a new request
    fresh.set_containment_edge_types(CONT)
    hits = await fresh.search_nodes(f"new {last}")
    assert [n.urn for n in hits] == [created[last]] and hits[0].properties == {"i": last}
    assert counting.loads == [("node", [created[last]])]
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_large_drafts_overlay_reads_no_payload_to_build_and_reads_like_the_draft():
    draft_overlay_provider._DELTAS = draft_overlay_provider._DeltaCache()
    asyncio.run(_run())
