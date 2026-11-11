"""``graphver.projection_quarantine``: projector statements that still failed for one entity.

A projector statement that still times out for a single entity, after its retries, used to fail
the pass, and with it every later pass of the graph. It is now held in this table, and the rest of
its window lands and publishes. Each later pass retries the graph's rows first; one that lands, or
a newer write of the same entity that lands, removes it.

* ``projection_state.quarantine_next_at`` — when the graph's quarantined entities are next
  retried, NULL when it holds none: what a pass and the poll read, so a graph with nothing held
  costs no query of the table. Nullable with no default: a catalog change, with no rewrite.

A new, empty table with no foreign key, so creating it locks nothing in use; the column's ALTER is
bounded like the others (``_bound_lock_wait``), and the upgrade is safe to re-run. Both are
mirrored at start-up (``create_schema_and_partitions``, ``models._ensure_schema_upgrades``) for a
separate ``GRAPHVER_DB_URL`` alembic never reaches. The downgrade drops them: held entities stay
unprojected until the next pass that writes them, or a rebuild.

Revision ID: 20261112_1000_gv_proj_quarantine
Revises: 20261111_1000_gv_draft_prune
Create Date: 2026-11-12 10:00
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_ps_quarantine_column

revision: str = "20261112_1000_gv_proj_quarantine"
down_revision: Union[str, None] = "20261111_1000_gv_draft_prune"
branch_labels = None
depends_on = None


def _bound_lock_wait() -> None:
    """Wait at most five seconds for ``projection_state``'s lock: every projection pass writes it,
    so a long holder makes the upgrade give up, to be run again, rather than queue them."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    bind = op.get_bind()
    if not sa.inspect(bind).has_schema(gv_config.graphver_schema()):
        return                              # create_schema_and_partitions builds both
    _bound_lock_wait()
    bind.execute(sa.text(
        f'CREATE TABLE IF NOT EXISTS "{gv_config.graphver_schema()}"."projection_quarantine" ('
        "graph_id text NOT NULL, statement text NOT NULL, entity_key text NOT NULL, "
        "entity_kind text NOT NULL, cypher text NOT NULL, params jsonb NOT NULL, error text, "
        "attempts integer NOT NULL, first_at text NOT NULL, last_at text NOT NULL, "
        "CONSTRAINT pk_projection_quarantine PRIMARY KEY (graph_id, statement, entity_key), "
        "CONSTRAINT ck_projection_quarantine_kind CHECK (entity_kind IN ('node','edge')))"))
    ensure_ps_quarantine_column(bind)


def downgrade() -> None:
    _bound_lock_wait()
    schema = gv_config.graphver_schema()
    bind = op.get_bind()
    bind.execute(sa.text(f'DROP TABLE IF EXISTS "{schema}"."projection_quarantine"'))
    bind.execute(sa.text(f'ALTER TABLE "{schema}"."projection_state" '
                         "DROP COLUMN IF EXISTS quarantine_next_at"))
