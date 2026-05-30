"""Add ``display_rules_config`` column to ``context_models``.

Revision ID: 20260530_1200_context_models_display_rules
Revises: 20260512_1100_jobs_current_phase
Create Date: 2026-05-30 12:00

Backs the Property Manager's display-rule tag overlay. A display rule
pairs a reused Advanced-Search predicate with a tag (label + color);
matched canvas nodes are decorated with that tag chip. Rules are part of
the view blueprint, so they persist via the Save Blueprint flow
(``context-models`` PUT/POST).

The column stores a JSON array of ``DisplayRuleConfig`` exactly as the
frontend sends it under ``displayRulesConfig``. Nullable + no default:
legacy context models leave it NULL, which the frontend hydrates as an
empty rule list, so no backfill is required.

Without this migration the viz-service errors at startup with
``UndefinedColumnError: column context_models.display_rules_config does
not exist`` because ``ContextModelORM`` declares the column and
SQLAlchemy auto-includes it in every generated SELECT.

Idempotent: the baseline migration uses ``Base.metadata.create_all`` so
on fresh deploys the column may already exist. The inspector check
before ``add_column`` makes the upgrade safe in that case.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260530_1200_context_models_display_rules"
down_revision: Union[str, None] = "20260512_1100_jobs_current_phase"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "context_models"
_COLUMN = "display_rules_config"


def _has_column(inspector: sa.engine.reflection.Inspector) -> bool:
    columns = inspector.get_columns(_TABLE)
    return any(c["name"] == _COLUMN for c in columns)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if _has_column(inspector):
        return
    op.add_column(
        _TABLE,
        sa.Column(_COLUMN, sa.Text(), nullable=True),
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not _has_column(inspector):
        return
    op.drop_column(_TABLE, _COLUMN)
