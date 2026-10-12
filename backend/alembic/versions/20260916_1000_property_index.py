"""The ``propidx`` schema: the property side index that lifts FalkorDB's cap.

Revision ID: 20260916_1000_property_index
Revises: 20260915_1100_show_rollup_edges
Create Date: 2026-09-16 10:00

FalkorDB numbers every distinct property name with a 16-bit id it never
frees, and our writers made property names data: a 241k-node source with
~65,000 distinct keys filled the table and its rollups could no longer be
written. See ``docs/PROPERTY_STORAGE.md``. The decision (E+) keeps the graph
for topology and a constant set of attribute names, and puts the COMPLETE
user bag of every node here, one LIST partition per physical graph, with
an expression GIN over a case-folded copy so equality and existence on any
key are index seeks. Predicates, sort, distinct and key discovery are
answered here and enter FalkorDB as per-label URN seeks.

This revision is the SOURCE OF TRUTH for the DDL. ``propidx_models.py``
mirrors it for inspection, but ``create_all`` can never produce it: the
GIN indexes an expression over the ``propidx.ci`` function, which only
this revision creates, and the parent is partitioned. Partitions
themselves are created lazily, per graph, by ``PostgresPropertyIndex.
ensure_partition`` — the versioning schema's programmatic hash partitions
are the precedent.

Inspector-guarded like its siblings so a re-run creates only what is
missing. Tables are checked through the inspector; the schema, the
function and the indexes use the DDL's own ``IF NOT EXISTS`` / ``OR
REPLACE`` forms, which is the same guard without depending on how the
inspector reflects an expression index on a partitioned parent.

``pg_trgm`` is NOT required here: it is only needed by the phase-2
trigram hot index, which creates its own extension when it lands.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260916_1000_property_index"
down_revision: Union[str, None] = "20260915_1100_show_rollup_edges"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SCHEMA = "propidx"

# Case-folds every string value of a bag and leaves every other value as it
# is. IMMUTABLE so it can sit under an expression index; PARALLEL SAFE so a
# parallel scan may evaluate it. The empty-object COALESCE keeps ``{}`` bags
# indexable: ``jsonb_object_agg`` over zero rows is NULL, and a NULL key
# would be invisible to ``@>``.
_CI_FUNCTION = f"""
CREATE OR REPLACE FUNCTION {_SCHEMA}.ci(p jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(
    jsonb_object_agg(
      k,
      CASE WHEN jsonb_typeof(v) = 'string' THEN to_jsonb(lower(v #>> '{{}}')) ELSE v END
    ),
    '{{}}'::jsonb)
  FROM jsonb_each(p) AS e(k, v)
$$
"""

# (table, DDL) in creation order.
_TABLES: tuple[tuple[str, str], ...] = (
    (
        "node_props",
        f"""
CREATE TABLE {_SCHEMA}.node_props (
  graph_key    text NOT NULL,
  urn          text NOT NULL,
  entity_type  text NOT NULL,
  props        jsonb NOT NULL,
  tags         jsonb NOT NULL DEFAULT '[]',
  content_hash text NOT NULL,
  load_epoch   bigint NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (graph_key, urn)
) PARTITION BY LIST (graph_key)
""",
    ),
    (
        "prop_keys",
        f"""
CREATE TABLE {_SCHEMA}.prop_keys (
  graph_key    text NOT NULL,
  entity_type  text NOT NULL,
  key          text NOT NULL,
  node_count   bigint DEFAULT 0,
  kinds        text[] DEFAULT '{{}}',
  samples      jsonb DEFAULT '[]',
  refreshed_at timestamptz,
  PRIMARY KEY (graph_key, entity_type, key)
)
""",
    ),
    (
        "graph_state",
        f"""
CREATE TABLE {_SCHEMA}.graph_state (
  graph_key        text PRIMARY KEY,
  storage_version  smallint NOT NULL CHECK (storage_version IN (1, 2)),
  status           text NOT NULL CHECK (status IN ('building', 'ready', 'failed')),
  load_epoch       bigint NOT NULL DEFAULT 0,
  declared_ready   jsonb NOT NULL DEFAULT '[]',
  row_count        bigint,
  progress         jsonb,
  last_built_at    timestamptz,
  last_verified_at timestamptz,
  last_error       text,
  updated_at       timestamptz NOT NULL DEFAULT now()
)
""",
    ),
    (
        "hot_indexes",
        f"""
CREATE TABLE {_SCHEMA}.hot_indexes (
  graph_key  text NOT NULL,
  key        text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('text', 'numeric', 'trgm')),
  index_name text NOT NULL,
  status     text NOT NULL,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (graph_key, key, kind)
)
""",
    ),
)

# An index on the partitioned parent is inherited by every partition
# attached later, so the per-graph partitions need no DDL of their own.
_INDEXES: tuple[str, ...] = (
    # @> for case-folded equality / IN, ? for existence, on any key.
    f"CREATE INDEX IF NOT EXISTS ix_np_ci_gin ON {_SCHEMA}.node_props "
    f"USING gin (({_SCHEMA}.ci(props)) jsonb_ops)",
    # Per-label anchor buckets and the entity-type scope pushdown.
    f"CREATE INDEX IF NOT EXISTS ix_np_type ON {_SCHEMA}.node_props "
    f"(graph_key, lower(entity_type))",
    # The epoch sweep after a full seed.
    f"CREATE INDEX IF NOT EXISTS ix_np_epoch ON {_SCHEMA}.node_props "
    f"(graph_key, load_epoch)",
    # Key typeahead: text_pattern_ops serves LIKE 'prefix%' regardless of
    # the database collation.
    f"CREATE INDEX IF NOT EXISTS ix_pk_prefix ON {_SCHEMA}.prop_keys "
    f"(graph_key, key text_pattern_ops)",
)


def upgrade() -> None:
    bind = op.get_bind()
    op.execute(sa.text(f"CREATE SCHEMA IF NOT EXISTS {_SCHEMA}"))
    op.execute(sa.text(_CI_FUNCTION))

    inspector = sa.inspect(bind)
    for table, ddl in _TABLES:
        if not inspector.has_table(table, schema=_SCHEMA):
            op.execute(sa.text(ddl))

    for ddl in _INDEXES:
        op.execute(sa.text(ddl))


def downgrade() -> None:
    # CASCADE takes the partitions, the indexes and the function with it.
    op.execute(sa.text(f"DROP SCHEMA IF EXISTS {_SCHEMA} CASCADE"))
