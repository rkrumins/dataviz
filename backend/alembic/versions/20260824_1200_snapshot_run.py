"""Bind an observation to the run that caused it, and stop double-writes.

Revision ID: 20260824_1200_snapshot_run
Revises: 20260824_1100_count_rollups
Create Date: 2026-08-24 12:00

**``refresh_event_id`` and the ``run`` reason.** Correlating a snapshot to
platform activity by timestamp answers "what else was running around then".
It does not answer "what did that load do", which is the question anyone asks
after an ingestion run — and a ±15 minute window cannot answer it, because two
runs inside one window are indistinguishable. Capture at the run boundary,
stamped with the event id, makes it an exact join.

The ``run`` reason is separate from ``changed`` on purpose: a run that changed
nothing is itself a finding (the loader ran and produced no movement), and it
must survive the change gate that would otherwise drop it.

**``uq_dscs_ds_instant``.** A retried transaction can re-run capture at the
same instant. Two rows for one observation make the rollup's "last value in
the bucket" arbitrary, so the pair is the real identity of a row here.
Duplicates are collapsed before the constraint is added — keeping the row with
the most information rather than an arbitrary one.

**``ix_dscs_ws_captured``.** Tenant-scoped reads filter on ``workspace_id``
and had to scan. The column was already denormalised here; only the index was
missing.

The reason CHECK widen is WIDEN-ONLY, mirroring ``20260823_1500_alert_identity``:
rebuild over the required set UNION whatever values already exist, so a row
this migration does not know about can never wedge the ``ADD CONSTRAINT``.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260824_1200_snapshot_run"
down_revision: Union[str, None] = "20260824_1100_count_rollups"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_SNAPSHOTS = "data_source_count_snapshots"
_CONSTRAINT = "ck_dscs_reason"
_UNIQUE = "uq_dscs_ds_instant"

_REQUIRED: Sequence[str] = ("first", "changed", "heartbeat", "run")
_REQUIRED_BEFORE: Sequence[str] = ("first", "changed", "heartbeat")

_COLUMNS = (("refresh_event_id", sa.Text()),)

_INDEXES = (
    ("ix_dscs_ws_captured", ["workspace_id", "captured_at"]),
    ("ix_dscs_refresh_event", ["refresh_event_id"]),
)


def _columns(inspector: sa.engine.reflection.Inspector, table: str) -> set:
    return {c["name"] for c in inspector.get_columns(table)}


def _index_names(inspector: sa.engine.reflection.Inspector, table: str) -> set:
    return {ix["name"] for ix in inspector.get_indexes(table)}


def _unique_names(inspector: sa.engine.reflection.Inspector, table: str) -> set:
    names = {u["name"] for u in inspector.get_unique_constraints(table)}
    # Some backends report a unique constraint only as an index.
    return names | _index_names(inspector, table)


def _widen_reason_check(bind, required: Sequence[str]) -> None:
    """Rebuild the reason CHECK over ``required`` union whatever is already
    stored. A fresh database never reaches here — ``create_all`` lays the
    widened CHECK down directly and never ALTERs."""
    inspector = sa.inspect(bind)
    if not inspector.has_table(_SNAPSHOTS):
        return
    if bind.dialect.name == "sqlite":
        # SQLite cannot ALTER a CHECK. Tests build from the ORM, which already
        # carries the widened constraint, so there is nothing to reconcile.
        return
    present = {
        row[0]
        for row in bind.execute(
            sa.text(f"SELECT DISTINCT capture_reason FROM {_SNAPSHOTS}")
        )
        if row[0]
    }
    allowed = sorted(set(required) | present)
    values = ", ".join("'" + v.replace("'", "''") + "'" for v in allowed)
    bind.execute(sa.text(
        f"ALTER TABLE {_SNAPSHOTS} DROP CONSTRAINT IF EXISTS {_CONSTRAINT}"
    ))
    bind.execute(sa.text(
        f"ALTER TABLE {_SNAPSHOTS} ADD CONSTRAINT {_CONSTRAINT} "
        f"CHECK (capture_reason IN ({values}))"
    ))


def _collapse_duplicate_instants(bind) -> None:
    """Delete all but one row per (data_source_id, captured_at).

    Keeps the row that knows the most — a delta-bearing row over a bare one —
    then falls back to the lexically greatest id so the choice is deterministic
    and the same on a re-run.
    """
    if bind.dialect.name == "sqlite":
        bind.execute(sa.text(f"""
            DELETE FROM {_SNAPSHOTS} WHERE id NOT IN (
                SELECT id FROM (
                    SELECT id,
                           ROW_NUMBER() OVER (
                               PARTITION BY data_source_id, captured_at
                               ORDER BY (node_delta IS NOT NULL) DESC, id DESC
                           ) AS rn
                    FROM {_SNAPSHOTS}
                ) ranked WHERE rn = 1
            )
        """))
        return
    bind.execute(sa.text(f"""
        DELETE FROM {_SNAPSHOTS} WHERE id IN (
            SELECT id FROM (
                SELECT id,
                       ROW_NUMBER() OVER (
                           PARTITION BY data_source_id, captured_at
                           ORDER BY (node_delta IS NOT NULL) DESC, id DESC
                       ) AS rn
                FROM {_SNAPSHOTS}
            ) ranked WHERE ranked.rn > 1
        )
    """))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table(_SNAPSHOTS):
        return

    present = _columns(inspector, _SNAPSHOTS)
    for name, col_type in _COLUMNS:
        if name not in present:
            op.add_column(_SNAPSHOTS, sa.Column(name, col_type, nullable=True))

    existing_ix = _index_names(inspector, _SNAPSHOTS)
    for name, columns in _INDEXES:
        if name not in existing_ix:
            op.create_index(name, _SNAPSHOTS, columns)

    if _UNIQUE not in _unique_names(inspector, _SNAPSHOTS):
        _collapse_duplicate_instants(bind)
        op.create_unique_constraint(
            _UNIQUE, _SNAPSHOTS, ["data_source_id", "captured_at"],
        )

    _widen_reason_check(bind, _REQUIRED)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table(_SNAPSHOTS):
        return

    # A 'run' row cannot survive the narrowed CHECK, and it is a real
    # observation — reclassify rather than delete.
    bind.execute(sa.text(
        f"UPDATE {_SNAPSHOTS} SET capture_reason = 'changed' "
        f"WHERE capture_reason = 'run'"
    ))
    _widen_reason_check(bind, _REQUIRED_BEFORE)

    if _UNIQUE in _unique_names(inspector, _SNAPSHOTS):
        op.drop_constraint(_UNIQUE, _SNAPSHOTS, type_="unique")

    existing_ix = _index_names(inspector, _SNAPSHOTS)
    for name, _columns_ in reversed(_INDEXES):
        if name in existing_ix:
            op.drop_index(name, table_name=_SNAPSHOTS)

    present = _columns(inspector, _SNAPSHOTS)
    for name, _col_type in reversed(_COLUMNS):
        if name in present:
            op.drop_column(_SNAPSHOTS, name)
