"""Import settings: a data source's own, and the ones each import job runs under.

On ``workspace_data_sources``, five nullable columns a workspace admin sets on the data source's
Versioning tab (``backend.app.services.import_settings``):

* ``import_identifier`` — what an import's rows find their entities by when the import names no
  ``identifier``: ``entity_id``, ``urn`` or ``prop.<name>``;
* ``import_replace_min_live``, ``import_replace_delete_fraction``,
  ``import_replace_create_fraction`` — the replace guard's limits;
* ``import_replace_min_match_fraction`` — a replace's fail-fast limit.

NULL is "not set": the platform's holds (``GRAPHVER_IMPORT_IDENTIFIER``, ``IMPORT_REPLACE_*``).

On ``graphver.jobs``, ``import_settings`` (JSONB): what an import runs under, as resolved when it
was made, so a resumed one keeps it. NULL, every job made before, runs under the platform's.

Catalog-only changes, with no rewrite: the ALTERs wait at most five seconds for a lock and are safe
to re-run. ``models._ensure_schema_upgrades`` mirrors the jobs column at start-up for a separate
``GRAPHVER_DB_URL`` alembic never reaches. The downgrade drops them: imports then run under the
platform's settings.

Revision ID: 20261112_1600_import_settings
Revises: 20261112_1500_gv_entity_keys
Create Date: 2026-11-12 16:00
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_jobs_import_settings_column

revision: str = "20261112_1600_import_settings"
down_revision: Union[str, None] = "20261112_1500_gv_entity_keys"
branch_labels = None
depends_on = None

_COLUMNS = (
    ("import_identifier", sa.Text()),
    ("import_replace_min_live", sa.Integer()),
    ("import_replace_delete_fraction", sa.Float()),
    ("import_replace_create_fraction", sa.Float()),
    ("import_replace_min_match_fraction", sa.Float()),
)


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: giving up (to be run again) beats queueing every
    request that reads a data source behind a long transaction."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    for name, kind in _COLUMNS:
        op.add_column("workspace_data_sources", sa.Column(name, kind, nullable=True), if_not_exists=True)
    bind = op.get_bind()
    if sa.inspect(bind).has_schema(gv_config.graphver_schema()):
        ensure_jobs_import_settings_column(bind)


def downgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()
    if sa.inspect(bind).has_schema(gv_config.graphver_schema()):
        bind.execute(sa.text(f'ALTER TABLE IF EXISTS "{gv_config.graphver_schema()}"."jobs" '
                             "DROP COLUMN IF EXISTS import_settings"))
    for name, _kind in reversed(_COLUMNS):
        op.execute(f"ALTER TABLE workspace_data_sources DROP COLUMN IF EXISTS {name}")
