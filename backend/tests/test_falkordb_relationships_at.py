"""FalkorDB ``relationships_at``: every relationship at a set of entities, both ways, each once.

What a draft's relationship counts read of main's store at the entities the draft changed
(``draft_search``). Pins: each urn seeked by its label's URN index, out and in — an urn whose
label is unknown (not in the graph) is never an unlabeled scan; the types as a pattern, or every
type but a roll-up and those left out; one relationship read from both its ends once; and the
limit, which says whether that was all of them.
"""
import asyncio

import pytest

from backend.app.providers.falkordb_provider import FalkorDBProvider
from backend.app.providers.versioned_branch_provider import VersionedBranchProvider


class _Result:
    def __init__(self, result_set=None):
        self.result_set = result_set or []


LABELS = {"urn:t1": "Table", "urn:t2": "Table", "urn:d1": "Dashboard"}


def _provider(rows_for=lambda cypher, params: []):
    p = FalkorDBProvider(host="x", graph_name="g")
    p._redis = None
    calls = []

    async def _connected():
        return None

    async def _buckets(urns):
        by = {}
        for u in dict.fromkeys(u for u in urns if u):
            by.setdefault(LABELS.get(u) or "", []).append(u)
        return sorted(by.items())

    async def _ro_query(cypher, params=None, timeout=None, op=None, **kw):
        calls.append((cypher, params or {}))
        return _Result(rows_for(cypher, params or {}))

    p._ensure_connected = _connected
    p._label_buckets = _buckets
    p._ro_query = _ro_query
    p._alias_rel_types = lambda types: list(types)
    return p, calls


def _run(coro):
    return asyncio.run(coro)


def test_each_label_is_seeked_by_its_urn_index_both_ways_and_an_unknown_urn_has_none():
    p, calls = _provider()
    _run(p.relationships_at(["urn:t1", "urn:d1", "urn:t2", "urn:gone"], edge_types=["FLOWS_TO"],
                            limit=10))
    shapes = sorted(cypher.split(" AND ID(r)")[0] for cypher, _ in calls)
    assert shapes == [
        "MATCH (a)-[r:FLOWS_TO]->(b:Dashboard) WHERE b.urn IN $_urns",
        "MATCH (a)-[r:FLOWS_TO]->(b:Table) WHERE b.urn IN $_urns",
        "MATCH (a:Dashboard)-[r:FLOWS_TO]->(b) WHERE a.urn IN $_urns",
        "MATCH (a:Table)-[r:FLOWS_TO]->(b) WHERE a.urn IN $_urns",
    ]
    assert sorted(tuple(params["_urns"]) for _, params in calls) == \
        [("urn:d1",), ("urn:d1",), ("urn:t1", "urn:t2"), ("urn:t1", "urn:t2")]
    assert all(params["_page"] == 10 and params["_after"] == -1 for _, params in calls)
    assert not _run(p.relationships_at(["urn:gone"], limit=10)), "no unlabeled scan"
    assert len(calls) == 4


def test_every_type_is_every_type_but_a_rollup_and_those_left_out():
    p, calls = _provider()
    _run(p.relationships_at(["urn:t1"], except_types=["contains"], limit=5))
    cypher, params = calls[0]
    assert "-[r]->" in cypher and "AND NOT toUpper(type(r)) IN $_skip" in cypher
    assert params["_skip"] == ["AGGREGATED", "CONTAINS"]
    calls.clear()
    # Named types never take a roll-up; none left: nothing to read.
    assert _run(p.relationships_at(["urn:t1"], edge_types=["AGGREGATED"], limit=5)) == []
    assert _run(p.relationships_at(["urn:t1"], edge_types=[], limit=5)) == []
    assert calls == []


def test_one_read_from_both_its_ends_is_once_and_the_limit_holds():
    def rows(cypher, params):
        # t1 → t2 is read out of t1 and into t2; t1 → t1 out of and into t1.
        return [[1, "urn:t1", "urn:t2", "FLOWS_TO", {"id": "e1", "confidence": 0.5}],
                [2, "urn:t1", "urn:t1", "FLOWS_TO", {"id": "e2", "properties": '{"mode": "batch"}'}]]

    p, _calls = _provider(rows)
    edges = _run(p.relationships_at(["urn:t1", "urn:t2"], edge_types=["FLOWS_TO"], limit=10))
    assert sorted(e.id for e in edges) == ["e1", "e2"]
    by_id = {e.id: e for e in edges}
    assert by_id["e1"].confidence == 0.5 and by_id["e2"].properties == {"mode": "batch"}
    assert (by_id["e1"].source_urn, by_id["e1"].target_urn) == ("urn:t1", "urn:t2")
    assert len(_run(p.relationships_at(["urn:t1"], edge_types=["FLOWS_TO"], limit=1))) == 1


def test_a_hub_past_one_reply_is_read_a_page_at_a_time(monkeypatch):
    """FalkorDB cuts a reply at its ``RESULTSET_SIZE`` rows without saying so: a hub's
    relationships are read in relationship-ID order a page at a time, every one of them, and a
    short page — never a cut reply — is what says that was all."""
    from backend.app.providers import falkordb_provider as fp
    monkeypatch.setattr(fp, "_EDGES_AT_PAGE", 3)
    hub = [[i, "urn:t1", f"urn:x{i}", "FLOWS_TO", {"id": f"e{i}"}] for i in range(10)]

    def rows(cypher, params):
        if "a.urn IN $_urns" not in cypher:
            return []                                    # nothing comes into the hub
        later = [r for r in hub if r[0] > params["_after"]]
        return later[:params["_page"]]

    p, calls = _provider(rows)
    edges = _run(p.relationships_at(["urn:t1"], edge_types=["FLOWS_TO"], limit=100))
    assert sorted(e.id for e in edges) == sorted(f"e{i}" for i in range(10))
    assert all("ORDER BY ID(r) LIMIT $_page" in cypher for cypher, _ in calls)
    assert [params["_after"] for cypher, params in calls if "a.urn IN" in cypher] == [-1, 2, 5, 8]
    # The limit still holds, across pages.
    p, _ = _provider(rows)
    assert len(_run(p.relationships_at(["urn:t1"], edge_types=["FLOWS_TO"], limit=4))) == 4


def test_a_lagging_main_refuses_it_as_its_other_search_reads():
    provider = VersionedBranchProvider(object(), graph_id="g", branch_id="m")
    with pytest.raises(NotImplementedError, match="catching up"):
        _run(provider.relationships_at(["urn:t1"], limit=1))
