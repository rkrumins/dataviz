"""Service accounts: principals that never sign in, and who answers for them.

* ``service_accounts`` — one row per service account, keyed by its ``users``
  row (whose id starts ``svc_``): what it is for, who made it, and since when
  it has had no manager in good standing (``unmanaged_since``, kept by the
  routes that change its managers and by the hourly sweep), with the reminder
  sent before its keys pause.
* ``service_account_managers`` — the people, or teams, who answer for each
  account and may make its keys: exactly one of ``user_id`` or ``group_id``.
* ``system:service-accounts:manage`` — creating them, choosing their managers
  and granting their workspace roles; granted to ``super_admin`` and
  ``org_admin``, as a fresh install seeds it.

Creating a foreign key to ``users`` and ``groups`` locks both, and ``users`` is
read on every request, so the revision bounds its wait for locks. Guarded DDL:
two empty tables and their indexes. Downgrade drops what this adds; service
accounts' ``users`` rows stay, and read as accounts that cannot sign in, with
their keys paused.

Revision ID: 20261023_1200_service_accounts
Revises: 20261019_1600_access_life
Create Date: 2026-10-23 12:00
"""
from __future__ import annotations

import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261023_1200_service_accounts"
down_revision: Union[str, None] = "20261019_1600_access_life"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_PERMISSION = "system:service-accounts:manage"
_DESCRIPTION = "Create service accounts, choose who manages them, and grant them workspace roles."
_LONG_DESCRIPTION = (
    "Service accounts are principals that never sign in: an integration acts as one through "
    "API keys its managers make. This lets you create, rename, disable and enable them, appoint "
    "and remove their managers — people or teams — hand a leaver's accounts over to a successor, "
    "and give them workspace roles, never one that administers a workspace or lets people in. "
    "Deliberately SEPARATE from system:users:manage, so integrations can be looked after without "
    "administering people."
)
_EXAMPLES = [
    "Create a service account for a scheduled job and make its team its manager.",
    "Hand someone's service accounts over to a colleague before they leave.",
]
_ROLE_PERMISSIONS: list[tuple[str, str]] = [
    ("org_admin", _PERMISSION),
    ("super_admin", _PERMISSION),
]


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: ``users`` is read on every
    request, and giving up (to be run again) beats queueing them behind a
    long transaction."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    conn = op.get_bind()

    op.create_table(
        "service_accounts",
        sa.Column(
            "user_id", sa.Text(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True,
        ),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Text(), nullable=True),
        sa.Column("unmanaged_since", sa.Text(), nullable=True),
        sa.Column("pause_reminded_at", sa.Text(), nullable=True),
        if_not_exists=True,
    )
    op.create_table(
        "service_account_managers",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "service_account_id", sa.Text(),
            sa.ForeignKey("service_accounts.user_id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("user_id", sa.Text(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("group_id", sa.Text(), sa.ForeignKey("groups.id", ondelete="CASCADE"), nullable=True),
        sa.Column("added_by", sa.Text(), nullable=True),
        sa.Column("added_at", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "(user_id IS NULL) <> (group_id IS NULL)", name="ck_service_account_managers_subject",
        ),
        sa.UniqueConstraint(
            "service_account_id", "user_id", name="uq_service_account_managers_user",
        ),
        sa.UniqueConstraint(
            "service_account_id", "group_id", name="uq_service_account_managers_group",
        ),
        if_not_exists=True,
    )
    op.create_index(
        "idx_service_account_managers_user", "service_account_managers", ["user_id"],
        if_not_exists=True,
    )
    op.create_index(
        "idx_service_account_managers_group", "service_account_managers", ["group_id"],
        if_not_exists=True,
    )

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
            "description": _DESCRIPTION,
            "category": "system",
            "long_description": _LONG_DESCRIPTION,
            "examples": json.dumps(_EXAMPLES),
        },
    )
    for role_name, perm_id in _ROLE_PERMISSIONS:
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


def downgrade() -> None:
    _bound_lock_wait()
    conn = op.get_bind()

    conn.execute(
        sa.text("DELETE FROM role_permissions WHERE permission_id = :id"), {"id": _PERMISSION},
    )
    conn.execute(sa.text("DELETE FROM permissions WHERE id = :id"), {"id": _PERMISSION})
    op.drop_index(
        "idx_service_account_managers_group", table_name="service_account_managers", if_exists=True,
    )
    op.drop_index(
        "idx_service_account_managers_user", table_name="service_account_managers", if_exists=True,
    )
    op.drop_table("service_account_managers", if_exists=True)
    op.drop_table("service_accounts", if_exists=True)
