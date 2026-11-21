"""A data source's details: what it is, where to read more, and whether to trust it.

On ``workspace_data_sources``, ten nullable columns:

* ``description`` (at most 4000 characters), ``links`` (JSON ``[{label, url}]``) and
  ``tags`` (JSON ``[str]``) — edited by whoever manages the source;
* ``classification`` (``public``, ``internal``, ``confidential`` or ``restricted``),
  ``trust_status`` (``certified``, ``in_review`` or ``deprecated``) and ``trust_note`` (at
  most 500 characters), with ``trust_status_by`` / ``trust_status_at`` — who set the current
  status, and when — edited by the workspace's admins and the source's named contacts;
* ``metadata_updated_by`` / ``metadata_updated_at`` — the last change to any of them, and the
  token a save sends back to show it changed what it read.

And a partial index on ``data_requests(data_source_id)``: the onboarding line finds the request a
source came from by it, as does working out a source's contacts when nobody is named.

NULL is "not said". The table is read by most requests, so the revision bounds its wait for
locks. Guarded DDL; the checks are swapped in, the index is inspector-guarded (a brand-new
environment's ``0001_baseline`` create_all()s the current ORM). Downgrade drops the index, the
checks and the columns.

Revision ID: 20261124_1000_ds_metadata
Revises: 20261123_1000_conversations
Create Date: 2026-11-24 10:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261124_1000_ds_metadata"
down_revision: Union[str, None] = "20261123_1000_conversations"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "workspace_data_sources"
_COLUMNS = (
    "description", "links", "tags", "classification", "trust_status", "trust_note",
    "trust_status_by", "trust_status_at", "metadata_updated_by", "metadata_updated_at",
)
_CHECKS = {
    "ck_ds_description_len": "description IS NULL OR length(description) <= 4000",
    "ck_ds_classification":
        "classification IS NULL OR classification IN ('public', 'internal', 'confidential', 'restricted')",
    "ck_ds_trust_status": "trust_status IS NULL OR trust_status IN ('certified', 'in_review', 'deprecated')",
    "ck_ds_trust_note_len": "trust_note IS NULL OR length(trust_note) <= 500",
}
_REQUESTS = "data_requests"
_INDEX = "idx_data_requests_source"
_WHERE = "data_source_id IS NOT NULL"


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: giving up (to be run again) beats queueing every
    request that reads a data source behind a long transaction."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def _swap_check(name: str, condition: str) -> None:
    op.execute(f"ALTER TABLE {_TABLE} DROP CONSTRAINT IF EXISTS {name}")
    op.create_check_constraint(name, _TABLE, condition)


def _indexes(bind) -> set[str]:
    return {i["name"] for i in sa.inspect(bind).get_indexes(_REQUESTS)}


def upgrade() -> None:
    _bound_lock_wait()
    for name in _COLUMNS:
        op.add_column(_TABLE, sa.Column(name, sa.Text(), nullable=True), if_not_exists=True)
    for name, condition in _CHECKS.items():
        _swap_check(name, condition)
    bind = op.get_bind()
    if _INDEX not in _indexes(bind):
        op.create_index(_INDEX, _REQUESTS, ["data_source_id"],
                        postgresql_where=sa.text(_WHERE), sqlite_where=sa.text(_WHERE))


def downgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()
    if _INDEX in _indexes(bind):
        op.drop_index(_INDEX, table_name=_REQUESTS)
    for name in _CHECKS:
        op.execute(f"ALTER TABLE {_TABLE} DROP CONSTRAINT IF EXISTS {name}")
    for name in reversed(_COLUMNS):
        op.execute(f"ALTER TABLE {_TABLE} DROP COLUMN IF EXISTS {name}")
