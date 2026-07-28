"""Widen idp_providers.kind to allow 'custom_profile'.

New IdP kind for enterprise deployments where an upstream corporate
portal (or an auth proxy) has already authenticated the user and hands
the profile over through a cookie, browser storage, or an injected
request header rather than an OIDC/SAML redirect. See
``backend/auth_service/providers/custom_profile.py``.

WIDEN-ONLY, following ``20260720_1300_clear_scope``: rebuild the CHECK
over the required set UNION whatever kinds already exist in the table,
so a row this migration doesn't know about can never wedge the
``ADD CONSTRAINT``.

The ORM (``backend.app.db.models.IdpProviderORM``) carries the widened
CHECK for fresh DBs, where ``create_all`` — which never ALTERs — is the
only DDL that runs. SQLite is skipped for the same reason: it has no
``ALTER TABLE ... DROP CONSTRAINT``, and every SQLite database here is
laid down by ``create_all`` with the current ORM definition.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260725_1200_custom_profile"
down_revision: Union[str, None] = "20260722_0900_merge_jobvis"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "idp_providers"
_CONSTRAINT = "ck_idp_providers_kind"
_REQUIRED: Sequence[str] = ("oidc", "saml2", "custom", "custom_profile")
_REQUIRED_BEFORE: Sequence[str] = ("oidc", "saml2", "custom")


def _widen_kind_check(bind, required: Sequence[str]) -> None:
    """Rebuild ck_idp_providers_kind over `required` ∪ whatever kinds
    are already present in the table."""
    if bind.dialect.name == "sqlite":
        return  # no ALTER ... DROP CONSTRAINT; create_all owns the schema
    inspector = sa.inspect(bind)
    if not inspector.has_table(_TABLE):
        return  # fresh DB: create_all lays down the widened CHECK directly
    present = {
        row[0] for row in bind.execute(sa.text(f"SELECT DISTINCT kind FROM {_TABLE}"))
        if row[0]
    }
    allowed = sorted(set(required) | present)
    values = ", ".join("'" + v.replace("'", "''") + "'" for v in allowed)
    bind.execute(sa.text(
        f"ALTER TABLE {_TABLE} DROP CONSTRAINT IF EXISTS {_CONSTRAINT}"
    ))
    bind.execute(sa.text(
        f"ALTER TABLE {_TABLE} ADD CONSTRAINT {_CONSTRAINT} "
        f"CHECK (kind IN ({values}))"
    ))


def upgrade() -> None:
    _widen_kind_check(op.get_bind(), _REQUIRED)


def downgrade() -> None:
    # Widen-only in reverse: any custom_profile rows that exist stay
    # allowed, so the downgrade can't fail on live data.
    _widen_kind_check(op.get_bind(), _REQUIRED_BEFORE)
