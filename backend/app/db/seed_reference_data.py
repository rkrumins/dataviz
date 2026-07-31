"""Write the RBAC reference rows a fresh install needs.

Machinery only — the CONTENT is ``backend.app.config.rbac_seed``. Same
split as ``seed_feature_registry`` / ``config.features_seed``.

Called by ``backend.scripts.upgrade`` on the virgin-database path, where
``create_all`` has just built empty tables and the migration chain — which
is where these rows have always come from — is deliberately not replayed.
Nothing else calls it: databases that predate the fast path already hold
these rows from the migrations, and the ``ON CONFLICT DO NOTHING`` here
means running it against one anyway is a no-op rather than a reset.

Sync, not async, because it runs inside the upgrade Job alongside Alembic
rather than in the app. It takes a live ``Connection`` so it joins the
caller's transaction and the advisory lock already held around it.

The conflict targets match the migrations this replaces exactly —
``permissions(id)``, ``roles(name)``, ``role_permissions(role_name,
permission_id)`` — so an operator's own roles and any hand-granted
permission survive untouched.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.engine import Connection

from backend.app.config.rbac_seed import PERMISSIONS, ROLE_GRANTS, SYSTEM_ROLES

logger = logging.getLogger(__name__)


def seed_reference_data(conn: Connection) -> dict[str, int]:
    """Insert permissions, system roles and grants. Returns rows written.

    Idempotent. The returned counts are rows actually inserted, so a
    second call reports zeros — which is what the caller logs, and what
    makes "did the seed run?" answerable from the Job output.
    """
    now = datetime.now(timezone.utc).isoformat()
    written = {"permissions": 0, "roles": 0, "role_permissions": 0}

    for perm in PERMISSIONS:
        result = conn.execute(
            text(
                "INSERT INTO permissions "
                "(id, description, category, long_description, examples) "
                "VALUES (:id, :description, :category, :long_description, :examples) "
                "ON CONFLICT (id) DO NOTHING"
            ),
            perm,
        )
        written["permissions"] += result.rowcount

    for role in SYSTEM_ROLES:
        result = conn.execute(
            text(
                "INSERT INTO roles "
                "(name, description, scope_type, scope_id, is_system, "
                " created_at, updated_at, created_by) "
                "VALUES (:name, :description, :scope_type, NULL, TRUE, "
                "        :now, :now, NULL) "
                "ON CONFLICT (name) DO NOTHING"
            ),
            {**role, "now": now},
        )
        written["roles"] += result.rowcount

    for role_name, permission_id in ROLE_GRANTS:
        result = conn.execute(
            text(
                "INSERT INTO role_permissions (role_name, permission_id) "
                "VALUES (:role_name, :permission_id) "
                "ON CONFLICT (role_name, permission_id) DO NOTHING"
            ),
            {"role_name": role_name, "permission_id": permission_id},
        )
        written["role_permissions"] += result.rowcount

    logger.info("Reference data seeded: %s", written)
    return written
