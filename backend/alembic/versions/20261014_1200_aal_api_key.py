"""Record on the ledger which API key a change was made with — last.

Revision ID: 20261014_1200_aal_api_key
Revises: 20261014_1100_merge_sso_keys
Create Date: 2026-10-14 12:00

Adds ``auth_audit_log.api_key_id`` and the partial index that makes "what
did this key do?" a range scan; ``20261013_1200_activity_api_key`` says what
the column is for. Here, as the upgrade's last step, because the upgrade job
applies its revisions in one transaction and every lock is held until it
commits: the column's exclusive lock — reads included — is taken last, so it
lasts only for this table's own build, about 0.7 s per 10 million events on
Postgres 16. The index is partial: none of the rows recorded before keys
existed has a key, so the build reads the table once and writes nothing for
them. The wait for the lock is bounded (``_bound_lock_wait``).

Inspector-guarded: a database that ran ``20261013_1200`` while it still
built both, and a brand-new environment (``0001_baseline`` create_all()s the
current ORM), already have them.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261014_1200_aal_api_key"
down_revision: Union[str, None] = "20261014_1100_merge_sso_keys"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "auth_audit_log"
_COLUMN = "api_key_id"
_INDEX = "idx_aal_api_key_occurred"
_WHERE = "api_key_id IS NOT NULL"


def _bound_lock_wait() -> None:
    """Wait at most five seconds for the ledger's lock: a long reader — an
    activity export streaming for minutes — makes the upgrade give up, to be
    run again, rather than queue every later query on the table behind it
    while it waits."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    inspector = sa.inspect(op.get_bind())
    if _COLUMN not in {c["name"] for c in inspector.get_columns(_TABLE)}:
        op.add_column(_TABLE, sa.Column(_COLUMN, sa.Text(), nullable=True))
    if _INDEX not in {i["name"] for i in inspector.get_indexes(_TABLE)}:
        op.create_index(
            _INDEX, _TABLE, [_COLUMN, "occurred_at"],
            postgresql_where=sa.text(_WHERE), sqlite_where=sa.text(_WHERE),
        )


def downgrade() -> None:
    _bound_lock_wait()
    inspector = sa.inspect(op.get_bind())
    if _INDEX in {i["name"] for i in inspector.get_indexes(_TABLE)}:
        op.drop_index(_INDEX, table_name=_TABLE)
    if _COLUMN in {c["name"] for c in inspector.get_columns(_TABLE)}:
        op.drop_column(_TABLE, _COLUMN)
