"""``import_rows.code``: why an import's row was refused, as a stable code.

A refused row said why only in words (``reasons``), which a client building on the import API had
to parse. It now also carries a code — ``no_key``, ``two_entities``, ``duplicate_value``,
``changed_since_export``, ``named_already``, ``invalid_type`` and the rest of
``import_export/resolve.CODES`` — which the preview and the dry run return beside the reasons.

Nullable text with no default: a catalog change, with no rewrite of the staged rows. The ALTER
waits at most five seconds for the table's lock (import windows write it constantly) and is safe to
re-run; ``models._ensure_schema_upgrades`` mirrors it at start-up for a separate
``GRAPHVER_DB_URL`` alembic never reaches. The downgrade drops it: rows staged since lose their
codes, not their reasons.

Revision ID: 20261112_1300_gv_import_row_code
Revises: 20261112_1200_gv_ps_rollup_state
Create Date: 2026-11-12 13:00
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_import_rows_code_column

revision: str = "20261112_1300_gv_import_row_code"
down_revision: Union[str, None] = "20261112_1200_gv_ps_rollup_state"
branch_labels = None
depends_on = None


def _bound_lock_wait() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    bind = op.get_bind()
    if not sa.inspect(bind).has_schema(gv_config.graphver_schema()):
        return                              # create_schema_and_partitions builds it
    _bound_lock_wait()
    ensure_import_rows_code_column(bind)


def downgrade() -> None:
    _bound_lock_wait()
    op.get_bind().execute(sa.text(f'ALTER TABLE "{gv_config.graphver_schema()}"."import_rows" '
                                  "DROP COLUMN IF EXISTS code"))
