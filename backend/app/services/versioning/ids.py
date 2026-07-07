"""ULID identifiers — time-sortable primary keys for the ``graphver`` store.

Plan §2 / §16.5 #4 call for **ULID** PKs (not random UUID/SHA-256) so B-tree
inserts stay sequential and append-only version tables don't fragment.  A ULID
is a 128-bit value — 48-bit millisecond timestamp + 80-bit randomness — encoded
as 26 Crockford-base32 characters that sort lexicographically in creation order.

Pure stdlib (no ``ulid`` dependency).  Generation is monotonic *within* a
millisecond so two ids minted back-to-back still sort in mint order.
"""
from __future__ import annotations

import os
import threading
import time

__all__ = ["ulid", "prefixed_id"]

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
