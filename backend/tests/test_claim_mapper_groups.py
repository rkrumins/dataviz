"""Group-claim normalisation against the shapes directories really send.

The old ``_to_groups`` split every string on commas and dropped every
non-string list item. Both rules destroy real payloads: an LDAP DN is
one group whose *name contains commas*, and plenty of directories key
groups by number. Silently mangled groups do not fail — they just map
to nothing, and the person quietly loses the access the mapping was
supposed to grant.
"""
from __future__ import annotations

import pytest

from backend.auth_service.providers.claim_mapper import (
    _to_groups,
    apply_claim_mapping,
    hoist_nested,
    resolved_sources,
)


@pytest.mark.parametrize("value,expected", [
    # The DN rule: '=' means one group, commas and all.
    ("CN=Data Analysts,OU=Groups,DC=corp,DC=example",
     ("CN=Data Analysts,OU=Groups,DC=corp,DC=example",)),
    # Plain delimited strings still split — on either delimiter.
    ("eng,analytics", ("eng", "analytics")),
    ("eng; analytics ;ops", ("eng", "analytics", "ops")),
    ("eng, analytics; ops", ("eng", "analytics", "ops")),
    # Single values.
    ("engineering", ("engineering",)),
    ("  padded  ", ("padded",)),
    # Hyphens, underscores, dots and slashes are name characters, not
    # delimiters — a kebab-case directory name is one group.
    ("my-super-cool-group", ("my-super-cool-group",)),
    ("team-a,team-b", ("team-a", "team-b")),
    (["my-super-cool-group", "corp/eng_ops.eu"],
     ("my-super-cool-group", "corp/eng_ops.eu")),
    # Numeric ids: directories that key groups by number.
    (42, ("42",)),
    ([101, "eng", 202], ("101", "eng", "202")),
    # Booleans are int subclasses and are NOT groups.
    (True, ()),
    ([True, False, "eng"], ("eng",)),
    # Lists are already delimited — items are never split further.
    (["CN=A,OU=B", "CN=C,OU=D"], ("CN=A,OU=B", "CN=C,OU=D")),
    (["a, b"], ("a, b",)),
    # Blanks and non-shapes.
    (None, ()),
    ("", ()),
    ("   ", ()),
    ([], ()),
    (["", "  ", None], ()),
    ({"nested": "dict"}, ()),
])
def test_group_shapes(value, expected):
    assert _to_groups(value) == expected


def test_the_dn_payload_survives_end_to_end():
    """Through the full mapping, not just the normaliser: one DN claim
    arrives as one mappable group name."""
    identity = apply_claim_mapping(
        {
            "sub": "emp-1", "email": "a@corp.example",
            "memberOf": "CN=Data Analysts,OU=Groups,DC=corp",
        },
        kind="backchannel", provider_slug="corp",
    )
    assert identity.groups == ("CN=Data Analysts,OU=Groups,DC=corp",)


# ── Nested membership (entitlements.groups and deeper) ───────────────


def test_groups_nested_under_entitlements_resolve_by_default():
    """The user object many AD federations hand over nests membership
    under an ``entitlements`` key. The dotted default candidate reaches
    it without any operator override — on the token kinds (no hoist)
    and the gateway kinds alike."""
    claims = {
        # Both spellings of the subject, so one dict satisfies every
        # kind's external_id default — the groups are what's under test.
        "sub": "emp-1", "external_id": "emp-1",
        "email": "a@corp.example",
        "entitlements": {"groups": ["group1", "group2", "group3"]},
    }
    for kind in ("oidc", "custom", "custom_profile", "backchannel"):
        identity = apply_claim_mapping(claims, kind=kind, provider_slug="corp")
        assert identity.groups == ("group1", "group2", "group3"), kind


def test_a_top_level_groups_claim_still_wins_over_the_nested_one():
    identity = apply_claim_mapping(
        {
            "sub": "emp-1", "email": "a@corp.example",
            "groups": ["direct"],
            "entitlements": {"groups": ["nested"]},
        },
        kind="oidc", provider_slug="corp",
    )
    assert identity.groups == ("direct",)


def test_an_empty_top_level_groups_does_not_shadow_the_nested_one():
    """A vestigial ``groups: []`` beside the populated nested list must
    not silently turn group mapping off — the candidate walk skips
    empty values."""
    identity = apply_claim_mapping(
        {
            "sub": "emp-1", "email": "a@corp.example",
            "groups": [],
            "entitlements": {"groups": ["group1"]},
        },
        kind="oidc", provider_slug="corp",
    )
    assert identity.groups == ("group1",)


def test_an_operator_override_reaches_any_nesting():
    """Depths the defaults do not cover are one dotted override away in
    the mapping studio."""
    identity = apply_claim_mapping(
        {
            "sub": "emp-1", "email": "a@corp.example",
            "authz": {"ad": {"memberships": ["deep1", "deep2"]}},
        },
        kind="oidc", provider_slug="corp",
        override={"groups": ["authz.ad.memberships"]},
    )
    assert identity.groups == ("deep1", "deep2")


def test_hundreds_of_ad_groups_arrive_intact_and_in_order():
    """Large organisations release 100+ groups per person. Every one
    must survive normalisation — DNs included, order preserved, nothing
    truncated — because the ones that matter to a mapping may be
    anywhere in the list."""
    many = [f"CN=Team {i},OU=Groups,DC=corp" for i in range(150)]
    identity = apply_claim_mapping(
        {
            "sub": "emp-1", "email": "a@corp.example",
            "entitlements": {"groups": many},
        },
        kind="backchannel", provider_slug="corp",
    )
    assert len(identity.groups) == 150
    assert identity.groups[0] == "CN=Team 0,OU=Groups,DC=corp"
    assert identity.groups[-1] == "CN=Team 149,OU=Groups,DC=corp"


def test_the_hoist_is_generic_over_container_names():
    """``entitlements`` was only ever an example — a gateway may nest
    under any name it likes, and one level of every object-valued key
    is flattened."""
    flat = hoist_nested({
        "sub": "emp-1",
        "myCorpBlob": {"groups": ["group1"], "firstName": "Alice"},
    })
    assert flat["groups"] == ["group1"]
    assert flat["firstName"] == "Alice"


def test_the_hoist_keeps_top_level_wins_and_the_emptyish_rule():
    flat = hoist_nested({
        "email": "top@corp.example",
        "groups": [],
        "anything": {"email": "nested@corp.example", "groups": ["g1"]},
    })
    # Populated top-level beats hoisted; vestigial empty does not.
    assert flat["email"] == "top@corp.example"
    assert flat["groups"] == ["g1"]


def test_priority_containers_beat_payload_order():
    """The well-known names keep first pick when two containers carry
    the same key, whatever order the payload lists them in."""
    flat = hoist_nested(
        {
            "zzz": {"firstName": "FromZzz"},
            "user": {"firstName": "FromUser"},
        },
        priority=("user",),
    )
    assert flat["firstName"] == "FromUser"


def test_the_hoist_is_one_level_but_dots_reach_the_rest():
    """A hoisted inner object is not flattened again — it becomes
    reachable by its dotted path instead, which is how the
    ``entitlements.groups`` default candidate finds
    ``{"data": {"entitlements": {"groups": [...]}}}``."""
    claims = {
        "sub": "emp-1", "email": "a@corp.example",
        "data": {"entitlements": {"groups": ["group1"]}},
    }
    flat = hoist_nested(claims)
    assert flat["entitlements"] == {"groups": ["group1"]}
    identity = apply_claim_mapping(
        flat, kind="backchannel", provider_slug="corp",
    )
    assert identity.groups == ("group1",)


def test_non_object_values_are_never_hoisted():
    flat = hoist_nested({"groups": ["g1"], "note": "text", "n": 7})
    assert flat == {"groups": ["g1"], "note": "text", "n": 7}


def test_provenance_names_the_nested_winner():
    """The mapping studio's preview must say ``entitlements.groups``
    supplied the groups, not report the field unresolved."""
    sources = resolved_sources(
        {
            "sub": "emp-1", "email": "a@corp.example",
            "entitlements": {"groups": ["group1"]},
        },
        kind="oidc",
    )
    assert sources["groups"] == "entitlements.groups"
