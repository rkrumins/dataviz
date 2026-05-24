"""Graph Store: source layer for connected (Mode-2) graphs.

Revision ID: 0005_source_layer
Revises: 0004_view_id_audit
Create Date: 2026-05-24

Connected graphs (``user_graphs.origin = 'connected'``) materialize
the upstream system's view of the world into our store as the
**source layer**, then layer user edits on top as the **enrichment
layer** (the existing ``graph_node_versions`` / ``graph_edge_versions``
tables, already in place). Read-time composition merges the two —
enrichment wins on field overlap; tags union; deleted enrichments
suppress source items; source URNs that disappear are tracked as
orphans for the user to triage.

Tables (all on the Graph Store DB):

- ``graph_source_snapshots`` — one row per source-refresh run.
  Carries status, counts, error, and a content-derived
  ``source_root_hash`` so a follow-up sync that yields no change
  fast-paths.
- ``graph_source_nodes`` / ``graph_source_edges`` — current state
  of the source layer. ``last_sync_run_id`` tags rows so the
  end-of-run sweep can DELETE anything not touched this run.
- ``graph_orphan_enrichments`` — enrichment objects whose source
  URN vanished. Queue for human triage (drop enrichment, port to
  a different URN, or revive the source object upstream).

Plan section "Mode-2 — connected genesis-import" (decisions 21,
work item W4). Idempotent so re-runs across multiple environments
don't fail. View binding from the existing tables is unchanged.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0005_source_layer"
down_revision: Union[str, None] = "0004_view_id_audit"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS graph_source_snapshots (
            id text PRIMARY KEY,
            graph_id text NOT NULL REFERENCES user_graphs(id) ON DELETE CASCADE,
            source_data_source_id text,
            status text NOT NULL DEFAULT 'running',
            source_root_hash text,
            added_count integer NOT NULL DEFAULT 0,
            modified_count integer NOT NULL DEFAULT 0,
            removed_count integer NOT NULL DEFAULT 0,
            orphan_count integer NOT NULL DEFAULT 0,
            error_message text,
            triggered_by text,
            started_at text NOT NULL,
            finished_at text,
            CONSTRAINT ck_gss_status CHECK (
                status IN ('running','completed','failed')
            )
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_gss_graph_started "
        "ON graph_source_snapshots (graph_id, started_at DESC)"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS graph_source_nodes (
            graph_id text NOT NULL,
            urn text NOT NULL,
            entity_type text,
            display_name text,
            position jsonb,
            properties jsonb NOT NULL DEFAULT '{}'::jsonb,
            tags jsonb NOT NULL DEFAULT '[]'::jsonb,
            content_hash text NOT NULL,
            last_sync_run_id text NOT NULL,
            last_synced_at text NOT NULL,
            PRIMARY KEY (graph_id, urn)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_gsn_graph_runid "
        "ON graph_source_nodes (graph_id, last_sync_run_id)"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS graph_source_edges (
            graph_id text NOT NULL,
            urn text NOT NULL,
            source_urn text NOT NULL,
            target_urn text NOT NULL,
            edge_type text,
            properties jsonb NOT NULL DEFAULT '{}'::jsonb,
            tags jsonb NOT NULL DEFAULT '[]'::jsonb,
            content_hash text NOT NULL,
            last_sync_run_id text NOT NULL,
            last_synced_at text NOT NULL,
            PRIMARY KEY (graph_id, urn)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_gse_graph_runid "
        "ON graph_source_edges (graph_id, last_sync_run_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_gse_graph_src "
        "ON graph_source_edges (graph_id, source_urn)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_gse_graph_tgt "
        "ON graph_source_edges (graph_id, target_urn)"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS graph_orphan_enrichments (
            id text PRIMARY KEY,
            graph_id text NOT NULL,
            urn text NOT NULL,
            object_kind text NOT NULL,
            sync_run_id text NOT NULL,
            discovered_at text NOT NULL,
            resolved_at text,
            resolved_by text,
            resolution text,
            CONSTRAINT ck_goe_kind CHECK (object_kind IN ('node','edge'))
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_goe_graph_unresolved "
        "ON graph_orphan_enrichments (graph_id, resolved_at) "
        "WHERE resolved_at IS NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_goe_graph_unresolved")
    op.execute("DROP TABLE IF EXISTS graph_orphan_enrichments")
    op.execute("DROP INDEX IF EXISTS idx_gse_graph_tgt")
    op.execute("DROP INDEX IF EXISTS idx_gse_graph_src")
    op.execute("DROP INDEX IF EXISTS idx_gse_graph_runid")
    op.execute("DROP TABLE IF EXISTS graph_source_edges")
    op.execute("DROP INDEX IF EXISTS idx_gsn_graph_runid")
    op.execute("DROP TABLE IF EXISTS graph_source_nodes")
    op.execute("DROP INDEX IF EXISTS idx_gss_graph_started")
    op.execute("DROP TABLE IF EXISTS graph_source_snapshots")
