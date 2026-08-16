"""Reconciliation ops join: run_id, live finding, overnight ledger.

Revision ID: 20260815_1200_recon_ops
Revises: 20260814_1600_recon_audit_link
Create Date: 2026-08-15 12:00

The sweep audited its decisions and the cockpit showed tallies, but an
operator asking "what did automation do overnight" had to click through
sources one at a time, and a source that was drifting with automation
off had a verdict with no counts behind it.

  * ``refresh_events.run_id`` names the ``reconcile_runs`` pass that
    produced the event, so the ledger is a real join rather than
    trigger-source + calendar day.
  * ``data_source_state.last_finding_*`` stamps the live detector
    evidence on every detection (including holds), distinct from
    last_reconcile_* which remains "last rebuild queued".

Inspector-guarded so a database that already received the columns
(``db_init``, another branch) does not die on DuplicateColumn.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260815_1200_recon_ops"
down_revision: Union[str, None] = "20260814_1600_recon_audit_link"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_SCHEMA = "aggregation"
_STATE = "data_source_state"
_EVENTS = "refresh_events"

_FINDING_COLUMNS = (
    ("last_finding_at", sa.Text()),
    ("last_finding_reason", sa.Text()),
    ("last_finding_evidence", sa.Text()),
)


def _columns(inspector: sa.engine.reflection.Inspector, table: str, *, schema: str | None = None) -> set:
    return {c["name"] for c in inspector.get_columns(table, schema=schema)}


def _index_names(inspector: sa.engine.reflection.Inspector, table: str, *, schema: str | None = None) -> set:
    return {ix["name"] for ix in inspector.get_indexes(table, schema=schema)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table(_STATE, schema=_SCHEMA):
        present = _columns(inspector, _STATE, schema=_SCHEMA)
        for name, col_type in _FINDING_COLUMNS:
            if name not in present:
                op.add_column(
                    _STATE,
                    sa.Column(name, col_type, nullable=True),
                    schema=_SCHEMA,
                )

    if inspector.has_table(_EVENTS):
        present = _columns(inspector, _EVENTS)
        if "run_id" not in present:
            op.add_column(_EVENTS, sa.Column("run_id", sa.Text(), nullable=True))
        if "idx_refresh_events_origin_run" not in _index_names(inspector, _EVENTS):
            op.create_index(
                "idx_refresh_events_origin_run",
                _EVENTS,
                ["origin", "run_id"],
            )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table(_EVENTS):
        if "idx_refresh_events_origin_run" in _index_names(inspector, _EVENTS):
            op.drop_index("idx_refresh_events_origin_run", _EVENTS)
        if "run_id" in _columns(inspector, _EVENTS):
            op.drop_column(_EVENTS, "run_id")

    if inspector.has_table(_STATE, schema=_SCHEMA):
        present = _columns(inspector, _STATE, schema=_SCHEMA)
        for name, _col_type in reversed(_FINDING_COLUMNS):
            if name in present:
                op.drop_column(_STATE, name, schema=_SCHEMA)
