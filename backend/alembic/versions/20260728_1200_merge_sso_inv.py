"""Merge the SSO and invites migration heads.

Revision ID: 20260728_1200_merge_sso_inv
Revises: 20260725_1400_sso_hrd, 20260727_1400_invite_tokenver
Create Date: 2026-07-28 12:00

Two heads formed because the SSO work and the shareable-invite work both
branched off ``20260722_0900_merge_jobvis``:

* SSO     -> ``20260725_1200_custom_profile`` -> ``20260725_1400_sso_hrd``
* invites -> ``20260727_1200_invites``        -> ``20260727_1400_invite_tokenver``

They touch disjoint tables -- four nullable/defaulted columns across
``idp_providers`` and ``app_auth_config`` versus the new ``invites``
tables -- so there is no reconciliation work. This is a no-op merge
revision that rejoins the heads.

It matters more than a tidy graph: the deploy job
(``deploy/helm/dataviz/templates/upgrade-job.yaml``) runs
``alembic upgrade head`` in the singular, which fails outright while two
heads exist. And per QUICKSTART, column *additions* to existing tables
land only through alembic -- ``create_all`` will not add them -- so
without this the SSO columns would silently never appear on an
already-provisioned database.

The revision id is 29 characters, inside the 32-char ``alembic_version``
column limit the CI guard enforces.
"""
from __future__ import annotations

from typing import Sequence, Union


revision: str = "20260728_1200_merge_sso_inv"
down_revision: Union[str, Sequence[str], None] = (
    "20260725_1400_sso_hrd",
    "20260727_1400_invite_tokenver",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """No-op: the two merged chains touch disjoint tables."""
    pass


def downgrade() -> None:
    """No-op: nothing to reverse."""
    pass
