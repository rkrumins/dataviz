"""Admin › System › Redis — the resolved Redis configuration, per role.

Read-only by design. The global endpoints are deploy-managed (GitOps, rotatable
secrets); this surface makes them *visible, attributable and testable*, which is
what was missing when a password silently reached one client and not another.

Never returns a password. Reports WHERE each value came from instead.
"""
import asyncio
import os
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import get_db_session
from backend.app.db.repositories import provider_repo
from backend.common.adapters.redis_endpoint import (
    RedisConfigurationError, RedisRole, build_redis_client, resolve_redis_config,
)

router = APIRouter()

# Upper bound on a connection test — this is an interactive admin action, not a
# background job, and it must never be able to hang the request on a Redis that
# is up but wedged (e.g. blocked on a stalled AOF rewrite).
_TEST_TIMEOUT_S = 10.0


def _files_readable_for(tls) -> Optional[bool]:
    """Are the TLS cert files actually readable by THIS process? A cert Secret
    mounted into the wrong container is invisible until the first connect fails."""
    paths = [p for p in (tls.ca_certs, tls.certfile, tls.keyfile) if p]
    if not tls.enabled or not paths:
        return None
    return all(os.access(p, os.R_OK) for p in paths)


def _files_readable(cfg) -> Optional[bool]:
    return _files_readable_for(cfg.tls)


def _tls_view(tls) -> Dict[str, Any]:
    """One TLS block shape for every role card (streams/cache/falkordb)."""
    return {
        "enabled": tls.enabled,
        "mutual": bool(tls.certfile),
        "caCertPath": tls.ca_certs,
        "certPath": tls.certfile,
        "keyPath": tls.keyfile,
        "verifyMode": tls.cert_reqs,
        "checkHostname": tls.check_hostname,
        "filesReadable": _files_readable_for(tls),
    }


def _redact(text: str, *secrets: Optional[str]) -> str:
    """Belt-and-braces: strip a secret out of an error string if it ever ended up
    there (e.g. reflected back by a client-side exception). Never trust that an
    exception message is safe just because it "shouldn't" contain the password."""
    for secret in secrets:
        if secret:
            text = text.replace(secret, "***")
    return text


def build_role_view(role: RedisRole) -> Dict[str, Any]:
    try:
        cfg = resolve_redis_config(role)
    except RedisConfigurationError as exc:
        return {"role": role.value, "error": _redact(str(exc))}

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
        # Sentinel DAEMONS authenticate separately from the data plane; an
        # operator must be able to SEE from this page whether the daemons will
        # be authenticated (dedicated creds, reused data-plane creds via
        # sentinelAuthEnabled, or none) — previously invisible here.
        "sentinelUsername": cfg.sentinel_username,
        "hasSentinelPassword": bool(cfg.sentinel_password),
        "sentinelPasswordSource": cfg.source.get("sentinel_password"),
        "sentinelAuthEnabled": cfg.sentinel_auth_enabled,
        # Behavioral, per-role default (STREAMS true / CACHE false) — worth
        # showing so a debugging operator knows whether a timed-out op retried.
        "retryOnTimeout": cfg.retry_on_timeout,
        "tls": _tls_view(cfg.tls),
        "source": dict(cfg.source),
        "configured": cfg.is_configured,
    }


def _graph_env_source() -> Dict[str, str]:
    """Per-field provenance for the ENV-DEFAULT FalkorDB instance.

    ``falkordb_connection`` deliberately carries no source map (it would
    thread display-only state through the provider-row path shared by every
    graph consumer). For the env-default instance every field maps to exactly
    one ``FALKORDB_*`` variable, so provenance is statically computable here,
    in the display layer, with zero backend-core changes.
    """
    def first_set(*vars_: str) -> Optional[str]:
        for v in vars_:
            if os.getenv(v):
                return v
        return None

    single = {
        "host": "FALKORDB_HOST",
        "port": "FALKORDB_PORT",
        "mode": "FALKORDB_MODE",
        "username": "FALKORDB_USERNAME",
        "sentinel_master": "FALKORDB_SENTINEL_MASTER",
        "sentinel_nodes": "FALKORDB_SENTINEL_NODES",
        "sentinel_username": "FALKORDB_SENTINEL_USERNAME",
        "sentinel_auth_enabled": "FALKORDB_SENTINEL_AUTH_ENABLED",
        "sentinel_tls": "FALKORDB_SENTINEL_TLS_ENABLED",
        "cluster_nodes": "FALKORDB_CLUSTER_NODES",
        "address_remap": "FALKORDB_ADDRESS_REMAP",
        "socket_timeout": "FALKORDB_SOCKET_TIMEOUT",
        "connect_timeout": "FALKORDB_SOCKET_CONNECT_TIMEOUT",
    }
    src = {field: (var if os.getenv(var) else "default")
           for field, var in single.items()}
    # Secrets: the mounted file wins over the plain variable.
    src["password"] = first_set(
        "FALKORDB_PASSWORD_FILE", "FALKORDB_PASSWORD") or "default"
    src["sentinel_password"] = first_set(
        "FALKORDB_SENTINEL_PASSWORD_FILE", "FALKORDB_SENTINEL_PASSWORD") or "default"
    src["tls"] = first_set(
        "FALKORDB_TLS_ENABLED", "FALKORDB_TLS_CA_CERTS",
        "FALKORDB_TLS_CERTFILE", "FALKORDB_TLS_KEYFILE") or "default"
    return src


def build_graph_role_view() -> Dict[str, Any]:
    """The FalkorDB GRAPH role card — the env-default instance only.

    Provider-routed graph instances configure on the provider page (their
    config rides the provider row); this card makes the env-default endpoint
    as visible/attributable/testable as the streams and cache roles. Never
    returns a secret: presence booleans + provenance only.
    """
    from backend.app.providers.falkordb_connection import env_conn_config

    try:
        cfg = env_conn_config()
    except Exception as exc:
        # env_conn_config raises ProviderConfigurationError on a missing or
        # empty FALKORDB_PASSWORD_FILE — that IS the diagnosis; degrade to an
        # error view, never a 500. The message names the var + path only.
        return {"role": "falkordb", "error": _redact(str(exc))}

    src = _graph_env_source()
    return {
        "role": "falkordb",
        "error": None,
        "mode": cfg.mode,
        "host": cfg.host,
        "port": cfg.port,
        "clusterNodes": [f"{h}:{p}" for h, p in cfg.cluster_nodes],
        "sentinelMaster": cfg.sentinel_master,
        "sentinelNodes": [f"{h}:{p}" for h, p in cfg.sentinel_nodes],
        "username": cfg.username,
        "hasPassword": bool(cfg.password),
        "passwordSource": src["password"] if cfg.password else None,
        "sentinelUsername": cfg.sentinel_username,
        "hasSentinelPassword": bool(cfg.sentinel_password),
        "sentinelPasswordSource": (
            src["sentinel_password"] if cfg.sentinel_password else None
        ),
        "sentinelAuthEnabled": cfg.sentinel_auth_enabled,
        "tls": _tls_view(cfg.tls_settings()),
        # The daemons inherit the data-plane TLS unless sentinel.tls overrides.
        "sentinelTls": {
            "inherited": cfg.sentinel_tls is None,
            **_tls_view(cfg.sentinel_tls_settings()),
        },
        # Cross-cluster rewrite pairs — hosts/ports only, never secret.
        "addressRemap": [
            {"from": frm, "to": to} for frm, to in cfg.address_remap
        ],
        "socketTimeout": cfg.socket_timeout,
        "connectTimeout": cfg.socket_connect_timeout,
        "source": src,
        # The env default always resolves to SOMETHING (localhost:6379); call
        # it configured when any endpoint-shaped var was set explicitly.
        "configured": any(
            src[f] != "default"
            for f in ("host", "port", "mode", "cluster_nodes", "sentinel_nodes")
        ),
    }


@router.get("/config", summary="Resolved Redis configuration (super-admin)")
async def get_redis_config(session: AsyncSession = Depends(get_db_session)) -> dict:
    roles = [build_role_view(r) for r in (RedisRole.STREAMS, RedisRole.CACHE)]
    roles.append(build_graph_role_view())

    # Which providers override the cache, and which are still on the legacy URL.
    # For the graph role: every falkordb-typed provider is a SEPARATE instance
    # (not an override of the env default) — listed so the card can point the
    # operator at the provider page for those.
    overrides: List[dict] = []
    legacy_providers: List[dict] = []
    provider_graphs: List[dict] = []
    for p in await provider_repo.list_providers(session):
        conn = (p.extra_config or {}).get("cacheConnection")
        if conn:
            overrides.append({
                "providerId": p.id, "name": p.name, "host": conn.get("host"),
            })
        else:
            creds = await provider_repo.get_credentials(session, p.id)
            if (creds or {}).get("cache_redis_url"):
                legacy_providers.append({"providerId": p.id, "name": p.name})
        if (p.provider_type or "").lower() == "falkordb":
            fconn = (p.extra_config or {}).get("falkordbConnection") or {}
            provider_graphs.append({
                "providerId": p.id,
                "name": p.name,
                "host": p.host,
                "mode": fconn.get("mode") or "standalone",
            })

    for r in roles:
        if r["role"] == RedisRole.CACHE.value:
            r["providerOverrides"] = overrides
            r["legacyProviders"] = legacy_providers
        if r["role"] == "falkordb":
            r["providerGraphs"] = provider_graphs

    return {
        "roles": roles,
        "deprecations": {
            "REDIS_URL": bool(os.getenv("REDIS_URL")),
            "CACHE_REDIS_URL": bool(os.getenv("CACHE_REDIS_URL")),
            "providersOnLegacyCacheUrl": len(legacy_providers),
        },
    }


async def _probe(client) -> None:
    """PING then INFO — some deployments ACL-restrict INFO while allowing PING,
    so PING alone would report a false "ok" for a connection the app can't
    actually use."""
    await client.ping()
    await client.info()


@router.post("/{role}/test", summary="Test a Redis endpoint (super-admin)")
async def test_redis_role(role: str) -> dict:
    if role == "falkordb":
        # Reuse the topology-aware system-status probe rather than a bespoke
        # PING: it resolves the CURRENT sentinel master, fans out over every
        # cluster primary with a per-shard rollup, carries the real auth+TLS,
        # and its error strings are already secret-safe.
        from backend.app.services.system_status.probes import probe_falkordb

        t0 = time.perf_counter()
        result = await probe_falkordb()
        return {
            "ok": result.get("status") not in ("down", None),
            "error": result.get("error"),
            "latencyMs": result.get("latencyMs")
            or round((time.perf_counter() - t0) * 1000, 1),
            "detail": result.get("detail") or {},
        }

    try:
        r = RedisRole(role)
    except ValueError:
        raise HTTPException(status_code=404, detail=f"unknown redis role {role!r}")

    try:
        cfg = resolve_redis_config(r)
    except RedisConfigurationError as exc:
        return {"ok": False, "error": _redact(str(exc)), "latencyMs": None}

    client = build_redis_client(cfg)
    t0 = time.perf_counter()
    try:
        await asyncio.wait_for(_probe(client), timeout=_TEST_TIMEOUT_S)
        return {
            "ok": True, "error": None,
            "latencyMs": round((time.perf_counter() - t0) * 1000, 1),
        }
    except asyncio.TimeoutError:
        return {
            "ok": False,
            "error": f"timed out after {_TEST_TIMEOUT_S}s",
            "latencyMs": None,
        }
    except Exception as exc:                     # NOAUTH / WRONGPASS / TLS / refused
        return {
            "ok": False,
            "error": _redact(f"{type(exc).__name__}: {exc}", cfg.password),
            "latencyMs": None,
        }
    finally:
        try:
            await client.aclose()
        except Exception:
            pass
