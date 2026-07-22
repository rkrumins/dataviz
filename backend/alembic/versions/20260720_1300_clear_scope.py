"""Widen refresh_events.scope to allow 'clear' (H1, spec §9a).

New force-clear refresh scope: the read-caches steps plus an explicit
stale-marker clear, un-sticking a source stuck "recomputing" after a
failed rebuild (e.g. provider OOM). ``ck_refresh_events_scope`` needs
``'clear'`` added to its domain.

WIDEN-ONLY, mirroring ``20260713_1400_jobs_bootstrap_type``: rebuild the
CHECK over the required set UNION whatever scope values already exist in
the table, so a row this migration doesn't know about can never wedge the
``ADD CONSTRAINT``. ``refresh_events`` is a fresh table (this branch), so
in practice the union is a no-op beyond the new value — but the pattern
costs nothing and avoids a future footgun if a row with an unexpected
scope ever lands here.

The ORM (``backend.app.db.models.RefreshEventORM``) carries the widened
CHECK for fresh DBs, where ``create_all`` — which never ALTERs — is the
only DDL that runs.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260720_1300_clear_scope"
down_revision: Union[str, None] = "20260720_1200_merge_heads"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "refresh_events"
_REQUIRED: Sequence[str] = (
    "auto", "read-caches", "rollups", "full", "batch-item", "clear",
)
_REQUIRED_BEFORE: Sequence[str] = (
    "auto", "read-caches", "rollups", "full", "batch-item",
)


def _widen_scope_check(bind, required: Sequence[str]) -> None:
    """Rebuild ck_refresh_events_scope over `required` ∪ whatever scope
    values are already present in the table."""
    inspector = sa.inspect(bind)
    if not inspector.has_table(_TABLE):
        return  # fresh DB: create_all lays down the widened CHECK directly
    present = {
        row[0] for row in bind.execute(sa.text(f"SELECT DISTINCT scope FROM {_TABLE}"))
        if row[0]
    }
    allowed = sorted(set(required) | present)
    values = ", ".join("'" + v.replace("'", "''") + "'" for v in allowed)
    bind.execute(sa.text(
        f"ALTER TABLE {_TABLE} DROP CONSTRAINT IF EXISTS ck_refresh_events_scope"
    ))
    bind.execute(sa.text(
        f"ALTER TABLE {_TABLE} ADD CONSTRAINT ck_refresh_events_scope "
        f"CHECK (scope IN ({values}))"
    ))


def upgrade() -> None:
    _widen_scope_check(op.get_bind(), _REQUIRED)


def downgrade() -> None:
    # Widen-only in reverse too: keep every scope value that exists, drop
    # nothing — see 20260713_1400_jobs_bootstrap_type for the rationale.
    _widen_scope_check(op.get_bind(), _REQUIRED_BEFORE)
