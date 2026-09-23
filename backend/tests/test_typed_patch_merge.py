"""A patch that sends a stored value back in a lossier form must not rewrite it.

The canvas saves a node by sending its whole ``properties`` object, which has been through
the browser's ``JSON.parse``: every integer past ±2^53 comes back rounded, and editors that
hold text send digits back as strings. ``_patch_payload`` keeps the stored value whenever
the incoming one is EQUAL to it as the client could represent it, and takes the incoming
value for every real edit. Pure functions — no DB, no FalkorDB.
"""
from backend.app.services.versioning.service import GraphVersioningService
from backend.app.services.versioning.typed_merge import preserve_stored_type

BIG = -3746471915534727923            # an int64 no double can hold
BIG_AS_BROWSER_SENDS = float(BIG)     # -3.7464719155347277e18: what JSON.parse made of it


def test_rounded_big_integer_keeps_the_stored_value():
    assert preserve_stored_type(BIG, BIG_AS_BROWSER_SENDS) == BIG
    assert isinstance(preserve_stored_type(BIG, BIG_AS_BROWSER_SENDS), int)


def test_big_integer_as_exact_digits_keeps_the_stored_int():
    assert preserve_stored_type(BIG, str(BIG)) == BIG
    assert preserve_stored_type(42, " 42 ") == 42


def test_a_different_number_is_a_real_edit():
    assert preserve_stored_type(BIG, float(BIG) + 4096.0) == float(BIG) + 4096.0
    assert preserve_stored_type(42, 43) == 43
    assert preserve_stored_type(42, "43") == "43"


def test_floats_bools_and_numeric_text_keep_their_type():
    assert preserve_stored_type(1.0, 1) == 1.0 and isinstance(preserve_stored_type(1.0, 1), float)
    assert preserve_stored_type(1.5, "1.5") == 1.5
    assert preserve_stored_type(True, "true") is True
    assert preserve_stored_type(False, "FALSE") is False
    assert preserve_stored_type("1.50", 1.5) == "1.50"      # text that holds a number stays text
    assert preserve_stored_type("007", 7) == "007"          # a coerced NUMBER lost the zeros, not the user
    assert preserve_stored_type("007", "7") == "7"          # edited TEXT is a real change


def test_bool_is_never_read_as_an_integer():
    assert preserve_stored_type(1, True) is True
    assert preserve_stored_type(True, 1) == 1


def test_lists_and_dicts_compare_element_by_element():
    assert preserve_stored_type([BIG, 1], [BIG_AS_BROWSER_SENDS, 1]) == [BIG, 1]
    assert preserve_stored_type([BIG], [BIG_AS_BROWSER_SENDS, 2]) == [BIG_AS_BROWSER_SENDS, 2]
    assert preserve_stored_type({"id": BIG, "x": 1}, {"id": BIG_AS_BROWSER_SENDS, "y": 2}) == {
        "id": BIG, "y": 2,
    }


def test_patch_payload_round_trip_leaves_untouched_properties_exact():
    """The drawer edits `owner`; the browser round-trips everything else."""
    stored = {"urn": "u", "displayName": "X",
              "properties": {"owner": "fin", "sourceId": BIG, "rows": 12, "ratio": 0.5}}
    patch = {"properties": {"owner": "ops", "sourceId": BIG_AS_BROWSER_SENDS, "rows": "12",
                            "ratio": 0.5}}
    out = GraphVersioningService._patch_payload(stored, patch)
    assert out["properties"] == {"owner": "ops", "sourceId": BIG, "rows": 12, "ratio": 0.5}
    assert isinstance(out["properties"]["sourceId"], int)


def test_patch_payload_still_deletes_with_the_sentinel():
    stored = {"urn": "u", "properties": {"sourceId": BIG, "owner": "fin"}}
    out = GraphVersioningService._patch_payload(stored, {"properties": {"sourceId": "__nx_prop_delete__"}})
    assert out["properties"] == {"owner": "fin"}


def test_patch_payload_new_keys_are_taken_as_sent():
    out = GraphVersioningService._patch_payload({"urn": "u", "properties": {}}, {"properties": {"n": "5"}})
    assert out["properties"] == {"n": "5"}
