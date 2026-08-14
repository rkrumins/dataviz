"""Automatic aggregation reconciliation.

Revision ID: 20260814_1200_agg_reconcile
Revises: 20260802_1000_open_publish
Create Date: 2026-08-14 12:00

An external system that reloads a data source rewrites the raw nodes and
edges with the same URNs but wipes the ``:AGGREGATED`` overlay. Nothing in
the product noticed: ``aggregation_edge_count`` is written once by the worker
on completion and never re-verified, and the drift sweep in ``scheduler.py``
only covers sources carrying an ``aggregation_schedule`` cron that no UI ever
sets. The lineage canvas served an empty rollup while every status said
``ready``.

This adds the state a scheduled sweep needs to detect that from the counts
the stats service already collects — no graph queries — and to audit what it
did and why.

Three groups of change:

  * ``aggregation.data_source_state`` gains the per-source policy (the
    opt-out flag and check cadence), the drift baseline, the last-checked /
    last-acted stamps, the stored drift verdict, and a circuit-breaker
    counter.
  * ``aggregation.reconcile_runs`` records one row per sweep, so the cockpit
    can show "last checked / N scanned / N findings" without writing a row
    per source per hour.
  * ``refresh_events`` gains ``reason`` and ``evidence``, and its origin
    CHECK admits ``reconcile-sweep``.

Note on the baseline column: ``raw_fingerprint`` is deliberately NOT
``graph_fingerprint``. That one is computed over every edge type INCLUDING
``AGGREGATED``, so it moves on every successful rebuild — using it as the
drift baseline would make each rebuild look like fresh drift and re-trigger
itself forever. The new column excludes ``AGGREGATED`` and is therefore
invariant across rebuilds by construction.

``reconcile-sweep`` is a distinct origin from the existing ``reconcile``,
which means the stale-marker reconciler in ``scheduler.py`` — a different
subsystem that the UI and tests already read by that name.

Plain forward DDL per docs/MIGRATIONS.md.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260814_1200_agg_reconcile"
down_revision: Union[str, None] = "20260802_1000_open_publish"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_ORIGIN_BEFORE = (
    "origin IN ('script', 'connector', 'api', 'drift', 'reconcile')"
)
_ORIGIN_AFTER = (
    "origin IN ('script', 'connector', 'api', 'drift', 'reconcile', "
    "'reconcile-sweep')"
)


def upgrade() -> None:
    # ── 1. Per-source reconciliation state ───────────────────────────
    for column in (
        # Policy. NULL at each level means "inherit the next one down"
        # (per-source → persisted global → env), the same resolution chain
        # ``rebuild_min_interval_secs`` already uses.
        sa.Column("reconcile_enabled", sa.Boolean(), nullable=True),
        sa.Column("reconcile_check_interval_secs", sa.Integer(), nullable=True),
        # Drift baseline + the counts behind it, for the audit evidence.
        sa.Column("raw_fingerprint", sa.Text(), nullable=True),
        sa.Column("raw_node_count", sa.Integer(), nullable=True),
        sa.Column("raw_edge_count", sa.Integer(), nullable=True),
        # Last evaluation vs last action — deliberately separate.
        sa.Column("last_reconcile_checked_at", sa.Text(), nullable=True),
        sa.Column("last_reconciled_at", sa.Text(), nullable=True),
        sa.Column("last_reconcile_reason", sa.Text(), nullable=True),
        sa.Column("last_reconcile_mode", sa.Text(), nullable=True),
        # Stored verdict, so the freshness read path stays pure SQL.
        sa.Column("drift_state", sa.Text(), nullable=True),
        # Circuit breaker against an un-clearable finding.
        sa.Column(
            "reconcile_consecutive_actions", sa.Integer(),
            nullable=True, server_default="0",
        ),
    ):
        op.add_column("data_source_state", column, schema="aggregation")

    # The sweep's candidate query orders by this and takes the oldest first,
    # so it is what keeps a fleet-wide scan bounded.
    op.create_index(
        "ix_ds_state_recon_due",
        "data_source_state",
        ["last_reconcile_checked_at"],
        schema="aggregation",
    )

    # ── 2. Sweep-level run records ───────────────────────────────────
    op.create_table(
        "reconcile_runs",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("started_at", sa.Text(), nullable=False),
        sa.Column("finished_at", sa.Text(), nullable=True),
        sa.Column("mode", sa.Text(), nullable=False, server_default="auto"),
        sa.Column("actor", sa.Text(), nullable=True),
        sa.Column("scanned", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("skipped", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("seeded", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("findings", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("actions", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("errors", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "mode IN ('auto', 'manual', 'preview')",
            name="ck_recon_runs_mode",
        ),
        schema="aggregation",
    )
    op.create_index(
        "ix_recon_runs_started", "reconcile_runs", ["started_at"],
        schema="aggregation",
    )

    # ── 3. Audit: why it fired, and the numbers behind it ────────────
    op.add_column("refresh_events", sa.Column("reason", sa.Text(), nullable=True))
    op.add_column("refresh_events", sa.Column("evidence", sa.Text(), nullable=True))

    # Drop-and-recreate under the SAME name. That is what makes this safe in
    # all three schema-CI paths: fresh-install never runs the chain (create_all
    # already produces the new expression); forward-migrate replaces the old
    # one (the real gate); chain-replay drops the create_all-produced
    # constraint by name and recreates it identically.
    op.drop_constraint(
        "ck_refresh_events_origin", "refresh_events", type_="check",
    )
    op.create_check_constraint(
        "ck_refresh_events_origin", "refresh_events", _ORIGIN_AFTER,
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_refresh_events_origin", "refresh_events", type_="check",
    )
    # Any 'reconcile-sweep' rows would violate the restored constraint, so
    # relabel them onto the nearest pre-existing origin first.
    op.execute(
        "UPDATE refresh_events SET origin = 'reconcile' "
        "WHERE origin = 'reconcile-sweep'"
    )
    op.create_check_constraint(
        "ck_refresh_events_origin", "refresh_events", _ORIGIN_BEFORE,
    )
    op.drop_column("refresh_events", "evidence")
    op.drop_column("refresh_events", "reason")

    op.drop_index("ix_recon_runs_started", "reconcile_runs", schema="aggregation")
    op.drop_table("reconcile_runs", schema="aggregation")

    op.drop_index(
        "ix_ds_state_recon_due", "data_source_state", schema="aggregation",
    )
    for name in (
        "reconcile_consecutive_actions",
        "drift_state",
        "last_reconcile_mode",
        "last_reconcile_reason",
        "last_reconciled_at",
        "last_reconcile_checked_at",
        "raw_edge_count",
        "raw_node_count",
        "raw_fingerprint",
        "reconcile_check_interval_secs",
        "reconcile_enabled",
    ):
        op.drop_column("data_source_state", name, schema="aggregation")
