"""Record on the ledger which API key a change was made with.

Revision ID: 20261013_1200_activity_api_key
Revises: 20261013_1100_merge_api_keys
Create Date: 2026-10-13 12:00

A request made with an API key writes its events like any other, as the key's
owner, and each payload names the key (``api_key_id``). This projects it into
a column with an index that leads with it and ends on the timeline, so "what
did this key do?" is a range scan like every other activity filter, not a
scan of payloads.

Partial: most changes are made in a browser, so the index costs a write only
for the rows made with a key. No row recorded before keys existed names one,
so nothing is backfilled and ``PROJECTION_VERSION`` stays: new rows get the
column as the relay records them. Building the index reads the table once and
writes nothing for those rows.

Inspector-guarded like its siblings: ``0001_baseline`` create_all()s the
current ORM, so a brand-new environment already has both.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261013_1200_activity_api_key"
down_revision: Union[str, None] = "20261013_1100_merge_api_keys"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "auth_audit_log"
_COLUMN = "api_key_id"
_INDEX = "idx_aal_api_key_occurred"
_WHERE = "api_key_id IS NOT NULL"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if _COLUMN not in {c["name"] for c in inspector.get_columns(_TABLE)}:
        op.add_column(_TABLE, sa.Column(_COLUMN, sa.Text(), nullable=True))
    if _INDEX not in {i["name"] for i in inspector.get_indexes(_TABLE)}:
        op.create_index(
            _INDEX, _TABLE, [_COLUMN, "occurred_at"],
            postgresql_where=sa.text(_WHERE), sqlite_where=sa.text(_WHERE),
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if _INDEX in {i["name"] for i in inspector.get_indexes(_TABLE)}:
        op.drop_index(_INDEX, table_name=_TABLE)
    if _COLUMN in {c["name"] for c in inspector.get_columns(_TABLE)}:
        op.drop_column(_TABLE, _COLUMN)
