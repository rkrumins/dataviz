"""One live pull request per source branch + ``merged_via`` provenance.

A PR points at a source *branch* and its diff is computed live from that branch at read time —
never snapshotted. So commits made after the PR was raised are **already** part of it, and a second
PR from the same branch is a duplicate rather than a new proposal. Nothing enforced that: there was
no DB constraint, no service check and no UI check, so "Submit for review" could be clicked N times
to produce N live PRs on one branch. Merging any one of them marks the branch ``merged``, at which
point every sibling is unmergeable (it fails ``_require_open``) while the UI still lists it as
actionable.

This revision makes the invariant real:

  1. ``merged_via`` records HOW a PR was resolved — ``review`` (merged through the PR) or
     ``direct_publish`` (an admin published the branch straight to main, which lands the same
     changes and therefore resolves the PR). Without it a bypassed review is indistinguishable from
     a reviewed merge.
  2. Pre-existing duplicates are **closed** — newest live PR per branch survives, the rest are
     marked ``closed``. This is destructive to those rows by design; they were already dead (their
     branch can only be merged once), and the unique index below cannot be created while they exist.
  3. ``uq_mr_live_source_branch`` — a partial unique index over the live statuses. This is the real
     enforcement: it closes the race where two concurrent openers both pass the service pre-check.

NOTE the index is partial (``WHERE status NOT IN ('merged','closed')``) — merged/closed PRs pile up
per branch as history and must stay exempt.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20260714_1500_pr_one_live"
down_revision: Union[str, None] = "20260714_1400_layer_edit_dflt"
branch_labels = None
depends_on = None

_LIVE = "status NOT IN ('merged','closed')"


def upgrade() -> None:
    bind = op.get_bind()
    mr = f'"{gv_config.graphver_schema()}"."merge_requests"'

    bind.execute(sa.text(f"ALTER TABLE {mr} ADD COLUMN IF NOT EXISTS merged_via text"))

    # Backfill: every already-merged PR got there through its own review — direct publish did not
    # resolve PRs at all before this change (it orphaned them), so `review` is the truthful value.
    bind.execute(sa.text(
        f"UPDATE {mr} SET merged_via = 'review' WHERE status = 'merged' AND merged_via IS NULL"
    ))

    # Close pre-existing duplicates, newest-first survives. Report what we touched: a silent
    # destructive migration reads as "there was nothing to do", which is exactly the wrong story if
    # an operator later wonders where a PR went.
    dupes = bind.execute(sa.text(f"""
        WITH ranked AS (
            SELECT id, source_branch_id,
                   row_number() OVER (PARTITION BY source_branch_id ORDER BY created_at DESC, id DESC) AS rn
              FROM {mr}
             WHERE {_LIVE}
        )
        UPDATE {mr} m
           SET status    = 'closed',
               closed_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               closed_by = 'system:one-live-pr-migration'
          FROM ranked r
         WHERE m.id = r.id AND r.rn > 1
        RETURNING m.id, m.source_branch_id
    """)).fetchall()
    if dupes:
        print(f"[20260714_1500_pr_one_live] closed {len(dupes)} duplicate live PR(s): "
              + ", ".join(f"{r[0]} (branch {r[1]})" for r in dupes))

    bind.execute(sa.text(
        f"CREATE UNIQUE INDEX IF NOT EXISTS uq_mr_live_source_branch "
        f"ON {mr} (source_branch_id) WHERE {_LIVE}"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    mr = f'"{gv_config.graphver_schema()}"."merge_requests"'
    schema = gv_config.graphver_schema()
    bind.execute(sa.text(f'DROP INDEX IF EXISTS "{schema}"."uq_mr_live_source_branch"'))
    bind.execute(sa.text(f"ALTER TABLE {mr} DROP COLUMN IF EXISTS merged_via"))
    # The closed duplicates are NOT reopened — they were unmergeable rows and reopening them would
    # recreate the broken state this revision exists to remove.
