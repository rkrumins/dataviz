"""
ProviderManager -- resilient, workspace-centric manager for GraphDataProvider instances.

Replaces the former ProviderRegistry with integrated:
* Per-(provider_id, graph_name) instance cache with CircuitBreakerProxy wrapping
* Instantiation-time circuit breaker (negative cache) so a dead downstream
  doesn't burn 10s per request on repeated instantiation attempts
* HealthState reporting for readiness probes and observability
* Async-safe double-checked locking per cache key

Design invariants:
* Every provider instance handed out is wrapped in a CircuitBreakerProxy.
* A failing downstream is detected at TWO levels:
  1. Instantiation-time: the instantiation breaker opens after N failures,
     fast-failing subsequent requests in <1ms with ProviderUnavailable.
  2. Operation-time: the per-instance CircuitBreakerProxy opens after N
     method-call failures, fast-failing with ProviderUnavailable.
* Legacy connection-based access has been removed. All access is workspace-scoped.
"""

import asyncio
import json
import logging
import os
from enum import Enum
from typing import Dict, Optional, Tuple

from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.adapters import (
    AsyncCircuitBreaker,
    BreakerOpenError,
    BreakerState,
    CircuitBreakerProxy,
    ProviderUnavailable,
)
from backend.common.interfaces.provider import GraphDataProvider

logger = logging.getLogger(__name__)

# Tuneable via env vars. See backend/app/config/resilience.py for full reference.
_BREAKER_FAIL_MAX = int(os.getenv("PROVIDER_BREAKER_FAIL_MAX", "3"))
_BREAKER_RESET_TIMEOUT = int(os.getenv("PROVIDER_BREAKER_RESET_TIMEOUT_SECS", "30"))


class HealthState(str, Enum):
    """Observable health of a provider from the manager's perspective."""
    UNKNOWN = "unknown"
    HEALTHY = "healthy"
    DEGRADED = "degraded"  # half-open probing
    UNAVAILABLE = "unavailable"  # breaker open, fast-failing
    INSTANTIATION_FAILED = "instantiation_failed"  # never successfully created


def _wrap_in_breaker(provider: GraphDataProvider, name: str) -> GraphDataProvider:
    """Wrap a raw provider in a CircuitBreakerProxy before caching."""
    return CircuitBreakerProxy(  # type: ignore[return-value]
        target=provider,
        name=name,
        fail_max=_BREAKER_FAIL_MAX,
        reset_timeout=_BREAKER_RESET_TIMEOUT,
    )


class ProviderManager:
    """Resilient, workspace-centric manager for GraphDataProvider instances."""

    def __init__(self) -> None:
        # Workspace-centric cache: (provider_id, graph_name) -> breaker-wrapped provider
        self._providers: Dict[Tuple[str, str], GraphDataProvider] = {}
        self._locks: Dict[Tuple[str, str], asyncio.Lock] = {}

        # Instantiation-time circuit breakers -- prevent repeated 10s timeouts
        # against a dead downstream. Opens after _BREAKER_FAIL_MAX failures,
        # fast-fails for _BREAKER_RESET_TIMEOUT seconds.
        self._instantiation_breakers: Dict[Tuple[str, str], AsyncCircuitBreaker] = {}

        # Background warmup status cache (P0.7): keyed by provider_id,
        # populated by the lifespan-launched ``run_provider_warmup_loop``
        # in ``backend/app/providers/warmup.py``. Health/status endpoints
        # read this for the source of truth on un-visited providers,
        # making provider unreachability invisible to the request path.
        # Entry shape: see warmup.py module docstring.
        self.warmup_cache: Dict[str, dict] = {}

    # ------------------------------------------------------------------ #
    # Public API                                                           #
    # ------------------------------------------------------------------ #

    async def get_provider(
        self,
        workspace_id: str,
        session: AsyncSession,
        data_source_id: Optional[str] = None,
    ) -> GraphDataProvider:
        """
        Resolve workspace -> data source -> (provider_id, graph_name) -> cached provider.

        Raises ProviderUnavailable if the provider cannot be reached (both
        instantiation-time and operation-time failures are normalized).
        Raises KeyError if the workspace or data source is not found.
        """
        from ..db.repositories import data_source_repo

        if data_source_id:
            ds = await data_source_repo.get_data_source_orm(session, data_source_id)
            if ds is None:
                raise KeyError(f"Data source not found: {data_source_id}")
        else:
            ds = await data_source_repo.get_primary_data_source(session, workspace_id)
            if ds is None:
                raise KeyError(f"No data source for workspace: {workspace_id}")

        cache_key = (ds.provider_id, ds.graph_name or "")

        # Fast path: already cached and healthy
        if cache_key in self._providers:
            return self._providers[cache_key]

        # Check the instantiation breaker BEFORE attempting to create.
        # If the breaker is open, fail fast (<1ms, no I/O).
        breaker = self._get_instantiation_breaker(cache_key)
        try:
            await breaker._acquire_call_slot()
        except BreakerOpenError as exc:
            raise ProviderUnavailable(
                provider_name=f"{cache_key[0]}:{cache_key[1]}",
                reason="Provider instantiation circuit open — recent attempts failed",
                retry_after_seconds=exc.retry_after_seconds,
            )

        # Slow path: acquire per-key lock and instantiate
        if cache_key not in self._locks:
            self._locks[cache_key] = asyncio.Lock()

        async with self._locks[cache_key]:
            # Double-check after acquiring lock
            if cache_key in self._providers:
                await breaker._record_success()
                return self._providers[cache_key]

            logger.info(
                "Instantiating provider for workspace=%s ds=%s provider=%s graph=%s",
                workspace_id, ds.id, ds.provider_id, ds.graph_name,
            )
            ds_extra = json.loads(ds.extra_config) if getattr(ds, "extra_config", None) else None
            try:
                raw_provider = await asyncio.wait_for(
                    self._instantiate_from_provider(
                        ds.provider_id, ds.graph_name, session,
                        ds_extra_config=ds_extra,
                    ),
                    timeout=10,
                )
            except asyncio.TimeoutError:
                state_after, fails_after = await breaker._record_failure()
                logger.warning(
                    "Provider instantiation timed out for %s (breaker=%s fails=%d/%d)",
                    cache_key, state_after, fails_after, breaker.fail_max,
                )
                raise ProviderUnavailable(
                    provider_name=f"{cache_key[0]}:{cache_key[1]}",
                    reason="Provider instantiation timed out",
                )
            except Exception as exc:
                state_after, fails_after = await breaker._record_failure()
                logger.warning(
                    "Provider instantiation failed for %s: %s (breaker=%s fails=%d/%d)",
                    cache_key, exc, state_after, fails_after, breaker.fail_max,
                )
                raise ProviderUnavailable(
                    provider_name=f"{cache_key[0]}:{cache_key[1]}",
                    reason=f"Instantiation failed: {exc}",
                ) from exc

            # Success: wrap in circuit breaker and cache.
            breaker_name = f"{ds.provider_id}:{ds.graph_name or ''}"
            self._providers[cache_key] = _wrap_in_breaker(raw_provider, breaker_name)
            state_after, _ = await breaker._record_success()
            logger.info(
                "Provider cached for %s (breaker=%s)",
                cache_key, state_after,
            )

        return self._providers[cache_key]

    # Alias for backward compatibility during migration. ContextEngine,
    # aggregation worker, and health-check endpoint call this name.
    async def get_provider_for_workspace(
        self,
        workspace_id: str,
        session: AsyncSession,
        data_source_id: Optional[str] = None,
    ) -> GraphDataProvider:
        return await self.get_provider(workspace_id, session, data_source_id)

    def get_health(self, provider_id: str, graph_name: str) -> HealthState:
        """Return the observable health state of a specific provider."""
        cache_key = (provider_id, graph_name or "")

        # Check instantiation breaker first
        if cache_key in self._instantiation_breakers:
            ib = self._instantiation_breakers[cache_key]
            ib_state = ib.current_state
            if ib_state == BreakerState.OPEN.value:
                return HealthState.INSTANTIATION_FAILED

        # Check cached provider's operation breaker
        if cache_key in self._providers:
            proxy = self._providers[cache_key]
            if hasattr(proxy, "_breaker"):
                ob_state = proxy._breaker.current_state
                if ob_state == BreakerState.OPEN.value:
                    return HealthState.UNAVAILABLE
                if ob_state == BreakerState.HALF_OPEN.value:
                    return HealthState.DEGRADED
                return HealthState.HEALTHY

        return HealthState.UNKNOWN

    def report_provider_states(self) -> Dict[str, str]:
        """Return health states for all known providers (cached + breaker-tracked).

        Used by the /health/ready endpoint. No I/O, no new connections.
        """
        states: Dict[str, str] = {}

        # Report cached providers
        for cache_key in self._providers:
            key_str = f"{cache_key[0]}:{cache_key[1]}"
            states[key_str] = self.get_health(cache_key[0], cache_key[1]).value

        # Report instantiation-failed providers not in cache
        for cache_key, breaker in self._instantiation_breakers.items():
            key_str = f"{cache_key[0]}:{cache_key[1]}"
            if key_str not in states and breaker.current_state == BreakerState.OPEN.value:
                states[key_str] = HealthState.INSTANTIATION_FAILED.value

        return states

    # ------------------------------------------------------------------ #
    # Eviction                                                             #
    # ------------------------------------------------------------------ #

    async def evict_data_source(self, provider_id: str, graph_name: str) -> None:
        """Evict cached provider for a (provider_id, graph_name) pair."""
        cache_key = (provider_id, graph_name or "")
        provider = self._providers.pop(cache_key, None)
        if provider is not None:
            try:
                await provider.close()
            except Exception as exc:
                logger.warning("Error closing provider %s: %s", cache_key, exc)
        self._locks.pop(cache_key, None)
        # Also reset the instantiation breaker so re-instantiation is attempted
        self._instantiation_breakers.pop(cache_key, None)
        logger.info("Evicted provider for key=%s", cache_key)

    async def evict_workspace(self, workspace_id: str, session: AsyncSession) -> None:
        """Evict all cached providers for all data sources in a workspace."""
        from ..db.repositories import data_source_repo
        sources = await data_source_repo.list_data_sources(session, workspace_id)
        for ds in sources:
            await self.evict_data_source(ds.provider_id, ds.graph_name or "")

    async def evict_provider(self, provider_id: str) -> None:
        """Evict all cached providers for a given provider_id (any graph_name)."""
        keys_to_evict = [k for k in self._providers if k[0] == provider_id]
        for key in keys_to_evict:
            await self.evict_data_source(key[0], key[1])

    async def evict_all(self) -> None:
        """Evict all cached providers. Called during shutdown."""
        for key in list(self._providers.keys()):
            await self.evict_data_source(key[0], key[1])

    # ------------------------------------------------------------------ #
    # Provider instantiation                                               #
    # ------------------------------------------------------------------ #

    async def _instantiate_from_provider(
        self,
        provider_id: str,
        graph_name: Optional[str],
        session: AsyncSession,
        ds_extra_config: Optional[dict] = None,
    ) -> GraphDataProvider:
        """Instantiate a GraphDataProvider from a ProviderORM row."""
        from ..db.repositories.provider_repo import get_provider_orm, get_credentials

        row = await get_provider_orm(session, provider_id)
        if row is None:
            raise KeyError(f"Provider not found: {provider_id}")

        credentials = await get_credentials(session, provider_id)
        provider_extra = json.loads(row.extra_config) if row.extra_config else None
        merged_extra = self._merge_extra_config(provider_extra, ds_extra_config)
        return self._create_provider_instance(
            row.provider_type, row.host, row.port, graph_name,
            row.tls_enabled, credentials, extra_config=merged_extra,
        )

    @staticmethod
    def _merge_extra_config(
        provider_config: Optional[dict],
        datasource_config: Optional[dict],
    ) -> Optional[dict]:
        """Merge provider-level and data-source-level extra_config.
        DataSource values win on conflict (shallow merge at top-level,
        deep merge for ``schemaMapping`` sub-key).
        """
        if not provider_config and not datasource_config:
            return None
        base = dict(provider_config or {})
        override = dict(datasource_config or {})
        if "schemaMapping" in base and "schemaMapping" in override:
            merged_mapping = dict(base["schemaMapping"])
            merged_mapping.update(
                {k: v for k, v in override["schemaMapping"].items() if v is not None}
            )
            base.update(override)
            base["schemaMapping"] = merged_mapping
        else:
            base.update(override)
        return base

    @staticmethod
    def _create_provider_instance(
        provider_type: str,
        host: Optional[str],
        port: Optional[int],
        graph_name: Optional[str],
        tls_enabled: bool,
        credentials: dict,
        extra_config: Optional[dict] = None,
    ) -> GraphDataProvider:
        """Dispatch to the correct provider constructor."""
        ptype = provider_type.lower()

        if ptype == "falkordb":
            from backend.app.providers.falkordb_provider import FalkorDBProvider
            return FalkorDBProvider(
                host=host or "localhost",
                port=port or 6379,
                graph_name=graph_name or "nexus_lineage",
            )

        elif ptype == "neo4j":
            from backend.graph.adapters.neo4j_provider import Neo4jProvider
            return Neo4jProvider(
                uri=f"{'bolt+s' if tls_enabled else 'bolt'}://{host}:{port or 7687}",
                username=credentials.get("username", "neo4j"),
                password=credentials.get("password", ""),
                database=graph_name or "neo4j",
                extra_config=extra_config,
            )

        elif ptype == "datahub":
            from backend.graph.adapters.datahub_provider import DataHubGraphQLProvider
            return DataHubGraphQLProvider(
                base_url=host or "",
                token=credentials.get("token"),
            )

        raise ValueError(f"Unknown provider_type: {ptype!r}")

    # ------------------------------------------------------------------ #
    # Internal helpers                                                     #
    # ------------------------------------------------------------------ #

    def _get_instantiation_breaker(self, cache_key: Tuple[str, str]) -> AsyncCircuitBreaker:
        """Get or create the instantiation-time circuit breaker for a cache key."""
        if cache_key not in self._instantiation_breakers:
            self._instantiation_breakers[cache_key] = AsyncCircuitBreaker(
                name=f"init:{cache_key[0]}:{cache_key[1]}",
                fail_max=_BREAKER_FAIL_MAX,
                reset_timeout=_BREAKER_RESET_TIMEOUT,
            )
        return self._instantiation_breakers[cache_key]


# Module-level singleton -- used by FastAPI dependency and ContextEngine.
provider_manager = ProviderManager()
