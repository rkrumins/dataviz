"""Allow graphs.kind = 'blank' (self-service blank-canvas lineage models).

A blank graph is genesis-only (no provider seed), 1:1 with an auto-provisioned
manual data source, and contractually ontology-governed (strict enforcement,
rules fail closed). The ``ck_graphs_kind`` CHECK is swapped in place; the ORM
constraint (``versioning/models.py``) carries the same set for fresh DBs.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20260703_1200_graph_kind_blank"
down_revision: Union[str, None] = "20260703_0010_view_updated_by"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    graphs = f'"{gv_config.graphver_schema()}"."graphs"'
    bind.execute(sa.text(f"ALTER TABLE {graphs} DROP CONSTRAINT IF EXISTS ck_graphs_kind"))
    bind.execute(sa.text(
        f"ALTER TABLE {graphs} ADD CONSTRAINT ck_graphs_kind "
        "CHECK (kind IN ('manual','authoritative','hybrid','blank'))"))


def downgrade() -> None:
    bind = op.get_bind()
    graphs = f'"{gv_config.graphver_schema()}"."graphs"'
    bind.execute(sa.text(f"ALTER TABLE {graphs} DROP CONSTRAINT IF EXISTS ck_graphs_kind"))
    bind.execute(sa.text(
        f"ALTER TABLE {graphs} ADD CONSTRAINT ck_graphs_kind "
        "CHECK (kind IN ('manual','authoritative','hybrid'))"))
