"""``projection_state.physical_types`` and ``external_drift``: a customer graph's own spelling of its
types, and what was written to it outside history.

Version control enabled on a graph that already exists projects into that graph's own key
(``owns_falkor_graph`` false). ``physical_types`` is the graph's own spelling of each type where it
differs from the declared one (``{"nodes": {declared: physical}, "edges": {...}}``), recorded when
the enable finishes, so the projector writes and matches ``:table`` rather than adding ``:Table``.
``external_drift`` (``{at, nodes, edges, via}``) records what a pass found in that key that history
does not hold, which it keeps rather than deletes. Two nullable ``ADD COLUMN IF NOT EXISTS``:
catalog-only, no rewrite; the wait for the table's lock is bounded (``_bound_lock_wait``), and the
upgrade is safe to re-run. Graphs enabled before this revision keep ``physical_types`` NULL and are
projected with the declared spelling, as before.

The downgrade drops both columns. It logs how many graphs had their own spelling recorded (the
projector writes the declared spelling into them again) and how many were flagged with outside
changes.

Mirrored in ``models._ensure_schema_upgrades`` for a separate ``GRAPHVER_DB_URL`` alembic never
reaches.
"""
from __future__ import annotations

import logging
from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_ps_customer_key_columns

revision: str = "20261028_1000_gv_ps_unowned"
down_revision: Union[str, None] = "20261018_1200_gv_lifecycle"
branch_labels = None
depends_on = None

logger = logging.getLogger("alembic.runtime.migration")


def _bound_lock_wait() -> None:
    """Wait at most five seconds for the table's lock: every projection pass writes
    ``projection_state``, so a long holder makes the upgrade give up, to be run again, rather
    than queue those writes behind it."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    ensure_ps_customer_key_columns(op.get_bind())


def downgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    inspector = sa.inspect(bind)
    if not inspector.has_table("projection_state", schema=schema):
        return
    ps = f'"{schema}"."projection_state"'
    present = {c["name"] for c in inspector.get_columns("projection_state", schema=schema)}
    if "physical_types" in present:
        spelled = bind.execute(sa.text(
            f"SELECT count(*) FROM {ps} WHERE physical_types IS NOT NULL")).scalar()
        if spelled:
            logger.warning("%d graph(s) had their own spelling of types recorded; the declared "
                           "spelling is written into them again", spelled)
    if "external_drift" in present:
        drifted = bind.execute(sa.text(
            f"SELECT count(*) FROM {ps} WHERE external_drift IS NOT NULL")).scalar()
        if drifted:
            logger.warning("%d graph(s) were flagged with changes made outside history; the flag "
                           "is dropped, the changes stay in their graphs", drifted)
    for column in ("physical_types", "external_drift"):
        bind.execute(sa.text(f"ALTER TABLE {ps} DROP COLUMN IF EXISTS {column}"))
