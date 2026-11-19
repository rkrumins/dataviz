"""``merge_requests.changes_requested``: a reviewer sent the review back for changes.

``{by, at, reason, headCommitId, headSeq}``. It holds until a content commit lands on the draft after
``headSeq`` (the author changed it), or the reviewer withdraws it; while it holds the review does not
merge. One nullable ``ADD COLUMN IF NOT EXISTS``: catalog-only, no rewrite; the wait for the table's
lock is bounded, and the upgrade is safe to re-run.

Mirrored in ``models._ensure_schema_upgrades`` for a separate ``GRAPHVER_DB_URL`` alembic never
reaches.

Revision ID: 20261117_1500_gv_mr_sendback
Revises: 20261117_1400_gv_save_jobs
Create Date: 2026-11-17 15:00
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_mr_changes_requested_column

revision: str = "20261117_1500_gv_mr_sendback"
down_revision: Union[str, None] = "20261117_1400_gv_save_jobs"
branch_labels = None
depends_on = None


def _bound_lock_wait() -> None:
    """Wait at most five seconds for the table's lock: opening, approving and merging a review
    write ``merge_requests``."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    ensure_mr_changes_requested_column(op.get_bind())


def downgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    if not sa.inspect(bind).has_table("merge_requests", schema=schema):
        return
    bind.execute(sa.text(f'ALTER TABLE "{schema}"."merge_requests" DROP COLUMN IF EXISTS changes_requested'))
