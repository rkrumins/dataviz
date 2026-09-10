"""What happens when the directory sends one name instead of two.

Plenty of IdPs release ``name`` and nothing else — no ``given_name``, no
``family_name``. Without a fallback those people arrive with no name at
all, so ``claim_mapper`` splits the full name into halves.

Splitting is a guess, and that is the load-bearing fact here rather than
an aside. ``"Doe, Alice"`` and ``"Maria del Carmen García"`` do not divide
the same way, and no rule gets every name right. So the guess is kept
distinguishable from an assertion all the way through:

  * ``ProviderIdentity.names_derived_from`` names the claim it came out of,
  * ``asserted_fields`` declines to hand the IdP ownership of it, which is
    what leaves the person able to correct it, and
  * the mapping preview reports it, so the screen an operator configures
    this on does not say "nothing resolved" beside two populated values.

The third one is why this file exists at all: before it, the studio showed
First name and Last name as unresolved and unlocked while the login
populated and locked them.
"""
import pytest

from backend.auth_service.providers.claim_mapper import (
    apply_claim_mapping,
    resolved_sources,
    split_display_name,
)
from backend.common.identity_provenance import asserted_fields


# ── The split itself ─────────────────────────────────────────────────

@pytest.mark.parametrize("full,first,last", [
    # The ordinary case.
    ("Alice Doe", "Alice", "Doe"),
    # Active Directory's cn convention. A whitespace split put the surname
    # in the first-name box with the comma still attached.
    ("Doe, Alice", "Alice", "Doe"),
    ("Doe,Alice", "Alice", "Doe"),
    ("  van der Berg ,  Jan  ", "Jan", "van der Berg"),
    # A trailing comma is punctuation, not a structure — fall through to
    # the whitespace rule, and the comma itself is stripped rather than
    # stored in the surname.
    ("Alice Doe,", "Alice", "Doe"),
    (",Alice Doe", "Alice", "Doe"),
    # Particles belong with the family name, which falls out of splitting
    # once rather than on every space.
    ("Maria del Carmen García", "Maria", "del Carmen García"),
    ("John Doe", "John", "Doe"),
    # A middle name lands in the family half — a guess, which is why the
    # halves are never IdP-locked and every surface displays the stored
    # verbatim string ("James May Meadows"), not a re-join of the halves.
    ("James May Meadows", "James", "May Meadows"),
    ("Juan De La Hoya", "Juan", "De La Hoya"),
    # Nothing to divide. Inventing a division would be worse than one
    # empty field.
    ("Prince", "Prince", ""),
    ("山田太郎", "山田太郎", ""),
    ("   Alice   Doe   ", "Alice", "Doe"),
    ("", "", ""),
    ("   ", "", ""),
])
def test_split_display_name(full, first, last):
    assert split_display_name(full) == (first, last)


# ── End to end through the mapper ────────────────────────────────────

def test_full_name_only_still_produces_a_name():
    identity = apply_claim_mapping(
        {"sub": "u1", "email": "alice@corp.example", "name": "Alice Doe"},
        kind="oidc", provider_slug="entra",
    )
    assert (identity.first_name, identity.last_name) == ("Alice", "Doe")
    assert identity.names_derived_from == "name"
    # The exact string the IdP released rides along — the split is a
    # guess about word order, and downstream wants the original too.
    assert identity.display_name == "Alice Doe"


def test_a_custom_kind_splits_the_grab_bag_names_too():
    """DEFAULT_CUSTOM used to carry a single display_name candidate, so
    a custom IdP releasing only ``name`` produced no name at all."""
    for key in ("name", "fullName", "displayName"):
        identity = apply_claim_mapping(
            {"external_id": "u1", "email": "a@corp.example",
             key: "Alice Doe"},
            kind="custom", provider_slug="corp",
        )
        assert (identity.first_name, identity.last_name) == ("Alice", "Doe"), key


def test_saml_splits_the_directory_native_full_name():
    """Shibboleth/eduPerson release cn as urn:oid:2.5.4.3 and nothing
    friendlier — the default candidates must reach it."""
    identity = apply_claim_mapping(
        {"__name_id__": "u1", "email": "a@corp.example",
         "urn:oid:2.5.4.3": "Doe, Alice"},
        kind="saml2", provider_slug="shib",
    )
    assert (identity.first_name, identity.last_name) == ("Alice", "Doe")
    assert identity.display_name == "Doe, Alice"


def test_the_idp_naming_the_halves_is_not_a_derivation():
    identity = apply_claim_mapping(
        {
            "sub": "u1", "email": "alice@corp.example",
            "given_name": "Alice", "family_name": "Doe",
            "name": "Something Else Entirely",
        },
        kind="oidc", provider_slug="entra",
    )
    assert (identity.first_name, identity.last_name) == ("Alice", "Doe")
    assert identity.names_derived_from is None


def test_one_asserted_half_suppresses_the_split():
    """The fallback fires only when *both* are empty.

    Splitting to fill in the other half would overwrite nothing but would
    invent a surname the directory never gave us, and mark it asserted.
    """
    identity = apply_claim_mapping(
        {"sub": "u1", "email": "a@corp.example",
         "given_name": "Alice", "name": "Alice Doe"},
        kind="oidc", provider_slug="entra",
    )
    assert identity.first_name == "Alice"
    assert identity.last_name == ""
    assert identity.names_derived_from is None


def test_derivation_names_the_claim_that_won():
    """Which candidate, not merely that there was one.

    ``display_name`` carries a fallback list; an operator editing it needs
    to know whether ``fullName`` or ``displayName`` is doing the work.
    """
    identity = apply_claim_mapping(
        {"sub": "u1", "email": "a@corp.example", "displayName": "Alice Doe"},
        kind="custom_profile", provider_slug="portal",
    )
    assert identity.names_derived_from == "displayName"


def test_derivation_follows_an_operator_override():
    identity = apply_claim_mapping(
        {"sub": "u1", "email": "a@corp.example",
         "profile": {"cn": "Doe, Alice"}},
        kind="oidc", provider_slug="entra",
        override={"display_name": ["profile.cn"]},
    )
    assert (identity.first_name, identity.last_name) == ("Alice", "Doe")
    assert identity.names_derived_from == "profile.cn"


# ── Ownership ────────────────────────────────────────────────────────

def test_a_split_name_is_not_owned_by_the_idp():
    """The point of the whole exercise.

    Ownership costs the person the ability to correct the field and
    re-applies our answer on every login. Claiming that on the strength of
    a guess is the one outcome worth avoiding.
    """
    assert asserted_fields(
        first_name="Alice", last_name="Doe", derived=True,
    ) == []


def test_an_asserted_name_is_still_owned():
    """The asymmetry is the assertion worth having — it would be easy to
    fix the lock by never locking anything."""
    assert asserted_fields(
        first_name="Alice", last_name="Doe", derived=False,
    ) == ["first_name", "last_name"]


# ── What the mapping screen is told ──────────────────────────────────

def test_provenance_reports_no_winner_for_a_split_name():
    """``resolvedFrom`` answers "which candidate of *this field* fired",
    and for a split name the honest answer is none of them. The derivation
    is reported separately rather than by claiming a candidate won."""
    sources = resolved_sources(
        {"sub": "u1", "email": "a@corp.example", "name": "Alice Doe"},
        kind="oidc",
    )
    assert sources["first_name"] is None
    assert sources["last_name"] is None
    assert sources["display_name"] == "name"
