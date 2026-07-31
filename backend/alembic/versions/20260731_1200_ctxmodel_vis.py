"""context_models.visibility: a column the ORM had and no migration ever added.

``ContextModelORM`` has declared ``visibility`` (NOT NULL, plus
``ck_context_models_visibility``) for a long time, but nothing in the
chain adds it. It reached databases only through ``0001_baseline``'s
``Base.metadata.create_all()`` — so an environment built *after* the
column entered the ORM has it, and every environment built before does
not. Both then report themselves at head.

That is the create_all baseline's failure mode in its purest form:
``context_models`` is one of the 46 tables no migration ever creates, so
a column added to it in the ORM is silently a fresh-installs-only column.
It stayed invisible because the instance rows were deleted by
``20260707_1200_view_layout_merge`` and templates rarely exercise the
read path — but any query naming ``context_models.visibility`` raises
``UndefinedColumn`` on an older database.

Found by ``synodic-upgrade repair``, which refuses to stamp while the ORM
declares anything the database lacks and named this as the one gap.

The column is added with a ``server_default`` so existing rows satisfy
NOT NULL, and the default is then dropped: the ORM declares only a
Python-side ``default="private"``, so leaving a server default in place
would show up forever as autogenerate drift — the same mismatch
``invites.token_version`` already carries.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260731_1200_ctxmodel_vis"
down_revision: Union[str, None] = "20260730_1200_refresh_records"
branch_labels: Union[str, None] = None
depends_on: Union[str, None] = None

_TABLE = "context_models"
_CONSTRAINT = "ck_context_models_visibility"


def upgrade() -> None:
    op.add_column(
        _TABLE,
        sa.Column(
            "visibility", sa.Text(), nullable=False, server_default="private",
        ),
        if_not_exists=True,
    )
    # Drop the server default now that every existing row has a value —
    # the ORM's default is Python-side only.
    op.execute(f"ALTER TABLE {_TABLE} ALTER COLUMN visibility DROP DEFAULT")

    # Idempotent by drop-then-add: a database built by create_all already
    # carries this constraint from the ORM's __table_args__.
    op.execute(f"ALTER TABLE {_TABLE} DROP CONSTRAINT IF EXISTS {_CONSTRAINT}")
    op.create_check_constraint(
        _CONSTRAINT, _TABLE,
        "visibility IN ('private', 'workspace', 'enterprise')",
    )


def downgrade() -> None:
    op.execute(f"ALTER TABLE {_TABLE} DROP CONSTRAINT IF EXISTS {_CONSTRAINT}")
    op.execute(f"ALTER TABLE {_TABLE} DROP COLUMN IF EXISTS visibility")
