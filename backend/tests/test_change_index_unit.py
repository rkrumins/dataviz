"""The change index's pure parts (change_index.py): what an entity's change is, what a list
counts and in which order it lists, what a filter keeps, and a cache that builds each index once.

The store-facing half — reading a draft's heads or a window of main — is covered against Postgres
in ``integration/test_versioning_change_index.py``."""
from __future__ import annotations

import asyncio
from typing import NamedTuple, Optional

import pytest

from backend.app.services.versioning.change_index import (
    ChangeIndex, ChangeIndexBuilder, ChangeOrigin, IndexCache, classify, compact_entries,
    entry_dict, stat_changes,
)


class V(NamedTuple):
    """A stored value as ``_hashes_at`` and ``_head_index`` give one: no payload."""
    kind: str
    content_hash: str
    urn: Optional[str] = None
    type: Optional[str] = None
    src: Optional[str] = None
    tgt: Optional[str] = None
    name: Optional[str] = None
    qname: Optional[str] = None


def node(h, name, typ="Table", urn=None):
    return V("node", h, urn or f"urn:{name}", typ, name=name, qname=f"db.{name}")


def edge(h, typ, src, tgt):
    return V("edge", h, None, typ, src=src, tgt=tgt)


def test_classify_from_hashes():
    assert classify(None, node("h1", "a")) == "added"
    assert classify(node("h1", "a"), None) == "removed"
    assert classify(node("h1", "a"), node("h2", "a")) == "modified"
    # Changed and changed back is no change; absent at both ends is nothing.
    assert classify(node("h1", "a"), node("h1", "a")) is None
    assert classify(None, None) is None


def _built(pairs, cset=("CONTAINS",), keep=True, **finish):
    b = ChangeIndexBuilder(cset, keep=keep)
    b.add_pairs(pairs)
    return b.finish(**finish)


PAIRS = [
    ("n1", None, node("h1", "orders")),                                   # added table
    ("n2", node("h1", "customers"), node("h2", "customers")),             # modified table
    ("n3", node("h1", "amount", "Column"), None),                         # removed column
    ("n4", node("h1", "same"), node("h1", "same")),                       # no net change
    ("e1", None, edge("h1", "CONTAINS", "n1", "n3")),                     # added structure
    ("e2", None, edge("h1", "FLOWS_TO", "n1", "n2")),                     # added relationship
    ("e3", edge("h1", "FLOWS_TO", "n2", "n1"), None),                     # removed relationship
]


def test_counts_agree_with_the_tree_summary():
    """``counts`` holds everything, ``entityCounts`` the nodes, ``edgeCounts`` the
    relationships but not structure, and ``impact`` the node types — as the Changes tree's
    summary (``_count_if_too_large``) counts them, so the two never disagree."""
    s = _built(PAIRS).summary(ChangeOrigin(branch_id="br_1"))
    assert s["counts"] == {"added": 3, "modified": 1, "removed": 2}
    assert s["entityCounts"] == {"added": 1, "modified": 1, "removed": 1}
    assert s["edgeCounts"] == {"added": 1, "modified": 0, "removed": 1}
    assert s["structureCounts"] == {"added": 1, "modified": 0, "removed": 0}
    assert s["impact"] == {"Table": 2, "Column": 1}
    assert s["total"] == s["listed"] == 6
    assert s["origin"] == {"branchId": "br_1"} and s["tooLarge"] is None
    by_type = {(r["kind"], r["type"]): (r["added"], r["modified"], r["removed"]) for r in s["byType"]}
    assert by_type == {("node", "Table"): (1, 1, 0), ("node", "Column"): (0, 0, 1),
                       ("structure", "CONTAINS"): (1, 0, 0), ("edge", "FLOWS_TO"): (1, 0, 1)}


def test_order_is_entities_then_relationships_then_structure():
    ids = [e.entity_id for e in _built(PAIRS).entries]
    # Column < Table by type; within Table, customers < orders by name.
    assert ids == ["n3", "n2", "n1", "e2", "e3", "e1"]


def test_a_removed_entity_is_named_as_it_was():
    e = next(e for e in _built(PAIRS).entries if e.entity_id == "n3")
    assert (e.status, e.name, e.type, e.urn) == ("removed", "amount", "Column", "urn:amount")


def test_filters_and_pages_are_offsets_into_one_order():
    index = _built(PAIRS)
    assert [index.entries[i].entity_id for i in index.view(kind="node")] == ["n3", "n2", "n1"]
    assert [index.entries[i].entity_id for i in index.view(kind="edge")] == ["e2", "e3"]
    assert [index.entries[i].entity_id for i in index.view(kind="structure")] == ["e1"]
    assert [index.entries[i].entity_id for i in index.view(statuses=["removed"])] == ["n3", "e3"]
    assert [index.entries[i].entity_id for i in index.view(type_="Table")] == ["n2", "n1"]
    # Text matches a name, qualified name, urn, type or id, ignoring case.
    assert [index.entries[i].entity_id for i in index.view(q="CUST")] == ["n2"]
    everything = index.view()
    first, second = index.page(everything, 0, 4), index.page(everything, 4, 4)
    assert [e.entity_id for e in first + second] == [e.entity_id for e in index.entries]
    assert len(second) == 2
    # The same filter is served from the kept view, not filtered again.
    assert index.view(kind="node") is index.view(kind="node")


def test_an_origin_past_the_cap_is_counted_and_lists_nothing():
    index = _built(PAIRS, keep=False, too_large={"changed": 6, "limit": 5})
    assert index.entries == [] and index.summary(ChangeOrigin(branch_id="b"))["listed"] == 0
    assert index.counts == {"added": 3, "modified": 1, "removed": 2}
    assert index.too_large == {"changed": 6, "limit": 5}
    assert compact_entries(index) == []


def test_a_counted_window_says_its_counts_are_approximate():
    index = ChangeIndex.counted({"added": 10, "modified": 0, "removed": 0},
                                too_large={"changed": 10, "limit": 5}, window={"commitCount": 3},
                                approximate=True)
    s = index.summary(ChangeOrigin(from_seq=1, to_seq=4))
    assert s["approximate"] is True and s["entityCounts"] is None
    assert s["origin"] == {"fromSeq": 1, "toSeq": 4} and s["window"] == {"commitCount": 3}


def test_rows_name_an_edges_ends_and_compact_entries_are_short():
    index = _built(PAIRS)
    e2 = index.entries[index.by_id["e2"]]
    row = entry_dict(e2, {"n1": "orders", "n2": "customers"})
    assert row == {"entityId": "e2", "kind": "edge", "status": "added", "type": "FLOWS_TO",
                   "structural": False, "sourceEntityId": "n1", "targetEntityId": "n2",
                   "sourceName": "orders", "targetName": "customers"}
    n1 = entry_dict(index.entries[index.by_id["n1"]], {})
    assert n1["displayName"] == "orders" and n1["urn"] == "urn:orders" and "sourceName" not in n1
    compact = compact_entries(index)
    assert ["n1", "n", "a", "Table"] in compact
    assert ["e1", "e", "a", "CONTAINS", "n1", "n3"] in compact
    assert index.status_of("e3") == "removed" and index.status_of("n4") is None


@pytest.mark.parametrize("stats,expected", [
    ({"create": 2, "update": 3, "delete": 1}, (2, 3, 1)),
    ({"create": 2, "rebased": 7, "from_seq": 1, "to_seq": 9}, (2, 0, 0)),   # a pull's
    ({"nodes": 40, "edges": 2}, (42, 0, 0)),                                  # an import's
    ({"nodes": 0, "edges": 0}, (0, 0, 0)),                                    # genesis
    ({}, (0, 0, 0)),
    (None, (0, 0, 0)),
])
def test_what_a_revision_recorded_of_itself(stats, expected):
    assert stat_changes(stats) == expected


async def test_the_cache_builds_each_index_once_and_keeps_within_its_bound():
    cache = IndexCache(lambda: 10)
    builds = []

    def build_of(key, n):
        async def build():
            builds.append(key)
            await asyncio.sleep(0)
            pairs = [(f"{key}{i}", None, node(f"h{i}", f"x{i}")) for i in range(n)]
            return _built(pairs)
        return build

    # Two readers at once share one build.
    a, b = await asyncio.gather(cache.get(("a",), build_of("a", 6)), cache.get(("a",), build_of("a", 6)))
    assert a is b and builds == ["a"]
    assert await cache.get(("a",), build_of("a", 6)) is a and builds == ["a"]
    # A second index past the bound evicts the least recently read; the newest always stays.
    await cache.get(("b",), build_of("b", 6))
    await cache.get(("a",), build_of("a", 6))
    assert builds == ["a", "b", "a"]
    # One larger than the whole bound is still kept.
    big = await cache.get(("c",), build_of("c", 20))
    assert await cache.get(("c",), build_of("c", 20)) is big and builds[-1] == "c"


async def test_a_failed_build_is_not_kept():
    cache = IndexCache(lambda: 10)

    async def boom():
        raise RuntimeError("store down")

    with pytest.raises(RuntimeError):
        await cache.get(("x",), boom)

    async def ok():
        return _built(PAIRS)

    assert (await cache.get(("x",), ok)).counts["added"] == 3
