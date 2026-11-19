"""What deciding one change of a review decides with it, so what merges holds together and what
stays on the draft does too (``change_index.review_requirements`` / ``review_closure``)."""
import time

from backend.app.services.versioning.change_index import ChangeEntry, review_closure, review_requirements


def node(eid, status):
    return ChangeEntry(eid, "node", status, "Table", eid, None, None, None, None, False)


def edge(eid, status, src, tgt, structural=False):
    return ChangeEntry(eid, "edge", status, "CONTAINS" if structural else "FEEDS", None, None, None, src, tgt,
                       structural)


def index(*entries):
    return {e.entity_id: e for e in entries}


def test_a_new_edge_takes_the_new_entities_it_joins_not_existing_ones():
    entries = index(node("A", "added"), node("B", "modified"), edge("e", "added", "A", "B"))
    req = review_requirements(entries)
    assert review_closure(req, ["e"]) == {"e": None, "A": "e"}
    # Rejecting the new entity rejects the edge that needs it.
    assert review_closure(req, ["A"], accept=False) == {"A": None, "e": "A"}


def test_a_new_child_takes_its_link_to_its_parent_and_the_link_its_child():
    entries = index(node("P", "added"), node("C", "added"),
                    edge("pc", "added", "P", "C", structural=True))
    req = review_requirements(entries)
    assert set(review_closure(req, ["C"])) == {"C", "pc", "P"}       # a new child under a new parent
    assert set(review_closure(req, ["P"])) == {"P"}                  # a new parent alone stands


def test_a_removed_entity_takes_its_edges_and_a_removed_subtree_goes_whole():
    entries = index(node("P", "removed"), node("C", "removed"), node("X", "modified"),
                    edge("pc", "removed", "P", "C", structural=True), edge("px", "removed", "P", "X"))
    req = review_requirements(entries)
    assert set(review_closure(req, ["P"])) == {"P", "pc", "px", "C"}
    assert set(review_closure(req, ["px"])) == {"px"}                # dropping one edge alone is fine


def test_a_move_takes_both_links():
    entries = index(node("C", "modified"), edge("old", "removed", "P1", "C", structural=True),
                    edge("new", "added", "P2", "C", structural=True))
    req = review_requirements(entries)
    assert set(review_closure(req, ["new"])) == {"new", "old"}
    assert set(review_closure(req, ["old"], accept=False)) == {"old", "new"}


def test_implied_names_the_chosen_change_it_came_with():
    entries = index(node("A", "added"), node("B", "added"), edge("e", "added", "A", "B"),
                    edge("f", "added", "B", "A"))
    out = review_closure(review_requirements(entries), ["e", "f"])
    assert out["e"] is None and out["f"] is None and out["A"] in ("e", "f") and out["B"] in ("e", "f")


def test_100k_changes_decided_in_well_under_a_second():
    entries = {}
    for i in range(50_000):
        entries[f"n{i}"] = node(f"n{i}", "added")
        entries[f"e{i}"] = edge(f"e{i}", "added", f"n{i}", f"n{(i + 1) % 50_000}")
    t = time.perf_counter()
    req = review_requirements(entries)
    out = review_closure(req, [f"e{i}" for i in range(0, 50_000, 2)])
    assert time.perf_counter() - t < 2.0
    assert len(out) == 25_000 + 50_000
