"""``graphver.key_index`` and ``graphver.entity_keys``: the properties imports match nodes by.

An import names what its rows find their entities by (``identifier``); with ``prop.<name>`` it is a
property of the nodes, such as ``external_id``. ``entity_keys`` holds, for each such property, every
node of a graph's main that holds a value of it; ``key_index`` how far each is caught up (a main
commit). The first import naming a property builds its index from main's live nodes; each later one
catches it up from main's version log first, so no write path changes.

Two new, empty tables with no foreign key: creating them locks nothing in use, and the upgrade is
safe to re-run. ``create_schema_and_partitions`` creates them from the models for a separate
``GRAPHVER_DB_URL`` alembic never reaches. The downgrade drops them: the next import naming a
property builds its index again.

Revision ID: 20261112_1500_gv_entity_keys
Revises: 20261112_1400_gv_job_mass_delete
Create Date: 2026-11-12 15:00
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20261112_1500_gv_entity_keys"
down_revision: Union[str, None] = "20261112_1400_gv_job_mass_delete"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    if not sa.inspect(bind).has_schema(schema):
        return                              # create_schema_and_partitions builds them
    bind.execute(sa.text(
        f'CREATE TABLE IF NOT EXISTS "{schema}"."key_index" ('
        "graph_id text NOT NULL, key_name text NOT NULL, status text NOT NULL, "
        "seq bigint NOT NULL, cursor text, created_at text NOT NULL, created_by_job text, "
        "CONSTRAINT pk_key_index PRIMARY KEY (graph_id, key_name), "
        "CONSTRAINT ck_key_index_status CHECK (status IN ('building','ready')))"))
    bind.execute(sa.text(
        f'CREATE TABLE IF NOT EXISTS "{schema}"."entity_keys" ('
        "graph_id text NOT NULL, key_name text NOT NULL, key_value text NOT NULL, "
        "entity_id text NOT NULL, live boolean NOT NULL, "
        "CONSTRAINT pk_entity_keys PRIMARY KEY (graph_id, key_name, key_value, entity_id))"))
    bind.execute(sa.text(
        f'CREATE INDEX IF NOT EXISTS ix_entity_keys_entity ON "{schema}"."entity_keys" '
        "(graph_id, key_name, entity_id)"))


def downgrade() -> None:
    schema = gv_config.graphver_schema()
    bind = op.get_bind()
    bind.execute(sa.text(f'DROP TABLE IF EXISTS "{schema}"."entity_keys"'))
    bind.execute(sa.text(f'DROP TABLE IF EXISTS "{schema}"."key_index"'))
