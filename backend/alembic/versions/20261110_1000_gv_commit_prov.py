"""``commits.actor_kind``, ``api_key_id`` and ``correlation_id``: who made a commit, and how.

A commit recorded only its ``actor``. An auditor could not tell a person's change from a service
account's, nor which API key or which request made it, and nothing else recorded it either: no
versioning write reached the activity ledger. Three nullable columns, added to the partitioned
parent (and so to every partition) without a default — a catalog change, with no rewrite. Nothing
is backfilled: a commit from before reads its kind from its actor
(``provenance.actor_kind_sql``), and its key and request were never recorded.

``jobs.provenance`` keeps the request that queued a job (``{actor, apiKeyId, correlationId}``), so
the commits an import or a publish job writes on a worker name the key that started it.

The wait for the table's lock is bounded (``_bound_lock_wait``), and the upgrade is safe to re-run.
The downgrade drops the columns.

Mirrored in ``models._ensure_schema_upgrades`` for a separate ``GRAPHVER_DB_URL`` alembic never
reaches.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import (
    COMMIT_PROVENANCE_COLUMNS,
    ensure_commit_provenance_columns,
)

revision: str = "20261110_1000_gv_commit_prov"
down_revision: Union[str, None] = "20261109_1200_publish_words"
branch_labels = None
depends_on = None


def _bound_lock_wait() -> None:
    """Wait at most five seconds for the table's lock: every save writes ``commits``, so a long
    holder makes the upgrade give up, to be run again, rather than queue those writes behind it."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    ensure_commit_provenance_columns(op.get_bind())


def downgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    if not sa.inspect(bind).has_table("commits", schema=schema):
        return
    bind.execute(sa.text(f'ALTER TABLE "{schema}"."commits" '
                         + ", ".join(f"DROP COLUMN IF EXISTS {c}" for c in COMMIT_PROVENANCE_COLUMNS)))
    if sa.inspect(bind).has_table("jobs", schema=schema):
        bind.execute(sa.text(f'ALTER TABLE "{schema}"."jobs" DROP COLUMN IF EXISTS provenance'))
