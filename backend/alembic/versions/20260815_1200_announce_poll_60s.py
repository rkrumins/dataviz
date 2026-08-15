"""Announcement banner polls every 60s, not every 15s.

Revision ID: 20260815_1200_announce_poll_60s
Revises: 20260802_1000_open_publish
Create Date: 2026-08-15 12:00

``announcement_config.poll_interval_seconds`` shipped with a default of
15. The frontend has a tuned constant of 60
(``frontend/src/config/polling.ts``) with a comment explaining why 15
was too expensive at fleet scale — but that constant only applies until
``GET /announcements/config`` resolves, at which point the DB value
takes over. So the tuning never actually took effect anywhere: every
deployment polled the banner four times a minute, per tab, forever.

This moves the seeded row to 60 **only if it is still sitting at the old
default**. An operator who deliberately chose a value — including
deliberately choosing 15 — keeps it; this is a default correction, not a
policy override. The admin config endpoint still accepts anything >= 5,
so dialling it down for a live incident is unaffected.

Plain forward DDL per docs/MIGRATIONS.md.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "20260815_1200_announce_poll_60s"
down_revision: Union[str, None] = "20260802_1000_open_publish"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # WHERE poll_interval_seconds = 15 — the old default. A deployment
    # that never touched this setting moves to 60; one that chose a
    # value keeps it. The table is single-row (CHECK id = 1), so this
    # touches at most one row.
    op.execute(
        "UPDATE announcement_config SET poll_interval_seconds = 60 "
        "WHERE poll_interval_seconds = 15"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE announcement_config SET poll_interval_seconds = 15 "
        "WHERE poll_interval_seconds = 60"
    )
