# Central Redis Connection Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cache and streams independently-configurable Redis endpoints — each with its own host, ACL credentials and TLS/mTLS material — resolved through one central factory that every Redis client in every service uses.

**Architecture:** A new `backend/common/adapters/redis_endpoint.py` owns a role-keyed config dataclass (`RedisEndpointConfig`), a resolver (defaults → role-prefixed env → legacy env → per-provider override) and the single client factory (`build_redis_client`). All 12 non-graph Redis construction sites migrate onto it. Cache gains a structured per-provider override; streams stays one central bus. Cluster is rejected for both roles (FalkorDB keeps cluster support).

**Tech Stack:** Python 3.14 / FastAPI / `redis.asyncio` (redis-py 8.x) / SQLAlchemy async / Pydantic v2 / pytest; React 18 + TypeScript + Vite + Tailwind + vitest; kustomize.

**Spec:** `docs/superpowers/specs/2026-07-14-redis-connection-config-design.md` — read it before Task 1.

## Global Constraints

- **No cross-role inheritance, ever.** A `CACHE` client must never receive a `STREAMS` credential or TLS cert, and neither may inherit FalkorDB's. This is the invariant the whole design exists to enforce; every task must preserve it.
- **Secrets are never literals in returned config.** Passwords resolve from `*_PASSWORD` (env / `secretKeyRef`) or `*_PASSWORD_FILE` (mounted file). A resolved password is never logged, never returned by an API, never embedded in a URL string.
- **Cluster is rejected for `STREAMS` and `CACHE`** with a `RedisConfigurationError` naming the reason. Cluster remains FalkorDB-only. Do not add cluster support for these roles.
- **Back-compat is one-directional and role-scoped.** `REDIS_URL` + `REDIS_USERNAME`/`REDIS_PASSWORD`/`REDIS_TLS_*` → `STREAMS` only. `CACHE_REDIS_URL` → `CACHE` only. Role-prefixed vars win. Every existing deployment must keep booting with zero config changes.
- **Dev stays zero-config.** docker-compose dev keeps one unauthenticated Redis with two DB indices, working through the legacy vars.
- **Cert material is file paths** (`ssl_ca_certs` / `ssl_certfile` / `ssl_keyfile`), reusing the existing `backend/common/adapters/redis_tls.py` — do not add inline-PEM support.

### Running the tests

Backend tests run inside the dev container. pytest is not in the image — install once per container:

```bash
docker exec -u root synodic-dev-viz-service-1 pip install -q pytest pytest-asyncio
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/<file> -q -p no:cacheprovider
```

Frontend: `cd frontend && npx vitest run src/<path>` and `npx tsc --noEmit` (there is a pre-existing tsc error baseline on this branch — do not regress it, but do not try to fix unrelated ones).

## File Structure

| File | Responsibility |
|---|---|
| `backend/common/adapters/redis_endpoint.py` | **NEW.** `RedisRole`, `RedisEndpointConfig`, `ProviderCacheOverride`, `RedisConfigurationError`, `resolve_redis_config()`, `build_redis_client()`. The only place a non-graph Redis client is constructed. |
| `backend/common/adapters/redis_bus.py` | `build_bus_redis()` becomes a thin `STREAMS` wrapper. Keeps `BusConfigurationError` as an alias so existing imports/tests survive. |
| `backend/app/services/revocation_service.py` | `RedisBackend` takes a client, not a URL. |
| `backend/app/services/system_status/probes.py` | Cache probe + FalkorDB node probe gain auth/TLS. |
| `backend/app/providers/falkordb_connection.py` | `build_cache_client` delegates to the factory; `build_cache_redis_fallback` deleted. |
| `backend/app/providers/manager.py` | Startup validation per role (replaces `_assert_dedicated_cache_configured`). |
| `backend/common/models/management.py` | `cacheConnection` validator; new credential fields; `extra_config` redaction on responses. |
| `backend/app/db/repositories/provider_repo.py` | Credentials merge-not-replace. |
| `backend/app/api/v1/endpoints/redis_config.py` | **NEW.** `GET /admin/redis/config`, `POST /admin/redis/{role}/test`. |
| `frontend/src/components/admin/AdminRedis/` | **NEW.** Read-only diagnostics page. |
| `frontend/src/components/admin/ProviderOnboardingWizard.tsx` | Structured dedicated-cache panel replacing the URL input. |
| `deploy/k8s/**`, `deploy/topologies/**` | Secret keys, cert mounts, two-instance auth+TLS harness. |

---

### Task 1: `RedisEndpointConfig` + resolver

**Files:**
- Create: `backend/common/adapters/redis_endpoint.py`
- Test: `backend/tests/test_redis_endpoint.py`

**Interfaces:**
- Consumes: `TLSSettings`, `tls_client_kwargs` from `backend/common/adapters/redis_tls.py`.
- Produces:
  - `class RedisRole(str, Enum): STREAMS = "streams"; CACHE = "cache"`
  - `class RedisConfigurationError(RuntimeError)`
  - `@dataclass(frozen=True) class ProviderCacheOverride: provider_id: str; connection: dict; credentials: dict`
  - `@dataclass(frozen=True) class RedisEndpointConfig` with fields `role, mode, host, port, db, username, password, sentinel_master, sentinel_nodes, sentinel_username, sentinel_password, sentinel_auth_enabled, tls, max_connections, socket_timeout, socket_connect_timeout, health_check_interval, source` and method `describe() -> str`
  - `def resolve_redis_config(role: RedisRole, *, provider_cache: Optional[ProviderCacheOverride] = None) -> RedisEndpointConfig`

`source: Dict[str, str]` is the **provenance map** — field name → where the value came from (`"REDIS_CACHE_HOST"`, `"REDIS_CACHE_PASSWORD_FILE"`, `"CACHE_REDIS_URL (legacy)"`, `"provider:acme-prod"`, `"default"`). The Admin page in Task 10/11 renders it. Every resolved field must record its origin.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_redis_endpoint.py`:

```python
"""Unit tests for the central Redis endpoint resolver.

The invariant under test: cache and streams are INDEPENDENT. A credential or a
cert configured for one role must never reach the other, and neither inherits
from FalkorDB. Regressions here re-open the bug where REDIS_PASSWORD was
honoured by the bus but silently ignored by token revocation.
"""
import pytest

from backend.common.adapters.redis_endpoint import (
    ProviderCacheOverride,
    RedisConfigurationError,
    RedisEndpointConfig,
    RedisRole,
    resolve_redis_config,
)

_ALL_VARS = [
    "REDIS_URL", "REDIS_USERNAME", "REDIS_PASSWORD", "CACHE_REDIS_URL",
    "REDIS_TLS_ENABLED", "REDIS_TLS_CA_CERTS", "REDIS_TLS_CERTFILE",
    "REDIS_TLS_KEYFILE", "REDIS_TLS_CERT_REQS", "REDIS_TLS_CHECK_HOSTNAME",
    "REDIS_CLUSTER_NODES",
]
for _role in ("STREAMS", "CACHE"):
    _ALL_VARS += [
        f"REDIS_{_role}_MODE", f"REDIS_{_role}_HOST", f"REDIS_{_role}_PORT",
        f"REDIS_{_role}_DB", f"REDIS_{_role}_USERNAME", f"REDIS_{_role}_PASSWORD",
        f"REDIS_{_role}_PASSWORD_FILE", f"REDIS_{_role}_TLS_ENABLED",
        f"REDIS_{_role}_TLS_CA_CERTS", f"REDIS_{_role}_TLS_CERTFILE",
        f"REDIS_{_role}_TLS_KEYFILE", f"REDIS_{_role}_TLS_CERT_REQS",
        f"REDIS_{_role}_TLS_CHECK_HOSTNAME", f"REDIS_{_role}_SENTINEL_MASTER",
        f"REDIS_{_role}_SENTINEL_NODES", f"REDIS_{_role}_CLUSTER_NODES",
    ]


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for v in _ALL_VARS:
        monkeypatch.delenv(v, raising=False)


# ── role isolation: THE invariant ───────────────────────────────────

def test_cache_and_streams_are_fully_independent(monkeypatch):
    monkeypatch.setenv("REDIS_STREAMS_HOST", "streams.internal")
    monkeypatch.setenv("REDIS_STREAMS_USERNAME", "bus-user")
    monkeypatch.setenv("REDIS_STREAMS_PASSWORD", "bus-pw")
    monkeypatch.setenv("REDIS_STREAMS_TLS_ENABLED", "true")
    monkeypatch.setenv("REDIS_STREAMS_TLS_CA_CERTS", "/certs/streams/ca.crt")

    monkeypatch.setenv("REDIS_CACHE_HOST", "cache.internal")
    monkeypatch.setenv("REDIS_CACHE_USERNAME", "cache-user")
    monkeypatch.setenv("REDIS_CACHE_PASSWORD", "cache-pw")
    monkeypatch.setenv("REDIS_CACHE_TLS_ENABLED", "true")
    monkeypatch.setenv("REDIS_CACHE_TLS_CA_CERTS", "/certs/cache/ca.crt")

    s = resolve_redis_config(RedisRole.STREAMS)
    c = resolve_redis_config(RedisRole.CACHE)

    assert (s.host, s.username, s.password) == ("streams.internal", "bus-user", "bus-pw")
    assert (c.host, c.username, c.password) == ("cache.internal", "cache-user", "cache-pw")
    assert s.tls.ca_certs == "/certs/streams/ca.crt"
    assert c.tls.ca_certs == "/certs/cache/ca.crt"


def test_streams_password_never_leaks_into_cache(monkeypatch):
    """Only the bus is configured. The cache must NOT inherit its credentials."""
    monkeypatch.setenv("REDIS_STREAMS_PASSWORD", "bus-pw")
    monkeypatch.setenv("REDIS_CACHE_HOST", "cache.internal")
    c = resolve_redis_config(RedisRole.CACHE)
    assert c.password is None
    assert c.username is None


# ── secret refs ─────────────────────────────────────────────────────

def test_password_file_wins_over_password_env(monkeypatch, tmp_path):
    pw = tmp_path / "pw"
    pw.write_text("from-file\n")          # trailing newline must be stripped
    monkeypatch.setenv("REDIS_CACHE_PASSWORD", "from-env")
    monkeypatch.setenv("REDIS_CACHE_PASSWORD_FILE", str(pw))
    cfg = resolve_redis_config(RedisRole.CACHE)
    assert cfg.password == "from-file"
    assert cfg.source["password"] == "REDIS_CACHE_PASSWORD_FILE"


def test_missing_password_file_is_an_error(monkeypatch):
    monkeypatch.setenv("REDIS_CACHE_PASSWORD_FILE", "/nope/missing")
    with pytest.raises(RedisConfigurationError, match="REDIS_CACHE_PASSWORD_FILE"):
        resolve_redis_config(RedisRole.CACHE)


# ── legacy back-compat, role-scoped ─────────────────────────────────

def test_legacy_redis_url_maps_to_streams_only(monkeypatch):
    monkeypatch.setenv("REDIS_URL", "redis://:legacy-pw@old-host:6380/0")
    s = resolve_redis_config(RedisRole.STREAMS)
    assert (s.host, s.port, s.db, s.password) == ("old-host", 6380, 0, "legacy-pw")
    assert "legacy" in s.source["host"]
    # The cache must NOT pick up REDIS_URL.
    c = resolve_redis_config(RedisRole.CACHE)
    assert c.host == "localhost" and c.password is None


def test_legacy_cache_url_maps_to_cache_only(monkeypatch):
    monkeypatch.setenv("CACHE_REDIS_URL", "redis://cache-host:6379/1")
    c = resolve_redis_config(RedisRole.CACHE)
    assert (c.host, c.db) == ("cache-host", 1)
    s = resolve_redis_config(RedisRole.STREAMS)
    assert s.host == "localhost"


def test_role_prefixed_wins_over_legacy(monkeypatch):
    monkeypatch.setenv("CACHE_REDIS_URL", "redis://legacy:6379/1")
    monkeypatch.setenv("REDIS_CACHE_HOST", "new-host")
    c = resolve_redis_config(RedisRole.CACHE)
    assert c.host == "new-host"
    assert c.source["host"] == "REDIS_CACHE_HOST"


def test_legacy_rediss_url_enables_tls(monkeypatch):
    monkeypatch.setenv("CACHE_REDIS_URL", "rediss://cache-host:6379/0")
    c = resolve_redis_config(RedisRole.CACHE)
    assert c.tls.enabled is True


# ── cluster is rejected for BOTH roles ──────────────────────────────

@pytest.mark.parametrize("role", [RedisRole.STREAMS, RedisRole.CACHE])
def test_cluster_mode_is_rejected(monkeypatch, role):
    monkeypatch.setenv(f"REDIS_{role.value.upper()}_MODE", "cluster")
    with pytest.raises(RedisConfigurationError, match="cluster"):
        resolve_redis_config(role)


def test_legacy_redis_cluster_nodes_still_rejected(monkeypatch):
    monkeypatch.setenv("REDIS_CLUSTER_NODES", "n1:7000")
    with pytest.raises(RedisConfigurationError, match="cluster"):
        resolve_redis_config(RedisRole.STREAMS)


# ── sentinel ────────────────────────────────────────────────────────

def test_sentinel_mode(monkeypatch):
    monkeypatch.setenv("REDIS_STREAMS_MODE", "sentinel")
    monkeypatch.setenv("REDIS_STREAMS_SENTINEL_MASTER", "mymaster")
    monkeypatch.setenv("REDIS_STREAMS_SENTINEL_NODES", "s1:26379,s2:26379")
    s = resolve_redis_config(RedisRole.STREAMS)
    assert s.mode == "sentinel"
    assert s.sentinel_master == "mymaster"
    assert s.sentinel_nodes == (("s1", 26379), ("s2", 26379))


def test_sentinel_without_master_is_an_error(monkeypatch):
    monkeypatch.setenv("REDIS_STREAMS_MODE", "sentinel")
    with pytest.raises(RedisConfigurationError, match="sentinel"):
        resolve_redis_config(RedisRole.STREAMS)


# ── per-provider cache override ─────────────────────────────────────

def test_provider_override_replaces_global_cache_wholesale(monkeypatch):
    monkeypatch.setenv("REDIS_CACHE_HOST", "global-cache")
    monkeypatch.setenv("REDIS_CACHE_PASSWORD", "global-pw")
    monkeypatch.setenv("REDIS_CACHE_TLS_ENABLED", "true")
    monkeypatch.setenv("REDIS_CACHE_TLS_CA_CERTS", "/certs/global/ca.crt")

    override = ProviderCacheOverride(
        provider_id="acme-prod",
        connection={
            "host": "acme-cache", "port": 6380, "db": 0,
            "tls": {"enabled": True, "caCertPath": "/certs/acme/ca.crt"},
        },
        credentials={"cache_username": "acme", "cache_password": "acme-pw"},
    )
    c = resolve_redis_config(RedisRole.CACHE, provider_cache=override)

    assert (c.host, c.port) == ("acme-cache", 6380)
    assert (c.username, c.password) == ("acme", "acme-pw")
    # Whole-endpoint: it must NOT inherit the global CA or the global password.
    assert c.tls.ca_certs == "/certs/acme/ca.crt"
    assert c.password != "global-pw"
    assert c.source["host"] == "provider:acme-prod"


def test_provider_legacy_cache_url_still_works():
    override = ProviderCacheOverride(
        provider_id="old", connection={},
        credentials={"cache_redis_url": "redis://:pw@old-cache:6379/1"},
    )
    c = resolve_redis_config(RedisRole.CACHE, provider_cache=override)
    assert (c.host, c.db, c.password) == ("old-cache", 1, "pw")
    assert "legacy" in c.source["host"]


def test_provider_cluster_mode_is_rejected():
    override = ProviderCacheOverride(
        provider_id="p", connection={"mode": "cluster", "host": "h"}, credentials={},
    )
    with pytest.raises(RedisConfigurationError, match="cluster"):
        resolve_redis_config(RedisRole.CACHE, provider_cache=override)


# ── describe() must never leak the password ─────────────────────────

def test_describe_redacts_the_password(monkeypatch):
    monkeypatch.setenv("REDIS_CACHE_HOST", "h")
    monkeypatch.setenv("REDIS_CACHE_PASSWORD", "super-secret")
    text = resolve_redis_config(RedisRole.CACHE).describe()
    assert "super-secret" not in text
    assert "h" in text
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
docker exec -u root synodic-dev-viz-service-1 pip install -q pytest pytest-asyncio
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/test_redis_endpoint.py -q -p no:cacheprovider
```

Expected: collection error — `ModuleNotFoundError: No module named 'backend.common.adapters.redis_endpoint'`.

- [ ] **Step 3: Implement the module**

Create `backend/common/adapters/redis_endpoint.py`:

```python
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
    """Read a mounted secret. A missing file is a HARD error — silently falling
    back to 'no password' is how an unauthenticated connect slips into prod."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError as exc:
        raise RedisConfigurationError(
            f"{var}={path!r} could not be read: {exc}. Refusing to connect without "
            f"the credential it names."
        ) from exc


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
        raise RedisConfigurationError(
            f"Redis Cluster is not supported for the {role.value!r} endpoint. "
            f"This is deliberate: graph_cache uses SCAN + multi-key DEL, the job "
            f"broker pipelines XADD across two un-tagged keys, and the role uses a "
            f"non-zero DB index — all incompatible with Cluster. Use a single node "
            f"or Sentinel. (Redis Cluster IS supported for FalkorDB — a different "
            f"role, see FALKORDB_DEPLOYMENT.md.)"
        )


# ── the resolver ────────────────────────────────────────────────────

def resolve_redis_config(
    role: RedisRole, *, provider_cache: Optional[ProviderCacheOverride] = None,
) -> RedisEndpointConfig:
    """Resolve one role's endpoint.

    Precedence:
        CACHE:   provider override -> REDIS_CACHE_*  -> CACHE_REDIS_URL (legacy)
        STREAMS: REDIS_STREAMS_*   -> REDIS_URL + REDIS_{USERNAME,PASSWORD,TLS_*}

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

    mode = (os.getenv(f"{prefix}MODE") or "standalone").strip().lower()
    if os.getenv(f"{prefix}MODE"):
        src["mode"] = f"{prefix}MODE"
    _reject_cluster(role, mode)

    # Legacy URL supplies the BASE for this role only; role-prefixed vars win.
    legacy_var = _LEGACY[role]
    legacy_url = os.getenv(legacy_var)
    base: Dict[str, Any] = {}
    if legacy_url:
        base = _parse_url(legacy_url)
        for k in base:
            src[k] = f"{legacy_var} (legacy)"
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
                src["password"] = src.get("password", "REDIS_PASSWORD (legacy)")
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
    sentinel_nodes = _parse_nodes(os.getenv(f"{prefix}SENTINEL_NODES"))
    if mode == "sentinel" and not (sentinel_master and sentinel_nodes):
        raise RedisConfigurationError(
            f"{role.value}: sentinel mode requires {prefix}SENTINEL_MASTER and "
            f"{prefix}SENTINEL_NODES."
        )

    return RedisEndpointConfig(
        role=role, mode=mode, host=host, port=port, db=db,
        username=username, password=password,
        sentinel_master=sentinel_master, sentinel_nodes=sentinel_nodes,
        sentinel_username=os.getenv(f"{prefix}SENTINEL_USERNAME"),
        sentinel_password=_resolve_password(
            prefix, "SENTINEL_PASSWORD", src, "sentinel_password",
        ),
        sentinel_auth_enabled=_as_bool(os.getenv(f"{prefix}SENTINEL_AUTH_ENABLED"), False),
        tls=tls,
        max_connections=int(os.getenv(f"{prefix}MAX_CONNECTIONS", "20")),
        socket_timeout=float(os.getenv(f"{prefix}SOCKET_TIMEOUT", "10")),
        socket_connect_timeout=float(os.getenv(f"{prefix}SOCKET_CONNECT_TIMEOUT", "5")),
        health_check_interval=int(os.getenv(f"{prefix}HEALTH_CHECK_INTERVAL", "30")),
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
        src = {k: f"{origin} cache_redis_url (legacy)" for k in
               ("host", "port", "db", "username", "password", "tls")}
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
            f"provider {ov.provider_id}: Redis Cluster is not supported for the cache "
            f"endpoint (see RedisRole.CACHE). Use standalone or sentinel."
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
    src = {k: origin for k in
           ("mode", "host", "port", "db", "username", "password", "tls")}
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
        max_connections=int(conn.get("maxConnections") or 20),
        socket_timeout=float(conn.get("socketTimeout") or 10),
        source=src,
    )
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/test_redis_endpoint.py -q -p no:cacheprovider
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/common/adapters/redis_endpoint.py backend/tests/test_redis_endpoint.py
git commit -m "Central Redis endpoint config: role-keyed resolver with independent auth + TLS

Cache and streams become fully independent endpoints — own host, own ACL user,
own password (env or rotatable *_PASSWORD_FILE), own TLS/mTLS PKI. Nothing is
inherited across roles, and nothing from FalkorDB. Cluster is rejected for both
roles with the concrete reasons named. Legacy REDIS_URL / CACHE_REDIS_URL keep
working, role-scoped. No callers yet."
```

---

### Task 2: `build_redis_client` factory

**Files:**
- Modify: `backend/common/adapters/redis_endpoint.py` (append)
- Test: `backend/tests/test_redis_endpoint_factory.py`

**Interfaces:**
- Consumes: `RedisEndpointConfig`, `RedisRole`, `tls_client_kwargs`.
- Produces: `def build_redis_client(cfg: RedisEndpointConfig, *, decode_responses: bool = True) -> "aioredis.Redis"`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_redis_endpoint_factory.py`:

```python
"""The single client factory. Every non-graph Redis client is built here, so these
assertions are what guarantee auth + TLS actually reach the wire for every role."""
import pytest

from backend.common.adapters.redis_endpoint import (
    RedisConfigurationError, RedisEndpointConfig, RedisRole, build_redis_client,
)
from backend.common.adapters.redis_tls import TLSSettings


def test_standalone_passes_auth_and_tls(monkeypatch):
    captured = {}
    import redis.asyncio as aioredis

    def fake_redis(**kw):
        captured.update(kw)
        return "CLIENT"

    monkeypatch.setattr(aioredis, "Redis", fake_redis)

    cfg = RedisEndpointConfig(
        role=RedisRole.CACHE, host="cache.internal", port=6380, db=2,
        username="cache-user", password="cache-pw",
        tls=TLSSettings.from_fields(
            enabled=True, ca_certs="/certs/cache/ca.crt",
            certfile="/certs/cache/client.crt", keyfile="/certs/cache/client.key",
        ),
    )
    assert build_redis_client(cfg) == "CLIENT"
    assert captured["host"] == "cache.internal"
    assert captured["port"] == 6380
    assert captured["db"] == 2
    assert captured["username"] == "cache-user"
    assert captured["password"] == "cache-pw"
    assert captured["ssl"] is True
    assert captured["ssl_ca_certs"] == "/certs/cache/ca.crt"
    assert captured["ssl_certfile"] == "/certs/cache/client.crt"
    assert captured["ssl_keyfile"] == "/certs/cache/client.key"


def test_plaintext_sends_no_ssl_kwargs(monkeypatch):
    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or "C")

    build_redis_client(RedisEndpointConfig(role=RedisRole.STREAMS, host="h"))
    assert "ssl" not in captured
    assert captured.get("username") is None
    assert captured.get("password") is None


def test_sentinel_uses_master_for_with_auth_and_tls(monkeypatch):
    captured = {}

    class FakeSentinel:
        def __init__(self, nodes, sentinel_kwargs=None, **kw):
            captured["nodes"] = nodes
            captured["sentinel_kwargs"] = sentinel_kwargs
            captured["kw"] = kw

        def master_for(self, name, **kw):
            captured["master"] = name
            captured["master_kw"] = kw
            return "MASTER"

    import redis.asyncio.sentinel as sentinel_mod
    monkeypatch.setattr(sentinel_mod, "Sentinel", FakeSentinel)

    cfg = RedisEndpointConfig(
        role=RedisRole.STREAMS, mode="sentinel",
        sentinel_master="mymaster", sentinel_nodes=(("s1", 26379),),
        username="u", password="pw",
        tls=TLSSettings.from_fields(enabled=True, ca_certs="/certs/streams/ca.crt"),
    )
    assert build_redis_client(cfg) == "MASTER"
    assert captured["master"] == "mymaster"
    assert captured["kw"]["password"] == "pw"
    assert captured["kw"]["ssl"] is True
    assert captured["kw"]["ssl_ca_certs"] == "/certs/streams/ca.crt"


def test_sentinel_daemons_get_no_auth_by_default(monkeypatch):
    """The FalkorDB work established this: sending the data-plane password to an
    UNAUTHENTICATED sentinel daemon makes redis-py raise on the AUTH reply and
    takes discover_master down. Only send it when explicitly opted in."""
    captured = {}

    class FakeSentinel:
        def __init__(self, nodes, sentinel_kwargs=None, **kw):
            captured["sentinel_kwargs"] = sentinel_kwargs or {}

        def master_for(self, name, **kw):
            return "MASTER"

    import redis.asyncio.sentinel as sentinel_mod
    monkeypatch.setattr(sentinel_mod, "Sentinel", FakeSentinel)

    build_redis_client(RedisEndpointConfig(
        role=RedisRole.STREAMS, mode="sentinel", sentinel_master="m",
        sentinel_nodes=(("s1", 26379),), password="data-plane-pw",
    ))
    assert "password" not in captured["sentinel_kwargs"]


def test_cluster_mode_config_is_refused_by_the_factory():
    cfg = RedisEndpointConfig(role=RedisRole.CACHE, mode="cluster", host="h")
    with pytest.raises(RedisConfigurationError, match="cluster"):
        build_redis_client(cfg)
```

- [ ] **Step 2: Run to verify it fails**

```bash
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/test_redis_endpoint_factory.py -q -p no:cacheprovider
```

Expected: `ImportError: cannot import name 'build_redis_client'`.

- [ ] **Step 3: Append the factory to `redis_endpoint.py`**

```python
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

    if cfg.mode == "cluster":
        _reject_cluster(cfg.role, "cluster")

    common: Dict[str, Any] = {
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

    client = aioredis.Redis(host=cfg.host, port=cfg.port, db=cfg.db, **common)
    logger.info("redis_endpoint: %s", cfg.describe())
    return client
```

- [ ] **Step 4: Run both endpoint test files**

```bash
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/test_redis_endpoint.py backend/tests/test_redis_endpoint_factory.py -q -p no:cacheprovider
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/common/adapters/redis_endpoint.py backend/tests/test_redis_endpoint_factory.py
git commit -m "build_redis_client: the single factory for every non-graph Redis client

Standalone + Sentinel, honouring the role's ACL auth and its own TLS/mTLS.
Sentinel daemons get credentials only when explicitly configured (an
unauthenticated sentinel raises on the AUTH reply and breaks discover_master)."
```

---

### Task 3: `build_bus_redis` becomes a STREAMS wrapper

**Files:**
- Modify: `backend/common/adapters/redis_bus.py` (replace body; keep the public names)
- Test: `backend/tests/test_bus_redis.py` (existing — must stay green)

**Interfaces:**
- Consumes: `resolve_redis_config`, `build_redis_client`, `RedisRole`, `RedisConfigurationError`.
- Produces: `build_bus_redis(**kwargs)` unchanged signature; `BusConfigurationError = RedisConfigurationError` (alias, so `from ... import BusConfigurationError` keeps working).

Callers that must keep working untouched: `backend/app/services/aggregation/redis_client.py:104`, `backend/app/services/versioning/messaging.py:40`.

- [ ] **Step 1: Rewrite `redis_bus.py`**

```python
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
    # Callers pass pool sizing; env wins when it explicitly set them.
    src = cfg.source
    if "max_connections" not in src:
        cfg = dataclasses.replace(cfg, max_connections=max_connections)
    if "socket_timeout" not in src:
        cfg = dataclasses.replace(
            cfg,
            socket_timeout=float(socket_timeout),
            socket_connect_timeout=float(socket_connect_timeout),
        )
    return build_redis_client(cfg, decode_responses=decode_responses)
```

- [ ] **Step 2: Run the EXISTING bus tests — they must still pass**

```bash
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/test_bus_redis.py -q -p no:cacheprovider
```

Expected: PASS. If `test_single_node_plain` fails because it patches `aioredis.from_url` while the factory now calls `aioredis.Redis`, update that test to patch `aioredis.Redis` and assert on `host`/`port`/`db` instead of the URL string — the behaviour under test (no ssl kwargs on a plaintext endpoint) is unchanged.

- [ ] **Step 3: Add a regression test that the bus now honours a password**

Append to `backend/tests/test_bus_redis.py`:

```python
def test_bus_honours_password_and_tls(monkeypatch):
    _clear_bus_env(monkeypatch)
    monkeypatch.setenv("REDIS_URL", "redis://bus-host:6380/0")
    monkeypatch.setenv("REDIS_PASSWORD", "bus-pw")
    monkeypatch.setenv("REDIS_TLS_ENABLED", "true")
    monkeypatch.setenv("REDIS_TLS_CA_CERTS", "/certs/streams/ca.crt")
    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or "C")

    assert build_bus_redis() == "C"
    assert captured["password"] == "bus-pw"
    assert captured["ssl"] is True
    assert captured["ssl_ca_certs"] == "/certs/streams/ca.crt"
```

- [ ] **Step 4: Run the full Redis test set**

```bash
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/test_bus_redis.py backend/tests/test_redis_endpoint.py backend/tests/test_redis_endpoint_factory.py -q -p no:cacheprovider
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/common/adapters/redis_bus.py backend/tests/test_bus_redis.py
git commit -m "build_bus_redis delegates to the central factory (STREAMS role)

Behaviour preserved for its two callers (aggregation, versioning messaging) and
its Cluster-rejection contract; BusConfigurationError is now an alias of
RedisConfigurationError."
```

---

### Task 4: Token revocation honours auth + TLS — the primary bug fix

**Files:**
- Modify: `backend/app/services/revocation_service.py:82-104` (the `RedisBackend` ctor) and its instantiation site (~`:442`)
- Test: `backend/tests/test_revocation_redis_auth.py`

**Interfaces:**
- Consumes: `resolve_redis_config`, `build_redis_client`, `RedisRole` from Task 1/2.
- Produces: `RedisBackend(client)` — now takes a **client**, not a URL.

This is the fix for the reported symptom: `revocation_service` built its own `from_url(REDIS_URL)` and ignored `REDIS_PASSWORD` / `REDIS_USERNAME` / `REDIS_TLS_*` entirely. Setting a password made the bus authenticate while revocation — which runs on **every authenticated request** — silently did not.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_revocation_redis_auth.py`:

```python
"""Regression: token revocation MUST authenticate.

revocation_service used to call from_url(REDIS_URL) directly, so REDIS_PASSWORD /
REDIS_USERNAME / REDIS_TLS_* were ignored. Enabling AUTH on the bus therefore
authenticated the job stream while breaking auth on every request. This is the
test that would have caught it.
"""
import pytest


def test_revocation_client_carries_auth_and_tls(monkeypatch):
    for v in ("REDIS_STREAMS_HOST", "REDIS_STREAMS_PASSWORD", "REDIS_TLS_ENABLED"):
        monkeypatch.delenv(v, raising=False)
    monkeypatch.setenv("REDIS_URL", "redis://bus:6379/0")
    monkeypatch.setenv("REDIS_USERNAME", "app")
    monkeypatch.setenv("REDIS_PASSWORD", "s3cret")
    monkeypatch.setenv("REDIS_TLS_ENABLED", "true")
    monkeypatch.setenv("REDIS_TLS_CA_CERTS", "/certs/streams/ca.crt")

    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or object())

    from backend.app.services.revocation_service import build_revocation_backend

    build_revocation_backend()

    assert captured["username"] == "app"
    assert captured["password"] == "s3cret"
    assert captured["ssl"] is True
    assert captured["ssl_ca_certs"] == "/certs/streams/ca.crt"
```

- [ ] **Step 2: Run to verify it fails**

```bash
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/test_revocation_redis_auth.py -q -p no:cacheprovider
```

Expected: `ImportError: cannot import name 'build_revocation_backend'`.

- [ ] **Step 3: Change `RedisBackend` to take a client, and add the builder**

In `backend/app/services/revocation_service.py`, replace the `RedisBackend.__init__` (currently `def __init__(self, url: str)` building `redis_async.from_url(url, ...)`) with:

```python
    def __init__(self, client):
        """Takes an already-built client from the central factory.

        It used to build its own ``from_url(REDIS_URL)``, which ignored
        REDIS_USERNAME / REDIS_PASSWORD / REDIS_TLS_* — so turning on AUTH
        authenticated the bus and silently broke revocation, which runs on every
        authenticated request. Never construct a Redis client here.
        """
        self._client = client
```

Add, near the bottom of the module (next to the existing singleton wiring at ~`:442`):

```python
def build_revocation_backend() -> "RedisBackend":
    """Revocation rides the STREAMS endpoint — the same coordination Redis as the
    bus, with the same credentials and TLS, resolved centrally."""
    import dataclasses

    from backend.common.adapters.redis_endpoint import (
        RedisRole, build_redis_client, resolve_redis_config,
    )

    cfg = resolve_redis_config(RedisRole.STREAMS)
    # Revocation is on the hot auth path: keep its short fail-open budget.
    cfg = dataclasses.replace(
        cfg,
        socket_timeout=REVOCATION_SOCKET_TIMEOUT_S,
        socket_connect_timeout=REVOCATION_SOCKET_TIMEOUT_S,
    )
    return RedisBackend(build_redis_client(cfg))
```

Then update the existing instantiation (the line that reads roughly `backend = RedisBackend(REDIS_URL)` around `:442`) to `backend = build_revocation_backend()`. Delete the now-unused module-level `REDIS_URL` constant at `:32` — it carried a *different default port* (`6379`) from the bus (`6380`), which is itself a latent bug.

- [ ] **Step 4: Run the test + the existing revocation suite**

```bash
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/test_revocation_redis_auth.py -q -p no:cacheprovider
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/ -q -p no:cacheprovider -k "revocation or revoke"
```

Expected: PASS. Fix any existing revocation test that constructs `RedisBackend("redis://...")` — it now takes a client; pass a fake object with `exists` / `set_with_ttl` / `sadd` / `smembers`.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/revocation_service.py backend/tests/test_revocation_redis_auth.py
git commit -m "Token revocation now authenticates: route it through the central factory

THE bug. revocation_service built its own from_url(REDIS_URL) and ignored
REDIS_PASSWORD / REDIS_USERNAME / REDIS_TLS_* entirely, so enabling AUTH on the
coordination Redis authenticated the job bus while silently breaking revocation —
which runs on every authenticated request. It now resolves the STREAMS endpoint
centrally. Also drops its divergent default port (6379 vs the bus's 6380)."
```

---

### Task 5: Health probes honour auth + TLS

**Files:**
- Modify: `backend/app/services/system_status/probes.py:93-105` (`_cache_redis`) and `:418-425` (`_falkor_node_probe`)
- Test: `backend/tests/test_probes_redis_auth.py`

**Interfaces:**
- Consumes: `resolve_redis_config`, `build_redis_client`, `RedisRole`; for the FalkorDB node probe, `load_connection_config` + `tls_client_kwargs` (already imported in the FalkorDB path).
- Produces: no new public API.

A probe that cannot authenticate reports a healthy service as **down** — the single most confusing failure mode when you first enable AUTH.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_probes_redis_auth.py`:

```python
"""A health probe that can't authenticate reports a healthy service as DOWN.
Both probe clients must carry the same credentials/TLS as the real clients."""
import pytest


def test_cache_probe_carries_cache_auth_and_tls(monkeypatch):
    monkeypatch.delenv("CACHE_REDIS_URL", raising=False)
    monkeypatch.setenv("REDIS_CACHE_HOST", "cache.internal")
    monkeypatch.setenv("REDIS_CACHE_USERNAME", "cache-user")
    monkeypatch.setenv("REDIS_CACHE_PASSWORD", "cache-pw")
    monkeypatch.setenv("REDIS_CACHE_TLS_ENABLED", "true")
    monkeypatch.setenv("REDIS_CACHE_TLS_CA_CERTS", "/certs/cache/ca.crt")

    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or object())

    from backend.app.services.system_status import probes
    probes._cache_redis_client = None          # reset the module singleton
    assert probes._cache_redis() is not None

    assert captured["host"] == "cache.internal"
    assert captured["username"] == "cache-user"
    assert captured["password"] == "cache-pw"
    assert captured["ssl"] is True
    assert captured["ssl_ca_certs"] == "/certs/cache/ca.crt"


def test_falkor_node_probe_carries_falkordb_auth(monkeypatch):
    """The FalkorDB node probe built a bare Redis(host, port) and would fail on an
    authenticated instance."""
    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or object())

    from backend.app.services.system_status import probes
    probes._build_falkor_probe_client("fdb-host", 6379,
                                      username="graph", password="graph-pw")
    assert captured["username"] == "graph"
    assert captured["password"] == "graph-pw"
```

- [ ] **Step 2: Run to verify it fails**

```bash
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/test_probes_redis_auth.py -q -p no:cacheprovider
```

Expected: FAIL — `_cache_redis` returns `None` (no `CACHE_REDIS_URL`), and `_build_falkor_probe_client` does not exist.

- [ ] **Step 3: Rewrite both probe clients**

Replace `_cache_redis` (`probes.py:93-105`):

```python
def _cache_redis():
    """Probe client for the CACHE endpoint — resolved centrally so it carries the
    same auth + TLS as the real cache client. A probe that cannot authenticate
    reports a healthy cache as DOWN."""
    global _cache_redis_client
    if _cache_redis_client is None:
        import dataclasses

        from backend.common.adapters.redis_endpoint import (
            RedisConfigurationError, RedisRole, build_redis_client,
            resolve_redis_config,
        )
        try:
            cfg = resolve_redis_config(RedisRole.CACHE)
        except RedisConfigurationError:
            return None
        if cfg.source.get("host", "default") == "default":
            return None                      # cache not configured -> nothing to probe
        cfg = dataclasses.replace(
            cfg, socket_timeout=1.0, socket_connect_timeout=1.0, max_connections=2,
        )
        _cache_redis_client = build_redis_client(cfg)
    return _cache_redis_client
```

Add above `_falkor_node_probe`:

```python
def _build_falkor_probe_client(
    host: str, port: int, *, username=None, password=None, tls=None,
):
    """Short-lived probe client for ONE FalkorDB node, carrying the graph
    connection's auth + TLS. It used to be a bare Redis(host, port), which cannot
    talk to an authenticated instance at all."""
    import redis.asyncio as aioredis

    from backend.common.adapters.redis_tls import tls_client_kwargs

    kw = dict(
        host=host, port=port, decode_responses=True,
        socket_connect_timeout=1, socket_timeout=1.5,
        **tls_client_kwargs(tls),
    )
    if username:
        kw["username"] = username
    if password:
        kw["password"] = password
    return aioredis.Redis(**kw)
```

Change `_falkor_node_probe` to accept and forward credentials:

```python
async def _falkor_node_probe(
    host: str, port: int, label: str, *, username=None, password=None, tls=None,
) -> dict:
    """One FalkorDB node: PING + INFO + its own GRAPH.LIST count. Builds a
    short-lived client (nodes come and go on a rotation, so nothing is cached)."""
    client = _build_falkor_probe_client(
        host, port, username=username, password=password, tls=tls,
    )
```

(keep the rest of the function body unchanged) — then update its call sites in
`probes.py` (the cluster fan-out around `:495` and the standalone/sentinel path) to
pass `username=cfg.username, password=cfg.password, tls=cfg.tls_settings()` from the
FalkorDB `FalkorDBConnConfig` they already resolve.

- [ ] **Step 4: Run the tests**

```bash
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/test_probes_redis_auth.py -q -p no:cacheprovider
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/ -q -p no:cacheprovider -k "probe or system_status"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/system_status/probes.py backend/tests/test_probes_redis_auth.py
git commit -m "Health probes authenticate: cache probe + FalkorDB node probe carry auth/TLS

Both built bare clients with no credentials, so the first thing that breaks when
you enable AUTH is the dashboard telling you everything is down."
```

---

### Task 6: Per-provider cache schema + validation

**Files:**
- Modify: `backend/common/models/management.py` — `ConnectionCredentials` (`:30-45`), add `_validate_cache_connection`, wire it into `ProviderCreateRequest` (`:262`) and `ProviderUpdateRequest` (`:319`)
- Test: `backend/tests/test_cache_connection_schema.py`

**Interfaces:**
- Produces:
  - `ConnectionCredentials` gains: `cache_username`, `cache_password`, `cache_sentinel_username`, `cache_sentinel_password`, `sentinel_username`, `sentinel_password` (all `Optional[str] = None`). `cache_redis_url` stays (legacy).
  - `def _validate_cache_connection(extra: dict) -> None` — raises `ValueError` (→ 422) on `mode: "cluster"`, on sentinel without master/nodes, and on **any secret-looking key** inside `cacheConnection`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_cache_connection_schema.py`:

```python
"""extra_config is PLAINTEXT in the DB and is returned by ProviderResponse.
Secrets must therefore never be accepted into it — that is exactly how
falkordbConnection.sentinel.password ended up stored in the clear and echoed
back over the API."""
import pytest
from pydantic import ValidationError

from backend.common.models.management import ProviderCreateRequest


def _req(**extra):
    return dict(
        name="p", providerType="falkordb", host="h", port=6379,
        credentials={"username": "u", "password": "p"}, **extra,
    )


def test_valid_cache_connection_is_accepted():
    r = ProviderCreateRequest(**_req(extraConfig={
        "cacheConnection": {
            "mode": "standalone", "host": "cache-b", "port": 6379, "db": 0,
            "tls": {"enabled": True, "caCertPath": "/certs/cache/ca.crt"},
        }
    }))
    assert r.extra_config["cacheConnection"]["host"] == "cache-b"


def test_cluster_mode_is_rejected():
    with pytest.raises(ValidationError, match="cluster"):
        ProviderCreateRequest(**_req(extraConfig={
            "cacheConnection": {"mode": "cluster", "host": "h"}
        }))


def test_sentinel_requires_master_and_nodes():
    with pytest.raises(ValidationError, match="sentinel"):
        ProviderCreateRequest(**_req(extraConfig={
            "cacheConnection": {"mode": "sentinel", "host": "h"}
        }))


@pytest.mark.parametrize("secret_key", ["password", "cachePassword", "authToken"])
def test_secrets_are_refused_inside_extra_config(secret_key):
    with pytest.raises(ValidationError, match="credentials"):
        ProviderCreateRequest(**_req(extraConfig={
            "cacheConnection": {"host": "h", secret_key: "leaked"}
        }))


def test_cache_credentials_are_accepted_in_the_encrypted_blob():
    r = ProviderCreateRequest(**_req(credentials={
        "username": "u", "password": "p",
        "cache_username": "cu", "cache_password": "cp",
    }))
    assert r.credentials.cache_username == "cu"
    assert r.credentials.cache_password == "cp"
```

- [ ] **Step 2: Run to verify it fails**

```bash
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/test_cache_connection_schema.py -q -p no:cacheprovider
```

Expected: FAIL — `extra = "forbid"` rejects `cache_username`, and no `cacheConnection` validation exists.

- [ ] **Step 3: Extend the models**

In `backend/common/models/management.py`, add to `ConnectionCredentials` (after `cache_redis_url`):

```python
    # ── Dedicated CACHE endpoint credentials (Fernet-encrypted, never returned).
    # The non-secret half (host/port/db/tls paths) rides extra_config.cacheConnection.
    cache_username: Optional[str] = None
    cache_password: Optional[str] = None
    cache_sentinel_username: Optional[str] = None
    cache_sentinel_password: Optional[str] = None
    # ── FalkorDB SENTINEL daemon credentials. These used to live in
    # extra_config.falkordbConnection.sentinel — an UNENCRYPTED column that
    # ProviderResponse returns to clients. Moved here; the old location is still
    # read for one release (see falkordb_connection.load_connection_config).
    sentinel_username: Optional[str] = None
    sentinel_password: Optional[str] = None
```

Add the validator (next to `_validate_falkordb_connection` at `:197`):

```python
_SECRET_HINTS = ("password", "passwd", "secret", "token", "credential")


def _validate_cache_connection(extra: Optional[Dict[str, Any]]) -> None:
    """Validate extra_config.cacheConnection.

    extra_config is a PLAINTEXT column AND is returned by ProviderResponse, so a
    secret in here is stored in the clear and echoed back. Refuse them outright
    rather than trusting a redaction pass to catch every future key.
    """
    if not extra:
        return
    conn = extra.get("cacheConnection")
    if conn is None:
        return
    if not isinstance(conn, dict):
        raise ValueError("cacheConnection must be an object")

    def _scan(node: Any, path: str = "") -> None:
        if isinstance(node, dict):
            for k, v in node.items():
                if any(h in k.lower() for h in _SECRET_HINTS):
                    raise ValueError(
                        f"cacheConnection.{path}{k} looks like a secret. extra_config "
                        f"is stored unencrypted and returned by the API — put it in "
                        f"credentials (cache_password / cache_sentinel_password) "
                        f"instead."
                    )
                _scan(v, f"{path}{k}.")

    _scan(conn)

    mode = (conn.get("mode") or "standalone").strip().lower()
    if mode == "cluster":
        raise ValueError(
            "cacheConnection.mode 'cluster' is not supported. The cache uses SCAN + "
            "multi-key DEL and a non-zero DB index, neither of which works on a "
            "Redis Cluster. Use 'standalone' or 'sentinel'. (Cluster IS supported "
            "for the FalkorDB graph — see falkordbConnection.)"
        )
    if mode not in ("standalone", "sentinel"):
        raise ValueError(f"cacheConnection.mode must be standalone|sentinel, got {mode!r}")
    if mode == "sentinel":
        s = conn.get("sentinel") or {}
        if not s.get("masterName") or not s.get("nodes"):
            raise ValueError(
                "cacheConnection sentinel mode requires sentinel.masterName and "
                "sentinel.nodes"
            )
```

Wire it into both requests' existing `@model_validator` — add a call alongside `_validate_falkordb_connection(self.extra_config)`:

```python
        _validate_cache_connection(self.extra_config)
```

- [ ] **Step 4: Run the tests**

```bash
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/test_cache_connection_schema.py -q -p no:cacheprovider
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/ -q -p no:cacheprovider -k "provider and (model or schema or validate)"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/common/models/management.py backend/tests/test_cache_connection_schema.py
git commit -m "Per-provider cacheConnection schema: structured config + encrypted credentials

Non-secret topology/TLS-paths ride extra_config.cacheConnection (mirroring
falkordbConnection); secrets go in the Fernet-encrypted credentials blob. The
validator REFUSES any secret-looking key inside extra_config — that column is
plaintext and is returned by the API, which is how sentinel.password leaked."
```

---

### Task 7: `build_cache_client` uses the factory; startup validation per role

**Files:**
- Modify: `backend/app/providers/falkordb_connection.py:624-673` (`build_cache_client`, delete `build_cache_redis_fallback`)
- Modify: `backend/app/providers/falkordb_provider.py:1030-1085` (pass the provider override)
- Modify: `backend/app/providers/manager.py:118-138` (`_assert_dedicated_cache_configured`)
- Test: `backend/tests/test_cache_client_endpoint.py`

**Interfaces:**
- Consumes: `resolve_redis_config`, `build_redis_client`, `ProviderCacheOverride`, `RedisRole`.
- Produces: `build_cache_client(*, provider_id: str, extra_config: dict, credentials: dict) -> Optional[Redis]` — **signature changes**: it no longer takes `cfg: FalkorDBConnConfig` or `cache_url`, because inheriting the graph's TLS was the bug.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_cache_client_endpoint.py`:

```python
"""The cache must NOT inherit FalkorDB's TLS. Old behaviour:
 - FalkorDB TLS off + rediss:// cache  -> silently used the system trust store
 - FalkorDB TLS on  + redis://  cache  -> NO TLS at all
Both are undiagnosable. The cache now owns its TLS."""
import pytest

from backend.app.providers.falkordb_connection import build_cache_client


def test_cache_uses_its_own_tls_not_falkordbs(monkeypatch):
    monkeypatch.delenv("CACHE_REDIS_URL", raising=False)
    monkeypatch.setenv("REDIS_CACHE_HOST", "cache.internal")
    monkeypatch.setenv("REDIS_CACHE_PASSWORD", "cache-pw")
    monkeypatch.setenv("REDIS_CACHE_TLS_ENABLED", "true")
    monkeypatch.setenv("REDIS_CACHE_TLS_CA_CERTS", "/certs/cache/ca.crt")
    # FalkorDB's own TLS — must NOT reach the cache client.
    monkeypatch.setenv("FALKORDB_TLS_ENABLED", "true")
    monkeypatch.setenv("FALKORDB_TLS_CA_CERTS", "/certs/graph/ca.crt")

    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or object())

    client = build_cache_client(provider_id="p1", extra_config={}, credentials={})
    assert client is not None
    assert captured["host"] == "cache.internal"
    assert captured["password"] == "cache-pw"
    assert captured["ssl_ca_certs"] == "/certs/cache/ca.crt"   # NOT /certs/graph/ca.crt


def test_provider_override_beats_the_global_cache(monkeypatch):
    monkeypatch.setenv("REDIS_CACHE_HOST", "global-cache")
    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or object())

    build_cache_client(
        provider_id="acme",
        extra_config={"cacheConnection": {"host": "acme-cache", "port": 6380}},
        credentials={"cache_username": "acme", "cache_password": "acme-pw"},
    )
    assert captured["host"] == "acme-cache"
    assert captured["port"] == 6380
    assert captured["username"] == "acme"
    assert captured["password"] == "acme-pw"


def test_no_cache_configured_returns_none(monkeypatch):
    for v in ("CACHE_REDIS_URL", "REDIS_CACHE_HOST"):
        monkeypatch.delenv(v, raising=False)
    assert build_cache_client(provider_id="p", extra_config={}, credentials={}) is None
```

- [ ] **Step 2: Run to verify it fails**

```bash
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/test_cache_client_endpoint.py -q -p no:cacheprovider
```

Expected: FAIL — `build_cache_client` takes different arguments.

- [ ] **Step 3: Rewrite `build_cache_client`**

Replace `build_cache_client` and **delete** `build_cache_redis_fallback` (dead: it always returns `None` and has no production callers) in `backend/app/providers/falkordb_connection.py`:

```python
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
    if cfg.source.get("host", "default") == "default":
        return None                      # nothing configured anywhere → cache off
    return build_redis_client(cfg)
```

In `backend/app/providers/falkordb_provider.py`, `FalkorDBProvider` must now carry the raw `extra_config` and decrypted `credentials`. Replace the `cache_redis_url` resolution at `:1030` and the `build_cache_client(...)` call at `:1072-1076` with:

```python
            self._redis = None
            try:
                cache_client = build_cache_client(
                    provider_id=self._provider_id or "env",
                    extra_config=self._extra_config,
                    credentials=self._credentials,
                )
```

Add `provider_id`, `extra_config` and `credentials` to `FalkorDBProvider.__init__` (keeping `cache_redis_url` as a deprecated alias that is folded into `credentials["cache_redis_url"]`), and update the two construction sites — `manager.py:1057` and `registry/provider_registry.py:316` — to pass them.

Replace `ProviderManager._assert_dedicated_cache_configured` (`manager.py:118-138`) with:

```python
    def _assert_redis_roles_configured(self) -> None:
        """Deployed roles must have every Redis endpoint they use resolvable.

        The old guard only checked the *env* CACHE_REDIS_URL, so a deployment that
        configured the cache purely per-provider failed to boot. Validate the roles
        this process actually uses, and fail with the role, the resolved host and
        what is missing — never a silent cache-off or a silent unauthenticated
        connect.
        """
        from backend.common.adapters.redis_endpoint import (
            RedisConfigurationError, RedisRole, resolve_redis_config,
        )

        if not is_deployed_role():
            return
        for role in (RedisRole.STREAMS, RedisRole.CACHE):
            try:
                cfg = resolve_redis_config(role)
            except RedisConfigurationError as exc:
                raise RuntimeError(f"Redis {role.value} endpoint mis-configured: {exc}")
            if role is RedisRole.STREAMS and cfg.source.get("host", "default") == "default":
                raise RuntimeError(
                    "Redis STREAMS endpoint is not configured. Set REDIS_STREAMS_HOST "
                    "(or the legacy REDIS_URL)."
                )
            logger.info("providers: redis %s", cfg.describe())
```

(Keep the existing `is_deployed_role()` predicate the old guard used. The CACHE role is *not* required globally any more — a deployment may configure it only per provider — so it is resolved and logged, not enforced.)

- [ ] **Step 4: Run the tests**

```bash
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/test_cache_client_endpoint.py backend/tests/test_falkordb_connection.py -q -p no:cacheprovider
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/ -q -p no:cacheprovider -k "cache or provider_manager"
```

Expected: PASS. `test_falkordb_connection.py` has two tests calling `build_cache_redis_fallback` (`:370`, `:377`) — delete them; the function is gone.

- [ ] **Step 5: Commit**

```bash
git add backend/app/providers/falkordb_connection.py backend/app/providers/falkordb_provider.py \
        backend/app/providers/manager.py backend/app/registry/provider_registry.py \
        backend/tests/test_cache_client_endpoint.py backend/tests/test_falkordb_connection.py
git commit -m "Provider cache: own endpoint, own auth, own TLS (stop inheriting FalkorDB's)

build_cache_client resolves the CACHE role centrally, with a whole-endpoint
per-provider override. It no longer derives TLS from the GRAPH connection —
which silently gave 'no TLS' or 'system trust store' depending on the URL scheme.
Startup validation now checks the roles a process actually uses instead of only
the env CACHE_REDIS_URL (which failed any per-provider-only deployment).
Deletes the dead build_cache_redis_fallback."
```

---

### Task 8: Neo4j provider cache uses the factory

**Files:**
- Modify: `backend/graph/adapters/neo4j_provider.py:269`
- Test: `backend/tests/test_neo4j_cache_endpoint.py`

**Interfaces:** Consumes `build_cache_client` from Task 7.

- [ ] **Step 1: Write the failing test**

```python
"""The Neo4j provider had its OWN cache client from extra_config['redisUrl'] with no
auth and no TLS — a third divergent path."""
def test_neo4j_cache_goes_through_the_central_factory(monkeypatch):
    monkeypatch.setenv("REDIS_CACHE_HOST", "cache.internal")
    monkeypatch.setenv("REDIS_CACHE_PASSWORD", "cache-pw")
    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or object())

    from backend.graph.adapters.neo4j_provider import build_neo4j_cache_client
    build_neo4j_cache_client(provider_id="n1", extra_config={}, credentials={})
    assert captured["host"] == "cache.internal"
    assert captured["password"] == "cache-pw"
```

Save as `backend/tests/test_neo4j_cache_endpoint.py`.

- [ ] **Step 2: Run to verify it fails**

```bash
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/test_neo4j_cache_endpoint.py -q -p no:cacheprovider
```

Expected: `ImportError: cannot import name 'build_neo4j_cache_client'`.

- [ ] **Step 3: Implement**

In `backend/graph/adapters/neo4j_provider.py`, replace the `aioredis.from_url(redis_url, decode_responses=True)` at `:269` with a call to a new module-level helper:

```python
def build_neo4j_cache_client(*, provider_id: str, extra_config: dict, credentials: dict):
    """Neo4j's ancestor cache rides the same CACHE endpoint as every other provider.

    It used to build its own client from extra_config['redisUrl'] with no auth and no
    TLS. That key is now a legacy alias folded into the credentials blob.
    """
    from backend.app.providers.falkordb_connection import build_cache_client

    creds = dict(credentials or {})
    legacy = (extra_config or {}).get("redisUrl")
    if legacy and not creds.get("cache_redis_url"):
        creds["cache_redis_url"] = legacy
    return build_cache_client(
        provider_id=provider_id, extra_config=extra_config, credentials=creds,
    )
```

and have the provider call it with its own `provider_id` / `extra_config` / `credentials`.

- [ ] **Step 4: Run**

```bash
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/test_neo4j_cache_endpoint.py -q -p no:cacheprovider
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/graph/adapters/neo4j_provider.py backend/tests/test_neo4j_cache_endpoint.py
git commit -m "Neo4j provider cache routes through the central factory (gains auth + TLS)"
```

---

### Task 9: Security — merge-not-replace credentials, sentinel secret migration, response redaction

**Files:**
- Modify: `backend/app/db/repositories/provider_repo.py:129-130`
- Modify: `backend/common/models/management.py` — `ProviderResponse` redaction
- Modify: `backend/app/providers/falkordb_connection.py:205-210` (read sentinel creds from the credentials blob, fall back to the old location)
- Test: `backend/tests/test_provider_secret_handling.py`

**Interfaces:**
- Produces: `def redact_extra_config(extra: Optional[dict]) -> Optional[dict]` in `management.py`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_provider_secret_handling.py`:

```python
"""Two verified defects, fixed here.

1. falkordbConnection.sentinel.password rode extra_config — a PLAINTEXT column
   (db/models.py:284) that ProviderResponse RETURNS to clients.
2. provider_repo did `row.credentials = _encrypt(req.credentials.model_dump())` — a
   full replace, so a partial update wiped every omitted secret.
"""
import pytest

from backend.common.models.management import redact_extra_config


def test_redaction_strips_secret_keys_from_extra_config():
    out = redact_extra_config({
        "falkordbConnection": {
            "mode": "sentinel",
            "sentinel": {"masterName": "m", "username": "su", "password": "LEAK"},
        },
        "cacheConnection": {"host": "h"},
    })
    assert out["falkordbConnection"]["sentinel"]["password"] == "***"
    assert out["falkordbConnection"]["sentinel"]["masterName"] == "m"
    assert out["cacheConnection"]["host"] == "h"


def test_redaction_is_recursive_and_case_insensitive():
    out = redact_extra_config({"a": {"b": {"authToken": "LEAK", "apiSecret": "LEAK"}}})
    assert out["a"]["b"]["authToken"] == "***"
    assert out["a"]["b"]["apiSecret"] == "***"


@pytest.mark.asyncio
async def test_partial_credentials_update_does_not_wipe_other_secrets(db_session):
    """Updating ONLY the cache password must not blank the FalkorDB password."""
    from backend.app.db.repositories import provider_repo
    from backend.common.models.management import (
        ProviderCreateRequest, ProviderUpdateRequest,
    )

    created = await provider_repo.create_provider(db_session, ProviderCreateRequest(
        name="p", providerType="falkordb", host="h", port=6379,
        credentials={"username": "graph-u", "password": "graph-pw"},
    ))
    await provider_repo.update_provider(db_session, created.id, ProviderUpdateRequest(
        credentials={"cache_password": "cache-pw"},
    ))
    creds = await provider_repo.get_credentials(db_session, created.id)
    assert creds["cache_password"] == "cache-pw"
    assert creds["password"] == "graph-pw"      # NOT wiped
    assert creds["username"] == "graph-u"


@pytest.mark.asyncio
async def test_explicit_null_clears_a_credential(db_session):
    from backend.app.db.repositories import provider_repo
    from backend.common.models.management import (
        ProviderCreateRequest, ProviderUpdateRequest,
    )

    created = await provider_repo.create_provider(db_session, ProviderCreateRequest(
        name="p2", providerType="falkordb", host="h", port=6379,
        credentials={"username": "u", "password": "pw"},
    ))
    await provider_repo.update_provider(db_session, created.id, ProviderUpdateRequest(
        credentials={"password": None}, credentials_clear=["password"],
    ))
    creds = await provider_repo.get_credentials(db_session, created.id)
    assert creds.get("password") in (None, "")
    assert creds["username"] == "u"
```

If the repo has no `db_session` fixture, reuse the session fixture the existing provider-repo tests use (`grep -rn "async def db_session\|@pytest.fixture" backend/tests/conftest.py`) and match it exactly.

- [ ] **Step 2: Run to verify it fails**

```bash
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/test_provider_secret_handling.py -q -p no:cacheprovider
```

Expected: `ImportError: cannot import name 'redact_extra_config'`.

- [ ] **Step 3: Implement all three fixes**

**(a) Redaction** — add to `backend/common/models/management.py`:

```python
def redact_extra_config(extra: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Mask secret-looking values anywhere in extra_config before it leaves the API.

    extra_config is an UNENCRYPTED column and ProviderResponse returns it, so any
    secret written there is both stored in the clear and echoed back. The schema
    validator (``_validate_cache_connection``) refuses new secrets; this is the
    belt-and-braces pass that also covers values already in the database.
    """
    if not extra:
        return extra

    def _walk(node: Any) -> Any:
        if isinstance(node, dict):
            return {
                k: ("***" if any(h in k.lower() for h in _SECRET_HINTS) and node[k]
                    else _walk(v))
                for k, v in node.items()
            }
        if isinstance(node, list):
            return [_walk(v) for v in node]
        return node

    return _walk(extra)
```

and apply it in whatever builds `ProviderResponse` — `provider_repo._to_response` — so *every* response path is covered:

```python
        extra_config=redact_extra_config(json.loads(row.extra_config) if row.extra_config else None),
```

**(b) Merge-not-replace** — in `provider_repo.update_provider`, replace
`row.credentials = _encrypt(req.credentials.model_dump())` with:

```python
    if req.credentials is not None:
        # MERGE, don't replace. `model_dump()` emits None for every field the caller
        # omitted, so a full replace silently wiped secrets the admin never touched
        # (e.g. editing the cache host blanked the FalkorDB password). Omitted key =
        # keep; explicit clear = list the key in `credentials_clear`.
        existing = _decrypt(row.credentials) if row.credentials else {}
        incoming = req.credentials.model_dump(exclude_unset=True)
        merged = {**existing, **{k: v for k, v in incoming.items() if v is not None}}
        for key in (getattr(req, "credentials_clear", None) or []):
            merged.pop(key, None)
        row.credentials = _encrypt(merged)
```

Add `credentials_clear: Optional[List[str]] = Field(None, alias="credentialsClear")` to `ProviderUpdateRequest`.

**(c) Sentinel secrets read from the encrypted blob** — in
`falkordb_connection.load_connection_config`, change the sentinel username/password
resolution (`:205-210`) to prefer the decrypted credentials, falling back to the old
plaintext location with a warning:

```python
    # Sentinel-daemon credentials. These USED to live in
    # extra_config.falkordbConnection.sentinel — an unencrypted column that the API
    # returns. They now come from the encrypted credentials blob; the old location is
    # still read for one release so existing rows keep working.
    sentinel_username = credentials.get("sentinel_username") if credentials else None
    sentinel_password = credentials.get("sentinel_password") if credentials else None
    if sentinel_password is None and sentinel_cfg.get("password"):
        logger.warning(
            "provider %s: sentinel.password is in extra_config (PLAINTEXT, and "
            "returned by the API). Re-save the provider to move it into the encrypted "
            "credentials blob.", cfg_name,
        )
        sentinel_password = sentinel_cfg.get("password")
    if sentinel_username is None:
        sentinel_username = sentinel_cfg.get("username")
    sentinel_username = sentinel_username or os.getenv("FALKORDB_SENTINEL_USERNAME")
    sentinel_password = sentinel_password or os.getenv("FALKORDB_SENTINEL_PASSWORD")
```

(`load_connection_config` must accept the decrypted `credentials` dict — thread it from the two call sites that already decrypt: `manager.py:1048` and `provider_registry.py:308`.)

- [ ] **Step 4: Run the tests**

```bash
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/test_provider_secret_handling.py -q -p no:cacheprovider
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/ -q -p no:cacheprovider -k "provider"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/db/repositories/provider_repo.py backend/common/models/management.py \
        backend/app/providers/falkordb_connection.py backend/tests/test_provider_secret_handling.py
git commit -m "Security: encrypt sentinel creds, redact extra_config, merge credentials

Three fixes. (1) falkordbConnection.sentinel.password was stored in the PLAINTEXT
extra_config column AND returned by ProviderResponse — it moves into the encrypted
credentials blob (old location read for one release, with a warning). (2) A
recursive redaction pass masks any secret-looking key on the way out, covering rows
already in the DB. (3) Credentials updates MERGE instead of replace: a partial
update was dumping None for omitted fields and wiping secrets the admin never
touched."
```

---

### Task 10: Admin API — resolved config + connection test

**Files:**
- Create: `backend/app/api/v1/endpoints/redis_config.py`
- Modify: `backend/app/api/v1/api.py` (register the router, mirroring `system_status` at `:241-245`)
- Test: `backend/tests/test_admin_redis_config_api.py`

**Interfaces:**
- Produces:
  - `GET /api/v1/admin/redis/config` → `{"roles": [RoleView, ...], "legacy": {...}}`
  - `POST /api/v1/admin/redis/{role}/test` → `{"ok": bool, "error": str|None, "latencyMs": float|None}`
  - `RoleView = {role, mode, host, port, db, username, hasPassword, passwordSource, tls: {enabled, mutual, caCertPath, certPath, keyPath, verifyMode, checkHostname, filesReadable}, source: {field: origin}, providerOverrides: [{providerId, name, host}]}`

Both are `system:admin`-gated at registration. **No endpoint ever returns a password.**

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_admin_redis_config_api.py`:

```python
"""The admin surface must be truthful and must never leak a secret."""
import pytest

from backend.app.api.v1.endpoints.redis_config import build_role_view
from backend.common.adapters.redis_endpoint import RedisRole


def test_role_view_reports_provenance_and_never_the_password(monkeypatch, tmp_path):
    pw = tmp_path / "pw"
    pw.write_text("super-secret")
    ca = tmp_path / "ca.crt"
    ca.write_text("x")

    monkeypatch.setenv("REDIS_CACHE_HOST", "cache.internal")
    monkeypatch.setenv("REDIS_CACHE_USERNAME", "cache-user")
    monkeypatch.setenv("REDIS_CACHE_PASSWORD_FILE", str(pw))
    monkeypatch.setenv("REDIS_CACHE_TLS_ENABLED", "true")
    monkeypatch.setenv("REDIS_CACHE_TLS_CA_CERTS", str(ca))

    view = build_role_view(RedisRole.CACHE)

    assert view["host"] == "cache.internal"
    assert view["username"] == "cache-user"
    assert view["hasPassword"] is True
    assert view["passwordSource"] == "REDIS_CACHE_PASSWORD_FILE"
    assert view["tls"]["enabled"] is True
    assert view["tls"]["filesReadable"] is True
    assert view["source"]["host"] == "REDIS_CACHE_HOST"
    # the secret itself must appear NOWHERE in the payload
    assert "super-secret" not in repr(view)


def test_unreadable_cert_file_is_reported(monkeypatch):
    monkeypatch.setenv("REDIS_CACHE_HOST", "h")
    monkeypatch.setenv("REDIS_CACHE_TLS_ENABLED", "true")
    monkeypatch.setenv("REDIS_CACHE_TLS_CA_CERTS", "/nope/missing-ca.crt")
    view = build_role_view(RedisRole.CACHE)
    assert view["tls"]["filesReadable"] is False


def test_misconfigured_role_reports_the_error_not_a_500(monkeypatch):
    monkeypatch.setenv("REDIS_CACHE_MODE", "cluster")
    view = build_role_view(RedisRole.CACHE)
    assert view["error"] is not None
    assert "cluster" in view["error"].lower()
```

- [ ] **Step 2: Run to verify it fails**

```bash
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/test_admin_redis_config_api.py -q -p no:cacheprovider
```

Expected: `ModuleNotFoundError: ... redis_config`.

- [ ] **Step 3: Implement the endpoint**

Create `backend/app/api/v1/endpoints/redis_config.py`:

```python
"""Admin › System › Redis — the resolved Redis configuration, per role.

Read-only by design. The global endpoints are deploy-managed (GitOps, rotatable
secrets); this surface makes them *visible, attributable and testable*, which is
what was missing when a password silently reached one client and not another.

Never returns a password. Reports WHERE each value came from instead.
"""
import os
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request

from backend.common.adapters.redis_endpoint import (
    RedisConfigurationError, RedisRole, build_redis_client, resolve_redis_config,
)

router = APIRouter()


def _files_readable(cfg) -> Optional[bool]:
    """Are the TLS cert files actually readable by THIS process? A cert Secret
    mounted into the wrong container is invisible until the first connect fails."""
    paths = [p for p in (cfg.tls.ca_certs, cfg.tls.certfile, cfg.tls.keyfile) if p]
    if not cfg.tls.enabled or not paths:
        return None
    return all(os.access(p, os.R_OK) for p in paths)


def build_role_view(role: RedisRole) -> Dict[str, Any]:
    try:
        cfg = resolve_redis_config(role)
    except RedisConfigurationError as exc:
        return {"role": role.value, "error": str(exc)}

    return {
        "role": role.value,
        "error": None,
        "mode": cfg.mode,
        "host": cfg.host,
        "port": cfg.port,
        "db": cfg.db,
        "sentinelMaster": cfg.sentinel_master,
        "sentinelNodes": [f"{h}:{p}" for h, p in cfg.sentinel_nodes],
        "username": cfg.username,
        "hasPassword": bool(cfg.password),
        "passwordSource": cfg.source.get("password"),
        "tls": {
            "enabled": cfg.tls.enabled,
            "mutual": bool(cfg.tls.certfile),
            "caCertPath": cfg.tls.ca_certs,
            "certPath": cfg.tls.certfile,
            "keyPath": cfg.tls.keyfile,
            "verifyMode": cfg.tls.cert_reqs,
            "checkHostname": cfg.tls.check_hostname,
            "filesReadable": _files_readable(cfg),
        },
        "source": dict(cfg.source),
        "configured": cfg.source.get("host", "default") != "default",
    }


@router.get("/config", summary="Resolved Redis configuration (super-admin)")
async def get_redis_config(request: Request) -> dict:
    from backend.app.db.repositories import provider_repo
    from backend.app.db.session import get_session_factory

    roles = [build_role_view(r) for r in (RedisRole.STREAMS, RedisRole.CACHE)]

    # Which providers override the cache, and which are still on the legacy URL.
    overrides: List[dict] = []
    legacy: List[dict] = []
    async with get_session_factory()() as session:
        for p in await provider_repo.list_providers(session):
            conn = (p.extra_config or {}).get("cacheConnection")
            if conn:
                overrides.append({
                    "providerId": p.id, "name": p.name, "host": conn.get("host"),
                })
            else:
                creds = await provider_repo.get_credentials(session, p.id)
                if (creds or {}).get("cache_redis_url"):
                    legacy.append({"providerId": p.id, "name": p.name})

    for r in roles:
        if r["role"] == RedisRole.CACHE.value:
            r["providerOverrides"] = overrides
            r["legacyProviders"] = legacy

    return {
        "roles": roles,
        "deprecations": {
            "REDIS_URL": bool(os.getenv("REDIS_URL")),
            "CACHE_REDIS_URL": bool(os.getenv("CACHE_REDIS_URL")),
            "providersOnLegacyCacheUrl": len(legacy),
        },
    }


@router.post("/{role}/test", summary="Test a Redis endpoint (super-admin)")
async def test_redis_role(role: str, request: Request) -> dict:
    try:
        r = RedisRole(role)
    except ValueError:
        raise HTTPException(status_code=404, detail=f"unknown redis role {role!r}")

    try:
        cfg = resolve_redis_config(r)
    except RedisConfigurationError as exc:
        return {"ok": False, "error": str(exc), "latencyMs": None}

    client = build_redis_client(cfg)
    t0 = time.perf_counter()
    try:
        await client.ping()
        return {
            "ok": True, "error": None,
            "latencyMs": round((time.perf_counter() - t0) * 1000, 1),
        }
    except Exception as exc:                     # NOAUTH / WRONGPASS / TLS / refused
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "latencyMs": None}
    finally:
        try:
            await client.aclose()
        except Exception:
            pass
```

Register it in `backend/app/api/v1/api.py` next to `system_status`:

```python
    redis_config.router, prefix="/admin/redis", tags=["admin:redis"],
    dependencies=[Depends(requires("system:admin"))],
```

(and add `redis_config` to the endpoints import at `:9`).

- [ ] **Step 4: Run the tests**

```bash
docker exec -w /app synodic-dev-viz-service-1 python -m pytest backend/tests/test_admin_redis_config_api.py -q -p no:cacheprovider
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v1/endpoints/redis_config.py backend/app/api/v1/api.py \
        backend/tests/test_admin_redis_config_api.py
git commit -m "Admin API: resolved Redis config with provenance + connection test

GET /admin/redis/config reports, per role, the resolved endpoint, WHERE each value
came from, whether the TLS cert files are readable by this process, which providers
override the cache, and which are still on the legacy URL. It never returns a
password. POST /admin/redis/{role}/test surfaces NOAUTH / WRONGPASS / TLS failures
precisely."
```

---

### Task 11: Admin › System › Redis page

**Files:**
- Create: `frontend/src/services/redisConfigService.ts`
- Create: `frontend/src/components/admin/AdminRedis/index.tsx`
- Modify: `frontend/src/pages/AdminPage.tsx:36-41` (add the nav item), `:74-96` (permission gate)
- Modify: `frontend/src/routes.tsx:23-32` (lazy import) and the `/admin` children (~`:193-200`)
- Modify: `backend/app/services/nav_catalogue.py:70` (`_ADMIN_SECTIONS`)
- Test: `frontend/src/components/admin/AdminRedis/AdminRedis.test.tsx`

**Interfaces:**
- Consumes: `GET /api/v1/admin/redis/config`, `POST /api/v1/admin/redis/{role}/test` (Task 10).
- Produces: `AdminRedis` component exported by name (matching the `AdminInfrastructure` convention: `export function AdminRedis()`).

- [ ] **Step 1: Register the nav entry (backend + AdminPage + route)**

`backend/app/services/nav_catalogue.py` — add to `_ADMIN_SECTIONS`, after `infrastructure`:

```python
    "redis":         ("Redis",           NavSpecPerm(perm="system:admin")),
```

`frontend/src/pages/AdminPage.tsx` — import `Database` from `lucide-react` and add to the `system` group's `items`, after `infrastructure`:

```tsx
            { path: 'redis', label: 'Redis', icon: Database, description: 'Cache & streams endpoints, auth & TLS' },
```

Add the gate alongside the others:

```tsx
    const redisVisible = useNavPermission(useAdminSectionSpec('redis'))
```

and the map entry `redis: redisVisible,`.

`frontend/src/routes.tsx` — add the lazy import next to `AdminInfrastructure`:

```tsx
const AdminRedis = lazy(() => import('@/components/admin/AdminRedis').then(m => ({ default: m.AdminRedis })))
```

and the child route after `infrastructure`:

```tsx
          {
            path: 'redis',
            element: (
              <RequireNav group="admin" sectionKey="redis">
                <Lazy><AdminRedis /></Lazy>
              </RequireNav>
            ),
          },
```

- [ ] **Step 2: Write the failing component test**

Create `frontend/src/components/admin/AdminRedis/AdminRedis.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AdminRedis } from './index'

vi.mock('@/services/redisConfigService', () => ({
  fetchRedisConfig: vi.fn().mockResolvedValue({
    roles: [
      {
        role: 'streams', error: null, mode: 'standalone', configured: true,
        host: 'mem-coord.gcp', port: 6379, db: 0,
        username: 'app', hasPassword: true, passwordSource: 'REDIS_STREAMS_PASSWORD_FILE',
        tls: { enabled: true, mutual: true, caCertPath: '/certs/streams/ca.crt',
               verifyMode: 'required', checkHostname: true, filesReadable: true },
        source: { host: 'REDIS_STREAMS_HOST' },
      },
      {
        role: 'cache', error: null, mode: 'standalone', configured: true,
        host: 'mem-cache.gcp', port: 6379, db: 1,
        username: 'cache', hasPassword: true, passwordSource: 'REDIS_CACHE_PASSWORD',
        tls: { enabled: false, mutual: false, filesReadable: null },
        source: { host: 'REDIS_CACHE_HOST' },
        providerOverrides: [{ providerId: 'p1', name: 'acme-prod', host: 'acme-cache' }],
        legacyProviders: [{ providerId: 'p2', name: 'legacy-src' }],
      },
    ],
    deprecations: { REDIS_URL: false, CACHE_REDIS_URL: false, providersOnLegacyCacheUrl: 1 },
  }),
  testRedisRole: vi.fn(),
}))

describe('AdminRedis', () => {
  it('shows both endpoints as independent, with provenance and no secrets', async () => {
    render(<AdminRedis />)
    await waitFor(() => expect(screen.getByText('mem-coord.gcp:6379')).toBeInTheDocument())
    expect(screen.getByText('mem-cache.gcp:6379')).toBeInTheDocument()
    // provenance is shown, the secret value is not
    expect(screen.getByText(/REDIS_STREAMS_PASSWORD_FILE/)).toBeInTheDocument()
    expect(screen.queryByText(/pw=|password=/i)).not.toBeInTheDocument()
  })

  it('warns about providers still on the legacy cache URL', async () => {
    render(<AdminRedis />)
    await waitFor(() => expect(screen.getByText(/legacy-src/)).toBeInTheDocument())
  })
})
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd frontend && npx vitest run src/components/admin/AdminRedis/AdminRedis.test.tsx
```

Expected: FAIL — module `./index` not found.

- [ ] **Step 4: Implement the service + component**

`frontend/src/services/redisConfigService.ts`:

```ts
import { fetchWithTimeout } from '@/lib/fetchWithTimeout'

export interface RedisTlsView {
  enabled: boolean
  mutual: boolean
  caCertPath?: string | null
  certPath?: string | null
  keyPath?: string | null
  verifyMode?: string
  checkHostname?: boolean
  filesReadable: boolean | null
}

export interface RedisRoleView {
  role: 'streams' | 'cache'
  error: string | null
  mode?: string
  configured?: boolean
  host?: string
  port?: number
  db?: number
  sentinelMaster?: string | null
  sentinelNodes?: string[]
  username?: string | null
  hasPassword?: boolean
  passwordSource?: string | null
  tls?: RedisTlsView
  source?: Record<string, string>
  providerOverrides?: { providerId: string; name: string; host?: string }[]
  legacyProviders?: { providerId: string; name: string }[]
}

export interface RedisConfigResponse {
  roles: RedisRoleView[]
  deprecations: {
    REDIS_URL: boolean
    CACHE_REDIS_URL: boolean
    providersOnLegacyCacheUrl: number
  }
}

export async function fetchRedisConfig(): Promise<RedisConfigResponse> {
  const res = await fetchWithTimeout('/api/v1/admin/redis/config')
  if (!res.ok) throw new Error(`Failed to load Redis config (${res.status})`)
  return res.json()
}

export async function testRedisRole(
  role: 'streams' | 'cache',
): Promise<{ ok: boolean; error: string | null; latencyMs: number | null }> {
  const res = await fetchWithTimeout(`/api/v1/admin/redis/${role}/test`, { method: 'POST' })
  return res.json()
}
```

`frontend/src/components/admin/AdminRedis/index.tsx` — a read-only card per role. Requirements the test pins:
- render `host:port` for each role,
- render the **provenance** string for every field (`source[field]`, and `passwordSource` for the password) — the password value is never in the payload, so it cannot be rendered,
- render `••••` when `hasPassword`, and the source label next to it,
- TLS row: off / on / on+mutual, the cert paths, and a **red warning when `filesReadable === false`** ("cert files not readable by this process — check the Secret mount"),
- a `Test connection` button per role calling `testRedisRole`, showing latency on success and the raw error (`NOAUTH` / `WRONGPASS` / TLS) on failure,
- the cache card lists `providerOverrides` (linking to `/admin/providers`) and a warning banner listing `legacyProviders`,
- when `error` is set (e.g. cluster configured), show the error instead of the fields.

Follow the existing `AdminInfrastructure` idiom: `PageContainer` wrapper, `ServiceTile`-style cards, `lucide-react` icons, `cn()` for classes, and the same status-pill colours.

- [ ] **Step 5: Run the test + typecheck**

```bash
cd frontend && npx vitest run src/components/admin/AdminRedis/AdminRedis.test.tsx
cd frontend && npx tsc --noEmit    # must not add NEW errors to the baseline
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/admin/AdminRedis frontend/src/services/redisConfigService.ts \
        frontend/src/pages/AdminPage.tsx frontend/src/routes.tsx \
        backend/app/services/nav_catalogue.py
git commit -m "Admin > System > Redis: read-only endpoint diagnostics

Shows each role as an independent endpoint with per-field provenance (which env
var or file, or which provider overrode it), whether the TLS cert files are
readable by this process, a Test Connection that reports NOAUTH/WRONGPASS/TLS
failures precisely, and which providers still use the legacy cache URL. Never
renders a secret — the API does not return one."
```

---

### Task 12: Provider wizard — structured dedicated-cache panel

**Files:**
- Modify: `frontend/src/components/admin/ProviderOnboardingWizard.tsx` — types (`:70-88`), `buildExtraConfig` (`:300-359`), `buildCredentials` (`:363-382`), the cache field (`:1195-1211`)
- Modify: `frontend/src/services/providerService.ts:19-96` (credentials DTO)
- Test: `frontend/src/components/admin/ProviderOnboardingWizard.test.tsx` (existing — extend)

**Interfaces:** Consumes the Task 6 schema (`extra_config.cacheConnection` + `credentials.cache_*`).

- [ ] **Step 1: Extend the failing test**

Append to `ProviderOnboardingWizard.test.tsx`:

```tsx
it('submits a structured dedicated cache, with secrets in credentials only', async () => {
  const onSubmit = vi.fn()
  render(<ProviderOnboardingWizard onSubmit={onSubmit} />)
  // ... navigate to the connection step, enable "Dedicated cache", fill:
  //     host=cache-b, port=6379, username=cu, password=cp, TLS on, CA=/certs/cache/ca.crt
  // then submit.
  await waitFor(() => expect(onSubmit).toHaveBeenCalled())
  const payload = onSubmit.mock.calls[0][0]

  expect(payload.extraConfig.cacheConnection).toMatchObject({
    mode: 'standalone', host: 'cache-b', port: 6379,
    tls: { enabled: true, caCertPath: '/certs/cache/ca.crt' },
  })
  expect(payload.credentials.cache_username).toBe('cu')
  expect(payload.credentials.cache_password).toBe('cp')
  // the secret must NOT be anywhere in extraConfig
  expect(JSON.stringify(payload.extraConfig)).not.toContain('cp')
  // and the legacy URL field is no longer emitted
  expect(payload.credentials.cache_redis_url).toBeUndefined()
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd frontend && npx vitest run src/components/admin/ProviderOnboardingWizard.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Replace `cacheRedisUrl: string` in `FalkorDBConnectionState` with:

```ts
interface CacheConnectionState {
  enabled: boolean
  mode: 'standalone' | 'sentinel'
  host: string
  port: number
  db: number
  username: string
  password: string
  sentinelMasterName: string
  sentinelNodes: HostPort[]
  tlsEnabled: boolean
  tlsCaCertPath: string
  tlsCertPath: string
  tlsKeyPath: string
  tlsVerifyMode: 'required' | 'optional' | 'none'
  tlsCheckHostname: boolean
  // Set when editing a provider that still carries the legacy URL. Rendered
  // read-only with a "Convert to structured config" action.
  legacyUrlPresent: boolean
}
```

Replace the single `Dedicated cache Redis URL (optional)` input (`:1195-1211`) with a
`Dedicated cache` panel that mirrors the existing FalkorDB TLS/sentinel panels
(`:1289-1356`) — same markup idiom, same verify-mode select, same check-hostname
checkbox. Gate it behind a `Use a dedicated cache for this provider` checkbox; when
unchecked, the provider uses the global cache and **no** `cacheConnection` is emitted.

`buildExtraConfig` emits `cacheConnection` (never any secret). `buildCredentials` emits
`cache_username` / `cache_password` / `cache_sentinel_*` and **stops emitting**
`cache_redis_url`.

For an existing provider whose credentials still hold a legacy `cache_redis_url`, render
the panel read-only with a **Convert to structured config** button that parses the URL
into the fields (host/port/db/username/password/TLS-from-`rediss://`) and clears the
legacy value on save via `credentialsClear: ['cache_redis_url']` (Task 9b).

- [ ] **Step 4: Run tests + typecheck**

```bash
cd frontend && npx vitest run src/components/admin/ProviderOnboardingWizard.test.tsx
cd frontend && npx tsc --noEmit
```

Expected: PASS, no new tsc errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/admin/ProviderOnboardingWizard.tsx \
        frontend/src/components/admin/ProviderOnboardingWizard.test.tsx \
        frontend/src/services/providerService.ts
git commit -m "Provider wizard: structured dedicated-cache panel replaces the URL field

Host/port/db/ACL user/password + its own TLS/mTLS, mirroring the FalkorDB panels.
Secrets go to the encrypted credentials blob; only non-secret topology reaches
extra_config. Legacy cache_redis_url renders read-only with a one-click convert."
```

---

### Task 13: Deployment — secrets, cert mounts, and a two-instance auth+TLS harness

**Files:**
- Modify: `deploy/k8s/base/configmaps/common-config.yaml` (drop the URLs), `deploy/k8s/base/secrets/app-secrets.yaml` (add Redis keys)
- Modify: `deploy/k8s/overlays/production/patches/managed-data-tier.yaml:16-30`
- Modify: `deploy/k8s/Makefile:23` (`ENVSUBST_VARS`), `deploy/k8s/.env.deploy.example`
- Create: `deploy/topologies/docker-compose.redis-split-auth-tls.yml`
- Modify: `docker-compose.yml` (unchanged behaviour — verify dev still boots)

**Interfaces:** none (deployment only).

- [ ] **Step 1: Add the production wiring**

In `managed-data-tier.yaml`, replace the two ConfigMap URLs with role-prefixed vars, and move the credentials into the Secret patch:

```yaml
data:
  # Cache and streams are SEPARATE Memorystore instances with independent
  # credentials and TLS. Nothing is shared between the roles.
  REDIS_STREAMS_HOST: "${REDIS_COORD_HOST}"
  REDIS_STREAMS_PORT: "6379"
  REDIS_STREAMS_DB: "0"
  REDIS_STREAMS_USERNAME: "${REDIS_STREAMS_USERNAME}"
  REDIS_STREAMS_TLS_ENABLED: "${REDIS_STREAMS_TLS_ENABLED}"
  REDIS_STREAMS_TLS_CA_CERTS: "/certs/streams/ca.crt"

  REDIS_CACHE_HOST: "${REDIS_CACHE_HOST}"
  REDIS_CACHE_PORT: "6379"
  REDIS_CACHE_DB: "1"
  REDIS_CACHE_USERNAME: "${REDIS_CACHE_USERNAME}"
  REDIS_CACHE_TLS_ENABLED: "${REDIS_CACHE_TLS_ENABLED}"
  REDIS_CACHE_TLS_CA_CERTS: "/certs/cache/ca.crt"
```

Add `REDIS_STREAMS_PASSWORD` and `REDIS_CACHE_PASSWORD` to the `app-secrets` Secret, and mount two cert Secrets (`redis-streams-certs` → `/certs/streams`, `redis-cache-certs` → `/certs/cache`) onto the five backend Deployments. Add every new var to `ENVSUBST_VARS` in `deploy/k8s/Makefile:23` and to `.env.deploy.example`.

- [ ] **Step 2: Verify every overlay still builds**

```bash
for o in dev staging production production-cluster; do
  echo "== $o"; kustomize build deploy/k8s/overlays/$o > /dev/null && echo OK || echo FAIL
done
```

Expected: all OK.

- [ ] **Step 3: Verify dev is unchanged (zero-config)**

```bash
docker compose up -d && sleep 20
docker compose logs viz-service | grep -i "redis_endpoint" | head -5
```

Expected: the legacy `REDIS_URL` / `CACHE_REDIS_URL` still resolve; logs show
`streams[standalone] redis:6379/0 ... no-TLS` and `cache[standalone] redis:6379/1 ... no-TLS`.
**Dev must boot with no config change.**

- [ ] **Step 4: Prove independence with a two-instance auth+TLS harness**

Create `deploy/topologies/docker-compose.redis-split-auth-tls.yml` with **two** Redis
instances — `redis-streams` (requirepass `streams-pw`, TLS with CA-A) and `redis-cache`
(requirepass `cache-pw`, TLS with CA-B) — reusing `deploy/topologies/gen-certs.sh` to
generate two distinct CAs. Then run:

```bash
./deploy/topologies/gen-certs.sh
docker compose -f deploy/topologies/docker-compose.redis-split-auth-tls.yml up -d
# point the app at both, with DIFFERENT credentials and DIFFERENT CAs, then:
docker exec -w /app synodic-dev-viz-service-1 python -c "
import asyncio
from backend.common.adapters.redis_endpoint import RedisRole, build_redis_client, resolve_redis_config
async def main():
    for role in (RedisRole.STREAMS, RedisRole.CACHE):
        cfg = resolve_redis_config(role)
        c = build_redis_client(cfg)
        print(role.value, cfg.describe(), '->', await c.ping())
        await c.aclose()
asyncio.run(main())"
```

Expected: both PING. Then **swap only the cache password** and re-run: the cache must fail
with `WRONGPASS` while streams still succeeds. That is the proof of independence.

- [ ] **Step 5: Commit**

```bash
git add deploy/k8s deploy/topologies docker-compose.yml
git commit -m "Deploy: independent Redis credentials + per-role TLS cert mounts

Cache and streams get their own Secret keys and their own cert mounts (/certs/cache,
/certs/streams), so the two Memorystore instances can use entirely different PKI.
Redis endpoints move out of the ConfigMap now that they carry credentials. Dev is
unchanged and still zero-config via the legacy vars. Adds a two-instance auth+TLS
compose harness that proves swapping one role's password fails ONLY that role."
```

---

### Task 14: Documentation

**Files:**
- Modify: `docs/DECISIONS.md` (ADR-022), `docs/DATA_ARCHITECTURE.md` ("Redis Topology & Decoupling", `:524`), `docs/FALKORDB_DEPLOYMENT.md` (§7.3 cache-in-cluster note), `docs/INFRASTRUCTURE_LAUNCH_SCALE.md` (Appendix A env summary), `deploy/topologies/README.md`

- [ ] **Step 1: Write ADR-022**

Append to `docs/DECISIONS.md` (before `## Decision Summary`) an ADR covering: the 12-sites/1-honours-the-password root cause; roles as independent endpoints with no cross-role inheritance; secrets as refs; cluster rejected for cache/streams with the three concrete blockers; and the three security fixes. Add the summary-table row:

```
| 022 | Central role-keyed Redis config (cache/streams independent) | Accepted | Low |
```

- [ ] **Step 2: Correct the stale claims found in the audit**

`docs/DATA_ARCHITECTURE.md:571` currently says *"Today Streams + Pub/Sub + Cache share **one** dedicated Redis"* — that already contradicts the production overlay, which points the two vars at **two separate MemoryStore hosts**. Fix it, and document the new role-prefixed env surface + the per-provider cache override.

`docs/FALKORDB_DEPLOYMENT.md` §7.3 — update to state that the cache is a *separate role* with its own auth/TLS, and that Cluster is unsupported for it (with the three reasons).

`docs/INFRASTRUCTURE_LAUNCH_SCALE.md` Appendix A — replace the `REDIS_URL`/`CACHE_REDIS_URL` rows with the role-prefixed set, and strike "TLS in transit" from the still-open list (it is now supported).

- [ ] **Step 3: Commit**

```bash
git add docs/ deploy/topologies/README.md
git commit -m "Docs: ADR-022 + role-keyed Redis config reference

Also corrects DATA_ARCHITECTURE's claim that streams and cache share one Redis —
the production overlay has pointed them at two separate MemoryStore instances for
some time."
```

---

## Self-review

**Spec coverage** — every section maps to a task: §3.1 roles → T1; §3.3 secret refs → T1; §4 architecture → T1/T2; §5 config + precedence → T1; §5.2 per-provider → T1/T6/T7; §6 cluster policy → T1/T2/T6; §7 the 12 sites → T3/T4/T5/T7/T8 (scripts unchanged, as specced); §7.1 startup validation → T7; §8 admin surface → T10/T11/T12; §9 security fixes → T6/T9; §10 deployment → T13; §11 testing → distributed across every task plus the live harness in T13; §12 rollout back-compat → T1 (legacy vars) + T13 Step 3.

**Type consistency** — `RedisRole`, `RedisEndpointConfig`, `ProviderCacheOverride`, `RedisConfigurationError`, `resolve_redis_config`, `build_redis_client` are defined in T1/T2 and used with the same names and signatures in T3–T11. `build_cache_client(*, provider_id, extra_config, credentials)` is defined in T7 and consumed with that exact signature in T8. `redact_extra_config` is defined and consumed in T9. `build_role_view` is defined in T10 and consumed by its own test only.

**Known gap, deliberately deferred (spec §13):** editable DB-backed global config, cluster support for the cache, per-tenant streams isolation.
