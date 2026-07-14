"""Don't take semantic-layer editing away from the people who have it today

Revision ID: 20260714_1400_layer_edit_dflt
Revises: 20260714_1300_feature_impact
Create Date: 2026-07-14

`semanticLayerNonAdminEditing` was seeded `false` and then enforced NOWHERE — so for its whole
life the stored value has been a default nobody could feel, not a decision anybody made. Every
existing database therefore holds `false` by accident.

This release wires the flag to a real gate. Applying it against that accidental `false` would
have silently revoked semantic-layer editing from `workspace_admin` and `workspace_data_engineer`
— roles that can edit layers today, one of which exists to do precisely that — the moment the
deploy landed, with no admin having asked for it and no obvious way to work out why.

So the stored value is corrected once, here, to match the behaviour people already have. The
flag is real from now on: an admin who wants admins-only turns it off deliberately, and that
choice is then honoured (and never re-flipped — the seeder does not touch stored settings).

Only `false` is rewritten, and only for this one key. Every other setting is left exactly as the
admin left it.
"""
import json

import sqlalchemy as sa
from alembic import op

revision = "20260714_1400_layer_edit_dflt"
down_revision = "20260714_1300_feature_impact"
branch_labels = None
depends_on = None

_KEY = "semanticLayerNonAdminEditing"


def _rewrite(value: bool) -> None:
    """Set _KEY to `value` in the single feature_flags config row, leaving everything else alone.

    Done in Python rather than SQL/JSON functions because `config` is a TEXT column holding JSON,
    and this has to work on both PostgreSQL and SQLite.
    """
    bind = op.get_bind()
    row = bind.execute(
        sa.text("SELECT id, config FROM feature_flags ORDER BY id LIMIT 1")
    ).fetchone()
    if row is None:
        return  # fresh database — the seeder writes the correct default on first startup

    try:
        config = json.loads(row.config) if row.config else {}
    except (TypeError, ValueError):
        return  # unreadable config: leave it for the seeder rather than corrupt it further
    if not isinstance(config, dict):
        return

    if bool(config.get(_KEY)) is value:
        return

    config[_KEY] = value
    bind.execute(
        sa.text("UPDATE feature_flags SET config = :config WHERE id = :id"),
        {"config": json.dumps(config), "id": row.id},
    )


def upgrade() -> None:
    _rewrite(True)


def downgrade() -> None:
    _rewrite(False)
