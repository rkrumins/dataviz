"""Import/export artifacts in the database, where every API pod can read them.

Revision ID: 20260926_1000_object_store
Revises: 20260925_1000_view_draft_stage
Create Date: 2026-09-26 10:00

Production runs several API pods with no shared volume, and the object store wrote each
artifact (an upload, an export, a view package waiting for its data import) to the local disk
of the pod that received it. The next request failed whenever the load balancer picked another
pod. The artifacts move into two tables every pod shares:

  * ``object_store_objects``: one row per key, naming the blob that holds its bytes.
  * ``object_store_chunks``: a blob's bytes in 1 MiB chunks, in order (``seq``).

Fresh installs get both tables from ``0001_baseline``'s create_all and never run this file, so
the DDL is guarded (docs/MIGRATIONS.md). There is no data to move: an artifact lives a day, and
the files already on a pod's disk go with it.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260926_1000_object_store"
down_revision: Union[str, None] = "20260925_1000_view_draft_stage"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if not sa.inspect(bind).has_table("object_store_objects"):
        op.create_table(
            "object_store_objects",
            sa.Column("key", sa.Text(), primary_key=True),
            sa.Column("blob_id", sa.Text(), nullable=False),
            sa.Column("size", sa.BigInteger(), nullable=False),
            sa.Column("chunk_count", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.Text(), nullable=False),
        )
    if not sa.inspect(bind).has_table("object_store_chunks"):
        op.create_table(
            "object_store_chunks",
            sa.Column("blob_id", sa.Text(), primary_key=True),
            sa.Column("seq", sa.Integer(), primary_key=True),
            sa.Column("data", sa.LargeBinary(), nullable=False),
            sa.Column("created_at", sa.Text(), nullable=False),
        )


def downgrade() -> None:
    op.drop_table("object_store_chunks")
    op.drop_table("object_store_objects")
