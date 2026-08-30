"""Provider catalog dataclasses.

``ProviderSpec`` normalises what both existing dispatch entry points accept
today (``ProviderManager._create_provider_instance`` /
``ProviderRegistry._create_provider_instance``). ``ProviderDescriptor``
describes one provider type's construction, capability, and connection-form
metadata as a single immutable record. See ``catalog/__init__.py`` for the
registry these are registered into.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Literal, Mapping, Optional, Tuple

from backend.common.interfaces.provider import GraphDataProvider, ProviderCapability


@dataclass(frozen=True)
class ProviderSpec:
    """Normalised constructor input -- the union of what both dispatchers
    accept today (``manager.py``'s ``_create_provider_instance`` /
    ``provider_registry.py``'s ``_create_provider_instance``)."""
    provider_type: str
    host: Optional[str]
    port: Optional[int]
    graph_name: Optional[str]
    tls_enabled: bool
    credentials: Mapping[str, Any]              # decrypted; {} when absent
    extra_config: Optional[Mapping[str, Any]]
    provider_id: Optional[str] = None


class ProviderRequestError(ValueError):
    """A create/test payload that is structurally wrong for this provider type.
    Endpoints map it to 422 {"type": "provider_config_invalid", …}."""


FieldKind = Literal["text", "number", "password", "textarea", "boolean"]
FieldLocation = Literal["column", "credentials", "extraConfig"]   # providers.host/port | encrypted blob | extra_config JSON


@dataclass(frozen=True)
class FieldSpec:
    key: str
    label: str
    kind: FieldKind
    location: FieldLocation
    required: bool = False
    secret: bool = False
    default: Any = None
    placeholder: Optional[str] = None
    help: Optional[str] = None


ShapeKind = Literal["generic", "falkordb", "spanner"]   # which frontend panel renders the connection step
AuthKind = Literal["basic", "token", "service_account", "none"]
ProbeStrategy = Literal["preflight", "full_connect"]


@dataclass(frozen=True)
class ConnectionShape:
    kind: ShapeKind
    uses_host_port: bool
    default_port: Optional[int]
    tls: Literal["flag", "none"]                 # "flag" = the tlsEnabled toggle is shown
    auth: AuthKind
    database_field: Optional[FieldSpec] = None   # generic shape: a provider-level default database (extraConfig)
    fields: Tuple[FieldSpec, ...] = ()            # informational for bespoke shapes; rendered for generic
    secret_credential_keys: Tuple[str, ...] = ()  # keys of ConnectionCredentials this type uses
    extra_config_keys: Tuple[str, ...] = ()       # FORM-OWNED extra_config keys (wizard rebuilds these)


ProviderFamily = Literal["cypher", "gql", "graphql", "native"]   # a LABEL only -- nothing branches on it


@dataclass(frozen=True)
class ProviderDescriptor:
    id: str
    label: str
    description: str
    docs_url: Optional[str]
    family: ProviderFamily                       # falkordb/neo4j "cypher", spanner "gql", datahub "graphql"
    capability: ProviderCapability
    connection: ConnectionShape
    build: Callable[[ProviderSpec], GraphDataProvider]
    provider_class_path: str                     # "backend.app.providers.falkordb_provider:FalkorDBProvider" (contract tests)
    validate: Callable[[Any], None] = lambda req: None             # raises ProviderRequestError
    probe_strategy: Callable[[Optional[Mapping[str, Any]]], ProbeStrategy] = lambda extra: "preflight"
    probe_deadline_s: Callable[[Optional[Mapping[str, Any]], float], float] = lambda extra, default: default
    admin_visible: bool = True
