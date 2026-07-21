"""
Pydantic models for the management database layer.
Covers: graph connections, ontology configs, assignment rule sets, saved views.
"""
import json
from typing import List, Optional, Dict, Any
from urllib.parse import urlparse
from pydantic import BaseModel, Field, model_validator
from enum import Enum


class ProviderType(str, Enum):
    FALKORDB = "falkordb"
    NEO4J = "neo4j"
    DATAHUB = "datahub"
    SPANNER = "spanner"


# ============================================
# Connection Models
# ============================================

# Service-account JSON key shape we require for Spanner registrations
# (anything less and the google-cloud-spanner client can't construct
# `service_account.Credentials.from_service_account_info`). Validated
# at request boundary so a bad paste returns 400 with a clear message
# instead of a 500 deep in the provider's first probe.
_SPANNER_SA_REQUIRED_KEYS = {"type", "project_id", "private_key", "client_email"}


class ConnectionCredentials(BaseModel):
    username: Optional[str] = None
    password: Optional[str] = None
    token: Optional[str] = None
    # Spanner-specific. Both are snake_case to match the FE wizard payload.
    project_id: Optional[str] = None
    service_account_json: Optional[str] = None
    # FalkorDB per-provider dedicated cache Redis URL. Carried as a
    # credential (Fernet-encrypted, never returned) because the URL may
    # embed a password — unlike the non-secret topology config which rides
    # extra_config. Overrides the process-wide CACHE_REDIS_URL env.
    cache_redis_url: Optional[str] = None
    # ── Dedicated CACHE endpoint credentials (Fernet-encrypted, never returned).
    # The non-secret half (host/port/db/tls paths) rides extra_config.cacheConnection.
    cache_username: Optional[str] = None
    cache_password: Optional[str] = None
    cache_sentinel_username: Optional[str] = None
    cache_sentinel_password: Optional[str] = None
    # ── FalkorDB SENTINEL daemon credentials. These used to live in
    # extra_config.falkordbConnection.sentinel — an UNENCRYPTED column that
    # ProviderResponse returns to clients. Moved here; the old location is still
    # read for one release (see falkordb_connection.load_connection_config).
    sentinel_username: Optional[str] = None
    sentinel_password: Optional[str] = None

    class Config:
        populate_by_name = True
        extra = "forbid"  # silent drops are how B2 happened — fail loudly instead


class ConnectionCreateRequest(BaseModel):
    name: str
    provider_type: ProviderType
    host: Optional[str] = None
    port: Optional[int] = None
    graph_name: Optional[str] = None
    credentials: Optional[ConnectionCredentials] = None
    tls_enabled: bool = False
    extra_config: Optional[Dict[str, Any]] = Field(None, alias="extraConfig")

    class Config:
        populate_by_name = True


class ConnectionUpdateRequest(BaseModel):
    name: Optional[str] = None
    host: Optional[str] = None
    port: Optional[int] = None
    graph_name: Optional[str] = Field(None, alias="graphName")
    credentials: Optional[ConnectionCredentials] = None
    tls_enabled: Optional[bool] = Field(None, alias="tlsEnabled")
    is_active: Optional[bool] = Field(None, alias="isActive")
    extra_config: Optional[Dict[str, Any]] = Field(None, alias="extraConfig")

    class Config:
        populate_by_name = True


class ConnectionResponse(BaseModel):
    id: str
    name: str
    provider_type: ProviderType = Field(alias="providerType")
    host: Optional[str] = None
    port: Optional[int] = None
    graph_name: Optional[str] = Field(None, alias="graphName")
    tls_enabled: bool = Field(alias="tlsEnabled")
    is_primary: bool = Field(alias="isPrimary")
    is_active: bool = Field(alias="isActive")
    extra_config: Optional[Dict[str, Any]] = Field(None, alias="extraConfig")
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")
    # credentials are NEVER returned

    class Config:
        populate_by_name = True


class ConnectionTestResult(BaseModel):
    success: bool
    latency_ms: Optional[float] = Field(None, alias="latencyMs")
    error: Optional[str] = None
    provider_version: Optional[str] = Field(None, alias="providerVersion")

    class Config:
        populate_by_name = True


class GraphListResponse(BaseModel):
    graphs: List[str]
    connection_id: str = Field(alias="connectionId")

    class Config:
        populate_by_name = True


# ============================================
# Assignment Rule Set Models
# ============================================

class RuleSetCreateRequest(BaseModel):
    name: str
    description: Optional[str] = None
    layers_config: List[Dict[str, Any]] = Field(alias="layersConfig")
    is_default: bool = Field(False, alias="isDefault")

    class Config:
        populate_by_name = True


class RuleSetResponse(BaseModel):
    id: str
    connection_id: str = Field(alias="connectionId")
    name: str
    description: Optional[str] = None
    is_default: bool = Field(alias="isDefault")
    layers_config: List[Dict[str, Any]] = Field(alias="layersConfig")
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")

    class Config:
        populate_by_name = True


# ============================================
# Management DB Config Model
# ============================================

class StorageBackend(str, Enum):
    SQLITE = "sqlite"
    POSTGRES = "postgres"
    FALKORDB = "falkordb"


class ManagementDbConfig(BaseModel):
    storage_backend: StorageBackend = Field(StorageBackend.SQLITE, alias="storageBackend")
    falkordb_conn_id: Optional[str] = Field(None, alias="falkordbConnId")
    falkordb_graph_name: Optional[str] = Field(None, alias="falkordbGraphName")
    postgres_url: Optional[str] = Field(None, alias="postgresUrl")
    updated_at: Optional[str] = Field(None, alias="updatedAt")

    class Config:
        populate_by_name = True


# ============================================
# Provider Models (workspace-centric)
# ============================================

_FALKORDB_MODES = {"standalone", "sentinel", "cluster"}


def _validate_node_list(nodes: Any, path: str) -> None:
    """Validate a list of host:port nodes (accepts [host, port] pairs,
    {host, port} objects, or "host:port" strings — matching the backend's
    falkordb_connection._parse_nodes). ``path`` is the full dotted config
    path to use in error messages (e.g. "falkordbConnection.sentinel.nodes"),
    so this helper is reusable across any topology block, not just FalkorDB's."""
    if not isinstance(nodes, list) or len(nodes) == 0:
        raise ValueError(
            f"{path} must be a non-empty list of host:port nodes."
        )
    for n in nodes:
        host = port = None
        if isinstance(n, str):
            host, _, port = n.rpartition(":")
        elif isinstance(n, dict):
            host, port = n.get("host"), n.get("port")
        elif isinstance(n, (list, tuple)) and len(n) == 2:
            host, port = n[0], n[1]
        if not host or not str(host).strip():
            raise ValueError(
                f"{path}: each node needs a non-empty host (got {n!r})."
            )
        try:
            int(port)
        except (TypeError, ValueError):
            raise ValueError(
                f"{path}: each node needs an integer port (got {n!r})."
            )


def _validate_falkordb_connection(extra_config: Optional[Dict[str, Any]]) -> None:
    """Validate extra_config.falkordbConnection shape (no-op when absent →
    standalone). Mirrors the server-side gate pattern used for Spanner so the
    wizard gets a clear 422 before anything is persisted."""
    fc = (extra_config or {}).get("falkordbConnection")
    if fc is None:
        return
    if not isinstance(fc, dict):
        raise ValueError("extra_config.falkordbConnection must be an object.")
    # Same unencrypted-column exposure as cacheConnection (see
    # _validate_cache_connection) — refuse a secret-named key carrying a real
    # value anywhere under this block, not just the fields this function
    # otherwise knows about.
    _reject_secret_keys(fc, path="falkordbConnection")
    mode = fc.get("mode") or "standalone"
    if mode not in _FALKORDB_MODES:
        raise ValueError(
            f"falkordbConnection.mode must be one of {sorted(_FALKORDB_MODES)} (got {mode!r})."
        )
    if mode == "sentinel":
        sent = fc.get("sentinel") or {}
        if not str(sent.get("masterName") or "").strip():
            raise ValueError(
                "falkordbConnection.sentinel.masterName is required in sentinel mode."
            )
        _validate_node_list(sent.get("nodes"), "falkordbConnection.sentinel.nodes")
    elif mode == "cluster":
        clus = fc.get("cluster") or {}
        _validate_node_list(clus.get("startupNodes"), "falkordbConnection.cluster.startupNodes")
    for key, caster, label in (
        ("socketTimeout", float, "a positive number"),
        ("graphPoolSize", int, "a positive integer"),
    ):
        val = fc.get(key)
        if val is None:
            continue
        try:
            if caster(val) <= 0:
                raise ValueError
        except (TypeError, ValueError):
            raise ValueError(f"falkordbConnection.{key} must be {label}.")
    # Per-provider auth gate. Optional; when present must be a bool. False
    # disables FalkorDB graph AUTH for this provider (anonymous connect).
    if "authEnabled" in fc and not isinstance(fc.get("authEnabled"), bool):
        raise ValueError("falkordbConnection.authEnabled must be a boolean.")
    # Per-provider TLS / mutual-TLS. Optional object; cert inputs are file
    # PATHS (non-secret). Applies to the graph (all topologies), preflight,
    # and the cache.
    tls = fc.get("tls")
    if tls is not None:
        if not isinstance(tls, dict):
            raise ValueError("falkordbConnection.tls must be an object.")
        if "enabled" in tls and not isinstance(tls.get("enabled"), bool):
            raise ValueError("falkordbConnection.tls.enabled must be a boolean.")
        if "checkHostname" in tls and not isinstance(tls.get("checkHostname"), bool):
            raise ValueError("falkordbConnection.tls.checkHostname must be a boolean.")
        verify = tls.get("verifyMode")
        if verify is not None and str(verify).strip().lower() not in (
            "required", "optional", "none",
        ):
            raise ValueError(
                "falkordbConnection.tls.verifyMode must be one of "
                "'required', 'optional', 'none'."
            )
        for path_key in ("caCertPath", "certPath", "keyPath"):
            val = tls.get(path_key)
            if val is not None and not isinstance(val, str):
                raise ValueError(f"falkordbConnection.tls.{path_key} must be a string path.")


_SECRET_HINTS = (
    "pass", "pwd", "pw", "secret", "token", "credential",
    "apikey", "accesskey", "privatekey", "signingkey",
)


def _normalize_secret_key(key: str) -> str:
    """Lowercase and strip "_"/"-" so "api_key", "apiKey", "API-KEY" all match
    the single normalized hint "apikey"."""
    return key.lower().replace("_", "").replace("-", "")


def _looks_like_secret_key(key: str) -> bool:
    normalized = _normalize_secret_key(key)
    return any(hint in normalized for hint in _SECRET_HINTS)


def _is_redaction_placeholder(value: Any) -> bool:
    """True for ``redact_extra_config``'s own mask ("***") and empty/None
    values — i.e. NOT a newly-introduced secret. A client that GETs a
    provider (secrets already masked to "***") and PUTs it back unmodified
    must not be rejected for echoing back its own placeholder."""
    if value is None:
        return True
    if isinstance(value, str) and (value == "***" or not value.strip()):
        return True
    return False


def _reject_secret_keys(block: Any, *, path: str) -> None:
    """Recursively reject any secret-named key (see _SECRET_HINTS) carrying a
    real value anywhere under ``block`` (dicts and lists). ``path`` is the
    full dotted prefix to use in error messages (e.g. "cacheConnection" or
    "falkordbConnection") — shared by both connection validators so they
    can't drift out of sync (same ``path``-param idiom as _validate_node_list).
    """
    if isinstance(block, dict):
        for k, v in block.items():
            sub_path = f"{path}.{k}" if path else k
            if _looks_like_secret_key(k) and not _is_redaction_placeholder(v):
                raise ValueError(
                    f"{sub_path} looks like a secret. extra_config is stored "
                    f"unencrypted and returned by the API — put it in "
                    f"credentials instead."
                )
            _reject_secret_keys(v, path=sub_path)
    elif isinstance(block, list):
        for item in block:
            _reject_secret_keys(item, path=path)


def _redact_url_userinfo(value: str) -> str:
    """Mask the password in a URL's userinfo, e.g.
    ``redis://user:pw@host:6379/0`` -> ``redis://user:***@host:6379/0``.

    Catches secrets that ride INSIDE a value under a non-secret-looking key —
    e.g. legacy Neo4j ``extra_config["redisUrl"]`` — which ``redact_extra_config``'s
    key-name scan alone would miss. Non-URL strings pass through untouched.
    """
    if "://" not in value or "@" not in value:
        return value
    try:
        parsed = urlparse(value)
    except ValueError:
        return value
    if not parsed.password:
        return value
    netloc = f"{parsed.username or ''}:***@{parsed.hostname or ''}"
    if parsed.port:
        netloc += f":{parsed.port}"
    return parsed._replace(netloc=netloc).geturl()


def redact_extra_config(extra: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Mask secret-looking values anywhere in extra_config before it leaves the API.

    extra_config is an UNENCRYPTED column and ProviderResponse/DataSourceResponse
    return it, so any secret written there is both stored in the clear and echoed
    back. This function is purely NAME-based: it masks a secret-looking KEY
    anywhere in the tree (dicts and lists, case/separator-insensitive — see
    _SECRET_HINTS) and a password embedded in a URL's userinfo under an
    innocuous key (e.g. the legacy Neo4j ``redisUrl``). It is not a general
    secret-detection heuristic beyond those two cases.

    The schema validators (``_validate_cache_connection`` /
    ``_validate_falkordb_connection``, via the shared ``_reject_secret_keys``)
    reject a secret-named key carrying a real value at write time, in both
    ``cacheConnection`` and ``falkordbConnection``. This function is the
    belt-and-braces pass that also covers rows already in the database from
    before those validators existed.
    """
    if not extra:
        return extra

    def _walk(node: Any) -> Any:
        if isinstance(node, dict):
            return {
                k: ("***" if _looks_like_secret_key(k) and node[k]
                    else _walk(v))
                for k, v in node.items()
            }
        if isinstance(node, list):
            return [_walk(v) for v in node]
        if isinstance(node, str):
            return _redact_url_userinfo(node)
        return node

    return _walk(extra)


def _validate_cache_connection(extra: Optional[Dict[str, Any]]) -> None:
    """Validate extra_config.cacheConnection.

    extra_config is a PLAINTEXT column AND is returned by ProviderResponse, so a
    secret in here is stored in the clear and echoed back. Refuse them outright
    rather than trusting a redaction pass to catch every future key.
    """
    if not extra:
        return
    conn = extra.get("cacheConnection")
    if conn is None:
        return
    if not isinstance(conn, dict):
        raise ValueError("cacheConnection must be an object")

    _reject_secret_keys(conn, path="cacheConnection")

    mode = (conn.get("mode") or "standalone").strip().lower()
    if mode == "cluster":
        raise ValueError(
            "cacheConnection.mode 'cluster' is not supported. The cache uses SCAN + "
            "multi-key DEL and a non-zero DB index, neither of which works on a "
            "Redis Cluster. Use 'standalone' or 'sentinel'. (Cluster IS supported "
            "for the FalkorDB graph — see falkordbConnection.)"
        )
    if mode not in ("standalone", "sentinel"):
        raise ValueError(f"cacheConnection.mode must be standalone|sentinel, got {mode!r}")
    if mode == "sentinel":
        s = conn.get("sentinel") or {}
        if not s.get("masterName") or not s.get("nodes"):
            raise ValueError(
                "cacheConnection sentinel mode requires sentinel.masterName and "
                "sentinel.nodes"
            )
        # Shape-check the node list itself — without this, a malformed entry
        # (e.g. a bare string with no port) passes the 422 gate here and only
        # blows up later inside the resolver's node parsing, where it is
        # swallowed and silently degrades to cache-disabled.
        _validate_node_list(s.get("nodes"), "cacheConnection.sentinel.nodes")


class ProviderCreateRequest(BaseModel):
    name: str
    provider_type: ProviderType = Field(alias="providerType")
    host: Optional[str] = None
    port: Optional[int] = None
    credentials: Optional[ConnectionCredentials] = None
    tls_enabled: bool = Field(False, alias="tlsEnabled")
    extra_config: Optional[Dict[str, Any]] = Field(None, alias="extraConfig")
    falkor_max_resident: Optional[int] = Field(None, alias="falkorMaxResident")

    class Config:
        populate_by_name = True

    @model_validator(mode="after")
    def _validate_falkordb_connection_cfg(self) -> "ProviderCreateRequest":
        _validate_falkordb_connection(self.extra_config)
        _validate_cache_connection(self.extra_config)
        return self

    @model_validator(mode="after")
    def _validate_spanner_credentials(self) -> "ProviderCreateRequest":
        # Only Spanner has shape requirements on the credentials JSON; for
        # other provider types, the existing username/password/token fields
        # are validated by the dispatch (or not — that's a separate audit
        # item). Emulator mode skips auth entirely so credentials are
        # optional in that branch.
        if self.provider_type != ProviderType.SPANNER:
            return self
        use_emulator = bool((self.extra_config or {}).get("useEmulator"))
        if use_emulator:
            return self
        sa_json = (self.credentials.service_account_json
                   if self.credentials else None)
        if not sa_json:
            raise ValueError(
                "Spanner provider requires credentials.service_account_json "
                "(unless extra_config.useEmulator is true)."
            )
        try:
            parsed = json.loads(sa_json)
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"credentials.service_account_json is not valid JSON: {exc.msg}"
            ) from exc
        if not isinstance(parsed, dict):
            raise ValueError(
                "credentials.service_account_json must be a JSON object."
            )
        missing = _SPANNER_SA_REQUIRED_KEYS - parsed.keys()
        if missing:
            raise ValueError(
                "credentials.service_account_json is missing required keys: "
                f"{sorted(missing)}. Expected a Google service-account key "
                f"with at least {sorted(_SPANNER_SA_REQUIRED_KEYS)}."
            )
        return self


class ProviderUpdateRequest(BaseModel):
    name: Optional[str] = None
    host: Optional[str] = None
    port: Optional[int] = None
    credentials: Optional[ConnectionCredentials] = None
    # Credentials updates MERGE with the stored blob (an omitted field keeps its
    # existing value) — see provider_repo.update_provider. This is the explicit
    # way to REMOVE a key outright, since "send it as null" is indistinguishable
    # from "didn't touch it" once merged.
    credentials_clear: Optional[List[str]] = Field(None, alias="credentialsClear")
    tls_enabled: Optional[bool] = Field(None, alias="tlsEnabled")
    is_active: Optional[bool] = Field(None, alias="isActive")
    extra_config: Optional[Dict[str, Any]] = Field(None, alias="extraConfig")
    falkor_max_resident: Optional[int] = Field(None, alias="falkorMaxResident")

    class Config:
        populate_by_name = True

    @model_validator(mode="after")
    def _validate_falkordb_connection_cfg(self) -> "ProviderUpdateRequest":
        _validate_falkordb_connection(self.extra_config)
        _validate_cache_connection(self.extra_config)
        return self


class ProviderResponse(BaseModel):
    id: str
    name: str
    provider_type: ProviderType = Field(alias="providerType")
    host: Optional[str] = None
    port: Optional[int] = None
    tls_enabled: bool = Field(alias="tlsEnabled")
    is_active: bool = Field(alias="isActive")
    extra_config: Optional[Dict[str, Any]] = Field(None, alias="extraConfig")
    falkor_max_resident: Optional[int] = Field(None, alias="falkorMaxResident")
    permitted_workspaces: List[str] = Field(default_factory=lambda: ["*"], alias="permittedWorkspaces")
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")
    # credentials are NEVER returned. These non-secret flags say only WHETHER a
    # graph / cache credential is stored — so an edit form can show "stored —
    # leave blank to keep" instead of an empty field that reads as "no
    # credentials". They carry no value and are safe to return on every path.
    auth_configured: bool = Field(False, alias="authConfigured")
    cache_auth_configured: bool = Field(False, alias="cacheAuthConfigured")
    # FalkorDB sentinel-DAEMON credentials (sentinel_username/sentinel_password
    # in the blob) — the daemons authenticate separately from the data plane.
    sentinel_auth_configured: bool = Field(False, alias="sentinelAuthConfigured")

    class Config:
        populate_by_name = True


# ============================================
# Ontology Definition Models (standalone, versioned)
# ============================================

class OntologyCreateRequest(BaseModel):
    name: str
    description: Optional[str] = None
    version: int = 1
    scope: str = "universal"  # "universal" | "workspace"
    # Schema evolution policy: what happens when this ontology is updated and published.
    # reject   — block publish if it breaks existing data (default, safest).
    # deprecate — mark removed/renamed types deprecated; still served.
    # migrate  — apply a migration manifest to remap types automatically.
    evolution_policy: str = Field("reject", alias="evolutionPolicy")
    containment_edge_types: List[str] = Field(default_factory=list, alias="containmentEdgeTypes")
    lineage_edge_types: List[str] = Field(default_factory=list, alias="lineageEdgeTypes")
    edge_type_metadata: Dict[str, Any] = Field(default_factory=dict, alias="edgeTypeMetadata")
    entity_type_hierarchy: Dict[str, Any] = Field(default_factory=dict, alias="entityTypeHierarchy")
    root_entity_types: List[str] = Field(default_factory=list, alias="rootEntityTypes")
    entity_type_definitions: Dict[str, Any] = Field(default_factory=dict, alias="entityTypeDefinitions")
    relationship_type_definitions: Dict[str, Any] = Field(default_factory=dict, alias="relationshipTypeDefinitions")

    class Config:
        populate_by_name = True


class OntologyUpdateRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    evolution_policy: Optional[str] = Field(None, alias="evolutionPolicy")
    containment_edge_types: Optional[List[str]] = Field(None, alias="containmentEdgeTypes")
    lineage_edge_types: Optional[List[str]] = Field(None, alias="lineageEdgeTypes")
    edge_type_metadata: Optional[Dict[str, Any]] = Field(None, alias="edgeTypeMetadata")
    entity_type_hierarchy: Optional[Dict[str, Any]] = Field(None, alias="entityTypeHierarchy")
    root_entity_types: Optional[List[str]] = Field(None, alias="rootEntityTypes")
    entity_type_definitions: Optional[Dict[str, Any]] = Field(None, alias="entityTypeDefinitions")
    relationship_type_definitions: Optional[Dict[str, Any]] = Field(None, alias="relationshipTypeDefinitions")

    class Config:
        populate_by_name = True


class OntologyImportRequest(BaseModel):
    """
    Validated import payload — mirrors the export JSON format exactly.
    All semantic fields are required so we can detect what changed.
    Metadata fields (id, timestamps, status flags) are accepted but ignored on import.
    """
    # Metadata (accepted from export JSON, ignored during import)
    id: Optional[str] = None
    version: Optional[int] = None
    scope: Optional[str] = None
    is_published: Optional[bool] = Field(None, alias="isPublished")
    is_system: Optional[bool] = Field(None, alias="isSystem")
    created_at: Optional[str] = Field(None, alias="createdAt")
    updated_at: Optional[str] = Field(None, alias="updatedAt")

    # Required semantic content
    name: str
    description: Optional[str] = None
    evolution_policy: str = Field("reject", alias="evolutionPolicy")
    entity_type_definitions: Dict[str, Any] = Field(default_factory=dict, alias="entityTypeDefinitions")
    relationship_type_definitions: Dict[str, Any] = Field(default_factory=dict, alias="relationshipTypeDefinitions")
    containment_edge_types: List[str] = Field(default_factory=list, alias="containmentEdgeTypes")
    lineage_edge_types: List[str] = Field(default_factory=list, alias="lineageEdgeTypes")
    edge_type_metadata: Dict[str, Any] = Field(default_factory=dict, alias="edgeTypeMetadata")
    entity_type_hierarchy: Dict[str, Any] = Field(default_factory=dict, alias="entityTypeHierarchy")
    root_entity_types: List[str] = Field(default_factory=list, alias="rootEntityTypes")

    class Config:
        populate_by_name = True


class OntologyImportResponse(BaseModel):
    """Result of an import operation."""
    ontology: "OntologyDefinitionResponse"
    status: str  # "created" | "updated" | "new_version" | "no_changes"
    summary: str
    changes: Optional[Dict[str, Any]] = None  # type diff if applicable

    class Config:
        populate_by_name = True


class OntologyDefinitionResponse(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    version: int
    evolution_policy: str = Field("reject", alias="evolutionPolicy")
    containment_edge_types: List[str] = Field(alias="containmentEdgeTypes")
    lineage_edge_types: List[str] = Field(alias="lineageEdgeTypes")
    edge_type_metadata: Dict[str, Any] = Field(alias="edgeTypeMetadata")
    entity_type_hierarchy: Dict[str, Any] = Field(alias="entityTypeHierarchy")
    root_entity_types: List[str] = Field(alias="rootEntityTypes")
    entity_type_definitions: Dict[str, Any] = Field(default_factory=dict, alias="entityTypeDefinitions")
    relationship_type_definitions: Dict[str, Any] = Field(default_factory=dict, alias="relationshipTypeDefinitions")
    is_published: bool = Field(alias="isPublished")
    is_system: bool = Field(False, alias="isSystem")
    scope: str = "universal"
    schema_id: str = Field("", alias="schemaId")
    revision: int = Field(0)
    created_by: Optional[str] = Field(None, alias="createdBy")
    updated_by: Optional[str] = Field(None, alias="updatedBy")
    published_by: Optional[str] = Field(None, alias="publishedBy")
    published_at: Optional[str] = Field(None, alias="publishedAt")
    deleted_by: Optional[str] = Field(None, alias="deletedBy")
    deleted_at: Optional[str] = Field(None, alias="deletedAt")
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")

    class Config:
        populate_by_name = True


class OntologyAuditEntry(BaseModel):
    id: str
    ontology_id: str = Field(alias="ontologyId")
    schema_id: str = Field(alias="schemaId")
    action: str
    actor: Optional[str] = None
    version: Optional[int] = None
    summary: Optional[str] = None
    changes: Optional[Dict[str, Any]] = None
    created_at: str = Field(alias="createdAt")

    class Config:
        populate_by_name = True


class OntologyValidationIssue(BaseModel):
    severity: str  # "error" | "warning"
    code: str
    message: str
    affected: Optional[str] = None


class OntologyValidationResponse(BaseModel):
    is_valid: bool = Field(alias="isValid")
    issues: List[OntologyValidationIssue] = Field(default_factory=list)

    class Config:
        populate_by_name = True


class OntologyCoverageResponse(BaseModel):
    coverage_percent: float = Field(alias="coveragePercent")
    covered_entity_types: List[str] = Field(default_factory=list, alias="coveredEntityTypes")
    uncovered_entity_types: List[str] = Field(default_factory=list, alias="uncoveredEntityTypes")
    extra_entity_types: List[str] = Field(default_factory=list, alias="extraEntityTypes")
    covered_relationship_types: List[str] = Field(default_factory=list, alias="coveredRelationshipTypes")
    uncovered_relationship_types: List[str] = Field(default_factory=list, alias="uncoveredRelationshipTypes")

    class Config:
        populate_by_name = True


class OntologyResolutionRelGap(BaseModel):
    """A relationship type missing classification flags."""
    id: str
    name: str
    is_containment: Optional[bool] = Field(None, alias="isContainment")
    is_lineage: Optional[bool] = Field(None, alias="isLineage")

    class Config:
        populate_by_name = True


class OntologyResolutionHierarchyGap(BaseModel):
    """An entity type with an incomplete hierarchy field. Advisory."""
    entity_type: str = Field(alias="entityType")
    missing_field: str = Field(alias="missingField")

    class Config:
        populate_by_name = True


class OntologyResolutionResponse(BaseModel):
    """Per-data-source ontology resolution gate report.

    Drives the AssetOnboardingWizard SchemaReviewStep and is enforced
    by AggregationService.trigger before any aggregation job is created.
    """
    resolved: bool
    ontology_id: Optional[str] = Field(None, alias="ontologyId")
    ontology_version: Optional[int] = Field(None, alias="ontologyVersion")
    ontology_is_published: bool = Field(False, alias="ontologyIsPublished")
    missing_entity_types: List[str] = Field(default_factory=list, alias="missingEntityTypes")
    missing_edge_types: List[str] = Field(default_factory=list, alias="missingEdgeTypes")
    unclassified_relationships: List[OntologyResolutionRelGap] = Field(
        default_factory=list, alias="unclassifiedRelationships"
    )
    has_lineage: bool = Field(False, alias="hasLineage")
    has_containment: bool = Field(False, alias="hasContainment")
    hierarchy_warnings: List[OntologyResolutionHierarchyGap] = Field(
        default_factory=list, alias="hierarchyWarnings"
    )
    advisory_warnings: List[str] = Field(default_factory=list, alias="advisoryWarnings")
    blocking_reasons: List[str] = Field(default_factory=list, alias="blockingReasons")
    # Share of introspected types covered by the ontology; None without introspection data.
    coverage_percent: Optional[float] = Field(None, alias="coveragePercent")
    fingerprint: Optional[str] = None

    class Config:
        populate_by_name = True


class OntologyMatchResult(BaseModel):
    ontology_id: str = Field(alias="ontologyId")
    ontology_name: str = Field(alias="ontologyName")
    version: int
    jaccard_score: float = Field(alias="jaccardScore")
    covered_entity_types: List[str] = Field(default_factory=list, alias="coveredEntityTypes")
    uncovered_entity_types: List[str] = Field(default_factory=list, alias="uncoveredEntityTypes")
    covered_relationship_types: List[str] = Field(default_factory=list, alias="coveredRelationshipTypes")
    uncovered_relationship_types: List[str] = Field(default_factory=list, alias="uncoveredRelationshipTypes")
    total_entity_types: int = Field(0, alias="totalEntityTypes")
    total_relationship_types: int = Field(0, alias="totalRelationshipTypes")
    # Relationship types the graph USES that this ontology declares but leaves UNCLASSIFIED
    # (neither containment nor lineage — i.e. stuck in "Other"). The name-overlap jaccardScore
    # ignores classification, so a 100% match can still be non-functional for aggregation; this
    # qualifies it so the UI can warn "N edges uncategorized" instead of implying a working setup.
    uncategorized_relationship_types: List[str] = Field(
        default_factory=list, alias="uncategorizedRelationshipTypes"
    )

    class Config:
        populate_by_name = True


class MergedTypeVariant(BaseModel):
    spelling: str
    count: int = 0


class OntologySuggestResponse(BaseModel):
    suggested: OntologyCreateRequest
    matching_ontologies: List[OntologyMatchResult] = Field(default_factory=list, alias="matchingOntologies")
    # Canonical suggested type id → the source spellings merged into it (Task E §1c).
    # Present only for types the source spelled >1 way; the suggest-review UI shows these
    # inline with a "split" affordance so a same-source multi-variant is a visible decision.
    merged_variants: Dict[str, List[MergedTypeVariant]] = Field(
        default_factory=dict, alias="mergedVariants")

    class Config:
        populate_by_name = True


# ============================================
# Data Source Models (workspace data sources)
# ============================================

class DataSourceCreateRequest(BaseModel):
    provider_id: Optional[str] = Field(None, alias="providerId")
    catalog_item_id: Optional[str] = Field(None, alias="catalogItemId")
    graph_name: Optional[str] = Field(None, alias="graphName")
    ontology_id: Optional[str] = Field(None, alias="ontologyId")
    label: Optional[str] = None
    access_level: Optional[str] = Field(None, alias="accessLevel")  # read | write | admin
    extra_config: Optional[dict] = Field(None, alias="extraConfig")  # per-data-source config (schema mapping, etc.)

    class Config:
        populate_by_name = True

    @model_validator(mode="after")
    def _validate_extra_config_cfg(self) -> "DataSourceCreateRequest":
        # A data source's extra_config merges with (and can override) its
        # provider's — see ProviderManager._merge_extra_config — and rides the
        # same unencrypted column echoed back by DataSourceResponse. It must be
        # held to the same gate as a provider's extra_config, or this endpoint
        # is a side door around Provider's secret/cluster-mode validation.
        _validate_falkordb_connection(self.extra_config)
        _validate_cache_connection(self.extra_config)
        return self


class DataSourceUpdateRequest(BaseModel):
    provider_id: Optional[str] = Field(None, alias="providerId")
    graph_name: Optional[str] = Field(None, alias="graphName")
    ontology_id: Optional[str] = Field(None, alias="ontologyId")
    label: Optional[str] = None
    is_active: Optional[bool] = Field(None, alias="isActive")
    projection_mode: Optional[str] = Field(None, alias="projectionMode")  # None | "in_source" | "dedicated"
    dedicated_graph_name: Optional[str] = Field(None, alias="dedicatedGraphName")  # graph name when dedicated
    extra_config: Optional[dict] = Field(None, alias="extraConfig")  # per-data-source config (schema mapping, etc.)

    class Config:
        populate_by_name = True

    @model_validator(mode="after")
    def _validate_extra_config_cfg(self) -> "DataSourceUpdateRequest":
        _validate_falkordb_connection(self.extra_config)
        _validate_cache_connection(self.extra_config)
        return self


class DataSourceResponse(BaseModel):
    id: str
    workspace_id: str = Field(alias="workspaceId")
    provider_id: Optional[str] = Field(None, alias="providerId")
    catalog_item_id: Optional[str] = Field(None, alias="catalogItemId")
    graph_name: Optional[str] = Field(None, alias="graphName")
    ontology_id: Optional[str] = Field(None, alias="ontologyId")
    label: Optional[str] = None
    is_primary: bool = Field(alias="isPrimary")
    is_active: bool = Field(alias="isActive")
    projection_mode: Optional[str] = Field(None, alias="projectionMode")
    dedicated_graph_name: Optional[str] = Field(None, alias="dedicatedGraphName")
    access_level: Optional[str] = Field(None, alias="accessLevel")  # read | write | admin
    extra_config: Optional[dict] = Field(None, alias="extraConfig")
    # Provenance: "managed" = in-app writable graph (blank/versioned models),
    # "federated" = external system of record. None on legacy rows — clients
    # derive from shape (no catalog item → managed), mirroring the ORM comment.
    source_mode: Optional[str] = Field(None, alias="sourceMode")  # "managed" | "federated"
    write_back_enabled: bool = Field(False, alias="writeBackEnabled")
    # Aggregation state
    aggregation_status: str = Field("none", alias="aggregationStatus")
    last_aggregated_at: Optional[str] = Field(None, alias="lastAggregatedAt")
    aggregation_edge_count: int = Field(0, alias="aggregationEdgeCount")
    aggregation_schedule: Optional[str] = Field(None, alias="aggregationSchedule")
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")

    class Config:
        populate_by_name = True


# ============================================
# Workspace Models (workspace-centric)
# ============================================

class WorkspaceCreateRequest(BaseModel):
    name: str
    description: Optional[str] = None
    data_sources: List[DataSourceCreateRequest] = Field(alias="dataSources")

    class Config:
        populate_by_name = True


class WorkspaceUpdateRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    is_active: Optional[bool] = Field(None, alias="isActive")

    class Config:
        populate_by_name = True


class WorkspaceResponse(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    data_sources: List[DataSourceResponse] = Field(default_factory=list, alias="dataSources")
    is_default: bool = Field(alias="isDefault")
    is_active: bool = Field(alias="isActive")
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")
    #: People and groups with access. The cards could not show "who works here"
    #: without it, and asking per-workspace would be one request per card.
    member_count: int = Field(0, alias="memberCount")
    #: Live (non-deleted) views built on this workspace.
    view_count: int = Field(0, alias="viewCount")

    class Config:
        populate_by_name = True

    @property
    def primary_data_source(self) -> Optional[DataSourceResponse]:
        """Return the primary data source, or first if none marked primary."""
        return next(
            (ds for ds in self.data_sources if ds.is_primary),
            self.data_sources[0] if self.data_sources else None,
        )

    @property
    def provider_id(self) -> Optional[str]:
        """Convenience: provider_id from primary data source (backward compat)."""
        ds = self.primary_data_source
        return ds.provider_id if ds else None

    @property
    def graph_name(self) -> Optional[str]:
        """Convenience: graph_name from primary data source (backward compat)."""
        ds = self.primary_data_source
        return ds.graph_name if ds else None

    @property
    def ontology_id(self) -> Optional[str]:
        """Convenience: ontology_id from primary data source."""
        ds = self.primary_data_source
        return ds.ontology_id if ds else None


# ============================================
# Context Model Models
# ============================================

class ContextModelCreateRequest(BaseModel):
    name: str
    description: Optional[str] = None
    is_template: bool = Field(False, alias="isTemplate")
    category: Optional[str] = None
    layers_config: List[Dict[str, Any]] = Field(default_factory=list, alias="layersConfig")
    scope_filter: Optional[Dict[str, Any]] = Field(None, alias="scopeFilter")
    instance_assignments: Dict[str, Any] = Field(default_factory=dict, alias="instanceAssignments")
    scope_edge_config: Optional[Dict[str, Any]] = Field(None, alias="scopeEdgeConfig")
    display_rules_config: Optional[List[Dict[str, Any]]] = Field(None, alias="displayRulesConfig")

    class Config:
        populate_by_name = True


class ContextModelUpdateRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    layers_config: Optional[List[Dict[str, Any]]] = Field(None, alias="layersConfig")
    scope_filter: Optional[Dict[str, Any]] = Field(None, alias="scopeFilter")
    instance_assignments: Optional[Dict[str, Any]] = Field(None, alias="instanceAssignments")
    scope_edge_config: Optional[Dict[str, Any]] = Field(None, alias="scopeEdgeConfig")
    display_rules_config: Optional[List[Dict[str, Any]]] = Field(None, alias="displayRulesConfig")

    class Config:
        populate_by_name = True


class ContextModelResponse(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    workspace_id: Optional[str] = Field(None, alias="workspaceId")
    data_source_id: Optional[str] = Field(None, alias="dataSourceId")
    is_template: bool = Field(alias="isTemplate")
    category: Optional[str] = None
    layers_config: List[Dict[str, Any]] = Field(default_factory=list, alias="layersConfig")
    scope_filter: Optional[Dict[str, Any]] = Field(None, alias="scopeFilter")
    instance_assignments: Dict[str, Any] = Field(default_factory=dict, alias="instanceAssignments")
    scope_edge_config: Optional[Dict[str, Any]] = Field(None, alias="scopeEdgeConfig")
    display_rules_config: Optional[List[Dict[str, Any]]] = Field(None, alias="displayRulesConfig")
    is_active: bool = Field(alias="isActive")
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")

    class Config:
        populate_by_name = True


class InstantiateTemplateRequest(BaseModel):
    template_id: str = Field(alias="templateId")
    name: str

    class Config:
        populate_by_name = True


# ============================================
# View Models (visual rendering of context models)
# ============================================

class ViewCreateRequest(BaseModel):
    name: str
    description: Optional[str] = None
    context_model_id: Optional[str] = Field(None, alias="contextModelId")
    workspace_id: str = Field(alias="workspaceId")
    data_source_id: Optional[str] = Field(None, alias="dataSourceId")
    view_type: str = Field("graph", alias="viewType")
    config: Dict[str, Any] = Field(default_factory=dict)
    visibility: str = "private"
    tags: Optional[List[str]] = None
    is_pinned: bool = Field(False, alias="isPinned")

    class Config:
        populate_by_name = True


class ViewUpdateRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    context_model_id: Optional[str] = Field(None, alias="contextModelId")
    view_type: Optional[str] = Field(None, alias="viewType")
    config: Optional[Dict[str, Any]] = None
    visibility: Optional[str] = None
    tags: Optional[List[str]] = None
    is_pinned: Optional[bool] = Field(None, alias="isPinned")

    class Config:
        populate_by_name = True


class ViewLayoutUpdateRequest(BaseModel):
    """Body for ``PUT /views/{id}/layout`` — a layout-only update (layer
    definitions + the flattened urn->assignment map), decoupled from the
    rest of the view's config (name/description/content/filters/...). See
    ``backend.app.services.layout_config.parse_reference_layout`` for the
    canonical shape ``reference_layout`` must match.
    """
    reference_layout: Dict[str, Any] = Field(alias="referenceLayout")
    entity_scope: Optional[str] = Field(None, alias="entityScope")
    display_rules: Optional[List[Dict[str, Any]]] = Field(None, alias="displayRules")

    class Config:
        populate_by_name = True

    @model_validator(mode="after")
    def _validate_reference_layout_shape(self) -> "ViewLayoutUpdateRequest":
        if not isinstance(self.reference_layout.get("layers"), list):
            raise ValueError("referenceLayout.layers must be a list")
        if not isinstance(self.reference_layout.get("assignments"), dict):
            raise ValueError("referenceLayout.assignments must be a dict")
        return self

    @model_validator(mode="after")
    def _validate_entity_scope(self) -> "ViewLayoutUpdateRequest":
        if self.entity_scope is not None and self.entity_scope not in ("all", "curated"):
            raise ValueError("entityScope must be 'all' or 'curated'")
        return self


class ViewResponse(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    context_model_id: Optional[str] = Field(None, alias="contextModelId")
    context_model_name: Optional[str] = Field(None, alias="contextModelName")
    workspace_id: str = Field(alias="workspaceId")
    workspace_name: Optional[str] = Field(None, alias="workspaceName")
    data_source_id: Optional[str] = Field(None, alias="dataSourceId")
    data_source_name: Optional[str] = Field(None, alias="dataSourceName")
    view_type: str = Field(alias="viewType")
    # Layout algorithm (reference | hierarchical | force | …). Projected from
    # config.layoutType so metadata-only consumers (e.g. the ViewWizard's
    # scope resolver) can branch on it without parsing the full config.
    layout_type: Optional[str] = Field(None, alias="layoutType")
    config: Dict[str, Any] = Field(default_factory=dict)
    visibility: str = "private"
    created_by: Optional[str] = Field(None, alias="createdBy")
    # Human-readable display for the creator, resolved server-side so
    # every UI surface can show "Alex Smith" rather than "usr_abc123".
    # Nullable for legacy rows where the user record has since been
    # deleted — callers fall back to ``created_by`` in that case.
    created_by_name: Optional[str] = Field(None, alias="createdByName")
    created_by_email: Optional[str] = Field(None, alias="createdByEmail")
    # Who last edited the view. NULL until the first edit after the
    # updated_by migration; names NULL whenever the user can't be resolved
    # (deleted record / anonymous), resolved server-side like created_by.
    updated_by: Optional[str] = Field(None, alias="updatedBy")
    updated_by_name: Optional[str] = Field(None, alias="updatedByName")
    updated_by_email: Optional[str] = Field(None, alias="updatedByEmail")
    # When/who last changed the view's UNDERLYING DATA (a publish / PR merge /
    # revert on its data source) — separate from updated_* (settings edits) so
    # both stories stay truthful. NULL until the first post-migration publish;
    # the name resolves in the same batched user lookup as created_by.
    data_updated_at: Optional[str] = Field(None, alias="dataUpdatedAt")
    data_updated_by: Optional[str] = Field(None, alias="dataUpdatedBy")
    data_updated_by_name: Optional[str] = Field(None, alias="dataUpdatedByName")
    data_updated_by_email: Optional[str] = Field(None, alias="dataUpdatedByEmail")
    tags: Optional[List[str]] = None
    is_pinned: bool = Field(False, alias="isPinned")
    favourite_count: int = Field(0, alias="favouriteCount")
    is_favourited: bool = Field(False, alias="isFavourited")
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")
    deleted_at: Optional[str] = Field(None, alias="deletedAt")
    # Ontology digest captured at view save time. When the wizard opens a
    # view for edit, it compares this against the currently-resolved ontology
    # digest; a mismatch surfaces a non-blocking drift banner so the user
    # knows some entity classifications may have changed since creation.
    # NULL on legacy rows → wizard treats as "drift check unavailable".
    ontology_digest: Optional[str] = Field(None, alias="ontologyDigest")

    class Config:
        populate_by_name = True


class ViewListResponse(BaseModel):
    """Paginated view listing envelope.

    Returned by GET /api/v1/views/ so callers get an authoritative
    ``total`` count and a pre-computed ``has_more`` flag instead of
    guessing from ``len(items) >= limit``. ``next_offset`` is the
    offset to pass for the next page, or None when ``has_more`` is
    False.

    ``popular`` is populated only when the caller passes
    ``?include=popular`` so the Explorer can grab its list + trending
    strip in one round-trip. Absent (None) otherwise.
    """
    items: List[ViewResponse]
    total: int
    has_more: bool = Field(alias="hasMore")
    next_offset: Optional[int] = Field(None, alias="nextOffset")
    popular: Optional[List[ViewResponse]] = None

    class Config:
        populate_by_name = True


class ViewFacetValue(BaseModel):
    """A single facet value with its row count."""
    value: str
    count: int


class ViewFacetCreator(BaseModel):
    """A creator facet row, enriched with display metadata."""
    user_id: str = Field(alias="userId")
    display_name: str = Field(alias="displayName")
    email: Optional[str] = None
    count: int

    class Config:
        populate_by_name = True


class ViewCatalogStats(BaseModel):
    """Aggregate catalog counts surfaced in the Explorer stats bar.

    Returned by ``GET /api/v1/views/stats`` which accepts the same
    filter params as the list endpoint — so the numbers always
    describe the current query, not a stale "entire catalog" snapshot.
    """
    total: int
    recently_added: int = Field(alias="recentlyAdded")
    needs_attention: int = Field(alias="needsAttention")
    last_activity_at: Optional[str] = Field(None, alias="lastActivityAt")

    class Config:
        populate_by_name = True


class ViewFacetsResponse(BaseModel):
    """Aggregate facets across the views table.

    Used by the Explorer to populate the Tag / View Type / Creator
    dropdowns so users can pick from the real set of values in the
    database rather than a derived-from-current-page approximation.
    Facets are intentionally GLOBAL (not filter-scoped) so dropdowns
    always offer the full option space — see ``GET /views/stats`` for
    filter-aware counts.
    """
    tags: List[ViewFacetValue]
    view_types: List[ViewFacetValue] = Field(alias="viewTypes")
    creators: List[ViewFacetCreator]

    class Config:
        populate_by_name = True


# ─── Impact / Blast-radius models ─────────────────────────────────────────────

class ImpactedEntity(BaseModel):
    """A single entity (workspace, view, catalog item) affected by a deletion."""
    id: str
    name: str
    type: str  # e.g. "workspace", "view", "catalog_item"


class ProviderImpactResponse(BaseModel):
    """Blast-radius report when deleting a Provider."""
    catalogItems: List[ImpactedEntity] = []
    workspaces: List[ImpactedEntity] = []
    views: List[ImpactedEntity] = []


class DraftImpact(BaseModel):
    """An unpublished draft that a delete would destroy, and the person who will lose it.

    Not an `ImpactedEntity`: that model's `type` is a KIND ("view", "workspace"), and an owner is
    not a kind. Drafts are overwhelmingly named "Untitled draft", so the name alone identifies
    nothing — the OWNER is the load-bearing field here.
    """

    id: str
    name: str
    owner: str = ""                            # resolved to a human name by the repository layer


class VersioningImpact(BaseModel):
    """What deleting a data source destroys in its VERSIONED graph — and what it does not.

    The second half matters as much as the first. A data source is usually pinned to the
    customer's own FalkorDB graph (`nexus_lineage`), and a user about to delete something is
    entitled to know, before they click, that their actual graph data is not going anywhere.
    A confirmation that only lists horrors teaches people to click through it.
    """

    versioned: bool = False
    commits: int = 0
    openDrafts: List[DraftImpact] = []         # WHO has work in flight — the forgotten casualty
    openReviews: int = 0
    curatedEntities: int = 0                   # entities a HUMAN edited: the irreplaceable part
    storageBytes: int = 0

    # ── the reassurance ──
    falkorGraphName: Optional[str] = None
    falkorGraphOwned: bool = False             # False -> "your graph data will NOT be touched"

    # NOTE: there is deliberately no `gracePeriodDays` here. It was, and then it was a lie: the
    # delete path is a hard DELETE with no restore, so a dialog promising a 30-day undo would have
    # been promising something the backend cannot honour. The tombstone on `graphs.deleted_at`
    # exists to hide a graph WHILE ITS PURGE RUNS, not to offer an undo window. If we ever want a
    # real one it needs the data-source row soft-deleted too — until then we say "cannot be
    # undone", and we mean it.

    class Config:
        populate_by_name = True


class DeletedDataSource(BaseModel):
    """A data source in the trash, and whether it can still be brought back."""

    id: str
    label: str
    deletedAt: Optional[str] = None
    deletedBy: str = "someone"
    daysLeft: int = 0
    restoreWindowDays: int = 30
    # A purge has been queued: it is being dismantled and there is nothing left to restore.
    purging: bool = False
    restorable: bool = True

    class Config:
        populate_by_name = True


class WorkspaceDataSourceImpactResponse(BaseModel):
    """Blast-radius report when removing a Data Source from a Workspace."""
    views: List[ImpactedEntity] = []
    versioning: Optional[VersioningImpact] = None
    # How long the delete can be undone for. The dialog's whole register depends on this: a
    # reversible action does not deserve the same friction as an irreversible one.
    restoreWindowDays: int = 30


class DataSourceMoveRequest(BaseModel):
    """Re-home a data source into another workspace."""

    target_workspace_id: str = Field(alias="targetWorkspaceId")

    class Config:
        populate_by_name = True


class WorkspaceImpactResponse(BaseModel):
    """Blast-radius report for DELETING a whole workspace.

    Deleting a workspace is not a soft delete of a container — the FK from
    ``views.workspace_id`` is ON DELETE CASCADE, so every view inside it is
    HARD-deleted (it never reaches the soft-delete/restore path that the
    Explorer's own delete uses). Data sources, workspace-scoped role bindings
    and workspace-scoped custom roles go with it. The UI must be able to say all
    of that BEFORE the click, not after.
    """
    views: List[ImpactedEntity] = []
    data_sources: List[ImpactedEntity] = Field(default_factory=list, alias="dataSources")
    member_count: int = Field(0, alias="memberCount")
    custom_role_count: int = Field(0, alias="customRoleCount")
    #: Entities held by the workspace's graphs — the data itself is NOT deleted
    #: from the provider, and the dialog says so rather than implying it is.
    node_count: int = Field(0, alias="nodeCount")

    class Config:
        populate_by_name = True


# ─── Physical asset stats ──────────────────────────────────────────────────────

class PhysicalGraphStatsResponse(BaseModel):
    """Raw node/edge counts and type breakdowns for a physical graph/database."""
    nodeCount: int = 0
    edgeCount: int = 0
    entityTypeCounts: Dict[str, int] = {}
    edgeTypeCounts: Dict[str, int] = {}


# ============================================
# Announcement Models (global banners)
# ============================================

class AnnouncementCreateRequest(BaseModel):
    title: str
    message: str
    banner_type: str = Field(default="info", alias="bannerType")
    is_active: bool = Field(default=True, alias="isActive")
    snooze_duration_minutes: int = Field(default=0, alias="snoozeDurationMinutes")  # 0 = no snooze
    cta_text: Optional[str] = Field(None, alias="ctaText")
    cta_url: Optional[str] = Field(None, alias="ctaUrl")

    class Config:
        populate_by_name = True


class AnnouncementUpdateRequest(BaseModel):
    title: Optional[str] = None
    message: Optional[str] = None
    banner_type: Optional[str] = Field(None, alias="bannerType")
    is_active: Optional[bool] = Field(None, alias="isActive")
    snooze_duration_minutes: Optional[int] = Field(None, alias="snoozeDurationMinutes")
    cta_text: Optional[str] = Field(None, alias="ctaText")
    cta_url: Optional[str] = Field(None, alias="ctaUrl")

    class Config:
        populate_by_name = True


class AnnouncementResponse(BaseModel):
    id: str
    title: str
    message: str
    banner_type: str = Field(alias="bannerType")
    is_active: bool = Field(alias="isActive")
    snooze_duration_minutes: int = Field(0, alias="snoozeDurationMinutes")
    cta_text: Optional[str] = Field(None, alias="ctaText")
    cta_url: Optional[str] = Field(None, alias="ctaUrl")
    created_by: Optional[str] = Field(None, alias="createdBy")
    updated_by: Optional[str] = Field(None, alias="updatedBy")
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")

    class Config:
        populate_by_name = True


class AnnouncementConfigUpdateRequest(BaseModel):
    poll_interval_seconds: Optional[int] = Field(None, alias="pollIntervalSeconds")
    default_snooze_minutes: Optional[int] = Field(None, alias="defaultSnoozeMinutes")

    class Config:
        populate_by_name = True


class AnnouncementConfigResponse(BaseModel):
    poll_interval_seconds: int = Field(15, alias="pollIntervalSeconds")
    default_snooze_minutes: int = Field(30, alias="defaultSnoozeMinutes")
    updated_by: Optional[str] = Field(None, alias="updatedBy")
    updated_at: Optional[str] = Field(None, alias="updatedAt")

    class Config:
        populate_by_name = True


class AssetListResponse(BaseModel):
    """List of raw asset identifiers (graph names, database names, topics…) on a provider."""
    assets: List[str] = []


# ─── Enterprise Catalog models ─────────────────────────────────────────────────

class CatalogItemCreateRequest(BaseModel):
    provider_id: str = Field(alias="providerId")
    source_identifier: Optional[str] = Field(None, alias="sourceIdentifier")
    name: str
    description: Optional[str] = None
    permitted_workspaces: List[str] = Field(default_factory=lambda: ["*"], alias="permittedWorkspaces")

    class Config:
        populate_by_name = True


class CatalogItemUpdateRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    permitted_workspaces: Optional[List[str]] = Field(None, alias="permittedWorkspaces")

    class Config:
        populate_by_name = True


class CatalogItemResponse(BaseModel):
    id: str
    provider_id: str = Field(alias="providerId")
    source_identifier: Optional[str] = Field(None, alias="sourceIdentifier")
    name: str
    description: Optional[str] = None
    permitted_workspaces: List[str] = Field(default_factory=lambda: ["*"], alias="permittedWorkspaces")
    status: str = "active"
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")

    class Config:
        populate_by_name = True
