"""Denormalise a product event's subject out of its JSON payload.

Revision ID: 20260821_1200_event_subject
Revises: 20260817_1400_recon_pause
Create Date: 2026-08-21 12:00

``product_events`` kept what an event was ABOUT inside its JSON payload, which
no portable SQL can group on. Counting opens per view therefore meant selecting
every event in the window and decoding it in Python — linear in usage, on the
one table designed to grow with usage. At a few hundred concurrent users and a
year-long window that is tens of millions of rows per pass.

``subject_id`` makes it a GROUP BY served by an index, and makes "how much is
THIS view used?" a keyed lookup rather than a scan — which is what lets usage
appear on the content itself rather than only on the dashboard.

Inspector-guarded — 0001_baseline create_all()s the CURRENT ORM, so a bare
add_column here would make a brand-new environment unbuildable while every
migrated database kept working.
"""
from __future__ import annotations

import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260821_1200_event_subject"
down_revision: Union[str, None] = "20260817_1400_recon_pause"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "product_events"
_COLUMN = "subject_id"
_INDEX = "idx_product_events_subject"

#: Rows per backfill transaction. The table is small on every install that
#: reaches this migration — view opens only began being recorded one release
#: ago — but the loop is chunked anyway so it cannot become a long lock on an
#: install that sat on that release for a while.
_BATCH = 5_000


def _columns(bind) -> set[str]:
    return {c["name"] for c in sa.inspect(bind).get_columns(_TABLE)}


def _indexes(bind) -> set[str]:
    return {i["name"] for i in sa.inspect(bind).get_indexes(_TABLE)}


def _backfill(bind) -> None:
    """Copy ``payload->viewId`` into the column, in Python.

    Deliberately not a SQL JSON expression: SQLite spells it ``json_extract``
    and Postgres spells it ``::json->>``, and this project runs both. Decoding
    here is portable and, at these volumes, indistinguishable in cost.
    """
    table = sa.table(
        _TABLE,
        sa.column("id", sa.Text),
        sa.column("payload", sa.Text),
        sa.column(_COLUMN, sa.Text),
        sa.column("event_type", sa.Text),
    )
    while True:
        rows = bind.execute(
            sa.select(table.c.id, table.c.payload)
            .where(
                table.c.event_type == "view.opened",
                table.c[_COLUMN].is_(None),
                table.c.payload.isnot(None),
            )
            .limit(_BATCH)
        ).fetchall()
        if not rows:
            return
        updates = []
        for row_id, payload in rows:
            try:
                decoded = json.loads(payload)
            except (ValueError, TypeError):
                decoded = {}
            subject = decoded.get("viewId") if isinstance(decoded, dict) else None
            # A row whose payload carries no view id would be re-selected
            # forever by the `IS NULL` predicate above, so it is stamped with
            # the empty string: still falsy to every reader, and terminating.
            updates.append({"row_id": row_id, "subject": subject or ""})
        bind.execute(
            table.update().where(table.c.id == sa.bindparam("row_id")).values(
                **{_COLUMN: sa.bindparam("subject")}
            ),
            updates,
        )
        if len(rows) < _BATCH:
            return


def upgrade() -> None:
    bind = op.get_bind()
    if _COLUMN not in _columns(bind):
        op.add_column(_TABLE, sa.Column(_COLUMN, sa.Text(), nullable=True))
    _backfill(bind)
    if _INDEX not in _indexes(bind):
        op.create_index(_INDEX, _TABLE, ["event_type", _COLUMN, "created_at"])


def downgrade() -> None:
    bind = op.get_bind()
    if _INDEX in _indexes(bind):
        op.drop_index(_INDEX, table_name=_TABLE)
    if _COLUMN in _columns(bind):
        op.drop_column(_TABLE, _COLUMN)
