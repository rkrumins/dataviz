"""Merge the view-visibility and invite-ledger chains.

Both branched off ``20260722_0900_merge_jobvis`` in parallel:

    20260722_0900_merge_jobvis
    ├── 20260727_1200_invites          → 20260727_1400_invite_tokenver
    └── 20260727_1200_view_public_tier → 20260727_1300_grant_expiry

Git merged them without complaint — each side only *added* files to this
directory, so there is no textual conflict to report. The fork only
surfaces at ``alembic upgrade head``, as "Multiple head revisions are
present".

No-op: the two chains touch disjoint tables. The invite chain creates
``invites`` / ``invite_redemptions``; the visibility chain widens the
``views`` tier CHECK, drops the dead ``context_models.visibility``, and
adds ``resource_grants.expires_at``.
"""
from __future__ import annotations

from typing import Sequence, Union

revision: str = "20260728_0900_merge_vw_inv"
down_revision: Union[str, Sequence[str], None] = (
    "20260727_1300_grant_expiry",
    "20260727_1400_invite_tokenver",
)
branch_labels = None
depends_on = None


def upgrade() -> None:
    """No-op: the two merged chains touch disjoint tables."""
    pass


def downgrade() -> None:
    """No-op: splitting the chains again needs no schema change."""
    pass
