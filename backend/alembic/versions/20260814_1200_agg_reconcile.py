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

Mirrors the ``db_init.py`` additive ``ADD COLUMN IF NOT EXISTS`` safety-net
(CP/Worker). Fresh deploys get the state columns from the baseline's
``create_all``; existing DBs already touched by ``db_init`` have some or all
pieces — every step is inspector-guarded, so it is idempotent both ways.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260814_1200_agg_reconcile"
down_revision: Union[str, None] = "20260802_1000_open_publish"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_SCHEMA = "aggregation"
_STATE = "data_source_state"
_RUNS = "reconcile_runs"
_EVENTS = "refresh_events"

_ORIGIN_BEFORE = (
    "origin IN ('script', 'connector', 'api', 'drift', 'reconcile')"
)
_ORIGIN_AFTER = (
    "origin IN ('script', 'connector', 'api', 'drift', 'reconcile', "
    "'reconcile-sweep')"
)

_STATE_COLUMNS = (
    # Policy. NULL at each level means "inherit the next one down"
    # (per-source → persisted global → env), the same resolution chain
    # ``rebuild_min_interval_secs`` already uses.
    ("reconcile_enabled", sa.Boolean(), None),
    ("reconcile_check_interval_secs", sa.Integer(), None),
    # Drift baseline + the counts behind it, for the audit evidence.
    ("raw_fingerprint", sa.Text(), None),
    ("raw_node_count", sa.Integer(), None),
    ("raw_edge_count", sa.Integer(), None),
    # Last evaluation vs last action — deliberately separate.
    ("last_reconcile_checked_at", sa.Text(), None),
    ("last_reconciled_at", sa.Text(), None),
    ("last_reconcile_reason", sa.Text(), None),
    ("last_reconcile_mode", sa.Text(), None),
    # Stored verdict, so the freshness read path stays pure SQL.
    ("drift_state", sa.Text(), None),
    # Circuit breaker against an un-clearable finding.
    ("reconcile_consecutive_actions", sa.Integer(), "0"),
)


def _columns(inspector: sa.engine.reflection.Inspector, table: str, *, schema: str | None = None) -> set:
    return {c["name"] for c in inspector.get_columns(table, schema=schema)}


def _index_names(inspector: sa.engine.reflection.Inspector, table: str, *, schema: str | None = None) -> set:
    return {ix["name"] for ix in inspector.get_indexes(table, schema=schema)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # ── 1. Per-source reconciliation state ───────────────────────────
    if inspector.has_table(_STATE, schema=_SCHEMA):
        present = _columns(inspector, _STATE, schema=_SCHEMA)
        for name, col_type, server_default in _STATE_COLUMNS:
            if name not in present:
                kwargs = {}
                if server_default is not None:
                    kwargs["server_default"] = server_default
                op.add_column(
                    _STATE,
                    sa.Column(name, col_type, nullable=True, **kwargs),
                    schema=_SCHEMA,
                )
        if "ix_ds_state_recon_due" not in _index_names(inspector, _STATE, schema=_SCHEMA):
            # The sweep's candidate query orders by this and takes the oldest
            # first, so it is what keeps a fleet-wide scan bounded.
            op.create_index(
                "ix_ds_state_recon_due",
                _STATE,
                ["last_reconcile_checked_at"],
                schema=_SCHEMA,
            )

    # ── 2. Sweep-level run records ───────────────────────────────────
    if not inspector.has_table(_RUNS, schema=_SCHEMA):
        op.create_table(
            _RUNS,
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
            schema=_SCHEMA,
        )
        op.create_index(
            "ix_recon_runs_started", _RUNS, ["started_at"],
            schema=_SCHEMA,
        )
    elif "ix_recon_runs_started" not in _index_names(inspector, _RUNS, schema=_SCHEMA):
        op.create_index(
            "ix_recon_runs_started", _RUNS, ["started_at"],
            schema=_SCHEMA,
        )

    # ── 3. Audit: why it fired, and the numbers behind it ────────────
    if inspector.has_table(_EVENTS):
        present = _columns(inspector, _EVENTS)
        if "reason" not in present:
            op.add_column(_EVENTS, sa.Column("reason", sa.Text(), nullable=True))
        if "evidence" not in present:
            op.add_column(_EVENTS, sa.Column("evidence", sa.Text(), nullable=True))

    # Drop-and-recreate under the SAME name. That is what makes this safe in
    # all three schema-CI paths: fresh-install never runs the chain (create_all
    # already produces the new expression); forward-migrate replaces the old
    # one (the real gate); chain-replay drops the create_all-produced
    # constraint by name and recreates it identically.
    op.drop_constraint(
        "ck_refresh_events_origin", _EVENTS, type_="check",
    )
    op.create_check_constraint(
        "ck_refresh_events_origin", _EVENTS, _ORIGIN_AFTER,
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    op.drop_constraint(
        "ck_refresh_events_origin", _EVENTS, type_="check",
    )
    # Any 'reconcile-sweep' rows would violate the restored constraint, so
    # relabel them onto the nearest pre-existing origin first.
    op.execute(
        "UPDATE refresh_events SET origin = 'reconcile' "
        "WHERE origin = 'reconcile-sweep'"
    )
    op.create_check_constraint(
        "ck_refresh_events_origin", _EVENTS, _ORIGIN_BEFORE,
    )

    if inspector.has_table(_EVENTS):
        present = _columns(inspector, _EVENTS)
        if "evidence" in present:
            op.drop_column(_EVENTS, "evidence")
        if "reason" in present:
            op.drop_column(_EVENTS, "reason")

    if inspector.has_table(_RUNS, schema=_SCHEMA):
        if "ix_recon_runs_started" in _index_names(inspector, _RUNS, schema=_SCHEMA):
            op.drop_index("ix_recon_runs_started", _RUNS, schema=_SCHEMA)
        op.drop_table(_RUNS, schema=_SCHEMA)

    if inspector.has_table(_STATE, schema=_SCHEMA):
        if "ix_ds_state_recon_due" in _index_names(inspector, _STATE, schema=_SCHEMA):
            op.drop_index(
                "ix_ds_state_recon_due", _STATE, schema=_SCHEMA,
            )
        present = _columns(inspector, _STATE, schema=_SCHEMA)
        for name, _col_type, _default in reversed(_STATE_COLUMNS):
            if name in present:
                op.drop_column(_STATE, name, schema=_SCHEMA)
