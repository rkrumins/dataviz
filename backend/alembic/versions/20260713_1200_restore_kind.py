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
# Re-pointed at merge time. This branch was cut before `20260713_1000_view_visits` landed on
# the base branch, and that migration hangs off the SAME parent — so merging the two as-cut
# gives alembic TWO HEADS and `upgrade head` refuses to run at all. Git does not warn: the
# two migrations are different files with no textual conflict. Chaining onto it instead of
# beside it keeps one linear history, and needs no merge migration.
down_revision: Union[str, None] = "20260713_1000_view_visits"
branch_labels = None
depends_on = None

# WIDEN-ONLY, including on HISTORICAL REPLAY: both lists carry 'pull'
# even though it "belongs" to the later 20260714_1600_pull_kind
# migration. A DB bootstrapped by worker-boot create_all gets the
# CURRENT ORM constraint (with 'pull') and the app writes pull commits
# immediately; when alembic then replays history, this migration's
# original pull-less list re-added a constraint NARROWER than the live
# data → CheckViolation on commits partitions → the whole upgrade
# chain wedged before ever reaching the widening migration. An
# intermediate migration must never narrow a constraint below what
# current app code writes.
_KINDS_WITH_RESTORE = (
    "'genesis','edit','checkpoint','squash_publish','import','sync','revert','restore','pull'"
)
_KINDS_WITHOUT_RESTORE = (
    "'genesis','edit','checkpoint','squash_publish','import','sync','revert','pull'"
)


def upgrade() -> None:
    bind = op.get_bind()
    commits = f'"{gv_config.graphver_schema()}"."commits"'
    # Pre-validate over live data so a mismatch fails with the ACTUAL
    # offending values (and row counts) instead of an opaque partition
    # CheckViolation. Any hit means some writer produced a kind this
    # file doesn't know — widen the lists (WIDEN-ONLY doctrine, see
    # models.py ck_commits_kind); never delete the rows.
    stray = bind.execute(sa.text(
        f"SELECT kind, count(*) FROM {commits} "
        f"WHERE kind NOT IN ({_KINDS_WITH_RESTORE}) GROUP BY kind"
    )).fetchall()
    if stray:
        raise RuntimeError(
            "restore_kind migration: commits.kind contains value(s) outside the "
            f"target constraint list: {[(r[0], r[1]) for r in stray]!r}. "
            "Widen _KINDS_WITH_RESTORE/_KINDS_WITHOUT_RESTORE in this file to "
            "include them (WIDEN-ONLY) — do not delete rows."
        )
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
