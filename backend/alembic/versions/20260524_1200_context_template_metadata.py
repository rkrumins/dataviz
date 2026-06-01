"""Add template metadata + usage columns to ``context_models``.

Revision ID: 20260524_1200_context_template_metadata
Revises: 20260512_1100_jobs_current_phase
Create Date: 2026-05-24 12:00

Backs the "Manage ContextViewCanvas Templates" UI. Adds:

  * ``icon``                — Lucide icon name (e.g. ``"Workflow"``)
  * ``accent_color``        — hex string (e.g. ``"#6366f1"``)
  * ``maintainer``          — free-text user or team
  * ``about_markdown``      — longer-form description, rendered in detail drawer
  * ``instantiation_count`` — incremented by ``instantiate_template``
  * ``last_used_at``        — ISO timestamp set on each instantiation
  * ``deleted_at``          — soft-delete tombstone (matches ``views`` pattern)
  * ``instantiated_from_id``— self-FK on instances pointing at their source template;
                              enables usage-by-workspace stats

All columns nullable; ``instantiation_count`` has a server-side default of 0
so existing rows backfill cleanly without a separate UPDATE pass.

Idempotent inspector guards mirror the pattern in
``20260512_1100_jobs_current_phase`` so the migration is safe against the
``Base.metadata.create_all`` baseline path on fresh deploys.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260524_1200_context_template_metadata"
down_revision: Union[str, None] = "20260512_1100_jobs_current_phase"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "context_models"

_NEW_COLUMNS: tuple[tuple[str, sa.Column], ...] = (
    ("icon",                  sa.Column("icon", sa.Text(), nullable=True)),
    ("accent_color",          sa.Column("accent_color", sa.Text(), nullable=True)),
    ("maintainer",            sa.Column("maintainer", sa.Text(), nullable=True)),
    ("about_markdown",        sa.Column("about_markdown", sa.Text(), nullable=True)),
    ("instantiation_count",   sa.Column("instantiation_count", sa.Integer(), nullable=False, server_default="0")),
    ("last_used_at",          sa.Column("last_used_at", sa.Text(), nullable=True)),
    ("deleted_at",            sa.Column("deleted_at", sa.Text(), nullable=True)),
    ("instantiated_from_id",  sa.Column("instantiated_from_id", sa.Text(), nullable=True)),
)

_NEW_INDEXES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("idx_cm_template_workspace", ("is_template", "workspace_id")),
    ("idx_cm_deleted_at",         ("deleted_at",)),
    ("idx_cm_instantiated_from",  ("instantiated_from_id",)),
)


def _existing_columns(inspector: sa.engine.reflection.Inspector) -> set[str]:
    return {c["name"] for c in inspector.get_columns(_TABLE)}


def _existing_indexes(inspector: sa.engine.reflection.Inspector) -> set[str]:
    return {i["name"] for i in inspector.get_indexes(_TABLE)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = _existing_columns(inspector)
    for name, column in _NEW_COLUMNS:
        if name in existing:
            continue
        op.add_column(_TABLE, column)

    existing_idx = _existing_indexes(inspector)
    for name, cols in _NEW_INDEXES:
        if name in existing_idx:
            continue
        op.create_index(name, _TABLE, list(cols))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    existing_idx = _existing_indexes(inspector)
    for name, _ in _NEW_INDEXES:
        if name in existing_idx:
            op.drop_index(name, table_name=_TABLE)

    existing = _existing_columns(inspector)
    for name, _ in _NEW_COLUMNS:
        if name in existing:
            op.drop_column(_TABLE, name)
