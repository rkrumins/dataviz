"""ULID identifiers — time-sortable primary keys for the ``graphver`` store.

Plan §2 / §16.5 #4 call for **ULID** PKs (not random UUID/SHA-256) so B-tree
inserts stay sequential and append-only version tables don't fragment.  A ULID
is a 128-bit value — 48-bit millisecond timestamp + 80-bit randomness — encoded
as 26 Crockford-base32 characters that sort lexicographically in creation order.

Pure stdlib (no ``ulid`` dependency).  Generation is monotonic *within* a
millisecond so two ids minted back-to-back still sort in mint order.

**Entity ids** — what a new node or edge is named, and a node's urn too — are minted here and
only here (``tests/test_identity_minting_guard.py`` holds every write path to it), in the one
standard form ``urn:uuid:<uuid>`` (RFC 9562's URN form of a UUID, lowercase):

- :func:`new_entity_id` — a UUIDv7: time-ordered for the same B-tree reason as ULIDs, unique
  without asking the database.
- :func:`derived_entity_id` — a UUIDv5 named by a seed: for an id a request must mint identically
  when it is sent again (a save retried under its Idempotency-Key).

An id says nothing about what it names: the type and origin are the entity's own fields, so an id
never goes stale. See ``docs/versioning/18-identity.md``.
"""
from __future__ import annotations

import hashlib
import os
import threading
import time
import uuid
from typing import Any, Optional

__all__ = ["ulid", "prefixed_id", "stable_prefixed_id", "uuid7", "new_entity_id",
           "derived_entity_id", "uuid_urn", "ENTITY_NAMESPACE"]

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"   # excludes I, L, O, U
_MASK80 = (1 << 80) - 1

_lock = threading.Lock()
_last_ts: int = -1
_last_rand: int = 0


def _encode(value: int, length: int) -> str:
    out = []
    for _ in range(length):
        out.append(_CROCKFORD[value & 0x1F])
        value >>= 5
    return "".join(reversed(out))


def ulid(ts_ms: int | None = None) -> str:
    """Return a 26-char ULID.  Monotonic within a millisecond."""
    global _last_ts, _last_rand
    with _lock:
        now = int(time.time() * 1000) if ts_ms is None else ts_ms
        if now == _last_ts:
            # Same ms: increment the previous randomness to preserve sort order.
            _last_rand = (_last_rand + 1) & _MASK80
            if _last_rand == 0:        # overflow (astronomically unlikely) → bump ms
                now += 1
                _last_ts = now
                _last_rand = int.from_bytes(os.urandom(10), "big")
        else:
            _last_ts = now
            _last_rand = int.from_bytes(os.urandom(10), "big")
        rand = _last_rand
        ts = now
    return _encode(ts, 10) + _encode(rand, 16)


def prefixed_id(prefix: str) -> str:
    """``<prefix>_<ulid>`` — e.g. ``cmt_01J9Z...`` (mirrors the repo's id style)."""
    return f"{prefix}_{ulid()}"


def stable_prefixed_id(prefix: str, key: str) -> str:
    """``<prefix>_<26 chars>`` derived from ``key`` alone — the same key always mints the same id.

    For an id a job must mint again identically when it replays a window after a crash (a package
    line with no entity id is keyed by its position in the file), where :func:`prefixed_id` would
    mint a second entity. Not time-sortable: the 128 bits are a hash of ``key``."""
    digest = hashlib.blake2b(key.encode("utf-8"), digest_size=16).digest()
    return f"{prefix}_{_encode(int.from_bytes(digest, 'big'), 26)}"


# ── Entity ids: ``urn:uuid:<uuid>`` ───────────────────────────────────────────

#: The namespace of every name-based (v5) entity id: fixed, so a seed names the same entity on
#: every process and every deploy — and nothing outside this platform's.
ENTITY_NAMESPACE = uuid.UUID("f957ac52-8d28-4774-a953-af5a68dc6b11")

_URN_UUID = "urn:uuid:"
_MASK74 = (1 << 74) - 1
_u7_lock = threading.Lock()
_u7_last_ts: int = -1
_u7_last_rand: int = 0


def uuid7(ts_ms: Optional[int] = None) -> uuid.UUID:
    """An RFC 9562 UUIDv7: a 48-bit Unix-millisecond timestamp, the version, 74 random bits, the
    variant. Monotonic within a process (RFC 9562 §6.2, method 2): within one millisecond — or
    when the clock steps back — the random field counts up from the last one, so ids minted back
    to back sort in mint order and inserts keyed by them land at the right edge of a B-tree. Two
    processes start each millisecond from independent random points. (``uuid.uuid7`` is stdlib
    only from Python 3.14.)"""
    global _u7_last_ts, _u7_last_rand
    with _u7_lock:
        now = int(time.time() * 1000) if ts_ms is None else ts_ms
        if now <= _u7_last_ts:
            now = _u7_last_ts
            _u7_last_rand = (_u7_last_rand + 1) & _MASK74
            if _u7_last_rand == 0:                    # the 74 bits ran out: the next millisecond
                now += 1
                _u7_last_rand = int.from_bytes(os.urandom(10), "big") & _MASK74
        else:
            _u7_last_rand = int.from_bytes(os.urandom(10), "big") & _MASK74
        _u7_last_ts = now
        ts, rand = now, _u7_last_rand
    value = ((ts & ((1 << 48) - 1)) << 80) | (0x7 << 76) | ((rand >> 62) << 64) | (0b10 << 62) \
        | (rand & ((1 << 62) - 1))
    return uuid.UUID(int=value)


def new_entity_id() -> str:
    """A new entity's id: ``urn:uuid:<UUIDv7>``. A node's id is its urn too."""
    return f"{_URN_UUID}{uuid7()}"


def derived_entity_id(kind: str, seed: str) -> str:
    """``urn:uuid:<UUIDv5>`` named by ``kind`` and ``seed`` alone: the same pair always names the
    same entity, so a request sent again mints what it minted the first time. ``kind``
    (``node``, ``edge``) keeps one seed's ids for different things apart."""
    return f"{_URN_UUID}{uuid.uuid5(ENTITY_NAMESPACE, f'{kind}/{seed}')}"


def uuid_urn(value: Any) -> Optional[str]:
    """``value`` in the canonical form ``urn:uuid:<lowercase 8-4-4-4-12 uuid>`` when it is a
    ``urn:uuid:`` in any case, else ``None``. A bare UUID is not one: an id is the whole string."""
    if not isinstance(value, str):
        return None
    v = value.strip()
    if len(v) != len(_URN_UUID) + 36 or v[:len(_URN_UUID)].lower() != _URN_UUID:
        return None
    tail = v[len(_URN_UUID):].lower()
    try:
        parsed = uuid.UUID(tail)
    except ValueError:
        return None
    return f"{_URN_UUID}{parsed}" if str(parsed) == tail else None


def _selftest() -> None:
    # Format.
    u = ulid()
    assert len(u) == 26, len(u)
    assert all(c in _CROCKFORD for c in u), u

    # Monotonic + lexicographically sortable even minted in a tight loop.
    ids = [ulid() for _ in range(10000)]
    assert ids == sorted(ids), "ulids must sort in creation order"
    assert len(set(ids)) == len(ids), "ulids must be unique"

    # Timestamp ordering across milliseconds.
    a = ulid(1000)
    b = ulid(2000)
    assert a < b, (a, b)

    # Prefix helper.
    pid = prefixed_id("cmt")
    assert pid.startswith("cmt_") and len(pid) == 4 + 26

    print("ids.py self-test: OK")


if __name__ == "__main__":
    _selftest()
