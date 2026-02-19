"""
Pydantic models for the management database layer.
Covers: graph connections, ontology configs, assignment rule sets, saved views.
"""
from typing import List, Optional, Dict, Any, Literal
from pydantic import BaseModel, Field
from enum import Enum


class ProviderType(str, Enum):
    FALKORDB = "falkordb"
    NEO4J = "neo4j"
    DATAHUB = "datahub"
    MOCK = "mock"


# ============================================
# Connection Models
# ============================================

class ConnectionCredentials(BaseModel):
    username: Optional[str] = None
    password: Optional[str] = None
    token: Optional[str] = None

    class Config:
        populate_by_name = True


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
# Ontology Config Models
# ============================================

class OntologyConfigUpdate(BaseModel):
    containment_edge_types: Optional[List[str]] = Field(None, alias="containmentEdgeTypes")
    lineage_edge_types: Optional[List[str]] = Field(None, alias="lineageEdgeTypes")
    edge_type_metadata: Optional[Dict[str, Any]] = Field(None, alias="edgeTypeMetadata")
    entity_type_hierarchy: Optional[Dict[str, Any]] = Field(None, alias="entityTypeHierarchy")
    root_entity_types: Optional[List[str]] = Field(None, alias="rootEntityTypes")
    override_mode: Literal["merge", "replace"] = Field("merge", alias="overrideMode")

    class Config:
        populate_by_name = True


class OntologyConfigResponse(BaseModel):
    connection_id: str = Field(alias="connectionId")
    containment_edge_types: List[str] = Field(alias="containmentEdgeTypes")
    lineage_edge_types: List[str] = Field(alias="lineageEdgeTypes")
    edge_type_metadata: Dict[str, Any] = Field(alias="edgeTypeMetadata")
    entity_type_hierarchy: Dict[str, Any] = Field(alias="entityTypeHierarchy")
    root_entity_types: List[str] = Field(alias="rootEntityTypes")
    override_mode: str = Field(alias="overrideMode")
    updated_at: Optional[str] = Field(None, alias="updatedAt")
    source: str = "merged"  # 'merged' | 'db_only' | 'introspected_only'

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
# Saved View Models
# ============================================

class ViewType(str, Enum):
    CANVAS = "canvas"
    REFERENCE_MODEL = "reference_model"
    SCOPE = "scope"


class SavedViewCreateRequest(BaseModel):
    name: str
    description: Optional[str] = None
    view_type: ViewType = Field(ViewType.CANVAS, alias="viewType")
    config: Dict[str, Any] = Field(default_factory=dict)
    scope_filter: Optional[Dict[str, Any]] = Field(None, alias="scopeFilter")

    class Config:
        populate_by_name = True


class SavedViewResponse(BaseModel):
    id: str
    connection_id: str = Field(alias="connectionId")
    name: str
    description: Optional[str] = None
    view_type: ViewType = Field(alias="viewType")
    config: Dict[str, Any]
    scope_filter: Optional[Dict[str, Any]] = Field(None, alias="scopeFilter")
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

class ProviderCreateRequest(BaseModel):
    name: str
    provider_type: ProviderType = Field(alias="providerType")
    host: Optional[str] = None
    port: Optional[int] = None
    credentials: Optional[ConnectionCredentials] = None
    tls_enabled: bool = Field(False, alias="tlsEnabled")
    extra_config: Optional[Dict[str, Any]] = Field(None, alias="extraConfig")

    class Config:
        populate_by_name = True


class ProviderUpdateRequest(BaseModel):
    name: Optional[str] = None
    host: Optional[str] = None
    port: Optional[int] = None
    credentials: Optional[ConnectionCredentials] = None
    tls_enabled: Optional[bool] = Field(None, alias="tlsEnabled")
    is_active: Optional[bool] = Field(None, alias="isActive")
    extra_config: Optional[Dict[str, Any]] = Field(None, alias="extraConfig")

    class Config:
        populate_by_name = True


class ProviderResponse(BaseModel):
    id: str
    name: str
    provider_type: ProviderType = Field(alias="providerType")
    host: Optional[str] = None
    port: Optional[int] = None
    tls_enabled: bool = Field(alias="tlsEnabled")
    is_active: bool = Field(alias="isActive")
    extra_config: Optional[Dict[str, Any]] = Field(None, alias="extraConfig")
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")
    # credentials are NEVER returned

    class Config:
        populate_by_name = True


# ============================================
# Ontology Blueprint Models (workspace-centric)
# ============================================

class BlueprintCreateRequest(BaseModel):
    name: str
    containment_edge_types: List[str] = Field(default_factory=list, alias="containmentEdgeTypes")
    lineage_edge_types: List[str] = Field(default_factory=list, alias="lineageEdgeTypes")
    edge_type_metadata: Dict[str, Any] = Field(default_factory=dict, alias="edgeTypeMetadata")
    entity_type_hierarchy: Dict[str, Any] = Field(default_factory=dict, alias="entityTypeHierarchy")
    root_entity_types: List[str] = Field(default_factory=list, alias="rootEntityTypes")
    visual_overrides: Dict[str, Any] = Field(default_factory=dict, alias="visualOverrides")

    class Config:
        populate_by_name = True


class BlueprintUpdateRequest(BaseModel):
    name: Optional[str] = None
    containment_edge_types: Optional[List[str]] = Field(None, alias="containmentEdgeTypes")
    lineage_edge_types: Optional[List[str]] = Field(None, alias="lineageEdgeTypes")
    edge_type_metadata: Optional[Dict[str, Any]] = Field(None, alias="edgeTypeMetadata")
    entity_type_hierarchy: Optional[Dict[str, Any]] = Field(None, alias="entityTypeHierarchy")
    root_entity_types: Optional[List[str]] = Field(None, alias="rootEntityTypes")
    visual_overrides: Optional[Dict[str, Any]] = Field(None, alias="visualOverrides")

    class Config:
        populate_by_name = True


class BlueprintResponse(BaseModel):
    id: str
    name: str
    version: int
    containment_edge_types: List[str] = Field(alias="containmentEdgeTypes")
    lineage_edge_types: List[str] = Field(alias="lineageEdgeTypes")
    edge_type_metadata: Dict[str, Any] = Field(alias="edgeTypeMetadata")
    entity_type_hierarchy: Dict[str, Any] = Field(alias="entityTypeHierarchy")
    root_entity_types: List[str] = Field(alias="rootEntityTypes")
    visual_overrides: Dict[str, Any] = Field(default_factory=dict, alias="visualOverrides")
    is_published: bool = Field(alias="isPublished")
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")

    class Config:
        populate_by_name = True


# ============================================
# Data Source Models (workspace data sources)
# ============================================

class DataSourceCreateRequest(BaseModel):
    provider_id: str = Field(alias="providerId")
    graph_name: str = Field(alias="graphName")
    blueprint_id: Optional[str] = Field(None, alias="blueprintId")
    label: Optional[str] = None

    class Config:
        populate_by_name = True


class DataSourceUpdateRequest(BaseModel):
    provider_id: Optional[str] = Field(None, alias="providerId")
    graph_name: Optional[str] = Field(None, alias="graphName")
    blueprint_id: Optional[str] = Field(None, alias="blueprintId")
    label: Optional[str] = None
    is_active: Optional[bool] = Field(None, alias="isActive")

    class Config:
        populate_by_name = True


class DataSourceResponse(BaseModel):
    id: str
    workspace_id: str = Field(alias="workspaceId")
    provider_id: str = Field(alias="providerId")
    graph_name: Optional[str] = Field(None, alias="graphName")
    blueprint_id: Optional[str] = Field(None, alias="blueprintId")
    label: Optional[str] = None
    is_primary: bool = Field(alias="isPrimary")
    is_active: bool = Field(alias="isActive")
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
    def blueprint_id(self) -> Optional[str]:
        """Convenience: blueprint_id from primary data source (backward compat)."""
        ds = self.primary_data_source
        return ds.blueprint_id if ds else None
