"""Central Redis connection config — one resolver, one factory, per role.

Why this exists: there were 12 non-graph Redis construction sites and only two
went through a shared builder, so ``REDIS_PASSWORD`` / ``REDIS_TLS_*`` were
honoured by the bus and silently ignored by token revocation, the health probes
and the provider cache. Turning on AUTH therefore authenticated the job bus while
breaking auth on every request. Making the factory the ONLY way to build a client
turns "someone forgot to wire auth into this client" from a discipline problem
into an impossibility.

Roles are INDEPENDENT ENDPOINTS. Cache and streams may be different instances
with different hosts, different ACL users, different passwords and different PKI.
Nothing is inherited across roles, and nothing is inherited from FalkorDB — the
old code derived the cache's TLS from the FalkorDB connection's certs, which
silently produced either "no TLS" or "system trust store" depending on the URL
scheme.

Cluster is NOT supported for either role and fails fast. This is deliberate:
``graph_cache`` does SCAN + variadic DEL (cross-slot), the job broker pipelines
XADD to two un-tagged keys (cross-slot), and both roles use a non-zero DB index
(cluster is DB 0 only). Cluster remains FalkorDB-only.

Config (per role R in {STREAMS, CACHE}) — all independent:

    REDIS_{R}_MODE                 standalone | sentinel
    REDIS_{R}_HOST / _PORT / _DB
    REDIS_{R}_USERNAME
    REDIS_{R}_PASSWORD             secret (env / secretKeyRef)
    REDIS_{R}_PASSWORD_FILE        secret (mounted file — wins; rotatable)
    REDIS_{R}_TLS_ENABLED / _TLS_CA_CERTS / _TLS_CERTFILE / _TLS_KEYFILE
    REDIS_{R}_TLS_CERT_REQS / _TLS_CHECK_HOSTNAME
    REDIS_{R}_SENTINEL_MASTER / _SENTINEL_NODES
    REDIS_{R}_SENTINEL_USERNAME / _SENTINEL_PASSWORD / _SENTINEL_PASSWORD_FILE
    REDIS_{R}_SENTINEL_AUTH_ENABLED
    REDIS_{R}_MAX_CONNECTIONS / _SOCKET_TIMEOUT / _SOCKET_CONNECT_TIMEOUT
    REDIS_{R}_HEALTH_CHECK_INTERVAL

Legacy (still honoured, ROLE-SCOPED — they only ever meant one role):
    REDIS_URL + REDIS_USERNAME/REDIS_PASSWORD/REDIS_TLS_*   -> STREAMS
    REDIS_SENTINEL_MASTER + REDIS_SENTINEL_NODES             -> STREAMS (sentinel mode)
    CACHE_REDIS_URL                                          -> CACHE
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, Optional, Tuple
from urllib.parse import unquote, urlparse

from backend.common.adapters.redis_tls import TLSSettings

logger = logging.getLogger(__name__)


class RedisRole(str, Enum):
    STREAMS = "streams"
    CACHE = "cache"


class RedisConfigurationError(RuntimeError):
    """A Redis endpoint is mis-configured (missing secret, cluster requested, ...)."""


@dataclass(frozen=True)
class ProviderCacheOverride:
    """A provider's dedicated CACHE endpoint.

    ``connection`` is the NON-SECRET ``extra_config["cacheConnection"]`` block.
    ``credentials`` is the DECRYPTED credentials blob (cache_username /
    cache_password / cache_sentinel_* / legacy cache_redis_url).
    """
    provider_id: str
    connection: Dict[str, Any] = field(default_factory=dict)
    credentials: Dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class RedisEndpointConfig:
    role: RedisRole
    mode: str = "standalone"
    host: str = "localhost"
    port: int = 6379
    db: int = 0
    username: Optional[str] = None
    password: Optional[str] = None
    sentinel_master: Optional[str] = None
    sentinel_nodes: Tuple[Tuple[str, int], ...] = ()
    sentinel_username: Optional[str] = None
    sentinel_password: Optional[str] = None
    sentinel_auth_enabled: bool = False
    tls: TLSSettings = TLSSettings()
    max_connections: int = 20
    socket_timeout: float = 10.0
    socket_connect_timeout: float = 5.0
    health_check_interval: int = 30
    # field name -> where the value came from. Rendered by Admin > System > Redis.
    source: Dict[str, str] = field(default_factory=dict)

    def describe(self) -> str:
        """Redacted, safe to log. NEVER includes the password."""
        where = (
            f"sentinel(master={self.sentinel_master}, nodes={len(self.sentinel_nodes)})"
            if self.mode == "sentinel" else f"{self.host}:{self.port}/{self.db}"
        )
        auth = f"user={self.username or '-'} pw={'set' if self.password else 'none'}"
        tls = "TLS" + ("+mTLS" if self.tls.certfile else "") if self.tls.enabled else "no-TLS"
        return f"{self.role.value}[{self.mode}] {where} {auth} {tls}"


# ── helpers ─────────────────────────────────────────────────────────

def _as_bool(v: Optional[str], default: bool = False) -> bool:
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def _parse_nodes(raw: Optional[str]) -> Tuple[Tuple[str, int], ...]:
    """Parse "h1:26379, h2:26379" -> (("h1",26379), ("h2",26379))."""
    out = []
    for chunk in (raw or "").split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        host, _, port = chunk.rpartition(":")
        if not host:
            logger.warning("redis_endpoint: ignoring node %r (no host:port)", chunk)
            continue
        try:
            out.append((host, int(port)))
        except ValueError:
            logger.warning("redis_endpoint: ignoring node %r (bad port)", chunk)
    return tuple(out)


def _read_secret_file(path: str, var: str) -> str:
    """Read a mounted secret. A missing OR empty file is a HARD error — silently
    falling back to 'no password' is how an unauthenticated connect slips into
    prod, whether the file is absent or just empty (mount race, bad rotation)."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            content = fh.read().strip()
    except OSError as exc:
        raise RedisConfigurationError(
            f"{var}={path!r} could not be read: {exc}. Refusing to connect without "
            f"the credential it names."
        ) from exc
    if not content:
        raise RedisConfigurationError(
            f"{var}={path!r} is empty. Refusing to connect without the credential "
            f"it names."
        )
    return content


def _resolve_password(
    prefix: str, suffix: str, src: Dict[str, str], key: str,
) -> Optional[str]:
    """`{prefix}{suffix}_FILE` (wins) or `{prefix}{suffix}`. Records provenance."""
    file_var = f"{prefix}{suffix}_FILE"
    path = os.getenv(file_var)
    if path:
        src[key] = file_var
        return _read_secret_file(path, file_var)
    env_var = f"{prefix}{suffix}"
    val = os.getenv(env_var)
    if val:
        src[key] = env_var
        return val
    return None


def _parse_url(url: str) -> Dict[str, Any]:
    """redis(s)://[user[:pass]@]host[:port][/db] -> field dict."""
    p = urlparse(url)
    out: Dict[str, Any] = {
        "host": p.hostname or "localhost",
        "port": int(p.port or 6379),
        "tls_enabled": p.scheme.lower() == "rediss",
    }
    if p.username:
        out["username"] = unquote(p.username)
    if p.password:
        out["password"] = unquote(p.password)
    path = (p.path or "").lstrip("/")
    if path:
        try:
            out["db"] = int(path)
        except ValueError:
            logger.warning("redis_endpoint: ignoring non-numeric db %r in URL", path)
    return out


def _tls_from_env(prefix: str, src: Dict[str, str], enabled_default: bool) -> TLSSettings:
    enabled_raw = os.getenv(f"{prefix}TLS_ENABLED")
    enabled = _as_bool(enabled_raw, enabled_default)
    if enabled_raw is not None:
        src["tls"] = f"{prefix}TLS_ENABLED"
    for var in ("TLS_CA_CERTS", "TLS_CERTFILE", "TLS_KEYFILE"):
        if os.getenv(f"{prefix}{var}"):
            src["tls"] = f"{prefix}{var}"
    return TLSSettings.from_fields(
        enabled=enabled,
        ca_certs=os.getenv(f"{prefix}TLS_CA_CERTS"),
        certfile=os.getenv(f"{prefix}TLS_CERTFILE"),
        keyfile=os.getenv(f"{prefix}TLS_KEYFILE"),
        cert_reqs=os.getenv(f"{prefix}TLS_CERT_REQS"),
        check_hostname=_as_bool(os.getenv(f"{prefix}TLS_CHECK_HOSTNAME", "true"), True),
    )


def _tls_from_json(block: Dict[str, Any]) -> TLSSettings:
    """extra_config cacheConnection.tls -> TLSSettings (camelCase, mirrors
    falkordbConnection.tls so operators see ONE shape)."""
    return TLSSettings.from_fields(
        enabled=bool(block.get("enabled", False)),
        ca_certs=block.get("caCertPath"),
        certfile=block.get("certPath"),
        keyfile=block.get("keyPath"),
        cert_reqs=block.get("verifyMode"),
        check_hostname=block.get("checkHostname", True),
    )


_LEGACY: Dict[RedisRole, str] = {
    RedisRole.STREAMS: "REDIS_URL",
    RedisRole.CACHE: "CACHE_REDIS_URL",
}


def _reject_cluster(role: RedisRole, mode: str) -> None:
    if mode == "cluster" or (
        role is RedisRole.STREAMS and os.getenv("REDIS_CLUSTER_NODES")
    ) or os.getenv(f"REDIS_{role.value.upper()}_CLUSTER_NODES"):
        if role is RedisRole.CACHE:
            reason = (
                "graph_cache does SCAN + multi-key DEL (cross-slot), and the cache "
                "uses a non-zero DB index — Cluster is DB-0 only"
            )
        else:
            reason = (
                "the job broker pipelines XADD across two un-tagged keys "
                "(cross-slot, no hash tag)"
            )
        raise RedisConfigurationError(
            f"Redis cluster mode is not supported for the {role.value!r} endpoint. "
            f"This is deliberate: {reason} — incompatible with Cluster. Use a "
            f"single node or Sentinel. (Redis Cluster IS supported for FalkorDB — "
            f"a different role, see FALKORDB_DEPLOYMENT.md.)"
        )


# ── the resolver ────────────────────────────────────────────────────

def resolve_redis_config(
    role: RedisRole, *, provider_cache: Optional[ProviderCacheOverride] = None,
) -> RedisEndpointConfig:
    """Resolve one role's endpoint.

    Precedence:
        CACHE:   provider override -> REDIS_CACHE_*  -> CACHE_REDIS_URL (legacy)
        STREAMS: REDIS_STREAMS_*   -> REDIS_URL + REDIS_{USERNAME,PASSWORD,TLS_*}
                 (legacy); REDIS_STREAMS_SENTINEL_* -> REDIS_SENTINEL_MASTER +
                 REDIS_SENTINEL_NODES (legacy, implies sentinel mode)

    Layers do NOT merge across sources of different scope: a provider override is
    whole-endpoint (it never inherits the global cache's password or CA), because a
    half-inherited credential is undiagnosable.
    """
    if provider_cache is not None and role is not RedisRole.CACHE:
        raise RedisConfigurationError(
            "A per-provider override is only valid for the CACHE role; the streams "
            "bus is a single fleet-wide coordination endpoint."
        )

    if provider_cache is not None:
        cfg = _resolve_provider_cache(provider_cache)
        if cfg is not None:
            return cfg

    prefix = f"REDIS_{role.value.upper()}_"
    src: Dict[str, str] = {}

    mode_raw = os.getenv(f"{prefix}MODE")
    mode = (mode_raw or "standalone").strip().lower()
    src["mode"] = f"{prefix}MODE" if mode_raw else "default"
    _reject_cluster(role, mode)

    # Legacy URL supplies the BASE for this role only; role-prefixed vars win.
    legacy_var = _LEGACY[role]
    legacy_url = os.getenv(legacy_var)
    base: Dict[str, Any] = {}
    if legacy_url:
        base = _parse_url(legacy_url)
        for k in base:
            # _parse_url's internal key is "tls_enabled"; the real config field
            # (and the one the Admin page renders source for) is "tls".
            src[("tls" if k == "tls_enabled" else k)] = f"{legacy_var} (legacy)"
        logger.info(
            "redis_endpoint: %s resolved from legacy %s — migrate to %sHOST/_PORT/_DB "
            "+ %sPASSWORD(_FILE).", role.value, legacy_var, prefix, prefix,
        )

    def _pick(env_suffix: str, base_key: str, default, cast=str):
        raw = os.getenv(f"{prefix}{env_suffix}")
        if raw is not None:
            src[base_key] = f"{prefix}{env_suffix}"
            return cast(raw)
        if base_key in base:
            return base[base_key]
        src.setdefault(base_key, "default")
        return default

    host = _pick("HOST", "host", "localhost")
    port = _pick("PORT", "port", 6379, int)
    db = _pick("DB", "db", 0, int)
    username = _pick("USERNAME", "username", None)

    password = _resolve_password(prefix, "PASSWORD", src, "password")
    if password is None and "password" in base:
        password = base["password"]

    tls = _tls_from_env(prefix, src, enabled_default=bool(base.get("tls_enabled", False)))

    # STREAMS keeps honouring the historical UNPREFIXED auth/TLS vars.
    if role is RedisRole.STREAMS:
        if username is None and os.getenv("REDIS_USERNAME"):
            username = os.getenv("REDIS_USERNAME")
            src["username"] = "REDIS_USERNAME (legacy)"
        if password is None:
            legacy_pw = _resolve_password("REDIS_", "PASSWORD", src, "password")
            if legacy_pw:
                password = legacy_pw
                src["password"] = f"{src['password']} (legacy)"
        if not tls.enabled and _as_bool(os.getenv("REDIS_TLS_ENABLED"), False):
            tls = TLSSettings.from_fields(
                enabled=True,
                ca_certs=os.getenv("REDIS_TLS_CA_CERTS"),
                certfile=os.getenv("REDIS_TLS_CERTFILE"),
                keyfile=os.getenv("REDIS_TLS_KEYFILE"),
                cert_reqs=os.getenv("REDIS_TLS_CERT_REQS"),
                check_hostname=_as_bool(os.getenv("REDIS_TLS_CHECK_HOSTNAME", "true"), True),
            )
            src["tls"] = "REDIS_TLS_* (legacy)"

    sentinel_master = os.getenv(f"{prefix}SENTINEL_MASTER")
    if sentinel_master:
        src["sentinel_master"] = f"{prefix}SENTINEL_MASTER"
    sentinel_nodes_raw = os.getenv(f"{prefix}SENTINEL_NODES")
    sentinel_nodes = _parse_nodes(sentinel_nodes_raw)
    if sentinel_nodes_raw:
        src["sentinel_nodes"] = f"{prefix}SENTINEL_NODES"

    # STREAMS keeps honouring the historical UNPREFIXED REDIS_SENTINEL_MASTER /
    # REDIS_SENTINEL_NODES: the original bus builder selected Sentinel mode
    # implicitly whenever both were set (there was no MODE concept at all).
    # Without this fallback, a deployment running the bus on Sentinel today
    # silently falls back to standalone after adopting the central resolver —
    # no error, no warning, just the wrong Redis. Role-prefixed vars still win
    # when they supply either value, and an explicit {prefix}MODE always wins
    # over this inference.
    if (
        role is RedisRole.STREAMS
        and mode_raw is None
        and not sentinel_master
        and not sentinel_nodes
    ):
        legacy_sentinel_master = os.getenv("REDIS_SENTINEL_MASTER")
        legacy_sentinel_nodes = _parse_nodes(os.getenv("REDIS_SENTINEL_NODES"))
        if legacy_sentinel_master and legacy_sentinel_nodes:
            sentinel_master = legacy_sentinel_master
            sentinel_nodes = legacy_sentinel_nodes
            src["sentinel_master"] = "REDIS_SENTINEL_MASTER (legacy)"
            src["sentinel_nodes"] = "REDIS_SENTINEL_NODES (legacy)"
            mode = "sentinel"
            src["mode"] = "REDIS_SENTINEL_MASTER+REDIS_SENTINEL_NODES (legacy)"
            logger.info(
                "redis_endpoint: %s sentinel mode inferred from legacy "
                "REDIS_SENTINEL_MASTER/REDIS_SENTINEL_NODES — migrate to "
                "%sMODE=sentinel + %sSENTINEL_MASTER/%sSENTINEL_NODES.",
                role.value, prefix, prefix, prefix,
            )

    if mode == "sentinel" and not (sentinel_master and sentinel_nodes):
        raise RedisConfigurationError(
            f"{role.value}: sentinel mode requires {prefix}SENTINEL_MASTER and "
            f"{prefix}SENTINEL_NODES."
        )

    sentinel_username = os.getenv(f"{prefix}SENTINEL_USERNAME")
    if sentinel_username:
        src["sentinel_username"] = f"{prefix}SENTINEL_USERNAME"

    sentinel_auth_enabled_raw = os.getenv(f"{prefix}SENTINEL_AUTH_ENABLED")
    sentinel_auth_enabled = _as_bool(sentinel_auth_enabled_raw, False)
    if sentinel_auth_enabled_raw is not None:
        src["sentinel_auth_enabled"] = f"{prefix}SENTINEL_AUTH_ENABLED"

    # Pool knobs. Provenance MUST be recorded for these: build_bus_redis (Task 3)
    # decides whether to apply its caller-supplied defaults by asking whether the
    # env explicitly set them (`"max_connections" not in cfg.source`). Without a
    # source entry the caller's default would silently override the operator's env.
    def _knob(env_suffix: str, key: str, default, cast):
        raw = os.getenv(f"{prefix}{env_suffix}")
        if raw is None:
            return default
        src[key] = f"{prefix}{env_suffix}"
        return cast(raw)

    return RedisEndpointConfig(
        role=role, mode=mode, host=host, port=port, db=db,
        username=username, password=password,
        sentinel_master=sentinel_master, sentinel_nodes=sentinel_nodes,
        sentinel_username=sentinel_username,
        sentinel_password=_resolve_password(
            prefix, "SENTINEL_PASSWORD", src, "sentinel_password",
        ),
        sentinel_auth_enabled=sentinel_auth_enabled,
        tls=tls,
        max_connections=_knob("MAX_CONNECTIONS", "max_connections", 20, int),
        socket_timeout=_knob("SOCKET_TIMEOUT", "socket_timeout", 10.0, float),
        socket_connect_timeout=_knob(
            "SOCKET_CONNECT_TIMEOUT", "socket_connect_timeout", 5.0, float,
        ),
        health_check_interval=_knob(
            "HEALTH_CHECK_INTERVAL", "health_check_interval", 30, int,
        ),
        source=src,
    )


def _resolve_provider_cache(
    ov: ProviderCacheOverride,
) -> Optional[RedisEndpointConfig]:
    """A provider's dedicated cache. Returns None when the provider defines none
    (so the caller falls through to the global default)."""
    conn = ov.connection or {}
    creds = ov.credentials or {}
    legacy_url = creds.get("cache_redis_url")
    if not conn and not legacy_url:
        return None

    origin = f"provider:{ov.provider_id}"

    if not conn and legacy_url:
        f = _parse_url(legacy_url)
        legacy_origin = f"{origin} cache_redis_url (legacy)"
        # Only attribute what the URL actually supplied — _parse_url omits
        # username/password/db entirely when the URL doesn't carry them, so a
        # blanket assignment here would lie about their provenance.
        src: Dict[str, str] = {
            ("tls" if k == "tls_enabled" else k): legacy_origin for k in f
        }
        for key in ("host", "port", "db", "username", "password", "tls"):
            src.setdefault(key, "default")
        return RedisEndpointConfig(
            role=RedisRole.CACHE,
            host=f["host"], port=f["port"], db=f.get("db", 0),
            username=f.get("username"), password=f.get("password"),
            tls=TLSSettings.from_fields(enabled=f["tls_enabled"]),
            source=src,
        )

    mode = (conn.get("mode") or "standalone").strip().lower()
    if mode == "cluster":
        raise RedisConfigurationError(
            f"provider {ov.provider_id}: Redis cluster mode is not supported for the "
            f"cache endpoint (see RedisRole.CACHE). Use standalone or sentinel."
        )
    if mode == "sentinel" and not (
        conn.get("sentinel", {}).get("masterName")
        and conn.get("sentinel", {}).get("nodes")
    ):
        raise RedisConfigurationError(
            f"provider {ov.provider_id}: cacheConnection sentinel mode requires "
            f"sentinel.masterName and sentinel.nodes."
        )

    sentinel = conn.get("sentinel") or {}
    nodes = tuple(
        (n[0], int(n[1])) if isinstance(n, (list, tuple)) else (n["host"], int(n["port"]))
        for n in (sentinel.get("nodes") or [])
    )

    src: Dict[str, str] = {}

    def _identity(key: str, present: bool) -> None:
        # Identity fields ALWAYS get an entry: the real origin when the
        # provider actually supplied it, "default" otherwise. Never blanket.
        src[key] = origin if present else "default"

    _identity("mode", "mode" in conn)
    _identity("host", "host" in conn)
    _identity("port", "port" in conn)
    _identity("db", "db" in conn)
    _identity("username", bool(creds.get("cache_username")))
    _identity("password", bool(creds.get("cache_password")))
    _identity("tls", bool(conn.get("tls")))
    _identity("sentinel_master", bool(sentinel.get("masterName")))
    _identity("sentinel_nodes", bool(sentinel.get("nodes")))
    _identity("sentinel_username", bool(creds.get("cache_sentinel_username")))
    _identity("sentinel_password", bool(creds.get("cache_sentinel_password")))
    _identity("sentinel_auth_enabled", "authEnabled" in sentinel)

    def _knob(json_key: str, key: str, default, cast):
        # Pool knobs get an entry ONLY when the provider JSON actually
        # supplies them — absent otherwise, so callers can tell "the
        # provider set this" from "nobody set this, apply my own default".
        if json_key in conn:
            src[key] = origin
            return cast(conn[json_key])
        return default

    return RedisEndpointConfig(
        role=RedisRole.CACHE, mode=mode,
        host=conn.get("host") or "localhost",
        port=int(conn.get("port") or 6379),
        db=int(conn.get("db") or 0),
        username=creds.get("cache_username"),
        password=creds.get("cache_password"),
        sentinel_master=sentinel.get("masterName"),
        sentinel_nodes=nodes,
        sentinel_username=creds.get("cache_sentinel_username"),
        sentinel_password=creds.get("cache_sentinel_password"),
        sentinel_auth_enabled=bool(sentinel.get("authEnabled", False)),
        tls=_tls_from_json(conn.get("tls") or {}),
        max_connections=_knob("maxConnections", "max_connections", 20, int),
        socket_timeout=_knob("socketTimeout", "socket_timeout", 10.0, float),
        socket_connect_timeout=_knob(
            "socketConnectTimeout", "socket_connect_timeout", 5.0, float,
        ),
        health_check_interval=_knob(
            "healthCheckInterval", "health_check_interval", 30, int,
        ),
        source=src,
    )


# ── the factory ─────────────────────────────────────────────────────

def build_redis_client(
    cfg: RedisEndpointConfig, *, decode_responses: bool = True,
) -> Any:
    """The ONLY way to build a non-graph Redis client.

    Every role goes through here, so auth and TLS cannot be forgotten for one
    client and remembered for another — which is exactly the bug this replaces.
    """
    import redis.asyncio as aioredis
    from backend.common.adapters.redis_tls import tls_client_kwargs

    if cfg.mode.strip().lower() == "cluster":
        _reject_cluster(cfg.role, "cluster")

    common: Dict[str, Any] = {
        # Must live here (not sentinel_kwargs): sentinel daemons have no DBs, but
        # the master/replica data connection does — `common` is what reaches both
        # the standalone client and Sentinel's connection_kwargs/master_for.
        "db": cfg.db,
        "decode_responses": decode_responses,
        "socket_timeout": cfg.socket_timeout,
        "socket_connect_timeout": cfg.socket_connect_timeout,
        "health_check_interval": cfg.health_check_interval,
        "max_connections": cfg.max_connections,
        **tls_client_kwargs(cfg.tls),
    }
    if cfg.username:
        common["username"] = cfg.username
    if cfg.password:
        common["password"] = cfg.password

    if cfg.mode == "sentinel":
        from redis.asyncio.sentinel import Sentinel

        # Sentinel DAEMONS have their own auth. Passing the data-plane password to
        # an unauthenticated sentinel makes redis-py raise on the AUTH reply and
        # fails discover_master — send credentials only when configured.
        sentinel_kwargs: Dict[str, Any] = {
            "socket_timeout": cfg.socket_timeout,
            "socket_connect_timeout": cfg.socket_connect_timeout,
            **tls_client_kwargs(cfg.tls),
        }
        s_user = cfg.sentinel_username or (
            cfg.username if cfg.sentinel_auth_enabled else None
        )
        s_pass = cfg.sentinel_password or (
            cfg.password if cfg.sentinel_auth_enabled else None
        )
        if s_user:
            sentinel_kwargs["username"] = s_user
        if s_pass:
            sentinel_kwargs["password"] = s_pass

        sentinel = Sentinel(
            list(cfg.sentinel_nodes), sentinel_kwargs=sentinel_kwargs, **common,
        )
        client = sentinel.master_for(cfg.sentinel_master, **common)
        logger.info("redis_endpoint: %s", cfg.describe())
        return client

    client = aioredis.Redis(host=cfg.host, port=cfg.port, **common)
    logger.info("redis_endpoint: %s", cfg.describe())
    return client
