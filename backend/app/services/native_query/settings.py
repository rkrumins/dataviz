"""Bounds on native queries, from ``NATIVE_QUERY_*`` environment variables.

Each is clamped to a range that keeps one person's query from becoming
everyone's problem: rows and time well under what the HTTP graph tier
allows, a small share of each data source's connections, and a reply cap
that keeps the API process's memory flat whatever the query asks for.
Tests override with ``monkeypatch.setenv(...)`` plus
``get_native_query_settings.cache_clear()``.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache

_MIB = 1024 * 1024


@dataclass(frozen=True)
class NativeQuerySettings:
    #: Rows shown when the request doesn't say.
    default_rows: int
    #: The most rows a request may ask for.
    max_rows: int
    default_timeout_ms: int
    max_timeout_ms: int
    #: Runs per person, as a ``limits`` rate ("20/minute").
    rate: str
    #: Native queries at once, per data source, per process — and the size
    #: of each engine's own connection pool for them.
    concurrency: int
    #: The most bytes an engine's reply may carry before it is cut off.
    max_reply_bytes: int

    @classmethod
    def from_env(cls) -> "NativeQuerySettings":
        # A run reads one row past its limit to know more matched; 9,999 + 1
        # stays inside the stock FalkorDB image's RESULTSET_SIZE (10,000),
        # past which FalkorDB cuts a reply without saying so.
        max_rows = _read_int("NATIVE_QUERY_MAX_ROWS", 1000, 1, 9_999)
        max_timeout_ms = _read_int("NATIVE_QUERY_MAX_TIMEOUT_MS", 30_000, 1000, 60_000)
        return cls(
            default_rows=_read_int("NATIVE_QUERY_DEFAULT_ROWS", 200, 1, max_rows),
            max_rows=max_rows,
            default_timeout_ms=_read_int(
                "NATIVE_QUERY_DEFAULT_TIMEOUT_MS", 10_000, 1000, max_timeout_ms),
            max_timeout_ms=max_timeout_ms,
            rate=_read_rate("NATIVE_QUERY_RATE", "20/minute"),
            concurrency=_read_int("NATIVE_QUERY_CONCURRENCY", 2, 1, 16),
            max_reply_bytes=_read_int(
                "NATIVE_QUERY_MAX_REPLY_BYTES", 16 * _MIB, _MIB, 256 * _MIB),
        )


@lru_cache(maxsize=1)
def get_native_query_settings() -> NativeQuerySettings:
    return NativeQuerySettings.from_env()


def _read_rate(env_var: str, default: str) -> str:
    """A rate the limiter can read — never one it would fail open on."""
    from limits import parse

    raw = (os.getenv(env_var) or "").strip()
    try:
        parse(raw)
    except ValueError:
        return default
    return raw


def _read_int(env_var: str, default: int, low: int, high: int) -> int:
    raw = os.getenv(env_var)
    try:
        value = int(raw) if raw not in (None, "") else default
    except ValueError:
        value = default
    return max(low, min(high, value))
