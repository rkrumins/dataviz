"""Email-first login routing + last-assertion capture.

Four nullable/defaulted columns, all additive:

  * ``idp_providers.email_domains`` — JSON array of domains that route to
    this provider when email-first login is on. Plaintext, mirroring
    ``claim_mapping``: it holds no secrets.
  * ``idp_providers.last_assertion`` / ``.last_assertion_at`` — the most
    recent claims blob this provider sent, Fernet-encrypted with the same
    envelope as ``settings``, so an operator can map against what actually
    arrived rather than a hand-typed sample.
  * ``app_auth_config.email_first_login`` — the posture switch, defaulting
    FALSE. It changes what every user sees, so it must be opted into.

Every column is nullable or defaulted, so this is safe on a live table and
reversible without data loss. Adds no constraints and no indexes: none of
these are queried by predicate — ``email_domains`` is read for the whole
enabled set (a handful of rows) and the assertion columns are read one row
at a time by id.

Idempotent in both directions, following the existing SSO migrations.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260725_1400_sso_hrd"
down_revision: Union[str, None] = "20260725_1200_custom_profile"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_ADDITIONS: tuple[tuple[str, str, sa.Column], ...] = (
    ("idp_providers", "email_domains", sa.Column("email_domains", sa.Text(), nullable=True)),
    ("idp_providers", "last_assertion", sa.Column("last_assertion", sa.Text(), nullable=True)),
    ("idp_providers", "last_assertion_at", sa.Column("last_assertion_at", sa.Text(), nullable=True)),
    ("app_auth_config", "email_first_login",
     sa.Column("email_first_login", sa.Boolean(), nullable=False,
               server_default=sa.false())),
)


def _existing(bind, table: str) -> set[str]:
    inspector = sa.inspect(bind)
    if not inspector.has_table(table):
        return set()
    return {c["name"] for c in inspector.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    for table, name, column in _ADDITIONS:
        cols = _existing(bind, table)
        # Empty set = the table isn't there yet; ``name in cols`` = a fresh
        # DB where create_all already laid the column down.
        if not cols or name in cols:
            continue
        op.add_column(table, column)


def downgrade() -> None:
    bind = op.get_bind()
    for table, name, _column in reversed(_ADDITIONS):
        if name in _existing(bind, table):
            op.drop_column(table, name)
