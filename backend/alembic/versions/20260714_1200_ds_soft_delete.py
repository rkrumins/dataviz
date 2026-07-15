"""Data-source soft delete: make the trash possible, and stop a tombstone holding the door shut.

``workspace_data_sources.deleted_at`` / ``deleted_by`` already EXIST — they have been on the ORM
for some time and nothing ever read or wrote them; the delete path was a hard ``DELETE``. Wiring
them up is most of what an undo window needs. This migration exists for the part that is not
obvious, and that quietly breaks soft-delete everywhere it is bolted onto a mature table:

    A SOFT-DELETED ROW STILL OCCUPIES EVERY UNIQUE CONSTRAINT IT WAS IN.

Two of them here, and the first is the dangerous one:

  * ``uq_ds_catalog_item`` — UNIQUE(catalog_item_id), and it is GLOBAL. A catalog item may back
    exactly one data source anywhere in the product. Leave it as-is and a tombstone keeps holding
    that slot for the entire 30-day grace period: delete a data source and you cannot re-attach
    its catalog item to ANY workspace until the reaper gets to it. The undo window would silently
    become a lockout window.

  * ``uq_ds_ws_prov_graph`` — UNIQUE(workspace_id, provider_id, graph_name). Same failure, smaller
    blast radius: you could not re-attach the same graph to the same workspace after deleting it.

Both become PARTIAL UNIQUE INDEXES scoped to live rows (``WHERE deleted_at IS NULL``). Uniqueness
is preserved exactly where it means something — among data sources that exist — and the trash
stops being a hostage-taker. NULL semantics are unchanged: a partial unique index permits many
NULLs, precisely as the constraint did.

The ORM's ``__table_args__`` carries the same partial indexes so a fresh ``create_all`` agrees;
this migration is MANDATORY for existing databases because create_all never alters a live table.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260714_1200_ds_soft_delete"
down_revision: Union[str, None] = "20260714_1000_graph_lifecycle"
branch_labels = None
depends_on = None

_T = "workspace_data_sources"


def upgrade() -> None:
    bind = op.get_bind()

    # Defensive: the ORM has carried these for a while, but a DB built before that would not.
    bind.execute(sa.text(f"ALTER TABLE {_T} ADD COLUMN IF NOT EXISTS deleted_at TEXT"))
    bind.execute(sa.text(f"ALTER TABLE {_T} ADD COLUMN IF NOT EXISTS deleted_by TEXT"))

    # ── the point of this migration ──
    bind.execute(sa.text(f"ALTER TABLE {_T} DROP CONSTRAINT IF EXISTS uq_ds_catalog_item"))
    bind.execute(sa.text(
        f"CREATE UNIQUE INDEX IF NOT EXISTS uq_ds_catalog_item_live ON {_T} (catalog_item_id) "
        "WHERE deleted_at IS NULL"))

    bind.execute(sa.text(f"ALTER TABLE {_T} DROP CONSTRAINT IF EXISTS uq_ds_ws_prov_graph"))
    bind.execute(sa.text(
        f"CREATE UNIQUE INDEX IF NOT EXISTS uq_ds_ws_prov_graph_live ON {_T} "
        "(workspace_id, provider_id, graph_name) WHERE deleted_at IS NULL"))

    # Every list-a-workspace's-sources read now filters on this; it is the hot path.
    bind.execute(sa.text(
        f"CREATE INDEX IF NOT EXISTS idx_ds_ws_live ON {_T} (workspace_id) "
        "WHERE deleted_at IS NULL"))


def downgrade() -> None:
    bind = op.get_bind()
    # Restoring the plain constraints is only possible if no tombstones would collide with a live
    # row. Purge them first rather than fail halfway through a transactional DDL block.
    bind.execute(sa.text(f"DELETE FROM {_T} WHERE deleted_at IS NOT NULL"))

    bind.execute(sa.text("DROP INDEX IF EXISTS idx_ds_ws_live"))
    bind.execute(sa.text("DROP INDEX IF EXISTS uq_ds_ws_prov_graph_live"))
    bind.execute(sa.text("DROP INDEX IF EXISTS uq_ds_catalog_item_live"))
    bind.execute(sa.text(
        f"ALTER TABLE {_T} ADD CONSTRAINT uq_ds_ws_prov_graph "
        "UNIQUE (workspace_id, provider_id, graph_name)"))
    bind.execute(sa.text(
        f"ALTER TABLE {_T} ADD CONSTRAINT uq_ds_catalog_item UNIQUE (catalog_item_id)"))
