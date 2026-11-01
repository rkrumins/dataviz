"""``projection_state``: a graph's residency in FalkorDB.

Graphs live in FalkorDB by a class a system admin sets: ``always`` (never evicted), ``standard``
(evicted when unread for the Standard idle time, or earlier under a master's memory pressure, and
loaded again on the next read) or ``coldline`` (loaded only when a request needs FalkorDB, evicted
after the Coldline idle time). Postgres stays the only source of truth: an evicted graph reads from
it. This revision adds what the capacity loop decides from and records:

* ``residency`` — the class, ``'standard'`` for every graph (check ``ck_ps_residency``);
* ``last_read_at`` — when a person last read the graph;
* ``evicted_reason`` — ``idle_standard``, ``idle_coldline``, ``pressure``, ``lost``,
  ``load_stalled`` or ``admin`` (check ``ck_ps_evicted_reason``);
* ``size_bytes`` and ``size_measured_at`` — the key's measured size;
* ``rehydrating_since`` — when its load in flight started;

and widens ``ck_proj_status`` with ``rehydrating`` (a load in flight) and ``waiting_capacity`` (a
load its master has no room for yet). Columns with a constant default or none: catalog-only, no
rewrite. Every projection pass writes ``projection_state``, so the wait for its lock is bounded
(``_bound_lock_wait``); the upgrade is safe to re-run.

The downgrade turns a graph waiting for its load or being loaded into an evicted one at watermark
0, bumping its epoch so a load in flight cannot publish: the code before this revision reseeds every
evicted graph, as it always did. Then the columns and checks go, and ``ck_proj_status`` is narrowed
back.

Mirrored in ``models._ensure_schema_upgrades`` for a separate ``GRAPHVER_DB_URL`` alembic never
reaches.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_ps_residency

revision: str = "20261030_1300_gv_ps_residency"
down_revision: Union[str, None] = "20261030_1200_ds_fork_of"
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
    ensure_ps_residency(op.get_bind())


def downgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    if not sa.inspect(bind).has_table("projection_state", schema=schema):
        return
    ps = f'"{schema}"."projection_state"'
    bind.execute(sa.text(
        f"UPDATE {ps} SET status = 'evicted', projected_commit_seq = 0, epoch = epoch + 1 "
        "WHERE status IN ('rehydrating', 'waiting_capacity')"))
    bind.execute(sa.text(f"ALTER TABLE {ps} DROP CONSTRAINT IF EXISTS ck_proj_status"))
    bind.execute(sa.text(
        f"ALTER TABLE {ps} ADD CONSTRAINT ck_proj_status "
        "CHECK (status IN ('idle','projecting','rebuilding','evicted','reseeding'))"))
    for check in ("ck_ps_residency", "ck_ps_evicted_reason"):
        bind.execute(sa.text(f"ALTER TABLE {ps} DROP CONSTRAINT IF EXISTS {check}"))
    for column in ("residency", "last_read_at", "evicted_reason", "size_bytes", "size_measured_at",
                   "rehydrating_since"):
        bind.execute(sa.text(f"ALTER TABLE {ps} DROP COLUMN IF EXISTS {column}"))
