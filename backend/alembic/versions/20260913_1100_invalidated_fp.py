"""Record which fingerprint the read caches were last invalidated for.

``data_source_state.graph_fingerprint`` only advances when a rebuild
COMPLETES. While one is deferred by the rebuild cooldown the change gate
therefore keeps answering "changed" on every reconcile sweep, and each pass
bumped the cache generation again — making every entry re-warmed since
unreachable. A source under active change had an effective cache lifetime of
the detection cadence rather than its TTL, which is the difference between a
cache and a cache miss with extra steps.

Additive and inspector-guarded, like every migration in this chain: safe to
run against a database a previous deploy already created the column on, and
safe to leave in place during a rolling deploy (an older pod simply never
reads it, and re-invalidating is the behaviour it has today).
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260913_1100_invalidated_fp"
down_revision: Union[str, None] = "20260913_1000_job_scan_indexes"
branch_labels = None
depends_on = None

_SCHEMA = "aggregation"
_TABLE = "data_source_state"
_COLUMN = "invalidated_fingerprint"


def _has_column(bind) -> bool:
    inspector = sa.inspect(bind)
    try:
        cols = {c["name"] for c in inspector.get_columns(_TABLE, schema=_SCHEMA)}
    except Exception:
        return True          # table absent → nothing to add; db_init creates it
    return _COLUMN in cols


def upgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind):
        return
    op.add_column(
        _TABLE, sa.Column(_COLUMN, sa.Text(), nullable=True), schema=_SCHEMA,
    )


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind):
        return
    op.drop_column(_TABLE, _COLUMN, schema=_SCHEMA)
