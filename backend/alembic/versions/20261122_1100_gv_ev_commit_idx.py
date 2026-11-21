"""``edge_versions``: a commit's edges by ``(graph_id, commit_id)`` (``ix_ev_commit``).

``node_versions`` has ``ix_nv_commit``; ``edge_versions`` had nothing to find a commit's rows by,
so what reads the edges one commit wrote — a retried save's, a publish's audit of the bulk jobs it
takes — scanned the table's partitions. The build locks each partition of ``edge_versions``
against writes for as long as it takes over its rows, so run the upgrade in a quiet window; the
wait for that lock is bounded (``_bound_lock_wait``).

Mirrored in ``models._ensure_schema_upgrades`` (in a savepoint there: a worker starts without the
index rather than not at all) for a separate ``GRAPHVER_DB_URL`` alembic never reaches.

Revision ID: 20261122_1100_gv_ev_commit_idx
Revises: 20261121_1000_gv_property_jobs
Create Date: 2026-11-22 11:00
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_ev_commit_index

revision: str = "20261122_1100_gv_ev_commit_idx"
down_revision: Union[str, None] = "20261121_1000_gv_property_jobs"
branch_labels = None
depends_on = None


def _bound_lock_wait() -> None:
    """Wait at most five seconds for the table's lock: every save writes ``edge_versions``, so a
    long holder makes the upgrade give up, to be run again, rather than queue those writes behind
    it."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    ensure_ev_commit_index(op.get_bind())


def downgrade() -> None:
    _bound_lock_wait()
    op.get_bind().execute(sa.text(
        f'DROP INDEX IF EXISTS "{gv_config.graphver_schema()}".ix_ev_commit'))
