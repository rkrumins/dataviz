"""entity_audit's pure parts: the history cursor, what a revision changed, which lines a scope
reads, and the reader shape a save answers with."""
from datetime import datetime, timezone

import pytest

from backend.app.services.versioning.entity_audit import (
    InvalidCursor, decode_cursor, encode_cursor, entity_views, field_changes, history_branches,
)
from backend.app.services.versioning.merkle import content_hash


def test_cursor_round_trips():
    at = "2026-09-27T08:00:00.123456+00:00"
    when, row_id = decode_cursor(encode_cursor(at, "nv_1"))
    assert when == datetime(2026, 9, 27, 8, 0, 0, 123456, tzinfo=timezone.utc)
    assert row_id == "nv_1"


@pytest.mark.parametrize("bad", ["", "not-base64!", encode_cursor("yesterday", "nv_1"), "WzEsMl0"])
def test_a_foreign_cursor_is_refused(bad):
    with pytest.raises(InvalidCursor):
        decode_cursor(bad)


def test_field_changes_are_property_level():
    before = {"displayName": "A", "description": "d", "properties": {"owner": "ana", "sla": "1h"}}
    after = {"displayName": "B", "description": "d", "properties": {"owner": "bo", "tier": "gold"}}
    assert field_changes(before, after) == [
        {"path": ["displayName"], "kind": "changed", "before": "A", "after": "B"},
        {"path": ["properties", "owner"], "kind": "changed", "before": "ana", "after": "bo"},
        {"path": ["properties", "sla"], "kind": "removed", "before": "1h", "after": None},
        {"path": ["properties", "tier"], "kind": "added", "before": None, "after": "gold"},
    ]


def test_a_creation_lists_what_it_set_and_a_deletion_what_it_removed():
    assert field_changes(None, {"displayName": "A", "properties": {"x": 1}}) == [
        {"path": ["displayName"], "kind": "added", "before": None, "after": "A"},
        {"path": ["properties", "x"], "kind": "added", "before": None, "after": 1},
    ]
    assert [c["kind"] for c in field_changes({"displayName": "A"}, None)] == ["removed"]


def test_an_unchanged_revision_changes_nothing():
    v = {"displayName": "A", "properties": {"x": [1, 2]}}
    assert field_changes(v, dict(v)) == []


def test_scope_reads_main_and_only_the_viewed_draft():
    assert history_branches("all", "main", "d1") == ["main", "d1"]
    assert history_branches("all", "main", None) == ["main"]
    assert history_branches("draft", "main", "d1") == ["d1"]
    assert history_branches("draft", "main", None) == []
    assert history_branches("published", "main", "d1") == ["main"]


def test_entity_views_answer_in_the_reader_shape_with_the_token():
    node = {"urn": "urn:a", "entityType": "Table", "displayName": "A", "properties": {"x": 1}}
    edge = {"edgeType": "FLOWS_TO", "sourceEntityId": "a1", "targetEntityId": "urn:b", "properties": {}}
    views, truncated = entity_views(
        {"a1": ("node", node), "e1": ("edge", edge), "gone": ("node", None)}, {"a1": "urn:a"})
    assert not truncated
    assert views["a1"]["version"] == content_hash(node)
    assert views["a1"]["node"]["urn"] == "urn:a" and views["a1"]["node"]["properties"] == {"x": 1}
    assert views["e1"]["edge"]["sourceUrn"] == "urn:a"          # the endpoint's urn, not its id
    assert views["e1"]["edge"]["targetUrn"] == "urn:b"          # an id that IS its urn
    assert views["gone"] == {"kind": "node", "version": None, "deleted": True}


def test_entity_views_say_when_they_were_cut():
    values = {f"n{i}": ("node", {"urn": f"n{i}"}) for i in range(5)}
    views, truncated = entity_views(values, cap=3)
    assert truncated and len(views) == 3
