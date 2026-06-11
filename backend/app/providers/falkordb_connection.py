"""FalkorDB connection factory — standalone / Sentinel / Cluster.

A single FalkorDB graph key lives entirely on ONE Redis node, so Redis
Cluster does NOT shard a single graph. This factory therefore routes the
FalkorDB client to the *one* node that owns the graph key (Cluster),
follows the master on failover (Sentinel), or connects directly
(standalone) — selected by operator config, behaving correctly in each.

The ``falkordb.asyncio.FalkorDB`` client only accepts ``connection_pool=``,
so Sentinel and Cluster are wired via the adapter approach: resolve the
right node/master, hand ``FalkorDB`` an ordinary single-node
``ConnectionPool``, and rebuild that pool on failover / MOVED (see
``FalkorDBProvider._rebuild_graph_client_for_failover``).

Config rides the provider record's ``extra_config`` JSON (no migration):

    "falkordbConnection": {
      "mode": "standalone|sentinel|cluster",
      "sentinel": {"masterName": "mymaster", "nodes": [["h1", 26379]]},
      "cluster":  {"startupNodes": [["h1", 6379], ["h2", 6379]]}
    }

Env-var fallbacks (when the JSON is absent): ``FALKORDB_MODE``,
``FALKORDB_SENTINEL_MASTER``, ``FALKORDB_SENTINEL_NODES``,
``FALKORDB_CLUSTER_NODES`` (the *_NODES vars accept "h1:port,h2:port").
"""
import logging
import os
from dataclasses import dataclass, field
from typing import Any, List, Optional, Tuple

from backend.common.interfaces.provider import ProviderConfigurationError

logger = logging.getLogger(__name__)

VALID_MODES = ("standalone", "sentinel", "cluster")


@dataclass
class FalkorDBConnConfig:
    """Normalized connection settings resolved from explicit config + env."""

    mode: str = "standalone"
    host: str = "localhost"
    port: int = 6379
    username: Optional[str] = None
    password: Optional[str] = None
    sentinel_master: Optional[str] = None
    sentinel_nodes: List[Tuple[str, int]] = field(default_factory=list)
    cluster_nodes: List[Tuple[str, int]] = field(default_factory=list)
    # Per-provider advanced knobs (None → fall back to env defaults at the
    # call site). socket_timeout bounds a single Cypher query; graph_pool_size
    # is the max graph-query connection pool size.
    socket_timeout: Optional[float] = None
    graph_pool_size: Optional[int] = None

    def describe(self) -> str:
        if self.mode == "sentinel":
            return (
                f"sentinel(master={self.sentinel_master!r}, "
                f"nodes={len(self.sentinel_nodes)})"
            )
        if self.mode == "cluster":
            return f"cluster(startup_nodes={len(self.cluster_nodes)})"
        return f"standalone({self.host}:{self.port})"


def _parse_nodes(raw: Any) -> List[Tuple[str, int]]:
    """Parse a node list from several shapes into ``[(host, port), ...]``.

    Accepts:
      - ``"h1:26379,h2:26379"``                 (env-var CSV string)
      - ``[["h1", 26379], ["h2", 26379]]``      (JSON array of pairs)
      - ``[{"host": "h1", "port": 26379}, ...]`` (JSON array of objects)
    Unparseable entries are skipped with a warning.
    """
    if not raw:
        return []
    out: List[Tuple[str, int]] = []
    if isinstance(raw, str):
        for chunk in raw.split(","):
            chunk = chunk.strip()
            if not chunk:
                continue
            host, _, port = chunk.rpartition(":")
            if not host:
                logger.warning("falkordb_connection: ignoring node %r (no host:port)", chunk)
                continue
            try:
                out.append((host, int(port)))
            except ValueError:
                logger.warning("falkordb_connection: ignoring node %r (bad port)", chunk)
        return out
    for entry in raw:
        try:
            if isinstance(entry, dict):
                host = entry.get("host")
                port = int(entry.get("port"))
            else:  # pair/list/tuple
                host, port = entry[0], int(entry[1])
            if host:
                out.append((str(host), port))
        except (ValueError, TypeError, IndexError, KeyError):
            logger.warning("falkordb_connection: ignoring malformed node entry %r", entry)
    return out


def load_connection_config(
    explicit: Optional[dict],
    *,
    host: str,
    port: int,
    username: Optional[str],
    password: Optional[str],
) -> FalkorDBConnConfig:
    """Resolve a ``FalkorDBConnConfig`` from explicit provider config and
    env-var fallbacks. An absent/unknown mode resolves to ``standalone`` so
    the default path is byte-for-byte the legacy single-host behavior.
    """
    cfg = dict(explicit or {})
    mode = (cfg.get("mode") or os.getenv("FALKORDB_MODE") or "standalone").strip().lower()
    if mode not in VALID_MODES:
        logger.warning(
            "falkordb_connection: unknown mode %r — falling back to standalone.", mode,
        )
        mode = "standalone"

    sentinel = cfg.get("sentinel") or {}
    cluster = cfg.get("cluster") or {}
    return FalkorDBConnConfig(
        mode=mode,
        host=host,
        port=port,
        username=username,
        password=password,
        sentinel_master=(
            sentinel.get("masterName") or os.getenv("FALKORDB_SENTINEL_MASTER")
        ),
        sentinel_nodes=_parse_nodes(
            sentinel.get("nodes") or os.getenv("FALKORDB_SENTINEL_NODES")
        ),
        cluster_nodes=_parse_nodes(
            cluster.get("startupNodes") or os.getenv("FALKORDB_CLUSTER_NODES")
        ),
        socket_timeout=_coerce_float(cfg.get("socketTimeout")),
        graph_pool_size=_coerce_int(cfg.get("graphPoolSize")),
    )


def _coerce_float(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        logger.warning("falkordb_connection: ignoring non-numeric socketTimeout %r", v)
        return None


def _coerce_int(v: Any) -> Optional[int]:
    if v is None or v == "":
        return None
    try:
        return int(v)
    except (ValueError, TypeError):
        logger.warning("falkordb_connection: ignoring non-integer graphPoolSize %r", v)
        return None


def _conn_auth_kwargs(cfg: FalkorDBConnConfig, socket_timeout: float) -> dict:
    """Connection kwargs shared by Sentinel/Cluster master+node clients."""
    kw: dict = {
        "socket_connect_timeout": 2.0,
        "socket_timeout": socket_timeout,
        "decode_responses": True,
    }
    if cfg.username:
        kw["username"] = cfg.username
    if cfg.password:
        kw["password"] = cfg.password
    return kw


async def resolve_cluster_node_for_key(
    cfg: FalkorDBConnConfig, graph_name: str, socket_timeout: float,
) -> Tuple[str, int]:
    """Resolve the (host, port) of the cluster node owning ``graph_name``.

    All of a graph's keys hash to the slot of the graph key, so one node
    owns the whole graph. A short-lived ``RedisCluster`` discovers the slot
    map, then we keep only the owning node and route the FalkorDB client
    there via a normal single-node pool.
    """
    from redis.asyncio.cluster import RedisCluster
    from redis.cluster import ClusterNode

    nodes = [ClusterNode(h, p) for h, p in cfg.cluster_nodes]
    if not nodes:
        raise ProviderConfigurationError(
            "FalkorDB cluster mode requires cluster.startupNodes (or "
            "FALKORDB_CLUSTER_NODES)."
        )
    cluster = RedisCluster(startup_nodes=nodes, **_conn_auth_kwargs(cfg, socket_timeout))
    try:
        # redis.asyncio.cluster initializes lazily; force it so the slot
        # map is populated before we look up the owning node.
        if hasattr(cluster, "initialize"):
            await cluster.initialize()
        slot = cluster.keyslot(graph_name)
        node = cluster.nodes_manager.get_node_from_slot(slot)
        return node.host, int(node.port)
    finally:
        try:
            await cluster.aclose()
        except Exception:
            try:
                await cluster.close()
            except Exception:
                pass


async def build_graph_client(
    cfg: FalkorDBConnConfig,
    *,
    graph_name: str,
    pool_kwargs: dict,
) -> Tuple[Any, Any]:
    """Build the FalkorDB graph client for the configured topology.

    Returns ``(falkordb_client, underlying_connection_pool)``. The pool is
    a plain single-node ``redis.asyncio.ConnectionPool`` in every mode (the
    Sentinel/Cluster routing is resolved up-front), so the caller's pool
    lifecycle and ``FalkorDB(connection_pool=...)`` construction are
    identical across modes.
    """
    from falkordb.asyncio import FalkorDB
    from redis.asyncio import ConnectionPool

    socket_timeout = float(pool_kwargs.get("socket_timeout", 10.0))

    if cfg.mode == "standalone":
        pool = ConnectionPool(host=cfg.host, port=cfg.port, **pool_kwargs)
        return FalkorDB(connection_pool=pool), pool

    if cfg.mode == "sentinel":
        from redis.asyncio.sentinel import Sentinel

        if not cfg.sentinel_master or not cfg.sentinel_nodes:
            raise ProviderConfigurationError(
                "FalkorDB sentinel mode requires sentinel.masterName and "
                "sentinel.nodes (or FALKORDB_SENTINEL_MASTER / "
                "FALKORDB_SENTINEL_NODES)."
            )
        auth = _conn_auth_kwargs(cfg, socket_timeout)
        sentinel = Sentinel(cfg.sentinel_nodes, sentinel_kwargs=auth, **auth)
        # ``master_for`` returns a Redis bound to a pool that transparently
        # re-resolves the master on failover; hand that pool to FalkorDB.
        master = sentinel.master_for(
            cfg.sentinel_master,
            max_connections=pool_kwargs.get("max_connections"),
            **auth,
        )
        return FalkorDB(connection_pool=master.connection_pool), master.connection_pool

    if cfg.mode == "cluster":
        host, port = await resolve_cluster_node_for_key(cfg, graph_name, socket_timeout)
        node_kwargs = dict(pool_kwargs)
        pool = ConnectionPool(host=host, port=port, **node_kwargs)
        logger.info(
            "falkordb_connection: cluster graph %r routed to owning node %s:%d",
            graph_name, host, port,
        )
        return FalkorDB(connection_pool=pool), pool

    raise ProviderConfigurationError(f"Unsupported FalkorDB mode: {cfg.mode!r}")


def build_cache_redis_fallback(
    cfg: FalkorDBConnConfig, *, pool_kwargs: dict,
) -> Optional[Any]:
    """Build the *fallback* cache Redis (used only when CACHE_REDIS_URL is
    unset) for the configured topology.

    Returns a raw ``redis.asyncio.Redis`` for standalone/sentinel. Returns
    ``None`` for cluster mode — the provider's cache uses cross-slot SCAN /
    multi-key pipelines that a single-node fallback cannot serve correctly,
    so in cluster mode a dedicated ``CACHE_REDIS_URL`` is required; without
    it the provider runs in (correct) cache-disabled DEGRADED mode.
    """
    from redis.asyncio import ConnectionPool, Redis

    socket_timeout = float(pool_kwargs.get("socket_timeout", 10.0))

    if cfg.mode == "standalone":
        pool = ConnectionPool(host=cfg.host, port=cfg.port, **pool_kwargs)
        return Redis(connection_pool=pool)

    if cfg.mode == "sentinel":
        from redis.asyncio.sentinel import Sentinel

        auth = _conn_auth_kwargs(cfg, socket_timeout)
        sentinel = Sentinel(cfg.sentinel_nodes, sentinel_kwargs=auth, **auth)
        return sentinel.master_for(
            cfg.sentinel_master,
            max_connections=pool_kwargs.get("max_connections"),
            **auth,
        )

    if cfg.mode == "cluster":
        logger.warning(
            "falkordb_connection: cluster mode without CACHE_REDIS_URL — "
            "running cache-disabled (DEGRADED). Set CACHE_REDIS_URL to a "
            "dedicated Redis to enable ancestor/idempotency caching.",
        )
        return None

    return None
