"""View versions, and the identity a view carries between environments.

Revision ID: 20260923_1000_view_versions
Revises: 20260920_1200_view_entity_scope
Create Date: 2026-09-23 10:00

Two things a view has never had:

  * ``views.portable_id``: an identity that survives export and import. ``views.id`` is minted
    per environment, so dev's view and prod's copy of it had no way to recognise each other
    and every re-import made a duplicate. The id is copied into the exported file and adopted
    by the import.
  * ``view_versions``: immutable, content-addressed checkpoints of a view's design (layers,
    assignments, settings). The history of the view itself, not of the graph data under it,
    which graph version control already keeps.

The activity CHECK gains ``imported``, ``exported``, ``version_saved`` and
``version_restored``.

Existing views get a ``portable_id`` below. They get NO version rows: a view's first version
is taken lazily, the first time its history or an export needs one, so this migration does
not copy every view's config into a second table.

Fresh installs get the column and table from ``0001_baseline``'s create_all and never run
this file, so the DDL is guarded (docs/MIGRATIONS.md, "Guard the DDL; never guard the data").
The backfill is not guarded: it only touches rows whose ``portable_id`` is still NULL, so a
re-run is a no-op rather than a skip.
"""
from __future__ import annotations

import logging
import uuid
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260923_1000_view_versions"
down_revision: Union[str, None] = "20260920_1200_view_entity_scope"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

log = logging.getLogger("alembic.runtime.migration")

BATCH = 500

_ACTIONS_OLD = (
    "'created', 'updated', 'visibility_changed', 'shared', 'unshared', "
    "'favourited', 'unfavourited', 'deleted', 'restored', 'data_changed', "
    "'publish_requested', 'publish_denied', 'admin_viewed'"
)
_ACTIONS_NEW = _ACTIONS_OLD + ", 'imported', 'exported', 'version_saved', 'version_restored'"

_SOURCES = (
    "'baseline', 'create', 'wizard', 'import', 'restore', "
    "'promote', 'export', 'manual', 'snapshot'"
)


def upgrade() -> None:
    bind = op.get_bind()

    bind.execute(sa.text("ALTER TABLE views ADD COLUMN IF NOT EXISTS portable_id TEXT"))
    bind.execute(sa.text("CREATE INDEX IF NOT EXISTS idx_view_portable ON views (portable_id)"))

    # Every existing view gets its own identity. Minted in Python rather than SQL so the same
    # statement runs on Postgres and SQLite, which spell "random uuid" differently.
    ids = [row[0] for row in bind.execute(
        sa.text("SELECT id FROM views WHERE portable_id IS NULL")).fetchall()]
    params = [{"vid": vid, "pid": f"pv_{uuid.uuid4().hex}"} for vid in ids]
    for i in range(0, len(params), BATCH):
        bind.execute(
            sa.text("UPDATE views SET portable_id = :pid WHERE id = :vid AND portable_id IS NULL"),
            params[i:i + BATCH],
        )
    log.info("view_versions: stamped a portable_id on %d existing views", len(params))

    if not sa.inspect(bind).has_table("view_versions"):
        op.create_table(
            "view_versions",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("view_id", sa.Text(),
                      sa.ForeignKey("views.id", ondelete="CASCADE"), nullable=False),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.Column("content_hash", sa.Text(), nullable=False),
            sa.Column("definition", sa.Text(), nullable=False),
            sa.Column("name", sa.Text(), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("icon", sa.Text(), nullable=True),
            sa.Column("tags", sa.Text(), nullable=True),
            sa.Column("view_type", sa.Text(), nullable=False),
            sa.Column("source", sa.Text(), nullable=False),
            sa.Column("message", sa.Text(), nullable=True),
            sa.Column("parent_version", sa.Integer(), nullable=True),
            sa.Column("stats", sa.Text(), nullable=True),
            sa.Column("provenance", sa.Text(), nullable=True),
            sa.Column("ontology_digest", sa.Text(), nullable=True),
            sa.Column("request_id", sa.Text(), nullable=True),
            sa.Column("created_by", sa.Text(), nullable=True),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.UniqueConstraint("view_id", "version", name="uq_view_versions_view_version"),
            sa.CheckConstraint(f"source IN ({_SOURCES})", name="ck_view_versions_source"),
        )
    bind.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_vv_view_created ON view_versions (view_id, created_at)"
    ))
    bind.execute(sa.text(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_vv_request_id ON view_versions (request_id) "
        "WHERE request_id IS NOT NULL"
    ))

    op.drop_constraint("ck_val_action_enum", "view_activity_log", type_="check")
    op.create_check_constraint(
        "ck_val_action_enum", "view_activity_log", f"action IN ({_ACTIONS_NEW})",
    )


def downgrade() -> None:
    op.drop_constraint("ck_val_action_enum", "view_activity_log", type_="check")
    # Rows carrying a widened verb would violate the narrower constraint.
    op.execute(
        "DELETE FROM view_activity_log WHERE action IN "
        "('imported', 'exported', 'version_saved', 'version_restored')"
    )
    op.create_check_constraint(
        "ck_val_action_enum", "view_activity_log", f"action IN ({_ACTIONS_OLD})",
    )

    op.drop_index("uq_vv_request_id", table_name="view_versions")
    op.drop_index("idx_vv_view_created", table_name="view_versions")
    op.drop_table("view_versions")
    op.drop_index("idx_view_portable", table_name="views")
    op.drop_column("views", "portable_id")
