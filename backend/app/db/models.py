"""
SQLAlchemy ORM models for the management database.
All primary keys are text UUIDs. JSON columns stored as TEXT for SQLite compat.
"""
import uuid
from datetime import datetime, timezone
from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship

from .engine import Base


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _uuid() -> str:
    return f"conn_{uuid.uuid4().hex[:12]}"


# ------------------------------------------------------------------ #
# graph_connections                                                     #
# ------------------------------------------------------------------ #

class GraphConnectionORM(Base):
    __tablename__ = "graph_connections"

    id = Column(Text, primary_key=True, default=_uuid)
    name = Column(Text, nullable=False)
    provider_type = Column(Text, nullable=False)      # falkordb | neo4j | datahub | mock
    host = Column(Text, nullable=True)
    port = Column(Integer, nullable=True)
    graph_name = Column(Text, nullable=True)
    credentials = Column(Text, nullable=True)         # Fernet-encrypted JSON blob
    tls_enabled = Column(Boolean, nullable=False, default=False)
    is_primary = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True)
    extra_config = Column(Text, nullable=True)        # JSON blob
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    # Relationships
    assignment_rule_sets = relationship(
        "AssignmentRuleSetORM", back_populates="connection",
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        # Only one row may have is_primary=True (partial unique index).
        # SQLite doesn't support partial indexes in SQLAlchemy easily;
        # we enforce uniqueness at the application layer in the repository.
        Index("idx_connections_provider_type", "provider_type"),
        Index("idx_connections_is_primary", "is_primary"),
    )

    def __repr__(self) -> str:
        return f"<GraphConnection id={self.id!r} name={self.name!r} type={self.provider_type!r}>"


# ------------------------------------------------------------------ #
# assignment_rule_sets                                                  #
# ------------------------------------------------------------------ #

class AssignmentRuleSetORM(Base):
    __tablename__ = "assignment_rule_sets"

    id = Column(Text, primary_key=True, default=lambda: f"rs_{uuid.uuid4().hex[:12]}")
    connection_id = Column(
        Text,
        ForeignKey("graph_connections.id", ondelete="CASCADE"),
        nullable=True,  # nullable during migration
    )
    workspace_id = Column(
        Text,
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=True,  # nullable during migration
    )
    data_source_id = Column(
        Text,
        ForeignKey("workspace_data_sources.id", ondelete="SET NULL"),
        nullable=True,
    )
    name = Column(Text, nullable=False)
    description = Column(Text, nullable=True)
    is_default = Column(Boolean, nullable=False, default=False)
    layers_config = Column(Text, nullable=False, default="[]")  # JSON
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    connection = relationship("GraphConnectionORM", back_populates="assignment_rule_sets")
    workspace = relationship(
        "WorkspaceORM", back_populates="assignment_rule_sets",
        foreign_keys=[workspace_id],
    )

    __table_args__ = (
        Index("idx_rule_sets_connection", "connection_id"),
        Index("idx_rule_sets_workspace", "workspace_id"),
        Index("idx_rule_sets_data_source", "data_source_id"),
    )

    def __repr__(self) -> str:
        return f"<AssignmentRuleSet id={self.id!r} name={self.name!r}>"


# ------------------------------------------------------------------ #
# view_favourites                                                      #
# ------------------------------------------------------------------ #

class ViewFavouriteORM(Base):
    __tablename__ = "view_favourites"

    id = Column(Text, primary_key=True, default=lambda: f"fav_{uuid.uuid4().hex[:12]}")
    view_id = Column(
        Text,
        ForeignKey("views.id", ondelete="CASCADE"),
        nullable=False,
    )
    user_id = Column(Text, nullable=False)
    created_at = Column(Text, nullable=False, default=_now)

    view = relationship("ViewORM", back_populates="favourites")

    __table_args__ = (
        UniqueConstraint("view_id", "user_id", name="uq_view_user_favourite"),
        Index("idx_favourites_user", "user_id"),
        Index("idx_favourites_view", "view_id"),
    )

    def __repr__(self) -> str:
        return f"<ViewFavourite view={self.view_id!r} user={self.user_id!r}>"


# ------------------------------------------------------------------ #
# management_db_config  (single-row config table)                      #
# ------------------------------------------------------------------ #

class ManagementDbConfigORM(Base):
    __tablename__ = "management_db_config"

    id = Column(Integer, primary_key=True, default=1)
    storage_backend = Column(Text, nullable=False, default="sqlite")
    falkordb_conn_id = Column(
        Text,
        ForeignKey("graph_connections.id", ondelete="SET NULL"),
        nullable=True,
    )
    falkordb_graph_name = Column(Text, nullable=True)
    postgres_url = Column(Text, nullable=True)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    __table_args__ = (
        CheckConstraint("id = 1", name="single_row_constraint"),
    )


# ------------------------------------------------------------------ #
# feature_categories  (definitions: id, label, icon, color, order)     #
# ------------------------------------------------------------------ #

class FeatureCategoryORM(Base):
    __tablename__ = "feature_categories"

    id = Column(Text, primary_key=True)
    label = Column(Text, nullable=False)
    icon = Column(Text, nullable=False)
    color = Column(Text, nullable=False)
    sort_order = Column(Integer, nullable=False, default=0)
    preview = Column(Boolean, nullable=False, default=True)  # show "not yet wired" badge and footer when True
    preview_label = Column(Text, nullable=True)  # e.g. "Not yet wired"
    preview_footer = Column(Text, nullable=True)  # footer text when preview=True


# ------------------------------------------------------------------ #
# feature_definitions  (definitions: key, name, type, default, etc.) #
# ------------------------------------------------------------------ #

class FeatureDefinitionORM(Base):
    __tablename__ = "feature_definitions"

    key = Column(Text, primary_key=True)
    name = Column(Text, nullable=False)
    description = Column(Text, nullable=False)
    category_id = Column(Text, nullable=False)  # references feature_categories.id
    type = Column(Text, nullable=False)  # "boolean" | "string[]"
    default_value = Column(Text, nullable=False)  # JSON: true | false | ["graph",...]
    user_overridable = Column(Boolean, nullable=False, default=False)
    options = Column(Text, nullable=True)  # JSON: [{"id","label"},...] for string[]
    help_url = Column(Text, nullable=True)
    admin_hint = Column(Text, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)
    deprecated = Column(Boolean, nullable=False, default=False)
    implemented = Column(Boolean, nullable=False, default=False)  # when True, feature is "wired" (no preview badge)


# ------------------------------------------------------------------ #
# feature_registry_meta  (single-row: Admin Features UI copy)         #
# ------------------------------------------------------------------ #

class FeatureRegistryMetaORM(Base):
    __tablename__ = "feature_registry_meta"

    id = Column(Integer, primary_key=True, default=1)
    experimental_notice_enabled = Column(Boolean, nullable=False, default=True)
    experimental_notice_title = Column(Text, nullable=True)
    experimental_notice_message = Column(Text, nullable=True)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    __table_args__ = (
        CheckConstraint("id = 1", name="feature_registry_meta_single_row"),
    )


# ------------------------------------------------------------------ #
# feature_flags  (single-row config: global feature flag values)     #
# ------------------------------------------------------------------ #

class FeatureFlagsORM(Base):
    __tablename__ = "feature_flags"

    id = Column(Integer, primary_key=True, default=1)
    config = Column(Text, nullable=False, default="{}")  # JSON: { "editModeEnabled": true, ... }
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)
    version = Column(Integer, nullable=False, default=0)  # optimistic concurrency; incremented on every write

    __table_args__ = (
        CheckConstraint("id = 1", name="feature_flags_single_row"),
    )


# ------------------------------------------------------------------ #
# providers  (workspace-centric: pure infrastructure)                  #
# ------------------------------------------------------------------ #

class ProviderORM(Base):
    __tablename__ = "providers"

    id = Column(Text, primary_key=True, default=lambda: f"prov_{uuid.uuid4().hex[:12]}")
    name = Column(Text, nullable=False)
    provider_type = Column(Text, nullable=False)      # falkordb | neo4j | datahub | mock
    host = Column(Text, nullable=True)
    port = Column(Integer, nullable=True)
    credentials = Column(Text, nullable=True)         # Fernet-encrypted JSON blob
    tls_enabled = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True)
    permitted_workspaces = Column(Text, nullable=False, default='["*"]')  # JSON list; "*" = all
    extra_config = Column(Text, nullable=True)        # JSON blob
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    # Relationships
    data_sources = relationship(
        "WorkspaceDataSourceORM", back_populates="provider",
        cascade="all, delete-orphan",
    )
    catalog_items = relationship(
        "CatalogItemORM", back_populates="provider",
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        Index("idx_providers_type", "provider_type"),
    )

    def __repr__(self) -> str:
        return f"<Provider id={self.id!r} name={self.name!r} type={self.provider_type!r}>"


# ------------------------------------------------------------------ #
# ontologies  (standalone, versioned, reusable semantic definitions)   #
# ------------------------------------------------------------------ #

class OntologyORM(Base):
    __tablename__ = "ontologies"

    id = Column(Text, primary_key=True, default=lambda: f"bp_{uuid.uuid4().hex[:12]}")
    name = Column(Text, nullable=False)
    description = Column(Text, nullable=True, default=None)
    version = Column(Integer, nullable=False, default=1)
    # Legacy flat edge type lists (kept for backward compat; derived from definitions when present)
    containment_edge_types = Column(Text, nullable=False, default="[]")   # JSON
    lineage_edge_types = Column(Text, nullable=False, default="[]")       # JSON
    edge_type_metadata = Column(Text, nullable=False, default="{}")       # JSON
    entity_type_hierarchy = Column(Text, nullable=False, default="{}")    # JSON
    root_entity_types = Column(Text, nullable=False, default="[]")        # JSON
    # Rich definition columns (Phase 1+): nested dicts keyed by type ID
    entity_type_definitions = Column(Text, nullable=False, default="{}")  # JSON Dict[str, EntityTypeDefEntry]
    relationship_type_definitions = Column(Text, nullable=False, default="{}")  # JSON Dict[str, RelTypeDefEntry]
    # Ontology metadata
    is_published = Column(Boolean, nullable=False, default=False)
    is_system = Column(Boolean, nullable=False, default=False)
    scope = Column(Text, nullable=False, default="universal")             # universal | workspace
    # Schema evolution policy applied when a newer version of this ontology is published.
    # reject   — do not allow changes that would break existing data (safest).
    # deprecate — mark removed types as deprecated; continue to serve them.
    # migrate  — automatically rename/remap types per a migration manifest.
    evolution_policy = Column(Text, nullable=False, default="reject")   # reject | deprecate | migrate
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    # Relationships
    data_sources = relationship(
        "WorkspaceDataSourceORM", back_populates="ontology",
    )

    __table_args__ = (
        Index("idx_ontologies_name_version", "name", "version"),
        Index("idx_ontologies_is_system", "is_system"),
    )

    def __repr__(self) -> str:
        return f"<Ontology id={self.id!r} name={self.name!r} v{self.version}>"


# ------------------------------------------------------------------ #
# ontology_source_mappings — per-source type mapping profiles          #
# ------------------------------------------------------------------ #

class OntologySourceMappingORM(Base):
    """
    Maps external provider type labels to Synodic ontology type IDs.

    When a DataHub asset arrives with type "DATASET" from platform "snowflake",
    the mapping profile for that data source translates it to the Synodic
    entity type "dataset" before writing to the graph.

    One row per (data_source_id, external_type) pair.
    entity_type_mappings and relationship_type_mappings are JSON dicts:
      { "<external_label>": "<synodic_type_id>", … }
    """
    __tablename__ = "ontology_source_mappings"

    id = Column(Text, primary_key=True, default=lambda: f"osm_{uuid.uuid4().hex[:12]}")
    data_source_id = Column(Text, nullable=False, index=True)
    ontology_id = Column(Text, nullable=True)                        # optional pinned ontology
    # JSON dict: external entity type label → Synodic entity type id
    entity_type_mappings = Column(Text, nullable=False, default="{}")
    # JSON dict: external relationship type label → Synodic relationship type id
    relationship_type_mappings = Column(Text, nullable=False, default="{}")
    # EXTENSION POINT: add conditional aliasing/ignore rules when DataHub/OpenMetadata
    # ingestion needs source-context-aware mappings beyond simple label->type maps.
    # Snapshot of the last-seen external schema (for drift detection)
    last_seen_schema_hash = Column(Text, nullable=True)
    last_seen_at = Column(Text, nullable=True)
    # Whether the last drift check found unmapped types
    has_drift = Column(Boolean, nullable=False, default=False)
    drift_details = Column(Text, nullable=True)                      # JSON list of issues
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    __table_args__ = (
        Index("idx_osm_data_source", "data_source_id"),
    )

    def __repr__(self) -> str:
        return f"<OntologySourceMapping ds={self.data_source_id!r}>"


# ------------------------------------------------------------------ #
# workspaces  (operational context — a team's "project")               #
# ------------------------------------------------------------------ #

class WorkspaceORM(Base):
    __tablename__ = "workspaces"

    id = Column(Text, primary_key=True, default=lambda: f"ws_{uuid.uuid4().hex[:12]}")
    name = Column(Text, nullable=False)
    description = Column(Text, nullable=True)
    is_default = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    # Relationships
    data_sources = relationship(
        "WorkspaceDataSourceORM", back_populates="workspace",
        cascade="all, delete-orphan",
    )
    assignment_rule_sets = relationship(
        "AssignmentRuleSetORM", back_populates="workspace",
        foreign_keys="AssignmentRuleSetORM.workspace_id",
    )

    __table_args__ = (
        Index("idx_workspaces_is_default", "is_default"),
    )

    def __repr__(self) -> str:
        return f"<Workspace id={self.id!r} name={self.name!r}>"


# ------------------------------------------------------------------ #
# workspace_data_sources  (binds provider + graph + assigned ontology)  #
# ------------------------------------------------------------------ #

class WorkspaceDataSourceORM(Base):
    __tablename__ = "workspace_data_sources"

    id = Column(Text, primary_key=True, default=lambda: f"ds_{uuid.uuid4().hex[:12]}")
    workspace_id = Column(
        Text,
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
    )
    provider_id = Column(
        Text,
        ForeignKey("providers.id", ondelete="CASCADE"),
        nullable=False,
    )
    graph_name = Column(Text, nullable=True)
    catalog_item_id = Column(
        Text,
        ForeignKey("catalog_items.id", ondelete="SET NULL"),
        nullable=True,
    )
    ontology_id = Column(
        Text,
        ForeignKey("ontologies.id", ondelete="SET NULL"),
        nullable=True,
    )
    label = Column(Text, nullable=True)
    is_primary = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True)
    projection_mode = Column(Text, nullable=True)  # None = inherit from provider, "in_source" | "dedicated"
    dedicated_graph_name = Column(Text, nullable=True)  # graph name when projection_mode == "dedicated"
    access_level = Column(Text, nullable=True, default="read")  # read | write | admin
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    # Relationships
    workspace = relationship("WorkspaceORM", back_populates="data_sources")
    provider = relationship("ProviderORM", back_populates="data_sources")
    catalog_item = relationship("CatalogItemORM")
    ontology = relationship("OntologyORM", back_populates="data_sources")
    # EXTENSION POINT: add ontology_version_strategy (pinned|floating) and
    # ontology_enforcement (permissive|strict) when multi-source governance
    # requires per-data-source resolution policies.
    stats = relationship("DataSourceStatsORM", back_populates="data_source", uselist=False, cascade="all, delete-orphan")
    polling_config = relationship("DataSourcePollingConfigORM", back_populates="data_source", uselist=False, cascade="all, delete-orphan")

    __table_args__ = (
        UniqueConstraint("workspace_id", "provider_id", "graph_name", name="uq_ds_ws_prov_graph"),
        Index("idx_ds_workspace", "workspace_id"),
        Index("idx_ds_provider", "provider_id"),
        Index("idx_ds_catalog_item", "catalog_item_id"),
    )


# ------------------------------------------------------------------ #
# context_models  (how to visualize/organize the graph)               #
# ------------------------------------------------------------------ #

class ContextModelORM(Base):
    __tablename__ = "context_models"

    id = Column(Text, primary_key=True, default=lambda: f"cm_{uuid.uuid4().hex[:12]}")
    name = Column(Text, nullable=False)
    description = Column(Text, nullable=True)
    workspace_id = Column(
        Text,
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=True,  # null = global template
    )
    data_source_id = Column(
        Text,
        ForeignKey("workspace_data_sources.id", ondelete="SET NULL"),
        nullable=True,
    )
    is_template = Column(Boolean, nullable=False, default=False)
    category = Column(Text, nullable=True)                           # e.g. "data-engineering"
    layers_config = Column(Text, nullable=False, default="[]")       # JSON: ViewLayerConfig[]
    scope_filter = Column(Text, nullable=True)                       # JSON: ScopeFilterConfig
    instance_assignments = Column(Text, nullable=False, default="{}") # JSON: entityId→assignment
    scope_edge_config = Column(Text, nullable=True)                  # JSON: ScopeEdgeConfig
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    # Relationships
    workspace = relationship(
        "WorkspaceORM",
        foreign_keys=[workspace_id],
    )

    __table_args__ = (
        Index("idx_cm_workspace", "workspace_id"),
        Index("idx_cm_template", "is_template"),
    )


# ------------------------------------------------------------------ #
# views (Visual rendering of context models)                           #
# ------------------------------------------------------------------ #

class ViewORM(Base):
    __tablename__ = "views"

    id = Column(Text, primary_key=True, default=lambda: f"view_{uuid.uuid4().hex[:12]}")
    name = Column(Text, nullable=False)
    description = Column(Text, nullable=True)
    context_model_id = Column(
        Text,
        ForeignKey("context_models.id", ondelete="SET NULL"),
        nullable=True,
    )
    workspace_id = Column(
        Text,
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
    )
    data_source_id = Column(
        Text,
        ForeignKey("workspace_data_sources.id", ondelete="SET NULL"),
        nullable=True,
    )
    view_type = Column(Text, nullable=False, default="graph")
    config = Column(Text, nullable=False, default="{}")       # JSON: full ViewConfiguration
    # EXTENSION POINT: persist referenced_entity_types / referenced_relationship_types
    # for view-ontology compatibility checks once real breakage workflows appear.
    visibility = Column(Text, nullable=False, default="private")
    created_by = Column(Text, nullable=True)
    tags = Column(Text, nullable=True)                        # JSON array
    is_pinned = Column(Boolean, nullable=False, default=False)
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    # Relationships
    context_model = relationship("ContextModelORM", backref="views")
    workspace = relationship("WorkspaceORM", foreign_keys=[workspace_id])
    favourites = relationship("ViewFavouriteORM", back_populates="view", cascade="all, delete-orphan")

    __table_args__ = (
        Index("idx_view_workspace", "workspace_id"),
        Index("idx_view_context_model", "context_model_id"),
        Index("idx_view_visibility", "visibility"),
        Index("idx_view_data_source", "data_source_id"),
    )

    def __repr__(self) -> str:
        return f"<View id={self.id!r} name={self.name!r} type={self.view_type!r}>"


# ------------------------------------------------------------------ #
# data_source_stats (Graph Statistics Cache)                           #
# ------------------------------------------------------------------ #

class DataSourceStatsORM(Base):
    __tablename__ = "data_source_stats"

    data_source_id = Column(
        Text,
        ForeignKey("workspace_data_sources.id", ondelete="CASCADE"),
        primary_key=True,
    )
    node_count = Column(Integer, nullable=False, default=0)
    edge_count = Column(Integer, nullable=False, default=0)
    entity_type_counts = Column(Text, nullable=False, default="{}")  # JSON
    edge_type_counts = Column(Text, nullable=False, default="{}")    # JSON
    schema_stats = Column(Text, nullable=False, default="{}")        # JSON
    ontology_metadata = Column(Text, nullable=False, default="{}")   # JSON
    graph_schema = Column(Text, nullable=False, default="{}")        # JSON
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    # Relationships
    data_source = relationship("WorkspaceDataSourceORM", back_populates="stats")

    def __repr__(self) -> str:
        return f"<DataSourceStats ds_id={self.data_source_id!r}>"


# ------------------------------------------------------------------ #
# data_source_polling_configs (Microservice orchestration)             #
# ------------------------------------------------------------------ #

class DataSourcePollingConfigORM(Base):
    __tablename__ = "data_source_polling_configs"

    data_source_id = Column(
        Text,
        ForeignKey("workspace_data_sources.id", ondelete="CASCADE"),
        primary_key=True,
    )
    is_enabled = Column(Boolean, nullable=False, default=True)
    interval_seconds = Column(Integer, nullable=False, default=300)
    last_polled_at = Column(Text, nullable=True)                     # ISO string
    last_status = Column(Text, nullable=False, default="pending")    # pending | success | error 
    last_error = Column(Text, nullable=True)

    # Relationships
    data_source = relationship("WorkspaceDataSourceORM", back_populates="polling_config")

    def __repr__(self) -> str:
        return f"<DataSourcePollingConfig ds_id={self.data_source_id!r} enabled={self.is_enabled}>"


# ------------------------------------------------------------------ #
# catalog_items  (enterprise data asset catalog)                       #
# ------------------------------------------------------------------ #

class CatalogItemORM(Base):
    """
    Maps a named physical asset (e.g. a graph within a FalkorDB provider)
    to a managed, permission-controlled catalog entry.
    Workspaces consume catalog items instead of talking directly to providers.
    """
    __tablename__ = "catalog_items"

    id = Column(Text, primary_key=True, default=lambda: f"cat_{uuid.uuid4().hex[:12]}")
    provider_id = Column(
        Text,
        ForeignKey("providers.id", ondelete="CASCADE"),
        nullable=False,
    )
    source_identifier = Column(Text, nullable=True)  # e.g. the graph name on the provider
    name = Column(Text, nullable=False)
    description = Column(Text, nullable=True)
    permitted_workspaces = Column(Text, nullable=False, default='["*"]')  # JSON list; "*" = all
    status = Column(Text, nullable=False, default="active")  # active | archived | deprecated
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    # Relationships
    provider = relationship("ProviderORM", back_populates="catalog_items")

    __table_args__ = (
        Index("idx_catalog_provider", "provider_id"),
        Index("idx_catalog_status", "status"),
    )

    def __repr__(self) -> str:
        return f"<CatalogItem id={self.id!r} name={self.name!r} provider={self.provider_id!r}>"


# ------------------------------------------------------------------ #
# users  (authentication & identity)                                   #
# ------------------------------------------------------------------ #

class UserORM(Base):
    __tablename__ = "users"

    id = Column(Text, primary_key=True, default=lambda: f"usr_{uuid.uuid4().hex[:12]}")
    email = Column(Text, nullable=False)
    password_hash = Column(Text, nullable=False)
    first_name = Column(Text, nullable=False)
    last_name = Column(Text, nullable=False)
    status = Column(Text, nullable=False, default="pending")       # pending | active | suspended
    auth_provider = Column(Text, nullable=False, default="local")  # local | saml2 | oidc
    external_id = Column(Text, nullable=True)                      # SSO subject
    metadata_ = Column("metadata", Text, nullable=True, default="{}")  # JSON: SSO claims, prefs
    reset_token_hash = Column(Text, nullable=True)
    reset_token_expires_at = Column(Text, nullable=True)
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)
    deleted_at = Column(Text, nullable=True)                       # soft delete

    # Relationships
    roles = relationship("UserRoleORM", back_populates="user", cascade="all, delete-orphan")

    __table_args__ = (
        UniqueConstraint("email", name="uq_users_email"),
        Index("idx_users_status_created", "status", "created_at"),
    )

    def __repr__(self) -> str:
        return f"<User id={self.id!r} email={self.email!r} status={self.status!r}>"


# ------------------------------------------------------------------ #
# user_roles  (one row per user × role)                                #
# ------------------------------------------------------------------ #

class UserRoleORM(Base):
    __tablename__ = "user_roles"

    id = Column(Text, primary_key=True, default=lambda: f"urole_{uuid.uuid4().hex[:12]}")
    user_id = Column(Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    role_name = Column(Text, nullable=False, default="user")  # admin | user | viewer
    created_at = Column(Text, nullable=False, default=_now)

    user = relationship("UserORM", back_populates="roles")

    __table_args__ = (
        UniqueConstraint("user_id", "role_name", name="uq_user_role"),
        Index("idx_user_roles_user", "user_id"),
    )

    def __repr__(self) -> str:
        return f"<UserRole user={self.user_id!r} role={self.role_name!r}>"


# ------------------------------------------------------------------ #
# user_approvals  (audit trail for signup approval / rejection)        #
# ------------------------------------------------------------------ #

class UserApprovalORM(Base):
    __tablename__ = "user_approvals"

    id = Column(Text, primary_key=True, default=lambda: f"uapr_{uuid.uuid4().hex[:12]}")
    user_id = Column(Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    approved_by = Column(Text, nullable=True)                     # admin user_id (logical ref)
    status = Column(Text, nullable=False, default="pending")      # pending | approved | rejected
    rejection_reason = Column(Text, nullable=True)
    created_at = Column(Text, nullable=False, default=_now)
    resolved_at = Column(Text, nullable=True)

    __table_args__ = (
        Index("idx_user_approvals_user_status", "user_id", "status"),
    )

    def __repr__(self) -> str:
        return f"<UserApproval user={self.user_id!r} status={self.status!r}>"


# ------------------------------------------------------------------ #
# outbox_events  (transactional outbox for domain events)              #
# ------------------------------------------------------------------ #

class OutboxEventORM(Base):
    __tablename__ = "outbox_events"

    id = Column(Text, primary_key=True, default=lambda: f"evt_{uuid.uuid4().hex[:12]}")
    event_type = Column(Text, nullable=False)         # e.g. user.created, user.approved
    payload = Column(Text, nullable=False, default="{}")  # JSON
    processed = Column(Boolean, nullable=False, default=False)
    created_at = Column(Text, nullable=False, default=_now)

    __table_args__ = (
        Index("idx_outbox_processed_created", "processed", "created_at"),
    )

    def __repr__(self) -> str:
        return f"<OutboxEvent id={self.id!r} type={self.event_type!r}>"

