"""
ProviderRegistry — lazy-initialised, async-safe registry of GraphDataProvider instances.

Workspace-centric: providers are cached by (provider_id, graph_name) tuple.
Legacy connection-based access is preserved for backward compatibility.

Backward compatibility:
    When no workspace or connection is specified, the registry resolves to the
    default workspace.  On first startup with an empty DB, _bootstrap_from_env()
    creates a Provider + Blueprint + Workspace from existing env vars.
"""
import asyncio
import json
import logging
import os
import time
from typing import Dict, Optional, Tuple

from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.interfaces.provider import GraphDataProvider

logger = logging.getLogger(__name__)


class ProviderRegistry:
    # How long to remember a failed provider instantiation (seconds).
    # During this window, requests fail fast instead of re-trying the full
    # connection timeout.  Cleared on eviction or manual reset.
    NEGATIVE_CACHE_TTL = 30

    def __init__(self) -> None:
        # Workspace-centric cache: (provider_id, graph_name) → provider
        self._providers: Dict[Tuple[str, str], GraphDataProvider] = {}
        self._locks: Dict[Tuple[str, str], asyncio.Lock] = {}
        # Negative cache: (provider_id, graph_name) → monotonic timestamp of last failure
        self._failed_cache: Dict[Tuple[str, str], float] = {}
        # Legacy connection-based cache (kept during migration)
        self._legacy_providers: Dict[str, GraphDataProvider] = {}
        self._legacy_locks: Dict[str, asyncio.Lock] = {}
        # Default workspace ID (replaces primary connection)
        self._default_ws_id: Optional[str] = None
        self._default_lock = asyncio.Lock()

    # ------------------------------------------------------------------ #
    # Workspace-centric API (new)                                          #
    # ------------------------------------------------------------------ #

    async def get_provider_for_workspace(
        self,
        workspace_id: str,
        session: AsyncSession,
        data_source_id: Optional[str] = None,
    ) -> GraphDataProvider:
        """
        Resolve workspace → data source → (provider_id, graph_name) → cached provider.
        If data_source_id is given, uses that specific source; otherwise uses the primary.
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

        # Fail fast if this provider recently failed (negative cache)
        failed_at = self._failed_cache.get(cache_key)
        if failed_at is not None:
            age = time.monotonic() - failed_at
            if age < self.NEGATIVE_CACHE_TTL:
                raise ConnectionError(
                    f"Provider {cache_key} recently failed ({age:.0f}s ago). "
                    f"Will retry in {self.NEGATIVE_CACHE_TTL - age:.0f}s."
                )
            else:
                del self._failed_cache[cache_key]

        if cache_key not in self._locks:
            self._locks[cache_key] = asyncio.Lock()

        async with self._locks[cache_key]:
            if cache_key not in self._providers:
                logger.info(
                    "Instantiating provider for workspace=%s ds=%s provider=%s graph=%s",
                    workspace_id, ds.id, ds.provider_id, ds.graph_name,
                )
                ds_extra = json.loads(ds.extra_config) if getattr(ds, "extra_config", None) else None
                try:
                    self._providers[cache_key] = await asyncio.wait_for(
                        self._instantiate_from_provider(
                            ds.provider_id, ds.graph_name, session,
                            ds_extra_config=ds_extra,
                        ),
                        timeout=10,
                    )
                except asyncio.TimeoutError:
                    self._failed_cache[cache_key] = time.monotonic()
                    raise ConnectionError(
                        f"Provider instantiation timed out for {cache_key}"
                    )
                except Exception:
                    self._failed_cache[cache_key] = time.monotonic()
                    raise

        return self._providers[cache_key]

    async def get_default_workspace_id(
        self, session: AsyncSession
    ) -> str:
        """Return the default workspace ID, bootstrapping from env if needed."""
        if self._default_ws_id:
            return self._default_ws_id

        async with self._default_lock:
            if self._default_ws_id:
                return self._default_ws_id

            if session is None:
                raise RuntimeError(
                    "No default workspace configured and no DB session provided."
                )

            from ..db.repositories.workspace_repo import get_default_workspace
            default_ws = await get_default_workspace(session)
            if default_ws:
                self._default_ws_id = default_ws.id
                return self._default_ws_id

            # No default workspace → try legacy primary connection first
            from ..db.repositories.connection_repo import get_primary_connection
            primary = await get_primary_connection(session)
            if primary:
                # Migrate: create workspace-centric entities from legacy connection
                self._default_ws_id = await self._migrate_connection_to_workspace(
                    primary, session
                )
                return self._default_ws_id

            # Nothing exists → bootstrap from env vars
            self._default_ws_id = await self._bootstrap_from_env(session)
            return self._default_ws_id

    # ------------------------------------------------------------------ #
    # Legacy connection-based API (backward compat)                        #
    # ------------------------------------------------------------------ #

    async def get_provider(
        self,
        connection_id: Optional[str] = None,
        session: Optional[AsyncSession] = None,
    ) -> GraphDataProvider:
        """
        Legacy: return a cached provider for a connection_id.
        Kept for backward compatibility during migration.
        """
        resolved_id = connection_id or await self._resolve_primary_id(session)

        if resolved_id not in self._legacy_locks:
            self._legacy_locks[resolved_id] = asyncio.Lock()

        async with self._legacy_locks[resolved_id]:
            if resolved_id not in self._legacy_providers:
                logger.info("Instantiating provider for connection_id=%s", resolved_id)
                try:
                    self._legacy_providers[resolved_id] = await asyncio.wait_for(
                        self._instantiate_from_connection(
                            resolved_id, session
                        ),
                        timeout=10,
                    )
                except asyncio.TimeoutError:
                    raise ConnectionError(
                        f"Provider instantiation timed out for connection {resolved_id}"
                    )

        return self._legacy_providers[resolved_id]

    async def _resolve_primary_id(self, session: Optional[AsyncSession]) -> str:
        """Legacy: resolve primary connection ID."""
        if session is None:
            raise RuntimeError(
                "No primary connection configured and no DB session provided."
            )
        from ..db.repositories.connection_repo import get_primary_connection
        primary = await get_primary_connection(session)
        if primary:
            return primary.id
        # Bootstrap if nothing exists
        await self._bootstrap_from_env(session)
        # Return the legacy connection ID created during bootstrap
        from ..db.repositories.connection_repo import get_primary_connection as gpc
        primary = await gpc(session)
        if primary:
            return primary.id
        raise RuntimeError("Bootstrap failed — no primary connection created.")

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
        self._failed_cache.pop(cache_key, None)
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

    async def evict(self, connection_id: str) -> None:
        """Legacy: evict by connection_id."""
        provider = self._legacy_providers.pop(connection_id, None)
        if provider is not None:
            try:
                await provider.close()
            except Exception as exc:
                logger.warning("Error closing provider %s: %s", connection_id, exc)
        self._legacy_locks.pop(connection_id, None)

    async def evict_all(self) -> None:
        """Evict all cached providers (workspace + legacy)."""
        for key in list(self._providers.keys()):
            await self.evict_data_source(key[0], key[1])
        for conn_id in list(self._legacy_providers.keys()):
            await self.evict(conn_id)
        self._failed_cache.clear()
        self._default_ws_id = None

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
        # Merge: data-source extra_config overrides provider-level
        merged_extra = self._merge_extra_config(provider_extra, ds_extra_config)
        return self._create_provider_instance(
            row.provider_type, row.host, row.port, graph_name,
            row.tls_enabled, credentials, extra_config=merged_extra,
        )

    async def _instantiate_from_connection(
        self,
        connection_id: str,
        session: Optional[AsyncSession],
    ) -> GraphDataProvider:
        """Legacy: instantiate from a GraphConnectionORM row."""
        from ..db.repositories.connection_repo import get_connection_orm, get_credentials

        if session is None:
            raise RuntimeError(f"Cannot instantiate provider for {connection_id}: no DB session.")

        row = await get_connection_orm(session, connection_id)
        if row is None:
            raise KeyError(f"Connection not found: {connection_id}")

        credentials = await get_credentials(session, connection_id)
        return self._create_provider_instance(
            row.provider_type, row.host, row.port, row.graph_name,
            row.tls_enabled, credentials,
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
        # Deep-merge the schemaMapping sub-key
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

    def _create_provider_instance(
        self,
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
    # Migration: connection → workspace-centric                            #
    # ------------------------------------------------------------------ #

    async def _migrate_connection_to_workspace(
        self, connection_orm, session: AsyncSession
    ) -> str:
        """
        Create Provider + Blueprint + Workspace from an existing legacy connection.
        Returns the new workspace ID.
        """
        from ..db.repositories import provider_repo, ontology_definition_repo, workspace_repo
        from backend.common.models.management import (
            ProviderCreateRequest,
            OntologyCreateRequest,
            WorkspaceCreateRequest,
            ProviderType,
        )

        provider_map = {
            "falkordb": ProviderType.FALKORDB,
            "neo4j": ProviderType.NEO4J,
            "datahub": ProviderType.DATAHUB,
        }
        ptype = provider_map.get(connection_orm.provider_type.lower(), ProviderType.FALKORDB)

        # Create Provider
        prov = await provider_repo.create_provider(session, ProviderCreateRequest(
            name=f"{connection_orm.name} (provider)",
            providerType=ptype,
            host=connection_orm.host,
            port=connection_orm.port,
            tlsEnabled=bool(connection_orm.tls_enabled),
        ))

        # Create Ontology from legacy ontology config (if exists)
        ont_req = OntologyCreateRequest(name=f"{connection_orm.name} ontology")
        if connection_orm.ontology_config:
            import json as _json
            ont = connection_orm.ontology_config
            ont_req = OntologyCreateRequest(
                name=f"{connection_orm.name} ontology",
                containmentEdgeTypes=_json.loads(ont.containment_edge_types or "[]"),
                lineageEdgeTypes=_json.loads(ont.lineage_edge_types or "[]"),
                edgeTypeMetadata=_json.loads(ont.edge_type_metadata or "{}"),
                entityTypeHierarchy=_json.loads(ont.entity_type_hierarchy or "{}"),
                rootEntityTypes=_json.loads(ont.root_entity_types or "[]"),
            )
        ontology = await ontology_definition_repo.create_ontology(session, ont_req)

        # Create Workspace with data source
        from backend.common.models.management import DataSourceCreateRequest
        ws = await workspace_repo.create_workspace(session, WorkspaceCreateRequest(
            name=connection_orm.name,
            dataSources=[DataSourceCreateRequest(
                providerId=prov.id,
                graphName=connection_orm.graph_name or "nexus_lineage",
                ontologyId=ontology.id,
            )],
        ), make_default=True)

        logger.info(
            "Migrated connection %s → provider=%s ontology=%s workspace=%s",
            connection_orm.id, prov.id, ontology.id, ws.id,
        )
        return ws.id

    # ------------------------------------------------------------------ #
    # Env-var bootstrap (workspace-centric)                                #
    # ------------------------------------------------------------------ #

    async def _bootstrap_from_env(self, session: AsyncSession) -> str:
        """
        Create Provider + Blueprint + Workspace + legacy Connection from env vars.
        Called once on first startup when both tables are empty.
        Returns the new workspace ID.

        Idempotent: uses a schema_migrations lock row to prevent multi-worker
        races on PostgreSQL (advisory-lock-style).
        """
        from ..db.repositories import provider_repo, ontology_definition_repo, workspace_repo
        from ..db.repositories.connection_repo import create_connection
        from backend.common.models.management import (
            ProviderCreateRequest,
            OntologyCreateRequest,
            WorkspaceCreateRequest,
            ConnectionCreateRequest,
            DataSourceCreateRequest,
            ProviderType,
        )
        sa_text = __import__("sqlalchemy").text

        # Guard against multi-worker race: try to claim a lock row in
        # schema_migrations.  Only the first worker to INSERT wins; the
        # second gets an IntegrityError and falls through to re-query.
        try:
            from datetime import datetime, timezone
            await session.execute(
                sa_text(
                    "INSERT INTO schema_migrations (key, applied_at) "
                    "VALUES ('bootstrap_env', :now)"
                ),
                {"now": datetime.now(timezone.utc).isoformat()},
            )
            await session.flush()
        except Exception:
            # Another worker already claimed the lock — rollback the failed
            # INSERT and re-check for the workspace it created.
            await session.rollback()
            # Brief wait for the winning worker to commit
            import asyncio
            await asyncio.sleep(1.0)
            existing = await workspace_repo.get_default_workspace(session)
            if existing:
                logger.info("Bootstrap skipped — default workspace created by another worker: %s", existing.id)
                return existing.id
            # If still nothing, fall through and try to create (edge case)

        # Double-check: another worker may have finished between our check and lock
        existing = await workspace_repo.get_default_workspace(session)
        if existing:
            logger.info("Bootstrap skipped — default workspace already exists: %s", existing.id)
            return existing.id

        provider_name = os.getenv("GRAPH_PROVIDER", "falkordb").lower()
        provider_map = {
            "falkordb": ProviderType.FALKORDB,
            "neo4j": ProviderType.NEO4J,
            "datahub": ProviderType.DATAHUB,
        }
        ptype = provider_map.get(provider_name, ProviderType.FALKORDB)

        host = os.getenv("FALKORDB_HOST", "localhost")
        port = int(os.getenv("FALKORDB_PORT", "6379"))
        graph_name = os.getenv("FALKORDB_GRAPH_NAME", "nexus_lineage")

        # 1. Create Provider
        prov = await provider_repo.create_provider(session, ProviderCreateRequest(
            name="Primary Server (bootstrapped)",
            providerType=ptype,
            host=host,
            port=port,
            tlsEnabled=False,
        ))

        # 2. Create Ontology from env (containment edge types from env var)
        containment_types_raw = os.getenv("CONTAINMENT_EDGE_TYPES", "")
        containment_types = [t.strip() for t in containment_types_raw.split(",") if t.strip()]

        ontology = await ontology_definition_repo.create_ontology(session, OntologyCreateRequest(
            name="Default Ontology (bootstrapped)",
            containmentEdgeTypes=containment_types,
        ))

        # 3. Create Workspace with data source (default)
        ws = await workspace_repo.create_workspace(session, WorkspaceCreateRequest(
            name="Default Workspace",
            dataSources=[DataSourceCreateRequest(
                providerId=prov.id,
                graphName=graph_name,
                ontologyId=ontology.id,
            )],
        ), make_default=True)

        # 4. Also create legacy connection for backward compat
        legacy_conn = await create_connection(session, ConnectionCreateRequest(
            name="Primary (bootstrapped from env)",
            provider_type=ptype,
            host=host,
            port=port,
            graph_name=graph_name,
            credentials=None,
            tls_enabled=False,
        ), make_primary=True)

        logger.info(
            "Bootstrapped from env: provider=%s ontology=%s workspace=%s legacy_conn=%s",
            prov.id, ontology.id, ws.id, legacy_conn.id,
        )

        self._default_ws_id = ws.id
        return ws.id


# Module-level singleton — used by FastAPI dependency and ContextEngine.
provider_registry = ProviderRegistry()
