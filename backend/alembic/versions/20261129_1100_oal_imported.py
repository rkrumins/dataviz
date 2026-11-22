"""A semantic layer's audit log accepts ``imported``.

``ontology_audit_log.ck_oal_action_enum`` allowed created, updated, published, deleted, restored
and cloned — but importing a layer file that changes something writes ``imported``
(``ontology_definition_repo.import_ontology``), so every such import failed on the check. The
constraint comes from ``create_all`` (no migration made it); this swaps it for one that also
allows ``imported``.

Postgres only, and guarded: the constraint is dropped if it is there and added back with the
new list, so a database already at the current ORM (a fresh ``0001_baseline``) ends the same.
SQLite databases are built from the ORM. Downgrade records any ``imported`` entries as
``updated`` first, then restores the old list.

Revision ID: 20261129_1100_oal_imported
Revises: 20261129_1000_ontology_owner
Create Date: 2026-11-29 11:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "20261129_1100_oal_imported"
down_revision: Union[str, None] = "20261129_1000_ontology_owner"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "ontology_audit_log"
_CHECK = "ck_oal_action_enum"
_OLD = "'created', 'updated', 'published', 'deleted', 'restored', 'cloned'"
_NEW = _OLD + ", 'imported'"


def _swap(actions: str) -> None:
    op.execute(f"ALTER TABLE {_TABLE} DROP CONSTRAINT IF EXISTS {_CHECK}")
    op.execute(f"ALTER TABLE {_TABLE} ADD CONSTRAINT {_CHECK} CHECK (action IN ({actions}))")


def upgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        _swap(_NEW)


def downgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.execute(f"UPDATE {_TABLE} SET action = 'updated' WHERE action = 'imported'")
        _swap(_OLD)
