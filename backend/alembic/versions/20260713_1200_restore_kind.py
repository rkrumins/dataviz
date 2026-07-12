"""Allow commits.kind = 'restore' (point-in-time rollback commits).

A restore commit resets main to the state at an earlier commit K as ONE new
auditable commit (kind='restore', source_commit_ids=[K]) — the multi-commit
counterpart of kind='revert' (single-commit inverse). History is never
rewritten. The ``ck_commits_kind`` CHECK is swapped in place; the ORM
constraint (``versioning/models.py``) carries the same set for fresh DBs —
this migration is MANDATORY for existing DBs because the worker-boot
``create_schema_and_partitions`` (create_all) never alters existing tables.

``commits`` is hash-partitioned on graph_id; the constraint on the parent
cascades to every partition.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20260713_1200_restore_kind"
down_revision: Union[str, None] = "20260712_1730_view_activity_data_changed"
branch_labels = None
depends_on = None

_KINDS_WITH_RESTORE = (
    "'genesis','edit','checkpoint','squash_publish','import','sync','revert','restore'"
)
_KINDS_WITHOUT_RESTORE = (
    "'genesis','edit','checkpoint','squash_publish','import','sync','revert'"
)


def upgrade() -> None:
    bind = op.get_bind()
    commits = f'"{gv_config.graphver_schema()}"."commits"'
    bind.execute(sa.text(f"ALTER TABLE {commits} DROP CONSTRAINT IF EXISTS ck_commits_kind"))
    bind.execute(sa.text(
        f"ALTER TABLE {commits} ADD CONSTRAINT ck_commits_kind "
        f"CHECK (kind IN ({_KINDS_WITH_RESTORE}))"))


def downgrade() -> None:
    bind = op.get_bind()
    commits = f'"{gv_config.graphver_schema()}"."commits"'
    bind.execute(sa.text(f"ALTER TABLE {commits} DROP CONSTRAINT IF EXISTS ck_commits_kind"))
    bind.execute(sa.text(
        f"ALTER TABLE {commits} ADD CONSTRAINT ck_commits_kind "
        f"CHECK (kind IN ({_KINDS_WITHOUT_RESTORE}))"))
