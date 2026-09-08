"""The record that a check RAN, not just that a value moved.

Revision ID: 20260908_1200_check_events
Revises: 20260902_1000_derived_artifacts
Create Date: 2026-09-08 12:00

``data_source_count_snapshots`` answers "what did this source contain, and when
did that change". It cannot answer "was anybody watching": capture is
change-gated, and a FAILED collection deliberately writes nothing, so a source
that has been steady for a day and a source nobody has been able to reach for a
day produce the same picture — no rows. Reading liveness out of the absence of
movement is exactly the inference that hides an outage.

``data_source_check_events`` records the occurrence. Every lane that validates a
source — the 60s drift probe, the counts poll, the deep profile, the reconcile
sweep — writes that it ran and how it went, so the profiling drawer can say
"checked 96 times in the last 24h, all healthy" as a fact rather than an
inference.

Sampled, not exhaustive: the probe lane alone would otherwise write 1,440 rows
per source per day describing a source that neither changed nor failed. Rows
are written when the signature (outcome, detail) changes, and otherwise at most
once per ``PROFILING_CHECK_SAMPLE_SECS`` — so a healthy source produces a cheap
steady pulse, and a source that breaks records the transition immediately plus
every distinct error after it.

No foreign key, same as the snapshots beside it: the check history of a source
that was removed is exactly the history someone comes looking for.

Inspector-guarded in both directions — ``0001_baseline`` create_all()s the
CURRENT ORM, so a bare ``create_table`` here would make a brand-new environment
unbuildable while every migrated database kept working.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260908_1200_check_events"
down_revision: Union[str, None] = "20260902_1000_derived_artifacts"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_CHECKS = "data_source_check_events"

# (name, columns) — created only when absent, dropped only when present.
_INDEXES = (
    ("ix_dsce_ds_checked", ["data_source_id", "checked_at"]),
    ("ix_dsce_ds_lane_checked", ["data_source_id", "lane", "checked_at"]),
    ("ix_dsce_checked", ["checked_at"]),
)


def _index_names(inspector: sa.engine.reflection.Inspector, table: str) -> set:
    return {ix["name"] for ix in inspector.get_indexes(table)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table(_CHECKS):
        op.create_table(
            _CHECKS,
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("data_source_id", sa.Text(), nullable=False),
            sa.Column("checked_at", sa.Text(), nullable=False),
            sa.Column("lane", sa.Text(), nullable=False, server_default="poll"),
            sa.Column("outcome", sa.Text(), nullable=False, server_default="ok"),
            sa.Column("changed", sa.Boolean(), nullable=True),
            sa.Column("detail", sa.Text(), nullable=True),
            sa.Column("duration_ms", sa.Integer(), nullable=True),
            sa.CheckConstraint(
                "lane IN ('probe', 'poll', 'deep', 'sweep', 'write', "
                "'reconcile', 'discovery')",
                name="ck_dsce_lane",
            ),
            sa.CheckConstraint(
                "outcome IN ('ok', 'error', 'skipped')", name="ck_dsce_outcome",
            ),
        )
        inspector = sa.inspect(bind)

    if inspector.has_table(_CHECKS):
        present = _index_names(inspector, _CHECKS)
        for name, cols in _INDEXES:
            if name not in present:
                op.create_index(name, _CHECKS, cols)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table(_CHECKS):
        present = _index_names(inspector, _CHECKS)
        for name, _cols in reversed(_INDEXES):
            if name in present:
                op.drop_index(name, table_name=_CHECKS)
        op.drop_table(_CHECKS)
