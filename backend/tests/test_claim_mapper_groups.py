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
