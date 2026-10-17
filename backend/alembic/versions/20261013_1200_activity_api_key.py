"""Record on the ledger which API key a change was made with.

Revision ID: 20261013_1200_activity_api_key
Revises: 20261013_1100_merge_api_keys
Create Date: 2026-10-13 12:00

A request made with an API key writes its events like any other, as the key's
owner, and each payload names the key (``api_key_id``). This projects it into
a column with an index that leads with it and ends on the timeline, so "what
did this key do?" is a range scan like every other activity filter, not a
scan of payloads.

No row recorded before keys existed names one, so nothing is backfilled and
``PROJECTION_VERSION`` stays: new rows get the column as the relay records
them.

Nothing is built here any more: ``20261014_1200_aal_api_key`` adds the column
and its index as the upgrade's last step. The upgrade job applies its
revisions in one transaction, so a lock taken here would be held to its end
— the ledger's
exclusive lock, reads included, through every later revision's work. Taken
last, it lasts only as long as the ledger's own build. A database that ran
this revision while it still built both keeps them, and the later revision
finds them there; the downgrade below still removes them from such a
database, guarded, and waits a bounded time for the ledger's lock
(``_bound_lock_wait``).
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


def _bound_lock_wait() -> None:
    """Wait at most five seconds for the ledger's lock: a long reader — an
    activity export streaming for minutes — makes the downgrade give up, to
    be run again, rather than queue every later query on the table behind
    it while it waits."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    pass


def downgrade() -> None:
    _bound_lock_wait()
    inspector = sa.inspect(op.get_bind())
    if _INDEX in {i["name"] for i in inspector.get_indexes(_TABLE)}:
        op.drop_index(_INDEX, table_name=_TABLE)
    if _COLUMN in {c["name"] for c in inspector.get_columns(_TABLE)}:
        op.drop_column(_TABLE, _COLUMN)
