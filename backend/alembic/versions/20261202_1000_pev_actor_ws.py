"""Per-person activity reads, and the workspace a usage signal happened in.

Revision ID: 20261202_1000_pev_actor_ws
Revises: 20261201_1000_ontology_create
Create Date: 2026-12-02 10:00

People analytics asks "what did THIS person do?" of the two tables that hold
what people do, and neither could answer it without reading every row in the
window: ``product_events`` had no index on ``actor_id`` and
``view_activity_log`` none on ``actor``. Both gain one that leads with the
person and ends on the timeline, so one person's year is a range scan.

``product_events.workspace_id`` is where a trace, a search or an export
happened. Those signals carried no workspace at all, so a workspace's people
view could count its view opens (through the view) but not whether anyone
traced lineage in it. NULL for everything recorded before, and for signals the
client sent without one — the index is partial, so those rows cost it nothing.

Inspector-guarded: ``0001_baseline`` create_all()s the CURRENT ORM, so a
brand-new environment already has all of this and a migrated one does not.

On Postgres the indexes build CONCURRENTLY, outside the revision's
transaction: both tables take a row on every view open or edit, and a plain
build would hold those writes for as long as it reads the table. A concurrent
build that gives up (``lock_timeout``) leaves an INVALID index; the next try
drops it and builds again, as ``20261122_1200_gv_job_notices`` does.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261202_1000_pev_actor_ws"
down_revision: Union[str, None] = "20261201_1000_ontology_create"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_EVENTS = "product_events"
_COLUMN = "workspace_id"

#: (name, table, columns, partial predicate or None)
_INDEXES: tuple[tuple[str, str, tuple[str, ...], str | None], ...] = (
    ("idx_product_events_actor", _EVENTS, ("actor_id", "created_at"), None),
    ("idx_product_events_ws", _EVENTS, ("workspace_id", "created_at"),
     "workspace_id IS NOT NULL"),
    ("idx_val_actor_created", "view_activity_log", ("actor", "created_at"), None),
)


def _columns(bind, table: str) -> set[str]:
    return {c["name"] for c in sa.inspect(bind).get_columns(table)}


def _indexes(bind, table: str) -> set[str]:
    return {i["name"] for i in sa.inspect(bind).get_indexes(table)}


def _pg_valid(bind, name: str):
    """True when the index is there and usable, False when a build of it
    stopped part-way, None when it is not there."""
    return bind.execute(
        sa.text("SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass(:i)"),
        {"i": name},
    ).scalar()


def upgrade() -> None:
    bind = op.get_bind()
    if _COLUMN not in _columns(bind, _EVENTS):
        op.add_column(_EVENTS, sa.Column(_COLUMN, sa.Text(), nullable=True))

    if bind.dialect.name != "postgresql":
        for name, table, cols, where in _INDEXES:
            if name not in _indexes(bind, table):
                kwargs = {"sqlite_where": sa.text(where)} if where else {}
                op.create_index(name, table, list(cols), **kwargs)
        return

    with op.get_context().autocommit_block():
        for name, table, cols, where in _INDEXES:
            valid = _pg_valid(bind, name)
            if valid:
                continue
            if valid is False:
                bind.execute(sa.text(f"DROP INDEX CONCURRENTLY IF EXISTS {name}"))
            predicate = f" WHERE {where}" if where else ""
            bind.execute(sa.text(
                f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {name} "
                f"ON {table} ({', '.join(cols)}){predicate}"
            ))


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        with op.get_context().autocommit_block():
            for name, _table, _cols, _where in reversed(_INDEXES):
                bind.execute(sa.text(f"DROP INDEX CONCURRENTLY IF EXISTS {name}"))
    else:
        for name, table, _cols, _where in reversed(_INDEXES):
            if name in _indexes(bind, table):
                op.drop_index(name, table_name=table)
    if _COLUMN in _columns(bind, _EVENTS):
        op.drop_column(_EVENTS, _COLUMN)
