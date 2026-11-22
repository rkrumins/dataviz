"""``jobs``: ``ix_jobs_property_unnotified``, the bulk property jobs that have ended and that the
transfer lane's notices sweep hasn't looked at yet, by when they ended. The sweep reads the oldest
recent ones every minute (``import_export.job_notices``) and stamps each, which takes it out of
the index.

Built CONCURRENTLY, outside the revision's transaction: ``jobs`` keeps every job ever run, and
every running job's heartbeat and checkpoints write to it, so a plain build would hold those writes
for as long as it reads the table. A concurrent build that gives up waiting (``lock_timeout``)
leaves an invalid index; the upgrade Job's next try drops it and builds again.

``models._ensure_schema_upgrades`` mirrors it at start-up for a separate ``GRAPHVER_DB_URL`` that
alembic never reaches. The downgrade drops it, also concurrently.

Revision ID: 20261122_1200_gv_job_notices
Revises: 20261122_1100_reusable_changes
Create Date: 2026-11-22 12:00
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import JOBS_UNNOTIFIED

revision: str = "20261122_1200_gv_job_notices"
down_revision: Union[str, None] = "20261122_1100_reusable_changes"
branch_labels = None
depends_on = None

_INDEX = "ix_jobs_property_unnotified"


def _valid(bind, sch: str):
    """True when the index is there and usable, False when a build of it stopped part-way, None
    when it isn't there."""
    return bind.execute(sa.text("SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass(:i)"),
                        {"i": f'"{sch}".{_INDEX}'}).scalar()


def upgrade() -> None:
    bind = op.get_bind()
    sch = gv_config.graphver_schema()
    if bind.dialect.name != "postgresql" or not sa.inspect(bind).has_table("jobs", schema=sch):
        return                              # create_schema_and_partitions builds it from the models
    with op.get_context().autocommit_block():
        valid = _valid(bind, sch)
        if valid:
            return
        if valid is False:
            bind.execute(sa.text(f'DROP INDEX CONCURRENTLY IF EXISTS "{sch}".{_INDEX}'))
        bind.execute(sa.text(f'CREATE INDEX CONCURRENTLY IF NOT EXISTS {_INDEX} ON "{sch}"."jobs" '
                             f"(completed_at) WHERE {JOBS_UNNOTIFIED}"))


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    with op.get_context().autocommit_block():
        bind.execute(sa.text(f'DROP INDEX CONCURRENTLY IF EXISTS "{gv_config.graphver_schema()}".{_INDEX}'))
