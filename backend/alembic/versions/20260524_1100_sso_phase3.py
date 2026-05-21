"""SSO Phase 3 — multi-IdP, multi-identity, configurable mappings.

Revision ID: 20260524_1100_sso_phase3
Revises: 20260521_1200_sso_phase2
Create Date: 2026-05-24 11:00

Re-architecture of the SSO foundation:

  * New ``idp_providers`` table — one row per configured IdP, settings
    encrypted (Fernet, reusing ``CREDENTIAL_ENCRYPTION_KEY``), claim
    mappings stored per-provider so operators can plumb any IdP claim
    layout to internal fields.
  * New ``user_identities`` table — replaces the
    ``(users.auth_provider, users.external_id)`` pair so one user can
    stack local + Entra + Auth0 + SAML simultaneously.
  * ``idp_group_role_mappings`` extended with ``target_type``
    (``role_binding`` | ``group_membership``), ``target_group_id``,
    and ``provider_id`` for per-IdP scoping.
  * ``groups.is_protected`` + ``group_members.source`` so the SSO
    group->group reconciler can safely add/remove memberships
    without trampling admin-managed groups.
  * ``role_bindings.role_name -> roles.name`` FK (RESTRICT) so role
    deletion no longer silently orphans bindings.

Data migration:
  * For every existing ``UserORM`` row with ``external_id`` set, we
    synthesize an ``idp_providers`` row (one per distinct
    ``auth_provider`` value seen) and a matching ``user_identities``
    row. The synthesized provider is left ``enabled=true`` with
    empty ``settings`` so the admin can fill it in via the UI; the
    runtime registry tolerates an empty settings blob until the
    operator configures it.

Downgrade restores the Phase 2 columns by selecting the first
identity per user as the primary; data loss is limited to extra
identities (the second+ provider per user) which is expected when
unwinding a multi-identity migration.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260524_1100_sso_phase3"
down_revision: Union[str, None] = "20260521_1200_sso_phase2"
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


def upgrade() -> None:  # noqa: C901 — migration is one logical unit
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    now = sa.func.now()

    # 1. idp_providers ----------------------------------------------------
    if not _has_table(inspector, "idp_providers"):
        op.create_table(
            "idp_providers",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("slug", sa.Text(), nullable=False),
            sa.Column("display_name", sa.Text(), nullable=False),
            sa.Column("kind", sa.Text(), nullable=False),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("TRUE")),
            sa.Column("priority", sa.Integer(), nullable=False, server_default="100"),
            sa.Column("settings", sa.Text(), nullable=False, server_default="{}"),
            sa.Column("claim_mapping", sa.Text(), nullable=False, server_default="{}"),
            sa.Column(
                "linking_policy", sa.Text(), nullable=False,
                server_default="strict",
            ),
            sa.Column("button_label", sa.Text(), nullable=True),
            sa.Column("button_icon", sa.Text(), nullable=True),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("created_by", sa.Text(), nullable=True),
            sa.Column("updated_at", sa.Text(), nullable=False),
            sa.Column("updated_by", sa.Text(), nullable=True),
            sa.UniqueConstraint("slug", name="uq_idp_providers_slug"),
            sa.CheckConstraint(
                "kind IN ('oidc', 'saml2', 'custom')",
                name="ck_idp_providers_kind",
            ),
            sa.CheckConstraint(
                "linking_policy IN ('strict', 'allow_verified', 'manual_only', 'disabled')",
                name="ck_idp_providers_linking_policy",
            ),
        )
        op.create_index(
            "idx_idp_providers_kind_enabled",
            "idp_providers", ["kind", "enabled"],
        )

    # 2. user_identities --------------------------------------------------
    if not _has_table(inspector, "user_identities"):
        op.create_table(
            "user_identities",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column(
                "user_id", sa.Text(),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "provider_id", sa.Text(),
                sa.ForeignKey("idp_providers.id", ondelete="RESTRICT"),
                nullable=False,
            ),
            sa.Column("external_id", sa.Text(), nullable=False),
            sa.Column("email_at_link", sa.Text(), nullable=True),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("last_login_at", sa.Text(), nullable=True),
            sa.Column("metadata", sa.Text(), nullable=True, server_default="{}"),
            sa.UniqueConstraint(
                "provider_id", "external_id",
                name="uq_user_identities_provider_subject",
            ),
            sa.UniqueConstraint(
                "user_id", "provider_id",
                name="uq_user_identities_user_provider",
            ),
        )
        op.create_index(
            "idx_user_identities_user", "user_identities", ["user_id"],
        )

    # 3. Data backfill ---------------------------------------------------
    # For every existing UserORM row with external_id set, synthesize a
    # provider (if one doesn't already exist for that auth_provider
    # value) and a matching identity row. The provider's settings
    # field is empty so the operator must finish configuring it in
    # the admin UI before SSO logins resume — but the user record
    # itself stays intact and accessible.
    if _has_column(inspector, "users", "auth_provider"):
        # Collect the distinct (auth_provider) tuples that have at
        # least one user.
        seen = bind.execute(
            sa.text(
                "SELECT DISTINCT auth_provider FROM users "
                "WHERE auth_provider IS NOT NULL "
                "  AND auth_provider != 'local' "
                "  AND external_id IS NOT NULL"
            )
        ).fetchall()
        for (kind,) in seen:
            slug = f"default-{kind}"
            existing = bind.execute(
                sa.text("SELECT id FROM idp_providers WHERE slug = :slug"),
                {"slug": slug},
            ).first()
            if existing is None:
                bind.execute(
                    sa.text(
                        "INSERT INTO idp_providers "
                        "(id, slug, display_name, kind, enabled, priority, "
                        " settings, claim_mapping, linking_policy, "
                        " created_at, updated_at) "
                        "VALUES (:id, :slug, :name, :kind, FALSE, 100, "
                        "        '{}', '{}', 'strict', :now, :now)"
                    ),
                    {
                        "id": f"idp_legacy{kind[:8]}",
                        "slug": slug,
                        "name": f"Legacy {kind.upper()}",
                        "kind": kind,
                        "now": _now_iso_text(bind),
                    },
                )

        # Now insert one user_identities row per SSO user. Use
        # ``user_id + a 9-char suffix`` so the id is stable + unique
        # across reruns of the migration.
        bind.execute(
            sa.text(
                "INSERT INTO user_identities "
                "(id, user_id, provider_id, external_id, email_at_link, created_at) "
                "SELECT 'uid_' || substr(md5(u.id || u.auth_provider), 1, 12), "
                "       u.id, p.id, u.external_id, u.email, :now "
                "FROM users u "
                "JOIN idp_providers p ON p.slug = 'default-' || u.auth_provider "
                "WHERE u.external_id IS NOT NULL "
                "  AND u.auth_provider != 'local' "
                "ON CONFLICT (provider_id, external_id) DO NOTHING"
            ),
            {"now": _now_iso_text(bind)},
        )

    # 4. Drop the Phase 2 SSO columns from users -------------------------
    if _has_column(inspector, "users", "external_id"):
        # Drop the UNIQUE first (Postgres-only nuance).
        if _has_constraint(bind, "users", "uq_users_provider_external_id"):
            op.drop_constraint(
                "uq_users_provider_external_id", "users", type_="unique",
            )
        if _has_constraint(bind, "users", "ck_users_auth_provider"):
            op.drop_constraint(
                "ck_users_auth_provider", "users", type_="check",
            )
        op.drop_column("users", "external_id")
        op.drop_column("users", "auth_provider")

    # 5. idp_group_role_mappings — add target_type, provider_id, group ----
    if _has_table(inspector, "idp_group_role_mappings"):
        cols = {c["name"] for c in inspector.get_columns("idp_group_role_mappings")}
        if "target_type" not in cols:
            op.add_column(
                "idp_group_role_mappings",
                sa.Column(
                    "target_type", sa.Text(),
                    nullable=False, server_default="role_binding",
                ),
            )
        if "target_group_id" not in cols:
            op.add_column(
                "idp_group_role_mappings",
                sa.Column(
                    "target_group_id", sa.Text(),
                    sa.ForeignKey("groups.id", ondelete="CASCADE"),
                    nullable=True,
                ),
            )
        if "provider_id" not in cols:
            op.add_column(
                "idp_group_role_mappings",
                sa.Column(
                    "provider_id", sa.Text(),
                    sa.ForeignKey("idp_providers.id", ondelete="CASCADE"),
                    nullable=True,
                ),
            )

        # Relax NOT NULL on scope_type and role_name — group_membership
        # mappings leave them NULL.
        op.alter_column(
            "idp_group_role_mappings", "scope_type",
            existing_type=sa.Text(), nullable=True,
        )
        op.alter_column(
            "idp_group_role_mappings", "role_name",
            existing_type=sa.Text(), nullable=True,
        )

        # Replace the Phase-2 uniqueness key with two: one per target
        # type. The OLD key (idp_group, scope_type, scope_id, role_name)
        # is dropped; new keys include provider_id.
        if _has_constraint(bind, "idp_group_role_mappings", "uq_idp_group_role_mapping"):
            op.drop_constraint(
                "uq_idp_group_role_mapping",
                "idp_group_role_mappings",
                type_="unique",
            )
        op.create_unique_constraint(
            "uq_idp_group_role_mapping_role",
            "idp_group_role_mappings",
            ["provider_id", "idp_group", "scope_type", "scope_id", "role_name"],
        )
        op.create_unique_constraint(
            "uq_idp_group_role_mapping_group_membership",
            "idp_group_role_mappings",
            ["provider_id", "idp_group", "target_group_id"],
        )
        op.create_index(
            "idx_idp_group_role_mapping_provider_group",
            "idp_group_role_mappings",
            ["provider_id", "idp_group"],
        )

        # Replace the Phase 2 CHECK with the v2 shape check that
        # accommodates both target types.
        if _has_constraint(
            bind, "idp_group_role_mappings",
            "ck_idp_group_role_mappings_scope_type",
        ):
            op.drop_constraint(
                "ck_idp_group_role_mappings_scope_type",
                "idp_group_role_mappings", type_="check",
            )
        if _has_constraint(
            bind, "idp_group_role_mappings",
            "ck_idp_group_role_mappings_scope_consistency",
        ):
            op.drop_constraint(
                "ck_idp_group_role_mappings_scope_consistency",
                "idp_group_role_mappings", type_="check",
            )
        op.create_check_constraint(
            "ck_idp_group_role_mappings_target_type",
            "idp_group_role_mappings",
            "target_type IN ('role_binding', 'group_membership')",
        )
        op.create_check_constraint(
            "ck_idp_group_role_mappings_target_shape",
            "idp_group_role_mappings",
            "(target_type = 'role_binding' "
            " AND role_name IS NOT NULL "
            " AND scope_type IN ('global', 'workspace') "
            " AND ((scope_type = 'global' AND scope_id IS NULL) "
            "      OR (scope_type = 'workspace' AND scope_id IS NOT NULL)) "
            " AND target_group_id IS NULL) "
            "OR (target_type = 'group_membership' "
            "    AND target_group_id IS NOT NULL "
            "    AND role_name IS NULL "
            "    AND scope_type IS NULL "
            "    AND scope_id IS NULL)",
        )

    # 6. groups.is_protected + group_members.source -----------------------
    if _has_table(inspector, "groups") and not _has_column(inspector, "groups", "is_protected"):
        op.add_column(
            "groups",
            sa.Column(
                "is_protected", sa.Boolean(),
                nullable=False, server_default=sa.text("FALSE"),
            ),
        )

    if _has_table(inspector, "group_members") and not _has_column(
        inspector, "group_members", "source"
    ):
        op.add_column(
            "group_members",
            sa.Column(
                "source", sa.Text(),
                nullable=False, server_default="local",
            ),
        )
        op.create_check_constraint(
            "ck_group_members_source",
            "group_members",
            "source IN ('local', 'sso')",
        )

    # 7. role_bindings.role_name FK to roles.name (RESTRICT) -------------
    # Backfill any orphaned role_names into a placeholder role so the
    # FK does not reject the constraint creation.
    if _has_table(inspector, "role_bindings") and _has_table(inspector, "roles"):
        bind.execute(
            sa.text(
                "INSERT INTO roles (name, description, scope_type, scope_id, "
                "                   is_system, created_at, updated_at) "
                "SELECT DISTINCT rb.role_name, "
                "       'Orphaned role recovered during Phase 3 migration', "
                "       'global', NULL, FALSE, :now, :now "
                "FROM role_bindings rb "
                "LEFT JOIN roles r ON r.name = rb.role_name "
                "WHERE r.name IS NULL "
                "ON CONFLICT (name) DO NOTHING"
            ),
            {"now": _now_iso_text(bind)},
        )
        if not _has_constraint(bind, "role_bindings", "fk_role_bindings_role_name"):
            op.create_foreign_key(
                "fk_role_bindings_role_name",
                source_table="role_bindings",
                referent_table="roles",
                local_cols=["role_name"],
                remote_cols=["name"],
                ondelete="RESTRICT",
            )


def downgrade() -> None:  # noqa: C901
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # 7. drop the FK
    if _has_constraint(bind, "role_bindings", "fk_role_bindings_role_name"):
        op.drop_constraint(
            "fk_role_bindings_role_name", "role_bindings", type_="foreignkey",
        )

    # 6. group_members.source + groups.is_protected
    if _has_constraint(bind, "group_members", "ck_group_members_source"):
        op.drop_constraint("ck_group_members_source", "group_members", type_="check")
    if _has_column(inspector, "group_members", "source"):
        op.drop_column("group_members", "source")
    if _has_column(inspector, "groups", "is_protected"):
        op.drop_column("groups", "is_protected")

    # 5. idp_group_role_mappings — revert to Phase 2 shape
    if _has_table(inspector, "idp_group_role_mappings"):
        for ck in (
            "ck_idp_group_role_mappings_target_shape",
            "ck_idp_group_role_mappings_target_type",
        ):
            if _has_constraint(bind, "idp_group_role_mappings", ck):
                op.drop_constraint(ck, "idp_group_role_mappings", type_="check")
        for uq in (
            "uq_idp_group_role_mapping_role",
            "uq_idp_group_role_mapping_group_membership",
        ):
            if _has_constraint(bind, "idp_group_role_mappings", uq):
                op.drop_constraint(uq, "idp_group_role_mappings", type_="unique")

        # Best-effort: drop new columns. Existing rows of target_type='group_membership'
        # are deleted on downgrade (no Phase 2 representation).
        bind.execute(sa.text(
            "DELETE FROM idp_group_role_mappings WHERE target_type = 'group_membership'"
        ))
        for col in ("provider_id", "target_group_id", "target_type"):
            if _has_column(inspector, "idp_group_role_mappings", col):
                op.drop_column("idp_group_role_mappings", col)

        op.alter_column(
            "idp_group_role_mappings", "scope_type",
            existing_type=sa.Text(), nullable=False,
        )
        op.alter_column(
            "idp_group_role_mappings", "role_name",
            existing_type=sa.Text(), nullable=False,
        )
        op.create_unique_constraint(
            "uq_idp_group_role_mapping",
            "idp_group_role_mappings",
            ["idp_group", "scope_type", "scope_id", "role_name"],
        )
        op.create_check_constraint(
            "ck_idp_group_role_mappings_scope_type",
            "idp_group_role_mappings",
            "scope_type IN ('global', 'workspace')",
        )
        op.create_check_constraint(
            "ck_idp_group_role_mappings_scope_consistency",
            "idp_group_role_mappings",
            "(scope_type = 'global' AND scope_id IS NULL) "
            "OR (scope_type = 'workspace' AND scope_id IS NOT NULL)",
        )

    # 4. restore users.auth_provider + external_id
    if not _has_column(inspector, "users", "auth_provider"):
        op.add_column(
            "users",
            sa.Column(
                "auth_provider", sa.Text(),
                nullable=False, server_default="local",
            ),
        )
        op.add_column(
            "users",
            sa.Column("external_id", sa.Text(), nullable=True),
        )
        op.create_check_constraint(
            "ck_users_auth_provider", "users",
            "auth_provider IN ('local', 'oidc', 'saml2', 'custom')",
        )

    # 3. backfill the Phase 2 columns from the first user_identities row.
    if _has_table(inspector, "user_identities") and _has_table(inspector, "idp_providers"):
        bind.execute(
            sa.text(
                "UPDATE users u SET "
                "  auth_provider = p.kind, "
                "  external_id   = ui.external_id "
                "FROM user_identities ui JOIN idp_providers p ON p.id = ui.provider_id "
                "WHERE ui.user_id = u.id "
                "  AND ui.id IN ( "
                "    SELECT MIN(id) FROM user_identities GROUP BY user_id"
                "  )"
            )
        )
        op.create_unique_constraint(
            "uq_users_provider_external_id", "users",
            ["auth_provider", "external_id"],
        )

    # 2 + 1. drop the new tables.
    if _has_table(inspector, "user_identities"):
        op.drop_index("idx_user_identities_user", table_name="user_identities")
        op.drop_table("user_identities")
    if _has_table(inspector, "idp_providers"):
        op.drop_index("idx_idp_providers_kind_enabled", table_name="idp_providers")
        op.drop_table("idp_providers")


def _now_iso_text(bind) -> str:
    """SQLite + Postgres-portable ISO-8601 timestamp string."""
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
