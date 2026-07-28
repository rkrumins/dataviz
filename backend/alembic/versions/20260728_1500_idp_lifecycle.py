"""Provider readiness: draft until it has been proved.

Revision ID: 20260728_1500_idp_lifecycle
Revises: 20260728_1200_merge_sso_inv
Create Date: 2026-07-28 15:00

Adds ``idp_providers.lifecycle`` (``draft`` | ``live``). A draft is
configured but unproven: absent from every public surface, still fully
rehearsable, and promoted only by an explicit publish. Creating a provider
used to put it on every user's login page the instant it was saved.

**The default is deliberately asymmetric, and this is the whole point of
the migration:**

* ``server_default='live'`` — every row that already exists when this runs
  is *already* on people's login pages. Backfilling them as drafts would
  silently switch off SSO for every existing deployment at upgrade time.
  Existing rows are grandfathered.
* the ORM-side ``default='draft'`` — every row created *from now on* starts
  unproven, which is the behaviour change we actually want.

So the column's meaning is "has a human confirmed this works?", and for
pre-existing rows the honest answer is "yes, it is serving traffic".

``enabled`` is untouched and keeps its own meaning: the operational switch
for turning a live provider off during an incident. Readiness and
operational state are different questions and conflating them is what
created the problem.

Nullable-free but defaulted, so it is safe on a live table and reversible.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260728_1500_idp_lifecycle"
down_revision: Union[str, None] = "20260728_1200_merge_sso_inv"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _columns(bind, table: str) -> set[str]:
    inspector = sa.inspect(bind)
    if not inspector.has_table(table):
        return set()
    return {c["name"] for c in inspector.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    cols = _columns(bind, "idp_providers")
    # Empty set = the table isn't there yet; ``in cols`` = a fresh DB where
    # create_all already laid the column down.
    if not cols or "lifecycle" in cols:
        return
    op.add_column(
        "idp_providers",
        sa.Column(
            "lifecycle",
            sa.Text(),
            nullable=False,
            server_default="live",
        ),
    )


def downgrade() -> None:
    bind = op.get_bind()
    if "lifecycle" in _columns(bind, "idp_providers"):
        op.drop_column("idp_providers", "lifecycle")
