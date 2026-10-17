"""API keys at scale: index a key's successor and its owner's latest sign-in,
and drop an index nothing used.

Revision ID: 20261013_1300_api_key_scale
Revises: 20261013_1200_activity_api_key
Create Date: 2026-10-13 13:00

* ``idx_api_keys_rotated_from`` — showing or rotating a key asks whether a
  rotation replaced it, and without this each ask read the whole table.
  Partial: only a rotation's key has one.
* ``idx_user_identities_user_login`` — a key owner's latest SSO sign-in,
  which keeps their keys from pausing, read from the index alone: on every
  key request, and for every owner on the admin inventory.
* ``idx_api_keys_live_last_used`` goes. Postgres never chose it — the
  inventory's "unused" filter is on a key's computed status, which does not
  imply the index's predicate — and while it stood, every "last used" stamp
  rewrote each of the table's indexes instead of updating the row in place.

Plain builds in the migration's transaction, like the other index migrations
here (``20260913_1000_job_scan_indexes`` says why): ``user_identities`` has a
row per SSO identity, seconds to index at a million, during which SSO
sign-ins wait to record theirs; reads carry on. The wait for the lock itself
is bounded (``_bound_lock_wait``). Inspector-guarded:
``0001_baseline`` create_all()s the current ORM, so a brand-new environment
already has the new indexes and never had the old one.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261013_1300_api_key_scale"
down_revision: Union[str, None] = "20261013_1200_activity_api_key"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SUCCESSOR = "idx_api_keys_rotated_from"
_SIGN_IN = "idx_user_identities_user_login"
_UNUSED = "idx_api_keys_live_last_used"


def _indexes(table: str) -> set[str]:
    return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock. Every SSO sign-in writes
    ``user_identities``: a long transaction there makes this revision give
    up, to be run again, rather than queue every later query on the table
    behind it while it waits."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    keys = _indexes("api_keys")
    if _UNUSED in keys:
        op.drop_index(_UNUSED, table_name="api_keys")
    if _SUCCESSOR not in keys:
        op.create_index(
            _SUCCESSOR, "api_keys", ["rotated_from"],
            postgresql_where=sa.text("rotated_from IS NOT NULL"),
            sqlite_where=sa.text("rotated_from IS NOT NULL"),
        )
    if _SIGN_IN not in _indexes("user_identities"):
        op.create_index(_SIGN_IN, "user_identities", ["user_id", "last_login_at"])


def downgrade() -> None:
    _bound_lock_wait()
    if _SIGN_IN in _indexes("user_identities"):
        op.drop_index(_SIGN_IN, table_name="user_identities")
    keys = _indexes("api_keys")
    if _SUCCESSOR in keys:
        op.drop_index(_SUCCESSOR, table_name="api_keys")
    if _UNUSED not in keys:
        op.create_index(
            _UNUSED, "api_keys", ["last_used_at"],
            postgresql_where=sa.text("revoked_at IS NULL"),
            sqlite_where=sa.text("revoked_at IS NULL"),
        )
