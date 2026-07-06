"""Live full-reseed progress on projection_state (Data health rebuild bar).

``progress_done``/``progress_total`` are written throttled by the projector
during a FULL reseed and cleared on completion/failure; the watermark endpoint
exposes them so the rebuild UI can show "12,400 of 48,000 items" instead of an
opaque spinner. NULL when no full seed is running. The ORM
(``versioning/models.py``) carries the same columns for fresh DBs.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20260704_1200_projection_prog"
down_revision: Union[str, None] = "20260703_1200_graph_kind_blank"
branch_labels = None
depends_on = None

_COLS = ("progress_done", "progress_total")


def upgrade() -> None:
    bind = op.get_bind()
    tbl = f'"{gv_config.graphver_schema()}"."projection_state"'
    for col in _COLS:
        bind.execute(sa.text(f"ALTER TABLE {tbl} ADD COLUMN IF NOT EXISTS {col} bigint"))


def downgrade() -> None:
    bind = op.get_bind()
    tbl = f'"{gv_config.graphver_schema()}"."projection_state"'
    for col in _COLS:
        bind.execute(sa.text(f"ALTER TABLE {tbl} DROP COLUMN IF EXISTS {col}"))
