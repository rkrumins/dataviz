"""What discarding a draft's change takes with it, so the draft still holds together: a new entity
takes its new relationships and its link to its parent; a link of a move takes the other; a removed
entity brought back brings back what it lost — a removed subtree comes back whole; an edit goes alone."""
from backend.app.services.versioning.change_index import ChangeEntry, restore_closure, review_requirements


def _node(eid, status):
    return ChangeEntry(entity_id=eid, kind="node", status=status, type="Table", name=eid, qname=None,
                       urn=eid, src=None, tgt=None, structural=False)


def _edge(eid, status, src, tgt, structural=False):
    return ChangeEntry(entity_id=eid, kind="edge", status=status, type="CONTAINS" if structural else "FEEDS",
                       name=None, qname=None, urn=None, src=src, tgt=tgt, structural=structural)


def _closure(entries, chosen):
    by_id = {e.entity_id: e for e in entries}
    return restore_closure(by_id, review_requirements(by_id), chosen)


def test_a_new_entity_takes_its_links():
    entries = [_node("C3", "added"), _edge("l3", "added", "T1", "C3", structural=True), _edge("f3", "added", "C3", "T2")]
    assert _closure(entries, ["C3"]) == {"C3": None, "l3": "C3", "f3": "C3"}
    # A new link alone takes the new entity it holds (it would sit outside every parent).
    assert set(_closure(entries, ["l3"])) == {"C3", "l3", "f3"}


def test_a_removed_subtree_comes_back_whole():
    entries = [_node("T9", "removed"), _edge("l9", "removed", "S1", "T9", structural=True),
               _node("C9", "removed"), _edge("m9", "removed", "T9", "C9", structural=True), _edge("f9", "removed", "T9", "T2")]
    assert set(_closure(entries, ["T9"])) == {"T9", "l9", "C9", "m9", "f9"}


def test_a_move_takes_both_links_and_an_edit_goes_alone():
    entries = [_edge("old", "removed", "S1", "T1", structural=True), _edge("new", "added", "S2", "T1", structural=True),
               _node("T2", "modified")]
    assert set(_closure(entries, ["new"])) == {"old", "new"}
    assert _closure(entries, ["T2"]) == {"T2": None}
