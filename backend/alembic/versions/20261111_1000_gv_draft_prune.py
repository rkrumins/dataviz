"""A closed draft's changes are removed after a retention window, set by a system administrator.

* ``platform_settings.gv_draft_retention_days`` — how many days a merged or abandoned draft keeps
  its changes before the versioning worker removes them (0 keeps them for good). NULL is unset, and
  ``GRAPHVER_DRAFT_RETENTION_DAYS`` applies (30).
* ``branches.pruned_at`` / ``prune_finished_at`` — when the removal of a draft's changes began
  (reads of them are refused from then), and when it finished. The draft's record — the branch
  row, its members, its commits and its review — stays.

All nullable with no default: catalog changes, with no rewrite, and every existing draft reads as
never pruned. The waits for the tables' locks are bounded (``_bound_lock_wait``), and the upgrade
is safe to re-run. The downgrade drops the columns; a draft whose changes were removed stays
without them.

The branch columns are mirrored in ``models._ensure_schema_upgrades`` for a separate
``GRAPHVER_DB_URL`` alembic never reaches.

Revision ID: 20261111_1000_gv_draft_prune
Revises: 20261110_1000_gv_commit_prov
Create Date: 2026-11-11 10:00
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import (
    BRANCH_PRUNE_COLUMNS,
    ensure_branch_prune_columns,
)

revision: str = "20261111_1000_gv_draft_prune"
down_revision: Union[str, None] = "20261110_1000_gv_commit_prov"
branch_labels = None
depends_on = None


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a table's lock: every draft request reads ``branches`` and the
    app reads ``platform_settings`` often, so a long holder makes the upgrade give up, to be run
    again, rather than queue those reads behind it."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    op.add_column("platform_settings", sa.Column("gv_draft_retention_days", sa.Integer(), nullable=True),
                  if_not_exists=True)
    ensure_branch_prune_columns(op.get_bind())


def downgrade() -> None:
    _bound_lock_wait()
    op.execute("ALTER TABLE platform_settings DROP COLUMN IF EXISTS gv_draft_retention_days")
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    if sa.inspect(bind).has_table("branches", schema=schema):
        bind.execute(sa.text(f'ALTER TABLE "{schema}"."branches" '
                             + ", ".join(f"DROP COLUMN IF EXISTS {c}" for c in BRANCH_PRUNE_COLUMNS)))
