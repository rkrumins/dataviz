"""Add workspace_data_sources.source_mode + write_back_enabled (versioning source model).

`source_mode` (managed|federated; NULL = derive from provider capability) and
`write_back_enabled` (federated opt-in to push our overlay edits back to the external
system) drive write routing in the layered base/overlay versioning model.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260603_1400_ds_source_mode"
down_revision: Union[str, None] = "20260603_1300_mr_draft_source"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("ALTER TABLE workspace_data_sources ADD COLUMN IF NOT EXISTS source_mode text"))
    bind.execute(sa.text(
        "ALTER TABLE workspace_data_sources "
        "ADD COLUMN IF NOT EXISTS write_back_enabled boolean NOT NULL DEFAULT false"
    ))
    bind.execute(sa.text("ALTER TABLE workspace_data_sources DROP CONSTRAINT IF EXISTS ck_ds_source_mode"))
    bind.execute(sa.text(
        "ALTER TABLE workspace_data_sources ADD CONSTRAINT ck_ds_source_mode "
        "CHECK (source_mode IS NULL OR source_mode IN ('managed', 'federated'))"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("ALTER TABLE workspace_data_sources DROP CONSTRAINT IF EXISTS ck_ds_source_mode"))
    bind.execute(sa.text("ALTER TABLE workspace_data_sources DROP COLUMN IF EXISTS write_back_enabled"))
    bind.execute(sa.text("ALTER TABLE workspace_data_sources DROP COLUMN IF EXISTS source_mode"))
