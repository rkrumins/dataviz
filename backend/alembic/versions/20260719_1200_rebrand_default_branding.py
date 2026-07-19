"""Rebrand the default branding singleton — Nexus Lineage → Context Visualization Platform.

Revision ID: 20260719_1200_rebrand_default_branding
Revises: 20260714_1600_feature_changes
Create Date: 2026-07-19 12:00

The ``application_branding`` singleton is the runtime source of truth for the
deployment's white-label identity (the Admin Panel writes it; the app reads it).
The seed migration (``20260608_1200_application_branding``) filled the row *once*
from the env defaults, so a deployment that ran that seed before the product was
renamed still holds the old default identity and would keep displaying it.

This is a one-time data migration that moves the row from the OLD stock default to
the NEW one — but only where a field is still the old default. A deployment that
customised its brand through the Admin Panel matches none of the guards and is left
completely untouched. Idempotent: after it runs, the old values no longer match, so
re-running changes nothing.

Values are hard-coded here on purpose. A data migration is a frozen snapshot of a
transition; it must not import ``get_branding_defaults()``, whose values drift.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260719_1200_rebrand_default_branding"
down_revision: Union[str, None] = "20260714_1600_feature_changes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# The exact stock defaults this migration transitions between.
_OLD_NAME = "Nexus Lineage"
_NEW_NAME = "Context Visualization Platform"
_OLD_SHORT = "NexusLineage"
_NEW_SHORT = "CVP"
_OLD_COPYRIGHT = "© 2026 Nexus Lineage"
_NEW_COPYRIGHT = "© 2026 Context Visualization Platform"


def _has_table(inspector, table: str) -> bool:
    return table in inspector.get_table_names()


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _remap(old_name: str, new_name: str, old_short: str, new_short: str,
           old_copyright: str, new_copyright: str) -> None:
    """Move the singleton from one stock default to another, per column, never
    overwriting a value that was already customised away from ``old_*``."""
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not _has_table(inspector, "application_branding"):
        return

    bind.execute(
        sa.text(
            "UPDATE application_branding SET "
            "  app_name = CASE WHEN app_name = :old_name "
            "                  THEN :new_name ELSE app_name END, "
            "  short_name = CASE WHEN short_name = :old_short "
            "                    THEN :new_short ELSE short_name END, "
            "  copyright_text = CASE WHEN copyright_text = :old_copyright "
            "                        THEN :new_copyright ELSE copyright_text END, "
            "  version = version + 1, "
            "  updated_at = :now, "
            "  updated_by = 'system:rebrand-cvp' "
            "WHERE id = 'singleton' "
            "  AND (app_name = :old_name "
            "       OR short_name = :old_short "
            "       OR copyright_text = :old_copyright)"
        ),
        {
            "old_name": old_name,
            "new_name": new_name,
            "old_short": old_short,
            "new_short": new_short,
            "old_copyright": old_copyright,
            "new_copyright": new_copyright,
            "now": _now_iso(),
        },
    )


def upgrade() -> None:
    _remap(_OLD_NAME, _NEW_NAME, _OLD_SHORT, _NEW_SHORT,
           _OLD_COPYRIGHT, _NEW_COPYRIGHT)


def downgrade() -> None:
    # Reverse the transition under the same non-clobbering guard.
    _remap(_NEW_NAME, _OLD_NAME, _NEW_SHORT, _OLD_SHORT,
           _NEW_COPYRIGHT, _OLD_COPYRIGHT)
