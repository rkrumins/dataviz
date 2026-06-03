"""SSO Phase 4 — signup provenance + indexed claim attributes + app auth config.

Revision ID: 20260527_1200_sso_phase4
Revises: 20260524_1100_sso_phase3
Create Date: 2026-05-27 12:00

NB on the id: this migration originally shipped as
``20260527_1200_user_provenance_and_config`` (40 chars), which
overflowed the default ``alembic_version.version_num VARCHAR(32)``
column and produced a ``StringDataRightTruncation`` on the
post-migration UPDATE. The revision was renamed to
``20260527_1200_sso_phase4`` (24 chars, matching the
``sso_phase2`` / ``sso_phase3`` naming convention) before any deployed
environment had committed to the old id, so no on-disk
``alembic_version`` rows need rewriting.

Three additions on top of Phase 3:

  * ``users.signup_source`` + ``users.signup_provider_id`` — make the
    admin lookup surface answer "how did this user sign up?" without
    replaying ``auth_audit_log``. Backfilled from the live data:
    users with an existing ``user_identities`` row become
    ``sso_jit`` + provider; everyone else stays ``local_signup``.

  * ``user_external_attributes`` — the indexed projection of the
    Phase-3 ``users.metadata_.attributes`` JSON blob. One row per
    (user, attribute key); UNIQUE(user_id, key) + INDEX(key, value)
    covers the help-desk lookup ``where staff_id = '12345'``.

  * ``app_auth_config`` — singleton row carrying the platform-wide
    SSO posture (master toggle, allow_local_login, allow_jit_provisioning).
    Seeded with all-true defaults so existing deployments keep
    working unchanged.

Idempotent; downgrade restores Phase 3 schema cleanly.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260527_1200_sso_phase4"
down_revision: Union[str, None] = "20260524_1100_sso_phase3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(inspector, table: str) -> bool:
    return table in inspector.get_table_names()


def _has_column(inspector, table: str, column: str) -> bool:
    if not _has_table(inspector, table):
        return False
    return any(c["name"] == column for c in inspector.get_columns(table))


def _has_constraint(bind, table: str, name: str) -> bool:
    row = bind.execute(
        sa.text(
            "SELECT 1 FROM pg_constraint c "
            "JOIN pg_class t ON t.oid = c.conrelid "
            "WHERE t.relname = :table AND c.conname = :name"
        ),
        {"table": table, "name": name},
    ).first()
    return row is not None


def _now_iso(bind) -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # 1. users.signup_source + signup_provider_id -----------------------
    if not _has_column(inspector, "users", "signup_source"):
        # Add as nullable first so the backfill can populate it
        # without violating NOT NULL on the existing rows.
        op.add_column(
            "users",
            sa.Column(
                "signup_source", sa.Text(),
                nullable=True, server_default="local_signup",
            ),
        )
    if not _has_column(inspector, "users", "signup_provider_id"):
        op.add_column(
            "users",
            sa.Column(
                "signup_provider_id", sa.Text(),
                sa.ForeignKey("idp_providers.id", ondelete="SET NULL"),
                nullable=True,
            ),
        )

    # Backfill: any user with an existing ``user_identities`` row is
    # treated as ``sso_jit`` with ``signup_provider_id`` = earliest
    # identity's provider. Everyone else stays ``local_signup``.
    if _has_table(inspector, "user_identities"):
        bind.execute(
            sa.text(
                "UPDATE users u SET "
                "  signup_source = 'sso_jit', "
                "  signup_provider_id = ( "
                "    SELECT ui.provider_id FROM user_identities ui "
                "    WHERE ui.user_id = u.id "
                "    ORDER BY ui.created_at ASC LIMIT 1 "
                "  ) "
                "WHERE u.signup_source IS NULL "
                "   OR u.signup_source = 'local_signup' "
                "  AND EXISTS ( "
                "    SELECT 1 FROM user_identities ui WHERE ui.user_id = u.id "
                "  )"
            )
        )

    # Lock the column in: NOT NULL + CHECK.
    op.execute(
        "UPDATE users SET signup_source = 'local_signup' "
        "WHERE signup_source IS NULL"
    )
    op.alter_column(
        "users", "signup_source",
        existing_type=sa.Text(), nullable=False,
        server_default="local_signup",
    )
    if not _has_constraint(bind, "users", "ck_users_signup_source"):
        op.create_check_constraint(
            "ck_users_signup_source", "users",
            "signup_source IN ('local_signup', 'sso_jit', 'invite', "
            "                  'admin_created', 'admin_linked')",
        )
    # Lookup index for "show me every JIT-provisioned user from
    # provider X" admin queries.
    try:
        op.create_index(
            "idx_users_signup_source", "users", ["signup_source"]
        )
    except Exception:  # noqa: BLE001 — partial reruns may have it already
        pass

    # 2. user_external_attributes table ---------------------------------
    if not _has_table(inspector, "user_external_attributes"):
        op.create_table(
            "user_external_attributes",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column(
                "user_id", sa.Text(),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("key", sa.Text(), nullable=False),
            sa.Column("value", sa.Text(), nullable=False),
            sa.Column(
                "source_provider_id", sa.Text(),
                sa.ForeignKey("idp_providers.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column("set_at", sa.Text(), nullable=False),
            sa.UniqueConstraint(
                "user_id", "key",
                name="uq_user_external_attributes_user_key",
            ),
        )
        op.create_index(
            "idx_user_external_attributes_key_value",
            "user_external_attributes", ["key", "value"],
        )
        op.create_index(
            "idx_user_external_attributes_user",
            "user_external_attributes", ["user_id"],
        )

    # 3. app_auth_config singleton --------------------------------------
    if not _has_table(inspector, "app_auth_config"):
        op.create_table(
            "app_auth_config",
            sa.Column(
                "id", sa.Text(), primary_key=True,
                server_default="singleton",
            ),
            sa.Column(
                "sso_enabled", sa.Boolean(),
                nullable=False, server_default=sa.text("TRUE"),
            ),
            sa.Column(
                "allow_local_login", sa.Boolean(),
                nullable=False, server_default=sa.text("TRUE"),
            ),
            sa.Column(
                "allow_jit_provisioning", sa.Boolean(),
                nullable=False, server_default=sa.text("TRUE"),
            ),
            sa.Column(
                "version", sa.Integer(),
                nullable=False, server_default="1",
            ),
            sa.Column("updated_at", sa.Text(), nullable=False),
            sa.Column("updated_by", sa.Text(), nullable=True),
            sa.CheckConstraint(
                "id = 'singleton'", name="ck_app_auth_config_singleton",
            ),
        )
        bind.execute(
            sa.text(
                "INSERT INTO app_auth_config "
                "(id, sso_enabled, allow_local_login, allow_jit_provisioning, "
                " version, updated_at, updated_by) "
                "VALUES ('singleton', TRUE, TRUE, TRUE, 1, :now, NULL) "
                "ON CONFLICT (id) DO NOTHING"
            ),
            {"now": _now_iso(bind)},
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, "app_auth_config"):
        op.drop_table("app_auth_config")

    if _has_table(inspector, "user_external_attributes"):
        op.drop_index(
            "idx_user_external_attributes_user",
            table_name="user_external_attributes",
        )
        op.drop_index(
            "idx_user_external_attributes_key_value",
            table_name="user_external_attributes",
        )
        op.drop_table("user_external_attributes")

    if _has_constraint(bind, "users", "ck_users_signup_source"):
        op.drop_constraint("ck_users_signup_source", "users", type_="check")
    try:
        op.drop_index("idx_users_signup_source", table_name="users")
    except Exception:  # noqa: BLE001
        pass
    if _has_column(inspector, "users", "signup_provider_id"):
        op.drop_column("users", "signup_provider_id")
    if _has_column(inspector, "users", "signup_source"):
        op.drop_column("users", "signup_source")
