"""
SQLAlchemy ORM models for the management database.
All primary keys are text UUIDs. JSON columns stored as TEXT for SQLite compat.
"""
import uuid
from datetime import datetime, timezone
from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    text,
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
        Index("idx_connections_provider_type", "provider_type"),
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

class ViewVisitORM(Base):
    """Per-user 'recently viewed' — the server-side source of truth for the
    Explorer's "Continue where you left off" strip.

    Replaces a browser-local localStorage list, which (a) didn't follow the user
    across devices/browsers, (b) wasn't user-scoped so a second user on a shared
    browser inherited the first user's recents, and (c) cached stale name
    snapshots that 404'd once a view was renamed/deleted. One row per
    (user, view) — the visit timestamp is upserted — and the FK CASCADE means a
    deleted view disappears from everyone's recents for free.
    """
    __tablename__ = "view_visits"

    id = Column(Text, primary_key=True, default=lambda: f"vis_{uuid.uuid4().hex[:12]}")
    view_id = Column(
        Text,
        ForeignKey("views.id", ondelete="CASCADE"),
        nullable=False,
    )
    user_id = Column(Text, nullable=False)
    visited_at = Column(Text, nullable=False, default=_now)

    __table_args__ = (
        UniqueConstraint("view_id", "user_id", name="uq_view_user_visit"),
        # The read is always "this user's visits, newest first".
        Index("idx_visits_user_time", "user_id", "visited_at"),
        Index("idx_visits_view", "view_id"),
    )

    def __repr__(self) -> str:
        return f"<ViewVisit user={self.user_id!r} view={self.view_id!r} at={self.visited_at!r}>"


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
    # RETIRED. Declared true on two flags, served to the frontend, and honoured by absolutely
    # nothing — the same decorative-field bug as `implemented`, in the same table. Nothing reads or
    # writes it now; the column stays only because dropping it is a migration with no payoff. Do not
    # revive it: per-user opt-outs on a deployment-wide governance switch is a different feature,
    # and it would need building, not un-commenting.
    user_overridable = Column(Boolean, nullable=False, default=False)
    options = Column(Text, nullable=True)  # JSON: [{"id","label"},...] for string[]
    help_url = Column(Text, nullable=True)
    admin_hint = Column(Text, nullable=True)
    # "What happens if I turn this off?" — the one question an admin must be able to answer
    # BEFORE flipping a switch that affects everybody. Seeded from app/config/features_seed.py
    # and editable from the admin UI, like the other prose columns.
    impact_when_off = Column(Text, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)
    deprecated = Column(Boolean, nullable=False, default=False)
    # DERIVED FROM CODE — reconciled from app/config/feature_wiring.py on every startup, and NOT
    # editable over the API. It records whether the flag is actually wired (a server gate and/or
    # a UI surface); an admin ticking a box cannot make a gate exist, and while they could, this
    # column claimed four features were in a state they were not.
    implemented = Column(Boolean, nullable=False, default=False)


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
# feature_flag_changes  (who turned it off, and when)                #
# ------------------------------------------------------------------ #

class FeatureFlagChangeORM(Base):
    """Every change to a feature flag, and who made it.

    The Features page could tell you a flag was off. It could not tell you WHO turned it off, WHEN,
    or what it was before — the config row carries a value and a version and nothing else. On a
    surface where several admins can each silently remove a capability from every user of the
    deployment, "someone did this at some point" is not an answer to the only question anyone asks
    when a user reports that something has stopped working.

    ``actor_name`` is DENORMALISED on purpose. A foreign key to ``users`` would either forbid
    deleting a user who once flipped a switch, or take the history with them when they left — and
    an audit trail that disappears when the person does is not an audit trail. The name is a
    snapshot of who they were at the moment they acted, which is exactly what history means.
    """
    __tablename__ = "feature_flag_changes"

    id = Column(Text, primary_key=True, default=lambda: f"ffc_{uuid.uuid4().hex[:12]}")
    feature_key = Column(Text, nullable=False)
    old_value = Column(Text, nullable=True)   # JSON; null when the key had no stored value yet
    new_value = Column(Text, nullable=False)  # JSON
    actor_id = Column(Text, nullable=True)    # logical reference — no FK, see the docstring
    actor_name = Column(Text, nullable=True)
    created_at = Column(Text, nullable=False, default=_now)

    __table_args__ = (
        # The two reads this table exists for: "what happened to THIS flag" (newest first), and
        # "what happened recently" across all of them.
        Index("idx_ffc_key_created", "feature_key", "created_at"),
        Index("idx_ffc_created", "created_at"),
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
    provider_type = Column(Text, nullable=False)      # falkordb | neo4j | datahub | spanner | mock
    host = Column(Text, nullable=True)
    port = Column(Integer, nullable=True)
    credentials = Column(Text, nullable=True)         # Fernet-encrypted JSON blob
    tls_enabled = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True)
    permitted_workspaces = Column(Text, nullable=False, default='["*"]')  # JSON list; "*" = all
    extra_config = Column(Text, nullable=True)        # JSON blob
    falkor_max_resident = Column(Integer, nullable=True)  # per-provider FalkorDB cache-eviction budget (max resident graphs); NULL ⇒ unset
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
        CheckConstraint(
            "provider_type IN ('falkordb', 'neo4j', 'datahub', 'spanner', 'mock')",
            name="ck_providers_provider_type",
        ),
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
    schema_id = Column(Text, nullable=False, default="")               # stable identifier grouping all versions
    revision = Column(Integer, nullable=False, default=0)              # optimistic locking counter
    created_by = Column(Text, nullable=True, default=None)             # who created this version
    updated_by = Column(Text, nullable=True, default=None)             # last modifier
    published_by = Column(Text, nullable=True, default=None)           # who published this version
    published_at = Column(Text, nullable=True, default=None)           # when published
    deleted_by = Column(Text, nullable=True, default=None)             # who soft-deleted
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)
    deleted_at = Column(Text, nullable=True, default=None)             # soft delete timestamp

    # Relationships
    data_sources = relationship(
        "WorkspaceDataSourceORM", back_populates="ontology",
    )

    __table_args__ = (
        Index("idx_ontologies_name_version", "name", "version"),
        Index("idx_ontologies_is_system", "is_system"),
        Index("idx_ontologies_schema_id", "schema_id"),
        Index("idx_ontologies_deleted", "deleted_at"),
        CheckConstraint(
            "scope IN ('universal', 'workspace')",
            name="ck_ontologies_scope",
        ),
        CheckConstraint(
            "evolution_policy IN ('reject', 'deprecate', 'migrate')",
            name="ck_ontologies_evolution_policy",
        ),
    )

    def __repr__(self) -> str:
        return f"<Ontology id={self.id!r} name={self.name!r} v{self.version}>"


# ------------------------------------------------------------------ #
# ontology_audit_log — immutable trail of ontology lifecycle events    #
# ------------------------------------------------------------------ #

class OntologyAuditLogORM(Base):
    """
    Immutable audit trail for ontology lifecycle events.
    Each row captures a single action (create, update, publish, delete, restore, clone)
    along with who performed it and a summary of what changed.
    """
    __tablename__ = "ontology_audit_log"

    id = Column(Text, primary_key=True, default=lambda: f"oal_{uuid.uuid4().hex[:12]}")
    ontology_id = Column(Text, nullable=False, index=True)
    schema_id = Column(Text, nullable=False, index=True)           # groups events across versions
    action = Column(Text, nullable=False)                           # created | updated | published | deleted | restored | cloned
    actor = Column(Text, nullable=True)                             # user who performed the action
    version = Column(Integer, nullable=True)                        # ontology version at time of action
    summary = Column(Text, nullable=True)                           # human-readable summary
    changes = Column(Text, nullable=True, default=None)             # JSON: detailed diff (added/removed types, changed fields)
    created_at = Column(Text, nullable=False, default=_now)

    __table_args__ = (
        Index("idx_oal_ontology", "ontology_id"),
        Index("idx_oal_schema", "schema_id"),
        Index("idx_oal_created", "created_at"),
        Index("idx_oal_actor_action", "actor", "action", "created_at"),
        CheckConstraint(
            "action IN ('created', 'updated', 'published', 'deleted', 'restored', 'cloned')",
            name="ck_oal_action_enum",
        ),
    )

    def __repr__(self) -> str:
        return f"<OntologyAuditLog id={self.id!r} action={self.action!r} ontology={self.ontology_id!r}>"


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
        Index("idx_osm_ontology", "ontology_id"),
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
    # Who may publish a view to enterprise (platform-wide) visibility.
    #   'open' (default)  — anyone who can change a view's visibility may
    #                       publish it directly. This is the default
    #                       because the graph holds METADATA: names,
    #                       types and lineage. A platform whose purpose
    #                       is shared understanding of lineage should not
    #                       require a signature before anyone can share
    #                       lineage, and a gate that always says yes is
    #                       friction with no signal.
    #   'request'         — members ask; a publish-permission holder
    #                       answers. For workspaces whose sources are
    #                       sensitive enough to want a human in the loop.
    # Risk that is concentrated in a few SOURCES belongs on the source
    # (see ``WorkspaceDataSourceORM.is_restricted``), not on everyone.
    publish_policy = Column(Text, nullable=False, default="open")
    # Audit-only attribution; does not grant any permission. Resolved
    # access lives in role_bindings.
    created_by = Column(Text, nullable=True, default=None)
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)
    # Soft delete (Phase 1 policy: user-visible + cross-referenced → soft)
    deleted_at = Column(Text, nullable=True, default=None)
    deleted_by = Column(Text, nullable=True, default=None)

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
        Index("idx_workspaces_deleted_at", "deleted_at"),
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
    # Publishing a view exposes read-only access to THIS source, so the
    # sources that deserve a human in the loop are marked here rather
    # than by locking down every workspace that happens to contain one.
    # A restricted source overrides an 'open' workspace policy: views
    # over it always need ``workspace:view:publish`` (or a request).
    is_restricted = Column(Boolean, nullable=False, default=False)
    extra_config = Column(Text, nullable=True)  # JSON — per-data-source config (schema mapping overrides, etc.)
    # Node-identity property — the physical graph property that plays the role
    # the platform's canonical ``urn`` does (universal node identity). NULL means
    # "urn" (the default, and every legacy row). Set to e.g. "id" when an
    # onboarded third-party graph identifies nodes by a differently-named
    # property; resolved at read time as coalesce(n.urn, n[identity_property]) so
    # the source can keep updating independently without a rewrite.
    identity_property = Column(Text, nullable=True)
    # Node display-name property — the physical graph property that holds the
    # human-readable node name. NULL means "name" (the default). Set when an
    # onboarded graph stores its name under a differently-named property (e.g.
    # "title"); the aggregation run stamps it onto `displayName` so the whole
    # read stack renders it, and the serializer falls back through name/title/
    # label meanwhile. Symmetric to identity_property.
    name_property = Column(Text, nullable=True)
    # ── Versioning source model ───────────────────────────────
    # None = derive from provider capability (managed if writable & not external).
    source_mode = Column(Text, nullable=True)              # "managed" | "federated"
    # Federated only: push our overlay edits back to the external system (opt-in, and only
    # when the provider is write-capable). Ignored for managed sources.
    write_back_enabled = Column(Boolean, nullable=False, default=False)
    # ── Aggregation state ─────────────────────────────────────
    aggregation_status = Column(Text, nullable=False, default="none")  # none|pending|running|ready|failed|skipped
    last_aggregated_at = Column(Text, nullable=True)  # ISO timestamp of last successful aggregation
    aggregation_edge_count = Column(Integer, nullable=False, default=0)  # count of AGGREGATED edges created
    graph_fingerprint = Column(Text, nullable=True)  # JSON hash of node/edge counts by type (change detection)
    aggregation_schedule = Column(Text, nullable=True)  # Cron expression (e.g., "0 */6 * * *") for periodic checks
    # Audit-only attribution; does not grant any permission.
    created_by = Column(Text, nullable=True, default=None)
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)
    # Soft delete (Phase 1 policy: user-visible + cross-referenced → soft)
    deleted_at = Column(Text, nullable=True, default=None)
    deleted_by = Column(Text, nullable=True, default=None)

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
        # Uniqueness is scoped to LIVE rows. A soft-deleted data source still occupies every
        # unique constraint it was in, and uq_ds_catalog_item is GLOBAL — so a plain constraint
        # would mean deleting a data source locks its catalog item out of every workspace for the
        # whole 30-day grace period. The undo window would silently be a lockout window.
        # (Partial unique indexes permit many NULLs, exactly as the constraints did.)
        # See alembic 20260714_1200_ds_soft_delete.
        #
        # `sqlite_where` as well as `postgresql_where`, and that is not belt-and-braces: the
        # dialect kwargs are dialect-SPECIFIC, so a bare `postgresql_where` is SILENTLY DROPPED
        # on SQLite — which is what the repo tests run on. The index would come out as a plain
        # UNIQUE, the tombstone would squat on it again, and the lockout bug would be live in
        # exactly the place we test for it. Both dialects support partial indexes; say so twice.
        Index("uq_ds_ws_prov_graph_live", "workspace_id", "provider_id", "graph_name",
              unique=True,
              postgresql_where=text("deleted_at IS NULL"),
              sqlite_where=text("deleted_at IS NULL")),
        Index("uq_ds_catalog_item_live", "catalog_item_id",
              unique=True,
              postgresql_where=text("deleted_at IS NULL"),
              sqlite_where=text("deleted_at IS NULL")),
        Index("idx_ds_ws_live", "workspace_id",
              postgresql_where=text("deleted_at IS NULL"),
              sqlite_where=text("deleted_at IS NULL")),
        Index("idx_ds_workspace", "workspace_id"),
        Index("idx_ds_provider", "provider_id"),
        Index("idx_ds_catalog_item", "catalog_item_id"),
        Index("idx_ds_ontology", "ontology_id"),
        Index("idx_ds_deleted_at", "deleted_at"),
        CheckConstraint(
            "aggregation_status IN ('none', 'pending', 'running', 'ready', 'failed', 'skipped')",
            name="ck_ds_aggregation_status",
        ),
        CheckConstraint(
            "access_level IS NULL OR access_level IN ('read', 'write', 'admin')",
            name="ck_ds_access_level",
        ),
        CheckConstraint(
            "projection_mode IS NULL OR projection_mode IN ('in_source', 'dedicated')",
            name="ck_ds_projection_mode",
        ),
        CheckConstraint(
            "source_mode IS NULL OR source_mode IN ('managed', 'federated')",
            name="ck_ds_source_mode",
        ),
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
    display_rules_config = Column(Text, nullable=True)               # JSON: DisplayRuleConfig[]
    is_active = Column(Boolean, nullable=False, default=True)
    # Columns added during context-model → view unification
    view_type = Column(Text, nullable=True)                            # graph | table | lineage | ...
    config = Column(Text, nullable=True)                               # JSON: full ViewConfiguration
    visibility = Column(Text, nullable=False, default="private")        # private | workspace | enterprise
    created_by = Column(Text, nullable=True)
    tags = Column(Text, nullable=True)                                 # JSON array
    is_pinned = Column(Boolean, nullable=False, default=False)
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
        CheckConstraint(
            "visibility IN ('private', 'workspace', 'enterprise')",
            name="ck_context_models_visibility",
        ),
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
    # Ontology digest captured at view save time — used by the wizard to
    # detect drift when a user edits a view whose ontology has changed since
    # creation. Nullable because legacy rows pre-date the column; the wizard
    # treats NULL as "drift check unavailable" (no warning shown).
    ontology_digest = Column(Text, nullable=True, default=None)
    # EXTENSION POINT: persist referenced_entity_types / referenced_relationship_types
    # for view-ontology compatibility checks once real breakage workflows appear.
    visibility = Column(Text, nullable=False, default="private")
    # Pending request to publish this view platform-wide. Set when a
    # member who cannot publish asks for it; cleared on approve (which
    # flips visibility), deny, or withdrawal. A pending request IS the
    # queue — no separate table, because the request is a fact about
    # this view and dies with it.
    publish_requested_by = Column(Text, nullable=True)
    publish_requested_at = Column(Text, nullable=True)
    publish_request_note = Column(Text, nullable=True)
    created_by = Column(Text, nullable=True)
    # Principal id of whoever last edited the view (same convention as
    # created_by). NULL on legacy rows and until the first edit after the
    # updated_by migration; the API resolves it to a display name.
    updated_by = Column(Text, nullable=True)
    # When/who last changed the view's UNDERLYING DATA (publish / PR merge /
    # revert on its data source's versioned graph) — separate from
    # updated_at/updated_by so data freshness never clobbers settings-edit
    # attribution. Stamped by the versioning endpoints' view fan-out.
    data_updated_at = Column(Text, nullable=True)
    data_updated_by = Column(Text, nullable=True)
    tags = Column(Text, nullable=True)                        # JSON array
    is_pinned = Column(Boolean, nullable=False, default=False)
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)
    deleted_at = Column(Text, nullable=True, default=None)

    # Relationships
    context_model = relationship("ContextModelORM", backref="views")
    workspace = relationship("WorkspaceORM", foreign_keys=[workspace_id])
    favourites = relationship("ViewFavouriteORM", back_populates="view", cascade="all, delete-orphan")

    __table_args__ = (
        Index("idx_view_workspace", "workspace_id"),
        Index("idx_view_context_model", "context_model_id"),
        Index("idx_view_visibility", "visibility"),
        Index("idx_view_publish_requested", "publish_requested_at"),
        Index("idx_view_data_source", "data_source_id"),
        Index("idx_view_deleted_at", "deleted_at"),
        CheckConstraint(
            "visibility IN ('private', 'workspace', 'enterprise')",
            name="ck_views_visibility",
        ),
    )

    def __repr__(self) -> str:
        return f"<View id={self.id!r} name={self.name!r} type={self.view_type!r}>"


# ------------------------------------------------------------------ #
# view_activity_log — immutable per-view change timeline               #
# ------------------------------------------------------------------ #
class ViewActivityLogORM(Base):
    """Immutable activity trail for a single view.

    Each row captures one action (created, updated, visibility_changed,
    shared, unshared, favourited, unfavourited, deleted, restored) with who
    did it and a human summary / structured diff. This is the DURABLE source
    of truth for the per-view timeline UI — deliberately decoupled from the
    ``outbox_events`` relay (which is transient). Every mutation ALSO emits a
    ``visualization.view.<action>`` outbox event in the same transaction for
    app-wide consistency; the timeline reads only this table.
    """
    __tablename__ = "view_activity_log"

    id = Column(Text, primary_key=True, default=lambda: f"val_{uuid.uuid4().hex[:12]}")
    view_id = Column(Text, nullable=False, index=True)
    workspace_id = Column(Text, nullable=True, index=True)   # scoping / cross-view feeds
    action = Column(Text, nullable=False)
    actor = Column(Text, nullable=True)                       # principal id who acted
    summary = Column(Text, nullable=True)                     # human-readable
    changes = Column(Text, nullable=True, default=None)       # JSON: field-level diff
    created_at = Column(Text, nullable=False, default=_now)

    __table_args__ = (
        Index("idx_val_view", "view_id"),
        Index("idx_val_view_created", "view_id", "created_at"),
        Index("idx_val_created", "created_at"),
        CheckConstraint(
            "action IN ('created', 'updated', 'visibility_changed', 'shared', "
            "'unshared', 'favourited', 'unfavourited', 'deleted', 'restored', "
            "'data_changed', 'publish_requested', 'publish_denied', "
            "'admin_viewed')",
            name="ck_val_action_enum",
        ),
    )

    def __repr__(self) -> str:
        return f"<ViewActivityLog id={self.id!r} action={self.action!r} view={self.view_id!r}>"


class ProductEventORM(Base):
    """Append-only product telemetry — one immutable row per usage signal.

    Records the signals the app chooses to emit (docs 'was this helpful?', a
    search that returned nothing, a tour completed/skipped, an onboarding step),
    so the Admin telemetry view can aggregate them. Deliberately SEPARATE from
    ``outbox_events`` (a transient, consumer-drained relay) — these rows are
    durable and queryable. ``payload`` is a small JSON string; there is no PII
    beyond the actor id.
    """
    __tablename__ = "product_events"

    id = Column(Text, primary_key=True, default=lambda: f"pev_{uuid.uuid4().hex[:12]}")
    event_type = Column(Text, nullable=False)   # e.g. 'docs.feedback', 'docs.search_miss'
    actor_id = Column(Text, nullable=True)       # principal id who acted (if authenticated)
    payload = Column(Text, nullable=True)        # JSON string
    created_at = Column(Text, nullable=False, default=_now)

    __table_args__ = (
        Index("idx_product_events_type_created", "event_type", "created_at"),
        Index("idx_product_events_created", "created_at"),
    )

    def __repr__(self) -> str:
        return f"<ProductEvent id={self.id!r} type={self.event_type!r}>"


# ------------------------------------------------------------------ #
# view_layout_overlays (Branch-Scoped Layout)                          #
# ------------------------------------------------------------------ #
class ViewLayoutOverlayORM(Base):
    """Per-(view, branch) draft overlay of a Context View's layout.

    Branch-scoped layout: a draft branch's layer edits live here instead of on
    the published ``views.config``, so they don't leak to Published until the
    draft is merged/published (promote). One row per (view_id, branch_id).

    ``reference_layout`` / ``entity_scope`` hold the draft's CURRENT effective
    bare referenceLayout + scope; ``fork_base_*`` snapshot the published base at
    draft-open time so the 3-way promote merge (``layout_promote``) can tell
    what the draft actually changed. ``branch_id`` is a plain-text logical ref
    to a graphver draft branch — no cross-schema FK (mirrors versioning's
    ``originating_view_id``)."""
    __tablename__ = "view_layout_overlays"

    view_id = Column(
        Text,
        ForeignKey("views.id", ondelete="CASCADE"),
        primary_key=True,
    )
    branch_id = Column(Text, primary_key=True)
    # JSON: draft's effective bare referenceLayout {layers, assignments}.
    reference_layout = Column(Text, nullable=False, default="{}")
    entity_scope = Column(Text, nullable=True)                 # 'all'|'curated'|NULL
    # JSON: base bare referenceLayout snapshot captured at draft open.
    fork_base_layout = Column(Text, nullable=False, default="{}")
    fork_base_entity_scope = Column(Text, nullable=True)
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    __table_args__ = (
        Index("idx_vlo_branch", "branch_id"),
    )

    def __repr__(self) -> str:
        return f"<ViewLayoutOverlay view_id={self.view_id!r} branch_id={self.branch_id!r}>"


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
    # Deep-facet freshness marker (schema_stats / ontology_metadata /
    # graph_schema columns). ``updated_at`` tracks the cheap counts facet
    # and keeps driving the read path's fresh/stale classification; this
    # drives the scheduler's deep-poll due-ness. NULL until the first
    # deep poll lands.
    schema_updated_at = Column(Text, nullable=True)
    top_level_nodes = Column(Text, nullable=True)        # JSON payload, NULL = never materialized
    top_level_updated_at = Column(Text, nullable=True)   # ISO timestamp, freshness marker

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

    __table_args__ = (
        CheckConstraint(
            "last_status IN ('pending', 'success', 'error')",
            name="ck_polling_last_status",
        ),
    )

    def __repr__(self) -> str:
        return f"<DataSourcePollingConfig ds_id={self.data_source_id!r} enabled={self.is_enabled}>"


# ------------------------------------------------------------------ #
# asset_discovery_cache (Pre-registration asset cache)                 #
# ------------------------------------------------------------------ #
# Caches the result of provider asset-list and per-asset stats calls
# made during onboarding (before a workspace_data_source exists). Keyed
# by (provider_id, asset_name); the empty-string asset_name is the
# sentinel row for the "list all assets on this provider" payload.

class AssetDiscoveryCacheORM(Base):
    __tablename__ = "asset_discovery_cache"

    provider_id = Column(
        Text,
        ForeignKey("providers.id", ondelete="CASCADE"),
        primary_key=True,
    )
    asset_name = Column(Text, primary_key=True, default="")
    payload = Column(Text, nullable=False, default="{}")  # JSON
    status = Column(Text, nullable=False, default="fresh")  # fresh | stale | partial
    computed_at = Column(Text, nullable=False, default=_now)
    expires_at = Column(Text, nullable=False)  # ISO; absolute, cleaned by scheduler
    last_error = Column(Text, nullable=True)

    __table_args__ = (
        Index("idx_adc_expires", "expires_at"),
        CheckConstraint(
            "status IN ('fresh', 'stale', 'partial')",
            name="ck_adc_status",
        ),
    )

    def __repr__(self) -> str:
        return f"<AssetDiscoveryCache provider={self.provider_id!r} asset={self.asset_name!r} status={self.status!r}>"


# ------------------------------------------------------------------ #
# provider_admission_config (Per-provider rate-limit knobs)            #
# ------------------------------------------------------------------ #
# Admin-tunable token-bucket + circuit-breaker parameters per provider.
# Read by insights_service workers on each job; absence of a row falls
# back to module defaults (see backend/insights_service/admission.py).

class ProviderAdmissionConfigORM(Base):
    __tablename__ = "provider_admission_config"

    provider_id = Column(
        Text,
        ForeignKey("providers.id", ondelete="CASCADE"),
        primary_key=True,
    )
    bucket_capacity = Column(Integer, nullable=False, default=8)
    refill_per_sec = Column(Integer, nullable=False, default=2)
    circuit_fail_max = Column(Integer, nullable=False, default=5)
    circuit_window_secs = Column(Integer, nullable=False, default=30)
    half_open_after_secs = Column(Integer, nullable=False, default=60)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    def __repr__(self) -> str:
        return f"<ProviderAdmissionConfig provider={self.provider_id!r} cap={self.bucket_capacity} refill={self.refill_per_sec}/s>"


# ------------------------------------------------------------------ #
# provider_health_window (Rolling success window)                      #
# ------------------------------------------------------------------ #
# Worker-maintained rolling-window counters for admission control.
# `throttle_until` is set when the rolling success rate drops below
# threshold; while in the future, workers defer enqueues for this
# provider rather than burning capacity.

class ProviderHealthWindowORM(Base):
    __tablename__ = "provider_health_window"

    provider_id = Column(
        Text,
        ForeignKey("providers.id", ondelete="CASCADE"),
        primary_key=True,
    )
    success_count = Column(Integer, nullable=False, default=0)
    failure_count = Column(Integer, nullable=False, default=0)
    window_start = Column(Text, nullable=False, default=_now)
    consecutive_failures = Column(Integer, nullable=False, default=0)
    throttle_until = Column(Text, nullable=True)
    last_p99_ms = Column(Integer, nullable=True)

    def __repr__(self) -> str:
        return f"<ProviderHealthWindow provider={self.provider_id!r} ok={self.success_count} fail={self.failure_count}>"


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
        UniqueConstraint("provider_id", "source_identifier", name="uq_catalog_provider_source"),
        Index("idx_catalog_provider", "provider_id"),
        Index("idx_catalog_status", "status"),
        CheckConstraint(
            "status IN ('active', 'archived', 'deprecated')",
            name="ck_catalog_status",
        ),
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
    # Chosen display name. NULL means "derive it from first + last" —
    # which is what every row did before the column existed. Resolve it
    # through ``backend.common.display_name.resolve_display_name`` rather
    # than reading it directly, so the fallback lives in one place.
    display_name = Column(Text, nullable=True)
    status = Column(Text, nullable=False, default="pending")       # pending | active | suspended
    # NB: ``auth_provider`` / ``external_id`` lived here in Phase 2.
    # Phase 3 normalised SSO identity into the ``user_identities``
    # table so one user can stack multiple providers (local password
    # + Entra OIDC + Okta SAML, etc.). To check "does this user have
    # SSO?" query ``user_identities`` by ``user_id``; to check "does
    # this user have a password?" compare ``password_hash`` against
    # the disabled-sentinel constant in ``auth_service.core.password``.
    #
    # Phase 4 adds signup provenance: how the account first came into
    # existence ('local_signup' / 'sso_jit' / 'invite' /
    # 'admin_created' / 'admin_linked') and — for SSO origins —
    # which provider provisioned it. Used by the admin user-lookup
    # surface; the auth_audit_log carries the time-series detail.
    signup_source = Column(
        Text, nullable=False, default="local_signup",
    )
    signup_provider_id = Column(
        Text, ForeignKey("idp_providers.id", ondelete="SET NULL"),
        nullable=True,
    )
    metadata_ = Column("metadata", Text, nullable=True, default="{}")  # JSON: idp_groups snapshot, attributes, prefs
    reset_token_hash = Column(Text, nullable=True)
    reset_token_expires_at = Column(Text, nullable=True)
    # Force a rotation on the next request. Set on the bootstrap admin
    # when it is seeded with a shipped default password; cleared by
    # ``user_repo.update_password``. Carried into the access token as a
    # claim and enforced by ``get_current_user``.
    must_change_password = Column(
        Boolean, nullable=False, default=False, server_default="false",
    )
    # Chosen avatar illustration. Was a browser-local preference, so it
    # reset on a new machine and nobody else ever saw it.
    avatar_id = Column(Text, nullable=True)
    # ISO instant before which refresh tokens are refused. Revoking
    # sessions only tombstones access-token ``sid``s, and ``refresh()``
    # mints a fresh ``sid`` rather than reusing one — so without this
    # cutoff a client that silently refreshed on a 401 walked straight
    # back in. Stamped by ``user_repo.revoke_sessions_from_now``.
    sessions_valid_from = Column(Text, nullable=True)
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)
    deleted_at = Column(Text, nullable=True)                       # soft delete

    # Relationships
    roles = relationship("UserRoleORM", back_populates="user", cascade="all, delete-orphan")
    identities = relationship(
        "UserIdentityORM", back_populates="user", cascade="all, delete-orphan",
    )
    external_attributes = relationship(
        "UserExternalAttributeORM", back_populates="user",
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        UniqueConstraint("email", name="uq_users_email"),
        Index("idx_users_status_created", "status", "created_at"),
        Index("idx_users_signup_source", "signup_source"),
        CheckConstraint(
            "status IN ('pending', 'active', 'suspended')",
            name="ck_users_status",
        ),
        CheckConstraint(
            "signup_source IN ('local_signup', 'sso_jit', 'invite', "
            "                  'admin_created', 'admin_linked')",
            name="ck_users_signup_source",
        ),
    )

    def __repr__(self) -> str:
        return f"<User id={self.id!r} email={self.email!r} status={self.status!r}>"


# ------------------------------------------------------------------ #
# idp_providers  (DB-stored SSO IdP configuration; Phase 3)            #
# ------------------------------------------------------------------ #


class IdpProviderORM(Base):
    """One row per configured SSO Identity Provider.

    Multiple rows of the same ``kind`` are allowed — e.g. ``oidc/entra``
    + ``oidc/auth0-contractors`` is a legitimate setup. The runtime
    factory in ``auth_service.providers.registry`` instantiates a
    provider object per row, caching by ``id``.

    ``settings`` is a Fernet-encrypted JSON blob (the same envelope used
    by ``connection_repo._get_fernet``) carrying every kind-specific
    detail including secrets. ``claim_mapping`` is plaintext JSON — it
    contains no secrets and is read by the SSO admin UI for editing.
    """
    __tablename__ = "idp_providers"

    id = Column(Text, primary_key=True, default=lambda: f"idp_{uuid.uuid4().hex[:12]}")
    slug = Column(Text, nullable=False)                     # URL-safe id used in /auth/{slug}/login
    display_name = Column(Text, nullable=False)             # 'Corporate Entra ID'
    kind = Column(Text, nullable=False)                     # oidc | saml2 | custom | custom_profile
    enabled = Column(Boolean, nullable=False, default=True)
    priority = Column(Integer, nullable=False, default=100)
    # Fernet-encrypted JSON of kind-specific settings. The repo wraps
    # the bytes; never read this column directly outside the repo.
    settings = Column(Text, nullable=False, default="{}")
    # Plaintext JSON: which IdP claim populates which internal field.
    # Empty dict means "use the kind's defaults" (see claim_mapper).
    claim_mapping = Column(Text, nullable=False, default="{}")
    linking_policy = Column(Text, nullable=False, default="strict")
    button_label = Column(Text, nullable=True)
    button_icon = Column(Text, nullable=True)
    created_at = Column(Text, nullable=False, default=_now)
    created_by = Column(Text, nullable=True)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)
    updated_by = Column(Text, nullable=True)

    # Email domains that route to this provider when email-first login is
    # on. Plaintext JSON array, mirroring ``claim_mapping`` — no secrets,
    # and an operator may want to read it straight out of the DB.
    email_domains = Column(Text, nullable=True)
    # The most recent assertion this provider sent us, Fernet-encrypted via
    # the same envelope as ``settings``. Mapping against a pasted sample is
    # guesswork; mapping against what actually arrived is not. NEVER on the
    # provider DTO — it is served by a dedicated admin-only endpoint so it
    # cannot leak by someone adding a field to the list response.
    last_assertion = Column(Text, nullable=True)
    last_assertion_at = Column(Text, nullable=True)
    # Readiness, distinct from ``enabled``. A ``draft`` is configured but
    # unproven: invisible to every public surface, fully rehearsable, and
    # promoted to ``live`` only by an explicit publish. Creating a provider
    # used to put it on every user's login page the instant it was saved —
    # before discovery had been reviewed or a dry-run had proved it works.
    #
    # ``enabled`` stays the OPERATIONAL switch (turn a live provider off
    # during an incident). Conflating "configured" with "verified" is what
    # created the problem, so the two stay separate.
    lifecycle = Column(Text, nullable=False, default="draft", server_default="live")

    identities = relationship("UserIdentityORM", back_populates="provider")

    __table_args__ = (
        UniqueConstraint("slug", name="uq_idp_providers_slug"),
        Index("idx_idp_providers_kind_enabled", "kind", "enabled"),
        CheckConstraint(
            "kind IN ('oidc', 'saml2', 'custom', 'custom_profile')",
            name="ck_idp_providers_kind",
        ),
        CheckConstraint(
            "lifecycle IN ('draft', 'live')",
            name="ck_idp_providers_lifecycle",
        ),
        CheckConstraint(
            "linking_policy IN ('strict', 'allow_verified', 'manual_only', 'disabled')",
            name="ck_idp_providers_linking_policy",
        ),
    )

    def __repr__(self) -> str:
        return f"<IdpProvider id={self.id!r} slug={self.slug!r} kind={self.kind!r}>"


# ------------------------------------------------------------------ #
# user_identities  (multi-identity per user; Phase 3)                  #
# ------------------------------------------------------------------ #


class UserIdentityORM(Base):
    """SSO subject linked to a user. Replaces the Phase-2
    ``(users.auth_provider, users.external_id)`` columns with a real
    1:N relationship so one user can have local + Entra + Auth0 at
    the same time.

    The (provider_id, external_id) pair is the durable identity key —
    e.g. for OIDC this is ``(provider, sub)``. UNIQUE keeps the JIT
    find-or-provision flow race-safe even across pods.

    ``UNIQUE(user_id, provider_id)`` prevents a single user from being
    linked twice to the same IdP (which would be ambiguous on
    refresh).
    """
    __tablename__ = "user_identities"

    id = Column(Text, primary_key=True, default=lambda: f"uid_{uuid.uuid4().hex[:12]}")
    user_id = Column(
        Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False,
    )
    provider_id = Column(
        Text, ForeignKey("idp_providers.id", ondelete="RESTRICT"), nullable=False,
    )
    external_id = Column(Text, nullable=False)
    # Snapshot of the email the IdP asserted at link time. Useful for
    # audit ("this identity was linked under alice@example.com even
    # though the IdP now says alice@corp.example") and for the admin
    # identities tab.
    email_at_link = Column(Text, nullable=True)
    created_at = Column(Text, nullable=False, default=_now)
    last_login_at = Column(Text, nullable=True)
    # Most recent raw_claims / groups for THIS identity. Phase 2
    # snapshot logic (``set_user_idp_metadata``) still writes
    # ``users.metadata_.idp_groups`` for the latest-login provider so
    # the existing reconciler path keeps working unchanged.
    metadata_ = Column("metadata", Text, nullable=True, default="{}")

    user = relationship("UserORM", back_populates="identities")
    provider = relationship("IdpProviderORM", back_populates="identities")

    __table_args__ = (
        UniqueConstraint(
            "provider_id", "external_id",
            name="uq_user_identities_provider_subject",
        ),
        UniqueConstraint(
            "user_id", "provider_id",
            name="uq_user_identities_user_provider",
        ),
        Index("idx_user_identities_user", "user_id"),
    )

    def __repr__(self) -> str:
        return (
            f"<UserIdentity id={self.id!r} user={self.user_id!r} "
            f"provider={self.provider_id!r}>"
        )


# ------------------------------------------------------------------ #
# user_external_attributes  (indexed projection of IdP claim extras)   #
# ------------------------------------------------------------------ #


class UserExternalAttributeORM(Base):
    """One row per (user, attribute key). The ``value`` column is the
    indexed projection of the operator-declared ``claim_mapping.extras``
    bucket — multi-valued claims are flattened to a CSV so a single
    string can serve both single-value (staff_id=12345) and contains-
    style searches.

    Phase 4: the raw JSON (multi-typed) snapshot still lives at
    ``users.metadata_.attributes``; this table is the queryable
    view. ``set_at`` + ``source_provider_id`` are kept for audit so
    the help-desk can answer "which IdP last set this user's
    employee_id?".

    UNIQUE(user_id, key) keeps the upsert path race-safe across
    pods. INDEX(key, value) covers the
    "find user by ``staff_id=12345``" lookup.
    """
    __tablename__ = "user_external_attributes"

    id = Column(Text, primary_key=True, default=lambda: f"uea_{uuid.uuid4().hex[:12]}")
    user_id = Column(
        Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False,
    )
    key = Column(Text, nullable=False)
    value = Column(Text, nullable=False)
    source_provider_id = Column(
        Text, ForeignKey("idp_providers.id", ondelete="SET NULL"),
        nullable=True,
    )
    set_at = Column(Text, nullable=False, default=_now)

    user = relationship("UserORM", back_populates="external_attributes")

    __table_args__ = (
        UniqueConstraint(
            "user_id", "key",
            name="uq_user_external_attributes_user_key",
        ),
        Index(
            "idx_user_external_attributes_key_value",
            "key", "value",
        ),
        Index("idx_user_external_attributes_user", "user_id"),
    )

    def __repr__(self) -> str:
        return (
            f"<UserExternalAttribute user={self.user_id!r} "
            f"key={self.key!r}>"
        )


# ------------------------------------------------------------------ #
# app_auth_config  (singleton: platform-wide SSO posture switches)     #
# ------------------------------------------------------------------ #


class AppAuthConfigORM(Base):
    """Singleton row carrying the platform-wide SSO posture.

    Only one row ever exists (PK pinned to ``'singleton'`` by CHECK).
    The repo upserts with an optimistic ``version`` bump mirroring
    ``feature_flags_repo``'s pattern. The migration seeds the row
    with defaults (all true) so the auth flow never sees a NULL
    config.

    Phase 4 ships three posture switches:

      * ``sso_enabled`` — master kill-switch.
      * ``allow_local_login`` — when false, password login is
        refused (SSO-only mode).
      * ``allow_jit_provisioning`` — when false, SSO logins for
        unknown subjects with no matching email are rejected with
        ``jit_disabled`` instead of provisioning.
    """
    __tablename__ = "app_auth_config"

    id = Column(Text, primary_key=True, default="singleton")
    sso_enabled = Column(Boolean, nullable=False, default=True)
    allow_local_login = Column(Boolean, nullable=False, default=True)
    allow_jit_provisioning = Column(Boolean, nullable=False, default=True)
    # Email-first login (Home Realm Discovery). Off by default: it changes
    # what every user sees, and a wrong domain mapping strands them.
    email_first_login = Column(Boolean, nullable=False, default=False)
    version = Column(Integer, nullable=False, default=1)
    updated_at = Column(Text, nullable=False, default=_now)
    updated_by = Column(Text, nullable=True)

    __table_args__ = (
        CheckConstraint("id = 'singleton'", name="ck_app_auth_config_singleton"),
    )

    def __repr__(self) -> str:
        return (
            f"<AppAuthConfig sso={self.sso_enabled} "
            f"local={self.allow_local_login} jit={self.allow_jit_provisioning}>"
        )


class ApplicationBrandingORM(Base):
    """Singleton row carrying the white-label branding for the
    deployment (app name, logo, accent colour, legal text, …).

    Same shape as ``AppAuthConfigORM``: one row pinned to
    ``'singleton'`` by CHECK, an optimistic ``version`` the admin UI
    echoes back on PATCH, and a migration that seeds it from the
    ``APP_BRAND_*`` env vars. The repository falls back to those same
    env defaults for any NULL column, so env vars act as defaults and
    the DB row overrides them.

    Logo/favicon each support two mutually-compatible sources: a
    pasted ``*_url`` OR an uploaded image stored base64 in ``*_data``
    (+ ``*_mime``). When both are set the uploaded data wins.
    """
    __tablename__ = "application_branding"

    id = Column(Text, primary_key=True, default="singleton")
    app_name = Column(Text, nullable=True)
    short_name = Column(Text, nullable=True)
    description = Column(Text, nullable=True)
    # Logo: URL reference and/or uploaded base64 payload.
    logo_url = Column(Text, nullable=True)
    logo_data = Column(Text, nullable=True)   # base64 image bytes
    logo_mime = Column(Text, nullable=True)   # e.g. image/svg+xml, image/png
    # Favicon: URL reference and/or uploaded base64 payload.
    favicon_url = Column(Text, nullable=True)
    favicon_data = Column(Text, nullable=True)
    favicon_mime = Column(Text, nullable=True)
    accent_color = Column(Text, nullable=True)
    copyright_text = Column(Text, nullable=True)
    support_email = Column(Text, nullable=True)
    login_tagline = Column(Text, nullable=True)
    version = Column(Integer, nullable=False, default=1)
    updated_at = Column(Text, nullable=False, default=_now)
    updated_by = Column(Text, nullable=True)

    __table_args__ = (
        CheckConstraint(
            "id = 'singleton'", name="ck_application_branding_singleton",
        ),
    )

    def __repr__(self) -> str:
        return f"<ApplicationBranding name={self.app_name} v={self.version}>"


# ------------------------------------------------------------------ #
# user_roles  (one row per user × role)                                #
# ------------------------------------------------------------------ #

class UserRoleORM(Base):
    __tablename__ = "user_roles"

    id = Column(Text, primary_key=True, default=lambda: f"urole_{uuid.uuid4().hex[:12]}")
    user_id = Column(Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    # Phase 5: legacy ``user_roles`` table still consulted by
    # ``require_admin``; the constraint enumerates the post-uplift
    # taxonomy. Production Postgres dropped the original Phase-1 CHECK
    # in 20260430_1500_roles_lifecycle; SQLite tests use create_all so
    # we keep the constraint in the ORM and update the allowed set.
    role_name = Column(Text, nullable=False, default="workspace_member")
    created_at = Column(Text, nullable=False, default=_now)

    user = relationship("UserORM", back_populates="roles")

    __table_args__ = (
        UniqueConstraint("user_id", "role_name", name="uq_user_role"),
        Index("idx_user_roles_user", "user_id"),
        CheckConstraint(
            "role_name IN ("
            "'super_admin', 'org_admin', "
            "'workspace_admin', 'workspace_member', 'workspace_viewer'"
            ")",
            name="ck_user_roles_role_name",
        ),
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
        CheckConstraint(
            "status IN ('pending', 'approved', 'rejected')",
            name="ck_user_approvals_status",
        ),
    )

    def __repr__(self) -> str:
        return f"<UserApproval user={self.user_id!r} status={self.status!r}>"


# ====================================================================== #
# RBAC — Subject-Role-Scope binding model                                  #
# ====================================================================== #
# Six tables implement the binding model documented in the Enterprise
# RBAC plan (docs/superpowers/specs/...). The shape is:
#
#     subject (user|group)  ──╮
#                              ├── role_binding ──> role ──> permissions
#     scope   (global|ws_*)  ──╯
#
# Resource-level grants on Views (the only resource that supports
# explicit per-row sharing in Phase 1) live in ``resource_grants``.
# Data Sources are workspace-inherited and have no explicit grants.

# ------------------------------------------------------------------ #
# permissions  (catalogue of every permission the system enforces)     #
# ------------------------------------------------------------------ #

class PermissionORM(Base):
    """Single permission identifier and human description.

    The id is a stable string like ``workspace:view:edit`` — chosen
    deliberately so role_permissions rows and JWT claims can reference
    the permission by name, not by surrogate key. Seeded once by the
    Phase 1 migration; not user-editable in Phase 1.

    Phase 4.1 added ``long_description`` (paragraph-form explanation
    surfaced in the admin UI tooltip) and ``examples`` (JSON-encoded
    list of concrete example actions). Both backfilled by the
    ``20260430_1700_permission_descriptions`` migration.
    """
    __tablename__ = "permissions"

    id = Column(Text, primary_key=True)        # e.g. "workspace:view:edit"
    description = Column(Text, nullable=False)
    category = Column(Text, nullable=False)    # system | workspace | resource
    long_description = Column(Text, nullable=True)
    examples = Column(Text, nullable=True)     # JSON-encoded list[str]

    __table_args__ = (
        CheckConstraint(
            "category IN ('system', 'workspace', 'resource')",
            name="ck_permissions_category",
        ),
    )

    def __repr__(self) -> str:
        return f"<Permission id={self.id!r} category={self.category!r}>"


# ------------------------------------------------------------------ #
# role_permissions  (which permissions belong to which role)           #
# ------------------------------------------------------------------ #

class RolePermissionORM(Base):
    """Role → permission mapping.

    Phase 3 promoted ``role_name`` from a CHECK-constrained enum into
    a foreign-key-ish reference to the canonical ``roles`` table. The
    DB-level CHECK on the role name is dropped by the
    ``20260430_1500_roles_lifecycle`` migration; ``role_repo`` enforces
    referential integrity at the application boundary so a future
    Postgres-native FK is a non-breaking change.
    """
    __tablename__ = "role_permissions"

    role_name = Column(Text, primary_key=True)
    permission_id = Column(
        Text,
        ForeignKey("permissions.id", ondelete="CASCADE"),
        primary_key=True,
    )

    __table_args__ = (
        Index("idx_role_permissions_role", "role_name"),
    )

    def __repr__(self) -> str:
        return f"<RolePermission role={self.role_name!r} perm={self.permission_id!r}>"


# ------------------------------------------------------------------ #
# roles  (canonical role definitions — Phase 3 lifecycle)              #
# ------------------------------------------------------------------ #

class RoleORM(Base):
    """A role definition.

    Phase 1 baked admin/user/viewer into CHECK constraints on the
    role-permission and role-binding tables. Phase 3 promotes the
    role name into a real entity so:

      * Custom roles can be created and edited in the admin UI.
      * Each role can be ``global`` (usable in any binding) or
        ``workspace``-scoped (only assignable inside that workspace).
      * The ``is_system`` flag marks built-in roles that the UI
        renders read-only.

    Application-level guards in ``role_repo`` and ``binding_repo``
    enforce that bindings can only reference a role whose scope
    matches the binding's scope (a workspace-scoped role cannot be
    bound globally, etc.).
    """
    __tablename__ = "roles"

    name = Column(Text, primary_key=True)
    description = Column(Text, nullable=True)
    scope_type = Column(Text, nullable=False, default="global")  # global | workspace
    scope_id = Column(Text, nullable=True)
    is_system = Column(Boolean, nullable=False, default=False)
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)
    created_by = Column(Text, nullable=True)

    __table_args__ = (
        Index("idx_roles_scope", "scope_type", "scope_id"),
        Index("idx_roles_is_system", "is_system"),
        CheckConstraint(
            "scope_type IN ('global', 'workspace')",
            name="ck_roles_scope_type",
        ),
        CheckConstraint(
            "(scope_type = 'global' AND scope_id IS NULL) "
            "OR (scope_type = 'workspace' AND scope_id IS NOT NULL)",
            name="ck_roles_scope_consistency",
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<Role name={self.name!r} scope={self.scope_type}:{self.scope_id} "
            f"system={self.is_system}>"
        )


# ------------------------------------------------------------------ #
# groups  (named collections of users — the second Subject type)       #
# ------------------------------------------------------------------ #

class GroupORM(Base):
    """A named group of users.

    Groups are global (not workspace-scoped) so the same group can be
    bound to many workspaces with different roles, matching how
    Okta/Entra/SCIM directories work.
    """
    __tablename__ = "groups"

    id = Column(Text, primary_key=True, default=lambda: f"grp_{uuid.uuid4().hex[:12]}")
    name = Column(Text, nullable=False)
    description = Column(Text, nullable=True)
    # Provenance: 'local' = created in-app; 'scim' = synced from an
    # external IdP. external_id is the SCIM subject when source='scim'.
    # These two columns are placeholders for Phase 2 SSO sync.
    source = Column(Text, nullable=False, default="local")
    external_id = Column(Text, nullable=True)
    # Phase 3: groups flagged ``is_protected`` cannot be the target of
    # an IdP group->group mapping. Set on groups that confer elevated
    # access so admin-only flows remain the only way to add members.
    is_protected = Column(Boolean, nullable=False, default=False)
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)
    deleted_at = Column(Text, nullable=True, default=None)

    members = relationship(
        "GroupMemberORM", back_populates="group",
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        UniqueConstraint("name", name="uq_groups_name"),
        Index("idx_groups_deleted_at", "deleted_at"),
        Index("idx_groups_external_id", "external_id"),
        CheckConstraint(
            "source IN ('local', 'scim')",
            name="ck_groups_source",
        ),
    )

    def __repr__(self) -> str:
        return f"<Group id={self.id!r} name={self.name!r}>"


# ------------------------------------------------------------------ #
# group_members  (user × group membership)                             #
# ------------------------------------------------------------------ #

class GroupMemberORM(Base):
    __tablename__ = "group_members"

    group_id = Column(
        Text,
        ForeignKey("groups.id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_id = Column(
        Text,
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    added_at = Column(Text, nullable=False, default=_now)
    added_by = Column(Text, nullable=True)
    # Phase 3: provenance, mirroring ``role_bindings.source``. The
    # SSO group-mapping reconciler only ever adds/removes rows where
    # source='sso'; manually-added members stay untouched even when
    # the IdP later stops asserting the group.
    source = Column(Text, nullable=False, default="local")

    group = relationship("GroupORM", back_populates="members")

    __table_args__ = (
        # Hot path: "what groups is this user in?" — used by the
        # PermissionResolver on every login.
        Index("idx_group_members_user", "user_id"),
        CheckConstraint(
            "source IN ('local', 'sso')",
            name="ck_group_members_source",
        ),
    )

    def __repr__(self) -> str:
        return f"<GroupMember group={self.group_id!r} user={self.user_id!r}>"


# ------------------------------------------------------------------ #
# idp_group_role_mappings  (IdP group -> RBAC role binding template)   #
# ------------------------------------------------------------------ #


class IdpGroupRoleMappingORM(Base):
    """Maps an IdP group name to either an automatic RoleBinding or
    membership in an internal Group.

    Phase 2 supported only RoleBinding targets. Phase 3 adds:
      * ``target_type``: ``'role_binding'`` (default; Phase 2 behaviour)
        OR ``'group_membership'``: maps IdP group X -> membership in
        internal Group Y so internal admins manage group composition
        once and permission inheritance flows through.
      * ``provider_id``: scope the mapping to one IdP. NULL means
        "matches groups from any IdP" (Phase 2 semantics). Most
        enterprise setups want the explicit per-IdP form so a SAML
        IdP's ``engineering`` and an OIDC IdP's ``engineering`` don't
        collide.

    Validation happens in the repo (``role_repo.role_is_bindable_in_scope``
    + group existence checks) — DB CHECK only enforces shape.

    Hard guardrails (enforced in the repo):
      * ``role_name='system:admin'`` is forever refused — admin grants
        stay manual.
      * ``target_type='group_membership'`` cannot target a Group with
        ``is_protected=true``.
    """
    __tablename__ = "idp_group_role_mappings"

    id = Column(Text, primary_key=True, default=lambda: f"igrm_{uuid.uuid4().hex[:12]}")
    # Optional scoping to a specific IdP. NULL = applies to any IdP's
    # group set (Phase 2 fallback). ON DELETE CASCADE so removing an
    # IdP automatically cleans up the mappings that referenced it.
    provider_id = Column(
        Text, ForeignKey("idp_providers.id", ondelete="CASCADE"), nullable=True,
    )
    idp_group = Column(Text, nullable=False)
    target_type = Column(Text, nullable=False, default="role_binding")
    # role_binding target columns (NULL for group_membership):
    scope_type = Column(Text, nullable=True)            # global | workspace
    scope_id = Column(Text, nullable=True)              # NULL for global
    role_name = Column(Text, nullable=True)
    # group_membership target columns (NULL for role_binding):
    target_group_id = Column(
        Text, ForeignKey("groups.id", ondelete="CASCADE"), nullable=True,
    )
    created_at = Column(Text, nullable=False, default=_now)
    created_by = Column(Text, nullable=True)    # user_id who created the mapping

    __table_args__ = (
        # The role_binding target uniqueness key, with provider_id as the
        # outermost scope. Two providers can independently map their
        # respective ``engineering`` groups to the same role+scope
        # without colliding.
        UniqueConstraint(
            "provider_id", "idp_group", "scope_type", "scope_id", "role_name",
            name="uq_idp_group_role_mapping_role",
        ),
        # The group_membership target uniqueness key.
        UniqueConstraint(
            "provider_id", "idp_group", "target_group_id",
            name="uq_idp_group_role_mapping_group_membership",
        ),
        Index("idx_idp_group_role_mapping_group", "idp_group"),
        Index("idx_idp_group_role_mapping_provider_group", "provider_id", "idp_group"),
        CheckConstraint(
            "target_type IN ('role_binding', 'group_membership')",
            name="ck_idp_group_role_mappings_target_type",
        ),
        CheckConstraint(
            # role_binding target requires scope + role; group_membership
            # target requires target_group_id and forbids role columns.
            "(target_type = 'role_binding' "
            " AND role_name IS NOT NULL "
            " AND scope_type IN ('global', 'workspace') "
            " AND ((scope_type = 'global' AND scope_id IS NULL) "
            "      OR (scope_type = 'workspace' AND scope_id IS NOT NULL)) "
            " AND target_group_id IS NULL) "
            "OR (target_type = 'group_membership' "
            "    AND target_group_id IS NOT NULL "
            "    AND role_name IS NULL "
            "    AND scope_type IS NULL "
            "    AND scope_id IS NULL)",
            name="ck_idp_group_role_mappings_target_shape",
        ),
    )

    def __repr__(self) -> str:
        if self.target_type == "group_membership":
            return (
                f"<IdpGroupRoleMapping id={self.id!r} "
                f"group={self.idp_group!r} -> group={self.target_group_id!r}>"
            )
        return (
            f"<IdpGroupRoleMapping id={self.id!r} "
            f"group={self.idp_group!r} role={self.role_name!r} "
            f"{self.scope_type}={self.scope_id!r}>"
        )


# ------------------------------------------------------------------ #
# role_bindings  (the central binding table)                           #
# ------------------------------------------------------------------ #

class RoleBindingORM(Base):
    """Binds a Subject (user|group) to a Role within a Scope (global|workspace).

    No FK on subject_id — it's polymorphic (users.id OR groups.id).
    Referential integrity is enforced in repository code; orphaned
    bindings are pruned by the on-delete handlers on users/groups.

    No FK on scope_id either: it's NULL for global scope and references
    workspaces.id for workspace scope. CASCADE deletion of workspace_id
    bindings is handled in repository code (Phase 2 wires the
    workspace-delete event handler to revoke and remove bindings).
    """
    __tablename__ = "role_bindings"

    id = Column(Text, primary_key=True, default=lambda: f"bnd_{uuid.uuid4().hex[:12]}")
    subject_type = Column(Text, nullable=False)   # user | group
    subject_id = Column(Text, nullable=False)
    role_name = Column(Text, nullable=False)
    scope_type = Column(Text, nullable=False)     # global | workspace
    scope_id = Column(Text, nullable=True)        # NULL for global
    granted_at = Column(Text, nullable=False, default=_now)
    granted_by = Column(Text, nullable=True)      # user_id who created the binding
    # Time-bound bindings: schema-ready in Phase 1, not enforced until Phase 2.
    expires_at = Column(Text, nullable=True)
    # Provenance: 'local' = admin-granted in-app; 'sso' = derived from
    # an IdP group via ``idp_group_role_mappings`` at SSO login. The
    # reconciler only ever touches ``source='sso'`` rows; admin-granted
    # bindings remain authoritative and untouched.
    source = Column(Text, nullable=False, default="local")

    __table_args__ = (
        UniqueConstraint(
            "subject_type", "subject_id", "role_name", "scope_type", "scope_id",
            name="uq_role_binding",
        ),
        # Hot path: PermissionResolver pulls all bindings for a subject.
        Index("idx_role_bindings_subject", "subject_id", "scope_type", "scope_id"),
        # Reverse lookup: "who has access to this workspace?"
        Index("idx_role_bindings_scope", "scope_type", "scope_id"),
        Index("idx_role_bindings_role", "role_name"),
        CheckConstraint(
            "subject_type IN ('user', 'group')",
            name="ck_role_bindings_subject_type",
        ),
        CheckConstraint(
            "scope_type IN ('global', 'workspace')",
            name="ck_role_bindings_scope_type",
        ),
        CheckConstraint(
            # Global scope has NULL scope_id; workspace scope has a value.
            "(scope_type = 'global' AND scope_id IS NULL) "
            "OR (scope_type = 'workspace' AND scope_id IS NOT NULL)",
            name="ck_role_bindings_scope_consistency",
        ),
        CheckConstraint(
            "source IN ('local', 'sso')",
            name="ck_role_bindings_source",
        ),
        # Phase 3 dropped the role_name CHECK constraint — the canonical
        # ``roles`` table is now the source of truth and ``role_repo``
        # enforces referential integrity in app code.
    )

    def __repr__(self) -> str:
        return (
            f"<RoleBinding id={self.id!r} "
            f"{self.subject_type}={self.subject_id!r} "
            f"role={self.role_name!r} "
            f"{self.scope_type}={self.scope_id!r}>"
        )


# ------------------------------------------------------------------ #
# resource_grants  (per-View explicit shares — Layer 3 of view ACL)    #
# ------------------------------------------------------------------ #

class NotificationORM(Base):
    """An in-app notification for one user.

    Written in the SAME transaction as the event it describes, rather
    than derived from the outbox by a relay. Sharing flows are only as
    good as the moment someone learns they were shared with, so the
    notification has to be as durable as the grant or the request that
    caused it — an eventually-consistent fan-out that can silently lag
    (or drop) turns "you have access" into "you have access and nobody
    told you". The outbox keeps carrying the same events for external
    consumers; this table is what the bell reads.
    """
    __tablename__ = "notifications"

    id = Column(Text, primary_key=True, default=lambda: f"ntf_{uuid.uuid4().hex[:12]}")
    user_id = Column(Text, nullable=False)          # recipient
    # Machine kind, e.g. 'view.publish_requested'. Drives the icon and
    # any client-side grouping; the copy lives in title/body.
    kind = Column(Text, nullable=False)
    title = Column(Text, nullable=False)
    body = Column(Text, nullable=True)
    # In-app destination, e.g. '/views/view_abc'. Nullable for purely
    # informational notices.
    link = Column(Text, nullable=True)
    actor_id = Column(Text, nullable=True)          # who caused it
    resource_type = Column(Text, nullable=True)     # 'view' | ...
    resource_id = Column(Text, nullable=True)
    read_at = Column(Text, nullable=True)
    created_at = Column(Text, nullable=False, default=_now)

    __table_args__ = (
        # The bell's only query: this user's newest, unread-first.
        Index("idx_notifications_user_created", "user_id", "created_at"),
        Index("idx_notifications_unread", "user_id", "read_at"),
    )

    def __repr__(self) -> str:
        return f"<Notification id={self.id!r} kind={self.kind!r} user={self.user_id!r}>"


class ResourceGrantORM(Base):
    """Explicit grant of access to a single resource (Phase 1: views only).

    Additive only — a grant extends access to a subject regardless of
    workspace membership. The role_name enum here is intentionally
    narrower than the global role enum: only 'editor' or 'viewer' make
    sense at the resource level. It is NOT FK'd to role_permissions.
    """
    __tablename__ = "resource_grants"

    id = Column(Text, primary_key=True, default=lambda: f"grt_{uuid.uuid4().hex[:12]}")
    resource_type = Column(Text, nullable=False)  # 'view' for now
    resource_id = Column(Text, nullable=False)
    subject_type = Column(Text, nullable=False)   # user | group
    subject_id = Column(Text, nullable=False)
    role_name = Column(Text, nullable=False)      # editor | viewer (narrow)
    granted_at = Column(Text, nullable=False, default=_now)
    granted_by = Column(Text, nullable=True)

    __table_args__ = (
        UniqueConstraint(
            "resource_type", "resource_id", "subject_type", "subject_id",
            name="uq_resource_grant_subject",
        ),
        # Hot path: "what grants exist on this view?"
        Index("idx_resource_grants_resource", "resource_type", "resource_id"),
        # Reverse: "what views does Bob have explicit access to?"
        Index("idx_resource_grants_subject", "subject_type", "subject_id"),
        CheckConstraint(
            "resource_type IN ('view')",
            name="ck_resource_grants_resource_type",
        ),
        CheckConstraint(
            "subject_type IN ('user', 'group')",
            name="ck_resource_grants_subject_type",
        ),
        CheckConstraint(
            "role_name IN ('editor', 'viewer')",
            name="ck_resource_grants_role_name",
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<ResourceGrant id={self.id!r} "
            f"{self.resource_type}={self.resource_id!r} "
            f"{self.subject_type}={self.subject_id!r} "
            f"role={self.role_name!r}>"
        )


# ------------------------------------------------------------------ #
# access_requests  (Phase 4.3 — self-service workspace access asks)    #
# ------------------------------------------------------------------ #

class AccessRequestORM(Base):
    """A user asking a workspace admin for access at a specific role.

    State machine: ``pending`` → ``approved`` | ``denied``. Approval
    atomically creates the corresponding role binding (handled in the
    endpoint). The row stays around in either resolved state so the
    requester can see the resolution + reason on their My Access page.

    No FKs on ``requester_id`` / ``target_id`` — they reference users
    and workspaces respectively but rely on application-level guards
    (and on-delete cascades) the same way ``role_bindings`` does. The
    matching ``role_bindings`` row is the one that actually grants
    access; this table is metadata about the *ask*.
    """
    __tablename__ = "access_requests"

    id = Column(Text, primary_key=True, default=lambda: f"req_{uuid.uuid4().hex[:12]}")
    requester_id = Column(Text, nullable=False)
    target_type = Column(Text, nullable=False)        # only 'workspace' for now
    target_id = Column(Text, nullable=False)
    requested_role = Column(Text, nullable=False)     # must exist in roles table
    justification = Column(Text, nullable=True)
    status = Column(Text, nullable=False, default="pending")
    created_at = Column(Text, nullable=False, default=_now)
    resolved_at = Column(Text, nullable=True)
    resolved_by = Column(Text, nullable=True)
    resolution_note = Column(Text, nullable=True)

    __table_args__ = (
        Index(
            "idx_access_requests_target_status",
            "target_type", "target_id", "status",
        ),
        Index(
            "idx_access_requests_requester_status",
            "requester_id", "status",
        ),
        CheckConstraint(
            "target_type IN ('workspace')",
            name="ck_access_requests_target_type",
        ),
        CheckConstraint(
            "status IN ('pending', 'approved', 'denied')",
            name="ck_access_requests_status",
        ),
        CheckConstraint(
            # Pending rows have no resolution; resolved rows have both
            # a timestamp and (usually) a resolver id.
            "(status = 'pending' AND resolved_at IS NULL AND resolved_by IS NULL) "
            "OR (status IN ('approved', 'denied') AND resolved_at IS NOT NULL)",
            name="ck_access_requests_state_consistency",
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<AccessRequest id={self.id!r} "
            f"requester={self.requester_id!r} "
            f"{self.target_type}={self.target_id!r} "
            f"role={self.requested_role!r} "
            f"status={self.status!r}>"
        )


# ------------------------------------------------------------------ #
# revoked_refresh_jti  (refresh-token rotation tracking)               #
# ------------------------------------------------------------------ #
# invites  (shareable + email-bound signup links)                      #
# ------------------------------------------------------------------ #

class InviteORM(Base):
    """A signup invitation, shareable or pinned to one address.

    The JWT handed to the recipient is a BEARER PROOF; this row is the
    source of truth. Everything the invite grants — role, workspace,
    groups — is read back from here at redemption and never from the
    token payload, so a link that has been revoked or has run out of
    seats cannot be redeemed with a token that is still perfectly valid
    cryptographically. Before this table existed there was nothing to
    consult: a leaked link worked for every reader until it expired, up
    to 90 days later, and left no trace that it had been used.

    ``id`` doubles as the token's ``jti``. No token hash is stored, and
    that is deliberate: unlike a password-reset token — a bare random
    string, hashed in ``user_repo`` so that reading the database cannot
    yield a usable token — an invite's usability is gated by the HMAC
    signature. A database reader cannot forge one, so hashing the id
    would protect nothing and cost a lookup column.
    """
    __tablename__ = "invites"

    id = Column(Text, primary_key=True, default=lambda: f"inv_{uuid.uuid4().hex[:12]}")
    #: NULL = a plain activated account with no role binding.
    role = Column(Text, nullable=True)
    #: Resolved scope for workspace-tier and custom-workspace roles.
    workspace_id = Column(Text, nullable=True)
    #: Pinned address — the link refuses any other. NULL = shareable.
    email = Column(Text, nullable=True)
    #: Restricts a SHAREABLE link to one mail domain ("company.com").
    #: The middle ground between "anyone with the URL" and "one person".
    email_domain = Column(Text, nullable=True)
    group_ids = Column(Text, nullable=False, default="[]")   # JSON list
    shareable_groups_override = Column(Boolean, nullable=False, default=False)
    #: NULL = unlimited until expiry. Otherwise a seat cap.
    max_uses = Column(Integer, nullable=True)
    use_count = Column(Integer, nullable=False, default=0)
    created_by = Column(Text, nullable=False)
    created_at = Column(Text, nullable=False, default=_now)
    expires_at = Column(Text, nullable=False)                # ISO
    revoked_at = Column(Text, nullable=True)
    revoked_by = Column(Text, nullable=True)
    #: Bumped when a link is regenerated. The token carries the version
    #: it was minted at, so raising this invalidates every URL already
    #: handed out WITHOUT discarding the row — which is what lets one
    #: invitation keep a single redemption history across a rotation.
    #: Tokens minted before this column existed carry no version and are
    #: read as version 1, so they keep working.
    token_version = Column(Integer, nullable=False, default=1)

    # No `status` column: revoked / expired / exhausted / active are all
    # derivable from the columns above, and a stored copy is one more
    # thing that can disagree with them.

    __table_args__ = (
        Index("idx_invites_created_by", "created_by", "created_at"),
        Index("idx_invites_expires_at", "expires_at"),
        CheckConstraint("max_uses IS NULL OR max_uses > 0", name="ck_invites_max_uses"),
        CheckConstraint("use_count >= 0", name="ck_invites_use_count"),
        CheckConstraint(
            "revoked_by IS NULL OR revoked_at IS NOT NULL",
            name="ck_invites_revocation_consistency",
        ),
    )

    def __repr__(self) -> str:
        return f"<Invite id={self.id!r} role={self.role!r} uses={self.use_count}/{self.max_uses}>"


# ------------------------------------------------------------------ #
# invite_redemptions  (who actually used a link)                       #
# ------------------------------------------------------------------ #

class InviteRedemptionORM(Base):
    """One row per successful redemption.

    No foreign key on ``user_id``: this is audit history and has to
    survive the user being deleted — the same reasoning as
    ``role_bindings.subject_id`` and ``access_requests.requester_id``.
    ``email`` is denormalised for exactly that case, so a deleted
    account still leaves a legible record of who came in through which
    link.
    """
    __tablename__ = "invite_redemptions"

    id = Column(Text, primary_key=True, default=lambda: f"invr_{uuid.uuid4().hex[:12]}")
    invite_id = Column(
        Text, ForeignKey("invites.id", ondelete="CASCADE"), nullable=False,
    )
    user_id = Column(Text, nullable=False)
    email = Column(Text, nullable=False)
    redeemed_at = Column(Text, nullable=False, default=_now)

    __table_args__ = (
        UniqueConstraint("invite_id", "user_id", name="uq_invite_redemption"),
        Index("idx_invite_redemptions_invite", "invite_id", "redeemed_at"),
    )

    def __repr__(self) -> str:
        return f"<InviteRedemption invite={self.invite_id!r} user={self.user_id!r}>"


# ------------------------------------------------------------------ #
# SUPERSEDED by ``RefreshTokenORM`` below. Retained, unread and
# unwritten, only so a rollback to the previous release finds its table
# where it left it; drop it in a deliberate later revision once
# ``REFRESH_ADOPT_RECORDLESS`` is off and there is no rollback left to
# protect. Note that a rollback would not find rotations performed under
# allow-by-record recorded here, so replay detection would not see them.
#
# Each row recorded a refresh-token jti that had been consumed (rotated)
# or revoked (logout / reuse-detection) — a denylist, in which a token
# was valid unless a row said otherwise.
# Owned by the auth service; will move with it during extraction.

class RevokedRefreshJtiORM(Base):
    __tablename__ = "revoked_refresh_jti"

    jti = Column(Text, primary_key=True)
    family_id = Column(Text, nullable=False)
    revoked_at = Column(Text, nullable=False, default=_now)
    expires_at = Column(Text, nullable=False)  # ISO; rows past this can be GC'd

    # Identity of the token this rotation issued, written in the SAME
    # transaction as the row that consumes ``jti``. A concurrent refresh
    # that loses the race blocks on the primary key until that
    # transaction commits, then reads these back and re-mints the same
    # successor instead of being mistaken for a stolen-chain replay.
    #
    # Claims only, never the signed token: a JWT at rest in the database
    # would be a live credential, whereas these three fields are
    # worthless without the signing key. NULL on family-revoked
    # sentinels and on rows written before the grace window existed —
    # those fall through to reuse detection, which is the old behaviour.
    successor_jti = Column(Text, nullable=True)
    successor_exp = Column(Integer, nullable=True)       # epoch seconds
    successor_mint_ms = Column(BigInteger, nullable=True)  # epoch millis

    __table_args__ = (
        Index("idx_revoked_refresh_family", "family_id"),
        Index("idx_revoked_refresh_expires", "expires_at"),
    )

    def __repr__(self) -> str:
        return f"<RevokedRefreshJti jti={self.jti!r} family={self.family_id!r}>"


# ------------------------------------------------------------------ #
# One row per refresh token that has ever been issued, written at mint.
#
# This is the same state as ``revoked_refresh_jti`` above turned the
# right way up. That table is a DENYLIST: a refresh token is valid
# unless a row says otherwise, so correctness depends on the denylist
# being complete and durable forever — and ``purge_expired`` deletes
# from it. A row lost to an early prune, a failed write, or a restore
# from backup makes a consumed or revoked token valid again.
#
# Here validity is positive: a token is refused unless an active row
# says otherwise. Every failure mode of the storage now points the safe
# way — a missing row signs someone out rather than reviving a
# credential — and pruning an expired row can only reject a token that
# had already expired.
#
# The signed JWT remains the bearer. Going opaque would change the wire
# format, so a rollback would strand every session minted after the
# deploy; flipping *validation* delivers the security property with no
# format change at all.
# Owned by the auth service; will move with it during extraction.

class RefreshTokenORM(Base):
    __tablename__ = "refresh_tokens"

    jti = Column(Text, primary_key=True)
    family_id = Column(Text, nullable=False)
    user_id = Column(Text, nullable=False)

    # The IdP-issued authentication instant for SSO sessions, epoch
    # seconds; NULL for local password logins.
    #
    # Held here rather than trusted from the token because the 24h SSO
    # re-auth ceiling keys off it, and a refresh JWT that simply omits
    # the claim reads as a local session and skips the ceiling entirely.
    # That was a real bug earlier in this work. A server-side value
    # cannot be absent or stale.
    auth_time = Column(Integer, nullable=True)

    # Mint instant in epoch MILLISECONDS, matching the token's ``mat``
    # claim. Millisecond resolution because it is compared against
    # ``users.sessions_valid_from``, and both ends of that comparison
    # routinely land in the same second.
    mint_ms = Column(BigInteger, nullable=False)

    expires_at = Column(Text, nullable=False)   # ISO; the sweep's marker
    created_at = Column(Text, nullable=False, default=_now)

    # Set when this token is rotated away. Consumption is the UPDATE
    # itself — conditional on this being NULL — so two concurrent
    # refreshes cannot both succeed.
    consumed_at = Column(Text, nullable=True)

    # What this token rotated into. The successor's own row carries its
    # expiry and mint instant, so nothing is denormalised here: the
    # grace window follows this pointer and reads that row.
    successor_jti = Column(Text, nullable=True)

    # Set by logout and by reuse detection, across the whole family. It
    # replaces the ``family-revoked:<id>`` sentinel row, whose expiry had
    # to be hand-sized to outlive every token it guarded.
    revoked_at = Column(Text, nullable=True)

    __table_args__ = (
        Index("idx_refresh_tokens_family", "family_id"),
        Index("idx_refresh_tokens_user", "user_id"),
        Index("idx_refresh_tokens_expires", "expires_at"),
    )

    def __repr__(self) -> str:
        return f"<RefreshToken jti={self.jti!r} family={self.family_id!r}>"


# ------------------------------------------------------------------ #
# outbox_events  (transactional outbox for domain events)              #
# ------------------------------------------------------------------ #

class AnnouncementORM(Base):
    __tablename__ = "announcements"

    id = Column(Text, primary_key=True, default=lambda: f"ann_{uuid.uuid4().hex[:12]}")
    title = Column(Text, nullable=False)
    message = Column(Text, nullable=False)
    banner_type = Column(Text, nullable=False, default="info")        # info | warning | success
    is_active = Column(Boolean, nullable=False, default=True)
    is_dismissible = Column(Boolean, nullable=False, default=True)        # legacy; kept for DB compat
    snooze_duration_minutes = Column(Integer, nullable=False, default=0)  # 0 = no snooze allowed
    cta_text = Column(Text, nullable=True)                            # call-to-action button label
    cta_url = Column(Text, nullable=True)                             # call-to-action URL
    created_by = Column(Text, nullable=True)                          # admin user_id who created
    updated_by = Column(Text, nullable=True)                          # admin user_id who last updated
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    __table_args__ = (
        Index("idx_announcements_is_active", "is_active"),
        CheckConstraint(
            "banner_type IN ('info', 'warning', 'success')",
            name="ck_announcements_banner_type",
        ),
    )

    def __repr__(self) -> str:
        return f"<Announcement id={self.id!r} title={self.title!r} active={self.is_active}>"


# ------------------------------------------------------------------ #
# announcement_config  (single-row global settings for the banner)     #
# ------------------------------------------------------------------ #

class AnnouncementConfigORM(Base):
    __tablename__ = "announcement_config"

    id = Column(Integer, primary_key=True, default=1)
    poll_interval_seconds = Column(Integer, nullable=False, default=15)        # how often users poll for updates
    default_snooze_minutes = Column(Integer, nullable=False, default=30)       # default snooze duration for new announcements
    updated_by = Column(Text, nullable=True)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)

    __table_args__ = (
        CheckConstraint("id = 1", name="single_row_announcement_config"),
    )

    def __repr__(self) -> str:
        return f"<AnnouncementConfig poll={self.poll_interval_seconds}s snooze={self.default_snooze_minutes}m>"


# ------------------------------------------------------------------ #
# outbox_events  (transactional outbox for domain events)              #
# ------------------------------------------------------------------ #

class OutboxEventORM(Base):
    __tablename__ = "outbox_events"

    id = Column(Text, primary_key=True, default=lambda: f"evt_{uuid.uuid4().hex[:12]}")
    event_type = Column(Text, nullable=False)         # e.g. user.created, user.approved
    # Phase 1.5 §1.5.6 — domain-prefixed event payload contract.
    event_version = Column(Integer, nullable=False, default=1, server_default="1")  # payload schema version
    aggregate_type = Column(Text, nullable=True)      # e.g. "workspace", "ontology"
    aggregate_id = Column(Text, nullable=True)        # the entity id this event refers to
    payload = Column(Text, nullable=False, default="{}")  # JSON
    processed = Column(Boolean, nullable=False, default=False)
    created_at = Column(Text, nullable=False, default=_now)

    __table_args__ = (
        Index("idx_outbox_processed_created", "processed", "created_at"),
        Index("idx_outbox_aggregate", "aggregate_type", "aggregate_id"),
        Index("idx_outbox_event_type", "event_type"),
    )

    def __repr__(self) -> str:
        return f"<OutboxEvent id={self.id!r} type={self.event_type!r}>"


# ------------------------------------------------------------------ #
# auth_audit_log  (append-only audit trail, drained from the outbox)   #
# ------------------------------------------------------------------ #

class AuthAuditLogORM(Base):
    """Immutable record of every domain event the outbox relay drains.

    Append-only: rows are inserted by the relay and never updated or
    deleted. ``source_event_id`` is the originating outbox event id and
    is UNIQUE so a relay re-run after a crash cannot double-record.
    """
    __tablename__ = "auth_audit_log"

    id = Column(Text, primary_key=True, default=lambda: f"aud_{uuid.uuid4().hex[:12]}")
    source_event_id = Column(Text, nullable=False)   # OutboxEventORM.id
    event_type = Column(Text, nullable=False)
    aggregate_type = Column(Text, nullable=True)
    aggregate_id = Column(Text, nullable=True)
    payload = Column(Text, nullable=False, default="{}")  # JSON (verbatim)
    occurred_at = Column(Text, nullable=False)       # source event created_at
    recorded_at = Column(Text, nullable=False, default=_now)

    __table_args__ = (
        UniqueConstraint("source_event_id", name="uq_auth_audit_source_event"),
        Index("idx_auth_audit_event_type", "event_type"),
        Index("idx_auth_audit_recorded_at", "recorded_at"),
    )

    def __repr__(self) -> str:
        return f"<AuthAuditLog id={self.id!r} type={self.event_type!r}>"


# ------------------------------------------------------------------ #
# schema_migrations  (tracks one-time data-fix migrations)            #
# ------------------------------------------------------------------ #

class SchemaMigrationORM(Base):
    __tablename__ = "schema_migrations"

    key = Column(Text, primary_key=True)
    applied_at = Column(Text, nullable=False, default=_now)


# ------------------------------------------------------------------ #
# refresh_events  (append-only audit trail — OPS Freshness Cockpit)   #
# ------------------------------------------------------------------ #

class RefreshEventORM(Base):
    """Immutable record of one freshness/refresh operation.

    Covers every origin (script, connector, api, drift, reconcile) and
    scope (auto, read-caches, rollups, full, batch-item, clear) — the durable
    source of truth for "when did this data source last refresh and what
    happened", read by the per-source history and the fleet freshness
    view. Emission is best-effort (see ``refresh_events_repo.emit_refresh_event``)
    and must never block or fail the operation it records.
    """
    __tablename__ = "refresh_events"

    id = Column(Text, primary_key=True, default=lambda: uuid.uuid4().hex)
    ts = Column(Text, nullable=False, default=_now, index=True)
    workspace_id = Column(Text, nullable=True)
    data_source_id = Column(Text, nullable=False)
    provider_id = Column(Text, nullable=True)
    origin = Column(Text, nullable=False)      # script|connector|api|drift|reconcile|reconcile-sweep
    actor = Column(Text, nullable=False, default="internal")
    scope = Column(Text, nullable=False)       # auto|read-caches|rollups|full|batch-item|clear
    gate = Column(Text, nullable=False)        # changed|unchanged|forced|n/a
    actions = Column(Text, nullable=True)      # JSON: what was acted on
    outcome = Column(Text, nullable=False)     # accepted|deferred|noop|conflict|error|completed|failed
    detail = Column(Text, nullable=True)
    # WHY the reconciliation sweep acted — one of the typed detector codes in
    # ``services/aggregation/reconcile.REASONS``. Deliberately unconstrained
    # (like ``detail``) so adding a detector later needs no migration.
    reason = Column(Text, nullable=True)
    # JSON evidence behind ``reason``: observed vs expected AGGREGATED edges,
    # raw node/edge counts before → after, both fingerprints, and how old the
    # stats row was. Kept OUT of ``actions``, which is contractually "what the
    # signal DID" and is a List[str] on the wire.
    evidence = Column(Text, nullable=True)

    __table_args__ = (
        Index("idx_refresh_events_ds_ts", "data_source_id", "ts"),
        CheckConstraint(
            # 'reconcile' is the stale-marker reconciler in scheduler.py;
            # 'reconcile-sweep' is the drift / overlay-integrity sweep. They
            # are different subsystems and the UI distinguishes them, so the
            # new one gets its own value rather than reusing the old.
            "origin IN ('script', 'connector', 'api', 'drift', 'reconcile', "
            "'reconcile-sweep')",
            name="ck_refresh_events_origin",
        ),
        CheckConstraint(
            "scope IN ('auto', 'read-caches', 'rollups', 'full', 'batch-item', "
            "'clear')",
            name="ck_refresh_events_scope",
        ),
        CheckConstraint(
            "gate IN ('changed', 'unchanged', 'forced', 'n/a')",
            name="ck_refresh_events_gate",
        ),
        CheckConstraint(
            "outcome IN ('accepted', 'deferred', 'noop', 'conflict', 'error', "
            "'completed', 'failed')",
            name="ck_refresh_events_outcome",
        ),
    )

    def __repr__(self) -> str:
        return f"<RefreshEvent id={self.id!r} ds={self.data_source_id!r} outcome={self.outcome!r}>"


# ------------------------------------------------------------------ #
# Cross-domain registration                                             #
# ------------------------------------------------------------------ #
# Domain-owned ORM modules live next to their service code (e.g.,
# AggregationJobORM under services/aggregation/). Import them here so
# `Base.metadata` is fully populated whenever this module is imported —
# Alembic, tests, and any consumer all see the complete schema.
from backend.app.services.aggregation import models as _aggregation_models  # noqa: E402,F401

