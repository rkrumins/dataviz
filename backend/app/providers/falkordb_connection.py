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
import asyncio
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Callable, List, Optional, Tuple

from backend.app.config import resilience as _resilience
from backend.common.adapters.redis_tls import (
    TLSSettings,
    tls_client_kwargs,
    tls_pool_kwargs,
)
from backend.common.interfaces.provider import ProviderConfigurationError

logger = logging.getLogger(__name__)

VALID_MODES = ("standalone", "sentinel", "cluster")


def _as_bool(v: Any, default: bool = False) -> bool:
    if isinstance(v, bool):
        return v
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


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
    # TLS / mutual-TLS (cert inputs are file PATHS → non-secret, ride config/env).
    tls_enabled: bool = False
    tls_ca_certs: Optional[str] = None
    tls_certfile: Optional[str] = None
    tls_keyfile: Optional[str] = None
    tls_cert_reqs: str = "required"
    tls_check_hostname: bool = True

    def tls_settings(self) -> TLSSettings:
        """The normalized TLS settings, shared with the cache + bus builders."""
        return TLSSettings.from_fields(
            enabled=self.tls_enabled,
            ca_certs=self.tls_ca_certs,
            certfile=self.tls_certfile,
            keyfile=self.tls_keyfile,
            cert_reqs=self.tls_cert_reqs,
            check_hostname=self.tls_check_hostname,
        )

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
    tls_enabled: bool = False,
) -> FalkorDBConnConfig:
    """Resolve a ``FalkorDBConnConfig`` from explicit provider config and
    env-var fallbacks. An absent/unknown mode resolves to ``standalone`` so
    the default path is byte-for-byte the legacy single-host behavior.

    ``tls_enabled`` is the provider record's connection-level TLS flag; the
    finer-grained ``falkordbConnection.tls`` object (CA / client cert / key /
    verify mode) layers on top, with ``FALKORDB_TLS_*`` env fallbacks.
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
    tls = cfg.get("tls") or {}
    # TLS is on when the connection-level flag is set, the tls.enabled key is
    # set, or FALKORDB_TLS_ENABLED is truthy.
    tls_on = (
        bool(tls_enabled)
        or _as_bool(tls.get("enabled"), False)
        or _as_bool(os.getenv("FALKORDB_TLS_ENABLED"), False)
    )
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
        tls_enabled=tls_on,
        tls_ca_certs=(tls.get("caCertPath") or os.getenv("FALKORDB_TLS_CA_CERTS")),
        tls_certfile=(tls.get("certPath") or os.getenv("FALKORDB_TLS_CERTFILE")),
        tls_keyfile=(tls.get("keyPath") or os.getenv("FALKORDB_TLS_KEYFILE")),
        tls_cert_reqs=(
            tls.get("verifyMode") or os.getenv("FALKORDB_TLS_CERT_REQS") or "required"
        ),
        tls_check_hostname=_as_bool(
            tls.get("checkHostname", os.getenv("FALKORDB_TLS_CHECK_HOSTNAME", True)),
            True,
        ),
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


def resilient_pool_kwargs(*, socket_timeout: Optional[float] = None) -> dict:
    """Socket-hygiene kwargs every raw FalkorDB/Redis ``ConnectionPool`` must
    carry. ``socket_timeout`` is a HANG NET for black-holed sockets (a GKE
    node rotation leaves established connections pointing at a dead pod —
    the kernel can retransmit for 15+ minutes), not the query budget:
    server-side ``timeout`` / caller ``asyncio.wait_for`` own that.
    ``health_check_interval`` makes redis-py PING a pooled connection that
    sat idle longer than the interval before reuse, so stale sockets are
    replaced transparently instead of each costing one failed operation.
    (A PING against a LOADING server raises BusyLoadingError, which the
    provider path already classifies as retryable ProviderLoading.)
    No ``socket_keepalive_options`` — TCP_KEEPIDLE etc. aren't portable to
    macOS dev; kernel-default keepalive timers are fine as a last resort.

    All values are env-tunable with documented defaults — see the
    "FalkorDB socket hygiene" section of ``backend/app/config/resilience.py``
    (``FALKORDB_SOCKET_CONNECT_TIMEOUT`` / ``FALKORDB_SOCKET_TIMEOUT`` /
    ``FALKORDB_SOCKET_KEEPALIVE`` / ``FALKORDB_HEALTH_CHECK_INTERVAL``)."""
    if socket_timeout is None:
        socket_timeout = _resilience.FALKORDB_SOCKET_TIMEOUT_SECS
    return {
        "socket_connect_timeout": _resilience.FALKORDB_SOCKET_CONNECT_TIMEOUT_SECS,
        "socket_timeout": socket_timeout,
        "socket_keepalive": _resilience.FALKORDB_SOCKET_KEEPALIVE,
        "health_check_interval": _resilience.FALKORDB_HEALTH_CHECK_INTERVAL_SECS,
    }


def projection_socket_timeout() -> float:
    """Hang net for projection-capable pools (graph registry / env graph
    factory): must exceed the largest server-side write budget or long
    batched merges get killed client-side mid-write. Derived from the same
    env var the projector's write budget uses (``PROJECTION_FALKOR_WRITE_
    TIMEOUT_S``, default 60) so the two can't drift, plus a margin
    (``PROJECTION_SOCKET_TIMEOUT_MARGIN_S``, default 15 — documented in
    ``backend/app/config/resilience.py``)."""
    write_budget = float(os.getenv("PROJECTION_FALKOR_WRITE_TIMEOUT_S", "60"))
    return write_budget + _resilience.PROJECTION_SOCKET_TIMEOUT_MARGIN_SECS


def _conn_auth_kwargs(cfg: FalkorDBConnConfig, socket_timeout: float) -> dict:
    """Connection kwargs shared by the high-level Sentinel/Cluster clients —
    auth + timeouts + TLS (``ssl=True`` + cert paths when enabled)."""
    kw: dict = {
        "socket_connect_timeout": _resilience.FALKORDB_SOCKET_CONNECT_TIMEOUT_SECS,
        "socket_timeout": socket_timeout,
        "decode_responses": True,
    }
    if cfg.username:
        kw["username"] = cfg.username
    if cfg.password:
        kw["password"] = cfg.password
    kw.update(tls_client_kwargs(cfg.tls_settings()))
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
    # Raw ConnectionPool needs connection_class=SSLConnection + ssl_* kwargs
    # (it does NOT accept ssl=True); empty when TLS is disabled.
    _tls_pool = tls_pool_kwargs(cfg.tls_settings())

    if cfg.mode == "standalone":
        pool = ConnectionPool(host=cfg.host, port=cfg.port, **pool_kwargs, **_tls_pool)
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
        node_kwargs = {**pool_kwargs, **_tls_pool}
        pool = ConnectionPool(host=host, port=port, **node_kwargs)
        logger.info(
            "falkordb_connection: cluster graph %r routed to owning node %s:%d%s",
            graph_name, host, port,
            " (TLS)" if _tls_pool else "",
        )
        return FalkorDB(connection_pool=pool), pool

    raise ProviderConfigurationError(f"Unsupported FalkorDB mode: {cfg.mode!r}")


def build_cache_client(
    cfg: FalkorDBConnConfig, *, cache_url: Optional[str], pool_kwargs: dict,
) -> Optional[Any]:
    """Build the provider's cache Redis on a DEDICATED endpoint — or nothing.

    Only a dedicated ``cache_url`` produces a client:

    * ``cache_url`` set → a client on that dedicated Redis, with its own
      host / auth / scheme. A ``rediss://`` URL also picks up the connection's
      custom CA / client cert / verify mode (shared-PKI assumption) so
      mutual-TLS caches work, not just system-trust ``rediss://``.
    * ``cache_url`` unset → ``None`` (cache DISABLED). WS2.1: the provider's
      cache is NEVER co-located on the FalkorDB instance. FalkorDB hosts the
      graph and nothing else, so a graph outage cannot also wipe the cache or
      let cache traffic contend with graph queries on FalkorDB's single-
      threaded process. Decoupling is structural here, not conventional;
      deployed roles additionally fail fast at startup when no dedicated cache
      is configured (see ``ProviderManager``).
    """
    from redis.asyncio import Redis

    socket_timeout = float(pool_kwargs.get("socket_timeout", 10.0))

    if not cache_url:
        # No dedicated endpoint → cache off. Do NOT mirror the FalkorDB
        # topology — that is exactly the coupling this decoupling removes.
        return None

    extra: dict = {}
    if cache_url.lower().startswith("rediss://"):
        # rediss:// already implies ssl=True (from_url sets SSLConnection);
        # add only the cert/verify kwargs so custom CA / mTLS apply.
        extra = tls_client_kwargs(cfg.tls_settings())
        extra.pop("ssl", None)
    return Redis.from_url(
        cache_url,
        max_connections=pool_kwargs.get("max_connections"),
        socket_connect_timeout=2.0,
        socket_timeout=socket_timeout,
        decode_responses=True,
        **extra,
    )


def build_cache_redis_fallback(
    cfg: FalkorDBConnConfig, *, pool_kwargs: dict,
) -> Optional[Any]:
    """:func:`build_cache_client` with no dedicated URL. Always ``None`` now:
    the provider cache is never co-located on FalkorDB (WS2.1 decoupling)."""
    return build_cache_client(cfg, cache_url=None, pool_kwargs=pool_kwargs)


# ============================================================================
# Topology-aware graph clients (shared by EVERY FalkorDB consumer)
# ============================================================================
#
# ``build_graph_client`` above knows how to reach a standalone host, follow a
# Sentinel master, or pin a graph to its owning Cluster node — but only the
# read path (``ProviderManager`` → ``FalkorDBProvider``) used to go through it.
# The versioning registry / projector / worker factories each hand-rolled a
# plain ``ConnectionPool(host, port)``, i.e. they ALWAYS spoke standalone. On a
# Sentinel instance they pinned whatever node was master at boot (a failover
# then wrote to a replica → errors), and on a Cluster instance they could only
# reach graphs whose slots happened to live on that one seed node.
#
# Everything below is the single, shared way to obtain a graph handle for ANY
# instance, in ANY topology. The instance's OWN configuration decides the
# topology, so one deployment can host a standalone, a Sentinel, and a Cluster
# provider side by side and every service reaches each of them correctly.


def build_graph_pool_kwargs(
    cfg: FalkorDBConnConfig,
    *,
    socket_timeout: float,
    max_connections: Optional[int] = None,
) -> dict:
    """Pool kwargs for a topology-aware graph client: sizing + auth + socket
    hygiene. TLS is applied inside ``build_graph_client`` (raw pools need
    ``connection_class=SSLConnection``, which the high-level clients reject).

    Deliberately NOT ``decode_responses`` — the registry/projection callers
    have always run bytes-mode and decode at their own boundaries.
    """
    kw: dict = {
        "max_connections": (
            max_connections
            or cfg.graph_pool_size
            or int(os.getenv("FALKORDB_POOL_SIZE", "10"))
        ),
        **resilient_pool_kwargs(socket_timeout=socket_timeout),
    }
    if cfg.username:
        kw["username"] = cfg.username
    if cfg.password:
        kw["password"] = cfg.password
    return kw


def env_conn_config() -> FalkorDBConnConfig:
    """Connection config for the ENV-configured default instance.

    Resolves ``FALKORDB_MODE`` / ``FALKORDB_SENTINEL_*`` / ``FALKORDB_CLUSTER_NODES``
    exactly like a provider row would — so the env-default (unrouted) graphs a
    deployment still has are reached over the right topology instead of being
    hard-wired to standalone. The env instance carries no credentials (there are
    no ``FALKORDB_USERNAME`` / ``_PASSWORD`` vars anywhere in the stack); an
    authenticated instance must be registered as a provider row.
    """
    return load_connection_config(
        None,
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        username=None,
        password=None,
    )


def _is_retryable_client_error(exc: BaseException) -> bool:
    """Connection drop / cluster redirect / nulled handle — i.e. 'the client we
    cached is stale', not 'the query is wrong'. Reuses the read path's
    classifiers verbatim so both paths agree on what is retryable (imported
    lazily: ``falkordb_provider`` imports this module)."""
    try:
        from backend.app.providers.falkordb_provider import (
            _is_cluster_routing_error,
            _is_null_handle_error,
            _is_transient_connection_error,
        )
    except Exception:                            # pragma: no cover - defensive
        return False
    return (
        _is_transient_connection_error(exc)
        or _is_cluster_routing_error(exc)
        or _is_null_handle_error(exc)
    )


def _decode_key(k: Any) -> str:
    return k.decode() if isinstance(k, bytes) else k


class ResilientGraph:
    """A graph handle that re-resolves its client once on a stale-client error.

    The registry/projector paths have no ``ProviderManager`` breaker and no
    ``_run_guarded``: a cached handle pinned to a rotated Cluster node (or a
    failed-over Sentinel master, or a dropped socket) would otherwise fail for
    the process lifetime. On a connection/redirect error this drops the cached
    client — forcing a fresh topology resolve, which finds the promoted replica
    or new owner — and retries the call ONCE. Query errors (bad Cypher) and
    everything else propagate untouched.

    Reads are idempotent; a retried projector write re-applies at most one
    chunk via ``MERGE``, which is the same bounded, self-healing property
    ``_run_guarded`` relies on.
    """

    def __init__(self, clients: "TopologyGraphClients", cfg: FalkorDBConnConfig,
                 name: str, graph: Any):
        self._clients = clients
        self._cfg = cfg
        self._name = name
        self._graph = graph

    async def query(self, *args, **kwargs):
        return await self._call("query", *args, **kwargs)

    async def ro_query(self, *args, **kwargs):
        return await self._call("ro_query", *args, **kwargs)

    async def delete(self, *args, **kwargs):
        return await self._call("delete", *args, **kwargs)

    async def _call(self, method: str, *args, **kwargs):
        try:
            return await getattr(self._graph, method)(*args, **kwargs)
        except Exception as exc:
            if not _is_retryable_client_error(exc):
                raise
            logger.warning(
                "falkordb graph %r: %s during %s on %s — re-resolving the client "
                "and retrying once.",
                self._name, type(exc).__name__, method, self._cfg.describe(),
            )
            await self._clients.invalidate(self._cfg, self._name)
            self._graph = await self._clients.resolve_graph(self._cfg, self._name)
            return await getattr(self._graph, method)(*args, **kwargs)

    def __getattr__(self, item):
        # Anything not wrapped above (e.g. ``.name``) delegates unchanged.
        return getattr(self._graph, item)


class TopologyGraphClients:
    """Process-wide cache of FalkorDB clients, keyed by connection identity.

    Cache key = the instance's connection identity + (in CLUSTER mode only) the
    graph name: a graph key lives entirely on one cluster node, so its client is
    pinned to that node, while standalone/Sentinel instances share one client
    per instance. ``invalidate`` drops a client so the next call re-resolves —
    the hook a rotated cluster node or a Sentinel failover needs.
    """

    def __init__(self, *, socket_timeout: Optional[float] = None):
        self._clients: dict = {}     # key -> (FalkorDB, pool)
        self._locks: dict = {}       # key -> asyncio.Lock (per-key: a slow
                                     # cluster discovery must not block others)
        self._socket_timeout = socket_timeout

    @staticmethod
    def cache_key(cfg: FalkorDBConnConfig, graph_name: str) -> tuple:
        identity = (
            cfg.mode, cfg.host, cfg.port, cfg.username,
            cfg.sentinel_master,
            tuple(cfg.sentinel_nodes), tuple(cfg.cluster_nodes),
            cfg.tls_enabled,
        )
        return (identity, graph_name if cfg.mode == "cluster" else None)

    def _pool_kwargs(self, cfg: FalkorDBConnConfig) -> dict:
        # The socket timeout here is a HANG NET for these long-lived pools
        # (projector writes run to PROJECTION_FALKOR_WRITE_TIMEOUT_S), never the
        # query budget — callers keep their own asyncio.wait_for. A provider row
        # asking for a LONGER timeout is honored; a shorter one must not clip a
        # legitimate projection write.
        st = self._socket_timeout or projection_socket_timeout()
        if cfg.socket_timeout:
            st = max(st, float(cfg.socket_timeout))
        return build_graph_pool_kwargs(cfg, socket_timeout=st)

    async def _client_for(self, cfg: FalkorDBConnConfig, graph_name: str):
        key = self.cache_key(cfg, graph_name)
        entry = self._clients.get(key)
        if entry is not None:
            return entry[0]
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            entry = self._clients.get(key)          # another task may have built it
            if entry is None:
                db, pool = await build_graph_client(
                    cfg, graph_name=graph_name, pool_kwargs=self._pool_kwargs(cfg),
                )
                self._clients[key] = entry = (db, pool)
                logger.info(
                    "falkordb: built graph client for %s (graph=%r)",
                    cfg.describe(), graph_name,
                )
        return entry[0]

    async def resolve_graph(self, cfg: FalkorDBConnConfig, graph_name: str):
        """The raw ``falkordb`` graph object (no resilience wrapper)."""
        db = await self._client_for(cfg, graph_name)
        return db.select_graph(graph_name)

    async def get_graph(self, cfg: FalkorDBConnConfig, graph_name: str) -> ResilientGraph:
        """The graph handle every consumer should use: correct for the
        instance's topology, and self-healing across a node rotation."""
        return ResilientGraph(
            self, cfg, graph_name, await self.resolve_graph(cfg, graph_name),
        )

    async def invalidate(self, cfg: FalkorDBConnConfig, graph_name: str) -> None:
        key = self.cache_key(cfg, graph_name)
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            entry = self._clients.pop(key, None)
        if entry is not None:
            try:
                await entry[1].aclose()
            except Exception:                        # pragma: no cover - best effort
                pass

    async def aclose(self) -> None:
        entries, self._clients = list(self._clients.values()), {}
        for _db, pool in entries:
            try:
                await pool.aclose()
            except Exception:                        # pragma: no cover - best effort
                pass


# One cache per process: the registry factory, the env factory, the projector
# and the versioning read path all share these pools.
_GRAPH_CLIENTS = TopologyGraphClients()


def graph_clients() -> TopologyGraphClients:
    return _GRAPH_CLIENTS


def make_env_graph_factory() -> Callable[..., Any]:
    """``(name, provider_id=None) -> awaitable[graph]`` for the ENV-configured
    default instance, over whatever topology ``FALKORDB_MODE`` selects.

    ``provider_id`` is accepted (the factory contract) but ignored — every graph
    lands on the env instance. For per-provider routing use
    ``falkor_graph_registry.make_registry_graph_factory``.
    """
    async def graph(name: str, provider_id: Optional[str] = None):
        # graph_clients() is resolved per call (not captured) so the cache is a
        # single, patchable seam for every consumer.
        return await graph_clients().get_graph(env_conn_config(), name)

    return graph


async def cluster_primary_nodes(
    cfg: FalkorDBConnConfig, socket_timeout: float,
) -> List[Tuple[str, int]]:
    """Every primary in the cluster (the nodes that own slots)."""
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
        if hasattr(cluster, "initialize"):
            await cluster.initialize()
        return [(n.host, int(n.port)) for n in cluster.get_primaries()]
    finally:
        try:
            await cluster.aclose()
        except Exception:                            # pragma: no cover - best effort
            try:
                await cluster.close()
            except Exception:
                pass


async def list_graph_keys_for_config(
    cfg: FalkorDBConnConfig, *, socket_timeout: Optional[float] = None,
) -> set:
    """``GRAPH.LIST`` for a whole instance, topology-aware.

    CLUSTER is the reason this exists: a node only holds the graph keys whose
    slots it owns, so a single-node ``GRAPH.LIST`` silently UNDER-reports — and
    callers use this to decide whether a graph name is free. Fan out over every
    primary and union. Standalone/Sentinel list from the (current) master.
    """
    from falkordb.asyncio import FalkorDB
    from redis.asyncio import ConnectionPool

    st = socket_timeout or float(_resilience.FALKORDB_SOCKET_TIMEOUT_SECS)
    pool_kwargs = build_graph_pool_kwargs(cfg, socket_timeout=st, max_connections=2)

    if cfg.mode == "cluster":
        keys: set = set()
        tls = tls_pool_kwargs(cfg.tls_settings())
        for host, port in await cluster_primary_nodes(cfg, st):
            pool = ConnectionPool(host=host, port=port, **pool_kwargs, **tls)
            try:
                db = FalkorDB(connection_pool=pool)
                keys |= {_decode_key(k) for k in await db.list_graphs()}
            finally:
                try:
                    await pool.aclose()
                except Exception:                    # pragma: no cover - best effort
                    pass
        return keys

    db, pool = await build_graph_client(cfg, graph_name="", pool_kwargs=pool_kwargs)
    try:
        return {_decode_key(k) for k in await db.list_graphs()}
    finally:
        try:
            await pool.aclose()
        except Exception:                            # pragma: no cover - best effort
            pass
