"""Neo4j's entry in the provider catalog.

``_build`` is ``manager.py``'s former ``elif provider_type == "neo4j":``
branch, unchanged: the driver-backed adapter class is imported lazily,
inside the function, exactly as it is imported lazily inside the dispatch
branch it replaces.
"""
from backend.common.interfaces.provider import ProviderCapability, ProviderFeature

from . import register
from .descriptor import ConnectionShape, ProviderDescriptor, ProviderSpec


def _build(spec: ProviderSpec):
    from backend.graph.adapters.neo4j_provider import Neo4jProvider
    creds = spec.credentials
    return Neo4jProvider(
        uri=f"{'bolt+s' if spec.tls_enabled else 'bolt'}://{spec.host}:{spec.port or 7687}",
        username=creds.get("username", "neo4j"),
        password=creds.get("password", ""),
        database=spec.graph_name or "neo4j",
        # The CACHE role's per-provider override (extra_config.cacheConnection
        # + the decrypted cache_* credentials, including the legacy
        # extra_config.redisUrl alias) -- resolved centrally by
        # build_neo4j_cache_client, never inherited from the Bolt credentials.
        extra_config=spec.extra_config,
        provider_id=spec.provider_id,
        credentials=creds,
    )


DESCRIPTOR = register(ProviderDescriptor(
    id="neo4j",
    label="Neo4j",
    description="Neo4j graph database via the official Bolt driver.",
    docs_url=None,
    family="cypher",
    capability=ProviderCapability(
        writable=True, full_crud=False, is_external=False, supports_copy=False,
        features=frozenset({ProviderFeature.SCHEMA_DISCOVERY, ProviderFeature.MULTI_GRAPH}),
    ),
    connection=ConnectionShape(
        kind="generic",
        uses_host_port=True,
        default_port=7687,
        tls="flag",
        auth="basic",
        extra_config_keys=("schemaMapping",),
    ),
    build=_build,
    provider_class_path="backend.graph.adapters.neo4j_provider:Neo4jProvider",
))
