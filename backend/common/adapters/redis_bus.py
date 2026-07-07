"""Topology + TLS aware Redis client for the aggregation/insights message bus.

The bus — job stream + consumer groups, single-active exec locks, cancel
pub/sub, the admission token-bucket, and SSE progress — is a *coordination*
workload, not a sharded-data one. Every operation is single-key, so it runs
cleanly on a single node or a Sentinel-managed master (with auto-failover).

**Redis Cluster is intentionally NOT supported for the bus**: it would add
cross-slot/broadcast complexity with zero sharding benefit. If a cluster is
configured for the bus we fail fast with a clear error telling the operator to
use a single node or Sentinel. (The FalkorDB graph and its cache DO support
Cluster — that's a different role.)

Config (env):
    REDIS_URL                single-node URL (default redis://localhost:6380/0)
    REDIS_SENTINEL_MASTER    enable Sentinel; the monitored master name
    REDIS_SENTINEL_NODES     "h1:26379,h2:26379" sentinel addresses
    REDIS_USERNAME           auth username (esp. Sentinel, which has no URL)
    REDIS_PASSWORD           auth password
    REDIS_TLS_ENABLED        "true" → TLS for the bus
    REDIS_TLS_CA_CERTS       custom CA bundle path
    REDIS_TLS_CERTFILE       client cert path (mTLS)
    REDIS_TLS_KEYFILE        client key path (mTLS)
    REDIS_TLS_CERT_REQS      required | optional | none
    REDIS_TLS_CHECK_HOSTNAME "true"/"false"
    REDIS_CLUSTER_NODES      if set → explicit error (cluster unsupported here)
"""
from __future__ import annotations

import logging
import os
from typing import List, Optional, Tuple

import redis.asyncio as aioredis

from backend.common.adapters.redis_tls import TLSSettings, tls_client_kwargs

logger = logging.getLogger(__name__)


class BusConfigurationError(RuntimeError):
    """Raised when the bus Redis is mis-configured (e.g. Cluster requested)."""


def _as_bool(v, default: bool = False) -> bool:
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def _parse_nodes(raw: Optional[str]) -> List[Tuple[str, int]]:
    """Parse "h1:26379,h2:26379" → [(host, port), ...]."""
    out: List[Tuple[str, int]] = []
    for chunk in (raw or "").split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        host, _, port = chunk.rpartition(":")
        if not host:
            logger.warning("redis_bus: ignoring node %r (no host:port)", chunk)
            continue
        try:
            out.append((host, int(port)))
        except ValueError:
            logger.warning("redis_bus: ignoring node %r (bad port)", chunk)
    return out


def _tls_from_env() -> TLSSettings:
    return TLSSettings.from_fields(
        enabled=_as_bool(os.getenv("REDIS_TLS_ENABLED"), False),
        ca_certs=os.getenv("REDIS_TLS_CA_CERTS"),
        certfile=os.getenv("REDIS_TLS_CERTFILE"),
        keyfile=os.getenv("REDIS_TLS_KEYFILE"),
        cert_reqs=os.getenv("REDIS_TLS_CERT_REQS"),
        check_hostname=_as_bool(os.getenv("REDIS_TLS_CHECK_HOSTNAME", "true"), True),
    )


def _redact(url: str) -> str:
    """Hide any password in a URL for logging."""
    if "@" not in url:
        return url
    scheme, _, rest = url.partition("://")
    creds, _, host = rest.rpartition("@")
    if ":" in creds:
        user = creds.split(":", 1)[0]
        creds = f"{user}:***"
    return f"{scheme}://{creds}@{host}"


def build_bus_redis(
    *,
    decode_responses: bool = True,
    max_connections: int = 20,
    socket_connect_timeout: int = 5,
    socket_timeout: int = 10,
) -> aioredis.Redis:
    """Build the bus Redis client for the configured topology + TLS.

    Returns a ``redis.asyncio.Redis`` (single node) or a Sentinel-managed
    master client whose pool transparently follows failover. Raises
    :class:`BusConfigurationError` if Cluster is configured for the bus.
    """
    if os.getenv("REDIS_CLUSTER_NODES"):
        raise BusConfigurationError(
            "Redis Cluster is not supported for the aggregation/insights bus "
            "(coordination workload). Use a single node (REDIS_URL) or Sentinel "
            "(REDIS_SENTINEL_MASTER + REDIS_SENTINEL_NODES)."
        )

    tls = _tls_from_env()
    username = os.getenv("REDIS_USERNAME")
    password = os.getenv("REDIS_PASSWORD")
    common = dict(
        decode_responses=decode_responses,
        socket_connect_timeout=socket_connect_timeout,
        socket_timeout=socket_timeout,
    )

    master = os.getenv("REDIS_SENTINEL_MASTER")
    nodes = _parse_nodes(os.getenv("REDIS_SENTINEL_NODES"))
    if master and nodes:
        from redis.asyncio.sentinel import Sentinel

        conn = {**common, **tls_client_kwargs(tls)}
        if username:
            conn["username"] = username
        if password:
            conn["password"] = password
        sentinel = Sentinel(nodes, sentinel_kwargs=conn, **conn)
        client = sentinel.master_for(master, max_connections=max_connections, **conn)
        logger.info(
            "Bus Redis via Sentinel(master=%s, nodes=%d)%s",
            master, len(nodes), " TLS" if tls.enabled else "",
        )
        return client

    url = os.getenv("REDIS_URL", "redis://localhost:6380/0")
    extra: dict = {}
    if tls.enabled:
        # rediss:// makes from_url build an SSLConnection; add only the
        # cert/verify kwargs (custom CA / mTLS) on top.
        if url.lower().startswith("redis://"):
            url = "rediss://" + url[len("redis://"):]
        extra = tls_client_kwargs(tls)
        extra.pop("ssl", None)
    if username:
        extra["username"] = username
    if password:
        extra["password"] = password
    client = aioredis.from_url(
        url, max_connections=max_connections, retry_on_timeout=True,
        **common, **extra,
    )
    logger.info(
        "Bus Redis via single node %s%s",
        _redact(url), " TLS" if tls.enabled else "",
    )
    return client
