"""The graph-read plumbing every reader shares, request or not.

A route and a background job read the graph the same way: keyed in the graph
cache by (workspace, data source, branch, physical graph), admitted one
statement at a time through the per-(provider, graph) slot pair, and stamped
with the data generation they read. These helpers used to live in the graph
route module, where a worker — which must never import the API layer — could
not reach them. ``api/v1/endpoints/graph.py`` keeps its ``_…`` names as thin
wrappers over these, so its callers and their tests are unchanged.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import replace
from typing import Any, Optional

from backend.app.services.graph_cache import CacheScope, get_graph_cache, graph_ns_hash


def resolve_physical_graph_id(provider: Any, _depth: int = 0) -> Optional[str]:
    """Best-effort resolution of the live (host, port, graph_name) identity
    behind a possibly-wrapped provider.

    ``CircuitBreakerProxy`` and ``VersionedWriteProvider`` both delegate
    unknown attribute access to their wrapped provider via ``__getattr__``,
    so ``provider.physical_graph_id`` already resolves through those layers
    for free. ``DraftOverlayProvider`` does not implement ``__getattr__``,
    so it's unwrapped explicitly via its ``_base``.

    Returns None when unresolvable — notably a ``VersionedBranchProvider``
    (draft-on-stale-main / stale-main reads), which wraps a
    ``GraphVersioningService`` rather than a live graph adapter, so there is
    no physical graph to identify. Callers treat None as "no physical
    identity available" and the cache scope falls back to the ds-only
    behaviour. Never raises.
    """
    if provider is None or _depth > 5:
        return None
    try:
        get_id = getattr(provider, "physical_graph_id", None)
        if callable(get_id):
            return get_id()
        base = getattr(provider, "_base", None)
        if base is not None and base is not provider:
            return resolve_physical_graph_id(base, _depth + 1)
    except Exception:
        return None
    return None


def cache_scope(engine: Any) -> Optional[CacheScope]:
    """Derive the (workspace, data source) scope for cache keys.

    Returns None when the engine has no workspace context (legacy
    connection-scoped path). Connection-scoped reads bypass the cache —
    they're vanishingly rare in production and not worth the extra key
    plumbing.

    ``graph_ns`` is populated best-effort from the engine's live provider
    identity (host:port:graph_name, hashed) so a data source re-pointed to
    a different physical graph can never be served the old graph's cached
    response — see CacheScope's docstring. Resolution failure (or a
    provider shape we can't unwrap) degrades to graph_ns="", i.e. ds-only
    scoping; this never raises.
    """
    ws = getattr(engine, "_workspace_id", None)
    if not ws:
        return None
    ds = getattr(engine, "_data_source_id", None) or ""
    branch = getattr(engine, "_branch_id", None) or ""
    graph_ns = ""
    try:
        physical_id = resolve_physical_graph_id(getattr(engine, "provider", None))
        if physical_id:
            graph_ns = graph_ns_hash(physical_id)
    except Exception:
        graph_ns = ""
    return CacheScope(workspace_id=ws, data_source_id=ds, branch_id=branch, graph_ns=graph_ns)


def statement_admission(engine: Any, manager: Any = None):
    """The per-(provider, graph) slot pair — this process's and the fleet's —
    as a context manager held for ONE statement, or None when the engine's
    provider has no slot key (no admission then, as ``_bounded_compute``).

    ``manager`` is the ``ProviderManager`` whose slots to take: the process's
    own by default; a worker that keeps its own registry passes it, so its
    statements queue on the pools that serve them.
    """
    key = getattr(getattr(engine, "provider", None), "manager_cache_key", None)
    if key is None:
        return None
    if manager is None:
        from backend.app.providers.manager import provider_manager as manager

    @asynccontextmanager
    async def admit():
        sem = await manager.acquire_provider_slot(*key)
        try:
            async with manager.fleet_slot(*key):
                yield
        finally:
            sem.release()

    return admit


async def data_version(scope: Optional[CacheScope], cache: Any = None) -> str:
    """The graph data a read of ``scope`` sees: the published graph's content
    generation (a draft reads the graph it is a draft of) and the physical
    graph behind it. Never raises; "" when unknown. ``cache`` defaults to the
    process's graph cache."""
    if scope is None:
        return ""
    published = replace(scope, branch_id="")
    generation = await (cache or get_graph_cache()).content_generation(published)
    return f"{generation}.{published.graph_ns}"


async def search_data_version(engine: Any) -> str:
    """``data_version`` of the engine's own scope."""
    return await data_version(cache_scope(engine))
