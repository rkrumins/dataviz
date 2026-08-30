"""FalkorDB connection lifecycle and query chokepoints — ``ConnectionMixin``.

Carved from ``backend/app/providers/falkordb/provider.py``'s
``FalkorDBProvider`` class body as it stood before this split: ``__init__``
through ``_proj_query`` (lines 72-1338), plus ``list_graphs`` and ``close``
(lines 10496-10594, including their "ProviderRegistry lifecycle helpers"
comment header) from the end of the class — two blocks, not contiguous in
the original file.

This mixin owns the whole connection lifecycle and the five query
chokepoints the unit suite fakes by assigning over a live instance's own
methods (``_ensure_connected``, ``_ro_query``, ``_proj_ro_query``,
``_query``, ``_proj_query``, ``_run_guarded``) — see
``docs/superpowers/plans/2026-08-30-pr1-falkordb-decoupling.md`` §2.2
for why this has to be a mixin rather than a delegate/helper object.
"""
import asyncio
import functools
import os
import time
from typing import Any, Awaitable, Callable, Optional

from backend.app.providers.falkordb._log import logger
from backend.app.providers.falkordb.dialect import FALKORDB_DIALECT
from backend.app.providers.falkordb.errors import (
    _is_cluster_routing_error,
    _is_transient_connection_error,
    _is_null_handle_error,
    _is_missing_graph_error,
    _is_loading_error,
    _TRANSIENT_RETRY_BACKOFFS,
    _EmptyResult,
)
from backend.app.providers.falkordb.executor import FalkorDBExecutor
from backend.app.providers.falkordb.hosts import _normalize_falkordb_host
from backend.app.providers.falkordb.knobs import _resolve_bulk_create_knobs
from backend.common.providers.cypher.dialect import CypherDialect


class ConnectionMixin:
    """Connection lifecycle and the five query chokepoints the unit
    suite fakes by assigning over an instance's own methods."""

    def __init__(
        self,
        host: str = "localhost",
        port: int = 6379,
        graph_name: str = "nexus_lineage",
        seed_file: Optional[str] = None,
        projection_mode: str = "in_source",
        username: Optional[str] = None,
        password: Optional[str] = None,
        connection_config: Optional[dict] = None,
        cache_redis_url: Optional[str] = None,
        auth_enabled: bool = True,
        tls_enabled: bool = False,
        provider_id: Optional[str] = None,
        extra_config: Optional[dict] = None,
        credentials: Optional[dict] = None,
    ):
        # IPv6 dual-stack guard: "localhost" resolves to BOTH ::1 and
        # 127.0.0.1, and Docker commonly publishes IPv4 only, so the redis
        # ConnectionPool's ::1 attempt fails ("Connect call failed
        # ('::1', 6379)") and surfaces as a false "provider down". Pin
        # localhost to IPv4 (opt-out via FALKORDB_DISABLE_IPV4_NORMALIZE).
        # Setting self._host here covers both the connection factory pool
        # and preflight(), which read self._host.
        self._host = _normalize_falkordb_host(host)
        self._port = port
        self._graph_name = graph_name
        self._seed_file = seed_file
        self._projection_mode = projection_mode  # "in_source" or "dedicated"
        # Connection topology config (standalone / sentinel / cluster).
        # Rides the provider record's extra_config["falkordbConnection"].
        # None / absent / "standalone" → legacy single-host behavior.
        # Resolved lazily in _ensure_connected via the connection factory.
        self._connection_config = connection_config
        # Per-provider dedicated cache Redis URL (carries a possible password,
        # so it travels via the encrypted credentials blob, not extra_config).
        # Deprecated alias — folded into ``self._credentials["cache_redis_url"]``
        # below so ``build_cache_client`` resolves it the same way as a
        # provider row's own encrypted ``cache_redis_url`` credential.
        self._cache_redis_url = cache_redis_url
        # Identity + raw config for the CACHE role's central resolver
        # (``build_cache_client``): the provider's own
        # ``extra_config.cacheConnection`` (non-secret topology/TLS) and its
        # decrypted credentials (cache_username/cache_password/... plus the
        # legacy cache_redis_url alias). Never the FalkorDB graph credentials
        # — the cache resolves its own auth, never inherits the graph's.
        self._provider_id = provider_id
        self._extra_config = extra_config
        merged_credentials = dict(credentials or {})
        if cache_redis_url and "cache_redis_url" not in merged_credentials:
            merged_credentials["cache_redis_url"] = cache_redis_url
        self._credentials = merged_credentials
        self._conn_cfg = None  # populated by _ensure_connected (FalkorDBConnConfig)
        # Failover state: a monotonic generation bumped on each client
        # rebuild, plus a lock so concurrent MOVED/connection errors
        # coalesce into a single rebuild instead of a thundering herd.
        self._conn_generation = 0
        self._failover_lock = asyncio.Lock()
        self._proj_db = None   # separate client for {graph}_proj on cluster
        self._proj_pool = None
        # P1.6 — credentials previously dropped silently in
        # ProviderManager._create_provider_instance, causing NOAUTH errors
        # to be mis-classified as network failures and triggering false
        # breaker storms. They're now plumbed end-to-end:
        #   __init__ → preflight (RESP AUTH before PING)
        #            → _ensure_connected (driver auth via from_url args)
        #
        # Per-provider auth gate (extra_config.falkordbConnection.authEnabled,
        # default true). When auth is DISABLED for this provider, null the
        # FalkorDB graph credentials at this single chokepoint so NOTHING
        # downstream sends AUTH — the graph pool kwargs, preflight's AUTH-
        # before-PING, and load_connection_config() all read these fields.
        # This prevents credential leakage / NOAUTH storms against an
        # unauthenticated FalkorDB. The cache Redis resolves its OWN auth via
        # ``self._credentials`` (never these fields) and is intentionally
        # NOT gated by this flag.
        # Auth is ON unless EXPLICITLY disabled. ``authEnabled`` rides
        # extra_config.falkordbConnection.authEnabled and callers pass through
        # whatever was stored (``.get("authEnabled", True)``), so a null / 0 /
        # wrong-typed value used to be falsy here and SILENTLY NULL a saved
        # password — the "auth_required despite a saved credential" footgun the
        # operator keeps hitting after configuring auth in the UI. Only a real,
        # explicit false (bool ``False`` or "false"/"0"/"no"/"off") disables
        # auth; anything else keeps the configured credential. A configured
        # password against a genuinely UNauthenticated instance is still safe —
        # preflight treats the "no password set" reply as reachable and the
        # connect path's auth-negotiation drops the stale credential and
        # reconnects.
        auth_off = auth_enabled is False or (
            isinstance(auth_enabled, str)
            and auth_enabled.strip().lower() in ("false", "0", "no", "off")
        )
        self._auth_enabled = not auth_off
        # Normalize BEFORE storing: ""/whitespace-only creds must mean "absent"
        # here exactly as they do in load_connection_config, or preflight (which
        # reads self._username/_password directly) and the connect path would
        # disagree about whether this provider authenticates.
        from backend.app.providers.falkordb_connection import normalize_credentials
        username, password = normalize_credentials(
            username, password,
            context=f"FalkorDB provider {provider_id or f'{self._host}:{port}'}",
        )
        self._username = username if self._auth_enabled else None
        self._password = password if self._auth_enabled else None
        # Footgun guard: auth EXPLICITLY disabled while a graph password is saved
        # — the password is nulled above, so the graph connects UNAUTHENTICATED
        # and an auth-required instance (e.g. a requirepass Redis Cluster)
        # reports "auth_required". Surface it loudly.
        if auth_off and (password or (credentials or {}).get("password")):
            logger.warning(
                "FalkorDB provider %s: authentication is EXPLICITLY DISABLED "
                "(falkordbConnection.authEnabled=false) but a graph password is "
                "saved — connecting UNAUTHENTICATED. An auth-required instance will "
                "report 'auth_required'. Enable authentication for this provider, "
                "or clear the saved password.",
                provider_id or f"{self._host}:{port}",
            )
        # Connection-level TLS toggle (the provider record's tls_enabled, plus
        # the finer falkordbConnection.tls object resolved in _ensure_connected).
        # Applies to the graph (all topologies), preflight, and the cache.
        self._tls_enabled = tls_enabled
        self._graph = None
        # Per-instance connect cooldown (WS0.1). A recent connect failure
        # short-circuits repeated connect attempts within (and across) a
        # request: an unreachable / blackhole host would otherwise be
        # re-probed for EVERY one of a request's ontology-introspection +
        # read queries, each paying the full socket_connect_timeout and
        # summing to tens of seconds before the request finally 503s.
        # monotonic() deadline; 0.0 = no cooldown. The first attempt after
        # it lapses is allowed through, so recovery self-heals.
        self._connect_cooldown_until: float = 0.0
        self._connect_cooldown_s: float = float(
            os.getenv("FALKORDB_CONNECT_COOLDOWN_S", "5")
        )
        # In-flight guarded-op count. The ProviderManager's recovery eviction
        # defers close() while this is > 0 so it cannot tear the pool out from
        # under a running aggregation job (the 'NoneType has no query' race).
        self._inflight = 0
        self._proj_graph = None  # Dedicated projection graph (when mode = "dedicated")
        self._pool = None       # Graph query pool (used by FalkorDB)
        self._redis_pool = None  # Separate pool for Redis data-structure ops (caching, SADD, etc.)
        self._db = None
        # P2.3 — graceful cache-disable mode. When the cache Redis is
        # unreachable but the FalkorDB graph is fine, set this to False
        # so cache reads return None silently and cache writes are
        # dropped. Provider works DEGRADED (slower reads, no
        # materialization tracking) but does NOT fail availability —
        # mirroring Neo4j's pattern at line 271-276 of neo4j_provider.py.
        self._redis_available: bool = True
        # Application-layer concurrency cap for Cypher queries. Pool size
        # is FALKORDB_GRAPH_POOL_SIZE (default 24); we cap query-issuing
        # tasks below that so a burst of slow traces cannot exhaust the
        # pool and surface as opaque socket timeouts. The remaining pool
        # headroom is reserved for non-trace work (writes, schema
        # introspection, health checks).
        self._query_semaphore = asyncio.Semaphore(
            int(os.getenv("FALKORDB_QUERY_CONCURRENCY", "20"))
        )
        # AIMD state for aggregation MERGE sub-batch sizing. Starts at the
        # ceiling and shrinks on observed latency creep; per-instance so
        # different graphs on the same provider keep independent state
        # (each ProviderManager cache key is (provider_id, graph_name)).
        self._aggregation_sub_batch_size: int = self._MERGE_SUB_BATCH_SIZE
        self._aggregation_sub_batch_under_target_run: int = 0

        # AGGREGATED edge level-stamping state. Must live on every
        # instance from construction — ``set_entity_type_levels`` (called
        # by ContextEngine ontology resolution) reads ``_level_digest``
        # before ``ensure_indices`` has necessarily run.
        #
        # The probe runs lazily — it needs the level map (and its digest)
        # before it can ask "are stamps fresh?". `set_entity_type_levels`
        # triggers the probe whenever the digest changes. Until then,
        # ``_levels_backfilled`` stays None and the trace fast path uses
        # the label-scan fallback (correct, slower).
        #
        # ``_level_digest`` is the SHA-256 of the entity_type→level map
        # currently injected onto this provider. AGGREGATED edges carry
        # ``r.levelDigest`` set to whatever digest was current when they
        # were stamped; a mismatch means the ontology drifted and stamps
        # need a re-run of backfill_aggregated_levels.py.
        #
        # ``_levels_warning_for_digest`` throttles the "edges not stamped"
        # warning to at most one log line per (provider lifetime, digest)
        # pair, so per-request probes don't spam.
        self._levels_backfilled: Optional[bool] = None
        self._level_digest: Optional[str] = None
        self._levels_warning_for_digest: Optional[str] = None

        # Phase 1.6/1.8 — operator dials for the bulk-CREATE UNWIND batch size
        # and write timeout. Parsed + logged ONCE per process per env value
        # (see _resolve_bulk_create_knobs): providers are constructed
        # continuously at fleet scale (discovery worker transients, cache
        # rebuilds), and re-logging the same operator tuning on every
        # construction read as a per-request warning storm.
        self._bulk_create_batch_size, self._bulk_create_timeout_s = (
            _resolve_bulk_create_knobs()
        )

        # Phase 2 — provider-internal hard cap and latency-quiesce circuit.
        #
        # The write semaphore puts a structural ceiling on in-flight
        # writes to FalkorDB per (provider_id, graph_name) instance.
        # No caller can exceed it; the worker, ingest hooks, future
        # callers are all gated through ``_proj_query``. Default 2
        # tolerates one bulk-rebuild batch + one incremental MERGE
        # without competing for the single FalkorDB Cypher thread.
        _write_conc_raw = os.getenv("FALKORDB_WRITE_CONCURRENCY", "2")
        try:
            _write_conc = max(1, min(32, int(_write_conc_raw)))
        except ValueError:
            _write_conc = 2
            logger.warning(
                "FALKORDB_WRITE_CONCURRENCY=%r not an int; default 2.",
                _write_conc_raw,
            )
        self._write_semaphore = asyncio.Semaphore(_write_conc)
        self._write_concurrency_cap: int = _write_conc

        # Distributed admission controller (aggregation writes). Injected
        # per-job by the aggregation worker via ``set_admission_controller``
        # so N workers × M pods share one write budget per FalkorDB
        # endpoint instead of each pod throttling only itself. None →
        # the per-process ``_write_semaphore`` above is the only gate.
        self._admission_controller: Optional[Any] = None

        # Latency-quiesce: rolling window of last 50 write latencies (in
        # seconds), computed as p95 lazily on each write attempt. When
        # p95 climbs above ``_quiesce_trigger_s``, the provider enters
        # a "busy" state — all subsequent writes raise ``ProviderBusy``
        # for ``_quiesce_cooldown_s`` seconds. The worker treats this
        # as park-and-resume (not retry/error). Distinct from the
        # circuit breaker which trips on hard errors; quiesce is flow
        # control on observed slowness.
        from collections import deque
        self._write_latency_window: deque[float] = deque(maxlen=50)
        self._quiesce_until_monotonic: float = 0.0  # 0 = not quiesced

        # Quiesce trigger: write p95 > ``_QUIESCE_MULTIPLE × WRITE_TIMEOUT_TARGET``.
        # The target represents the "this is healthy" upper bound; the
        # trigger is 3× that, on the theory that 3× slowdown means
        # overload, not jitter.
        _target_raw = os.getenv("FALKORDB_WRITE_TARGET_S", "2.0")
        try:
            _target = max(0.1, min(60.0, float(_target_raw)))
        except ValueError:
            _target = 2.0
        self._quiesce_target_s: float = _target
        self._quiesce_trigger_s: float = _target * 3.0

        _cooldown_raw = os.getenv("FALKORDB_QUIESCE_COOLDOWN_S", "30")
        try:
            self._quiesce_cooldown_s: float = max(1.0, min(600.0, float(_cooldown_raw)))
        except ValueError:
            self._quiesce_cooldown_s = 30.0

    @property
    def _proj(self):
        """Transparent access to the projection graph.

        When projection_mode is "in_source", AGGREGATED edges live in the
        same graph as source data. When "dedicated", they go to a separate
        graph key (e.g. nexus_lineage_proj) on the same Redis instance.
        """
        if self._projection_mode == "dedicated" and self._proj_graph is not None:
            return self._proj_graph
        return self._graph

    def inflight_ops(self) -> int:
        """Number of guarded graph ops currently executing. The manager uses
        this to avoid closing a provider mid-job during recovery eviction."""
        return self._inflight

    async def preflight(self, *, deadline_s: float = 1.5):
        """Fast reachability probe — TCP connect + Redis PING within
        ``deadline_s``. Does NOT touch the production pool, does NOT run
        any DDL. Returns a ``PreflightResult``; never raises for network
        failure.

        The ``/test`` admin endpoint and the manager's preflight gate
        invoke this before any expensive driver work, so an unreachable
        host fails fast (≤1.5s) instead of triggering 30-45s of half-
        blocking init in ``_ensure_connected``.

        P1.6 — credential plumbing: when a username/password is configured,
        ``redis_ping_preflight`` runs ``AUTH`` before ``PING``. Without
        this, an auth-protected FalkorDB would fail preflight with
        NOAUTH and trigger the same false breaker storm we're trying to
        prevent for unreachable hosts. When TLS is enabled, the probe
        completes a real TLS handshake (else a TLS-only server is wrongly
        marked unreachable). For sentinel the probe hits the first configured
        sentinel node (failover is the sentinel pool's job). For CLUSTER the
        probe resolves and pings the node that OWNS this graph — probing only
        an entry node would report healthy while the owning node is dead —
        falling back to the first startup node when discovery fails;
        connect() remains the authoritative topology check.
        """
        from backend.common.interfaces.preflight import (
            redis_ping_preflight, is_auth_reachable_reason,
        )
        from backend.app.providers.falkordb_connection import load_connection_config
        from backend.common.adapters.redis_tls import build_ssl_context

        # Resolve TLS/topology so preflight matches what connect() will use.
        cfg = self._conn_cfg or load_connection_config(
            self._connection_config,
            host=self._host, port=self._port,
            username=self._username, password=self._password,
            tls_enabled=self._tls_enabled,
            credentials=self._credentials,
        )
        # Reachability + AUTH probe. It must be CHEAP and deadline-clean by
        # construction — a health probe must never build a heavyweight client.
        ssl_ctx = build_ssl_context(cfg.tls_settings())

        if cfg.mode == "cluster" and not cfg.cluster_nodes:
            # Cluster mode with no startup nodes is a CONFIG error connect()
            # will also raise. Falling through to a standalone ping of
            # self._host probed the wrong thing entirely — typically localhost
            # — and reported a verdict about a host nobody will dial.
            from backend.common.interfaces.preflight import PreflightResult
            return PreflightResult.failure("cluster_nodes_missing", 0)

        if cfg.mode == "cluster" and cfg.cluster_nodes:
            # Do NOT build a RedisCluster to resolve the owning node here.
            # RedisCluster.initialize() connects to EVERY startup node, verifies
            # full slot coverage and RETRIES, and its aclose() blocks our
            # deadline-cancel — one slow/down node adds ~2s (measured) and under
            # real network latency this overruns the warmup budget, surfacing as
            # 'warmup_wall_clock_exceeded'; on discovery-timeout the old code then
            # pinged cluster_nodes[0], which may itself be the down node
            # ('connect_timeout'). Owning-node discovery is the CONNECT path's
            # job (cached in TopologyGraphClients; a dead slot owner is
            # re-resolved + evicted there). The probe only needs "is the cluster
            # reachable and are the credentials good?" — a raw AUTH+PING to any
            # LIVE startup node answers that, deterministically (self._password,
            # no discovery / no learned-auth strip in the probe path). Try nodes
            # in order so one down node never fails the probe.
            nodes = list(cfg.cluster_nodes)
            per_node = max(0.5, deadline_s / len(nodes))
            result = None
            for node_host, node_port in nodes:
                result = await redis_ping_preflight(
                    node_host, node_port,
                    deadline_s=per_node,
                    username=self._username,
                    password=self._password,
                    ssl_context=ssl_ctx,
                )
                # ok → reachable. A definitive auth verdict (auth_required /
                # auth_failed) is the same on every node — the whole cluster
                # shares ONE credential — so stop rather than retry N nodes.
                if result.ok or is_auth_reachable_reason(result.reason):
                    break
                # else (connect_timeout / refused / dns) this node is down —
                # try the next one.
            return result

        # Standalone pings host:port directly. Sentinel resolves the CURRENT
        # master first (a Sentinel daemon answers PONG while its master is dead);
        # that discovery is a single lightweight query, deadline-bounded, with a
        # fallback to the first sentinel node.
        host, port = self._host, self._port
        discover = None
        probe_username, probe_password = self._username, self._password
        probe_ssl = ssl_ctx
        if cfg.mode == "sentinel" and cfg.sentinel_nodes:
            host, port = cfg.sentinel_nodes[0]
            from backend.app.providers.falkordb_connection import (
                _sentinel_auth_kwargs,
                resolve_sentinel_master,
            )
            # The FALLBACK target is a Sentinel DAEMON: its own auth and its own
            # TLS listener, not the data plane's. Probing it with the graph
            # password / graph TLS context reported auth_failed or a garbled
            # handshake against a perfectly healthy tier on any deployment where
            # the two differ (e.g. TLS data plane + plaintext sentinels).
            # Discovery socket budget: the 1.0s floor false-failed discovery on
            # a >1s-RTT sentinel tier, silently downgrading the probe to a
            # daemon PING (a dead master read green). A provider's
            # connectTimeout raises it, capped by the preflight deadline.
            discover_s = min(deadline_s, max(1.0, cfg.socket_connect_timeout or 1.0))
            sentinel_kw = _sentinel_auth_kwargs(cfg, discover_s)
            probe_username = sentinel_kw.get("username")
            probe_password = sentinel_kw.get("password")
            probe_ssl = build_ssl_context(cfg.sentinel_tls_settings())
            discover = resolve_sentinel_master(cfg, discover_s)

        if discover is not None:
            started = time.monotonic()
            try:
                host, port = await asyncio.wait_for(
                    discover, timeout=max(0.5, deadline_s * 0.6),
                )
                # Discovery succeeded → the probe target is the MASTER: back to
                # data-plane credentials and data-plane TLS.
                probe_username, probe_password = self._username, self._password
                probe_ssl = ssl_ctx
            except Exception:
                pass
            deadline_s = max(0.3, deadline_s - (time.monotonic() - started))
        return await redis_ping_preflight(
            host, port,
            deadline_s=deadline_s,
            username=probe_username,
            password=probe_password,
            ssl_context=probe_ssl,
            # Standalone mode against a cluster-enabled node silently sees only
            # one node's graphs — surface it as a config verdict here (the /test
            # wizard and discovery last_error both carry preflight reasons).
            # Sentinel targets are never cluster nodes; cluster mode never
            # reaches this call.
            detect_cluster=(cfg.mode == "standalone"),
        )

    def _build_pool_kwargs(self, socket_timeout: float) -> dict:
        """Graph connection-pool kwargs (sizing + timeouts + auth). TLS is
        applied inside the connection factory (raw pools need
        ``connection_class=SSLConnection``). Shared by the initial connect and
        the failover rebuild so the two can never drift apart."""
        graph_pool_size = (
            (self._conn_cfg.graph_pool_size if self._conn_cfg else None)
            or int(os.getenv("FALKORDB_GRAPH_POOL_SIZE", "24"))
        )
        from backend.app.providers.falkordb_connection import resilient_pool_kwargs

        kw: dict = {
            "max_connections": graph_pool_size,
            "decode_responses": True,
            **resilient_pool_kwargs(
                socket_timeout=socket_timeout,
                connect_timeout=(
                    self._conn_cfg.socket_connect_timeout if self._conn_cfg else None
                ),
            ),
        }
        # P1.6 — auth so the pool issues AUTH transparently (else NOAUTH is
        # mis-classified as a network failure and trips a false breaker).
        if self._username:
            kw["username"] = self._username
        if self._password:
            kw["password"] = self._password
        return kw

    async def _build_and_verify(self, graph_pool_kwargs: dict, init_timeout: float) -> None:
        """Build the graph client (+ the dedicated projection client on cluster),
        select the graphs, and verify the pool with ONE bounded connection-level
        PING. Shared by the initial connect and both auth-renegotiation rebuilds
        in ``_ensure_connected`` so the three paths can never drift apart.

        The verify is a Redis PING, never a GRAPH query: a read-only graph query
        raises "empty key" on a never-created graph (false "provider down"), and
        a read-write one would lazily create an empty graph key per probe.
        """
        from redis.asyncio import Redis
        from backend.app.providers.falkordb_connection import (
            build_graph_client,
            verify_not_cluster_node,
        )

        self._db, self._pool = await build_graph_client(
            self._conn_cfg,
            graph_name=self._graph_name,
            pool_kwargs=graph_pool_kwargs,
        )
        self._graph = self._db.select_graph(self._graph_name)
        # Projection graph for dedicated mode. On a Redis Cluster,
        # {graph}_proj may hash to a DIFFERENT shard than {graph}, so route it
        # through its own owning-node client; else it shares the same client.
        if self._projection_mode == "dedicated":
            proj_name = f"{self._graph_name}_proj"
            if self._conn_cfg.mode == "cluster":
                self._proj_db, self._proj_pool = await build_graph_client(
                    self._conn_cfg,
                    graph_name=proj_name,
                    pool_kwargs=graph_pool_kwargs,
                )
                self._proj_graph = self._proj_db.select_graph(proj_name)
            else:
                self._proj_db = self._db
                self._proj_graph = self._db.select_graph(proj_name)
        await asyncio.wait_for(
            Redis(connection_pool=self._pool).ping(),
            timeout=init_timeout,
        )
        # Standalone config against a cluster-enabled node would silently see
        # only one node's graphs — fail loud at build time (no-op otherwise).
        await verify_not_cluster_node(self._conn_cfg, self._pool, init_timeout)

    async def _ensure_connected(self):
        """Lazy connection to FalkorDB.

        Schema reconciliation (``ensure_indices``, ``ensure_projections``)
        is intentionally NOT run here — it is dispatched as a fire-and-
        forget background task on first successful connect so a slow DDL
        sweep cannot extend the request-path budget. See
        ``_schedule_reconcile_once`` below.
        """
        if self._graph is not None:
            return
        # WS0.1 connect cooldown: if a very recent connect attempt already
        # failed, fast-fail (<1ms) instead of re-paying the full
        # socket_connect_timeout. Without this, a single request's ontology
        # introspection (4-5 queries) + read + retries each re-probe an
        # unreachable/blackhole host and the request takes tens of seconds to
        # 503. The first attempt after the window lapses is allowed through.
        _now = time.monotonic()
        if _now < self._connect_cooldown_until:
            from redis.exceptions import ConnectionError as _RedisConnErr
            raise _RedisConnErr(
                f"FalkorDB {self._graph_name}: unreachable "
                f"(connect cooldown {self._connect_cooldown_until - _now:.1f}s)"
            )
        try:
            # Non-blocking ConnectionPool: on exhaustion raises ConnectionError
            # immediately instead of blocking the caller (and, for asyncio
            # BlockingConnectionPool, stalling the event loop while waiting
            # on a semaphore inside the loop itself). The circuit-breaker
            # proxy around this provider translates the failure into
            # ProviderUnavailable before it reaches the web tier.
            from backend.app.providers.falkordb_connection import (
                load_connection_config,
                build_cache_client,
            )

            # Resolve the connection topology (standalone / sentinel /
            # cluster). Default mode is standalone → byte-for-byte the
            # legacy single-host path. Sentinel/Cluster route via the
            # connection factory's adapter (the FalkorDB client only
            # accepts ``connection_pool=``). A single FalkorDB graph key
            # lives on one node, so cluster mode routes to the owning node.
            # tls_enabled (+ falkordbConnection.tls) gives TLS/mTLS in every
            # mode; resolved into self._conn_cfg so preflight/cache reuse it.
            self._conn_cfg = load_connection_config(
                self._connection_config,
                host=self._host, port=self._port,
                username=self._username, password=self._password,
                tls_enabled=self._tls_enabled,
                credentials=self._credentials,
            )
            socket_timeout = self._graph_socket_timeout()
            # The graph-pool socket timeout bounds a single Cypher query
            # (floored above the server's TIMEOUT_MAX — see
            # _graph_socket_timeout). Auth + TLS are applied inside the
            # connection factory (TLS via connection_class=SSLConnection on
            # the raw pools); pool_kwargs carries only sizing/timeouts/auth/
            # decode. Built once here and reused verbatim on failover rebuild.
            _graph_pool_kwargs = self._build_pool_kwargs(socket_timeout)
            if self._conn_cfg.mode != "standalone":
                logger.info(
                    "FalkorDB provider connecting graph %r via %s",
                    self._graph_name, self._conn_cfg.describe(),
                )
            # Redis for non-graph ops (caching, materialization tracking,
            # ancestor chains, stats). Resolved centrally via the CACHE role
            # (``build_cache_client``): the provider's own
            # ``extra_config.cacheConnection`` + encrypted cache_* credentials
            # win, else the global ``REDIS_CACHE_*`` endpoint, else the legacy
            # ``CACHE_REDIS_URL`` env. ALWAYS a DEDICATED endpoint with its OWN
            # auth and its OWN TLS — never inherited from FalkorDB (that
            # inheritance used to silently produce "no TLS" or "system trust
            # store" depending on the cache URL's scheme). ``None`` means no
            # cache is configured anywhere → cache DISABLED; the cache is never
            # co-located on the FalkorDB instance (ADR-020).
            from backend.common.adapters import TimeoutRedis
            redis_op_timeout = float(os.getenv("FALKORDB_REDIS_OP_TIMEOUT", "3"))
            # P2.3 — cache Redis is a BEST-EFFORT dependency. Wrapped in
            # its own try/except so an unreachable cache Redis sets
            # ``self._redis_available=False`` and degrades gracefully
            # instead of taking the whole provider down. Graph queries
            # (the load-bearing path) still work; cache misses just go
            # to the source. Without this, a cache Redis outage kills
            # FalkorDB availability even when FalkorDB itself is healthy.
            self._redis_available = True
            try:
                _raw_redis = build_cache_client(
                    provider_id=self._provider_id or "env",
                    extra_config=self._extra_config,
                    credentials=self._credentials,
                )
                self._redis_pool = None
                # Wrap in TimeoutRedis — every async call and pipeline.execute()
                # automatically gets an asyncio.wait_for() deadline. No call-site
                # wrapping needed. See backend/common/adapters/timeout_redis.py.
                if _raw_redis is None:
                    # No cache endpoint configured anywhere → degrade.
                    logger.warning(
                        "FalkorDB provider %r: no cache Redis configured — "
                        "ancestor/URN caches disabled (DEGRADED, graph queries "
                        "unaffected). Configure REDIS_CACHE_* / "
                        "extra_config.cacheConnection to enable caching.",
                        self._graph_name,
                    )
                    self._redis = None
                    self._redis_available = False
                else:
                    self._redis = TimeoutRedis(_raw_redis, timeout=redis_op_timeout)
            except Exception as exc:
                # Cache Redis construction failed. Provider continues
                # without cache; queries are slower but available.
                logger.warning(
                    "FalkorDB cache Redis unavailable (%s) — provider running "
                    "in cache-disabled mode (DEGRADED).", exc,
                )
                self._redis = None
                self._redis_available = False
            # Build graph client(s) + verify with one bounded PING (see
            # _build_and_verify — if the verify fails, the connect failed and
            # the caller's circuit breaker records it).
            from backend.app.providers.falkordb_connection import connect_verify_budget

            _init_timeout = connect_verify_budget(
                self._conn_cfg, float(os.getenv("FALKORDB_INIT_TIMEOUT", "3")),
            )
            try:
                await self._build_and_verify(_graph_pool_kwargs, _init_timeout)
            except Exception as _auth_exc:
                from backend.app.providers.falkordb_connection import (
                    is_auth_not_configured_error,
                    is_auth_required_error,
                    mark_instance_unauthenticated,
                    normalize_credentials,
                    raise_auth_config_error,
                    strip_credentials,
                    unmark_instance_unauthenticated,
                )

                if is_auth_not_configured_error(_auth_exc) and (
                    self._username or self._password
                ):
                    # The instance has NO authentication configured but this provider
                    # carries credentials (a stale password on the row, or auth turned
                    # off on the server). Reconnect WITHOUT them rather than reporting
                    # a healthy graph as down; the lesson is remembered for every other
                    # connection to this instance.
                    logger.warning(
                        "FalkorDB at %s has NO authentication configured but this "
                        "provider carries credentials — reconnecting without them.",
                        self._conn_cfg.describe(),
                    )
                    mark_instance_unauthenticated(self._conn_cfg)
                    self._conn_cfg = strip_credentials(self._conn_cfg)
                    self._username = None
                    self._password = None
                    await self._build_and_verify(
                        self._build_pool_kwargs(socket_timeout), _init_timeout,
                    )
                elif (
                    is_auth_required_error(_auth_exc)
                    and self._auth_enabled
                    and not (self._username or self._password)
                    and (
                        self._credentials.get("username")
                        or self._credentials.get("password")
                    )
                ):
                    # The mirror case: NOAUTH on a connect we made WITHOUT
                    # credentials while the row HAS them — the self-heal above
                    # nulled them earlier (instance was unauthenticated then) and
                    # authentication has since been re-enabled on the server.
                    # Restore the row credentials, un-learn, rebuild once WITH
                    # them; a second auth failure is a clean config error, so
                    # this can never loop.
                    logger.warning(
                        "FalkorDB at %s now REQUIRES authentication (it was "
                        "previously observed unauthenticated) — reconnecting with "
                        "the provider's saved credentials.",
                        self._conn_cfg.describe(),
                    )
                    unmark_instance_unauthenticated(self._conn_cfg)
                    self._username, self._password = normalize_credentials(
                        self._credentials.get("username"),
                        self._credentials.get("password"),
                    )
                    self._conn_cfg = load_connection_config(
                        self._connection_config,
                        host=self._host, port=self._port,
                        username=self._username, password=self._password,
                        tls_enabled=self._tls_enabled,
                        credentials=self._credentials,
                    )
                    try:
                        await self._build_and_verify(
                            self._build_pool_kwargs(socket_timeout), _init_timeout,
                        )
                    except Exception as _auth_exc2:
                        raise_auth_config_error(self._conn_cfg, _auth_exc2)
                        raise
                else:
                    # NOAUTH (instance wants credentials we lack) or WRONGPASS
                    # (credentials rejected) → a CONFIGURATION error, not an outage:
                    # raising ProviderConfigurationError keeps the breaker closed and
                    # tells the operator what to fix. Anything else propagates as-is.
                    raise_auth_config_error(self._conn_cfg, _auth_exc)
                    raise

            # Schema reconciliation runs OFF the request path. Fire-and-
            # forget background task; failures are logged but do not affect
            # connect outcome. Subsequent connects are no-ops because of the
            # ``_graph is not None`` guard above, so reconcile fires once
            # per provider instance, not once per query.
            self._schedule_reconcile_once()

            # Optional lazy seed (cheap when graph is non-empty; bounded by
            # the same init_timeout for the count query).
            if self._seed_file:
                count_result = await asyncio.wait_for(
                    self._graph.ro_query("MATCH (n) RETURN count(n) AS c", params={}),
                    timeout=_init_timeout,
                )
                if count_result.result_set and count_result.result_set[0][0] == 0:
                    await self._seed_from_file()
        except Exception as e:
            logger.error(f"FalkorDB connection failed: {e}")
            # WS0.1: arm the connect cooldown so the rest of this request's
            # queries (and immediately-following requests) fast-fail instead of
            # each re-paying the connect timeout against an unreachable host.
            self._connect_cooldown_until = time.monotonic() + self._connect_cooldown_s
            # Roll back any half-initialised graph state so a FAILED connect
            # does not leave a zombie handle. self._graph is assigned (line
            # above) BEFORE the verifying PING, so without this the
            # ``_graph is not None`` guard at the top of this method would make
            # every later call believe it is connected, skip reconnect, and
            # hammer a dead handle through the transient-retry stack
            # (~8-12s/call) instead of failing clean (~2-3s) and letting the
            # circuit breaker open. Next call does a fresh connect attempt.
            self._graph = None
            self._db = None
            self._proj_graph = None
            self._proj_db = None
            raise

    def _schedule_reconcile_once(self) -> None:
        """Schedule ``ensure_indices`` + ``ensure_projections`` as a
        background task. Idempotent — guarded by ``_reconcile_started``.

        Failures are logged at WARNING and do NOT raise into the connect
        path. The next call requiring a missing index will surface a
        logical error from the query, which is the correct signal — not
        a 30-45s connect-time stall.
        """
        if getattr(self, "_reconcile_started", False):
            return
        self._reconcile_started = True

        async def _run():
            try:
                await self.ensure_indices()
                await self.ensure_projections()
                logger.info("FalkorDB reconcile complete (host=%s port=%s)", self._host, self._port)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning(
                    "FalkorDB reconcile failed (host=%s port=%s): %s — provider remains usable",
                    self._host, self._port, exc,
                )

        # Detach the task — we don't await it. Hold a reference to prevent
        # GC under Python's "task may be GC'd before completion" rule.
        self._reconcile_task = asyncio.create_task(
            _run(), name=f"falkordb-reconcile-{self._host}:{self._port}"
        )

    # ── Timeout-guarded query helpers ────────────────────────────────
    # Every Cypher query routed through these methods gets an
    # asyncio.wait_for() deadline. TimeoutError is a network-class
    # exception — the CircuitBreakerProxy counts it toward the failure
    # budget and opens the breaker after fail_max consecutive failures.
    # Sourced from app.config.resilience so a single env var
    # (FALKORDB_QUERY_TIMEOUT / FALKORDB_WRITE_TIMEOUT) tunes every
    # consumer rather than each module reading os.getenv directly.
    from backend.app.config import resilience as _resilience
    _READ_TIMEOUT = _resilience.FALKORDB_QUERY_TIMEOUT_SECS
    _WRITE_TIMEOUT = _resilience.FALKORDB_WRITE_TIMEOUT_SECS
    _EDGES_BETWEEN_TIMEOUT = _resilience.FALKORDB_EDGES_BETWEEN_TIMEOUT_SECS
    del _resilience

    # FalkorDB engine cancels the query 500ms before the asyncio deadline so
    # the DB-side cancel races first (frees the worker thread + the pool
    # connection); asyncio.wait_for is the safety net for socket-level hangs.
    #
    # Clamped to the server's TIMEOUT_MAX: FalkorDB REJECTS (never runs) a
    # query whose TIMEOUT parameter exceeds it, so an over-budget caller
    # (e.g. the insights materialization's 600s) must degrade to "run for
    # up to TIMEOUT_MAX" rather than fail instantly with "The query TIMEOUT
    # parameter value cannot exceed the TIMEOUT_MAX configuration parameter".
    @staticmethod
    def _db_timeout_ms(seconds: float) -> int:
        from backend.app.config import resilience
        ms = max(500, int(seconds * 1000) - 500)
        cap = resilience.FALKORDB_SERVER_TIMEOUT_MAX_MS
        if cap > 0:
            ms = min(ms, cap)
        return ms

    def _graph_socket_timeout(self) -> float:
        """Socket recv/send timeout for the GRAPH query pools.

        Floored above the server's TIMEOUT_MAX: the redis client applies
        ``socket_timeout`` to each ``read_response``, and a long-running
        Cypher query sends no bytes until it completes — a socket timeout
        below the query budget kills legitimate queries mid-flight. The
        hang-net role the low per-tier value played is preserved by the
        per-call ``asyncio.wait_for`` in ``_ro_query``/``_query``, which
        bounds every call at its own (much smaller) budget regardless of
        socket state.
        """
        from backend.app.config import resilience
        configured = (
            (self._conn_cfg.socket_timeout if self._conn_cfg else None)
            or float(os.getenv("FALKORDB_SOCKET_TIMEOUT", "10"))
        )
        cap_ms = resilience.FALKORDB_SERVER_TIMEOUT_MAX_MS
        if cap_ms <= 0:
            return configured
        return max(configured, cap_ms / 1000.0 + 15.0)

    async def _rebuild_graph_client_for_failover(self, seen_generation: int) -> None:
        """Re-resolve and rebuild the FalkorDB client(s) after a cluster
        MOVED / connection drop. Coalesced: if another task already
        rebuilt past ``seen_generation`` we no-op. In cluster mode this
        re-discovers the node owning the graph key; in sentinel/standalone
        it reconnects against the (possibly newly-promoted) master/host.
        """
        if self._conn_cfg is None:
            return
        async with self._failover_lock:
            if seen_generation != self._conn_generation:
                return  # someone else already rebuilt for this failure
            from backend.app.providers.falkordb_connection import (
                build_graph_client, aclose_graph_client,
            )

            socket_timeout = self._graph_socket_timeout()
            # Same kwargs as the initial connect (auth; TLS re-applied inside
            # the factory) so failover never drops credentials or TLS.
            pool_kwargs = self._build_pool_kwargs(socket_timeout)

            old_pool, old_proj_pool = self._pool, self._proj_pool
            old_db, old_proj_db = self._db, self._proj_db
            self._db, self._pool = await build_graph_client(
                self._conn_cfg, graph_name=self._graph_name, pool_kwargs=pool_kwargs,
            )
            self._graph = self._db.select_graph(self._graph_name)
            if self._projection_mode == "dedicated":
                proj_name = f"{self._graph_name}_proj"
                if self._conn_cfg.mode == "cluster":
                    self._proj_db, self._proj_pool = await build_graph_client(
                        self._conn_cfg, graph_name=proj_name, pool_kwargs=pool_kwargs,
                    )
                    self._proj_graph = self._proj_db.select_graph(proj_name)
                else:
                    self._proj_db = self._db
                    self._proj_graph = self._db.select_graph(proj_name)
            self._conn_generation += 1
            logger.warning(
                "FalkorDB %s: rebuilt client after failover (generation %d, %s).",
                self._graph_name, self._conn_generation, self._conn_cfg.describe(),
            )
            # Best-effort close of superseded clients AND pools. Closing the pool
            # alone is not enough in cluster mode: the client is a RedisCluster
            # holding a pool PER node, which the pinned pool does not own. In-flight
            # ops on them either complete or fail and are retried by _run_guarded.
            for old_d, old_p in ((old_db, old_pool), (old_proj_db, old_proj_pool)):
                if old_d is self._db or old_d is self._proj_db:
                    old_d = None            # still in use — rebuilt to the same object
                if old_p is self._pool or old_p is self._proj_pool:
                    old_p = None
                await aclose_graph_client(old_d, old_p)

    async def _run_guarded(self, call: Callable[[], Awaitable[Any]]) -> Any:
        """Execute a graph call with transparent retries for transient
        failures so the circuit breaker stays closed on blips.

        Two failure classes are absorbed:

        * **Transient connection drops** (redis ``ConnectionError`` /
          ``TimeoutError``, e.g. 'Connection reset by peer' under FalkorDB
          memory pressure) — retried with a short backoff in ALL modes.
          redis-py hands out a fresh pooled connection on the next call, so
          the retried op succeeds once FalkorDB recovers. Reads are
          idempotent; a retried write/flush re-applies at most one chunk's
          weight via MERGE ON MATCH (bounded, self-healing). In CLUSTER
          mode the second and later retries escalate to a full topology
          re-resolve (see below): a silently-dead owning node (rotated pod,
          new address) never answers MOVED, so redialing the pinned address
          would otherwise fail forever.
        * **Cluster routing changes** (Moved/Ask/ClusterDown) — only in
          cluster mode: rebuild the single-node client (re-resolve the key
          owner) and retry.

        ``call`` must reference ``self._graph`` / ``self._proj`` lazily so a
        retry after a rebuild picks up the new client. A non-transient query
        error propagates immediately. Retries run inside the caller's per-op
        ``asyncio.wait_for`` budget and query semaphore, so they still count
        against the concurrency cap; only ``asyncio.TimeoutError`` (the
        per-op deadline) is never retried.
        """
        attempt = 0
        max_retries = len(_TRANSIENT_RETRY_BACKOFFS)
        # In-flight op count: the manager's recovery-eviction defers close()
        # while this is > 0 so it can't tear the pool out from under a job.
        self._inflight += 1
        try:
            while True:
                try:
                    return await call()
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    # FalkorDB is loading its RDB into memory on restart — a
                    # transient "warming up" state, not an outage. Fast-fail
                    # with ProviderLoading (a logical/ignored signal, so the
                    # breaker stays CLOSED and this instance recovers the moment
                    # its load finishes) instead of retrying for ~1.75s and then
                    # tripping the breaker on a load that takes many seconds.
                    # The caller (FE) polls per the Retry-After hint.
                    if _is_loading_error(exc):
                        from backend.common.adapters import ProviderLoading
                        raise ProviderLoading(
                            provider_name=self._graph_name,
                            reason="graph is starting up (loading dataset into memory)",
                            retry_after_seconds=5,
                        ) from exc
                    cluster = (
                        self._conn_cfg is not None
                        and self._conn_cfg.mode == "cluster"
                    )
                    # Cluster slot moved → rebuild the single-node client, retry.
                    if cluster and _is_cluster_routing_error(exc):
                        if attempt >= max_retries:
                            raise
                        gen = self._conn_generation
                        attempt += 1
                        logger.warning(
                            "FalkorDB %s: cluster redirect (%s) — rebuilding "
                            "client and retrying (%d/%d).",
                            self._graph_name, type(exc).__name__,
                            attempt, max_retries,
                        )
                        await self._rebuild_graph_client_for_failover(gen)
                        continue
                    # Transient connection drop (any mode) OR a graph handle that
                    # was nulled mid-flight (evicted/closed by the manager's
                    # recovery path during this retry) → rebuild the client and
                    # retry within budget. _ensure_connected is a no-op when the
                    # handle is still live (redis-py self-heals the pool) and a
                    # full rebuild when close() nulled it.
                    handle_lost = _is_null_handle_error(exc)
                    if (handle_lost or _is_transient_connection_error(exc)) and attempt < max_retries:
                        backoff = _TRANSIENT_RETRY_BACKOFFS[attempt]
                        attempt += 1
                        # Cluster: the pinned single-node pool redials the SAME
                        # address, so once a plain redial has also failed
                        # (attempt 2+) assume the owning node is gone — a
                        # rotated pod comes back at a NEW address and a dark
                        # node never answers MOVED — and re-resolve the
                        # topology (finds the promoted replica) instead of
                        # redialing a corpse. The first retry stays the cheap
                        # redial: it absorbs same-node blips (reset-by-peer)
                        # without pool churn.
                        reresolve = cluster and not handle_lost and attempt >= 2
                        logger.warning(
                            "FalkorDB %s: %s (%s) — %s + retry %d/%d after %.2fs.",
                            self._graph_name,
                            "lost graph handle" if handle_lost else "transient connection error",
                            type(exc).__name__,
                            "cluster topology re-resolve" if reresolve else "reconnect",
                            attempt, max_retries, backoff,
                        )
                        try:
                            if reresolve:
                                await self._rebuild_graph_client_for_failover(
                                    self._conn_generation
                                )
                            else:
                                await self._ensure_connected()
                        except Exception as reconnect_exc:
                            # If FalkorDB is loading (RDB replay) during the
                            # reconnect, surface the retryable warming signal
                            # rather than a hard failure that steps the breaker.
                            if _is_loading_error(reconnect_exc):
                                from backend.common.adapters import ProviderLoading
                                raise ProviderLoading(
                                    provider_name=self._graph_name,
                                    reason="graph is starting up (loading dataset into memory)",
                                    retry_after_seconds=5,
                                ) from reconnect_exc
                            # Reconnect failed → the host is unreachable, not a
                            # transient blip. Stop retrying and surface the
                            # failure now so the breaker opens fast instead of
                            # burning the remaining retries (each a fresh ~2-3s
                            # connect attempt) against a dead host.
                            logger.warning(
                                "FalkorDB %s: reconnect during retry failed (%s) — "
                                "treating as unreachable, not retrying.",
                                self._graph_name, reconnect_exc,
                            )
                            raise reconnect_exc from exc
                        await asyncio.sleep(backoff)
                        continue
                    raise
        finally:
            self._inflight -= 1

    async def _guarded_timed(
        self,
        runner: Callable[[], Awaitable[Any]],
        *,
        kind: str,
        cypher: str,
        op: Optional[str],
        budget: float,
    ):
        """Semaphore + guard + slow-query telemetry for every Cypher.

        Emits one WARNING line when DB execution OR semaphore-queue wait
        exceeds ``FALKORDB_SLOW_QUERY_MS``. The two durations are reported
        separately on purpose: ``queue_ms`` is the saturation signal (work
        waiting for a slot), ``query_ms`` attributes cost to the query
        shape. Zero overhead below the threshold beyond three monotonic
        reads; never raises from the logging path.
        """
        from backend.app.config.resilience import FALKORDB_SLOW_QUERY_MS

        queued_at = time.monotonic()
        async with self._query_semaphore:
            started = time.monotonic()
            rows: Optional[int] = None
            err: Optional[str] = None
            try:
                result = await self._run_guarded(runner)
                rs = getattr(result, "result_set", None)
                rows = len(rs) if rs is not None else 0
                return result
            except Exception as exc:
                err = type(exc).__name__
                raise
            finally:
                try:
                    query_ms = int((time.monotonic() - started) * 1000)
                    queue_ms = int((started - queued_at) * 1000)
                    if max(query_ms, queue_ms) >= FALKORDB_SLOW_QUERY_MS:
                        logger.warning(
                            "falkordb slow %s: graph=%s op=%s query_ms=%d queue_ms=%d "
                            "budget_s=%.1f rows=%s err=%s cypher=%.80s",
                            kind, self._graph_name, op or "-", query_ms, queue_ms,
                            budget, "-" if rows is None else rows, err or "-",
                            " ".join(cypher.split()),
                        )
                except Exception:  # pragma: no cover — telemetry must not mask results
                    pass

    async def _ro_query(self, cypher: str, params: dict = None, *, timeout: float = None,
                        op: Optional[str] = None):
        """Timeout-guarded read-only query on the source graph."""
        t = timeout if timeout is not None else self._READ_TIMEOUT

        async def _call():
            return await asyncio.wait_for(
                self._graph.ro_query(cypher, params=params or {}, timeout=self._db_timeout_ms(t)),
                timeout=t,
            )

        return await self._guarded_timed(_call, kind="ro", cypher=cypher, op=op, budget=t)

    async def _empty_key_is_genuine(self) -> bool:
        """Whether an "Invalid graph operation on empty key" really means the
        graph is empty.

        Standalone/Sentinel: yes — one endpoint serves every key, so the error
        can only mean the graph key does not exist yet.

        Cluster: verify before believing it. The SAME error comes back when a
        read lands on a node that does not hold the graph key — a stale pinned
        handle after a slot migration, or a replica promoted without its
        shard's data — and masking that as "0 nodes / 0 edges" is how a graph
        silently reads as empty on one pod while another still shows data. A
        slot-routed EXISTS through the cluster client asks the CURRENT owner:
        0 → genuinely absent (mask as empty); 1 → the graph exists and the
        empty read was a misroute (fail loud); probe error → fail loud, never
        mask on an unhealthy cluster.
        """
        if self._conn_cfg is None or self._conn_cfg.mode != "cluster":
            return True
        try:
            exists = await asyncio.wait_for(
                self._db.execute_command("EXISTS", self._graph_name),
                timeout=float(os.getenv("FALKORDB_INIT_TIMEOUT", "3")),
            )
        except Exception as probe_exc:
            logger.warning(
                "empty-key verification: EXISTS probe for %r failed (%s) — "
                "treating the empty read as UNVERIFIED and failing loud.",
                self._graph_name, probe_exc,
            )
            return False
        if int(exists or 0) == 0:
            return True
        logger.warning(
            "empty-key verification: graph %r EXISTS on the cluster but a read "
            "reported 'empty key' — the read landed on a node that does not "
            "hold the graph (stale routing or an unsynced promotee). Failing "
            "loud and rebuilding the client.", self._graph_name,
        )
        # Heal, don't just detect: the client that produced the misroute stays
        # cached otherwise (the bare ResponseError is not classified as a
        # routing error, so _run_guarded never rebuilds for it) and every
        # subsequent read keeps failing until an unrelated MOVED or a restart.
        # The rebuild re-resolves the owning node; the CURRENT read still
        # raises (fail loud), the next one uses the fresh route.
        try:
            await self._rebuild_graph_client_for_failover(self._conn_generation)
        except Exception:                            # pragma: no cover - best effort
            logger.warning(
                "empty-key verification: client rebuild after stale-route "
                "detection failed for %r.", self._graph_name, exc_info=True,
            )
        return False

    async def _is_verified_missing_graph(self, exc: BaseException) -> bool:
        """The ONLY predicate that may mask an 'empty key' error as an empty
        graph: matches the error AND (in cluster mode) verifies via EXISTS that
        the graph is genuinely absent. Every masking site calls this — a bare
        ``_is_missing_graph_error`` check silently converts a cluster misroute
        into '0 rows'."""
        return _is_missing_graph_error(exc) and await self._empty_key_is_genuine()

    async def _ro_query_tolerant(self, cypher: str, params: dict = None, *, timeout: float = None,
                                 op: Optional[str] = None):
        """Like :meth:`_ro_query`, but a missing/empty graph yields an empty
        result set instead of raising. For introspection reads where an empty
        graph is a valid 0-result state (the graph key may not exist yet).
        On a cluster the empty-key signal is verified first — see
        :meth:`_empty_key_is_genuine`."""
        try:
            return await self._ro_query(cypher, params=params, timeout=timeout, op=op)
        except Exception as exc:
            if await self._is_verified_missing_graph(exc):
                return _EmptyResult()
            raise

    async def _query(self, cypher: str, params: dict = None, *, timeout: float = None,
                     op: Optional[str] = None):
        """Timeout-guarded write query on the source graph."""
        t = timeout if timeout is not None else self._WRITE_TIMEOUT

        async def _call():
            return await asyncio.wait_for(
                self._graph.query(cypher, params=params or {}, timeout=self._db_timeout_ms(t)),
                timeout=t,
            )

        return await self._guarded_timed(_call, kind="write", cypher=cypher, op=op, budget=t)

    async def _proj_ro_query(self, cypher: str, params: dict = None, *, timeout: float = None,
                             op: Optional[str] = None):
        """Timeout-guarded read-only query on the projection graph."""
        t = timeout if timeout is not None else self._READ_TIMEOUT

        async def _call():
            return await asyncio.wait_for(
                self._proj.ro_query(cypher, params=params or {}, timeout=self._db_timeout_ms(t)),
                timeout=t,
            )

        return await self._guarded_timed(_call, kind="proj-ro", cypher=cypher, op=op, budget=t)

    def _quiesce_p95(self) -> float:
        """p95 of the rolling write-latency window (seconds). 0 if window empty."""
        if not self._write_latency_window:
            return 0.0
        sorted_lat = sorted(self._write_latency_window)
        idx = int(0.95 * (len(sorted_lat) - 1))
        return sorted_lat[idx]

    def _check_quiesce_gate(self) -> None:
        """Raise ``ProviderBusy`` if quiesce is active. Phase 2.

        Called at the entry of every write before doing any I/O. The
        check is monotonic-time based so a clock change doesn't
        accidentally unfreeze a quiesced provider.
        """
        if self._quiesce_until_monotonic <= 0.0:
            return
        now = time.monotonic()
        remaining = self._quiesce_until_monotonic - now
        if remaining <= 0:
            # Cooldown elapsed — clear the gate. Latency window stays;
            # if the underlying issue persists, it'll re-trip on the
            # next slow write.
            self._quiesce_until_monotonic = 0.0
            self._write_latency_window.clear()
            logger.info(
                "FalkorDB %s: quiesce cooldown elapsed, accepting writes again.",
                self._graph_name,
            )
            return
        from backend.common.adapters import ProviderBusy
        raise ProviderBusy(
            provider_name=self._graph_name,
            reason=(
                f"write p95 above {self._quiesce_trigger_s:.1f}s; "
                f"quiesce cooldown {remaining:.0f}s remaining"
            ),
            retry_after_seconds=max(1, int(remaining) + 1),
        )

    def _record_write_latency(self, elapsed_s: float) -> None:
        """Append a write-latency sample and trip quiesce if p95 crossed
        the trigger threshold. Phase 2.
        """
        self._write_latency_window.append(elapsed_s)
        # Only consider tripping once we have enough samples for p95 to
        # be meaningful (avoid one-off slow first call from quiescing
        # the provider). 10 samples is a reasonable floor.
        if len(self._write_latency_window) < 10:
            return
        if self._quiesce_until_monotonic > 0.0:
            return  # already quiesced
        p95 = self._quiesce_p95()
        if p95 > self._quiesce_trigger_s:
            self._quiesce_until_monotonic = (
                time.monotonic() + self._quiesce_cooldown_s
            )
            logger.warning(
                "FalkorDB %s: write p95=%.2fs > trigger %.1fs; entering "
                "quiesce for %.0fs. New writes will raise ProviderBusy "
                "until cooldown elapses.",
                self._graph_name, p95,
                self._quiesce_trigger_s, self._quiesce_cooldown_s,
            )

    async def _proj_query(self, cypher: str, params: dict = None, *, timeout: float = None,
                          op: Optional[str] = None):
        """Timeout-guarded write query on the projection graph.

        Phase 2: also gated by ``_write_semaphore`` (per-graph hard cap
        on concurrent writes) and the latency-quiesce circuit. Records
        observed latency for the p95 trip decision.

        ``op`` is additive (the other four chokepoints already take it) so
        ``FalkorDBExecutor.run`` can pass its op label uniformly; unused
        here, since -- unlike the other four -- this one calls
        ``_run_guarded`` directly rather than ``_guarded_timed``, so it has
        no slow-query telemetry line to feed.
        """
        # Quiesce gate — raises ``ProviderBusy`` if the provider is
        # currently in cooldown after a sustained p95 spike. Worker
        # treats this as park-and-resume (not retry).
        self._check_quiesce_gate()

        t = timeout if timeout is not None else self._WRITE_TIMEOUT

        async def _call():
            t_start = time.monotonic()
            try:
                return await asyncio.wait_for(
                    self._proj.query(
                        cypher, params=params or {},
                        timeout=self._db_timeout_ms(t),
                    ),
                    timeout=t,
                )
            finally:
                # Record latency regardless of success/failure so quiesce
                # trips even when slow writes are also erroring out (the
                # symptom we'd want to back off from).
                self._record_write_latency(time.monotonic() - t_start)

        async with self._write_semaphore:
            async with self._query_semaphore:
                return await self._run_guarded(_call)

    @functools.cached_property
    def executor(self) -> FalkorDBExecutor:
        """Adapter over the source-graph chokepoints (``_ro_query`` /
        ``_query`` / ``_ro_query_tolerant``). Cached on the instance via
        ``functools.cached_property`` (this getter runs at most once) and
        built lazily so a ``__new__``-built test instance (no ``__init__``)
        still gets one on first access. Caching the executor object does
        NOT cache the chokepoint lookup: ``FalkorDBExecutor.run`` /
        ``run_tolerant`` still look the chokepoint up on ``self`` fresh on
        every call, so a test that patches ``p._ro_query = fake`` keeps
        intercepting no matter how many times ``self.executor`` was
        accessed first.

        Not ``self.__dict__.setdefault("_executor", FalkorDBExecutor(self,
        "source"))``: Python evaluates a call's arguments before the call,
        so that form constructs a (discarded) ``FalkorDBExecutor`` on
        every access after the first -- a cost ``cached_property`` makes
        structurally impossible (a non-data descriptor: after the first
        access, the value lives in the instance's own ``__dict__`` and
        this getter never runs again) rather than merely avoided.
        """
        return FalkorDBExecutor(self, "source")

    @functools.cached_property
    def projection_executor(self) -> FalkorDBExecutor:
        """Adapter over the projection-graph chokepoints (``_proj_ro_query``
        / ``_proj_query``). A separate instance from ``executor``, not the
        same one with a different target: ``_proj_query`` carries the
        quiesce gate and the write semaphore, and ``_proj`` resolves to
        ``_graph`` only in ``"in_source"`` projection mode -- the two
        targets differ in policy, not just in handle.

        See ``executor`` above for why this is ``cached_property`` rather
        than ``self.__dict__.setdefault(...)``.
        """
        return FalkorDBExecutor(self, "projection")

    @functools.cached_property
    def dialect(self) -> CypherDialect:
        """The FalkorDB dialect object -- see ``backend.common.providers.
        cypher.dialect.CypherDialect`` and ``backend.app.providers.
        falkordb.dialect.FALKORDB_DIALECT``. Same lazy ``cached_property``
        pattern as ``executor``/``projection_executor`` above, for the
        same ``__new__`` reason (a test instance built without
        ``__init__`` still gets one on first access).

        Unlike the executor, ``FALKORDB_DIALECT`` needs no per-instance
        state -- it is one shared, immutable, module-level value, so a
        plain ``@property`` would be equally correct here. Caching it
        anyway keeps this seam and the executor seam mechanically
        identical, at zero extra cost.
        """
        return FALKORDB_DIALECT

    # `list_graphs` and `close` were lines 10496-10594 of provider.py
    # before this split — not contiguous with the block above.
    # ------------------------------------------------------------------ #
    # ProviderRegistry lifecycle helpers                                   #
    # ------------------------------------------------------------------ #

    async def list_graphs(self) -> list:
        """Return all graph keys on this FalkorDB instance via GRAPH.LIST.

        Raises on connection / auth / timeout failure so the discovery
        worker can stamp ``last_error`` and the UI can surface a
        reachable-failure reason (e.g. "tcp_refused: localhost:6379")
        instead of an empty list that the user can't distinguish from
        "no graphs exist". Only an empty result is normalised to ``[]``.
        """
        await self._ensure_connected()
        # On a CLUSTER, self._db is pinned to ONE node and a node only holds the
        # graph keys in its own slots — a single-node GRAPH.LIST silently
        # UNDER-reports (insights discovery would show a partial asset list). Fan
        # out over every primary and union, exactly as list_graph_keys_for_config
        # does for the registry path.
        if self._conn_cfg is not None and self._conn_cfg.mode == "cluster":
            from backend.app.providers.falkordb_connection import (
                list_graph_keys_for_config,
            )
            keys = await asyncio.wait_for(
                list_graph_keys_for_config(self._conn_cfg),
                timeout=self._READ_TIMEOUT,
            )
            return sorted(keys)
        # GRAPH.LIST is a one-off Redis-protocol command on the FalkorDB
        # client (not Cypher, not the TimeoutRedis proxy) so it has no
        # natural wrapper.  Bound it inline at the read-query timeout to
        # honour the per-operation deadline contract.
        result = await asyncio.wait_for(
            self._db.execute_command("GRAPH.LIST"),
            timeout=self._READ_TIMEOUT,
        )
        return list(result) if result else []

    async def close(self) -> None:
        """Release both connection pools held by this provider."""
        # Pool teardown still hits the network (graceful socket close) so it
        # qualifies under the per-operation deadline contract.  Use the
        # short init/teardown timeout — a stuck shutdown should fail fast,
        # not block the event loop forever.
        _close_timeout = float(os.getenv("FALKORDB_INIT_TIMEOUT", "3"))

        # P1.7 — cancel any in-flight reconcile task FIRST so it doesn't
        # keep using the pool we're about to close. Without this:
        #   - shutdown can stall (reconcile holds a Redis connection that
        #     keeps the pool's aclose() waiting)
        #   - on eviction-then-rebuild, two reconcile tasks can race on
        #     the same FalkorDB graph (idempotent CREATE INDEX is fine,
        #     but the warnings spam logs)
        reconcile_task = getattr(self, "_reconcile_task", None)
        if reconcile_task is not None and not reconcile_task.done():
            reconcile_task.cancel()
            try:
                await asyncio.wait_for(reconcile_task, timeout=0.5)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
            except Exception as exc:
                logger.warning(
                    "FalkorDB reconcile task raised on close: %s", exc,
                )
        # Reset so a re-instantiated provider can schedule a fresh
        # reconcile without colliding with the cancelled one.
        self._reconcile_task = None
        self._reconcile_started = False

        try:
            if hasattr(self, "_redis") and self._redis is not None:
                await asyncio.wait_for(self._redis.aclose(), timeout=_close_timeout)
            if self._redis_pool is not None:
                await asyncio.wait_for(self._redis_pool.aclose(), timeout=_close_timeout)
            # Close the graph CLIENTS as well as the pinned pools: in cluster mode
            # the client is a RedisCluster owning a pool per node, so closing
            # self._pool alone leaked every node pool. _proj_db is self._db outside
            # cluster mode, where the second close is a harmless no-op.
            from backend.app.providers.falkordb_connection import aclose_graph_client

            await asyncio.wait_for(
                aclose_graph_client(self._db, self._pool), timeout=_close_timeout,
            )
            if self._proj_db is not None:
                await asyncio.wait_for(
                    aclose_graph_client(self._proj_db, self._proj_pool),
                    timeout=_close_timeout,
                )
        except Exception as exc:
            logger.warning("Error closing FalkorDB pools: %s", exc)
        finally:
            self._graph = None
            self._proj_graph = None
            self._pool = None
            self._proj_pool = None
            self._redis_pool = None
            self._redis = None
            self._db = None
            self._proj_db = None
