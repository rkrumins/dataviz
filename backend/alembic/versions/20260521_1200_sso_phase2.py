"""SSO Phase 2 — SAML/custom providers, group->role mapping, RoleBinding source.

Revision ID: 20260521_1200_sso_phase2
Revises: 20260517_1300_auth_audit_log
Create Date: 2026-05-21 12:00

Ships the schema half of the Phase 2 SSO rollout:

  * Relaxes ``users.auth_provider`` CHECK from ('local','oidc','saml2')
    to also include ``'custom'`` (dev/demo provider, never enabled in
    production via the AUTH_CUSTOM_PROVIDER_ENABLED env gate).
  * Adds ``role_bindings.source`` (``'local'`` | ``'sso'``) so the
    Phase 2 reconciler can distinguish admin-granted bindings from
    IdP-group-derived ones — the reconciler only ever touches
    ``source='sso'`` rows.
  * Creates ``idp_group_role_mappings`` — the admin-managed table
    that drives the reconciler. ``(idp_group, scope, role_name)`` is
    UNIQUE; ``system:admin`` mappings are also refused at the
    application layer, but no DB-level CHECK enforces it (admins must
    still be able to type the role name to bind it elsewhere).

Idempotent: every step skips itself when already in place, so partial
reruns and fresh deploys (where ``create_all`` already populated the
schema) are safe.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260521_1200_sso_phase2"
down_revision: Union[str, None] = "20260517_1300_auth_audit_log"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_USERS_TABLE = "users"
_USERS_CHECK = "ck_users_auth_provider"
_BINDINGS_TABLE = "role_bindings"
_BINDINGS_SOURCE_CHECK = "ck_role_bindings_source"
_MAPPING_TABLE = "idp_group_role_mappings"


def _has_constraint(bind, table: str, name: str) -> bool:
    row = bind.execute(
        sa.text(
            """
            SELECT 1 FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            WHERE t.relname = :table AND c.conname = :name
            """
        ),
        {"table": table, "name": name},
    ).first()
    return row is not None


def _has_column(inspector, table: str, column: str) -> bool:
    if table not in inspector.get_table_names():
        return False
    return any(c["name"] == column for c in inspector.get_columns(table))


def _has_table(inspector, table: str) -> bool:
    return table in inspector.get_table_names()


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # 1. users.auth_provider CHECK: drop + re-add to include 'custom'.
    #    Defensive: the column is dropped by SSO Phase 3. On a schema
    #    built from the current ORM (post-Phase-3), the column is
    #    absent at this point and the CHECK cannot be created. Skip
    #    silently — matches the no-op semantics of the surrounding
    #    column-presence guards.
    if _has_column(inspector, _USERS_TABLE, "auth_provider"):
        if _has_constraint(bind, _USERS_TABLE, _USERS_CHECK):
            op.drop_constraint(_USERS_CHECK, _USERS_TABLE, type_="check")
        op.create_check_constraint(
            _USERS_CHECK,
            _USERS_TABLE,
            "auth_provider IN ('local', 'oidc', 'saml2', 'custom')",
        )

    # 2. role_bindings.source column + CHECK.
    if _has_table(inspector, _BINDINGS_TABLE):
        if not _has_column(inspector, _BINDINGS_TABLE, "source"):
            op.add_column(
                _BINDINGS_TABLE,
                sa.Column(
                    "source",
                    sa.Text(),
                    nullable=False,
                    server_default=sa.text("'local'"),
                ),
            )
        if not _has_constraint(bind, _BINDINGS_TABLE, _BINDINGS_SOURCE_CHECK):
            op.create_check_constraint(
                _BINDINGS_SOURCE_CHECK,
                _BINDINGS_TABLE,
                "source IN ('local', 'sso')",
            )

    # 3. idp_group_role_mappings table.
    if not _has_table(inspector, _MAPPING_TABLE):
        op.create_table(
            _MAPPING_TABLE,
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("idp_group", sa.Text(), nullable=False),
            sa.Column("scope_type", sa.Text(), nullable=False),
            sa.Column("scope_id", sa.Text(), nullable=True),
            sa.Column("role_name", sa.Text(), nullable=False),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("created_by", sa.Text(), nullable=True),
            sa.UniqueConstraint(
                "idp_group", "scope_type", "scope_id", "role_name",
                name="uq_idp_group_role_mapping",
            ),
            sa.CheckConstraint(
                "scope_type IN ('global', 'workspace')",
                name="ck_idp_group_role_mappings_scope_type",
            ),
            sa.CheckConstraint(
                "(scope_type = 'global' AND scope_id IS NULL) "
                "OR (scope_type = 'workspace' AND scope_id IS NOT NULL)",
                name="ck_idp_group_role_mappings_scope_consistency",
            ),
        )
        op.create_index(
            "idx_idp_group_role_mapping_group", _MAPPING_TABLE, ["idp_group"]
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # 3. mapping table.
    if _has_table(inspector, _MAPPING_TABLE):
        op.drop_index(
            "idx_idp_group_role_mapping_group", table_name=_MAPPING_TABLE
        )
        op.drop_table(_MAPPING_TABLE)

    # 2. role_bindings.source.
    if _has_table(inspector, _BINDINGS_TABLE):
        if _has_constraint(bind, _BINDINGS_TABLE, _BINDINGS_SOURCE_CHECK):
            op.drop_constraint(
                _BINDINGS_SOURCE_CHECK, _BINDINGS_TABLE, type_="check",
            )
        if _has_column(inspector, _BINDINGS_TABLE, "source"):
            op.drop_column(_BINDINGS_TABLE, "source")

    # 1. users.auth_provider CHECK rollback. Symmetric defensive guard
    #    — on a post-Phase-3 schema the column is gone and the CHECK
    #    cannot be re-created.
    if _has_column(inspector, _USERS_TABLE, "auth_provider"):
        if _has_constraint(bind, _USERS_TABLE, _USERS_CHECK):
            op.drop_constraint(_USERS_CHECK, _USERS_TABLE, type_="check")
        op.create_check_constraint(
            _USERS_CHECK,
            _USERS_TABLE,
            "auth_provider IN ('local', 'saml2', 'oidc')",
        )
