"""Alerts learn which measure moved, and what kind of finding they are.

Revision ID: 20260824_1300_alert_finding
Revises: 20260824_1200_snapshot_run
Create Date: 2026-08-24 13:00

**``metric``.** Nodes and edges fail independently. A loader that drops every
relationship while leaving every entity intact is a total failure of the graph
that a node-only alerter cannot see at all — the node count never moves. So
the metric an alert is about is part of its identity, not a detail buried in
its evidence, and the cooldown is per (source, metric) so an entity incident
cannot mute a concurrent relationship one.

**``finding`` and ``subject_type``.** ``movement`` is the original judgement:
a delta far outside what is ordinary for this source. Two more findings cannot
be expressed as a multiple of a baseline at all and were therefore invisible:

- ``type_gone`` — an entity or relationship type reached zero. This is the
  clearest evidence an external process deleted data, and as a fraction of the
  whole graph it is often small enough to be unremarkable.
- ``silent`` — the source stopped being observed. Not the same as dropping to
  zero, and previously only ever a count of rows nobody rendered.

``subject_type`` carries the type name for ``type_gone`` and is NULL for
findings about the source as a whole.

Both CHECKs are added WIDEN-ONLY over required union present, mirroring
``20260823_1500_alert_identity``, so an existing row can never wedge the
``ADD CONSTRAINT``.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260824_1300_alert_finding"
down_revision: Union[str, None] = "20260824_1200_snapshot_run"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_ALERTS = "data_source_count_alerts"

# (column, type, server_default, check name, check column, required values)
_METRIC_REQUIRED: Sequence[str] = ("nodes", "edges")
_FINDING_REQUIRED: Sequence[str] = ("movement", "type_gone", "silent")

_COLUMNS = (
    ("metric", sa.Text(), "nodes"),
    ("finding", sa.Text(), "movement"),
    ("subject_type", sa.Text(), None),
)


def _columns(inspector: sa.engine.reflection.Inspector, table: str) -> set:
    return {c["name"] for c in inspector.get_columns(table)}


def _widen_check(bind, *, constraint: str, column: str, required: Sequence[str]) -> None:
    """Rebuild ``constraint`` over ``required`` union whatever is stored."""
    inspector = sa.inspect(bind)
    if not inspector.has_table(_ALERTS):
        return
    if bind.dialect.name == "sqlite":
        # SQLite cannot ALTER a CHECK; tests build from the ORM, which already
        # carries the final constraint.
        return
    if column not in _columns(inspector, _ALERTS):
        return
    present = {
        row[0]
        for row in bind.execute(sa.text(f"SELECT DISTINCT {column} FROM {_ALERTS}"))
        if row[0]
    }
    allowed = sorted(set(required) | present)
    values = ", ".join("'" + v.replace("'", "''") + "'" for v in allowed)
    bind.execute(sa.text(
        f"ALTER TABLE {_ALERTS} DROP CONSTRAINT IF EXISTS {constraint}"
    ))
    bind.execute(sa.text(
        f"ALTER TABLE {_ALERTS} ADD CONSTRAINT {constraint} "
        f"CHECK ({column} IN ({values}))"
    ))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table(_ALERTS):
        return

    present = _columns(inspector, _ALERTS)
    for name, col_type, default in _COLUMNS:
        if name in present:
            continue
        # NOT NULL with a server_default so existing rows are backfilled in
        # one statement: every alert raised before this migration was about
        # node movement, which is exactly what the defaults say.
        op.add_column(_ALERTS, sa.Column(
            name, col_type,
            nullable=default is None,
            server_default=default,
        ))

    _widen_check(
        bind, constraint="ck_dsca_metric", column="metric",
        required=_METRIC_REQUIRED,
    )
    _widen_check(
        bind, constraint="ck_dsca_finding", column="finding",
        required=_FINDING_REQUIRED,
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table(_ALERTS):
        return

    if bind.dialect.name != "sqlite":
        for constraint in ("ck_dsca_metric", "ck_dsca_finding"):
            bind.execute(sa.text(
                f"ALTER TABLE {_ALERTS} DROP CONSTRAINT IF EXISTS {constraint}"
            ))

    present = _columns(inspector, _ALERTS)
    for name, _col_type, _default in reversed(_COLUMNS):
        if name in present:
            op.drop_column(_ALERTS, name)
