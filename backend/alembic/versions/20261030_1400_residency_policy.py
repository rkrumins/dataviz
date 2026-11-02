"""The versioned graphs' residency policy, on ``platform_settings``.

What the capacity loop evicts and loads by, changed live from the admin UI:

* ``gv_eviction_enabled`` — whether it evicts at all (loads go on either way);
* ``gv_default_residency`` — the class a new graph gets: ``always``, ``standard`` or
  ``coldline`` (check ``ck_platform_settings_gv_default_residency``);
* ``gv_standard_idle_secs`` / ``gv_coldline_idle_secs`` — how long unread before each class goes;
* ``gv_high_water_pct`` / ``gv_low_water_pct`` — where pressure eviction starts and stops, as a
  share of a master's memory;
* ``gv_load_margin_pct`` — the headroom a load needs over its estimate (130 = ×1.3);
* ``gv_bytes_per_entity`` — the estimate for a graph whose size was never measured;
* ``gv_coldline_canvas_load_above`` — a Coldline graph larger than this loads on its first canvas
  read;
* ``gv_capacity_interval_secs`` — how often the loop runs;
* ``gv_policy_updated_by`` / ``gv_policy_updated_at`` — who last changed the policy, and when (the
  row's own ``updated_by`` and ``updated_at`` are shared by every platform setting);
* ``gv_residency_on_since`` / ``gv_residency_phase`` — what the capacity leader keeps of the Graph
  residency switch (Admin → Features): since when it saw it on (evictions wait the grace period
  from then) and its phase, ``grace``, ``on`` or ``reloading`` (check
  ``ck_platform_settings_gv_residency_phase``).

All nullable: NULL is unset, and the environment default applies, so nothing changes until an
administrator saves a value. ``platform_settings`` is a single row the app reads often, so the
revision bounds its wait for locks. Guarded DDL, safe to re-run. Downgrade drops them, and every
value falls back to its default for code that still reads them.

Revision ID: 20261030_1400_residency_policy
Revises: 20261030_1300_gv_ps_residency
Create Date: 2026-10-30 14:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261030_1400_residency_policy"
down_revision: Union[str, None] = "20261030_1300_gv_ps_residency"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "platform_settings"
_CHECK = "ck_platform_settings_gv_default_residency"
_PHASE_CHECK = "ck_platform_settings_gv_residency_phase"
_COLUMNS = (
    ("gv_eviction_enabled", sa.Boolean()),
    ("gv_default_residency", sa.Text()),
    ("gv_standard_idle_secs", sa.Integer()),
    ("gv_coldline_idle_secs", sa.Integer()),
    ("gv_high_water_pct", sa.Integer()),
    ("gv_low_water_pct", sa.Integer()),
    ("gv_load_margin_pct", sa.Integer()),
    ("gv_bytes_per_entity", sa.Integer()),
    ("gv_coldline_canvas_load_above", sa.Integer()),
    ("gv_capacity_interval_secs", sa.Integer()),
    ("gv_policy_updated_by", sa.Text()),
    ("gv_policy_updated_at", sa.Text()),
    ("gv_residency_on_since", sa.Text()),
    ("gv_residency_phase", sa.Text()),
)


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: giving up (to be run again)
    beats queueing everything that reads the platform's settings behind a
    long transaction."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    for name, kind in _COLUMNS:
        op.add_column(_TABLE, sa.Column(name, kind, nullable=True), if_not_exists=True)
    op.execute(f"ALTER TABLE {_TABLE} DROP CONSTRAINT IF EXISTS {_CHECK}")
    op.create_check_constraint(
        _CHECK, _TABLE,
        "gv_default_residency IS NULL OR gv_default_residency IN ('always','standard','coldline')")
    op.execute(f"ALTER TABLE {_TABLE} DROP CONSTRAINT IF EXISTS {_PHASE_CHECK}")
    op.create_check_constraint(
        _PHASE_CHECK, _TABLE,
        "gv_residency_phase IS NULL OR gv_residency_phase IN ('grace','on','reloading')")


def downgrade() -> None:
    _bound_lock_wait()
    op.execute(f"ALTER TABLE {_TABLE} DROP CONSTRAINT IF EXISTS {_PHASE_CHECK}")
    op.execute(f"ALTER TABLE {_TABLE} DROP CONSTRAINT IF EXISTS {_CHECK}")
    for name, _kind in reversed(_COLUMNS):
        op.execute(f"ALTER TABLE {_TABLE} DROP COLUMN IF EXISTS {name}")
