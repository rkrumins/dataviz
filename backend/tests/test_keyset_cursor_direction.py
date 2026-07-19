"""Pure unit tests for the direction-aware keyset cursor helpers in the
FalkorDB provider (no DB): encode/decode round-trips, legacy-cursor
compatibility, direction-mismatch rejection, and the DESC sort key twin.
"""
import pytest

from backend.app.providers.falkordb_provider import (
    _decode_keyset_cursor,
    _encode_keyset_cursor,
    _keyset_sort,
    _validate_sort_direction,
)


class _Node:
    def __init__(self, display_name, urn):
        self.display_name = display_name
        self.urn = urn


class TestValidateSortDirection:
    def test_accepts_asc_desc_and_defaults(self):
        assert _validate_sort_direction("asc") == "asc"
        assert _validate_sort_direction("DESC") == "desc"
        assert _validate_sort_direction("") == "asc"
        assert _validate_sort_direction(None) == "asc"

    def test_rejects_garbage(self):
        with pytest.raises(ValueError):
            _validate_sort_direction("sideways")


class TestCursorRoundTrip:
    def test_asc_round_trip(self):
        c = _encode_keyset_cursor("Accounts", "urn:x", "asc")
        assert _decode_keyset_cursor(c, "asc") == ("Accounts", "urn:x")

    def test_desc_round_trip(self):
        c = _encode_keyset_cursor("Accounts", "urn:x", "desc")
        assert _decode_keyset_cursor(c, "desc") == ("Accounts", "urn:x")

    def test_asc_cursor_has_no_direction_field(self):
        # Wire-compat: asc cursors look exactly like pre-direction cursors.
        asc = _encode_keyset_cursor("A", "urn:x", "asc")
        legacy = _encode_keyset_cursor("A", "urn:x")
        assert asc == legacy

    def test_direction_mismatch_rejected_both_ways(self):
        asc = _encode_keyset_cursor("A", "urn:x", "asc")
        desc = _encode_keyset_cursor("A", "urn:x", "desc")
        with pytest.raises(ValueError):
            _decode_keyset_cursor(asc, "desc")
        with pytest.raises(ValueError):
            _decode_keyset_cursor(desc, "asc")

    def test_legacy_plain_string_cursor(self):
        # Pre-k1 cursors (bare displayName) still work for asc...
        assert _decode_keyset_cursor("Accounts", "asc") == ("Accounts", None)
        # ...but cannot be replayed against a desc request.
        with pytest.raises(ValueError):
            _decode_keyset_cursor("Accounts", "desc")


class TestKeysetSort:
    def test_asc_orders_by_name_then_urn_nulls_last(self):
        nodes = [
            _Node("b", "urn:1"),
            _Node("a", "urn:2"),
            _Node("a", "urn:1"),
            _Node(None, "urn:0"),
        ]
        out = _keyset_sort(nodes, "asc")
        assert [(n.display_name, n.urn) for n in out] == [
            ("a", "urn:1"), ("a", "urn:2"), ("b", "urn:1"), (None, "urn:0"),
        ]

    def test_desc_inverts_names_and_urn_tiebreak_nulls_still_last(self):
        nodes = [
            _Node("a", "urn:1"),
            _Node(None, "urn:0"),
            _Node("b", "urn:1"),
            _Node("a", "urn:2"),
        ]
        out = _keyset_sort(nodes, "desc")
        assert [(n.display_name, n.urn) for n in out] == [
            ("b", "urn:1"), ("a", "urn:2"), ("a", "urn:1"), (None, "urn:0"),
        ]

    def test_desc_is_exact_reverse_of_asc_for_unique_keys(self):
        nodes = [_Node(name, f"urn:{name}") for name in ["delta", "alpha", "zeta", "beta"]]
        asc = _keyset_sort(nodes, "asc")
        desc = _keyset_sort(nodes, "desc")
        assert [n.urn for n in desc] == [n.urn for n in reversed(asc)]
