"""FalkorDB connection factory — standalone / Sentinel / Cluster.

A single FalkorDB graph key lives entirely on ONE Redis node, so Redis
Cluster does NOT shard a single graph. This factory therefore routes the
FalkorDB client to the *one* node that owns the graph key (Cluster),
follows the master on failover (Sentinel), or connects directly
(standalone) — selected by operator config, behaving correctly in each.

We build the async redis client for the resolved topology OURSELVES and bind
the FalkorDB facade to it (``falkordb_over``) — we never let
``FalkorDB.__init__`` construct it. That constructor sniffs the topology with
a **synchronous** ``INFO`` on the event loop (an app-wide freeze against a hung
node) and, in cluster mode, rebuilds the client while silently dropping our
socket timeouts, pool cap, health check and TLS. We already know the mode from
config, so the sniff is both dangerous and pointless. See ``falkordb_over``.

Pools are rebuilt on failover / MOVED (see
``FalkorDBProvider._rebuild_graph_client_for_failover``).

Config rides the provider record's ``extra_config`` JSON (no migration):

    "falkordbConnection": {
      "mode": "standalone|sentinel|cluster",
      "sentinel": {"masterName": "mymaster", "nodes": [["h1", 26379]],
                   "authEnabled": false,
                   "tls": {"enabled": true, "caCertPath": "..."}},
      "cluster":  {"startupNodes": [["h1", 6379], ["h2", 6379]]},
      "tls": {"enabled": true, "caCertPath": "...", "certPath": "...",
              "keyPath": "...", "verifyMode": "required", "checkHostname": true},
      "addressRemap": {"10.0.0.5:6379": "edge.example.com:6379"},
      "socketTimeout": 10, "connectTimeout": 2, "graphPoolSize": 24,
      "probeDeadlineS": 6, "authEnabled": true
    }

``sentinel.tls`` defaults to the data-plane ``tls`` (absent → inherit; an
explicit ``enabled: false`` gives a TLS data plane with plaintext sentinel
daemons). ``addressRemap`` rewrites DISCOVERED addresses (cluster slot map /
MOVED redirects / sentinel-announced master — typically pod IPs unreachable
from another cluster) before they are dialed; see ``remap_address``.
``connectTimeout``/``probeDeadlineS`` raise the dial/probe budgets for a
single cross-cluster provider without fleet-wide env changes.

Env-var fallbacks (when the JSON is absent): ``FALKORDB_MODE``,
``FALKORDB_SENTINEL_MASTER``, ``FALKORDB_SENTINEL_NODES``,
``FALKORDB_CLUSTER_NODES`` (the *_NODES vars accept "h1:port,h2:port"),
``FALKORDB_SENTINEL_TLS_ENABLED``, ``FALKORDB_ADDRESS_REMAP`` (from=to CSV). The
ENV-configured (unrouted) default instance additionally authenticates via
``FALKORDB_USERNAME`` / ``FALKORDB_PASSWORD`` / ``FALKORDB_PASSWORD_FILE`` —
see ``env_conn_config``. Provider rows keep resolving their own credentials
from the encrypted credentials blob, never from these env vars.
"""
import asyncio
import hashlib
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
    # Auth for the Sentinel DAEMONS themselves (separate service from the data
    # plane). Default: none — see load_connection_config.
    sentinel_username: Optional[str] = None
    sentinel_password: Optional[str] = None
    sentinel_auth_enabled: bool = False
    # TLS for the Sentinel DAEMONS themselves. None → inherit the data-plane
    # TLS settings (a "TLS everywhere" deployment needs no extra config);
    # an explicit ``sentinel.tls`` object overrides per key, and
    # ``sentinel.tls.enabled=false`` gives a TLS data plane with plaintext
    # sentinels. See load_connection_config.
    sentinel_tls: Optional[TLSSettings] = None
    cluster_nodes: List[Tuple[str, int]] = field(default_factory=list)
    # Per-provider advanced knobs (None → fall back to env defaults at the
    # call site). socket_timeout bounds a single Cypher query; graph_pool_size
    # is the max graph-query connection pool size; socket_connect_timeout
    # (JSON key connectTimeout) bounds the TCP+TLS+AUTH dial — cross-cluster
    # providers legitimately need more than the 2s global default, and this
    # lets ONE slow provider get it without a fleet-wide env change.
    socket_timeout: Optional[float] = None
    graph_pool_size: Optional[int] = None
    socket_connect_timeout: Optional[float] = None
    # probeDeadlineS EXTENDS (never shrinks) every fixed probe/verify budget —
    # the warmup preflight deadline, the connect verify-ping wall clock, and
    # the manual test-endpoint deadline — for one slow cross-cluster provider.
    probe_deadline_s: Optional[float] = None
    # Cross-cluster address remap: pairs of ("host[:port]", "host[:port]").
    # Redis announces the addresses IT knows (cluster slot map, sentinel
    # discover-master) — pod IPs that a client in ANOTHER GKE cluster cannot
    # reach. The remap rewrites every DISCOVERED address before it is dialed;
    # empty (the default) is a strict no-op. See remap_address().
    address_remap: Tuple[Tuple[str, str], ...] = ()
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

    def sentinel_tls_settings(self) -> TLSSettings:
        """TLS for connections to the Sentinel daemons: the explicit
        ``sentinel.tls`` override when configured, else the data-plane settings."""
        return self.sentinel_tls or self.tls_settings()

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


def _split_host_port(s: str) -> Tuple[str, Optional[int]]:
    """``"h:6379"`` → ``("h", 6379)``; ``"h"`` → ``("h", None)``."""
    host, _, port = s.rpartition(":")
    if host and port.isdigit():
        return host, int(port)
    return s, None


def _parse_address_remap(raw: Any) -> Tuple[Tuple[str, str], ...]:
    """Parse the addressRemap config into normalized ``(from, to)`` pairs.

    Accepts:
      - ``{"10.0.0.5:6379": "graph.example.com:6379", "old-host": "new-host"}``
        (the ``falkordbConnection.addressRemap`` JSON object)
      - ``"10.0.0.5:6379=graph.example.com:6379,old=new"``
        (the ``FALKORDB_ADDRESS_REMAP`` env CSV)
    Both sides take ``host`` or ``host:port``. Malformed entries are skipped
    with a warning (same convention as ``_parse_nodes``).
    """
    if not raw:
        return ()
    if isinstance(raw, str):
        items = []
        for chunk in raw.split(","):
            chunk = chunk.strip()
            if not chunk:
                continue
            src, sep, dst = chunk.partition("=")
            if not sep:
                logger.warning(
                    "falkordb_connection: ignoring addressRemap entry %r "
                    "(expected from=to)", chunk,
                )
                continue
            items.append((src.strip(), dst.strip()))
    elif isinstance(raw, dict):
        items = [(str(k).strip(), str(v).strip()) for k, v in raw.items()]
    else:
        logger.warning(
            "falkordb_connection: ignoring addressRemap of type %s "
            "(expected object or from=to CSV)", type(raw).__name__,
        )
        return ()
    out = []
    for src, dst in items:
        if not src or not dst:
            logger.warning(
                "falkordb_connection: ignoring addressRemap entry %r=%r "
                "(empty side)", src, dst,
            )
            continue
        out.append((src, dst))
    return tuple(out)


def remap_address(cfg: FalkorDBConnConfig, host: str, port: int) -> Tuple[str, int]:
    """Rewrite a DISCOVERED address through the operator's addressRemap.

    An exact ``host:port`` entry wins over a host-only entry; a host-only
    entry preserves the port unless its target names one. No entry → the
    address passes through untouched (and an empty remap is a strict no-op).

    Applied at every point a topology-discovered address is dialed: the
    cluster slot-owner lookup, the primaries fan-out, the RedisCluster's own
    MOVED/ASK redirects (redis-py's ``address_remap`` hook), and the sentinel
    master discovery. The addresses the OPERATOR configured (startup nodes,
    sentinel nodes, host/port) are never remapped — they are reachable by
    definition, and remapping them would make the config lie about itself.
    """
    port = int(port)
    if not cfg.address_remap:
        return host, port
    host_only_target: Optional[str] = None
    for src, dst in cfg.address_remap:
        s_host, s_port = _split_host_port(src)
        if s_port is not None:
            if s_host == host and s_port == port:
                d_host, d_port = _split_host_port(dst)
                mapped = (d_host, d_port if d_port is not None else port)
                logger.debug(
                    "falkordb_connection: remapped %s:%d -> %s:%d",
                    host, port, mapped[0], mapped[1],
                )
                return mapped
        elif s_host == host and host_only_target is None:
            host_only_target = dst
    if host_only_target is not None:
        d_host, d_port = _split_host_port(host_only_target)
        mapped = (d_host, d_port if d_port is not None else port)
        logger.debug(
            "falkordb_connection: remapped %s:%d -> %s:%d",
            host, port, mapped[0], mapped[1],
        )
        return mapped
    return host, port


def _address_remap_kwargs(cfg: FalkorDBConnConfig) -> dict:
    """The redis-py ``RedisCluster(address_remap=...)`` hook, or nothing.

    Verified against redis-py 8 (``redis.asyncio.cluster.RedisCluster``):
    ``address_remap: Optional[Callable[[Tuple[str, int]], Tuple[str, int]]]``,
    applied by the NodesManager to every discovered node address — which is
    what keeps MOVED/ASK redirects dialable from another cluster.
    """
    if not cfg.address_remap:
        return {}
    return {"address_remap": lambda addr: remap_address(cfg, addr[0], addr[1])}


def load_connection_config(
    explicit: Optional[dict],
    *,
    host: str,
    port: int,
    username: Optional[str],
    password: Optional[str],
    tls_enabled: bool = False,
    credentials: Optional[dict] = None,
) -> FalkorDBConnConfig:
    """Resolve a ``FalkorDBConnConfig`` from explicit provider config and
    env-var fallbacks. An absent/unknown mode resolves to ``standalone`` so
    the default path is byte-for-byte the legacy single-host behavior.

    ``tls_enabled`` is the provider record's connection-level TLS flag; the
    finer-grained ``falkordbConnection.tls`` object (CA / client cert / key /
    verify mode) layers on top, with ``FALKORDB_TLS_*`` env fallbacks.

    ``credentials`` is the provider's DECRYPTED credentials blob (from
    ``provider_repo.get_credentials`` / ``connection_repo.get_credentials``),
    if the caller already has it. It is where sentinel-daemon credentials
    (``sentinel_username`` / ``sentinel_password``) live now; the old
    ``explicit["sentinel"]`` plaintext location is still read as a fallback —
    see the sentinel resolution below.
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
    tls_ca = tls.get("caCertPath") or os.getenv("FALKORDB_TLS_CA_CERTS")
    tls_cert = tls.get("certPath") or os.getenv("FALKORDB_TLS_CERTFILE")
    tls_key = tls.get("keyPath") or os.getenv("FALKORDB_TLS_KEYFILE")
    tls_reqs = (
        tls.get("verifyMode") or os.getenv("FALKORDB_TLS_CERT_REQS") or "required"
    )
    tls_check = _as_bool(
        tls.get("checkHostname", os.getenv("FALKORDB_TLS_CHECK_HOSTNAME", True)),
        True,
    )
    # Sentinel-daemon TLS. The daemons are a separate listener that may (or may
    # not) terminate TLS independently of the data plane. When neither the
    # ``sentinel.tls`` object nor FALKORDB_SENTINEL_TLS_ENABLED is present the
    # field stays None and ``sentinel_tls_settings()`` INHERITS the data-plane
    # settings — a "TLS everywhere" deployment needs no extra config. Explicit
    # keys override individually (own CA, own verify mode); an explicit
    # ``enabled: false`` gives a TLS data plane with plaintext sentinels.
    sentinel_tls_json = sentinel.get("tls") if isinstance(sentinel.get("tls"), dict) else None
    sentinel_tls_env = os.getenv("FALKORDB_SENTINEL_TLS_ENABLED")
    sentinel_tls: Optional[TLSSettings] = None
    if sentinel_tls_json is not None or sentinel_tls_env is not None:
        st = sentinel_tls_json or {}
        st_enabled = st.get("enabled")
        if st_enabled is None:
            st_enabled = sentinel_tls_env if sentinel_tls_env is not None else tls_on
        st_check = st.get("checkHostname")
        sentinel_tls = TLSSettings.from_fields(
            enabled=_as_bool(st_enabled, tls_on),
            ca_certs=st.get("caCertPath") or tls_ca,
            certfile=st.get("certPath") or tls_cert,
            keyfile=st.get("keyPath") or tls_key,
            cert_reqs=st.get("verifyMode") or tls_reqs,
            check_hostname=(
                _as_bool(st_check, tls_check) if st_check is not None else tls_check
            ),
        )
    # Sentinel-daemon credentials. These USED to live in
    # extra_config.falkordbConnection.sentinel — an unencrypted column that the
    # API returns (ProviderResponse.extra_config). They now come from the
    # decrypted credentials blob (ConnectionCredentials.sentinel_username /
    # .sentinel_password); the old plaintext location is still read as a
    # fallback for one release so existing rows keep working, with a warning
    # telling the operator to re-save the provider to migrate it.
    sentinel_username = credentials.get("sentinel_username") if credentials else None
    sentinel_password = credentials.get("sentinel_password") if credentials else None
    if sentinel_password is None and sentinel.get("password"):
        logger.warning(
            "falkordb_connection: sentinel.password is set in extra_config "
            "(PLAINTEXT, and returned by the API). Re-save the provider to move "
            "it into the encrypted credentials blob (sentinel_password)."
        )
        sentinel_password = sentinel.get("password")
    if sentinel_username is None:
        sentinel_username = sentinel.get("username")
    sentinel_username = sentinel_username or os.getenv("FALKORDB_SENTINEL_USERNAME")
    sentinel_password = sentinel_password or _env_secret(
        "FALKORDB_SENTINEL_PASSWORD", "FALKORDB_SENTINEL_PASSWORD_FILE"
    )
    # Single normalization chokepoint: ""/whitespace-only → None, and a
    # username without a password is dropped (see normalize_credentials).
    username, password = normalize_credentials(username, password)
    sentinel_username, sentinel_password = normalize_credentials(
        sentinel_username, sentinel_password, context="FalkorDB sentinel",
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
        # Sentinel DAEMONS authenticate separately from the data plane (they are a
        # different service on a different port). Explicit creds win; otherwise
        # ``authEnabled: true`` opts into reusing the FalkorDB credentials; the
        # default is NO auth to the sentinels — sending AUTH to an unauthenticated
        # sentinel makes redis-py raise, which used to make discover_master fail and
        # take sentinel mode down entirely.
        sentinel_username=sentinel_username,
        sentinel_password=sentinel_password,
        sentinel_auth_enabled=_as_bool(
            sentinel.get(
                "authEnabled", os.getenv("FALKORDB_SENTINEL_AUTH_ENABLED", False),
            ),
            False,
        ),
        sentinel_tls=sentinel_tls,
        cluster_nodes=_parse_nodes(
            cluster.get("startupNodes") or os.getenv("FALKORDB_CLUSTER_NODES")
        ),
        address_remap=_parse_address_remap(
            cfg.get("addressRemap") or os.getenv("FALKORDB_ADDRESS_REMAP")
        ),
        socket_timeout=_coerce_float(cfg.get("socketTimeout")),
        graph_pool_size=_coerce_int(cfg.get("graphPoolSize")),
        socket_connect_timeout=_coerce_float(cfg.get("connectTimeout"), "connectTimeout"),
        probe_deadline_s=_coerce_float(cfg.get("probeDeadlineS"), "probeDeadlineS"),
        tls_enabled=tls_on,
        tls_ca_certs=tls_ca,
        tls_certfile=tls_cert,
        tls_keyfile=tls_key,
        tls_cert_reqs=tls_reqs,
        tls_check_hostname=tls_check,
    )


async def verify_not_cluster_node(
    cfg: FalkorDBConnConfig, pool: Any, timeout: float,
) -> None:
    """Reject a STANDALONE-mode config pointed at a multi-shard Redis Cluster.

    A standalone client against a cluster node sees only that node's slots:
    keyless GRAPH.LIST silently under-reports (a random third of the graphs,
    varying per connection behind a load-balanced Service), and keyed commands
    fail with bare ``MOVED`` ResponseErrors nothing classifies. One bounded
    ``INFO cluster`` at client-BUILD time (never per query); fail-open on INFO
    errors — this guard must never take a healthy standalone instance down.

    Cluster-of-one exemption: a single master owning all 16384 slots serves a
    standalone client completely and correctly (no MOVED possible, listings
    complete), so only ``cluster_size > 1`` is rejected — a working
    single-shard deployment must not go down over a mode label. The mismatch
    itself needs positive evidence (cluster_enabled parsed from INFO); the
    exemption also needs positive evidence (cluster_size parsed as 1).
    """
    if cfg.mode != "standalone":
        return
    from redis.asyncio import Redis

    client = Redis(connection_pool=pool)
    try:
        info = await asyncio.wait_for(client.info("cluster"), timeout=timeout)
    except Exception:                                # pragma: no cover - fail-open
        return
    enabled = info.get("cluster_enabled", 0) if isinstance(info, dict) else 0
    if str(enabled).strip().lower() not in ("1", "true"):
        return
    size = None
    try:
        raw = await asyncio.wait_for(
            client.execute_command("CLUSTER", "INFO"), timeout=timeout,
        )
        text = raw.decode(errors="replace") if isinstance(raw, bytes) else str(raw)
        for ln in text.splitlines():
            if ln.startswith("cluster_size:"):
                size = int(ln.split(":", 1)[1].strip())
    except Exception:                                # pragma: no cover - see below
        size = None                                  # confirmed cluster still rejects
    if size == 1:
        logger.warning(
            "FalkorDB at %s:%d is a single-shard Redis Cluster served over a "
            "standalone-mode provider config — works today, but breaks the "
            "moment a second shard is added. Consider falkordbConnection."
            "mode=cluster.", cfg.host, cfg.port,
        )
        return
    raise ProviderConfigurationError(
        f"FalkorDB at {cfg.host}:{cfg.port} is a Redis Cluster node but this "
        f"provider is configured mode=standalone — a standalone client sees "
        f"only one node's graphs (listings under-report; queries hit MOVED). "
        f"Set falkordbConnection.mode=cluster with cluster.startupNodes (or "
        f"FALKORDB_MODE=cluster + FALKORDB_CLUSTER_NODES)."
    )


def connect_verify_budget(cfg: FalkorDBConnConfig, default_s: float) -> float:
    """Wall clock for the connect-verifying PING (and similar fixed probe
    windows). The fleet default must EXTEND for a provider configured for a
    slow cross-cluster hop, never clip it: the budget is at least the
    configured dial timeout plus one ping, and at least ``probeDeadlineS``.
    """
    return max(
        default_s,
        cfg.probe_deadline_s or 0.0,
        (cfg.socket_connect_timeout or 0.0) + 1.0,
    )


def _coerce_float(v: Any, name: str = "socketTimeout") -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        logger.warning("falkordb_connection: ignoring non-numeric %s %r", name, v)
        return None


def _coerce_int(v: Any) -> Optional[int]:
    if v is None or v == "":
        return None
    try:
        return int(v)
    except (ValueError, TypeError):
        logger.warning("falkordb_connection: ignoring non-integer graphPoolSize %r", v)
        return None


def _read_env_secret_file(path: str, var: str) -> str:
    """Read a mounted secret file. A missing OR empty/whitespace-only file is a
    HARD error — silently falling back to 'no password' is exactly how an
    unauthenticated connect reaches production, whether the file is absent or
    just empty (mount race, bad rotation).

    Mirrors ``backend.common.adapters.redis_endpoint``'s ``_read_secret_file``
    rule-for-rule, but independently implemented: FalkorDB's credentials must
    never share a code path (or a value) with the CACHE/STREAMS Redis roles, so
    a bug or a future change in one role's secret handling can't silently reach
    the other. Never includes the secret VALUE in the error — only the env var
    name and the path.
    """
    try:
        with open(path, "r", encoding="utf-8") as fh:
            content = fh.read().strip()
    except OSError as exc:
        raise ProviderConfigurationError(
            f"{var}={path!r} could not be read: {exc}. Refusing to connect "
            f"without the credential it names."
        ) from exc
    if not content:
        raise ProviderConfigurationError(
            f"{var}={path!r} is empty. Refusing to connect without the "
            f"credential it names."
        )
    return content


def _env_secret(env_var: str, file_var: str) -> Optional[str]:
    """``{file_var}`` (a mounted secret file — wins) or plain ``{env_var}``."""
    path = os.getenv(file_var)
    if path:
        return _read_env_secret_file(path, file_var)
    return os.getenv(env_var)


def normalize_credentials(
    username: Optional[str], password: Optional[str], *, context: str = "FalkorDB",
) -> Tuple[Optional[str], Optional[str]]:
    """Collapse every spelling of "no credential" into ``None``.

    ``""`` and whitespace-only values already behave as absent in the kwargs
    builders (truthiness checks) but NOT in ``TopologyGraphClients.identity``
    or the learned-auth set — so ``username=""`` and ``username=None`` used to
    be two different instances, and a learned-unauth mark or a cache
    invalidation recorded under one spelling missed the other.

    A username WITHOUT a password is dropped entirely: the kwargs builders
    would make redis-py send ``AUTH <user> ""`` (→ WRONGPASS) while the raw
    RESP preflight sends no AUTH at all (it gates on the password) — the two
    paths returned contradictory verdicts for the same misconfigured row.
    Values with real content are passed through UNTOUCHED (never stripped —
    a password may legitimately contain edge whitespace).
    """
    if isinstance(username, str) and not username.strip():
        username = None
    if isinstance(password, str) and not password.strip():
        password = None
    if username and not password:
        logger.warning(
            "%s: a username is configured without a password — ignoring the "
            "username (redis AUTH needs both; set a password or clear the "
            "username).", context,
        )
        username = None
    return username, password


def resilient_pool_kwargs(
    *,
    socket_timeout: Optional[float] = None,
    connect_timeout: Optional[float] = None,
) -> dict:
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
    if connect_timeout is None:
        connect_timeout = _resilience.FALKORDB_SOCKET_CONNECT_TIMEOUT_SECS
    return {
        "socket_connect_timeout": connect_timeout,
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


def _sentinel_class(cfg: FalkorDBConnConfig):
    """The ``Sentinel`` class to construct for ``cfg`` — plain when no remap is
    configured (byte-for-byte the existing behavior), else a subclass whose
    discovered addresses go through ``remap_address``.

    Needed because ``master_for`` dials whatever ``discover_master`` returns
    INTERNALLY on every (re)connect — the transparent-failover property — so a
    return-value rewrite at our call sites cannot reach it.
    """
    from redis.asyncio.sentinel import Sentinel

    if not cfg.address_remap:
        return Sentinel

    class _RemapSentinel(Sentinel):
        async def discover_master(self, service_name):
            host, port = await super().discover_master(service_name)
            return remap_address(cfg, host, int(port))

        async def discover_slaves(self, service_name):
            slaves = await super().discover_slaves(service_name)
            return [remap_address(cfg, h, int(p)) for h, p in slaves]

    return _RemapSentinel


def _conn_auth_kwargs(cfg: FalkorDBConnConfig, socket_timeout: float) -> dict:
    """Connection kwargs shared by the high-level Sentinel/Cluster clients —
    auth + timeouts + TLS (``ssl=True`` + cert paths when enabled)."""
    cfg = apply_learned_auth(cfg)       # skip AUTH on an instance known to have none
    kw: dict = {
        "socket_connect_timeout": (
            cfg.socket_connect_timeout
            or _resilience.FALKORDB_SOCKET_CONNECT_TIMEOUT_SECS
        ),
        "socket_timeout": socket_timeout,
        "decode_responses": True,
    }
    if cfg.username:
        kw["username"] = cfg.username
    if cfg.password:
        kw["password"] = cfg.password
    kw.update(tls_client_kwargs(cfg.tls_settings()))
    return kw


# ── Authentication: every combination of (instance auth on/off) × (creds present/absent)
#
# Three distinct outcomes, and they must NOT be confused with an outage:
#
#   auth_not_configured — we sent credentials, the instance has no password. Whether
#       this even errors depends on the server's ACL and the RESP version redis-py
#       negotiates (a `nopass` default user accepts any password over HELLO AUTH; a
#       plain RESP2 AUTH against the same server errors). SELF-HEAL: drop the
#       credentials for that instance and reconnect — a stale password on a provider
#       row must never take a healthy graph offline.
#   auth_required   — NOAUTH: the instance wants credentials we don't have.
#   auth_rejected   — WRONGPASS / invalid: the credentials are wrong.
#
# The last two are CONFIGURATION errors, not network failures. That distinction is
# load-bearing: redis-py's AuthenticationError subclasses redis ConnectionError, so
# without this mapping the provider retried bad credentials as a "transient blip"
# (and, in cluster mode, re-resolved the topology for them) and the circuit breaker
# tripped — surfacing a misconfiguration as "provider unavailable" and hammering it
# with half-open probes forever. Mapped to ProviderConfigurationError they are
# LOGICAL errors: the breaker stays closed and the operator sees what's actually wrong.

_AUTH_NOT_CONFIGURED_MARKERS = (
    "without any password configured",      # Redis 6+/ACL wording
    "client sent auth, but no password is set",
)
_AUTH_REQUIRED_MARKERS = (
    "noauth",
    "authentication required",
    # redis-py's RESP3 handshake against an auth-enabled server WITHOUT credentials:
    # "HELLO must be called with the client already authenticated, otherwise the
    # HELLO <proto> AUTH <user> <pass> option can be used…". No 'NOAUTH' anywhere in
    # it — found by driving a real requirepass instance, not by reading the docs.
    "must be called with the client already authenticated",
)
_AUTH_REJECTED_MARKERS = (
    "wrongpass", "invalid username-password", "invalid password",
    "invalid username or password",
)

# Instances observed to reject AUTH because they have none configured. Keyed by the
# same identity the client cache uses, so the lesson is applied to every later build.
_UNAUTHENTICATED_INSTANCES: set = set()


def _auth_error_text(exc: BaseException) -> str:
    parts, seen, cur = [], 0, exc
    while cur is not None and seen < 4:
        parts.append(str(cur))
        cur = cur.__cause__ or cur.__context__
        seen += 1
    return " | ".join(parts).lower()


def is_auth_not_configured_error(exc: BaseException) -> bool:
    """We sent credentials; the instance has no authentication configured."""
    text = _auth_error_text(exc)
    return any(m in text for m in _AUTH_NOT_CONFIGURED_MARKERS)


def is_auth_required_error(exc: BaseException) -> bool:
    """The instance requires credentials (NOAUTH)."""
    text = _auth_error_text(exc)
    return any(m in text for m in _AUTH_REQUIRED_MARKERS)


def is_auth_rejected_error(exc: BaseException) -> bool:
    """Credentials were supplied and rejected."""
    text = _auth_error_text(exc)
    return any(m in text for m in _AUTH_REJECTED_MARKERS)


def is_auth_error(exc: BaseException) -> bool:
    return (
        is_auth_not_configured_error(exc)
        or is_auth_required_error(exc)
        or is_auth_rejected_error(exc)
    )


def strip_credentials(cfg: FalkorDBConnConfig) -> FalkorDBConnConfig:
    from dataclasses import replace

    return replace(cfg, username=None, password=None)


def mark_instance_unauthenticated(cfg: FalkorDBConnConfig) -> None:
    _UNAUTHENTICATED_INSTANCES.add(TopologyGraphClients.identity(strip_credentials(cfg)))


def unmark_instance_unauthenticated(cfg: FalkorDBConnConfig) -> None:
    """Forget that an instance is unauthenticated — the symmetric half of the
    self-heal. Called when a NOAUTH proves auth was (re-)enabled on the server,
    and on every config invalidation: without it the learned mark outlives the
    reality it recorded, credentials keep being stripped, and only a process
    restart recovers."""
    _UNAUTHENTICATED_INSTANCES.discard(
        TopologyGraphClients.identity(strip_credentials(cfg))
    )


def is_instance_learned_unauthenticated(cfg: FalkorDBConnConfig) -> bool:
    return (
        TopologyGraphClients.identity(strip_credentials(cfg))
        in _UNAUTHENTICATED_INSTANCES
    )


def apply_learned_auth(cfg: FalkorDBConnConfig) -> FalkorDBConnConfig:
    """Drop credentials for an instance we've already learned has no auth, so every
    later connection (any mode, any entry point) skips AUTH instead of re-failing."""
    if not (cfg.username or cfg.password):
        return cfg
    if TopologyGraphClients.identity(strip_credentials(cfg)) in _UNAUTHENTICATED_INSTANCES:
        return strip_credentials(cfg)
    return cfg


def raise_auth_config_error(cfg: FalkorDBConnConfig, exc: BaseException) -> None:
    """Translate an auth failure into an actionable configuration error (LOGICAL —
    never trips the circuit breaker, never retried as a transient blip).

    ``rejected`` is checked FIRST: the classifiers walk the __cause__/__context__
    chain, and a retry-with-credentials raised inside an ``except NOAUTH`` block
    carries both markers (WRONGPASS chained onto NOAUTH). A WRONGPASS anywhere in
    the chain proves credentials WERE supplied and rejected — reporting it as
    "no credentials configured" sent the operator chasing the wrong fix."""
    if is_auth_rejected_error(exc):
        raise ProviderConfigurationError(
            f"FalkorDB at {cfg.describe()} rejected the provider's credentials "
            f"(wrong username/password)."
        ) from exc
    if is_auth_required_error(exc):
        raise ProviderConfigurationError(
            f"FalkorDB at {cfg.describe()} requires authentication but no credentials "
            f"are configured for this provider — add them to the provider, or disable "
            f"auth on the instance."
        ) from exc


async def with_auth_negotiation(cfg: FalkorDBConnConfig, attempt: Callable[..., Any]) -> Any:
    """Run ``attempt(cfg)``, resolving the auth mismatch cases exactly once.

    * instance has no auth but we hold credentials → strip them, remember it for
      every later connection, and retry (a stale password never takes a graph down);
    * instance HAS auth but the learned-unauth mark stripped our credentials →
      un-learn, retry once WITH them (auth re-enabled on the server must not
      dead-end in a false "no credentials configured" until process restart);
    * instance wants credentials we lack, or rejects the ones we have → raise a clear
      ProviderConfigurationError instead of a retried, breaker-tripping "outage".

    At most two ``attempt`` calls per invocation — each branch retries once and
    maps a second failure to a configuration error, never a loop.
    """
    effective = apply_learned_auth(cfg)
    stripped_by_learned_mark = effective is not cfg
    try:
        return await attempt(effective)
    except Exception as exc:
        if is_auth_not_configured_error(exc) and (effective.username or effective.password):
            mark_instance_unauthenticated(effective)
            logger.warning(
                "FalkorDB at %s has NO authentication configured but this provider "
                "carries credentials — reconnecting without them. Clear the credentials "
                "on the provider (or set falkordbConnection.authEnabled=false) to silence "
                "this.", effective.describe(),
            )
            return await attempt(strip_credentials(effective))
        if is_auth_required_error(exc) and stripped_by_learned_mark:
            # NOAUTH on a connection we deliberately sent WITHOUT credentials:
            # authentication was (re-)enabled on the instance since we learned it
            # had none. Un-learn and retry once with the configured credentials —
            # the downstream builders' apply_learned_auth is a no-op after the
            # discard, so the retry really carries them.
            unmark_instance_unauthenticated(cfg)
            logger.warning(
                "FalkorDB at %s now REQUIRES authentication (it was previously "
                "observed unauthenticated) — retrying with the configured "
                "credentials.", cfg.describe(),
            )
            try:
                return await attempt(cfg)
            except Exception as exc2:
                raise_auth_config_error(cfg, exc2)
                raise
        raise_auth_config_error(effective, exc)
        raise


def _sentinel_auth_kwargs(cfg: FalkorDBConnConfig, socket_timeout: float) -> dict:
    """Connection kwargs for talking to the Sentinel DAEMONS (not the master).

    Sentinels are a separate service with their own auth. Passing the FalkorDB
    password to an UNAUTHENTICATED sentinel makes redis-py raise on the AUTH reply,
    which fails ``discover_master`` and takes sentinel mode down entirely — so
    credentials are sent only when explicitly configured (``sentinel.username`` /
    ``sentinel.password``) or when ``sentinel.authEnabled`` opts into reusing the
    data-plane credentials.

    TLS likewise: the daemons listen on their own port, and when that listener
    terminates TLS these kwargs must carry it or discovery dials the handshake
    port in PLAINTEXT (garbled reply / timeout → the whole tier reads as down).
    ``sentinel_tls_settings()`` inherits the data-plane TLS unless a
    ``sentinel.tls`` override says otherwise. This is the single chokepoint —
    every sentinel-daemon connection (build_graph_client, resolve_sentinel_master,
    the dashboard probes) goes through it.
    """
    kw: dict = {
        "socket_connect_timeout": (
            cfg.socket_connect_timeout
            or _resilience.FALKORDB_SOCKET_CONNECT_TIMEOUT_SECS
        ),
        "socket_timeout": socket_timeout,
    }
    # Dedicated daemon credentials win AS A UNIT: a dedicated password-only
    # daemon (default user + requirepass) must not get the data-plane username
    # spliced in via a per-field fallback — that mismatched pair fails AUTH
    # even though both halves are individually valid.
    if cfg.sentinel_username or cfg.sentinel_password:
        username, password = cfg.sentinel_username, cfg.sentinel_password
    elif cfg.sentinel_auth_enabled:
        username, password = cfg.username, cfg.password
    else:
        username = password = None
    if username:
        kw["username"] = username
    if password:
        kw["password"] = password
    kw.update(tls_client_kwargs(cfg.sentinel_tls_settings()))
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

    if not cfg.cluster_nodes:
        raise ProviderConfigurationError(
            "FalkorDB cluster mode requires cluster.startupNodes (or "
            "FALKORDB_CLUSTER_NODES)."
        )

    # Slot discovery authenticates too — an unauthenticated cluster must not become
    # unreachable just because a provider row carries a stale password.
    async def _discover(c: FalkorDBConnConfig) -> Tuple[str, int]:
        return await _resolve_cluster_node_once(c, graph_name, socket_timeout)

    return await with_auth_negotiation(cfg, _discover)


async def _resolve_cluster_node_once(
    cfg: FalkorDBConnConfig, graph_name: str, socket_timeout: float,
) -> Tuple[str, int]:
    from redis.asyncio.cluster import RedisCluster
    from redis.cluster import ClusterNode

    nodes = [ClusterNode(h, p) for h, p in cfg.cluster_nodes]
    # address_remap: discovery itself follows the slot map when a startup node
    # redirects, so even this short-lived client needs the rewrite.
    cluster = RedisCluster(
        startup_nodes=nodes,
        **_conn_auth_kwargs(cfg, socket_timeout),
        **_address_remap_kwargs(cfg),
    )
    try:
        # redis.asyncio.cluster initializes lazily; force it so the slot
        # map is populated before we look up the owning node.
        if hasattr(cluster, "initialize"):
            await cluster.initialize()
        slot = cluster.keyslot(graph_name)
        node = cluster.nodes_manager.get_node_from_slot(slot)
        # The slot map answers with the address the CLUSTER knows (a pod IP);
        # rewrite it into one the caller can actually dial.
        return remap_address(cfg, node.host, node.port)
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
    from redis.asyncio import ConnectionPool, Redis

    socket_timeout = float(pool_kwargs.get("socket_timeout", 10.0))
    # Raw ConnectionPool needs connection_class=SSLConnection + ssl_* kwargs
    # (it does NOT accept ssl=True); empty when TLS is disabled.
    _tls_pool = tls_pool_kwargs(cfg.tls_settings())

    if cfg.mode == "standalone":
        pool = ConnectionPool(host=cfg.host, port=cfg.port, **pool_kwargs, **_tls_pool)
        return falkordb_over(Redis(connection_pool=pool)), pool

    if cfg.mode == "sentinel":
        if not cfg.sentinel_master or not cfg.sentinel_nodes:
            raise ProviderConfigurationError(
                "FalkorDB sentinel mode requires sentinel.masterName and "
                "sentinel.nodes (or FALKORDB_SENTINEL_MASTER / "
                "FALKORDB_SENTINEL_NODES)."
            )
        # The MASTER pool must carry the caller's full pool kwargs — socket
        # timeouts AND socket_keepalive / health_check_interval — plus TLS. Passing
        # only max_connections+auth (as this did) silently dropped the idle-socket
        # health check in sentinel mode alone: after a failover, stale pooled
        # sockets stalled to the caller's asyncio.TimeoutError (which _run_guarded
        # refuses to retry, by design) instead of a retryable redis ConnectionError,
        # so the breaker opened where a transparent retry was intended. It also
        # force-set decode_responses=True, giving Sentinel deployments `str` where
        # standalone/cluster give the same callers `bytes`.
        master_kwargs = {**pool_kwargs, **tls_client_kwargs(cfg.tls_settings())}
        # Data-plane credentials: pool_kwargs normally carries them (both
        # build_graph_pool_kwargs and _build_pool_kwargs add them), but fall back to
        # the config so a caller passing bare pool kwargs can never end up connecting
        # to the master UNAUTHENTICATED.
        if cfg.username and "username" not in master_kwargs:
            master_kwargs["username"] = cfg.username
        if cfg.password and "password" not in master_kwargs:
            master_kwargs["password"] = cfg.password
        # _sentinel_class: plain Sentinel, or the remapping subclass when
        # addressRemap is configured — master_for re-runs discover_master on
        # every reconnect, so the rewrite must live INSIDE the class.
        sentinel = _sentinel_class(cfg)(
            cfg.sentinel_nodes,
            sentinel_kwargs=_sentinel_auth_kwargs(cfg, socket_timeout),
            **master_kwargs,
        )
        # ``master_for`` returns a Redis bound to a pool that transparently
        # re-resolves the master on failover (redis-py re-runs discover_master on
        # every (re)connect), so a promoted replica is picked up without a rebuild.
        master = sentinel.master_for(cfg.sentinel_master, **master_kwargs)
        return falkordb_over(master), master.connection_pool

    if cfg.mode == "cluster":
        host, port = await resolve_cluster_node_for_key(cfg, graph_name, socket_timeout)
        # Same defence as the sentinel branch: a caller handing us bare pool kwargs
        # must never reach an AUTHENTICATED cluster unauthenticated.
        node_kwargs = dict(pool_kwargs)
        if cfg.username and "username" not in node_kwargs:
            node_kwargs["username"] = cfg.username
        if cfg.password and "password" not in node_kwargs:
            node_kwargs["password"] = cfg.password
        # The data plane is a RedisCluster WE build (see ``build_cluster_conn``), so
        # it follows MOVED/ASK on a reshard and honours our timeouts, pool cap,
        # health check and TLS — none of which survive falkordb's own adapter.
        db = falkordb_over(build_cluster_conn(cfg, host, port, node_kwargs))
        # A pinned single-node pool to the OWNING node, kept for the caller's
        # connect-verifying ``Redis(connection_pool=pool).ping()`` and teardown:
        # it proves the node that actually serves this graph is reachable and
        # authenticating, which pinging an arbitrary cluster node would not.
        pool = ConnectionPool(host=host, port=port, **node_kwargs, **_tls_pool)
        # DEBUG: fires on every graph-client build — continuous at fleet scale
        # (discovery transients, rebuilds). The connect-time "connecting graph
        # via cluster(...)" line and the aggregated GRAPH.LIST fan-out line
        # carry the operational signal; per-graph routing is diagnostics.
        logger.debug(
            "falkordb_connection: cluster graph %r routed to owning node %s:%d%s",
            graph_name, host, port,
            " (TLS)" if _tls_pool else "",
        )
        return db, pool

    raise ProviderConfigurationError(f"Unsupported FalkorDB mode: {cfg.mode!r}")


def build_cache_client(
    *, provider_id: str, extra_config: Optional[dict], credentials: Optional[dict],
) -> Optional[Any]:
    """The provider's cache Redis — a DEDICATED endpoint, resolved centrally.

    Precedence: the provider's own ``extra_config.cacheConnection`` (+ its encrypted
    cache_* credentials), else the global ``REDIS_CACHE_*`` endpoint, else the legacy
    ``CACHE_REDIS_URL``. ``None`` means no cache is configured → cache disabled
    (best-effort), never co-located on FalkorDB (ADR-020).

    It no longer takes the FalkorDB ``FalkorDBConnConfig``: it used to derive its TLS
    from the GRAPH's certs, which produced "no TLS" or "system trust store" depending
    on the URL scheme. The cache owns its own PKI (ADR-021 follow-up).
    """
    from backend.common.adapters.redis_endpoint import (
        ProviderCacheOverride, RedisRole, build_redis_client, resolve_redis_config,
    )

    override = ProviderCacheOverride(
        provider_id=provider_id,
        connection=(extra_config or {}).get("cacheConnection") or {},
        credentials=credentials or {},
    )
    cfg = resolve_redis_config(RedisRole.CACHE, provider_cache=override)
    if not cfg.is_configured:
        return None                      # nothing configured anywhere → cache off
                                         # (is_configured understands sentinel mode,
                                         #  which has no host — a host-only check
                                         #  silently disabled a sentinel cache)
    return build_redis_client(cfg)


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
    cfg = apply_learned_auth(cfg)       # skip AUTH on an instance known to have none
    kw: dict = {
        "max_connections": (
            max_connections
            or cfg.graph_pool_size
            or int(os.getenv("FALKORDB_POOL_SIZE", "10"))
        ),
        **resilient_pool_kwargs(
            socket_timeout=socket_timeout,
            connect_timeout=cfg.socket_connect_timeout,
        ),
    }
    # Credentials only when we actually have them: once an instance is learned to
    # be unauthenticated, ``apply_learned_auth`` clears them and they must vanish
    # from EVERY pool builder (test_falkordb_auth_matrix).
    #
    # These keys were briefly forced present-as-None to survive the falkordb cluster
    # adapter, whose ``connection_kwargs.pop("username")`` had no default and raised
    # ``KeyError: 'username'`` against an unauthenticated cluster. We no longer route
    # through that adapter (see ``falkordb_over``), so the workaround is gone.
    if cfg.username:
        kw["username"] = cfg.username
    if cfg.password:
        kw["password"] = cfg.password
    return kw


def falkordb_over(conn: Any) -> Any:
    """Bind the FalkorDB facade to an async redis client WE already built.

    Never call ``FalkorDB(...)`` / ``FalkorDB(connection_pool=...)`` from the
    async path. Its ``__init__`` calls ``falkordb.asyncio.cluster.Is_Cluster()``,
    which opens a **synchronous** redis client and issues ``INFO`` to sniff the
    topology — blocking socket I/O executed on the event loop. Against a hung or
    blackholed node that blocks the WHOLE process (measured: **26s**), and
    ``asyncio.wait_for`` cannot interrupt it — a blocked loop never fires its own
    timer — so it defeats every timeout guard in ``_run_guarded`` and turns one
    unreachable provider into an app-wide freeze. It is also pure waste: we KNOW
    the topology from ``cfg.mode``.

    Sniffing aside, letting ``__init__`` build the client is actively wrong in
    cluster mode, where it hands the pool to ``Cluster_Conn`` — which rebuilds a
    ``RedisCluster`` from scratch, forwarding only host/port/auth/retry and
    silently DROPPING:

    * ``socket_timeout`` / ``socket_connect_timeout`` → redis-py's 5s defaults,
    * ``max_connections`` → 100 **per node** (10x our cap, per shard),
    * ``health_check_interval`` → 0, i.e. the idle-socket check is OFF, so stale
      sockets after a failover stall to ``asyncio.TimeoutError`` (which
      ``_run_guarded`` refuses to retry, by design) instead of a retryable
      ``ConnectionError``,
    * ``ssl`` → ``FalkorDB.__init__``'s own ``ssl`` param, which is ``False``
      whenever the caller passes ``connection_pool=`` — so a TLS pool silently
      became a **plaintext** data plane.

    It additionally popped those keys off the pool DESTRUCTIVELY, leaving the
    pool we hand back pointing at localhost:6379.

    The FalkorDB class's entire state is the three attributes assigned below
    (``falkordb/asyncio/falkordb.py:127-129``); ``select_graph()``,
    ``list_graphs()`` and ``config_get/set()`` all derive from ``self.connection``.
    So constructing the client ourselves and binding it here is complete — and
    every topology then honours the SAME pool kwargs.
    """
    from falkordb.asyncio import FalkorDB

    db = FalkorDB.__new__(FalkorDB)      # bypass __init__'s blocking topology sniff
    db.connection = conn
    db.flushdb = conn.flushdb
    db.execute_command = conn.execute_command
    return db


def build_cluster_conn(cfg: FalkorDBConnConfig, host: str, port: int, pool_kwargs: dict) -> Any:
    """A ``RedisCluster`` over ``cfg``'s topology, honouring OUR pool kwargs.

    Entered at the node we already resolved (``host``/``port``) with the rest of
    the cluster as startup nodes, so discovery still works if that node is down.
    RedisCluster applies ``max_connections`` PER node pool — the same per-endpoint
    semantics as the standalone pool.

    TLS goes on as ``ssl=True`` + ``ssl_*`` (``tls_client_kwargs``), NOT as
    ``connection_class=SSLConnection`` (``tls_pool_kwargs``): RedisCluster builds
    its own per-node pools and does not accept a connection_class.
    """
    from redis.asyncio.cluster import RedisCluster
    from redis.cluster import ClusterNode

    startup = [ClusterNode(h, p) for h, p in (cfg.cluster_nodes or [])
               if (h, p) != (host, port)]
    return RedisCluster(
        host=host, port=port, startup_nodes=startup or None,
        **pool_kwargs, **tls_client_kwargs(cfg.tls_settings()),
        # Every slot-map/MOVED/ASK address this client dials goes through the
        # operator's remap — the redirects announce pod IPs too.
        **_address_remap_kwargs(cfg),
    )


async def aclose_graph_client(db: Any, pool: Any) -> None:
    """Close BOTH halves of a ``(client, pool)`` entry, best effort.

    The client owns real sockets that the pool does not: in cluster mode it is a
    ``RedisCluster`` with a pool PER node, while ``pool`` is only the pinned
    owning-node pool kept for the connect-verifying ping. Closing the pool alone
    leaked every node pool.
    """
    conn = getattr(db, "connection", None)
    for closeable in (conn, pool):
        if closeable is None:
            continue
        try:
            await closeable.aclose()
        except Exception:                            # pragma: no cover - best effort
            pass


def build_node_client(
    cfg: FalkorDBConnConfig, host: str, port: int, pool_kwargs: dict,
) -> Tuple[Any, Any]:
    """A FalkorDB client bound to ONE already-resolved endpoint.

    Used when the caller has already discovered the owning cluster node (so the
    slot lookup is not repeated per graph) — TLS still applied here, since raw
    pools need ``connection_class=SSLConnection``.

    In CLUSTER mode the client is still a full ``RedisCluster`` entered at that
    node, not a plain pinned client: the node is the owner *now*, but a reshard or
    failover moves the slot, and only a cluster client follows the resulting
    MOVED/ASK. The pinned pool is returned alongside for the connect-verifying
    ping and teardown, exactly as in ``build_graph_client``.
    """
    from redis.asyncio import ConnectionPool, Redis

    pool = ConnectionPool(
        host=host, port=port, **pool_kwargs, **tls_pool_kwargs(cfg.tls_settings()),
    )
    conn = (
        build_cluster_conn(cfg, host, port, pool_kwargs)
        if cfg.mode == "cluster"
        else Redis(connection_pool=pool)
    )
    return falkordb_over(conn), pool


def env_conn_config() -> FalkorDBConnConfig:
    """Connection config for the ENV-configured default instance.

    Resolves ``FALKORDB_MODE`` / ``FALKORDB_SENTINEL_*`` / ``FALKORDB_CLUSTER_NODES``
    exactly like a provider row would — so the env-default (unrouted) graphs a
    deployment still has are reached over the right topology instead of being
    hard-wired to standalone.

    Data-plane credentials: ``FALKORDB_USERNAME`` / ``FALKORDB_PASSWORD`` /
    ``FALKORDB_PASSWORD_FILE`` (file wins; a missing or empty file is a hard
    error — never a silent fall-back to an unauthenticated connect). This is
    the ONLY credential source for this instance; none of the new vars set
    reproduces the old behaviour exactly (``username=None, password=None``).
    An authenticated PROVIDER ROW keeps resolving its own credentials from the
    encrypted credentials blob, unaffected by these env vars.
    """
    return load_connection_config(
        None,
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        username=os.getenv("FALKORDB_USERNAME"),
        password=_env_secret("FALKORDB_PASSWORD", "FALKORDB_PASSWORD_FILE"),
    )


def assert_standalone_env(script: str) -> None:
    """Fail fast when an ops script that speaks plain STANDALONE Redis is pointed at
    a Sentinel or Cluster instance.

    The seed/import/maintenance scripts under ``backend/scripts/`` build a direct
    ``FalkorDB(host, port)`` client. Against a Sentinel instance that can land on a
    demoted replica; against a Cluster it reaches only the slots of one node — so a
    wipe or ``GRAPH.DELETE`` would partially apply and a reindex would silently skip
    shards. Refusing to run is strictly better than half-doing it.

    Deployed services never call this: they route through the topology-aware client.
    """
    cfg = env_conn_config()
    if cfg.mode != "standalone":
        raise SystemExit(
            f"{script}: refusing to run — FALKORDB_MODE={cfg.mode!r} ({cfg.describe()}). "
            f"This script speaks standalone Redis only; on a {cfg.mode} instance it "
            f"would reach a single node (partial writes/deletes). Run it against a "
            f"standalone instance, or drive the change through the application "
            f"(which is topology-aware)."
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
            if is_auth_not_configured_error(exc) and (
                self._cfg.username or self._cfg.password
            ):
                # Auth was turned OFF on the instance (or the row's password is
                # stale) — drop the credentials, rebuild, retry once. A graph that
                # is up must not read as down because of a leftover secret.
                logger.warning(
                    "falkordb graph %r: instance has no authentication configured — "
                    "reconnecting without credentials.", self._name,
                )
                mark_instance_unauthenticated(self._cfg)
                await self._clients.invalidate(self._cfg, self._name)
                self._cfg = strip_credentials(self._cfg)
                self._graph = await self._clients.resolve_graph(self._cfg, self._name)
                return await getattr(self._graph, method)(*args, **kwargs)
            if (
                is_auth_required_error(exc)
                and (self._cfg.username or self._cfg.password)
                and is_instance_learned_unauthenticated(self._cfg)
            ):
                # The mirror case: our cached client was built WITHOUT credentials
                # because of the learned-unauth mark, and the instance now demands
                # them — auth was re-enabled on the server. Un-learn, rebuild WITH
                # the credentials this handle still carries, retry once.
                logger.warning(
                    "falkordb graph %r: instance now REQUIRES authentication "
                    "(previously observed unauthenticated) — reconnecting with "
                    "the configured credentials.", self._name,
                )
                unmark_instance_unauthenticated(self._cfg)
                await self._clients.invalidate(self._cfg, self._name)
                try:
                    self._graph = await self._clients.resolve_graph(self._cfg, self._name)
                    return await getattr(self._graph, method)(*args, **kwargs)
                except Exception as exc2:
                    # Credentials genuinely missing/wrong → clean config error.
                    raise_auth_config_error(self._cfg, exc2)
                    raise
            if is_auth_error(exc):
                # NOAUTH / WRONGPASS → configuration error, not a retryable outage.
                raise_auth_config_error(self._cfg, exc)
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
    """Process-wide cache of FalkorDB clients, keyed by connection identity and —
    in CLUSTER mode — by the OWNING NODE (never by the graph).

    A graph key lives entirely on one cluster node, so a graph's client must be
    pinned to that node. But many graphs share a node: keying the client by graph
    would open one ConnectionPool **per graph** (×FALKORDB_POOL_SIZE connections),
    which at this platform's scale (100s of graphs, 1000s of versioned views)
    means thousands of pools and tens of thousands of sockets against a 3-node
    cluster. So the client cache is keyed by node and a separate, cheap map
    remembers which node owns each graph:

        _owner:   (identity, graph) -> (host, port)     # slot lookup, cached
        _clients: (identity, node)  -> (FalkorDB, pool) # bounded by #nodes

    Standalone/Sentinel have a single endpoint, so they share one client per
    instance (node = None).

    ``invalidate(cfg, graph)`` drops BOTH the graph's owner mapping and that
    node's client — the node is presumed dead (rotated pod / failover), and every
    other graph on it must re-resolve too. That is the hook a rotated cluster node
    or a Sentinel failover needs; the next call re-runs slot discovery and lands
    on the promoted replica.
    """

    def __init__(self, *, socket_timeout: Optional[float] = None):
        self._clients: dict = {}     # (identity, node|None) -> (FalkorDB, pool)
        self._owner: dict = {}       # (identity, graph) -> (host, port)  [cluster]
        self._locks: dict = {}       # per-key lock: a slow cluster discovery must
                                     # not block clients for other instances
        self._socket_timeout = socket_timeout

    @staticmethod
    def identity(cfg: FalkorDBConnConfig) -> tuple:
        # The password is folded in as a HASH (never the secret itself — identities
        # reach log lines via cfg.describe()). Without it a pure credential rotation
        # produces an IDENTICAL identity, so any process that missed the
        # invalidation broadcast would get a cache HIT on the client built with the
        # OLD password and never notice. It also keeps two providers that share
        # host/port/user but differ in password from colliding on one client.
        secret = hashlib.sha256(
            (cfg.password or "").encode("utf-8")
        ).hexdigest()[:16] if cfg.password else None
        # Sentinel-DAEMON auth is part of the identity for the same reason as
        # the data-plane password: two providers identical in data plane +
        # master + nodes but differing only in daemon credentials must not
        # collapse onto one cached client (whichever built first would win its
        # daemon auth for both). Hash, never the secret.
        daemon_secret = hashlib.sha256(
            (cfg.sentinel_password or "").encode("utf-8")
        ).hexdigest()[:16] if cfg.sentinel_password else None
        return (
            cfg.mode, cfg.host, cfg.port, cfg.username, secret,
            cfg.sentinel_master,
            tuple(cfg.sentinel_nodes), tuple(cfg.cluster_nodes),
            cfg.sentinel_username, daemon_secret, cfg.sentinel_auth_enabled,
            cfg.tls_enabled,
            # Frozen dataclass (hashable). Flipping the sentinel-daemon TLS
            # override must invalidate cached clients like any config change.
            cfg.sentinel_tls,
            # Different remap → different reachable endpoints → different client.
            cfg.address_remap,
        )

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

    async def _owner_node(self, cfg: FalkorDBConnConfig, graph_name: str):
        """(host, port) of the cluster node owning ``graph_name`` — memoized, so
        slot discovery is not on the hot path. Dropped by ``invalidate`` (a MOVED
        or a dead node), which is what lets a slot migration be picked up."""
        okey = (self.identity(cfg), graph_name)
        node = self._owner.get(okey)
        if node is None:
            st = float(self._pool_kwargs(cfg)["socket_timeout"])
            node = await resolve_cluster_node_for_key(cfg, graph_name, st)
            self._owner[okey] = node
        return node

    async def _client_for(self, cfg: FalkorDBConnConfig, graph_name: str):
        ident = self.identity(cfg)
        node = await self._owner_node(cfg, graph_name) if cfg.mode == "cluster" else None
        key = (ident, node)

        entry = self._clients.get(key)
        if entry is not None:
            return entry[0]

        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            entry = self._clients.get(key)          # another task may have built it
            if entry is None:
                async def _build(c: FalkorDBConnConfig):
                    if node is not None:
                        # Already resolved the owning node — build straight to it
                        # instead of re-running discovery inside build_graph_client.
                        db, pool = build_node_client(
                            c, node[0], node[1], self._pool_kwargs(c),
                        )
                    else:
                        db, pool = await build_graph_client(
                            c, graph_name=graph_name, pool_kwargs=self._pool_kwargs(c),
                        )
                    # Verify the connection ONCE here (bounded) so an auth mismatch is
                    # resolved at build time rather than surfacing deep inside a
                    # projector write. with_auth_negotiation turns "instance has no
                    # auth" into a silent reconnect without credentials, and
                    # NOAUTH/WRONGPASS into a clear configuration error.
                    from redis.asyncio import Redis

                    budget = connect_verify_budget(
                        c, _resilience.FALKORDB_INIT_TIMEOUT_SECS,
                    )
                    try:
                        await asyncio.wait_for(
                            Redis(connection_pool=pool).ping(), timeout=budget,
                        )
                        # Standalone config against a cluster-enabled node would
                        # silently see one node's slots — fail loud at build time.
                        await verify_not_cluster_node(c, pool, budget)
                    except BaseException:
                        # A raise here never lands the entry in self._clients, so
                        # nothing would ever close it — and a persistent condition
                        # (mode mismatch, dead node) re-enters _build on every
                        # call, leaking one live socket per attempt.
                        await aclose_graph_client(db, pool)
                        raise
                    return db, pool

                db, pool = await with_auth_negotiation(cfg, _build)
                self._clients[key] = entry = (db, pool)
                logger.info(
                    "falkordb: built graph client for %s%s",
                    cfg.describe(),
                    f" node={node[0]}:{node[1]}" if node else "",
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
        """Drop the graph's owner mapping AND its node's client. Both must go: on
        a rotation the node is dead for EVERY graph it held, and the slot may have
        moved elsewhere."""
        ident = self.identity(cfg)
        node = self._owner.pop((ident, graph_name), None) if cfg.mode == "cluster" else None
        key = (ident, node)
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            entry = self._clients.pop(key, None)
        if entry is not None:
            await aclose_graph_client(*entry)

    async def invalidate_config(self, cfg: FalkorDBConnConfig) -> None:
        """Drop EVERY client + owner mapping for one instance. Called when a
        provider row changes (host/mode/credentials) — otherwise the projector
        would keep writing to the old instance until the process restarts."""
        # A config change also invalidates what we LEARNED about the instance's
        # authentication: the operator may have just enabled auth or rotated the
        # credentials, and a process-lifetime "no auth here" mark would keep
        # stripping the new credentials until restart.
        unmark_instance_unauthenticated(cfg)
        ident = self.identity(cfg)
        keys = [k for k in self._clients if k[0] == ident]
        for k in keys:
            entry = self._clients.pop(k, None)
            if entry is not None:
                await aclose_graph_client(*entry)
        for k in [k for k in self._owner if k[0] == ident]:
            self._owner.pop(k, None)
        if keys:
            logger.info("falkordb: dropped %d cached client(s) for %s",
                        len(keys), cfg.describe())

    async def aclose(self) -> None:
        entries, self._clients = list(self._clients.values()), {}
        for db, pool in entries:
            await aclose_graph_client(db, pool)


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


async def resolve_sentinel_master(
    cfg: FalkorDBConnConfig, socket_timeout: float,
) -> Tuple[str, int]:
    """Ask the Sentinel quorum for the CURRENT master's address.

    Needed by preflight: pinging a Sentinel daemon proves only that Sentinel is
    alive — it answers PONG happily while the master it watches is dead. Probing
    the master it names is the same discipline the cluster path uses (probe the
    node that actually serves the data, not an entry point).
    """
    from redis.asyncio.sentinel import Sentinel

    if not cfg.sentinel_master or not cfg.sentinel_nodes:
        raise ProviderConfigurationError(
            "FalkorDB sentinel mode requires sentinel.masterName and "
            "sentinel.nodes (or FALKORDB_SENTINEL_MASTER / FALKORDB_SENTINEL_NODES)."
        )
    async def _discover(c: FalkorDBConnConfig):
        # Only sentinel_kwargs: discovery never opens a data-plane connection,
        # and spreading the daemon kwargs as connection kwargs too would hand
        # the DAEMONS' auth/TLS to any master pool built off this object.
        sentinel = Sentinel(
            c.sentinel_nodes,
            sentinel_kwargs=_sentinel_auth_kwargs(c, socket_timeout),
        )
        host, port = await sentinel.discover_master(c.sentinel_master)
        # Sentinels announce the master address THEY know (a pod IP) —
        # rewrite it into one this client can actually dial.
        return remap_address(c, host, int(port))

    # Sentinel daemons have their own auth (see _sentinel_auth_kwargs); negotiate the
    # same way so a credentialed config against unauthenticated sentinels self-heals.
    return await with_auth_negotiation(cfg, _discover)


class ClusterCoverageError(RuntimeError):
    """The cluster's primaries do not cover the full slot space.

    Raised by the primaries fan-out so a keyless GRAPH.LIST union is NEVER
    computed over a partial cluster: with a shard missing, the union would
    silently contain only the surviving shards' graphs, and the discovery
    worker would persist that shrunken list as ``fresh`` — items "vanish"
    from the UI for a whole sweep interval with no error anywhere. A raise
    routes to ``record_failure`` instead: last-known-good data is preserved
    and ``last_error`` names the gap. Transient (a mid-failover window heals
    itself), so deliberately NOT a ProviderConfigurationError."""


def _missing_slot_ranges(covered) -> str:
    """Compact ``"0-5460, 10923-16383"`` description of uncovered slots,
    capped at 4 ranges (log/error hygiene at 16k slots)."""
    missing = sorted(set(range(16384)) - set(covered))
    ranges: List[str] = []
    for slot in missing:
        if ranges and slot == ranges[-1][1] + 1:
            ranges[-1][1] = slot
        else:
            ranges.append([slot, slot])
    out = [f"{a}-{b}" if b > a else f"{a}" for a, b in ranges[:4]]
    return ", ".join(out) + (", …" if len(ranges) > 4 else "")


async def cluster_primary_nodes(
    cfg: FalkorDBConnConfig, socket_timeout: float,
) -> List[Tuple[str, int]]:
    """Every primary in the cluster (the nodes that own slots).

    Wrapped in ``with_auth_negotiation`` for the same reason the slot-owner
    lookup (``resolve_cluster_node_for_key``) is: an unauthenticated cluster must
    not read as unreachable over a stale provider password, and a missing/wrong
    credential must surface as a clear ProviderConfigurationError rather than the
    RAW ``RedisClusterException`` ("...provide at least one reachable node", which
    wraps redis-py 8's RESP3 ``HELLO``-with-no-AUTH error) — which the operation
    breaker would treat as an outage. This keyless ``GRAPH.LIST`` path (graph
    name-availability) previously skipped that negotiation, so a cluster with auth
    but no configured credential leaked both raw errors here.
    """
    if not cfg.cluster_nodes:
        raise ProviderConfigurationError(
            "FalkorDB cluster mode requires cluster.startupNodes (or "
            "FALKORDB_CLUSTER_NODES)."
        )

    async def _primaries(c: FalkorDBConnConfig) -> List[Tuple[str, int]]:
        return await _cluster_primary_nodes_once(c, socket_timeout)

    return await with_auth_negotiation(cfg, _primaries)


async def _cluster_primary_nodes_once(
    cfg: FalkorDBConnConfig, socket_timeout: float,
) -> List[Tuple[str, int]]:
    from redis.asyncio.cluster import RedisCluster
    from redis.cluster import ClusterNode

    nodes = [ClusterNode(h, p) for h, p in cfg.cluster_nodes]
    cluster = RedisCluster(
        startup_nodes=nodes,
        # Explicit, not the library default: the async client happens to
        # default require_full_coverage=True (the sync one does not), and a
        # future redis-py relaxing it would silently re-open the partial-
        # union hole this fan-out exists to close. The SERVER runs
        # --cluster-require-full-coverage no (surviving shards keep serving
        # through an outage), so the client must be the one to insist.
        require_full_coverage=True,
        **_conn_auth_kwargs(cfg, socket_timeout),
        **_address_remap_kwargs(cfg),
    )
    try:
        if hasattr(cluster, "initialize"):
            await cluster.initialize()
        # Belt over the braces above: verify the slot map we are about to
        # trust really covers the whole space, whatever initialize() accepted.
        # slots_cache is a private redis-py attribute: if a library upgrade
        # renames it, SKIP the belt (the explicit require_full_coverage kwarg
        # above still holds the invariant) rather than misreporting a healthy
        # cluster as 0/16384 covered and failing every listing fleet-wide.
        slots_cache = getattr(cluster.nodes_manager, "slots_cache", None)
        if slots_cache is None:
            logger.warning(
                "falkordb_connection: redis-py nodes_manager has no slots_cache "
                "attribute (library change?) — slot-coverage belt check skipped; "
                "require_full_coverage=True at initialize() still enforces it."
            )
        elif len(slots_cache) < 16384:
            raise ClusterCoverageError(
                f"cluster slot map covers {len(slots_cache)}/16384 slots "
                f"(missing: {_missing_slot_ranges(slots_cache)}) — refusing to "
                f"enumerate primaries over a partial cluster (a shard is down "
                f"or mid-failover; results would silently omit its graphs)"
            )
        primaries = [(n.host, int(n.port)) for n in cluster.get_primaries()]
        remapped = [remap_address(cfg, h, p) for h, p in primaries]
        # An addressRemap that collapses distinct primaries onto one dialable
        # endpoint would make the fan-out query the same node repeatedly and
        # under-report with no error — that is a config bug, so fail loud.
        if len(set(remapped)) < len(set(primaries)):
            raise ProviderConfigurationError(
                f"addressRemap collapses {len(set(primaries))} distinct cluster "
                f"primaries onto {len(set(remapped))} endpoint(s) "
                f"({sorted(set(remapped))}) — each primary needs its own "
                f"reachable address or a GRAPH.LIST fan-out cannot see every shard"
            )
        return remapped
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
        # Per-primary GRAPH.LIST, unioned.
        #
        # Deliberately a PLAIN redis client, never ``FalkorDB(connection_pool=)``:
        # the falkordb client wraps any pool whose server is cluster-enabled in
        # ``Cluster_Conn`` → a RedisCluster, which routes the *keyless*
        # GRAPH.LIST to ONE arbitrary node. Iterating the primaries with such a
        # client therefore re-asks an arbitrary node each time and SILENTLY
        # under-reports the union (verified against a live 3-shard cluster: it
        # returned 3 of 6 graphs, missing an entire shard's worth). GRAPH.LIST
        # is keyless, so a plain client pinned to a node is never redirected and
        # reports exactly that node's graphs.
        from redis.asyncio import Redis as _NodeRedis

        keys: set = set()
        per_node: dict = {}
        tls = tls_pool_kwargs(cfg.tls_settings())
        for host, port in await cluster_primary_nodes(cfg, st):
            pool = ConnectionPool(host=host, port=port, **pool_kwargs, **tls)
            try:
                node = _NodeRedis(connection_pool=pool)
                res = await node.execute_command("GRAPH.LIST")
                node_keys = {_decode_key(k) for k in (res or [])}
                keys |= node_keys
                per_node[f"{host}:{port}"] = len(node_keys)
            finally:
                try:
                    await pool.aclose()
                except Exception:                    # pragma: no cover - best effort
                    pass
        # One line per fan-out (not per node): the per-node split is the
        # under-report diagnostic; a line per node per sweep is log spam.
        logger.info(
            "falkordb GRAPH.LIST fan-out: %d primaries %s -> union %d key(s)",
            len(per_node), per_node, len(keys),
        )
        return keys

    db, pool = await build_graph_client(cfg, graph_name="", pool_kwargs=pool_kwargs)
    try:
        return {_decode_key(k) for k in await db.list_graphs()}
    finally:
        try:
            await pool.aclose()
        except Exception:                            # pragma: no cover - best effort
            pass
