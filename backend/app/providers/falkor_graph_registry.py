"""Registry-backed, provider-aware FalkorDB graph factory for the projector.

Bridges the management-DB provider registry to the versioning projector/read path.
The projector takes an injected ``(name, provider_id=None) -> graph`` factory (so the
versioning store stays decoupled from the registry — same pattern as
``eviction_budget.make_registry_budget_resolver``); this builds one that routes each
graph to **its data source's pinned FalkorDB instance**, so a projection lands on the
same instance — over the same TOPOLOGY — that the per-provider read path
(``ProviderManager``) and the aggregation worker use.

Topology parity (the point of this module): the connection is resolved from the
provider row's own ``extra_config.falkordbConnection`` through the SAME
``load_connection_config`` → ``build_graph_client`` path as the read path, via the
shared ``TopologyGraphClients`` cache. A standalone, a Sentinel and a Cluster
instance can therefore coexist in one deployment and every service reaches each of
them correctly. Previously this module hand-rolled a plain ``ConnectionPool(host,
port)`` — always standalone — which pinned a Sentinel instance to whoever was master
at boot and could only see the slots of one seed node on a Cluster instance.

Fallback contract:
- ``provider_id`` of ``None`` / ``""`` / ``"default"`` (genuinely unrouted — a graph with
  no pinned provider) → the env-configured instance (``FALKORDB_HOST`` / ``FALKORDB_PORT``
  / ``FALKORDB_MODE`` + the mode's env vars). This is the ONLY case that falls back to
  the env instance.
- An explicitly PINNED ``provider_id`` that is unknown / inactive / non-falkordb / has no
  host, or whose lookup raises, RAISES ``ProviderConfigurationError`` instead — landing a
  pinned graph's writes on the wrong (env-default) instance is a data-corruption risk, not
  something to silently paper over.

The factory returns an awaitable (resolving a provider does an async registry read the
first time, and a cluster client resolves the graph's owning node); callers ``await`` it.
Provider rows are cached per id for the process lifetime (credential/topology rotation
therefore needs a process restart — flagged in docs); the graph CLIENTS behind them
self-heal on a node rotation (see ``ResilientGraph``).
"""
from __future__ import annotations

import json
import logging
from typing import Callable, Optional

from backend.common.interfaces.provider import ProviderConfigurationError

logger = logging.getLogger(__name__)

_UNROUTED = (None, "", "default")

# provider_id -> FalkorDBConnConfig. Process-wide (NOT per-factory) so that ONE
# admin edit can invalidate it everywhere: main.py, the versioning endpoints and
# the versioning worker each build their own factory, and a per-closure memo would
# leave the others writing to the old instance.
_RESOLVED: dict = {}


async def invalidate_provider(provider_id: str) -> None:
    """Forget a provider's connection config and drop every graph client built
    from it.

    Called from ``ProviderManager.evict_data_source`` — the single eviction
    chokepoint — so an admin changing a provider's host / mode / credentials
    invalidates the READ path and the PROJECTOR path together. Without this the
    projector would keep writing to the OLD instance (or the old topology) until
    the process restarted: a silent data-corruption hazard, not just a stale read.

    Also runs on the warmup loop's recovery eviction, which is what discards the
    dead sockets a rotated pod leaves behind in these long-lived pools.
    """
    cfg = _RESOLVED.pop(provider_id, None)
    if cfg is None:
        return
    from backend.app.providers.falkordb_connection import graph_clients

    try:
        await graph_clients().invalidate_config(cfg)
    except Exception:                                # pragma: no cover - best effort
        logger.warning("failed to drop cached graph clients for provider %r",
                       provider_id, exc_info=True)


async def resolve_provider_conn_config(provider_id: str, session_factory=None):
    """PINNED ``provider_id`` → its ``FalkorDBConnConfig`` (topology + auth + TLS).

    Mirrors ``ProviderManager._create_provider_instance`` exactly: the same host
    resolution (``resolve_falkordb_target``), the same ``extra_config
    .falkordbConnection`` topology block, the same ``authEnabled`` gate (when false
    the credentials are nulled so no AUTH leaks to an unauthenticated instance), and
    the same connection-level TLS flag. Divergence here is what previously made a
    provider READ fine while every projection to it failed.

    RAISES ``ProviderConfigurationError`` if the provider is missing/inactive/
    non-falkordb/has no host, or if the lookup itself fails — never falls back to the
    env-default instance (that would land this graph's writes on the WRONG instance).
    """
    from backend.app.db.engine import PoolRole, get_session_factory
    from backend.app.db.repositories import provider_repo
    from backend.app.providers.falkordb_connection import load_connection_config
    from backend.app.providers.falkordb_provider import resolve_falkordb_target

    try:
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
            extra = json.loads(row.extra_config) if row.extra_config else {}
            host, port = resolve_falkordb_target(row.host, int(row.port or 6379))
    except ProviderConfigurationError:
        raise
    except Exception as exc:
        raise ProviderConfigurationError(
            f"provider lookup for {provider_id!r} failed — refusing to silently "
            f"route its graphs to the DEFAULT FalkorDB instance") from exc

    falkor_conn = (extra or {}).get("falkordbConnection")
    # authEnabled=false → this instance takes no AUTH (parity with the read path's
    # single chokepoint; sending AUTH to an unauthenticated FalkorDB errors out).
    auth_enabled = (falkor_conn or {}).get("authEnabled", True)
    return load_connection_config(
        falkor_conn,
        host=host,
        port=port,
        username=creds.get("username") if auth_enabled else None,
        password=creds.get("password") if auth_enabled else None,
        tls_enabled=bool(row.tls_enabled),
    )


def make_registry_graph_factory(session_factory=None) -> Callable[[str, Optional[str]], object]:
    """Return an async ``(name, provider_id=None) -> graph`` factory backed by the
    provider registry, env-fallback ONLY for the genuinely-unrouted case.

    ``session_factory`` defaults to a READONLY-pool sessionmaker; injectable for tests.
    """
    from backend.app.providers.falkordb_connection import env_conn_config, graph_clients

    async def _resolve(provider_id: str):
        """Memoized on success only — a transient lookup error or a since-fixed
        provider row is retried on the next call rather than staying broken for the
        process lifetime. The memo is the module-level ``_RESOLVED`` so
        ``invalidate_provider`` can clear it for every factory at once."""
        if provider_id not in _RESOLVED:
            _RESOLVED[provider_id] = await resolve_provider_conn_config(
                provider_id, session_factory,
            )
        return _RESOLVED[provider_id]

    async def graph(name: str, provider_id: Optional[str] = None):
        cfg = (
            env_conn_config() if provider_id in _UNROUTED
            else await _resolve(provider_id)
        )
        # Topology-correct (standalone / Sentinel master / owning cluster node)
        # and self-healing across a rotation of that node.
        return await graph_clients().get_graph(cfg, name)

    return graph


async def list_graph_keys(provider_id: Optional[str] = None,
                          session_factory=None) -> Optional[set]:
    """Best-effort ``GRAPH.LIST`` on a provider's instance (env default ONLY for the
    genuinely unrouted/``None`` case). ``None`` when the instance is unreachable —
    callers must treat that as "cannot verify", never as "no keys".

    Topology-aware: on a CLUSTER instance the keys are spread across shards, so this
    unions ``GRAPH.LIST`` over every primary — a single-node listing would silently
    under-report and callers use this to decide whether a graph name is free.

    A PINNED ``provider_id`` that is missing/inactive/non-falkordb/has no host, or
    whose lookup fails, RAISES ``ProviderConfigurationError`` — same fail-loud contract
    as ``resolve_provider_conn_config``; it must never fall back to listing the DEFAULT
    instance."""
    from backend.app.providers.falkordb_connection import (
        env_conn_config, list_graph_keys_for_config,
    )

    cfg = (
        env_conn_config() if provider_id in _UNROUTED
        else await resolve_provider_conn_config(provider_id, session_factory)
    )
    try:
        return await list_graph_keys_for_config(cfg)
    except Exception:
        logger.warning("GRAPH.LIST failed for provider %r — key check unavailable", provider_id)
        return None
