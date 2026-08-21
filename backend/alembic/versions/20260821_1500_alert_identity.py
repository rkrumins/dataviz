"""Alerts: a fourth severity, and the names behind the ids.

Revision ID: 20260821_1500_alert_identity
Revises: 20260821_1200_count_alerts
Create Date: 2026-08-21 15:00

Two changes, both about answering "what exactly is broken" without a second
lookup.

**``critical``.** The existing tiers are relative to a source's own churn
(>=3x and >=8x its median movement), which is the right lens for "is this
unusual" and the wrong one for a wipe: a source with large routine churn can
lose EVERYTHING without the loss reaching 8x its own median, so the tier that
should shout loudest would stay silent on the worst failure. ``critical`` is
measured against the graph instead — a drop taking >=90% of it — and it clears
any configured severity floor, because a floor is a noise control and a wipe is
not noise.

**``provider_name`` / ``data_source_label``.** The alert already carried
``provider_id`` and ``graph_name``. Ids do not tell an operator which data
source under which provider is affected without a lookup, and the names have to
survive a rename or a deletion of the very rows they came from — so they are
frozen onto the alert at the moment it is raised, like everything else here.

The CHECK widen is WIDEN-ONLY, mirroring ``20260720_1300_clear_scope``: rebuild
over the required set UNION whatever values already exist, so a row this
migration does not know about can never wedge the ``ADD CONSTRAINT``.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260821_1500_alert_identity"
down_revision: Union[str, None] = "20260821_1200_count_alerts"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_ALERTS = "data_source_count_alerts"
_CONSTRAINT = "ck_dsca_severity"

_REQUIRED: Sequence[str] = ("notable", "severe", "critical")
_REQUIRED_BEFORE: Sequence[str] = ("notable", "severe")

_IDENTITY_COLUMNS = (
    ("provider_name", sa.Text()),
    ("data_source_label", sa.Text()),
)


def _columns(inspector: sa.engine.reflection.Inspector, table: str) -> set:
    return {c["name"] for c in inspector.get_columns(table)}


def _widen_severity_check(bind, required: Sequence[str]) -> None:
    """Rebuild the severity CHECK over ``required`` ∪ whatever is already
    stored. A fresh database never reaches here — ``create_all`` lays the
    widened CHECK down directly and never ALTERs."""
    inspector = sa.inspect(bind)
    if not inspector.has_table(_ALERTS):
        return
    present = {
        row[0]
        for row in bind.execute(sa.text(f"SELECT DISTINCT severity FROM {_ALERTS}"))
        if row[0]
    }
    allowed = sorted(set(required) | present)
    values = ", ".join("'" + v.replace("'", "''") + "'" for v in allowed)
    bind.execute(sa.text(
        f"ALTER TABLE {_ALERTS} DROP CONSTRAINT IF EXISTS {_CONSTRAINT}"
    ))
    bind.execute(sa.text(
        f"ALTER TABLE {_ALERTS} ADD CONSTRAINT {_CONSTRAINT} "
        f"CHECK (severity IN ({values}))"
    ))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table(_ALERTS):
        present = _columns(inspector, _ALERTS)
        for name, col_type in _IDENTITY_COLUMNS:
            if name not in present:
                op.add_column(_ALERTS, sa.Column(name, col_type, nullable=True))

    _widen_severity_check(bind, _REQUIRED)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # Widen-only in reverse too: narrow the required set but keep every value
    # that actually exists, so an already-raised critical alert cannot wedge
    # the rebuild.
    _widen_severity_check(bind, _REQUIRED_BEFORE)

    if inspector.has_table(_ALERTS):
        present = _columns(inspector, _ALERTS)
        for name, _col_type in reversed(_IDENTITY_COLUMNS):
            if name in present:
                op.drop_column(_ALERTS, name)
