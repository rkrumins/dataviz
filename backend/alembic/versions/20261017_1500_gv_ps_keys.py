"""``projection_state``: one versioned graph per FalkorDB graph (``uq_ps_key``).

Two versioned graphs pinned to one FalkorDB graph (provider, name) each reconcile the other's
entities away. ``uq_ps_key`` is a partial unique index on ``(coalesce(falkor_provider,
'default'), falkor_graph_name)`` where a name is set; ``create_graph`` and the repin claim the key
first, and the index settles two claims that race.

Before the build, a tombstoned graph that does not own a key another graph also pins lets go of it
(its pin is cleared and logged; the downgrade does not restore it). Pins still shared after that
belong to live or owned graphs and abort the upgrade, naming them: they must be resolved by hand.
The table has one row per graph, so the plain build holds its lock for milliseconds; the wait for
it is bounded (``_bound_lock_wait``).

Mirrored in ``models._ensure_schema_upgrades`` (never strict there: a worker starts without the
index rather than not at all) for a separate ``GRAPHVER_DB_URL`` alembic never reaches.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_ps_key_index

revision: str = "20261017_1500_gv_ps_keys"
down_revision: Union[str, None] = "20261017_1000_datasource_publish"
branch_labels = None
depends_on = None


def _bound_lock_wait() -> None:
    """Wait at most five seconds for the table's lock: every projection pass writes
    ``projection_state``, so a long holder makes the upgrade give up, to be run again, rather
    than queue those writes behind it."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    ensure_ps_key_index(op.get_bind(), strict=True)


def downgrade() -> None:
    _bound_lock_wait()
    op.get_bind().execute(sa.text(
        f'DROP INDEX IF EXISTS "{gv_config.graphver_schema()}".uq_ps_key'))
