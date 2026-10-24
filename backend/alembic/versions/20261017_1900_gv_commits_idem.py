"""``commits``: one commit per idempotency key on a branch (``uq_commits_idem``).

A canvas save sent with an ``Idempotency-Key`` stores it on its commit, and a retry with the key
answers with that commit instead of applying the batch again. Two attempts racing past the lookup
are settled by this partial unique index on ``(graph_id, branch_id, idempotency_key)``.

Before the build, a later commit sharing its key with an earlier one on the same branch has the
key cleared (logged): bulk, sync and bootstrap look before they insert, so two could race in, and
every lookup returns one row anyway. ``ix_commits_idem`` stays for the graph-scoped lookups. The
plain build locks ``commits`` for as long as it takes over the keyed rows; the wait for that
lock is bounded (``_bound_lock_wait``).

Mirrored in ``models._ensure_schema_upgrades`` (in a savepoint there: a worker starts without the
index rather than not at all) for a separate ``GRAPHVER_DB_URL`` alembic never reaches.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_commits_idem_index

revision: str = "20261017_1900_gv_commits_idem"
down_revision: Union[str, None] = "20261017_1550_gv_ps_fencing"
branch_labels = None
depends_on = None


def _bound_lock_wait() -> None:
    """Wait at most five seconds for the table's lock: every save writes ``commits``, so a long
    holder makes the upgrade give up, to be run again, rather than queue those writes behind it."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    ensure_commits_idem_index(op.get_bind())


def downgrade() -> None:
    _bound_lock_wait()
    op.get_bind().execute(sa.text(
        f'DROP INDEX IF EXISTS "{gv_config.graphver_schema()}".uq_commits_idem'))
