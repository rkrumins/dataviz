"""Member sets: everything a set of seeds reaches, resolved a step at a time and kept to be read.

``member_sets``: one resolution of a membership spec on one graph's data — its identity
(``key``), where it is (``stage``, ``state``, the counters) and the fence a step writes
through (``step``, ``lease_*``). ``member_set_rows``: each entity in it and the walk's state
on it, read in ``seq`` order. ``member_set_edges``: the lineage between members, when asked
for. Ordinary logged tables: a set is rebuilt from nothing far slower than it is kept, and a
crash must not lose a finished one.

New tables only, so nothing busy is locked; the wait for locks is bounded all the same, as
every revision here bounds it. Guarded DDL (a ``create_all`` baseline already has all of it).
Revision id is kept <=32 chars (alembic_version.version_num is VARCHAR(32)).

Revision ID: 20261118_1000_member_sets
Revises: 20261117_1500_gv_mr_sendback
Create Date: 2026-11-18 10:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20261118_1000_member_sets"
down_revision: Union[str, None] = "20261117_1500_gv_mr_sendback"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_STATUSES = "'running', 'complete', 'failed', 'expired'"
_STAGES = "'seeds', 'inside', 'upstream', 'downstream', 'partnerInside', 'done'"


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: giving up (to be run again) beats
    queueing reads behind a long transaction."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def _partial(where: str) -> dict:
    return {"postgresql_where": sa.text(where), "sqlite_where": sa.text(where)}


def upgrade() -> None:
    _bound_lock_wait()
    inspector = sa.inspect(op.get_bind())

    if not inspector.has_table("member_sets"):
        op.create_table(
            "member_sets",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("key", sa.Text(), nullable=False, unique=True),
            sa.Column("workspace_id", sa.Text(), nullable=False),
            sa.Column("data_source_id", sa.Text(), nullable=True),
            sa.Column("branch_id", sa.Text(), nullable=True),
            sa.Column("read_in", sa.Text(), nullable=True),
            sa.Column("spec", sa.Text(), nullable=False),
            sa.Column("spec_hash", sa.Text(), nullable=False),
            sa.Column("data_version", sa.Text(), nullable=False),
            sa.Column("include_edges", sa.Boolean(), nullable=False),
            sa.Column("status", sa.Text(), nullable=False),
            sa.Column("stage", sa.Text(), nullable=False),
            sa.Column("state", sa.Text(), nullable=True),
            sa.Column("counts", sa.Text(), nullable=True),
            sa.Column("truncated", sa.Text(), nullable=True),
            sa.Column("member_count", sa.Integer(), nullable=False),
            sa.Column("edge_count", sa.Integer(), nullable=False),
            sa.Column("next_seq", sa.Integer(), nullable=False),
            sa.Column("step", sa.Integer(), nullable=False),
            sa.Column("lease_owner", sa.Text(), nullable=True),
            sa.Column("lease_until", sa.Text(), nullable=True),
            sa.Column("created_by", sa.Text(), nullable=True),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
            sa.Column("completed_at", sa.Text(), nullable=True),
            sa.Column("expires_at", sa.Text(), nullable=True),
            sa.Column("last_read_at", sa.Text(), nullable=True),
            sa.Column("error", sa.Text(), nullable=True),
            sa.CheckConstraint(f"status IN ({_STATUSES})", name="ck_member_sets_status"),
            sa.CheckConstraint(f"stage IN ({_STAGES})", name="ck_member_sets_stage"),
        )
    op.create_index("idx_member_sets_expiry", "member_sets", ["status", "expires_at"], if_not_exists=True)
    op.create_index("idx_member_sets_workspace", "member_sets", ["workspace_id"], if_not_exists=True)

    if not inspector.has_table("member_set_rows"):
        op.create_table(
            "member_set_rows",
            sa.Column("set_id", sa.Text(), sa.ForeignKey("member_sets.id", ondelete="CASCADE"),
                      primary_key=True),
            sa.Column("urn", sa.Text(), primary_key=True),
            sa.Column("seq", sa.Integer(), nullable=False),
            sa.Column("via", sa.Text(), nullable=False),
            sa.Column("hops_up", sa.Integer(), nullable=True),
            sa.Column("hops_down", sa.Integer(), nullable=True),
            sa.Column("walked_up", sa.Integer(), nullable=True),
            sa.Column("walked_down", sa.Integer(), nullable=True),
            sa.Column("queued_up", sa.Boolean(), nullable=False),
            sa.Column("queued_down", sa.Boolean(), nullable=False),
            sa.Column("cursor_up", sa.Text(), nullable=True),
            sa.Column("cursor_down", sa.Text(), nullable=True),
            sa.Column("whole", sa.Boolean(), nullable=False),
            sa.Column("name", sa.Text(), nullable=True),
            sa.Column("type", sa.Text(), nullable=True),
            sa.Column("qualified_name", sa.Text(), nullable=True),
            sa.Column("nearest_seed", sa.Text(), nullable=True),
        )
    op.create_index("idx_msr_seq", "member_set_rows", ["set_id", "seq"], if_not_exists=True)
    op.create_index("idx_msr_queued_up", "member_set_rows", ["set_id", "hops_up", "seq"],
                    if_not_exists=True, **_partial("queued_up"))
    op.create_index("idx_msr_queued_down", "member_set_rows", ["set_id", "hops_down", "seq"],
                    if_not_exists=True, **_partial("queued_down"))
    op.create_index("idx_msr_cursor_up", "member_set_rows", ["set_id", "seq"],
                    if_not_exists=True, **_partial("cursor_up <> ''"))
    op.create_index("idx_msr_cursor_down", "member_set_rows", ["set_id", "seq"],
                    if_not_exists=True, **_partial("cursor_down <> ''"))

    if not inspector.has_table("member_set_edges"):
        op.create_table(
            "member_set_edges",
            sa.Column("set_id", sa.Text(), sa.ForeignKey("member_sets.id", ondelete="CASCADE"),
                      primary_key=True),
            sa.Column("source_urn", sa.Text(), primary_key=True),
            sa.Column("target_urn", sa.Text(), primary_key=True),
            sa.Column("edge_type", sa.Text(), primary_key=True),
            sa.Column("seq", sa.Integer(), nullable=False),
        )
    op.create_index("idx_mse_seq", "member_set_edges", ["set_id", "seq"], if_not_exists=True)


def downgrade() -> None:
    _bound_lock_wait()
    op.drop_index("idx_mse_seq", table_name="member_set_edges", if_exists=True)
    op.drop_table("member_set_edges", if_exists=True)
    for name in ("idx_msr_cursor_down", "idx_msr_cursor_up", "idx_msr_queued_down",
                 "idx_msr_queued_up", "idx_msr_seq"):
        op.drop_index(name, table_name="member_set_rows", if_exists=True)
    op.drop_table("member_set_rows", if_exists=True)
    op.drop_index("idx_member_sets_workspace", table_name="member_sets", if_exists=True)
    op.drop_index("idx_member_sets_expiry", table_name="member_sets", if_exists=True)
    op.drop_table("member_sets", if_exists=True)
