"""``graphver.bootstrap_review`` — what an "enable version control" copy holds for a decision.

A source graph can hold what version history can't keep exactly as it is: one connection held
more than once with different properties (history keeps one connection per source, type and
target), or a value JSONB can't store (NaN, ±Infinity, a NUL character). Such a copy used to drop
the extra connections silently, or fail with an infrastructure error. It now holds them here and
pauses before anything goes live, so a person decides: keep one version, merge them (some
versions or properties left out), store the values as text — or fix the source and re-check.

The ORM (``versioning/models.BootstrapReviewORM``) declares the same table, so ``create_all``
covers fresh databases and a separate ``GRAPHVER_DB_URL``; this migration covers existing ones.

Revision ID: 20261202_1000_bootstrap_review
Revises: 20261201_1000_ontology_create
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20261202_1000_bootstrap_review"
down_revision: Union[str, None] = "20261201_1000_ontology_create"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    # A database installed at head has no graphver schema until the versioning worker's bootstrap
    # (create_schema_and_partitions) creates it, and that builds this table from the models.
    if not sa.inspect(bind).has_table("jobs", schema=schema):
        return
    bind.execute(sa.text(
        f'CREATE TABLE IF NOT EXISTS "{schema}"."bootstrap_review" ('
        "graph_id text NOT NULL, kind text NOT NULL, entity_id text NOT NULL, "
        "seq integer NOT NULL, detail jsonb NOT NULL, choice jsonb, "
        "CONSTRAINT pk_bootstrap_review PRIMARY KEY (graph_id, kind, entity_id, seq))"))


def downgrade() -> None:
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    bind.execute(sa.text(f'DROP TABLE IF EXISTS "{schema}"."bootstrap_review"'))
