"""Read access to every workspace, for service accounts: the ``org_reader`` role.

* ``org_reader`` — a platform role carrying ``system:org-viewer`` alone: it
  reads every workspace and nothing else, where ``org_auditor`` also reads
  the audit log, every role binding and the analytics. It is the one
  platform role a service account's claims keep anything of
  (``SERVICE_ACCOUNT_GLOBAL_PERMISSIONS``), as a fresh install seeds it.

Reference rows only, inserted if missing. Downgrade removes the role's grant,
and the role unless something is still bound to it — which the earlier code
ignores on a service account.

Revision ID: 20261026_1200_sa_org_read
Revises: 20261026_1000_sa_policy
Create Date: 2026-10-26 12:00
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261026_1200_sa_org_read"
down_revision: Union[str, None] = "20261026_1000_sa_policy"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_ROLE = "org_reader"
_ROLE_DESCRIPTION = (
    "Reads every workspace — views, data sources, semantic layers, catalog and providers — and "
    "nothing else: not the audit log, role bindings or analytics. For a service account that "
    "reads across the whole tenancy."
)
_ROLE_PERMISSIONS: list[tuple[str, str]] = [(_ROLE, "system:org-viewer")]


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: claims are resolved from these
    tables on every request, and giving up (to be run again) beats queueing
    them behind a long transaction."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    conn = op.get_bind()
    conn.execute(
        sa.text(
            """
            INSERT INTO roles
            (name, description, scope_type, scope_id, is_system, created_at, updated_at, created_by)
            VALUES (:name, :description, 'global', NULL, TRUE, :now, :now, NULL)
            ON CONFLICT (name) DO NOTHING
            """
        ),
        {"name": _ROLE, "description": _ROLE_DESCRIPTION, "now": datetime.now(timezone.utc).isoformat()},
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
    for role_name, perm_id in _ROLE_PERMISSIONS:
        conn.execute(
            sa.text("DELETE FROM role_permissions WHERE role_name = :role AND permission_id = :perm"),
            {"role": role_name, "perm": perm_id},
        )
    conn.execute(
        sa.text(
            "DELETE FROM roles WHERE name = :name "
            "AND NOT EXISTS (SELECT 1 FROM role_bindings WHERE role_name = :name)"
        ),
        {"name": _ROLE},
    )
