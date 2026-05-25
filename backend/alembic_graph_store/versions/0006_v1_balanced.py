"""Graph Store: V1 BALANCED additions.

Revision ID: 0006_v1_balanced
Revises: 0005_source_layer
Create Date: 2026-05-25

Adds the substrate the V1 BALANCED plan locked in:

- ``graph_commits.merge_source_commit_id`` + ``merge_source_branch``
  — provenance pointer for squash-merge commits on trunk. Lets future
  draft GC reap intermediate commits without losing reachability /
  blame deep-drill. Direct-main commits leave both NULL.
- Index ``idx_graph_commits_committed_at`` on
  ``(graph_id, committed_at DESC)`` — backs the ``/as_of?at=`` query.
- Index ``idx_graph_commits_merge_source`` on
  ``(graph_id, merge_source_commit_id)`` — reverse-blame "what trunk
  commit landed this draft".
- ``graph_trunk_log`` — insert-only date index of trunk-only commits.
  One row per default-branch commit. Survives any future non-trunk-
  commit growth.
- ``graph_commit_contributors`` — per-(trunk-commit, user) attribution
  manifest, populated at squash time from the draft chain (the Wave 6
  audit copy companion).
- ``graph_projector_cursor`` — per-(graph, target) projection state
  for the FalkorDB projector (V1-5). Shape is multi-target ready so a
  future read-replica / warehouse / search projector slots in as new
  rows.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0006_v1_balanced"
down_revision: Union[str, None] = "0005_source_layer"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── graph_commits: provenance pointer columns + indexes ──
    op.execute(
        "ALTER TABLE graph_commits "
        "ADD COLUMN IF NOT EXISTS merge_source_commit_id text"
    )
    op.execute(
        "ALTER TABLE graph_commits "
        "ADD COLUMN IF NOT EXISTS merge_source_branch text"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_graph_commits_committed_at "
        "ON graph_commits (graph_id, committed_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_graph_commits_merge_source "
        "ON graph_commits (graph_id, merge_source_commit_id) "
        "WHERE merge_source_commit_id IS NOT NULL"
    )

    # ── graph_trunk_log: trunk-only date index ──
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS graph_trunk_log (
            graph_id text NOT NULL,
            commit_seq bigint NOT NULL,
            commit_id text NOT NULL,
            committed_at text NOT NULL,
            PRIMARY KEY (graph_id, commit_seq)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trunk_log_committed_at "
        "ON graph_trunk_log (graph_id, committed_at DESC)"
    )

    # ── graph_commit_contributors: per-(commit, user) attribution ──
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS graph_commit_contributors (
            commit_id text NOT NULL,
            user_id text NOT NULL,
            graph_id text NOT NULL,
            ops_count integer NOT NULL DEFAULT 0,
            first_op_at text,
            last_op_at text,
            PRIMARY KEY (commit_id, user_id)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_gcc_graph_user "
        "ON graph_commit_contributors (graph_id, user_id)"
    )

    # ── graph_projector_cursor: multi-target projection state ──
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS graph_projector_cursor (
            graph_id text NOT NULL,
            target text NOT NULL,
            last_applied_commit_seq bigint,
            last_applied_commit_id text,
            last_stream_id text,
            lag_seconds_observed double precision,
            last_error text,
            updated_at text NOT NULL,
            PRIMARY KEY (graph_id, target)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_gpc_target_updated "
        "ON graph_projector_cursor (target, updated_at)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_gpc_target_updated")
    op.execute("DROP TABLE IF EXISTS graph_projector_cursor")
    op.execute("DROP INDEX IF EXISTS idx_gcc_graph_user")
    op.execute("DROP TABLE IF EXISTS graph_commit_contributors")
    op.execute("DROP INDEX IF EXISTS idx_trunk_log_committed_at")
    op.execute("DROP TABLE IF EXISTS graph_trunk_log")
    op.execute("DROP INDEX IF EXISTS idx_graph_commits_merge_source")
    op.execute("DROP INDEX IF EXISTS idx_graph_commits_committed_at")
    op.execute(
        "ALTER TABLE graph_commits DROP COLUMN IF EXISTS merge_source_branch"
    )
    op.execute(
        "ALTER TABLE graph_commits DROP COLUMN IF EXISTS merge_source_commit_id"
    )
