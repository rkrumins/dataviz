"""Copy each workspace's and data source's review rules into the settings store.

Main's 20261118_1100_review_rules put two columns on ``workspaces`` and ``workspace_data_sources``:
``review_required_approvals`` (0 to 10; 0, everyone asked must approve) and
``review_threads_hold``. They are settings now, ``drafts.requiredApprovals`` and
``drafts.threadsHold``, resolved graph → workspace → platform like the rest of the drafts and
reviews policy, and the old columns are written through for one release. This copies in what was
saved in them before, as 20261116_1100_settings_import copied the policy's other fields:

* each value goes in with ``ON CONFLICT DO NOTHING``: one already in the store is left as it is;
* each value copied is recorded in ``setting_changes`` as a ``migration`` change;
* what an old value meant is frozen here, not read from the registry: NULL copies nothing, and an
  old ``0`` approvals is ``"everyone"``;
* forks are skipped: a fork has no values of its own;
* the ``settings_imports`` marker ``legacy_review_rules`` is written once.

It reads the old columns and writes only the store, under the store's writers' lock, and waits at
most five seconds for a lock. The downgrade forgets the marker; the values stay, as the store's.

Revision ID: 20261119_1700_review_rules_store
Revises: 20261119_1600_merge_settings
Create Date: 2026-11-19 17:00:00+00:00

"""
from __future__ import annotations

import json
import uuid
from typing import Any, Dict, List, Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = '20261119_1700_review_rules_store'
down_revision: Union[str, None] = '20261119_1600_merge_settings'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_DOMAIN = "versioned-graphs"
#: The store's writers' lock: no save from a process already on the new image lands mid-copy.
_LOCK = "settings:versioned-graphs"
_MARKER = "legacy_review_rules"
_REASON = "Copied from where it was saved before the settings store"
#: The review rules, on ``workspaces`` and ``workspace_data_sources`` alike.
_COLUMNS = {
    "review_required_approvals": "drafts.requiredApprovals",
    "review_threads_hold": "drafts.threadsHold",
}

_INSERT = sa.text("""
WITH src AS (
    SELECT * FROM jsonb_to_recordset(CAST(:rows AS jsonb))
        AS r(key text, scope text, scope_id text, value jsonb)
), ins AS (
    INSERT INTO setting_values (domain, key, scope, scope_id, value, version, updated_at)
    SELECT :domain, key, scope, scope_id, value, 1, now()
    FROM src
    ON CONFLICT (domain, key, scope, scope_id) DO NOTHING
    RETURNING domain, key, scope, scope_id, value, version, updated_at
)
INSERT INTO setting_changes (change_set, domain, key, scope, scope_id, after_value, version,
                             reason, source, at)
SELECT CAST(:change_set AS uuid), domain, key, scope, scope_id, value, version, :reason,
       'migration', updated_at
FROM ins
RETURNING 1
""")
_MARK = sa.text("INSERT INTO settings_imports (name, detail) "
                "VALUES (:name, CAST(:detail AS jsonb)) ON CONFLICT (name) DO NOTHING")


def _value(key: str, old: Any) -> Any:
    """The store's value for what an old column held; None: nothing set."""
    if old is None:
        return None
    if key == "drafts.requiredApprovals" and type(old) is int and old == 0:
        return "everyone"
    return old


def _scoped(bind, rows: List[Dict[str, Any]], table: str, scope: str, where: str = "") -> None:
    """A workspace's review rules (``scope`` workspace), or a data source's graph's (graph). Only
    the columns the table has: a database the upgrade Job placed below the revision that adds them
    (its schema short of what its stamp claimed) runs this before they are made, and again after."""
    have = {c["name"] for c in sa.inspect(bind).get_columns(table)}
    columns = {column: key for column, key in _COLUMNS.items() if column in have}
    if not columns:
        return
    any_set = " OR ".join(f"{c} IS NOT NULL" for c in columns)
    for found in bind.execute(sa.text(
            f"SELECT id, {', '.join(columns)} FROM {table} WHERE ({any_set}){where}")).mappings():
        for column, key in columns.items():
            value = _value(key, found[column])
            if value is not None:
                rows.append({"key": key, "scope": scope, "scope_id": found["id"], "value": value})


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")
    bind.execute(sa.text("SELECT pg_advisory_xact_lock(hashtext(:lock))"), {"lock": _LOCK})
    rows: List[Dict[str, Any]] = []
    _scoped(bind, rows, "workspaces", "workspace")
    _scoped(bind, rows, "workspace_data_sources", "graph", " AND fork_of_data_source_id IS NULL")
    inserted = len(bind.execute(_INSERT, {
        "rows": json.dumps(rows), "domain": _DOMAIN, "change_set": str(uuid.uuid4()),
        "reason": _REASON}).all()) if rows else 0
    bind.execute(_MARK, {"name": _MARKER, "detail": json.dumps({
        "values": {scope: sum(1 for r in rows if r["scope"] == scope)
                   for scope in ("workspace", "graph")},
        "inserted": inserted})})


def downgrade() -> None:
    op.get_bind().execute(sa.text("DELETE FROM settings_imports WHERE name = :name"),
                          {"name": _MARKER})
