"""Merge the job-visibility and node-identity migration heads.

Revision ID: 20260722_0900_merge_jobvis
Revises: 20260720_1300_clear_scope, 20260721_1500_ds_name_prop
Create Date: 2026-07-22 09:00

Two heads formed while the freshness job-visibility work was in flight:

* freshness cockpit -> ``20260720_1300_clear_scope`` (refresh-scope CHECK widened)
* node identity     -> ``20260721_1200_ds_identity_prop`` -> ``20260721_1500_ds_name_prop``

They touch disjoint columns -- the refresh_events scope CHECK versus two
nullable ``aggregation_jobs`` property columns -- so there is no
reconciliation work. This is a no-op merge revision that rejoins the heads
so ``alembic upgrade head`` resolves to one again.

The revision id is 26 characters, inside the 32-char ``alembic_version``
column limit the CI guard enforces.
"""
from __future__ import annotations

from typing import Sequence, Union


revision: str = "20260722_0900_merge_jobvis"
down_revision: Union[str, Sequence[str], None] = (
    "20260720_1300_clear_scope",
    "20260721_1500_ds_name_prop",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """No-op: the two merged chains touch disjoint columns."""
    pass


def downgrade() -> None:
    """No-op: nothing to reverse."""
    pass
