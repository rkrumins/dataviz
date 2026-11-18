"""Write the RBAC reference rows a fresh install needs.

Machinery only — the CONTENT is ``backend.app.config.rbac_seed``. Same
split as ``seed_feature_registry`` / ``config.features_seed``.

Two entry points, both called by ``backend.scripts.upgrade``:

* :func:`seed_reference_data`, on the virgin-database path, where ``create_all`` has just built
  empty tables and the migration chain is deliberately not replayed.
* :func:`reconcile_reference_data`, after every upgrade, so a permission, system role or grant
  added to ``rbac_seed`` reaches databases that already exist. Running the seeder there instead
  would be wrong: an admin can remove a grant from a system role (Admin → Permissions), and
  ``ON CONFLICT DO NOTHING`` would put it back. Reconciling adds each built-in entry once, and
  records it (``reference_data_applied``), so what an admin removes afterwards stays removed.

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


#: Each built-in entry applied to this database, so it is applied once.
APPLIED = "reference_data_applied"


def _entries() -> list[tuple[str, str]]:
    return ([("permission", p["id"]) for p in PERMISSIONS] + [("role", r["name"]) for r in SYSTEM_ROLES]
            + [("grant", f"{r}:{p}") for r, p in ROLE_GRANTS])


def reconcile_reference_data(conn: Connection) -> dict:
    """Add the built-in entries this database hasn't had yet, once; never one an admin removed.

    ``reference_data_applied`` records each entry applied. Entries already recorded are left alone,
    present or not: a grant an admin removed from a system role stays removed. The rest are
    inserted (``ON CONFLICT DO NOTHING``) and recorded. Its first run on a database, which predates
    the record, can't tell a grant that was never made from one an admin removed, so it inserts a
    missing grant only when its role or permission is new in that same run, and reports the rest
    (``notGranted``): Admin → Permissions → Reset to default restores a role's built-in grants.
    A built-in role whose name a custom role already has gets no grants (``skipped``).

    Returns what it did: ``first``, ``added`` (permissions, roles, grants), ``notGranted``,
    ``skipped``.
    """
    conn.execute(text(
        f"CREATE TABLE IF NOT EXISTS {APPLIED} (kind VARCHAR(16) NOT NULL, key TEXT NOT NULL, "
        "applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (kind, key))"))
    applied = {(kind, key) for kind, key in conn.execute(text(f"SELECT kind, key FROM {APPLIED}"))}
    first = not applied
    now = datetime.now(timezone.utc).isoformat()
    report = {"first": first, "added": {"permissions": [], "roles": [], "grants": []},
              "notGranted": [], "skipped": []}

    for perm in PERMISSIONS:
        if ("permission", perm["id"]) not in applied and conn.execute(text(
                "INSERT INTO permissions (id, description, category, long_description, examples) "
                "VALUES (:id, :description, :category, :long_description, :examples) "
                "ON CONFLICT (id) DO NOTHING"), perm).rowcount:
            report["added"]["permissions"].append(perm["id"])
    for role in SYSTEM_ROLES:
        if ("role", role["name"]) not in applied and conn.execute(text(
                "INSERT INTO roles (name, description, scope_type, scope_id, is_system, created_at, "
                "updated_at, created_by) VALUES (:name, :description, :scope_type, NULL, TRUE, :now, "
                ":now, NULL) ON CONFLICT (name) DO NOTHING"), {**role, "now": now}).rowcount:
            report["added"]["roles"].append(role["name"])

    builtin = {r["name"] for r in SYSTEM_ROLES}
    custom = {name for name, is_system in conn.execute(text("SELECT name, is_system FROM roles"))
              if name in builtin and not is_system}
    granted = {(r, p) for r, p in conn.execute(text("SELECT role_name, permission_id FROM role_permissions"))}
    new_here = set(report["added"]["permissions"]) | set(report["added"]["roles"])
    for role_name, permission_id in ROLE_GRANTS:
        key = f"{role_name}:{permission_id}"
        if ("grant", key) in applied:
            continue
        if role_name in custom:
            report["skipped"].append(key)
            continue
        if (role_name, permission_id) in granted:
            continue
        if first and role_name not in new_here and permission_id not in new_here:
            report["notGranted"].append(key)
            continue
        if conn.execute(text(
                "INSERT INTO role_permissions (role_name, permission_id) VALUES (:r, :p) "
                "ON CONFLICT (role_name, permission_id) DO NOTHING"), {"r": role_name, "p": permission_id}).rowcount:
            report["added"]["grants"].append(key)

    skipped = {("grant", key) for key in report["skipped"]}
    new = [{"kind": kind, "key": key} for kind, key in _entries()
           if (kind, key) not in applied and (kind, key) not in skipped]
    if new:
        conn.execute(text(f"INSERT INTO {APPLIED} (kind, key) VALUES (:kind, :key) ON CONFLICT DO NOTHING"), new)
    if any(report["added"].values()):
        logger.info("Built-in reference data added: %s", report["added"])
    if report["notGranted"]:
        logger.warning("Built-in grants this database doesn't have, left as they are (an admin may have "
                       "removed them; Admin → Permissions → Reset to default restores a role's): %s",
                       report["notGranted"])
    if report["skipped"]:
        logger.warning("Built-in roles whose name a custom role has, given none of their grants: %s",
                       sorted({key.split(":")[0] for key in report["skipped"]}))
    return report
