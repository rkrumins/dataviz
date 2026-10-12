"""``propidx`` ORM — the property side index, mirrored for inspection.

The alembic revision ``20260916_1000_property_index`` is the SOURCE OF
TRUTH for this schema; these classes exist so the tables can be reflected,
compared and queried through metadata like every other schema in the tree.
They cannot build it: ``ix_np_ci_gin`` indexes an expression over the
``propidx.ci`` function that only the revision creates, and ``node_props``
is LIST-partitioned per physical graph with partitions created lazily by
``PostgresPropertyIndex.ensure_partition`` — so ``create_all`` on a bare
database fails on the function, and on a migrated one has nothing to do.

Own declarative base, deliberately. The management ``Base`` is
``create_all``ed by ``0001_baseline``; registering a partitioned table
with a function-backed index there would break a fresh environment's
first migration the moment anything imported this module. The versioning
schema separates its metadata for the same reason.

Conventions follow ``services/versioning/models.py``: no cross-schema
foreign keys, ``graph_key`` is a logical reference to a physical FalkorDB
graph (``host:port:graph_name``, the provider's ``_cache_ns`` identity),
and the partition key leads every primary key because Postgres requires
it there.
"""
from __future__ import annotations

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Column,
    DateTime,
    Index,
    PrimaryKeyConstraint,
    SmallInteger,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import DeclarativeBase

SCHEMA = "propidx"


class PropIdxBase(DeclarativeBase):
    """Declarative base for every ``propidx`` table (separate metadata)."""


class NodePropsORM(PropIdxBase):
    """The complete user bag of one node, on the graph's partition."""

    __tablename__ = "node_props"

    graph_key = Column(Text, nullable=False)
    urn = Column(Text, nullable=False)
    entity_type = Column(Text, nullable=False)      # physical label, casing as written
    props = Column(JSONB, nullable=False)           # the complete user bag
    tags = Column(JSONB, nullable=False, server_default=text("'[]'"))
    content_hash = Column(Text, nullable=False)     # blake2b-16 of canonical JSON
    load_epoch = Column(BigInteger, nullable=False)  # rows below the graph's epoch are stale
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=text("now()"))

    __table_args__ = (
        PrimaryKeyConstraint("graph_key", "urn"),
        Index(
            "ix_np_ci_gin", text(f"({SCHEMA}.ci(props)) jsonb_ops"),
            postgresql_using="gin",
        ),
        Index("ix_np_type", "graph_key", text("lower(entity_type)")),
        Index("ix_np_epoch", "graph_key", "load_epoch"),
        {"schema": SCHEMA, "postgresql_partition_by": "LIST (graph_key)"},
    )


class PropKeysORM(PropIdxBase):
    """Key discovery: every (label, key) a graph carries, with counts and samples."""

    __tablename__ = "prop_keys"

    graph_key = Column(Text, nullable=False)
    entity_type = Column(Text, nullable=False)
    key = Column(Text, nullable=False)
    node_count = Column(BigInteger, server_default=text("0"))
    kinds = Column(ARRAY(Text), server_default=text("'{}'"))
    samples = Column(JSONB, server_default=text("'[]'"))
    refreshed_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        PrimaryKeyConstraint("graph_key", "entity_type", "key"),
        Index("ix_pk_prefix", "graph_key", text("key text_pattern_ops")),
        {"schema": SCHEMA},
    )


class GraphStateORM(PropIdxBase):
    """Routing truth per physical graph: which storage version, and whether it is ready."""

    __tablename__ = "graph_state"

    graph_key = Column(Text, primary_key=True)
    storage_version = Column(SmallInteger, nullable=False)  # 1 legacy, 2 side index
    status = Column(Text, nullable=False)
    load_epoch = Column(BigInteger, nullable=False, server_default=text("0"))
    declared_ready = Column(JSONB, nullable=False, server_default=text("'[]'"))
    row_count = Column(BigInteger, nullable=True)
    progress = Column(JSONB, nullable=True)
    last_built_at = Column(DateTime(timezone=True), nullable=True)
    last_verified_at = Column(DateTime(timezone=True), nullable=True)
    last_error = Column(Text, nullable=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=text("now()"))

    __table_args__ = (
        CheckConstraint("storage_version IN (1, 2)", name="graph_state_storage_version_check"),
        CheckConstraint(
            "status IN ('building', 'ready', 'failed')", name="graph_state_status_check"
        ),
        {"schema": SCHEMA},
    )


class HotIndexORM(PropIdxBase):
    """A per-(graph, key) expression index promoted on the partition."""

    __tablename__ = "hot_indexes"

    graph_key = Column(Text, nullable=False)
    key = Column(Text, nullable=False)
    kind = Column(Text, nullable=False)
    index_name = Column(Text, nullable=False)
    status = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=text("now()"))

    __table_args__ = (
        PrimaryKeyConstraint("graph_key", "key", "kind"),
        CheckConstraint("kind IN ('text', 'numeric', 'trgm')", name="hot_indexes_kind_check"),
        {"schema": SCHEMA},
    )
