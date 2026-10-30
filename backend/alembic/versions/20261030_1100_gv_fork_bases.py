"""``graphver.fork_bases``: the parent seq a fork's ``main`` reads from each fork seq on.

A fork read its parent at one seq, ``graphs.fork_base_commit_seq``, whatever seq of the fork was
read. Update from parent needs a fork to read its parent at a later seq from the commit that takes
it on, and its earlier commits where they were, so the base is kept per commit: one row per base a
fork took, ``(fork_graph_id, fork_seq, parent_seq)``. A read of the fork at seq S composes the
parent at the ``parent_seq`` of the latest row with ``fork_seq <= S``, or at S before the first.

A new table with a foreign key to ``graphs`` (``ON DELETE CASCADE``: a purge takes a fork's rows
with it), and one row per existing fork with a fork point: ``(id, fork_base_commit_seq,
fork_base_commit_seq)``, as its genesis commit sits there. Creating the key locks ``graphs``, which
every main commit writes, so the wait for it is bounded (``_bound_lock_wait``); the upgrade is
safe to re-run.

The downgrade drops the table: every fork reads its parent at its fork point again, as only the
fork point exists until Update from parent.

Mirrored in ``models._ensure_schema_upgrades`` for a separate ``GRAPHVER_DB_URL`` alembic never
reaches.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_fork_bases

revision: str = "20261030_1100_gv_fork_bases"
down_revision: Union[str, None] = "20261030_1000_gv_mr_merged_seq"
branch_labels = None
depends_on = None


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: the foreign key locks ``graphs``, which every main
    commit writes, so a long holder makes the upgrade give up, to be run again, rather than queue
    those commits behind it."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    ensure_fork_bases(op.get_bind())


def downgrade() -> None:
    _bound_lock_wait()
    op.get_bind().execute(sa.text(f'DROP TABLE IF EXISTS "{gv_config.graphver_schema()}"."fork_bases"'))
