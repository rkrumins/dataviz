"""``merge_requests.approvals``: the head each approval was of.

``{actor: {headCommitId, headSeq, at}}``. A content commit on the source branch after an approval
makes it stale, and the merge asks for it again (doc 13 'Staleness'). One nullable ``ADD COLUMN IF
NOT EXISTS``: catalog-only, no rewrite; the wait for the table's lock is bounded
(``_bound_lock_wait``), and the upgrade is safe to re-run. Approvals given before this have no
recorded head and count as stale: their reviewers approve again.

Mirrored in ``models._ensure_schema_upgrades`` for a separate ``GRAPHVER_DB_URL`` alembic never
reaches.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_mr_approvals_column

revision: str = "20261018_1000_gv_mr_approvals"
down_revision: Union[str, None] = "20261017_2000_gv_ps_reseeding"
branch_labels = None
depends_on = None


def _bound_lock_wait() -> None:
    """Wait at most five seconds for the table's lock: opening, approving and merging a review
    write ``merge_requests``, so a long holder makes the upgrade give up, to be run again, rather
    than queue them behind it."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    ensure_mr_approvals_column(op.get_bind())


def downgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    if not sa.inspect(bind).has_table("merge_requests", schema=schema):
        return
    bind.execute(sa.text(f'ALTER TABLE "{schema}"."merge_requests" DROP COLUMN IF EXISTS approvals'))
