"""The STREAMS (coordination bus) Redis client.

Thin compatibility wrapper over the central resolver/factory in
``redis_endpoint.py``. Kept as its own name because two services import it
(aggregation ``redis_client``, versioning ``messaging``) and its Cluster-rejection
contract is referenced by docs and tests.

The bus — job stream + consumer groups, single-active exec locks, cancel pub/sub,
the admission token-bucket, SSE progress — is a *coordination* workload, not a
sharded-data one. Every operation is single-key, so it runs cleanly on a single
node or a Sentinel-managed master. Redis Cluster is intentionally NOT supported.
"""
from __future__ import annotations

import logging
from typing import Any

from backend.common.adapters.redis_endpoint import (
    RedisConfigurationError,
    RedisRole,
    build_redis_client,
    resolve_redis_config,
)

# Historical name — imported by tests and callers.
BusConfigurationError = RedisConfigurationError


# ── consumer-loop error classification ──────────────────────────────
#
# NOAUTH / WRONGPASS from the bus is a CONFIGURATION problem (rotated or
# wrong REDIS_STREAMS_PASSWORD, wrong ACL user), not a network blip. The
# consumer loops used to log a generic "XREADGROUP failed … retrying in 2s"
# and hot-loop on a ~2s cadence forever — the blocking read returns
# immediately on an error reply — with nothing telling the operator WHAT to
# fix. Auth-class errors get an actionable message and a long backoff; the
# loop still retries, so fixing the credential live self-heals.

_BUS_AUTH_MARKERS = (
    "noauth",
    "wrongpass",
    "invalid username-password",
    "authentication required",
    # redis-py's RESP3 HELLO against an auth-enabled server without creds.
    "must be called with the client already authenticated",
)

BUS_AUTH_RETRY_DELAY_S = 30.0
BUS_TRANSIENT_RETRY_DELAY_S = 2.0


def is_bus_auth_error(exc: BaseException) -> bool:
    """True when ``exc`` (or its cause/context chain) is a Redis AUTH failure."""
    parts, cur, seen = [], exc, 0
    while cur is not None and seen < 4:
        parts.append(str(cur))
        cur = cur.__cause__ or cur.__context__
        seen += 1
    text = " | ".join(parts).lower()
    return any(m in text for m in _BUS_AUTH_MARKERS)


def bus_error_retry_delay(
    exc: BaseException, log: logging.Logger, *, what: str,
) -> float:
    """Log a consumer-loop error actionably and return the retry delay.

    Shared by the three XREADGROUP loops (aggregation dispatcher, insights
    worker, state-sync listener) so an auth misconfiguration surfaces the
    same way everywhere instead of three generic retry lines.
    """
    if is_bus_auth_error(exc):
        log.error(
            "%s rejected by bus Redis AUTHENTICATION (%s) — check "
            "REDIS_STREAMS_PASSWORD / the ACL user; retrying in %.0fs.",
            what, exc, BUS_AUTH_RETRY_DELAY_S,
        )
        return BUS_AUTH_RETRY_DELAY_S
    log.warning(
        "%s failed: %s (retrying in %.0fs)",
        what, exc, BUS_TRANSIENT_RETRY_DELAY_S,
    )
    return BUS_TRANSIENT_RETRY_DELAY_S


def stream_block_ms(requested_ms: int = 5000) -> int:
    """Blocking-read window (XREAD/XREADGROUP ``block=``) that fits inside the
    resolved STREAMS ``socket_timeout``.

    The consumer loops historically hardcoded ``block=5000`` while
    ``REDIS_STREAMS_SOCKET_TIMEOUT`` is operator-tunable. A socket timeout at
    or below the block window makes EVERY quiet blocking read raise
    ``TimeoutError`` before the server can answer — the loops then spin
    through spurious "transient error" retries instead of blocking
    efficiently. Clamp the window to one second inside the socket timeout
    (floor 1s) and say so once, so a tightened socket timeout degrades to a
    shorter block instead of a spurious-error loop.
    """
    try:
        cfg = resolve_redis_config(RedisRole.STREAMS)
        socket_timeout = cfg.socket_timeout
    except RedisConfigurationError:
        return requested_ms
    if not socket_timeout:                      # None/0 → no socket deadline
        return requested_ms
    max_ms = int((float(socket_timeout) - 1.0) * 1000)
    if requested_ms <= max_ms:
        return requested_ms
    clamped = max(1000, max_ms)
    logging.getLogger(__name__).warning(
        "stream_block_ms: clamping blocking-read window %dms -> %dms so it "
        "fits inside REDIS_STREAMS socket_timeout=%.1fs (raise the socket "
        "timeout to block longer).",
        requested_ms, clamped, float(socket_timeout),
    )
    return clamped


def build_bus_redis(
    *,
    decode_responses: bool = True,
    max_connections: int = 20,
    socket_connect_timeout: int = 5,
    socket_timeout: int = 10,
) -> Any:
    """Build the STREAMS client for the configured topology + auth + TLS."""
    import dataclasses

    cfg = resolve_redis_config(RedisRole.STREAMS)
    # Callers pass pool sizing; env wins when it explicitly set them. Each
    # field is an INDEPENDENT provenance entry in cfg.source, so each needs
    # its own gate — a shared gate would let an operator who set only one of
    # socket_timeout/socket_connect_timeout have it silently overwritten by
    # the caller's default for the other.
    src = cfg.source
    if "max_connections" not in src:
        cfg = dataclasses.replace(cfg, max_connections=max_connections)
    if "socket_timeout" not in src:
        cfg = dataclasses.replace(cfg, socket_timeout=float(socket_timeout))
    if "socket_connect_timeout" not in src:
        cfg = dataclasses.replace(
            cfg, socket_connect_timeout=float(socket_connect_timeout),
        )
    return build_redis_client(cfg, decode_responses=decode_responses)
