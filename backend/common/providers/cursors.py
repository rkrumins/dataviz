"""Keyset pagination cursors shared by every provider adapter.

Moved unchanged (apart from dropping the leading underscore to make each
name part of this module's public surface; ``CursorMismatchError`` was
already unprefixed) from the pre-class section of the former
``backend/app/providers/falkordb_provider.py`` — see
``backend/app/providers/falkordb/cursors.py``, which re-exports these same
objects under their old private names so existing call sites keep
resolving to them without a copy.

Stdlib only, by design (kernel hygiene) — no dependency on any model or
app module: a cursor is an opaque encoding of (displayName, urn, direction)
and the sort helpers work on any object exposing those two attributes.
"""
import base64
import json
from typing import Any, Dict, List, Optional, Tuple

# ── Keyset pagination cursor ────────────────────────────────────────────────
#
# displayName is NOT unique. A real graph holds hundreds of children all called
# "Accounts (Analytics)". A keyset of `displayName > $cursor` therefore SKIPS
# every row that shares the boundary row's name: when a page ends in the middle
# of a run of duplicates, the next page starts *after* the whole run and those
# rows are lost — silently, forever. That is how a node with 200 children paged
# out as 197.
#
# A keyset is only correct on a UNIQUE sort key, so the cursor carries the urn
# (which is unique) as a tiebreaker and the queries order by (displayName, urn).
#
# Direction: the cursor also records the sort direction it was minted under
# ("d", absent = "asc" for cursors minted before direction support). A page
# request whose direction disagrees with its cursor's is a client bug —
# continuing would silently skip or repeat rows — so providers reject the
# mismatch (ValueError → 400 at the endpoint).
CURSOR_PREFIX = "k1:"


class CursorMismatchError(ValueError):
    """A pagination cursor (or sort_direction) that cannot serve the request —
    minted under the other direction, unreadable, or malformed. Endpoints map
    this (and only this) to HTTP 400; any other ValueError stays a 500."""


def validate_sort_direction(sort_direction: str) -> str:
    direction = (sort_direction or "asc").lower()
    if direction not in ("asc", "desc"):
        raise CursorMismatchError(f"invalid sort_direction {sort_direction!r} (expected 'asc' or 'desc')")
    return direction


def encode_keyset_cursor(display_name: Optional[str], urn: str, sort_direction: str = "asc") -> str:
    payload: Dict[str, Any] = {"n": display_name or "", "u": urn}
    if sort_direction == "desc":
        payload["d"] = "desc"
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode()
    ).decode().rstrip("=")
    return CURSOR_PREFIX + encoded


def decode_keyset_cursor(cursor: str, sort_direction: str = "asc") -> Tuple[str, Optional[str]]:
    """(displayName, urn). A legacy displayName-only cursor yields urn=None, so a
    client that is mid-pagination across a deploy keeps working (with the old,
    lossy semantics) instead of erroring.

    Raises CursorMismatchError when the cursor was minted under a different
    sort direction than the one now requested (absent "d" = asc)."""
    if not cursor.startswith(CURSOR_PREFIX):
        if sort_direction == "desc":
            raise CursorMismatchError("cursor direction mismatch: legacy asc cursor used with sort_direction=desc")
        return cursor, None
    raw = cursor[len(CURSOR_PREFIX):]
    try:
        padded = raw + "=" * (-len(raw) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
    except Exception:  # pragma: no cover - corrupt cursor, fall back to prefix scan
        if sort_direction == "desc":
            raise CursorMismatchError("cursor direction mismatch: unreadable cursor used with sort_direction=desc")
        return cursor, None
    cursor_direction = data.get("d") or "asc"
    if cursor_direction != sort_direction:
        raise CursorMismatchError(
            f"cursor direction mismatch: cursor was minted for {cursor_direction!r}, "
            f"request asked for {sort_direction!r}"
        )
    return str(data.get("n", "")), data.get("u") or None


def keyset_sort_key(node: Any) -> Tuple[bool, str, str]:
    """Sort rows the same way the ASC keyset does: (displayName, urn), nulls last."""
    name = getattr(node, "display_name", None)
    return (name is None, name or "", getattr(node, "urn", "") or "")


def keyset_sort(nodes: List[Any], sort_direction: str) -> List[Any]:
    """Defensive re-sort matching the Cypher keyset order for the direction.

    DESC is a TRUE descending lexicographic sort of (displayName, urn) with
    null names kept last (parity with the ASC path). Implemented as a
    two-bucket `reverse=True` sort — NOT a per-character complement key: a
    negated-code-point tuple fails to invert Python's tuple-length rule, so
    prefix pairs mis-order ("Account" would sort before "Accounts" although
    true DESC is the opposite), and a cursor minted from that wrong page tail
    silently duplicates/skips rows at page boundaries."""
    if sort_direction != "desc":
        return sorted(nodes, key=keyset_sort_key)
    named = [n for n in nodes if getattr(n, "display_name", None) is not None]
    unnamed = [n for n in nodes if getattr(n, "display_name", None) is None]
    named.sort(key=lambda n: (n.display_name, getattr(n, "urn", "") or ""), reverse=True)
    unnamed.sort(key=lambda n: getattr(n, "urn", "") or "", reverse=True)
    return named + unnamed
