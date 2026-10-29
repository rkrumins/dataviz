"""``jobs``: one import pending or running per draft (``uq_jobs_ingest_active``).

Two imports on one draft interleave their windows, and a replace among them deletes what the other
writes; a second import onto a busy draft is refused with ``JobActive`` (409 ``job_active``), and
this partial unique index on ``branch_id`` settles two that race past each other.

Before the build, the imports nothing will run are failed by the transfer lane's reaper rules
(never queued for an hour, or queued past ``TRANSFER_QUEUE_TIMEOUT_SECS``), and of the imports
queued on one draft the earliest keeps it while a later one that never started is failed. Imports
still running together on one draft are never failed here: the upgrade stops and names them, to
be run again once they finish. The wait for the table's lock is bounded (``_bound_lock_wait``).

Mirrored in ``models._ensure_schema_upgrades`` (in a savepoint there, leaving running duplicates
for a later start) for a separate ``GRAPHVER_DB_URL`` alembic never reaches.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_ingest_active_index

revision: str = "20261017_1950_gv_ingest_active"
down_revision: Union[str, None] = "20261017_1900_gv_commits_idem"
branch_labels = None
depends_on = None


def _bound_lock_wait() -> None:
    """Wait at most five seconds for the table's lock: every job's heartbeat writes ``jobs``, so a
    long holder makes the upgrade give up, to be run again, rather than queue those writes."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    ensure_ingest_active_index(op.get_bind(), strict=True)


def downgrade() -> None:
    _bound_lock_wait()
    op.get_bind().execute(sa.text(
        f'DROP INDEX IF EXISTS "{gv_config.graphver_schema()}".uq_jobs_ingest_active'))
