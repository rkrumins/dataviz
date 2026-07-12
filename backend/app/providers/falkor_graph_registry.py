"""Registry-backed, provider-aware FalkorDB graph factory for the projector.

Bridges the management-DB provider registry to the versioning projector/read path.
The projector takes an injected ``(name, provider_id=None) -> graph`` factory (so the
versioning store stays decoupled from the registry — same pattern as
``eviction_budget.make_registry_budget_resolver``); this builds one that routes each
graph to **its data source's pinned FalkorDB instance** (``ProviderORM.host/port`` +
decrypted credentials), so a projection lands on the same instance the per-provider
read path (``ProviderManager``) and the aggregation worker use.

Fallback contract:
- ``provider_id`` of ``None`` / ``""`` / ``"default"`` (genuinely unrouted — a graph with
  no pinned provider) → the env-configured instance (``FALKORDB_HOST`` / ``FALKORDB_PORT``
  / ``FALKORDB_POOL_SIZE``) — exactly today's single-instance behavior. This is the ONLY
  case that falls back to the env instance.
- An explicitly PINNED ``provider_id`` that is unknown / inactive / non-falkordb / has no
  host, or whose lookup raises, RAISES ``ProviderConfigurationError`` instead — landing a
  pinned graph's writes on the wrong (env-default) instance is a data-corruption risk, not
  something to silently paper over.

The factory may return an awaitable (the first use of a provider does an async
registry read); callers ``await`` when needed. Handles are cached per ``(host,
port)``; provider rows are cached per id for the process lifetime (credential
rotation therefore needs a process restart — flagged in docs).
"""
from __future__ import annotations

import logging
import os
from typing import Callable, Optional

from backend.common.interfaces.provider import ProviderConfigurationError

logger = logging.getLogger(__name__)

_UNROUTED = (None, "", "default")


def _env_handle_factory():
    """One lazily-built handle for the env-configured (default) instance."""
    from redis.asyncio import ConnectionPool           # pragma: no cover - infra
    from falkordb.asyncio import FalkorDB              # pragma: no cover - infra
    from backend.app.providers.falkordb_connection import (
        projection_socket_timeout, resilient_pool_kwargs)

    pool = ConnectionPool(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        max_connections=int(os.getenv("FALKORDB_POOL_SIZE", "10")),
        **resilient_pool_kwargs(socket_timeout=projection_socket_timeout()),
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
        """PINNED provider_id → connection tuple (memoized on success).

        ``graph()`` short-circuits the genuinely-unrouted ``_UNROUTED`` case before ever
        calling this, so every call here is for an explicitly pinned provider. RAISES
        ``ProviderConfigurationError`` if that provider is missing/inactive/non-falkordb/
        has no host, or if the lookup itself fails — never falls back to the env-default
        instance (that would land this graph's writes on the WRONG instance). Not
        memoized on failure, so a transient lookup error or a since-fixed provider row is
        retried on the next call rather than staying broken for the process lifetime.
        """
        if provider_id in resolved:
            return resolved[provider_id]
        try:
            from backend.app.db.engine import PoolRole, get_session_factory
            from backend.app.db.repositories import provider_repo
            factory = session_factory or get_session_factory(PoolRole.READONLY)
            async with factory() as session:
                row = await provider_repo.get_provider_orm(session, provider_id)
                if row is None or not row.is_active or row.provider_type != "falkordb" \
                        or not row.host:
                    raise ProviderConfigurationError(
                        f"projection provider {provider_id!r} is missing/inactive/"
                        f"non-falkordb/has no host — refusing to silently route its "
                        f"graphs to the DEFAULT FalkorDB instance")
                creds = await provider_repo.get_credentials(session, provider_id)
                # Same resolution the read path applies — projector and reads must
                # resolve a provider to the SAME instance. Missing this parity was
                # why a localhost-registered provider READ fine but every
                # projection/rebuild died with "connection refused".
                from backend.app.providers.falkordb_provider import resolve_falkordb_target
                host, port = resolve_falkordb_target(row.host, int(row.port or 6379))
                conn = (host, port, creds.get("username"), creds.get("password"))
        except ProviderConfigurationError:
            raise
        except Exception as exc:
            raise ProviderConfigurationError(
                f"provider lookup for {provider_id!r} failed — refusing to silently "
                f"route its graphs to the DEFAULT FalkorDB instance") from exc
        resolved[provider_id] = conn
        return conn

    def _handle_for(conn):
        from backend.app.providers.falkordb_connection import (
            projection_socket_timeout, resilient_pool_kwargs)

        host, port, username, password = conn
        key = (host, port, username)
        if key not in handles:
            kw = {"host": host, "port": port,
                  "max_connections": int(os.getenv("FALKORDB_POOL_SIZE", "10")),
                  **resilient_pool_kwargs(socket_timeout=projection_socket_timeout())}
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
        return _handle_for(conn).select_graph(name)

    return graph


async def list_graph_keys(provider_id: Optional[str] = None,
                          session_factory=None) -> Optional[set]:
    """Best-effort ``GRAPH.LIST`` on a provider's instance (env default ONLY for the
    genuinely unrouted/``None`` case). ``None`` when the instance is unreachable —
    callers must treat that as "cannot verify", never as "no keys". Builds a one-shot
    connection (callers are rare, e.g. graph-name availability checks).

    A PINNED ``provider_id`` that is missing/inactive/non-falkordb/has no host, or
    whose lookup fails, RAISES ``ProviderConfigurationError`` — same fail-loud contract
    as ``_resolve`` above; it must never fall back to listing the DEFAULT instance."""
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
                if row is None or not row.is_active or row.provider_type != "falkordb" \
                        or not row.host:
                    raise ProviderConfigurationError(
                        f"projection provider {provider_id!r} is missing/inactive/"
                        f"non-falkordb/has no host — refusing to list the DEFAULT "
                        f"FalkorDB instance instead")
                creds = await provider_repo.get_credentials(session, provider_id)
                from backend.app.providers.falkordb_provider import resolve_falkordb_target
                host, port = resolve_falkordb_target(row.host, int(row.port or 6379))
                username, password = creds.get("username"), creds.get("password")
        except ProviderConfigurationError:
            raise
        except Exception as exc:
            raise ProviderConfigurationError(
                f"provider lookup for {provider_id!r} failed — refusing to list the "
                f"DEFAULT FalkorDB instance instead") from exc

    try:
        from falkordb.asyncio import FalkorDB          # pragma: no cover - infra
        from redis.asyncio import ConnectionPool       # pragma: no cover - infra
        from backend.app.providers.falkordb_connection import resilient_pool_kwargs

        kw = {"host": host, "port": port, "max_connections": 2,
              **resilient_pool_kwargs()}
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
