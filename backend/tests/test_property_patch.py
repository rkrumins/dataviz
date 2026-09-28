"""property_patch: the one definition of a partial update and of removing a property.

A node's property deletion never persisted because the drawer sent the whole bag and the server
merged it key by key — a key left out was kept. Removal is now explicit (`unsetProperties` on the
wire, `PROP_DELETE` inside), and these pin how a patch applies, composes and validates.
"""
import pytest

from backend.common.property_patch import (
    MAX_UNSET,
    PROP_DELETE,
    InvalidPatch,
    apply_patch,
    apply_properties_patch,
    compose_patches,
    lift_top_level_node_fields,
    normalize_update,
    strip_deletes,
)


# ── normalize_update: the wire → the internal patch ────────────────────────────
def test_unset_folds_into_properties_as_the_marker():
    out = normalize_update({"properties": {"a": 1}}, ["b", "c"])
    assert out == {"properties": {"a": 1, "b": PROP_DELETE, "c": PROP_DELETE}}


def test_unset_without_a_properties_payload():
    assert normalize_update({"displayName": "X"}, ["b"]) == {
        "displayName": "X", "properties": {"b": PROP_DELETE}}
    assert normalize_update(None, ["b"]) == {"properties": {"b": PROP_DELETE}}


def test_no_unset_returns_the_payload_unchanged():
    assert normalize_update({"properties": {"a": 1}}, None) == {"properties": {"a": 1}}
    assert normalize_update({"properties": {"a": 1}}, []) == {"properties": {"a": 1}}
    assert normalize_update(None, None) == {}


def test_duplicate_unset_names_collapse():
    assert normalize_update({}, ["b", "b"]) == {"properties": {"b": PROP_DELETE}}


def test_a_key_both_set_and_unset_is_refused():
    with pytest.raises(InvalidPatch, match="both set and unset"):
        normalize_update({"properties": {"a": 1}}, ["a"])


def test_a_legacy_marker_in_the_payload_is_the_same_removal():
    assert normalize_update({"properties": {"a": PROP_DELETE}}, ["a"]) == {"properties": {"a": PROP_DELETE}}
    assert normalize_update({"properties": {"a": PROP_DELETE}}, None) == {"properties": {"a": PROP_DELETE}}


@pytest.mark.parametrize("bad", ["", "x" * 513, 7, None])
def test_invalid_names_are_refused(bad):
    with pytest.raises(InvalidPatch, match="invalid property name"):
        normalize_update({}, [bad])


def test_too_many_names_are_refused():
    with pytest.raises(InvalidPatch, match="too many"):
        normalize_update({}, [f"k{i}" for i in range(MAX_UNSET + 1)])


def test_normalize_never_mutates_the_input():
    payload = {"properties": {"a": 1}}
    normalize_update(payload, ["b"])
    assert payload == {"properties": {"a": 1}}


# ── apply_patch: a patch onto a real value ─────────────────────────────────────
def test_apply_merges_properties_and_removes_marked_keys():
    base = {"urn": "n1", "displayName": "Old", "properties": {"a": 1, "b": 2, "c": 3}}
    out = apply_patch(base, {"displayName": "New", "properties": {"b": 20, "c": PROP_DELETE, "d": 4}})
    assert out == {"urn": "n1", "displayName": "New", "properties": {"a": 1, "b": 20, "d": 4}}


def test_apply_keeps_properties_the_patch_does_not_name():
    out = apply_patch({"properties": {"a": 1}}, {"description": "d"})
    assert out == {"properties": {"a": 1}, "description": "d"}


def test_apply_removing_an_absent_key_is_a_no_op():
    assert apply_patch({"properties": {"a": 1}}, {"properties": {"zz": PROP_DELETE}}) == {"properties": {"a": 1}}


def test_apply_onto_nothing_never_leaks_the_marker():
    assert apply_patch(None, {"properties": {"a": PROP_DELETE, "b": 1}}) == {"properties": {"b": 1}}


def test_apply_without_any_properties_adds_none():
    assert apply_patch({"urn": "n1"}, {"displayName": "X"}) == {"urn": "n1", "displayName": "X"}


def test_apply_never_mutates_its_inputs():
    base = {"properties": {"a": 1}}
    patch = {"properties": {"a": PROP_DELETE}}
    apply_patch(base, patch)
    assert base == {"properties": {"a": 1}} and patch == {"properties": {"a": PROP_DELETE}}


# ── compose_patches: two patches, in order, as one ─────────────────────────────
def test_compose_keeps_the_first_patches_removal():
    """A rename then a property edit on one node in one save used to drop the first's removal."""
    first = {"properties": {"a": PROP_DELETE}}
    second = {"displayName": "Renamed", "properties": {"b": 2}}
    composed = compose_patches(first, second)
    assert composed == {"displayName": "Renamed", "properties": {"a": PROP_DELETE, "b": 2}}
    assert apply_patch({"properties": {"a": 1, "c": 3}}, composed) == {
        "displayName": "Renamed", "properties": {"b": 2, "c": 3}}


def test_compose_a_later_set_readds_a_removed_property():
    composed = compose_patches({"properties": {"a": PROP_DELETE}}, {"properties": {"a": 5}})
    assert composed == {"properties": {"a": 5}}


def test_compose_a_later_removal_wins():
    composed = compose_patches({"properties": {"a": 5}}, {"properties": {"a": PROP_DELETE}})
    assert apply_patch({"properties": {"a": 1}}, composed) == {"properties": {}}


# ── helpers ────────────────────────────────────────────────────────────────────
def test_strip_deletes_drops_markers_and_returns_the_same_object_when_clean():
    clean = {"properties": {"a": 1}}
    assert strip_deletes(clean) is clean
    assert strip_deletes(None) is None
    assert strip_deletes({"properties": {"a": 1, "b": PROP_DELETE}}) == {"properties": {"a": 1}}


def test_apply_properties_patch_for_a_provider_bag():
    assert apply_properties_patch({"a": 1, "b": 2}, {"b": PROP_DELETE, "c": 3}) == {"a": 1, "c": 3}
    assert apply_properties_patch(None, {"x": PROP_DELETE}) == {}
    assert apply_properties_patch({"a": 1}, None) == {"a": 1}


def test_lift_moves_top_level_node_fields_out_of_properties():
    out = lift_top_level_node_fields({"properties": {"description": "D", "qualifiedName": "q", "owner": "o"}})
    assert out == {"description": "D", "qualifiedName": "q", "properties": {"owner": "o"}}


def test_lift_never_overrides_a_top_level_value():
    out = lift_top_level_node_fields({"description": "top", "properties": {"description": "nested"}})
    assert out == {"description": "top", "properties": {}}


def test_lift_returns_the_same_object_when_there_is_nothing_to_lift():
    payload = {"properties": {"owner": "o"}}
    assert lift_top_level_node_fields(payload) is payload
