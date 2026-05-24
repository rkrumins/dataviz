"""Unit tests for the working-set repository's pure coalesce decision
logic.

The repository touches DB state via SQLAlchemy ORM, so end-to-end
behaviour is verified by the integration suite. But the *decision* of
how an incoming staged change interacts with an existing pending one
is pure logic — pinned here so the cancel-out (add→delete) and
keep-as-add (add→update) semantics cannot regress silently.
"""
import pytest

from backend.app.db.repositories.graph_working_set_repo import coalesce_decision


@pytest.mark.parametrize(
    "existing, incoming, expected",
    [
        # add → delete cancels (the bug from the audit).
        ("add_node", "delete_node", "drop"),
        ("add_edge", "delete_edge", "drop"),
        # add → update keeps the row as an add with the new payload.
        ("add_node", "update_node", "replace_keep_add"),
        ("add_edge", "update_edge", "replace_keep_add"),
        # add → add (re-create with the same id mid-session) is last-
        # write-wins.
        ("add_node", "add_node", "replace"),
        # update → anything is last-write-wins.
        ("update_node", "update_node", "replace"),
        ("update_node", "delete_node", "replace"),
        ("update_edge", "update_edge", "replace"),
        # delete → anything is last-write-wins (delete-then-re-add is
        # weird but allowed; produces a final ADD row whose payload is
        # the new content — apply_changes treats it as add).
        ("delete_node", "add_node", "replace"),
        ("delete_node", "update_node", "replace"),
    ],
)
def test_coalesce_decision_matrix(existing, incoming, expected):
    assert coalesce_decision(existing, incoming) == expected


def test_add_then_delete_drops_for_both_object_kinds():
    # Specifically the bug — make sure both node and edge cancel-out.
    assert coalesce_decision("add_node", "delete_node") == "drop"
    assert coalesce_decision("add_edge", "delete_edge") == "drop"
