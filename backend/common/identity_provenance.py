"""Which profile fields the identity provider owns, and which you do.

"The IdP is the source of truth" is easy to say and slippery to
implement, because it is not one rule — it is one rule per field, and it
depends on what the IdP actually sent rather than on whether a link
exists.

Two things follow, and both are load-bearing:

**Gate on asserted, not on linked.** ``claim_mapper`` maps ``first_name``
from ``given_name``/``givenName``, falling back to splitting a display
name. An IdP that releases none of those leaves the field empty. Locking
every field the moment an identity row exists would hand those people a
blank name they can never fill in — a worse outcome than the drift we
were trying to prevent.

**A guess is not an assertion.** That display-name fallback is exactly
that: ``"Doe, Alice"`` and ``"Maria del Carmen García"`` do not divide the
same way, and no rule gets every name right. Ownership means the person
loses the ability to correct the field and we re-apply our answer on every
login — so it is claimed only when the IdP named the halves itself. A
split name is still written, and stays theirs to fix.

**Ownership implies re-sync.** A read-only field that nothing refreshes
is not owned by anybody: it is a stale local copy nobody may correct.
So the same snapshot that marks a field managed is written on every
login, immediately after the values are re-applied from the claims.

The snapshot is rewritten wholesale each login, which is what makes
"most recently authenticated provider wins" fall out for free rather
than needing a precedence table. It matches how ``idp_groups`` already
behaves, so there is one mental model instead of two.
"""
from __future__ import annotations

from typing import Any, Iterable, Optional

#: Profile fields an IdP may own. Deliberately excludes ``display_name``:
#: that is the local override, the one thing a person can always set for
#: themselves, and the reason locking the others is tolerable at all.
#:
#: ``email`` is absent for a different reason — it is the identity key,
#: already immutable through every write path, and re-syncing it would
#: change what the account *is*, not just what it is called.
MANAGEABLE_FIELDS: tuple[str, ...] = ("first_name", "last_name")

_METADATA_KEY = "idp_managed"


def asserted_fields(
    *,
    first_name: Optional[str],
    last_name: Optional[str],
    derived: bool = False,
) -> list[str]:
    """Which of the manageable fields this login actually carried.

    Values arrive already mapped by ``claim_mapper``, so a blank here
    means the IdP released nothing usable for that field — regardless of
    which claim path it would have come from.

    *derived* says the two names were split out of a single full-name
    claim (``ProviderIdentity.names_derived_from``). They are populated,
    but by us rather than by the directory, so nothing is owned: the
    values seed the profile and remain editable. Both names come from one
    split, which is why this is one flag rather than two.
    """
    if derived:
        return []
    present = {"first_name": first_name, "last_name": last_name}
    return [f for f in MANAGEABLE_FIELDS if (present.get(f) or "").strip()]


def build_snapshot(
    *, fields: Iterable[str], provider_id: Optional[str], at: str,
) -> dict:
    """The record of who owns what, as stored on ``users.metadata_``."""
    return {"fields": list(fields), "provider_id": provider_id, "at": at}


def managed_fields(metadata: Optional[dict]) -> frozenset[str]:
    """Fields the IdP currently owns for this user.

    Anything unreadable answers "nothing is managed". Failing open is
    deliberate: a malformed metadata blob should cost a user the lock,
    not the ability to edit their own name.
    """
    snapshot = (metadata or {}).get(_METADATA_KEY)
    if not isinstance(snapshot, dict):
        return frozenset()
    raw = snapshot.get("fields")
    if not isinstance(raw, list):
        return frozenset()
    return frozenset(f for f in raw if f in MANAGEABLE_FIELDS)


def managing_provider_id(metadata: Optional[dict]) -> Optional[str]:
    """Which provider last asserted the managed fields."""
    snapshot = (metadata or {}).get(_METADATA_KEY)
    if not isinstance(snapshot, dict):
        return None
    pid = snapshot.get("provider_id")
    return pid if isinstance(pid, str) and pid else None


def snapshot_key() -> str:
    """The ``metadata_`` key the snapshot lives under."""
    return _METADATA_KEY


def merge_into_metadata(metadata: Optional[dict], snapshot: dict) -> dict[str, Any]:
    """Place *snapshot* into a metadata document without disturbing it.

    ``metadata_`` is a shared free-form document — groups, raw claims,
    attributes and UI preferences all live there — so this merges one
    key rather than replacing the object.
    """
    out = dict(metadata or {})
    out[_METADATA_KEY] = snapshot
    return out
