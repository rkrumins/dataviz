"""``graphver.review_requests`` and ``graphver.review_events``: who a review asks (a person, or a
group any member of which answers for it), and what happened on it, in order — each review given
(approve, request changes, or a comment, with a summary and the draft's head it was of), each
verdict taken back, and each change to who is asked.

They take over from ``merge_requests``' ``approved_by``/``approvals``/``changes_requested``, which
the upgrade carries over (``models.ensure_review_records``, idempotent; also a required step of
``_ensure_schema_upgrades`` for a separate ``GRAPHVER_DB_URL``). ``merge_requests.reviewers`` stays,
mirroring the people asked. Two new, empty tables with no foreign key: creating them locks nothing
in use.

The downgrade writes each review's people asked, its approvals that are each person's latest
verdict, and its latest request for changes back into those columns, then drops the tables — a
group asked, summaries and comments-as-verdicts have nowhere to go and are lost.

Revision ID: 20261118_1000_gv_review_records
Revises: 20261117_1500_gv_mr_sendback
Create Date: 2026-11-18 10:00
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_review_records

revision: str = "20261118_1000_gv_review_records"
down_revision: Union[str, None] = "20261117_1500_gv_mr_sendback"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    sch = gv_config.graphver_schema()
    if not sa.inspect(bind).has_schema(sch):
        return                              # create_schema_and_partitions builds them
    bind.execute(sa.text(
        f'CREATE TABLE IF NOT EXISTS "{sch}"."review_requests" ('
        "pr_id text NOT NULL, subject_type text NOT NULL, subject_id text NOT NULL, graph_id text NOT NULL, "
        "requested_by text, requested_at text NOT NULL, PRIMARY KEY (pr_id, subject_type, subject_id), "
        "CONSTRAINT ck_rr_subject_type CHECK (subject_type IN ('user','group')))"))
    bind.execute(sa.text(f'CREATE INDEX IF NOT EXISTS ix_rr_subject ON "{sch}"."review_requests" (subject_type, subject_id)'))
    bind.execute(sa.text(f'CREATE INDEX IF NOT EXISTS ix_rr_graph ON "{sch}"."review_requests" (graph_id)'))
    bind.execute(sa.text(
        f'CREATE TABLE IF NOT EXISTS "{sch}"."review_events" ('
        "id text PRIMARY KEY, pr_id text NOT NULL, graph_id text NOT NULL, actor text NOT NULL, "
        "kind text NOT NULL, verdict text, body text, head_commit_id text, head_seq bigint, "
        "subjects jsonb, groups jsonb, tally jsonb, created_at text NOT NULL, "
        "CONSTRAINT ck_re_kind CHECK (kind IN ('requested','unrequested','re_requested','reviewed','withdrew')), "
        "CONSTRAINT ck_re_verdict CHECK (verdict IS NULL OR verdict IN ('approve','request_changes','comment')))"))
    bind.execute(sa.text(f'CREATE INDEX IF NOT EXISTS ix_re_pr ON "{sch}"."review_events" (pr_id, created_at)'))
    bind.execute(sa.text(f'CREATE INDEX IF NOT EXISTS ix_re_graph ON "{sch}"."review_events" (graph_id)'))
    ensure_review_records(bind)


def downgrade() -> None:
    bind = op.get_bind()
    sch = gv_config.graphver_schema()
    if not sa.inspect(bind).has_table("review_events", schema=sch):
        return
    mr, rr, re_ = (f'"{sch}"."{t}"' for t in ("merge_requests", "review_requests", "review_events"))
    # Each person's latest verdict (or withdrawal), per review.
    latest = (f"SELECT DISTINCT ON (pr_id, actor) pr_id, actor, kind, verdict, body, head_commit_id, head_seq, "
              f"created_at FROM {re_} WHERE kind IN ('withdrew') OR verdict IN ('approve', 'request_changes') "
              f"ORDER BY pr_id, actor, created_at DESC, id DESC")
    bind.execute(sa.text(
        f"UPDATE {mr} m SET reviewers = q.ids FROM (SELECT pr_id, jsonb_agg(subject_id ORDER BY requested_at) ids "
        f"FROM {rr} WHERE subject_type = 'user' GROUP BY pr_id) q WHERE m.id = q.pr_id"))
    bind.execute(sa.text(
        f"UPDATE {mr} m SET approved_by = q.ids, approvals = q.heads FROM ("
        f"SELECT pr_id, jsonb_agg(actor) ids, jsonb_object_agg(actor, jsonb_build_object("
        f"'headCommitId', head_commit_id, 'headSeq', head_seq, 'at', created_at)) heads "
        f"FROM ({latest}) l WHERE verdict = 'approve' GROUP BY pr_id) q WHERE m.id = q.pr_id"))
    bind.execute(sa.text(
        f"UPDATE {mr} m SET changes_requested = q.req FROM ("
        f"SELECT DISTINCT ON (pr_id) pr_id, jsonb_build_object('by', actor, 'at', created_at, 'reason', body, "
        f"'headCommitId', head_commit_id, 'headSeq', head_seq) req FROM ({latest}) l "
        f"WHERE verdict = 'request_changes' ORDER BY pr_id, created_at DESC) q WHERE m.id = q.pr_id"))
    bind.execute(sa.text(f"DROP TABLE IF EXISTS {re_}"))
    bind.execute(sa.text(f"DROP TABLE IF EXISTS {rr}"))
