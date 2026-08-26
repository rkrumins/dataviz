"""``backchannel`` provider kind: allowlist table, kind constraint, liveness columns.

Revision ID: 20260824_1500_sso_backchannel
Revises: 20260824_1400_profiling_policy
Create Date: 2026-08-24 15:00

Three changes, all in service of a new SSO provider kind whose identity
comes from calling the IdP server-to-server rather than from parsing an
assertion it handed the browser.

``sso_backchannel_hosts`` is the exception list for the outbound SSRF
guard. That guard refuses every private address, which is correct for
IdP metadata — published on the public internet — and fatal for an
internal identity gateway, which is on RFC1918 by definition. A row per
entry rather than a JSON column because the argument for letting
operators edit this at all rests on each entry being attributable and
individually revocable. ``(host, port)`` is the key: permitting a
gateway on 443 must not also permit whatever answers on 6379 on the
same box. Nothing here can unlock loopback or link-local — those are
refused in ``providers/outbound.py`` regardless of the table's
contents, which is the floor the whole design rests on.

``ck_idp_providers_kind`` gains ``'backchannel'``. Without this an
operator can fill in the whole admin form and the INSERT fails.

``system:sso:hosts:manage`` is seeded here as well as in
``rbac_seed``. ``seed_reference_data`` runs on the virgin-database path
only, so a permission added to the seed alone reaches fresh installs
and nothing else — absent row, absent grants, ungrantable to a custom
role, invisible in the role-matrix UI. It goes to ``super_admin``
alone: ``org_admin`` runs the platform, while this decides where the
platform may send requests, which is a network decision.

``refresh_tokens`` gains ``idp_provider_id`` and ``idp_checked_at`` for
the per-refresh liveness check, which re-confirms the upstream session
on each rotation so our session cannot outlive the SSO session that
created it. Both mirror the reasoning behind the existing ``auth_time``
column: the refresh path needs these BEFORE it trusts anything in the
token, and a claim the token can omit is not a fact about the session.
``idp_checked_at`` is the anchor the outage grace window measures from,
so it is written only on a successful confirmation.

Rewriting a CHECK constraint is the awkward part on SQLite, which
cannot ALTER one. ``batch_alter_table`` handles it by rebuilding the
table; Postgres takes the DROP/ADD path directly.

Downgrade is symmetric, and narrows the kind constraint back — which
fails, correctly, if any ``backchannel`` row still exists.
"""
from __future__ import annotations

import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260824_1500_sso_backchannel"
down_revision: Union[str, None] = "20260824_1400_profiling_policy"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_PERMISSION = "system:sso:hosts:manage"
_PERMISSION_CATEGORY = "system"
_PERMISSION_DESCRIPTION = (
    "Manage which internal hosts SSO may call back to."
)
_PERMISSION_LONG = (
    "Lets you add and remove entries in the back-channel host allowlist — "
    "the internal addresses a back-channel SSO provider is permitted to call "
    "during a login. Deliberately SEPARATE from system:admin, because an "
    "entry lets this service make requests to an address on your internal "
    "network: the list is the only thing standing between an SSO "
    "configuration form and a request-forgery tool, so who may edit it is a "
    "decision worth making on its own. It grants no access to provider "
    "settings or to anyone's identity, and no entry can ever unlock loopback "
    "or the cloud metadata service."
)
_PERMISSION_EXAMPLES = [
    "Allow sso-gateway.corp.internal:443 so a new back-channel provider can "
    "reach it.",
    "Remove a gateway that has been decommissioned.",
]
_ROLE_GRANTS: list[tuple[str, str]] = [
    ("super_admin", _PERMISSION),
]

_KIND_CK = "ck_idp_providers_kind"
_KINDS_WITH = "kind IN ('oidc', 'saml2', 'custom', 'custom_profile', 'backchannel')"
_KINDS_WITHOUT = "kind IN ('oidc', 'saml2', 'custom', 'custom_profile')"


def _has_table(name: str) -> bool:
    bind = op.get_bind()
    return name in sa.inspect(bind).get_table_names()


def _has_column(table: str, column: str) -> bool:
    bind = op.get_bind()
    if table not in sa.inspect(bind).get_table_names():
        return False
    return column in {c["name"] for c in sa.inspect(bind).get_columns(table)}


def _rewrite_kind_check(expression: str) -> None:
    """Swap the ``kind`` CHECK for *expression*.

    SQLite has no ALTER CONSTRAINT, so the table is rebuilt in a batch
    block. On a database created by ``create_all`` the constraint may
    already carry the target expression — dropping it is best-effort
    for that reason.
    """
    dialect = op.get_bind().dialect.name
    if dialect == "sqlite":
        with op.batch_alter_table("idp_providers") as batch:
            try:
                batch.drop_constraint(_KIND_CK, type_="check")
            except Exception:  # noqa: BLE001 — unnamed on older baselines
                pass
            batch.create_check_constraint(_KIND_CK, expression)
        return
    try:
        op.drop_constraint(_KIND_CK, "idp_providers", type_="check")
    except Exception:  # noqa: BLE001
        pass
    op.create_check_constraint(_KIND_CK, "idp_providers", expression)


def upgrade() -> None:
    if not _has_table("sso_backchannel_hosts"):
        op.create_table(
            "sso_backchannel_hosts",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("host", sa.Text(), nullable=False),
            sa.Column("port", sa.Integer(), nullable=False,
                      server_default="443"),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("created_by", sa.Text(), nullable=True),
            sa.UniqueConstraint("host", "port",
                                name="uq_sso_backchannel_host_port"),
            sa.CheckConstraint("port > 0 AND port <= 65535",
                               name="ck_sso_backchannel_port"),
        )

    _rewrite_kind_check(_KINDS_WITH)

    conn = op.get_bind()
    conn.execute(
        sa.text(
            """
            INSERT INTO permissions (id, description, category, long_description, examples)
            VALUES (:id, :description, :category, :long_description, :examples)
            ON CONFLICT (id) DO NOTHING
            """
        ),
        {
            "id": _PERMISSION,
            "description": _PERMISSION_DESCRIPTION,
            "category": _PERMISSION_CATEGORY,
            "long_description": _PERMISSION_LONG,
            "examples": json.dumps(_PERMISSION_EXAMPLES),
        },
    )
    for role_name, perm_id in _ROLE_GRANTS:
        conn.execute(
            sa.text(
                """
                INSERT INTO role_permissions (role_name, permission_id)
                VALUES (:role_name, :permission_id)
                ON CONFLICT (role_name, permission_id) DO NOTHING
                """
            ),
            {"role_name": role_name, "permission_id": perm_id},
        )

    if not _has_column("refresh_tokens", "idp_provider_id"):
        op.add_column(
            "refresh_tokens",
            sa.Column("idp_provider_id", sa.Text(), nullable=True),
        )
    if not _has_column("refresh_tokens", "idp_checked_at"):
        op.add_column(
            "refresh_tokens",
            sa.Column("idp_checked_at", sa.Integer(), nullable=True),
        )


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(
        sa.text("DELETE FROM role_permissions WHERE permission_id = :id"),
        {"id": _PERMISSION},
    )
    conn.execute(
        sa.text("DELETE FROM permissions WHERE id = :id"), {"id": _PERMISSION},
    )

    if _has_column("refresh_tokens", "idp_checked_at"):
        op.drop_column("refresh_tokens", "idp_checked_at")
    if _has_column("refresh_tokens", "idp_provider_id"):
        op.drop_column("refresh_tokens", "idp_provider_id")

    # Narrows the kind constraint. Correctly fails if a backchannel
    # provider row still exists — the rows would be unreadable by the
    # code this downgrade returns to.
    _rewrite_kind_check(_KINDS_WITHOUT)

    if _has_table("sso_backchannel_hosts"):
        op.drop_table("sso_backchannel_hosts")
