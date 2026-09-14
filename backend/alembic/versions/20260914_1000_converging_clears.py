"""Bound how long "it is converging" may hold the reconcile breaker open.

``_converging`` clears ``reconcile_consecutive_actions`` so a rebuild too
large for one wall clock is not suspended for making progress. Nothing
bounded the clearing: a source whose stored cube grows by one cell an attempt
is converging by that test and looping by any other, and it retried every
cadence forever with nothing ever asking a person. This column counts the
clears so the cap can.

Additive and inspector-guarded, like every migration in this chain: safe to
run against a database a previous deploy already created the column on, and
safe to leave in place during a rolling deploy (an older pod simply never
writes it, and clearing without a bound is the behaviour it has today).
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260914_1000_converging_clears"
down_revision: Union[str, None] = "20260913_1100_invalidated_fingerprint"
branch_labels = None
depends_on = None

_SCHEMA = "aggregation"
_TABLE = "data_source_state"
_COLUMN = "reconcile_converging_clears"


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
        _TABLE,
        sa.Column(_COLUMN, sa.Integer(), nullable=True, server_default="0"),
        schema=_SCHEMA,
    )


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind):
        return
    op.drop_column(_TABLE, _COLUMN, schema=_SCHEMA)
