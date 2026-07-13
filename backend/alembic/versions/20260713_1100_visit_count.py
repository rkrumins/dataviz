"""Count opens per (user, view) so "most viewed" can mean something.

``view_visits`` upserts one row per (user, view), so it recorded WHEN someone
last opened a view but never HOW OFTEN. That is enough for "continue where you
left off" and useless for popularity: the table could tell us six views had been
opened by one person and nothing more.

``visit_count`` is incremented on each open. Popularity is then two honest
numbers — how many DISTINCT people opened a view (the social signal: "what is
the team looking at") and how many times it was opened in total. Existing rows
backfill to 1: we know each of them happened at least once, and inventing a
larger number would be a lie.

Revision id is kept <=32 chars (alembic_version.version_num is VARCHAR(32)).
The ORM (``ViewVisitORM``) declares the same column so create_all covers
fresh/test DBs; this migration covers existing Postgres.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260713_1100_visit_count"
down_revision: Union[str, None] = "20260713_1000_view_visits"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "view_visits",
        sa.Column("visit_count", sa.Integer(), nullable=False, server_default="1"),
    )
    # No index needed: the ranking key (view_id) is ALREADY indexed —
    # ``idx_visits_view`` is declared on the ORM and created by the view_visits
    # migration. Re-creating it here fails the whole upgrade on DuplicateTable,
    # and because DDL is transactional that rolls back the column too.


def downgrade() -> None:
    op.drop_column("view_visits", "visit_count")
