"""FalkorDB's entry in the provider catalog.

The provider catalog (``backend.common.providers.catalog``) is the
dependency-free kernel ``tests/test_falkordb_kernel_purity.py`` proves
imports zero ``backend.app`` modules -- module-level or inside a function
body, lazy or not. FalkorDB's concrete class (``FalkorDBProvider``) lives
under ``backend.app`` (this package), so unlike neo4j/datahub/spanner
(whose classes live under ``backend.graph.adapters`` and register
themselves directly from ``catalog/neo4j.py`` etc.), FalkorDB's descriptor
is built and registered from here instead: this module imports the
catalog to call :func:`register` on it; the catalog never imports this
module or anything else under ``backend.app``.

``backend.app.providers.falkordb``'s own ``__init__`` imports this module
for that side effect, so importing the FalkorDB package -- which anything
that can actually construct a ``FalkorDBProvider`` has necessarily done --
is what guarantees ``"falkordb"`` is present in ``PROVIDER_CATALOG``.
Importing ``backend.common.providers.catalog`` alone does not register
this type; see that package's ``__init__`` docstring.

``_build`` is ``manager.py``'s former ``if provider_type == "falkordb":``
branch, unchanged.
"""
from backend.common.interfaces.provider import ProviderCapability, ProviderFeature
from backend.common.models.management import _validate_cache_connection, _validate_falkordb_connection
from backend.common.providers.catalog import register
from backend.common.providers.catalog.descriptor import ConnectionShape, ProviderDescriptor, ProviderSpec


def _build(spec: ProviderSpec):
    from backend.app.providers.falkordb.hosts import resolve_falkordb_target
    from backend.app.providers.falkordb.provider import FalkorDBProvider
    host, port = resolve_falkordb_target(spec.host, spec.port)
    creds = spec.credentials
    # P1.6 -- credentials previously dropped here, causing NOAUTH
    # errors to be mis-classified as network failures and tripping
    # the breaker for what is actually a configuration problem.
    # Passing username/password through means the driver issues
    # AUTH on every new connection and the breaker only fires for
    # real downstream failures.
    # Connection topology (standalone / sentinel / cluster) rides
    # extra_config["falkordbConnection"]. None / absent -> the
    # legacy single-host path. Previously extra_config was dropped
    # on the FalkorDB branch (only Neo4j/Spanner consumed it).
    _falkor_conn = (spec.extra_config or {}).get("falkordbConnection")
    # Per-provider auth gate (extra_config.falkordbConnection.authEnabled,
    # default true). When false, the provider nulls the graph
    # credentials at a single chokepoint so no AUTH leaks to an
    # unauthenticated FalkorDB (a dedicated cache_redis_url keeps its
    # own embedded auth).
    _auth_enabled = (_falkor_conn or {}).get("authEnabled", True)
    return FalkorDBProvider(
        host=host or "localhost",
        port=port or 6379,
        graph_name=spec.graph_name or "nexus_lineage",
        username=creds.get("username"),
        password=creds.get("password"),
        connection_config=_falkor_conn,
        # Per-provider dedicated cache Redis (encrypted credential;
        # deprecated alias -- folded into credentials["cache_redis_url"]).
        cache_redis_url=creds.get("cache_redis_url"),
        auth_enabled=_auth_enabled,
        # Connection-level TLS (the falkordbConnection.tls object adds
        # CA/client-cert/verify mode). Previously dropped for FalkorDB.
        tls_enabled=spec.tls_enabled,
        # The CACHE role's per-provider override (extra_config.cacheConnection
        # + the decrypted cache_* credentials) -- resolved centrally by
        # build_cache_client, never inherited from the graph connection.
        provider_id=spec.provider_id,
        extra_config=spec.extra_config,
        credentials=creds,
    )


def _validate(req) -> None:
    _validate_falkordb_connection(req.extra_config)
    _validate_cache_connection(req.extra_config)


def _probe_strategy(extra):
    # For FalkorDB Sentinel/Cluster topologies, a single host/port preflight
    # is not representative (host/port may be unset; routing is driven by the
    # node lists). Exercise the real connection path instead -- it resolves
    # the master / owning node and runs RETURN 1.
    fmode = ((extra or {}).get("falkordbConnection") or {}).get("mode")
    return "full_connect" if fmode in ("sentinel", "cluster") else "preflight"


def _probe_deadline_s(extra, default):
    # A provider configured for a slow cross-cluster hop raises its own
    # budget via falkordbConnection.probeDeadlineS -- the fixed default must
    # extend, never clip, or the Test button false-fails the exact providers
    # the knob exists for.
    probe_deadline = ((extra or {}).get("falkordbConnection") or {}).get("probeDeadlineS")
    try:
        return max(default, float(probe_deadline))
    except (TypeError, ValueError):
        return default


DESCRIPTOR = register(ProviderDescriptor(
    id="falkordb",
    label="FalkorDB",
    description="FalkorDB -- the primary, in-house-managed graph engine.",
    docs_url=None,
    family="cypher",
    capability=ProviderCapability(
        writable=True, full_crud=True, is_external=False, supports_copy=True,
        features=frozenset({
            ProviderFeature.TRACE_CLOSURE,
            ProviderFeature.COARSE_TRACE,
            ProviderFeature.DEEP_SEARCH,
            ProviderFeature.AGGREGATION_MATERIALIZATION,
            ProviderFeature.BLANK_MODELS,
            ProviderFeature.MULTI_GRAPH,
        }),
    ),
    connection=ConnectionShape(
        kind="falkordb",
        uses_host_port=True,
        default_port=6379,
        tls="flag",
        auth="basic",
        secret_credential_keys=(
            "username", "password", "cache_username", "cache_password",
            "cache_sentinel_username", "cache_sentinel_password",
            "sentinel_username", "sentinel_password", "cache_redis_url",
        ),
        extra_config_keys=("falkordbConnection", "cacheConnection"),
    ),
    build=_build,
    validate=_validate,
    probe_strategy=_probe_strategy,
    probe_deadline_s=_probe_deadline_s,
    provider_class_path="backend.app.providers.falkordb_provider:FalkorDBProvider",
))
