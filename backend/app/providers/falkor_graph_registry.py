"""Registry-backed, provider-aware FalkorDB graph factory for the projector.

Bridges the management-DB provider registry to the versioning projector/read path.
The projector takes an injected ``(name, provider_id=None) -> graph`` factory (so the
versioning store stays decoupled from the registry — same pattern as
``eviction_budget.make_registry_budget_resolver``); this builds one that routes each
graph to **its data source's pinned FalkorDB instance** (``ProviderORM.host/port`` +
decrypted credentials), so a projection lands on the same instance the per-provider
read path (``ProviderManager``) and the aggregation worker use.

Fallback contract (never raises from the factory itself):
- ``provider_id`` of ``None`` / ``""`` / ``"default"`` → the env-configured instance
  (``FALKORDB_HOST`` / ``FALKORDB_PORT`` / ``FALKORDB_POOL_SIZE``) — exactly today's
  single-instance behavior.
- Unknown / inactive / non-falkordb provider, or any lookup failure → the env
  instance, logged loudly (a deleted provider row silently landing writes on the
  wrong instance is the failure mode we most want visible).

The factory may return an awaitable (the first use of a provider does an async
registry read); callers ``await`` when needed. Handles are cached per ``(host,
port)``; provider rows are cached per id for the process lifetime (credential
rotation therefore needs a process restart — flagged in docs).
"""
from __future__ import annotations

import logging
import os
from typing import Callable, Optional

logger = logging.getLogger(__name__)

_UNROUTED = (None, "", "default")


def _env_handle_factory():
    """One lazily-built handle for the env-configured (default) instance."""
    from redis.asyncio import ConnectionPool           # pragma: no cover - infra
    from falkordb.asyncio import FalkorDB              # pragma: no cover - infra

    pool = ConnectionPool(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        max_connections=int(os.getenv("FALKORDB_POOL_SIZE", "10")),
    )
    return FalkorDB(connection_pool=pool)


def make_registry_graph_factory(session_factory=None) -> Callable[[str, Optional[str]], object]:
    """Return an async ``(name, provider_id=None) -> graph`` factory backed by the
    provider registry, env-fallback on anything unroutable.

    ``session_factory`` defaults to a READONLY-pool sessionmaker; injectable for tests.
    """
    from redis.asyncio import ConnectionPool           # pragma: no cover - infra
    from falkordb.asyncio import FalkorDB              # pragma: no cover - infra

    handles: dict = {}                 # (host, port, username) -> FalkorDB handle
    resolved: dict = {}                # provider_id -> (host, port, username, password) | None
    env_handle: list = []              # lazy singleton box

    def _env():
        if not env_handle:
            env_handle.append(_env_handle_factory())
        return env_handle[0]

    async def _resolve(provider_id: str):
        """provider_id → connection tuple, or ``None`` for env fallback (memoized)."""
        if provider_id in resolved:
            return resolved[provider_id]
        conn = None
        try:
            from backend.app.db.engine import PoolRole, get_session_factory
            from backend.app.db.repositories import provider_repo
            factory = session_factory or get_session_factory(PoolRole.READONLY)
            async with factory() as session:
                row = await provider_repo.get_provider_orm(session, provider_id)
                if row is None or not row.is_active or row.provider_type != "falkordb" \
                        or not row.host:
                    logger.warning(
                        "projection provider %r is missing/inactive/non-falkordb — "
                        "routing its graphs to the DEFAULT FalkorDB instance", provider_id)
                else:
                    creds = await provider_repo.get_credentials(session, provider_id)
                    # Same host rewrites the read path applies — projector and reads must
                    # resolve a provider to the SAME instance. BOTH directions matter:
                    # LOCAL_DEV_FALKORDB_OVERRIDE (Docker hostname → env host for
                    # host-run processes) and _normalize_falkordb_host (a stored
                    # ``localhost`` → FALKORDB_DOCKER_LOCALHOST_REWRITE for in-container
                    # processes; the reader gets this inside FalkorDBProvider.__init__).
                    # Missing the second was why a localhost-registered provider READ
                    # fine but every projection/rebuild died with "connection refused".
                    from backend.app.providers.falkordb_provider import _normalize_falkordb_host
                    from backend.app.providers.manager import apply_local_dev_falkordb_override
                    host, port = apply_local_dev_falkordb_override(
                        row.host, int(row.port or 6379))
                    host = _normalize_falkordb_host(host)
                    conn = (host, port, creds.get("username"), creds.get("password"))
        except Exception:
            logger.exception(
                "provider lookup for %r failed — routing to the DEFAULT FalkorDB instance",
                provider_id)
        resolved[provider_id] = conn
        return conn

    def _handle_for(conn):
        host, port, username, password = conn
        key = (host, port, username)
        if key not in handles:
            kw = {"host": host, "port": port,
                  "max_connections": int(os.getenv("FALKORDB_POOL_SIZE", "10"))}
            if username:
                kw["username"] = username
            if password:
                kw["password"] = password
            handles[key] = FalkorDB(connection_pool=ConnectionPool(**kw))
        return handles[key]

    async def graph(name: str, provider_id: Optional[str] = None):
        if provider_id in _UNROUTED:
            return _env().select_graph(name)
        conn = await _resolve(provider_id)
        if conn is None:
            return _env().select_graph(name)
        return _handle_for(conn).select_graph(name)

    return graph


async def list_graph_keys(provider_id: Optional[str] = None,
                          session_factory=None) -> Optional[set]:
    """Best-effort ``GRAPH.LIST`` on a provider's instance (env default when
    unrouted/unresolvable). ``None`` when the instance is unreachable — callers
    must treat that as "cannot verify", never as "no keys". Builds a one-shot
    connection (callers are rare, e.g. graph-name availability checks)."""
    try:
        from falkordb.asyncio import FalkorDB          # pragma: no cover - infra
        from redis.asyncio import ConnectionPool       # pragma: no cover - infra

        host = os.getenv("FALKORDB_HOST", "localhost")
        port = int(os.getenv("FALKORDB_PORT", "6379"))
        username = password = None
        if provider_id not in _UNROUTED:
            try:
                from backend.app.db.engine import PoolRole, get_session_factory
                from backend.app.db.repositories import provider_repo
                factory = session_factory or get_session_factory(PoolRole.READONLY)
                async with factory() as session:
                    row = await provider_repo.get_provider_orm(session, provider_id)
                    if row is not None and row.is_active and row.provider_type == "falkordb" \
                            and row.host:
                        creds = await provider_repo.get_credentials(session, provider_id)
                        from backend.app.providers.falkordb_provider import _normalize_falkordb_host
                        from backend.app.providers.manager import apply_local_dev_falkordb_override
                        host, port = apply_local_dev_falkordb_override(
                            row.host, int(row.port or 6379))
                        host = _normalize_falkordb_host(host)   # read-path parity (docker rewrite)
                        username, password = creds.get("username"), creds.get("password")
            except Exception:
                logger.exception("provider lookup for %r failed — listing DEFAULT instance",
                                 provider_id)
        kw = {"host": host, "port": port, "max_connections": 2}
        if username:
            kw["username"] = username
        if password:
            kw["password"] = password
        handle = FalkorDB(connection_pool=ConnectionPool(**kw))
        keys = await handle.list_graphs()
        return {k.decode() if isinstance(k, bytes) else k for k in keys}
    except Exception:
        logger.warning("GRAPH.LIST failed for provider %r — key check unavailable", provider_id)
        return None
