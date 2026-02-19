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
    ontology_config = relationship(
        "OntologyConfigORM", back_populates="connection",
        uselist=False, cascade="all, delete-orphan",
    )
    assignment_rule_sets = relationship(
        "AssignmentRuleSetORM", back_populates="connection",
        cascade="all, delete-orphan",
    )
    saved_views = relationship(
        "SavedViewORM", back_populates="connection",
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
# ontology_configs                                                      #
# ------------------------------------------------------------------ #

class OntologyConfigORM(Base):
    __tablename__ = "ontology_configs"

    id = Column(Text, primary_key=True, default=lambda: f"ont_{uuid.uuid4().hex[:12]}")
    connection_id = Column(
        Text,
        ForeignKey("graph_connections.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    containment_edge_types = Column(Text, nullable=False, default="[]")   # JSON
    lineage_edge_types = Column(Text, nullable=False, default="[]")       # JSON
    edge_type_metadata = Column(Text, nullable=False, default="{}")       # JSON
    entity_type_hierarchy = Column(Text, nullable=False, default="{}")    # JSON
    root_entity_types = Column(Text, nullable=False, default="[]")        # JSON
    override_mode = Column(Text, nullable=False, default="merge")         # merge | replace
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)
    updated_by = Column(Text, nullable=True)

    connection = relationship("GraphConnectionORM", back_populates="ontology_config")

    def __repr__(self) -> str:
        return f"<OntologyConfig conn={self.connection_id!r} mode={self.override_mode!r}>"


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
    )

    def __repr__(self) -> str:
        return f"<AssignmentRuleSet id={self.id!r} name={self.name!r}>"


# ------------------------------------------------------------------ #
# saved_views                                                           #
# ------------------------------------------------------------------ #

class SavedViewORM(Base):
    __tablename__ = "saved_views"

    id = Column(Text, primary_key=True, default=lambda: f"view_{uuid.uuid4().hex[:12]}")
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
    name = Column(Text, nullable=False)
    description = Column(Text, nullable=True)
    view_type = Column(Text, nullable=False, default="canvas")  # canvas | reference_model | scope
    config = Column(Text, nullable=False, default="{}")         # JSON
    scope_filter = Column(Text, nullable=True)                  # JSON
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    connection = relationship("GraphConnectionORM", back_populates="saved_views")
    workspace = relationship(
        "WorkspaceORM", back_populates="saved_views",
        foreign_keys=[workspace_id],
    )

    __table_args__ = (
        Index("idx_views_connection", "connection_id"),
        Index("idx_views_workspace", "workspace_id"),
    )

    def __repr__(self) -> str:
        return f"<SavedView id={self.id!r} name={self.name!r} type={self.view_type!r}>"


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
    extra_config = Column(Text, nullable=True)        # JSON blob
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    # Relationships
    workspaces = relationship(
        "WorkspaceORM", back_populates="provider",
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        Index("idx_providers_type", "provider_type"),
    )

    def __repr__(self) -> str:
        return f"<Provider id={self.id!r} name={self.name!r} type={self.provider_type!r}>"


# ------------------------------------------------------------------ #
# ontology_blueprints  (standalone, versioned, reusable)               #
# ------------------------------------------------------------------ #

class OntologyBlueprintORM(Base):
    __tablename__ = "ontology_blueprints"

    id = Column(Text, primary_key=True, default=lambda: f"bp_{uuid.uuid4().hex[:12]}")
    name = Column(Text, nullable=False)
    version = Column(Integer, nullable=False, default=1)
    containment_edge_types = Column(Text, nullable=False, default="[]")   # JSON
    lineage_edge_types = Column(Text, nullable=False, default="[]")       # JSON
    edge_type_metadata = Column(Text, nullable=False, default="{}")       # JSON
    entity_type_hierarchy = Column(Text, nullable=False, default="{}")    # JSON
    root_entity_types = Column(Text, nullable=False, default="[]")        # JSON
    visual_overrides = Column(Text, nullable=False, default="{}")         # JSON
    is_published = Column(Boolean, nullable=False, default=False)
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    # Relationships
    workspaces = relationship(
        "WorkspaceORM", back_populates="blueprint",
    )

    __table_args__ = (
        Index("idx_blueprints_name_version", "name", "version"),
    )

    def __repr__(self) -> str:
        return f"<OntologyBlueprint id={self.id!r} name={self.name!r} v{self.version}>"


# ------------------------------------------------------------------ #
# workspaces  (binding: provider + graph_name + blueprint)             #
# ------------------------------------------------------------------ #

class WorkspaceORM(Base):
    __tablename__ = "workspaces"

    id = Column(Text, primary_key=True, default=lambda: f"ws_{uuid.uuid4().hex[:12]}")
    name = Column(Text, nullable=False)
    description = Column(Text, nullable=True)
    provider_id = Column(
        Text,
        ForeignKey("providers.id", ondelete="CASCADE"),
        nullable=False,
    )
    graph_name = Column(Text, nullable=True)
    blueprint_id = Column(
        Text,
        ForeignKey("ontology_blueprints.id", ondelete="SET NULL"),
        nullable=True,
    )
    is_default = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    # Relationships
    provider = relationship("ProviderORM", back_populates="workspaces")
    blueprint = relationship("OntologyBlueprintORM", back_populates="workspaces")
    saved_views = relationship(
        "SavedViewORM", back_populates="workspace",
        foreign_keys="SavedViewORM.workspace_id",
    )
    assignment_rule_sets = relationship(
        "AssignmentRuleSetORM", back_populates="workspace",
        foreign_keys="AssignmentRuleSetORM.workspace_id",
    )

    __table_args__ = (
        Index("idx_workspaces_provider", "provider_id"),
        Index("idx_workspaces_is_default", "is_default"),
    )

    def __repr__(self) -> str:
        return f"<Workspace id={self.id!r} name={self.name!r} graph={self.graph_name!r}>"
