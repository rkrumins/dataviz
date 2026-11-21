"""A draft's counts, rule membership and catalog over a real draft — needs Postgres.

The correction a draft's deep-search answers make (``providers.draft_search``) reads the draft's
patch set and its values from the versioning service, and folds a later commit in from what that
commit wrote (``draft_search_window``) and what the draft held before it (``draft_nodes_as_of``).
Here those reads run against Postgres; main's store is the stub provider over main's own state, and
every answer must equal the stub's over the draft's state. A commit that writes a relationship
moving nothing (not containment) is folded in all the same; a draft too large to read whole answers
with main's counts and catalog, said so.
"""
import os

import pytest

from backend.app.providers import draft_search
from backend.app.providers.draft_overlay_provider import DraftOverlayProvider
from backend.app.services.deep_search import SearchRunContext
from backend.app.services.versioning import config as vconfig
from backend.common.models.search import SearchOptions, SearchQuery, SearchScope
from backend.graph.adapters.stub_deep_search import StubDeepSearchProvider
from backend.tests.integration.test_fork_overlay_delta import _d, _run
from backend.tests.test_draft_search import RULES, Main, catalog_of

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

CONT = ["CONTAINS"]
SCOPE = SearchScope(viewId="v", scopeMode="view", rootUrns=["db"], maxDepth=12)
CONTEXT = SearchRunContext(data_version="1.draft", scope_hash="scope-e2e")


def _node(urn, etype, op="create", **props):
    tags = props.pop("tags", None)
    payload = {"urn": urn, "entityType": etype, "displayName": urn, "properties": props}
    if tags:
        payload["tags"] = tags
    return {"op": op, "entity_kind": "node", "entity_id": urn, "payload": payload}


def _contains(src, tgt):
    return {"op": "create", "entity_kind": "edge", "entity_id": f"e:{src}>{tgt}",
            "payload": {"edgeType": "CONTAINS", "sourceEntityId": src, "targetEntityId": tgt}}


async def _seeded(svc):
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                  workspace_id="ws1", actor="alice"))["graph_id"]
    main = await svc.main_branch_id(gid)
    await svc.apply_ops(graph_id=gid, actor="alice", message="seed", containment_edge_types=CONT,
                        ops=[_node("db", "Database"), _node("t1", "Table", owner="ann"),
                             _node("t2", "Table", owner="bob"),
                             _node("c1", "Column", tier="gold", rows=10, tags=["pii"]),
                             _node("c2", "Column", tier="silver", rows=20),
                             _node("c3", "Column", tier="gold", rows=5),
                             _contains("db", "t1"), _contains("db", "t2"), _contains("t1", "c1"),
                             _contains("t1", "c2"), _contains("t2", "c3")])
    draft = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", message="edit",
                        containment_edge_types=CONT,
                        ops=[_node("c2", "Column", op="update", tier="gold", rows=50),
                             _d("e:t2>c3", kind="edge"), _d("c3"),
                             _node("c4", "Column", tier="gold", rows=7), _contains("t2", "c4")])
    return gid, main, draft


async def _stub(svc, gid, branch, cls=StubDeepSearchProvider):
    """The stub provider over a branch's state, as main's store would hold it."""
    state = await svc.materialize_state(graph_id=gid, branch_id=branch)
    urn = {eid: p["urn"] for eid, p in state["nodes"].items()}
    nodes = [{"urn": p["urn"], "entityType": p["entityType"], "displayName": p["displayName"],
              **(p.get("properties") or {}), **({"tags": p["tags"]} if p.get("tags") else {})}
             for p in state["nodes"].values()]
    edges = [{"id": eid, "source": urn[p["sourceEntityId"]], "target": urn[p["targetEntityId"]],
              "type": p["edgeType"]} for eid, p in state["edges"].items()]
    return cls(nodes=nodes, edges=edges)


async def _overlay(svc, gid, main, draft):
    p = DraftOverlayProvider(await _stub(svc, gid, main, Main), svc=svc, graph_id=gid,
                             branch_id=draft)
    p.set_containment_edge_types(CONT)
    return p


async def _counts(overlay, items):
    out = {}
    for rid, p in items:
        query = SearchQuery(predicate=p, scope=SCOPE, options=SearchOptions(results="hits"))
        out[rid] = (await overlay.deep_search_count(query, context=CONTEXT))["count"]
    deltas = await overlay.deep_search_count_deltas(SCOPE, items, context=CONTEXT, wait_ms=5000)
    assert deltas["status"] == "complete" and deltas["approximate"] == {}
    return {rid: n + deltas["deltas"].get(rid, 0) for rid, n in out.items()}


async def _truth(svc, gid, draft, items):
    truth = await _stub(svc, gid, draft)
    return {rid: (await truth.deep_search_count(SearchQuery(predicate=p, scope=SCOPE)))["count"]
            for rid, p in items}


def test_a_fold_reads_what_the_commits_wrote_and_the_draft_as_it_was():
    async def case(svc):
        gid, main, draft = await _seeded(svc)
        first = (await svc.overlay_version(graph_id=gid, branch_id=draft))[0]
        seq = (await svc.draft_search_window(graph_id=gid, branch_id=draft,
                                             commit_id=first))["seq"]
        await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", message="again",
                            containment_edge_types=CONT,
                            ops=[_node("c1", "Column", op="update", tier="bronze", rows=10)])
        head = (await svc.overlay_version(graph_id=gid, branch_id=draft))[0]
        window = await svc.draft_search_window(graph_id=gid, branch_id=draft, commit_id=head,
                                               since_seq=seq, limit=10)
        assert window == {"seq": seq + 1, "nodes": ["c1"], "edges": False}
        assert (await svc.draft_search_window(graph_id=gid, branch_id=draft, commit_id=head,
                                              since_seq=seq, limit=0))["nodes"] is None
        everything = await svc.draft_search_window(graph_id=gid, branch_id=draft,
                                                   commit_id=first, since_seq=0, limit=10)
        assert everything["edges"] is True and everything["nodes"] == ["c2", "c3", "c4"]

        before = await svc.draft_nodes_as_of(graph_id=gid, branch_id=draft,
                                             entity_ids=["c1", "c2", "c3", "c4", "t1"], seq=seq)
        assert set(before) == {"c2", "c3", "c4"}
        assert before["c2"]["node"]["properties"] == {"tier": "gold", "rows": 50}
        assert before["c3"] == {"urn": "c3", "node": None}
        assert before["c4"]["urn"] == "c4"
        # Main moves on after the draft branched: the draft still reads t1 as it was.
        await svc.apply_ops(graph_id=gid, actor="bob", message="main moves",
                            containment_edge_types=CONT,
                            ops=[_node("t1", "Table", op="update", owner="cy")])
        moved = await svc.draft_nodes_as_of(graph_id=gid, branch_id=draft, entity_ids=["t1"],
                                            seq=seq)
        assert moved["t1"]["node"]["properties"] == {"owner": "ann"}
    _run(case)


def test_counts_membership_and_the_catalog_are_the_drafts_commit_after_commit():
    async def case(svc):
        gid, main, draft = await _seeded(svc)
        items = list(RULES.items())
        assert await _counts(await _overlay(svc, gid, main, draft), items) == \
            await _truth(svc, gid, draft, items)

        await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", message="again",
                            containment_edge_types=CONT,
                            ops=[_node("c1", "Column", op="update", tier="bronze", rows=10),
                                 _node("c2", "Column", op="update", tier="silver", rows=3)])
        folded = []
        as_of = svc.draft_nodes_as_of

        async def spy(**kw):
            folded.append(sorted(kw["entity_ids"]))
            return await as_of(**kw)

        svc.draft_nodes_as_of = spy
        overlay = await _overlay(svc, gid, main, draft)
        assert await _counts(overlay, items) == await _truth(svc, gid, draft, items)
        assert folded == [["c1", "c2"]], "the second commit is folded in, not D read again"

        urns = ["c1", "c2", "c3", "c4", "t2"]
        got = await overlay.deep_search_membership(SCOPE, items, urns, context=CONTEXT)
        want = await (await _stub(svc, gid, draft)).deep_search_membership(SCOPE, items, urns)
        assert {k: sorted(v) for k, v in got["matches"].items()} == \
            {k: sorted(v) for k, v in want["matches"].items()}

        catalog = await overlay.deep_search_catalog(SCOPE, context=CONTEXT, wait_ms=5000)
        truth = await catalog_of(await _stub(svc, gid, draft), SCOPE, CONTEXT)
        assert catalog["status"] == "complete" and catalog["entities"] == truth["entities"]
        assert {p["key"]: (p["count"], p["values"]) for p in catalog["properties"]} == \
            {p["key"]: (p["count"], p["values"]) for p in truth["properties"]}
    _run(case)


def test_a_commit_writing_a_relationship_that_moves_nothing_is_folded_in():
    async def case(svc):
        gid, main, draft = await _seeded(svc)
        await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", message="lineage",
                            containment_edge_types=CONT, ops=[{
                                "op": "create", "entity_kind": "edge", "entity_id": "e:c1>c2",
                                "payload": {"edgeType": "FLOWS_TO", "sourceEntityId": "c1",
                                            "targetEntityId": "c2", "properties": {"weight": 1}}}])
        items = list(RULES.items())
        assert await _counts(await _overlay(svc, gid, main, draft), items) == \
            await _truth(svc, gid, draft, items)
        before = (await svc.overlay_version(graph_id=gid, branch_id=draft))[0]
        seq = (await svc.draft_search_window(graph_id=gid, branch_id=draft, commit_id=before))["seq"]
        weight = {"op": "update", "entity_kind": "edge", "entity_id": "e:c1>c2",
                  "payload": {"properties": {"weight": 2}}}
        await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", message="weight",
                            containment_edge_types=CONT, ops=[weight])
        head = (await svc.overlay_version(graph_id=gid, branch_id=draft))[0]
        moved = await svc.draft_search_window(graph_id=gid, branch_id=draft, commit_id=head,
                                              since_seq=seq, limit=10, containment_types=CONT)
        assert moved == {"seq": seq + 1, "nodes": [], "edges": False}
        assert (await svc.draft_search_window(graph_id=gid, branch_id=draft, commit_id=head,
                                              since_seq=seq, limit=10))["edges"] is True

        await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", message="weight and tier",
                            containment_edge_types=CONT,
                            ops=[{**weight, "payload": {"properties": {"weight": 3}}},
                                 _node("c1", "Column", op="update", tier="bronze", rows=10)])
        folded = []
        as_of = svc.draft_nodes_as_of

        async def spy(**kw):
            folded.append(sorted(kw["entity_ids"]))
            return await as_of(**kw)

        svc.draft_nodes_as_of = spy
        assert await _counts(await _overlay(svc, gid, main, draft), items) == \
            await _truth(svc, gid, draft, items)
        assert folded == [["c1"]], "folded in, the relationship moving nothing"
    _run(case)


def test_a_draft_too_large_to_read_whole_answers_with_mains_counts_said_so(monkeypatch):
    monkeypatch.setattr(vconfig, "DRAFT_SEARCH_MAX_DELTA", 2)

    async def case(svc):
        gid, main, draft = await _seeded(svc)               # it changed three entities
        overlay = await _overlay(svc, gid, main, draft)
        items = list(RULES.items())
        note = draft_search.TOO_LARGE.format(n=2)
        deltas = await overlay.deep_search_count_deltas(SCOPE, items, context=CONTEXT, wait_ms=5000)
        assert deltas["deltas"] == {} and deltas["approximate"] == {rid: note for rid, _ in items}
        catalog = await overlay.deep_search_catalog(SCOPE, context=CONTEXT, wait_ms=5000)
        mains = await catalog_of(await _stub(svc, gid, main), SCOPE, CONTEXT)
        assert catalog["notes"][-1] == note
        assert {p["key"]: (p["count"], p["values"]) for p in catalog["properties"]} == \
            {p["key"]: (p["count"], p["values"]) for p in mains["properties"]}
    _run(case)
