"""``merge_requests.merged_source_seq``: the fork's head a merged review of a fork took.

A fork's next review merges what the fork changed since its last merged one, from the fork's
state at that head, as git merges from the last merged commit; before, every review merged from
the fork point, so a change the parent took and then undid was proposed again, and a field only
the parent changed since was a conflict. One nullable column (catalog-only, no rewrite), filled in
for the forks' reviews merged before it: the latest of the fork's commits their squash names. A
review merged without a change before it has none to take, and leaves it empty: the review
before it, or the fork point, stands. The wait for the table's lock is bounded
(``_bound_lock_wait``), and the upgrade is safe to re-run.

The downgrade drops the column: forks' reviews merge from the fork point again.

Mirrored in ``models._ensure_schema_upgrades`` for a separate ``GRAPHVER_DB_URL`` alembic never
reaches.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_mr_merged_source_seq

revision: str = "20261030_1000_gv_mr_merged_seq"
down_revision: Union[str, None] = "20261029_1100_drafts_policy"
branch_labels = None
depends_on = None


def _bound_lock_wait() -> None:
    """Wait at most five seconds for the table's lock: every review reads ``merge_requests``, so
    a long holder makes the upgrade give up, to be run again, rather than queue those reads behind
    it."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    ensure_mr_merged_source_seq(op.get_bind())


def downgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    if not sa.inspect(bind).has_table("merge_requests", schema=schema):
        return
    bind.execute(sa.text(
        f'ALTER TABLE "{schema}"."merge_requests" DROP COLUMN IF EXISTS merged_source_seq'))
