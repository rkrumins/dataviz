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

from typing import Any

from backend.common.adapters.redis_endpoint import (
    RedisConfigurationError,
    RedisRole,
    build_redis_client,
    resolve_redis_config,
)

# Historical name — imported by tests and callers.
BusConfigurationError = RedisConfigurationError


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
