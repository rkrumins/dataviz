"""Changes top-down (``change_index.ChangeTree``): every change under its container — an entity
under its parent, a relationship under its source — each container counting the changes under it
at any depth, its children most-changed first; an unchanged ancestor named from its row; a path
from the top for any change."""
from types import SimpleNamespace as NS

from backend.app.services.versioning.change_index import ROOT, ChangeIndexBuilder, ChangeTree


def node(name, h="h", type_="Table"):
    return NS(kind="node", content_hash=h, type=type_, name=name, qname=None, urn=f"urn:{name}", src=None, tgt=None)


def edge(src, tgt, h="h", type_="FEEDS"):
    return NS(kind="edge", content_hash=h, type=type_, name=None, qname=None, urn=None, src=src, tgt=tgt)


def build():
    b = ChangeIndexBuilder(["CONTAINS"])
    b.add("T1", node("orders", "a"), node("Orders", "b"))           # edited
    b.add("C1", None, node("amount"))                             # added, under T1
    b.add("C2", node("legacy"), None)                             # removed, under T1
    b.add("T2", None, node("refunds"))                            # added, under S1
    b.add("F1", None, edge("T1", "T2"))                           # a relationship, from T1
    index = b.finish()
    parent_of = {"T1": "S1", "C1": "T1", "C2": "T1", "T2": "S1", "S1": "DB", "DB": None}
    names = {"S1": ("sales", "Schema"), "DB": ("warehouse", "Database")}
    return ChangeTree(index, parent_of, names)


def test_every_change_sits_under_its_container_with_counts_at_any_depth():
    t = build()
    assert t.children[ROOT] == ["DB"]
    assert t.children["DB"] == ["S1"]
    # T1 holds three changes (two columns and a relationship), T2 none: T1 first.
    assert t.children["S1"] == ["T1", "T2"]
    assert t.children["T1"][:2] == ["C2", "C1"] or t.children["T1"][:2] == ["C1", "C2"]
    assert t.children["T1"][-1] == "F1"                           # relationships after entities
    assert all(t.children[t.parent_of.get(k) or ROOT][t.rank[k]] == k for k in ("S1", "T2", "C1"))
    assert t.rollup["T1"] == [2, 0, 1]                            # amount + the relationship added, legacy removed
    assert t.rollup["DB"] == [3, 1, 1]                            # everything, counted at the top
    assert t.rollup.get("C1") is None


def test_names_paths_and_what_each_item_is():
    t = build()
    assert (t.name_of("S1"), t.type_of("S1")) == ("sales", "Schema")
    assert t.name_of("T1") == "Orders"
    assert t.path("C1") == ["DB", "S1", "T1"]
    assert t.path("F1") == ["DB", "S1", "T1"]
    assert t.path("DB") == []


def test_a_cycle_in_bad_data_never_loops():
    b = ChangeIndexBuilder([])
    b.add("A", None, node("a"))
    t = ChangeTree(b.finish(), {"A": "B", "B": "A"}, {})
    assert sum(t.rollup["B"]) >= 1
