"""The published graph as it was at a past revision — needs Postgres.

ContextEngine reads ``main`` as it was at revision K (``as_of_seq``) as main's store at its head
with the patch set of everything main changed since K put back over it. Over a history of seeded
random edits (tables and columns made, renamed, given properties, deleted; flows drawn, weighed,
re-pointed, deleted; columns moved between tables), every revision read through the engine is what
Postgres composes for main at that revision (``materialize_state``), entity by entity and field by
field: its nodes and child counts, its edges, each table's children and the top level, a page at a
time and each once. At the head a revision is main itself.

A revision opened again after the head moved extends its patch set by what changed since, and reads
the same as one built afresh. Opening one reads what changed since, never the graph: no whole-state
read, and the same statements on a graph with 30 times the untouched entities. A revision more
than ``GRAPHVER_REVISION_REWIND_MAX`` changes back is refused, and an unknown one is not found.
"""
import asyncio
import os
import random

import pytest
from sqlalchemy import event, select

from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.errors import RevisionTooFar
from backend.app.services.versioning.service import GraphVersioningService
from backend.common.models.graph import EdgeQuery, NodeQuery
from backend.tests.integration.test_fork_overlay_property import _Writer, _props, _urns
from backend.tests.integration.test_versioning_bounded_reads import _whole_graph_reads_refused

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

CONT = ["CONTAINS"]
EDGE_TYPES = ["CONTAINS", "FLOWS"]


class _Registry:
    """The live provider, which no read here reaches: the projection never ran, so main's store
    is its Postgres reader."""

    async def get_provider_for_workspace(self, workspace_id, session, data_source_id):
        return object()


@pytest.fixture()
def engine_parts(monkeypatch):
    """The engine without the management database: no ontology to resolve (the containment types
    are set on the reader), no data source row."""
    from backend.app.db.repositories import data_source_repo
    from backend.app.services.context_engine import ContextEngine

    async def no_ontology(self):
        return None

    async def no_row(session, ds_id):
        return None
    monkeypatch.setattr(ContextEngine, "_resolve_ontology", no_ontology)
    monkeypatch.setattr(data_source_repo, "get_data_source_orm", no_row)


async def _engine(ds, as_of_seq, branch_id=None):
    from backend.app.services.context_engine import ContextEngine

    async with db.graphver_session() as session:
        engine = await ContextEngine.for_workspace("ws1", _Registry(), session, data_source_id=ds,
                                                  branch_id=branch_id, as_of_seq=as_of_seq)
    engine.provider.set_containment_edge_types(CONT)
    return engine


async def _seqs(gid, main):
    async with db.graphver_session() as s:
        return list((await s.execute(select(models.CommitORM.commit_seq).where(
            models.CommitORM.graph_id == gid, models.CommitORM.branch_id == main)
            .order_by(models.CommitORM.commit_seq))).scalars())


async def _pages(fetch):
    """Every item of a listing, following its positions until it says it is done."""
    seen, position = [], None
    for _ in range(500):
        items, position, more = await fetch(position)
        seen += items
        if not more:
            return seen
    raise AssertionError("the listing never ended")


async def _check(svc, provider, gid, main, seq, urns, label):
    state = await svc.materialize_state(graph_id=gid, branch_id=main, as_of_seq=seq)
    nodes = {p["urn"]: p for p in state["nodes"].values()}
    edges = state["edges"]
    children = {}
    for p in edges.values():
        if p["edgeType"] == "CONTAINS":
            children.setdefault(p["sourceEntityId"], set()).add(p["targetEntityId"])

    got = {n.urn: n for n in await provider.get_nodes(NodeQuery(urns=sorted(urns), limit=len(urns)))}
    assert sorted(got) == sorted(nodes), label
    for urn, n in got.items():
        want = nodes[urn]
        assert (n.entity_type, n.display_name, _props(n.properties), n.child_count or 0) == (
            want["entityType"], want["displayName"], _props(want.get("properties")),
            len(children.get(urn, ()))), (label, urn)
    got_edges = {e.id: e for e in await provider.get_edges(EdgeQuery(edge_types=EDGE_TYPES,
                                                                     limit=10_000))}
    assert sorted(got_edges) == sorted(edges), label
    for eid, e in got_edges.items():
        want = edges[eid]
        assert (e.source_urn, e.target_urn, e.edge_type, _props(e.properties)) == (
            want["sourceEntityId"], want["targetEntityId"], want["edgeType"],
            _props(want.get("properties"))), (label, eid)

    # Each table's children, three at a time, each once.
    for urn, p in nodes.items():
        if p["entityType"] != "Table":
            continue

        async def page(offset, urn=urn):
            r = await provider.get_children_with_edges(urn, edge_types=CONT, offset=offset or 0,
                                                       limit=3)
            return [c.urn for c in r.children], r.next_offset, r.has_more
        listed = await _pages(page)
        assert sorted(listed) == sorted(children.get(urn, ())), (label, urn)
    # The top level — what nothing contains — four at a time, each once.
    contained = {t for kids in children.values() for t in kids}

    async def top(cursor):
        r = await provider.get_top_level_or_orphan_nodes(limit=4, cursor=cursor)
        return [n.urn for n in r.nodes], r.next_cursor, r.has_more
    listed = await _pages(top)
    assert sorted(listed) == sorted(u for u in nodes if u not in contained), label


async def _run_history(seed: int) -> None:
    from backend.app.providers.draft_overlay_provider import DraftOverlayProvider

    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds = "ds_" + os.urandom(4).hex()
    G = await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="alice")
    gid, main = G["graph_id"], G["main_branch_id"]
    writer = _Writer(svc, gid, main, "r", random.Random(seed))
    for _ in range(24):
        await writer.step()
    seqs = await _seqs(gid, main)
    head = seqs[-1]
    urns = await _urns(svc, writer)

    for seq in seqs[:-1]:
        engine = await _engine(ds, seq)
        p = engine.provider
        assert isinstance(p, DraftOverlayProvider) and p._as_of == seq, seq
        assert engine._branch_id == f"{main}@{seq}" and not engine._writes_main
        await _check(svc, p, gid, main, seq, urns, f"seed {seed} revision {seq} of {head}")
    # At the head, a revision is main itself.
    engine = await _engine(ds, head)
    assert not isinstance(engine.provider, DraftOverlayProvider) and engine._branch_id == main
    with pytest.raises(KeyError):
        await _engine(ds, head + 5)


@pytest.mark.parametrize("seed", [11, 2026])
def test_every_past_revision_reads_as_its_history_says(seed, engine_parts):
    asyncio.run(_run_history(seed))


async def _run_head_moves(monkeypatch) -> None:
    from backend.app.providers import draft_overlay_provider as dop
    from backend.app.services.versioning import service as service_module

    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds = "ds_" + os.urandom(4).hex()
    G = await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="alice")
    gid, main = G["graph_id"], G["main_branch_id"]
    writer = _Writer(svc, gid, main, "h", random.Random(5))
    for _ in range(10):
        await writer.step()
    seq = (await _seqs(gid, main))[4]
    await _check(svc, (await _engine(ds, seq)).provider, gid, main, seq,
                 await _urns(svc, writer), "before the head moved")

    extended = []
    real = service_module._extended_patch

    def spy(prev, window, ids):
        extended.append(len(ids))
        return real(prev, window, ids)
    monkeypatch.setattr(service_module, "_extended_patch", spy)
    for _ in range(6):
        await writer.step()
    urns = await _urns(svc, writer)
    await _check(svc, (await _engine(ds, seq)).provider, gid, main, seq, urns, "extended")
    assert len(extended) == 1                    # built on the patch set it had, not again

    monkeypatch.setattr(dop, "_DELTAS", dop._DeltaCache())
    await _check(svc, (await _engine(ds, seq)).provider, gid, main, seq, urns, "afresh")
    assert len(extended) == 1

    # Too far back: refused with what it would take, not drawn.
    monkeypatch.setattr(config, "REVISION_REWIND_MAX", 2)
    with pytest.raises(RevisionTooFar) as exc:
        await _engine(ds, seq)
    detail = exc.value.detail
    assert detail["type"] == "revision_too_far" and detail["asOfSeq"] == seq
    assert detail["changed"] > detail["limit"] == 2


def test_a_revision_follows_the_head_and_stops_where_it_is_too_far(engine_parts, monkeypatch):
    asyncio.run(_run_head_moves(monkeypatch))


def _node(eid, name=None):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "displayName": name or eid, "entityType": "Table"}}


async def _opened(untouched: int):
    """The statements opening a revision and reading what changed since take, on a graph with
    ``untouched`` entities nothing changed since."""
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds = "ds_" + os.urandom(4).hex()
    G = await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="alice")
    gid, main = G["graph_id"], G["main_branch_id"]
    await svc.apply_ops(graph_id=gid, actor="alice", message="baseline",
                        ops=[_node(f"U{i}") for i in range(untouched)] + [_node("A"), _node("B")])
    seq = (await _seqs(gid, main))[-1]
    await svc.apply_ops(graph_id=gid, actor="alice", message="since", ops=[
        {**_node("A", "A renamed"), "op": "update"}, _node("N"),
        {"op": "delete", "entity_kind": "node", "entity_id": "B", "payload": None}])

    statements = []

    def count(*_a, **_k):
        statements.append(1)
    engine = db.get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        with _whole_graph_reads_refused():
            reader = (await _engine(ds, seq)).provider
            got = {u: await reader.get_node(u) for u in ("A", "B", "N", "U0")}
            listed = await reader.get_nodes(NodeQuery(urns=["A", "B", "N"], limit=3))
    finally:
        event.remove(engine, "before_cursor_execute", count)
    assert got["A"].display_name == "A" and got["B"].display_name == "B"
    assert got["N"] is None and got["U0"].display_name == "U0"
    assert sorted(n.urn for n in listed) == ["A", "B"]
    return len(statements)


def test_opening_a_revision_reads_what_changed_since_never_the_graph(engine_parts):
    async def run():
        return await _opened(50), await _opened(1500)

    small, large = asyncio.run(run())
    assert small == large, (small, large)
