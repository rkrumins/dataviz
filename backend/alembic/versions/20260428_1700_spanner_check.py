"""Extend the ``providers.provider_type`` CHECK constraint to allow ``spanner_graph``.

Revision ID: 20260428_1700_spanner_check
Revises: 20260426_1600_job_event_log
Create Date: 2026-04-28 17:00

The baseline migration's CHECK constraint whitelists provider type values:

    provider_type IN ('falkordb', 'neo4j', 'datahub', 'mock')

The Google Spanner Graph provider adds a fifth value, ``'spanner_graph'``,
which the existing constraint rejects at INSERT time — a Pydantic-validated
``ProviderType`` enum value still hits the DB and produces a 500 from
asyncpg's ``CheckViolationError``. The fix is to drop and recreate the
constraint with the expanded allowlist.

Idempotent: inspects the live constraint text before mutating. Fresh
deployments (which run ``Base.metadata.create_all`` from the updated ORM
declaration in ``backend/app/db/models.py``) already have the new shape and
this migration becomes a no-op for them.

NOTE: revision id kept ≤ 32 chars to fit ``alembic_version.version_num``
(``VARCHAR(32)``). A longer name caused ``StringDataRightTruncation`` and
rolled the upgrade transaction back on first attempt.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260428_1700_spanner_check"
down_revision: Union[str, None] = "20260426_1600_job_event_log"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "providers"
_CONSTRAINT = "ck_providers_provider_type"
_OLD_LIST = "'falkordb', 'neo4j', 'datahub', 'mock'"
_NEW_LIST = "'falkordb', 'neo4j', 'datahub', 'mock', 'spanner_graph'"


def _current_constraint_definition(bind) -> str | None:
    """Return the SQL definition of the CHECK constraint, or None if absent.

    Uses ``information_schema.check_constraints`` so this works on any
    Postgres version we support without leaning on pg_constraint internals.
    """
    row = bind.execute(
        sa.text(
            "SELECT check_clause "
            "FROM information_schema.check_constraints "
            "WHERE constraint_name = :name"
        ),
        {"name": _CONSTRAINT},
    ).fetchone()
    return row[0] if row else None


def upgrade() -> None:
    bind = op.get_bind()
    current = _current_constraint_definition(bind)
    if current is None:
        # Constraint missing entirely — create it. Defensive; the baseline
        # migration always installs it but a hand-edited dev DB might not.
        op.create_check_constraint(
            _CONSTRAINT,
            _TABLE,
            f"provider_type IN ({_NEW_LIST})",
        )
        return
    if "spanner_graph" in current:
        # Already correct (fresh deploy from the updated baseline, or this
        # migration was applied previously). No-op.
        return

    op.drop_constraint(_CONSTRAINT, _TABLE, type_="check")
    op.create_check_constraint(
        _CONSTRAINT,
        _TABLE,
        f"provider_type IN ({_NEW_LIST})",
    )


def downgrade() -> None:
    bind = op.get_bind()
    current = _current_constraint_definition(bind)
    if current is None:
        return
    if "spanner_graph" not in current:
        # Already on the original 4-value list — nothing to revert.
        return

    op.drop_constraint(_CONSTRAINT, _TABLE, type_="check")
    op.create_check_constraint(
        _CONSTRAINT,
        _TABLE,
        f"provider_type IN ({_OLD_LIST})",
    )
