"""Copy every versioned-graph setting saved before the settings store into it.

Until now the values lived in four places, cleared four ways. This copies each one saved there
into ``setting_values`` (``20261116_1000_setting_values``), as the platform's, a workspace's or a
graph's:

* ``platform_settings``: New-version builds' JSON (``gv_build_policy``, with who saved it and
  when), the residency policy's ``gv_*`` columns (with ``gv_policy_updated_by`` / ``_at``) and
  ``gv_draft_retention_days``;
* ``workspaces``: the drafts and reviews policy;
* ``workspace_data_sources``: the drafts and reviews policy and the import settings, for the graph
  of each data source — a fork's are its parent's copies, so forks are skipped;
* ``graphver.projection_state``: a graph's own read mode, and its residency class where it differs
  from the class the platform gives new graphs (``gv_default_residency``, else ``standard``).

What the old storage meant is frozen here, not read from the registry, which a later release may
change: NULL, ``""`` and ``"inherit"`` are "not set" and copy nothing; an old ``0`` for the largest
graph copied is ``"unlimited"``, and for draft retention ``"forever"``; the import shares were
fractions and still are. A value keeps who saved it and when, where the old storage says; else it
was saved by no one known, now. Each copied value is recorded in ``setting_changes``
(``migration``), under one change set.

Idempotent: a value already in the store is left as it is (``ON CONFLICT DO NOTHING``), and the
``settings_imports`` marker ``legacy`` is written once. The graph store may be a database of its
own (``GRAPHVER_DB_URL``), out of this connection's reach: then the graphs' values are left to the
versioning worker, which copies them at start-up (``services.settings.legacy.import_graph_values``)
and marks ``legacy_graph``, as this does when it copies them itself. Reads only, of the old
storage. The downgrade forgets the markers; the values stay, as the store's.

Revision ID: 20261116_1100_settings_import
Revises: 20261116_1000_setting_values
Create Date: 2026-11-16 11:00
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Union

import sqlalchemy as sa
from alembic import op

from backend.app.services.versioning import config as gv_config

revision: str = "20261116_1100_settings_import"
down_revision: Union[str, None] = "20261116_1000_setting_values"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_DOMAIN = "versioned-graphs"
#: The store's writers take this lock, so ``rev`` grows in the order writes commit.
_LOCK = "settings:versioned-graphs"
_MARKER, _GRAPH_MARKER = "legacy", "legacy_graph"
_REASON = "Copied from where it was saved before the settings store"

#: New-version builds (``platform_settings.gv_build_policy`` ``values``), by wire name.
_BUILD_POLICY = {
    "readMode": "reads.mode",
    "buildAboveRows": "builds.aboveRows",
    "buildForRebuilds": "builds.forRebuilds",
    "buildMode": "builds.method",
    "copyMarginPct": "builds.copyRoomPct",
    "copyMaxBytes": "builds.copyMaxBytes",
    "noRoomPolicy": "builds.noRoom",
    "noRoomAlertSecs": "builds.noRoomAlertSecs",
    "buildConcurrency": "builds.perWorker",
    "buildMaxAttempts": "builds.maxAttempts",
    "flipMaxLagRows": "builds.switchMaxLagRows",
    "retireGraceSecs": "updates.retireGraceSecs",
    "statementTargetMs": "updates.statementTargetMs",
    "writeCeilingSecs": "updates.writeCeilingSecs",
    "pacingRatio": "updates.pacingRatio",
    "readPressureRatio": "updates.readPressureRatio",
    "pgStatementTimeoutMs": "database.readTimeoutMs",
    "pgReadsPerGraph": "database.readsPerGraph",
    "pgReadsPerProcess": "database.readsPerProcess",
}
#: The residency policy (``platform_settings``), saved with ``gv_policy_updated_by`` / ``_at``.
_RESIDENCY_POLICY = {
    "gv_eviction_enabled": "residency.autoUnload",
    "gv_default_residency": "residency.class",
    "gv_standard_idle_secs": "residency.standardIdleSecs",
    "gv_coldline_idle_secs": "residency.coldlineIdleSecs",
    "gv_high_water_pct": "residency.unloadStartPct",
    "gv_low_water_pct": "residency.unloadStopPct",
    "gv_load_margin_pct": "residency.loadMarginPct",
    "gv_bytes_per_entity": "residency.bytesPerEntity",
    "gv_coldline_canvas_load_above": "residency.coldlineLoadAbove",
    "gv_capacity_interval_secs": "residency.capacityIntervalSecs",
}
#: Draft retention (``platform_settings``): no who or when of its own — the row's are shared by
#: every platform setting.
_RETENTION = {"gv_draft_retention_days": "drafts.keepClosedDays"}
#: The drafts and reviews policy, on ``workspaces`` and ``workspace_data_sources`` alike.
_DRAFTS = {
    "draft_default_visibility": "drafts.defaultVisibility",
    "draft_levels": "drafts.levels",
    "review_self_approval": "drafts.selfApproval",
    "review_self_merge": "drafts.selfMerge",
}
_DATA_SOURCE = {
    **_DRAFTS,
    "import_identifier": "imports.identifier",
    "import_replace_min_live": "imports.guardMinLive",
    "import_replace_delete_fraction": "imports.guardDeleteShare",
    "import_replace_create_fraction": "imports.guardCreateShare",
    "import_replace_min_match_fraction": "imports.minMatchShare",
}
#: What an old 0 meant.
_ZERO_MEANS = {"builds.copyMaxBytes": "unlimited", "drafts.keepClosedDays": "forever"}
#: What the old storage held for "not set", beside NULL.
_NOT_SET = ("", "inherit")
_CLASSES = ("always", "standard", "coldline")

_INSERT = sa.text("""
WITH src AS (
    SELECT * FROM jsonb_to_recordset(CAST(:rows AS jsonb))
        AS r(key text, scope text, scope_id text, value jsonb, updated_by text,
             updated_at timestamptz)
), ins AS (
    INSERT INTO setting_values (domain, key, scope, scope_id, value, version, updated_at,
                                updated_by)
    SELECT :domain, key, scope, scope_id, value, 1, coalesce(updated_at, now()), updated_by
    FROM src
    ON CONFLICT (domain, key, scope, scope_id) DO NOTHING
    RETURNING domain, key, scope, scope_id, value, version, updated_by, updated_at
)
INSERT INTO setting_changes (change_set, domain, key, scope, scope_id, after_value, version,
                             actor, reason, source, at)
SELECT CAST(:change_set AS uuid), domain, key, scope, scope_id, value, version, updated_by,
       :reason, 'migration', updated_at
FROM ins
RETURNING 1
""")
_MARK = sa.text("INSERT INTO settings_imports (name, detail) "
                "VALUES (:name, CAST(:detail AS jsonb)) ON CONFLICT (name) DO NOTHING")


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock, like the revisions before it."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def _value(key: str, old: Any) -> Any:
    """The store's value for what the old storage held under ``key``; None: nothing set."""
    if old is None or (isinstance(old, str) and old.strip() in _NOT_SET):
        return None
    if key in _ZERO_MEANS and type(old) is int and old == 0:
        return _ZERO_MEANS[key]
    return old


def _when(text: Any) -> Optional[str]:
    """An ISO-8601 time the old storage kept, as UTC; None when it kept none it can be read as."""
    try:
        at = datetime.fromisoformat(str(text))
    except (TypeError, ValueError):
        return None
    return (at if at.tzinfo else at.replace(tzinfo=timezone.utc)).isoformat()


def _row(rows: List[Dict[str, Any]], key: str, scope: str, scope_id: str, old: Any,
         by: Optional[str] = None, at: Any = None) -> None:
    value = _value(key, old)
    if value is not None:
        rows.append({"key": key, "scope": scope, "scope_id": scope_id, "value": value,
                     "updated_by": by, "updated_at": _when(at) if at else None})


def _platform(bind, rows: List[Dict[str, Any]]) -> str:
    """The platform's values; returns the class the platform gives new graphs."""
    columns = [*_RESIDENCY_POLICY, *_RETENTION, "gv_build_policy", "gv_policy_updated_by",
               "gv_policy_updated_at"]
    found = bind.execute(sa.text(
        f"SELECT {', '.join(columns)} FROM platform_settings WHERE id = 1")).mappings().first()
    if found is None:
        return "standard"
    try:
        saved = json.loads(found["gv_build_policy"]) if found["gv_build_policy"] else {}
    except ValueError:
        saved = {}
    saved = saved if isinstance(saved, dict) else {}
    values = saved.get("values") if isinstance(saved.get("values"), dict) else {}
    for wire, key in _BUILD_POLICY.items():
        _row(rows, key, "platform", "", values.get(wire), saved.get("updatedBy"),
             saved.get("updatedAt"))
    for column, key in _RESIDENCY_POLICY.items():
        _row(rows, key, "platform", "", found[column], found["gv_policy_updated_by"],
             found["gv_policy_updated_at"])
    for column, key in _RETENTION.items():
        _row(rows, key, "platform", "", found[column])
    default = found["gv_default_residency"]
    return default if default in _CLASSES else "standard"


def _scoped(bind, rows: List[Dict[str, Any]], table: str, columns: Dict[str, str], scope: str,
            where: str = "") -> None:
    """A workspace's values (``scope`` workspace), or a data source's graph's (graph)."""
    names = ", ".join(columns)
    any_set = " OR ".join(f"{c} IS NOT NULL" for c in columns)
    for found in bind.execute(sa.text(
            f"SELECT id, {names} FROM {table} WHERE ({any_set}){where}")).mappings():
        for column, key in columns.items():
            _row(rows, key, scope, found["id"], found[column])


def _graphver_here(bind) -> bool:
    """Whether the graph store's tables are this connection's: not when ``GRAPHVER_DB_URL`` names
    a database of its own (the same test ``probes.probe_graphver_db`` calls colocated)."""
    url = os.getenv("GRAPHVER_DB_URL")
    if url and url != os.getenv("MANAGEMENT_DB_URL"):
        return False
    inspector = sa.inspect(bind)
    schema = gv_config.graphver_schema()
    return (inspector.has_table("projection_state", schema=schema)
            and inspector.has_table("graphs", schema=schema))


def _graphs(bind, rows: List[Dict[str, Any]], default_class: str) -> None:
    """Each graph's own read mode, and its class where it isn't the platform's; not a fork's."""
    schema = gv_config.graphver_schema()
    for ds, mode, residency in bind.execute(sa.text(
            f'SELECT g.data_source_id, ps.read_mode, ps.residency FROM "{schema}".projection_state '
            f'ps JOIN "{schema}".graphs g ON g.id = ps.graph_id '
            "WHERE g.fork_parent_graph_id IS NULL")):
        _row(rows, "reads.mode", "graph", ds, mode)
        if residency in _CLASSES and residency != default_class:
            _row(rows, "residency.class", "graph", ds, residency)


def upgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()
    bind.execute(sa.text("SELECT pg_advisory_xact_lock(hashtext(:lock))"), {"lock": _LOCK})
    rows: List[Dict[str, Any]] = []
    default_class = _platform(bind, rows)
    _scoped(bind, rows, "workspaces", _DRAFTS, "workspace")
    _scoped(bind, rows, "workspace_data_sources", _DATA_SOURCE, "graph",
            " AND fork_of_data_source_id IS NULL")
    graphs_here = _graphver_here(bind)
    if graphs_here:
        _graphs(bind, rows, default_class)
    inserted = len(bind.execute(_INSERT, {
        "rows": json.dumps(rows), "domain": _DOMAIN, "change_set": str(uuid.uuid4()),
        "reason": _REASON}).all()) if rows else 0
    counts = {scope: sum(1 for r in rows if r["scope"] == scope)
              for scope in ("platform", "workspace", "graph")}
    bind.execute(_MARK, {"name": _MARKER, "detail": json.dumps({
        "values": counts, "inserted": inserted,
        "graphValues": "copied" if graphs_here else "pending"})})
    if graphs_here:
        bind.execute(_MARK, {"name": _GRAPH_MARKER, "detail": json.dumps({"by": "migration"})})


def downgrade() -> None:
    op.get_bind().execute(sa.text("DELETE FROM settings_imports WHERE name IN (:a, :b)"),
                          {"a": _MARKER, "b": _GRAPH_MARKER})
