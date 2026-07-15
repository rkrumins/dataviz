"""Add the ``pull`` commit kind — a pull is a real event in a branch's history.

Pulling latest (`rebase_draft`) used to leave *no trace* in the common case. It computed its deltas
over only the entities the draft itself had touched, so when upstream changes didn't collide with
your edits the delta was empty and **no commit was written at all** — `base_commit_seq` just moved.
The branch history showed a silent gap exactly where someone else's work arrived. And when a commit
*was* written it was an ordinary ``checkpoint`` holding the draft's own rebased edits, which says
nothing about what came in.

So a pull now always writes a commit of its own kind, carrying the upstream commits it folded in
(``source_commit_ids``/``source_commit_count``/``contributors``) — which also means the existing
"merged N commits" drill-down in `CommitRow` renders it for free.

WIDEN-ONLY, as ever: the new list is every existing kind PLUS ``pull``. Dropping a value that a live
table already contains makes the constraint unaddable and wedges the whole upgrade chain.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20260714_1600_pull_kind"
down_revision: Union[str, None] = "20260714_1500_pr_one_live"
branch_labels = None
depends_on = None

_KINDS_WITHOUT_PULL = (
    "'genesis','edit','checkpoint','squash_publish','import','sync','revert','restore'"
)
_KINDS_WITH_PULL = (
    "'genesis','edit','checkpoint','squash_publish','import','sync','revert','restore','pull'"
)


def upgrade() -> None:
    bind = op.get_bind()
    commits = f'"{gv_config.graphver_schema()}"."commits"'
    bind.execute(sa.text(f"ALTER TABLE {commits} DROP CONSTRAINT IF EXISTS ck_commits_kind"))
    bind.execute(sa.text(
        f"ALTER TABLE {commits} ADD CONSTRAINT ck_commits_kind "
        f"CHECK (kind IN ({_KINDS_WITH_PULL}))"))


def downgrade() -> None:
    # Narrowing the allow-list fails if any `pull` commit has been written — which is correct: the
    # rows are real history and must not be silently dropped. Rewrite them before downgrading.
    bind = op.get_bind()
    commits = f'"{gv_config.graphver_schema()}"."commits"'
    bind.execute(sa.text(f"ALTER TABLE {commits} DROP CONSTRAINT IF EXISTS ck_commits_kind"))
    bind.execute(sa.text(
        f"ALTER TABLE {commits} ADD CONSTRAINT ck_commits_kind "
        f"CHECK (kind IN ({_KINDS_WITHOUT_PULL}))"))
