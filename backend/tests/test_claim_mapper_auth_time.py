"""The authentication-instant claim, in every shape an IdP sends it.

OIDC specifies epoch seconds. Corporate gateways do not read that spec:
the same field arrives as epoch milliseconds, as a decimal string, or as
an ISO-8601 timestamp (``lastLogin``). The regression this file pins:
an ISO string parsed to ``None``, and with ``require_auth_time`` on —
the back-channel default — that ``None`` hard-failed every login on the
connection while the gateway was, in fact, answering correctly.

A value that parses under none of the readings is still ``None``; the
caller decides whether that is fatal. Guessing would be worse — a wrong
instant silently disarms the daily re-authentication ceiling.
"""
import pytest

from backend.auth_service.providers.claim_mapper import apply_claim_mapping


def _auth_time(value):
    identity = apply_claim_mapping(
        {"sub": "emp-1", "email": "a@corp.example", "auth_time": value},
        kind="backchannel", provider_slug="corp",
    )
    return identity.auth_time


@pytest.mark.parametrize("value,expected", [
    (1_700_000_000, 1_700_000_000),          # OIDC epoch seconds
    (1_700_000_000.9, 1_700_000_000),        # float seconds
    ("1700000000", 1_700_000_000),           # stringified seconds
    (1_700_000_000_000, 1_700_000_000),      # epoch milliseconds
    ("1700000000000", 1_700_000_000),        # stringified milliseconds
])
def test_numeric_shapes_land_on_epoch_seconds(value, expected):
    assert _auth_time(value) == expected


@pytest.mark.parametrize("value", [
    "2023-11-14T22:13:20Z",                  # UTC, Zulu suffix
    "2023-11-14T22:13:20+00:00",             # UTC, explicit offset
    "2023-11-14T23:13:20+01:00",             # same instant, another zone
    "2023-11-14T22:13:20",                   # naive — read as UTC
])
def test_iso_8601_shapes_land_on_the_same_instant(value):
    assert _auth_time(value) == 1_700_000_000


@pytest.mark.parametrize("value", [
    "last Tuesday", "", "   ", None, True, ["1700000000"], {"t": 1},
])
def test_unreadable_shapes_stay_none(value):
    assert _auth_time(value) is None
