"""Baseline — create the entire current schema from ORM metadata.

Revision ID: 0001_baseline
Revises:
Create Date: 2026-04-14

This is the fresh-start baseline introduced when Alembic was adopted.
The dev/test workflow per the approved plan is:

    rm nexus_core.db nexus_core.db-wal nexus_core.db-shm 2>/dev/null
    alembic upgrade head

Subsequent migrations (0002_..., 0003_...) use explicit `op.*` DDL so
that schema evolution is reviewable per change. The baseline uses
`Base.metadata.create_all()` because there is no preceding state to
diff against — the ORM is the source of truth for what "head" means
at this point in history.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

# Importing env.py's metadata target indirectly: Base is populated by
# env.py before this revision runs, so we can just reach it back through
# the same import chain.
from backend.app.db.engine import Base
from backend.app.db import models as _management_models  # noqa: F401
from backend.app.services.aggregation import models as _aggregation_models  # noqa: F401


revision: str = "0001_baseline"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Tables introduced AFTER the baseline cutover. Each forward migration
# that adds a new ORM table must register its table name here so the
# baseline's `create_all` skips it — otherwise the new migration's
# `op.create_table` would race the baseline and fail on second-table-create.
#
# FIXME (pre-prod): convert this baseline to explicit `op.create_table`
# calls per the standard Alembic pattern. The filter approach is a P1
# convenience that becomes brittle once many forward migrations exist.
_POST_BASELINE_TABLES = {
    "revoked_refresh_jti",  # added in 0002_revoked_refresh_jti
}


def _baseline_tables():
    return [t for t in Base.metadata.sorted_tables if t.name not in _POST_BASELINE_TABLES]


def upgrade() -> None:
    bind = op.get_bind()
    Base.metadata.create_all(bind=bind, tables=_baseline_tables())


def downgrade() -> None:
    bind = op.get_bind()
    Base.metadata.drop_all(bind=bind, tables=_baseline_tables())
