"""People analytics' daily rollup: each person's activity, a day at a time.

Revision ID: 20261203_1000_people_rollup
Revises: 20261202_1100_people_index
Create Date: 2026-12-03 10:00

The People roster read raw events on every build — grouped by person, hour, type, view and
workspace — so its cost grew with how much people did, not with how many there are. At
thousands of people and a year's window that is tens of millions of rows. These tables hold
the same facts folded to one row per person, day, workspace and kind, written by the people
indexer (``services/people_activity_indexer``), so a roster costs people × days, a person's
activity line is an indexed read, and nothing on a request path scans an event table.

* ``person_activity_daily`` — what each person did each UTC day, per workspace (``''`` when
  the event had none) and kind. ``n``/``first_at``/``last_at`` count everything;
  ``n_ws``/``first_ws_at``/``last_ws_at`` only what a workspace admin may see.
* ``person_daily_totals`` — the same days with no kind: one row per person per day for each
  workspace they were in, and one (``workspace_id = '*'``) for everywhere. What a roster
  reads: everyone's actions, sign-ins and active days are a scan of one row per person-day,
  however many workspaces and kinds the day spread over.
* ``people_daily_facets`` — the same days without the person, per workspace and for
  everywhere (``'*'``): by hour, event type, kind and section — the punchcard, "what people
  do" and the scope's series, which need no one's name.
* ``people_index_days`` — which days the indexer has computed, and which are dirty because
  something about them arrived late.

``idx_product_events_ws`` goes: the roster read it, and the roster now reads the rollup. An
index nothing reads still costs every insert on the busiest table there is. Dropped
CONCURRENTLY on Postgres; the downgrade builds it back the same way.

All four tables are new and empty, so nothing here needs a concurrent build. Inspector-guarded:
``0001_baseline`` create_all()s the current ORM.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261203_1000_people_rollup"
down_revision: Union[str, None] = "20261202_1100_people_index"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_DAILY = "person_activity_daily"
_FACETS = "people_daily_facets"
_TOTALS = "person_daily_totals"
_DAYS = "people_index_days"
_OLD_WS_INDEX = "idx_product_events_ws"


def _drop_ws_index(bind) -> None:
    if bind.dialect.name == "postgresql":
        with op.get_context().autocommit_block():
            bind.execute(sa.text(f"DROP INDEX CONCURRENTLY IF EXISTS {_OLD_WS_INDEX}"))
    elif _OLD_WS_INDEX in {i["name"] for i in sa.inspect(bind).get_indexes("product_events")}:
        op.drop_index(_OLD_WS_INDEX, table_name="product_events")


def _build_ws_index(bind) -> None:
    if bind.dialect.name == "postgresql":
        with op.get_context().autocommit_block():
            bind.execute(sa.text(
                f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {_OLD_WS_INDEX} "
                "ON product_events (workspace_id, created_at) WHERE workspace_id IS NOT NULL"
            ))
    elif _OLD_WS_INDEX not in {i["name"] for i in sa.inspect(bind).get_indexes("product_events")}:
        op.create_index(_OLD_WS_INDEX, "product_events", ["workspace_id", "created_at"],
                        sqlite_where=sa.text("workspace_id IS NOT NULL"))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table(_DAILY):
        op.create_table(
            _DAILY,
            sa.Column("day", sa.Text(), nullable=False),
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("workspace_id", sa.Text(), nullable=False),
            sa.Column("kind", sa.Text(), nullable=False),
            sa.Column("n", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("n_ws", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("first_at", sa.Text(), nullable=True),
            sa.Column("last_at", sa.Text(), nullable=True),
            sa.Column("first_ws_at", sa.Text(), nullable=True),
            sa.Column("last_ws_at", sa.Text(), nullable=True),
            sa.PrimaryKeyConstraint("day", "user_id", "workspace_id", "kind"),
        )
        op.create_index("idx_pad_workspace_day", _DAILY, ["workspace_id", "day"])
        op.create_index("idx_pad_user_day", _DAILY, ["user_id", "day"])
    if not inspector.has_table(_TOTALS):
        op.create_table(
            _TOTALS,
            sa.Column("workspace_id", sa.Text(), nullable=False),
            sa.Column("day", sa.Text(), nullable=False),
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("actions", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("actions_ws", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("signins", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("sections", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("last_action_at", sa.Text(), nullable=True),
            sa.Column("last_action_ws_at", sa.Text(), nullable=True),
            sa.Column("last_signin_at", sa.Text(), nullable=True),
            sa.PrimaryKeyConstraint("workspace_id", "day", "user_id"),
        )
        op.create_index("idx_pdt_user", _TOTALS, ["user_id", "workspace_id", "day"])
        op.create_index("idx_pdt_day", _TOTALS, ["day"])
    if not inspector.has_table(_FACETS):
        op.create_table(
            _FACETS,
            sa.Column("day", sa.Text(), nullable=False),
            sa.Column("workspace_id", sa.Text(), nullable=False),
            sa.Column("facet", sa.Text(), nullable=False),
            sa.Column("value", sa.Text(), nullable=False),
            sa.Column("n", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("n_ws", sa.Integer(), nullable=False, server_default="0"),
            sa.PrimaryKeyConstraint("day", "workspace_id", "facet", "value"),
        )
        op.create_index("idx_pdf_workspace_day", _FACETS, ["workspace_id", "day"])
    if not inspector.has_table(_DAYS):
        op.create_table(
            _DAYS,
            sa.Column("day", sa.Text(), primary_key=True),
            sa.Column("computed_at", sa.Text(), nullable=True),
            sa.Column("dirty", sa.Boolean(), nullable=False, server_default="false"),
        )
    # The slice cursors of the first indexer; the per-day indexer keeps its own.
    op.execute(sa.text(
        "DELETE FROM people_index_cursors WHERE name IN "
        "('attribute', 'rollup.usage', 'rollup.edits', 'rollup.ledger')"
    ))
    _drop_ws_index(bind)


def downgrade() -> None:
    bind = op.get_bind()
    _build_ws_index(bind)
    inspector = sa.inspect(bind)
    for table in (_DAYS, _FACETS, _TOTALS, _DAILY):
        if inspector.has_table(table):
            op.drop_table(table)
