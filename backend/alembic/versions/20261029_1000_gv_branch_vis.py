"""``branches.visibility``: a draft is public or private.

A public draft is seen by everyone who reads its data source, and everyone who may change the data
source may write to it. A private one is its owner's, its members' and the people on its review
only. One ``NOT NULL DEFAULT 'private'`` column (catalog-only, no rewrite) with its check, so every
existing draft reads private and nothing becomes visible without its owner choosing; ``main`` reads
public. Member rows left on a draft that isn't shared granted nothing and would grant access from
now on, so they are deleted; a draft marked shared with no member left is unmarked, so
``is_shared`` means "has members". Two indexes: drafts by graph, visibility and status for the
listing, and members by subject for a person's drafts. The wait for the table's lock is bounded
(``_bound_lock_wait``), and the upgrade is safe to re-run.

The downgrade drops both indexes, the check and the column. It logs how many drafts were public:
under the older code they are their owner's alone again. The deleted member rows are not brought
back: they granted nothing.

Mirrored in ``models._ensure_schema_upgrades`` for a separate ``GRAPHVER_DB_URL`` alembic never
reaches.
"""
from __future__ import annotations

import logging
from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_branch_visibility

revision: str = "20261029_1000_gv_branch_vis"
down_revision: Union[str, None] = "20261028_1000_gv_ps_unowned"
branch_labels = None
depends_on = None

logger = logging.getLogger("alembic.runtime.migration")


def _bound_lock_wait() -> None:
    """Wait at most five seconds for the table's lock: every draft request reads ``branches``, so
    a long holder makes the upgrade give up, to be run again, rather than queue those reads behind
    it."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    ensure_branch_visibility(op.get_bind())


def downgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    inspector = sa.inspect(bind)
    if not inspector.has_table("branches", schema=schema):
        return
    branches = f'"{schema}"."branches"'
    if "visibility" in {c["name"] for c in inspector.get_columns("branches", schema=schema)}:
        public = bind.execute(sa.text(
            f"SELECT count(*) FROM {branches} WHERE visibility = 'public' AND kind <> 'main'"
        )).scalar()
        if public:
            logger.warning("%d draft(s) were public; they are their owner's alone again", public)
    bind.execute(sa.text(f'DROP INDEX IF EXISTS "{schema}"."ix_bm_subject"'))
    bind.execute(sa.text(f'DROP INDEX IF EXISTS "{schema}"."ix_branches_graph_vis"'))
    bind.execute(sa.text(f"ALTER TABLE {branches} DROP CONSTRAINT IF EXISTS ck_branches_visibility"))
    bind.execute(sa.text(f"ALTER TABLE {branches} DROP COLUMN IF EXISTS visibility"))
