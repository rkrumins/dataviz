"""Registry-backed FalkorDB cache-eviction budget resolver.

Bridges the management-DB provider registry to the versioning eviction daemon.
The daemon takes an injected ``provider_id -> budget`` resolver (so the
versioning store stays decoupled from the provider registry); this builds one
that reads each provider's ``falkor_max_resident`` from the providers table,
falling back to the env-backed default (``GRAPHVER_FALKOR_*`` via
``falkor_budget_for``) when a provider has no budget set — which also covers the
``"default"`` pseudo-provider used by single-FalkorDB deployments.

A budget of 0 means "unlimited" for that provider; an explicit 0 in the registry
is honoured (not treated as "unset"), so only a missing row / NULL column falls
through to the env default.
"""
from __future__ import annotations

from typing import Awaitable, Callable, Optional

from backend.app.db.engine import PoolRole, get_session_factory
from backend.app.db.repositories import provider_repo
from backend.app.services.versioning import config as vconfig


def make_registry_budget_resolver(session_factory=None) -> Callable[[str], Awaitable[int]]:
    """Return an async ``provider_id -> max resident graphs`` resolver backed by
    the provider registry, with the env-backed default as fallback.

    ``session_factory`` defaults to a READONLY-pool sessionmaker; it is injectable
    for tests.
    """
    factory = session_factory or get_session_factory(PoolRole.READONLY)

    async def budget(provider_id: str) -> int:
        async with factory() as session:
            registry_budget: Optional[int] = await provider_repo.get_falkor_budget(
                session, provider_id
            )
        if registry_budget is not None:
            return registry_budget
        return vconfig.falkor_budget_for(provider_id)

    return budget
