"""feature_definitions.impact_when_on — what turning a switch on means

The Admin → Features page explains what turning a switch OFF costs (``impact_when_off``); a switch
whose ON is the consequential direction — one that starts evicting graphs from memory, say — had
nowhere to say so. Nullable: a switch that leaves it unset turns on at once, as every switch did.

No backfill here: ``seed_feature_registry`` writes it on the next startup from
``app/config/features_seed.py``, like the other prose columns. ``feature_definitions`` is read by
every process's flag cache, so the revision bounds its wait for the lock. Guarded DDL, safe to
re-run. Downgrade drops it; nothing but the page reads it.

Revision ID: 20261102_1000_feature_impact_on
Revises: 20261030_1400_residency_policy
Create Date: 2026-11-02 10:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261102_1000_feature_impact_on"
down_revision: Union[str, None] = "20261030_1400_residency_policy"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "feature_definitions"


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: giving up (to be run again) beats queueing every
    process's flag read behind a long transaction."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    op.add_column(_TABLE, sa.Column("impact_when_on", sa.Text(), nullable=True), if_not_exists=True)


def downgrade() -> None:
    _bound_lock_wait()
    op.execute(f"ALTER TABLE {_TABLE} DROP COLUMN IF EXISTS impact_when_on")
