"""A semantic layer's owner: the workspace that owns it, and whether it is shared there.

On ``ontologies``, two nullable columns:

* ``owner_workspace_id`` — the workspace that owns the layer (a Playground maker's own layer,
  or one that moved into a workspace with its graph), a foreign key to ``workspaces`` that is
  cleared when the workspace goes, and indexed;
* ``owner_visibility`` — an owned layer's reach: ``private`` to its maker, or ``workspace``.

NULL is an org layer, as every layer was. Guarded DDL (a brand-new environment's
``0001_baseline`` create_all()s the current ORM); the foreign key is added on Postgres only,
where it is checked for first. Downgrade drops the index, the key and the columns.

Revision ID: 20261129_1000_ontology_owner
Revises: 20261128_1000_merge_reusable
Create Date: 2026-11-29 10:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261129_1000_ontology_owner"
down_revision: Union[str, None] = "20261128_1000_merge_reusable"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "ontologies"
_FK = "fk_ontologies_owner_workspace"
_INDEX = "idx_ontologies_owner_workspace"


def _owner_keys(bind) -> list[str]:
    """The foreign keys on ``owner_workspace_id``, whatever they are named (``create_all`` names
    its own)."""
    return [fk["name"] for fk in sa.inspect(bind).get_foreign_keys(_TABLE)
            if fk.get("constrained_columns") == ["owner_workspace_id"]]


def upgrade() -> None:
    bind = op.get_bind()
    have = {c["name"] for c in sa.inspect(bind).get_columns(_TABLE)}
    for name in ("owner_workspace_id", "owner_visibility"):
        if name not in have:
            op.add_column(_TABLE, sa.Column(name, sa.Text(), nullable=True))
    if bind.dialect.name == "postgresql" and not _owner_keys(bind):
        op.create_foreign_key(_FK, _TABLE, "workspaces", ["owner_workspace_id"], ["id"],
                              ondelete="SET NULL")
    op.create_index(_INDEX, _TABLE, ["owner_workspace_id"], if_not_exists=True)


def downgrade() -> None:
    op.drop_index(_INDEX, table_name=_TABLE, if_exists=True)
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        for name in _owner_keys(bind):
            op.drop_constraint(name, _TABLE, type_="foreignkey")
    op.drop_column(_TABLE, "owner_visibility")
    op.drop_column(_TABLE, "owner_workspace_id")
