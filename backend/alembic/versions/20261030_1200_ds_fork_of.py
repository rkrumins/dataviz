"""A fork's data source: ``workspace_data_sources.fork_of_data_source_id``.

A fork of a versioned graph becomes a data source of its own: a row keyed by the fork graph's
``dsfork_…`` id, in its parent's workspace and provider, its governing settings copied from the
parent's and kept in step with them. This column names the data source it was forked from (``ON
DELETE RESTRICT``: a parent row goes only after its forks' rows), with its index, and
``ck_ds_fork_no_key``: a fork's row names no FalkorDB graph — it reads through versioning, never a
key of its own. The partial unique index on (workspace, provider, graph_name) is unaffected: NULL
graph names never collide.

Most requests read the table, so the wait for its lock is bounded (``_bound_lock_wait``). Guarded
DDL, safe to re-run; the check is swapped in.

The downgrade refuses while fork rows exist: the code before this revision reads a data source
that names no graph from the provider's default graph, so a fork row left behind would read, and
could write, a graph that is not the fork's. Delete them first (a fork's graph keeps working
without its row under that code, as it did before).
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261030_1200_ds_fork_of"
down_revision: Union[str, None] = "20261030_1100_gv_fork_bases"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "workspace_data_sources"


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: giving up (to be run again) beats queueing every
    request that reads a data source behind a long transaction."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    op.execute(
        f"ALTER TABLE {_TABLE} ADD COLUMN IF NOT EXISTS fork_of_data_source_id TEXT "
        f"REFERENCES {_TABLE} (id) ON DELETE RESTRICT"
    )
    op.create_index("idx_ds_fork_of", _TABLE, ["fork_of_data_source_id"], if_not_exists=True)
    op.execute(f"ALTER TABLE {_TABLE} DROP CONSTRAINT IF EXISTS ck_ds_fork_no_key")
    op.create_check_constraint(
        "ck_ds_fork_no_key", _TABLE, "fork_of_data_source_id IS NULL OR graph_name IS NULL")


def downgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()
    if "fork_of_data_source_id" in {c["name"] for c in sa.inspect(bind).get_columns(_TABLE)}:
        forks = bind.execute(sa.text(
            f"SELECT count(*) FROM {_TABLE} WHERE fork_of_data_source_id IS NOT NULL")).scalar()
        if forks:
            raise RuntimeError(
                f"{forks} fork data source row(s) exist; the code before 20261030_1200_ds_fork_of "
                "would read them from the provider's default graph. Delete them first: DELETE "
                f"FROM {_TABLE} WHERE fork_of_data_source_id IS NOT NULL (their graphs stay).")
    op.execute(f"ALTER TABLE {_TABLE} DROP CONSTRAINT IF EXISTS ck_ds_fork_no_key")
    op.execute("DROP INDEX IF EXISTS idx_ds_fork_of")
    op.execute(f"ALTER TABLE {_TABLE} DROP COLUMN IF EXISTS fork_of_data_source_id")
