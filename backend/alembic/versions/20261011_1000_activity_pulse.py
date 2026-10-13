"""Index the ledger's workspace-audience rows by time alone.

Revision ID: 20261011_1000_activity_pulse
Revises: 20261010_1100_job_provenance
Create Date: 2026-10-11 10:00

The workspace pulse (Analytics → Workspaces, and the usage document the
warmer rebuilds every pass) asks for every workspace's workspace-audience
rows in a window, by day, category and whether a person did it.
``idx_aal_workspace_lens`` leads with the workspace, so a window across all
of them read the whole partial index and then fetched every row it found.
This one leads with the time and carries the three columns the pulse groups
on, so a window is a range read answered from the index alone. Partial, like
the lens: it costs a write only for workspace-audience rows.

Inspector-guarded — 0001_baseline create_all()s the CURRENT ORM, so a
brand-new environment already has the index when this runs.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261011_1000_activity_pulse"
down_revision: Union[str, None] = "20261010_1100_job_provenance"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "auth_audit_log"
_INDEX = "idx_aal_workspace_pulse"
_WHERE = "audience = 'workspace'"


def _indexes(bind) -> set[str]:
    return {i["name"] for i in sa.inspect(bind).get_indexes(_TABLE)}


def upgrade() -> None:
    bind = op.get_bind()
    if _INDEX not in _indexes(bind):
        op.create_index(
            _INDEX, _TABLE, ["occurred_at"],
            postgresql_include=["workspace_id", "category", "actor_kind"],
            postgresql_where=sa.text(_WHERE), sqlite_where=sa.text(_WHERE),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _INDEX in _indexes(bind):
        op.drop_index(_INDEX, table_name=_TABLE)
