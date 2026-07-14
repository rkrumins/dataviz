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


def _files_readable(cfg) -> Optional[bool]:
    """Are the TLS cert files actually readable by THIS process? A cert Secret
    mounted into the wrong container is invisible until the first connect fails."""
    paths = [p for p in (cfg.tls.ca_certs, cfg.tls.certfile, cfg.tls.keyfile) if p]
    if not cfg.tls.enabled or not paths:
        return None
    return all(os.access(p, os.R_OK) for p in paths)


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
async def get_redis_config(session: AsyncSession = Depends(get_db_session)) -> dict:
    roles = [build_role_view(r) for r in (RedisRole.STREAMS, RedisRole.CACHE)]

    # Which providers override the cache, and which are still on the legacy URL.
    overrides: List[dict] = []
    legacy_providers: List[dict] = []
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

    for r in roles:
        if r["role"] == RedisRole.CACHE.value:
            r["providerOverrides"] = overrides
            r["legacyProviders"] = legacy_providers

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
