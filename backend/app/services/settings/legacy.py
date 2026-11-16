"""Where each setting's value lived before the settings store, for the release that keeps both.

* :func:`legacy_map` — each old location (New-version builds' JSON wire name, the residency
  policy's wire name, a ``platform_settings`` / ``workspaces`` / ``workspace_data_sources`` /
  ``projection_state`` column) and the setting it holds, from the registry's ``Legacy`` fields.
* :func:`write_through` — a save written to the old storage too, so the previous image, rolled
  back to, behaves as configured. What has no old location (a workspace's read mode, limits, the
  settings that were env-only) is not kept by a rollback. :func:`save` is an old endpoint's save
  through the store, written through.
* :func:`import_graph_values` — the graphs' own values (``projection_state``), copied once at
  start-up by the versioning worker when the import migration could not reach the graph store
  (a separate ``GRAPHVER_DB_URL``): the ``settings_imports`` marker ``legacy_graph``.
* :func:`legacy_diff` — what the old storage holds that the store doesn't (a value changed through
  an old endpoint mid-rollout), and with ``adopt`` taken into the store:
  ``python -m backend.app.services.settings legacy-diff [--adopt]``.

The import migration (``20261116_1100_settings_import``) freezes its own copy of the map: a
migration never reads the registry.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Optional, Sequence

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config.settings_types import Setting
from backend.app.db.models import (PlatformSettingsORM, SettingChangeORM, SettingValueORM,
                                   WorkspaceDataSourceORM, WorkspaceORM)

from . import registry, resolver, store
from .resolver import RowKey

logger = logging.getLogger(__name__)

#: The ``settings_imports`` markers: the import migration's, and the graphs' values'.
MARKER, GRAPH_MARKER = "legacy", "legacy_graph"
#: Each ``Legacy`` field, and the scope of the values it holds.
LOCATIONS = {"build_policy": "platform", "residency_policy": "platform",
             "platform_column": "platform", "workspace_column": "workspace",
             "data_source_column": "graph", "projection_state_column": "graph"}
#: What the old storage held for "not set", beside NULL.
_NOT_SET = ("", "inherit")
_IMPORTED = "Copied from where it was saved before the settings store"
#: Rows per INSERT: a statement may bind at most 32,767 parameters.
_CHUNK = 1000
_ADOPTED = "Taken from where it was saved before the settings store (legacy-diff --adopt)"


def legacy_map(settings: Sequence[Setting]) -> Dict[str, Dict[str, Setting]]:
    """``{Legacy field: {old name: setting}}`` for every setting that had an old location."""
    out: Dict[str, Dict[str, Setting]] = {field: {} for field in LOCATIONS}
    for s in settings:
        for field in LOCATIONS:
            name = getattr(s.legacy, field) if s.legacy is not None else None
            if name:
                out[field][name] = s
    return out


def _value(setting: Setting, old: Any) -> Any:
    """The store's value for what an old location holds; None: nothing set."""
    if old is None or (isinstance(old, str) and old.strip() in _NOT_SET):
        return None
    return resolver.decode(setting, old)


# ── Reading the old storage ───────────────────────────────────────────────────────────────────────
def _build_policy(row: Any) -> Dict[str, Any]:
    """New-version builds' saved JSON (``{"values", "updatedBy", "updatedAt"}``), or {}."""
    try:
        saved = json.loads(row.gv_build_policy) if row is not None and row.gv_build_policy else {}
    except ValueError:
        saved = {}
    return saved if isinstance(saved, dict) else {}


async def read_legacy(session: AsyncSession, settings: Sequence[Setting], *,
                      graphs: bool = True) -> Dict[RowKey, Any]:
    """Every value the old storage holds, as the store would hold it, by ``(key, scope,
    scope_id)``: the platform's, each workspace's, each data source's graph's (not a fork's: its
    values are copies of its parent's), and with ``graphs`` each graph's own from the graph store
    (its class only where it isn't the class the platform gives new graphs)."""
    where = legacy_map(settings)
    out: Dict[RowKey, Any] = {}

    def put(setting: Setting, scope: str, scope_id: str, old: Any) -> None:
        value = _value(setting, old)
        if value is not None:
            out[(setting.key, scope, scope_id)] = value

    platform = await session.get(PlatformSettingsORM, 1)
    saved = (_build_policy(platform).get("values") or {})
    for wire, s in where["build_policy"].items():
        put(s, "platform", "", saved.get(wire) if isinstance(saved, dict) else None)
    for column, s in where["platform_column"].items():
        put(s, "platform", "", getattr(platform, column, None))
    for model, field, scope, extra in (
            (WorkspaceORM, "workspace_column", "workspace", ()),
            (WorkspaceDataSourceORM, "data_source_column", "graph",
             (WorkspaceDataSourceORM.fork_of_data_source_id.is_(None),))):
        columns = where[field]
        if not columns:
            continue
        found = await session.execute(select(model.id, *[getattr(model, c) for c in columns])
                                      .where(*extra))
        for row in found.all():
            for column, s in columns.items():
                put(s, scope, row.id, getattr(row, column))
    if graphs and where["projection_state_column"]:
        for (key, scope, scope_id), value in (await _graph_values(settings, platform)).items():
            out[(key, scope, scope_id)] = value
    return out


async def _graph_values(settings: Sequence[Setting], platform: Any) -> Dict[RowKey, Any]:
    """Each graph's own values in ``projection_state``, by its data source; not a fork's. A
    materialized value (the residency class, which every graph's row holds) only where it differs
    from the platform's old value of it, else the code default."""
    from backend.app.services.versioning import db as gvdb
    from backend.app.services.versioning.models import GraphORM, ProjectionStateORM

    columns = legacy_map(settings)["projection_state_column"]
    out: Dict[RowKey, Any] = {}
    async with gvdb.graphver_session() as s:
        found = await s.execute(
            select(GraphORM.data_source_id, *[getattr(ProjectionStateORM, c) for c in columns])
            .join(ProjectionStateORM, ProjectionStateORM.graph_id == GraphORM.id)
            .where(GraphORM.fork_parent_graph_id.is_(None)))
        rows = found.all()
    for row in rows:
        for column, setting in columns.items():
            value = _value(setting, getattr(row, column))
            if value is None:
                continue
            if setting.materialized:
                column_of = setting.legacy.platform_column
                inherited = (_value(setting, getattr(platform, column_of, None)) if column_of
                             else None)
                if resolver.value_error(setting, inherited) is not None:
                    inherited = setting.default.code
                if value == inherited:
                    continue
            out[(setting.key, "graph", row.data_source_id)] = value
    return out


# ── Writing through ───────────────────────────────────────────────────────────────────────────────
async def write_through(session: AsyncSession, change_set: store.ChangeSet, *,
                        settings: Optional[Sequence[Setting]] = None) -> None:
    """Write a change set's values to the old storage too, in ``session``'s transaction (pass it
    as :func:`~.store.apply`'s ``before_commit``): New-version builds' JSON, the
    ``platform_settings`` columns, a workspace's columns, a data source's (and its forks', which
    follow it); a graph's own read mode goes to the graph store at once. A materialized value (a
    graph's residency class) is the graph store's to keep in step, not this."""
    by_key = {s.key: s for s in (settings or registry().SETTINGS)}
    platform: Any = None
    policy: Optional[Dict[str, Any]] = None
    read_modes: Dict[str, Dict[str, Any]] = {}
    for a in change_set.applied:
        s = by_key.get(a.key)
        old = s.legacy if s is not None else None
        if old is None:
            continue
        value = resolver.encode(s, a.after_value)
        if a.scope == "platform" and (old.build_policy or old.platform_column):
            if platform is None:
                platform = await session.get(PlatformSettingsORM, 1)
                if platform is None:
                    platform = PlatformSettingsORM(id=1)
                    session.add(platform)
            if old.build_policy:
                policy = policy if policy is not None else dict(
                    _build_policy(platform).get("values") or {})
                policy.pop(old.build_policy, None)
                if value is not None:
                    policy[old.build_policy] = value
            if old.platform_column:
                setattr(platform, old.platform_column, value)
        elif a.scope == "workspace" and old.workspace_column:
            await session.execute(update(WorkspaceORM.__table__)
                                  .where(WorkspaceORM.__table__.c.id == a.scope_id)
                                  .values({old.workspace_column: value}))
        elif a.scope == "graph" and old.data_source_column:
            await session.execute(update(WorkspaceDataSourceORM.__table__)
                                  .where(WorkspaceDataSourceORM.__table__.c.id.in_(
                                      _source_and_forks(a.scope_id)))
                                  .values({old.data_source_column: value}))
        elif a.scope == "graph" and old.projection_state_column and not s.materialized:
            read_modes.setdefault(a.scope_id, {})[old.projection_state_column] = value
    if policy is not None:
        platform.gv_build_policy = json.dumps({
            "values": policy, "updatedBy": change_set.actor,
            "updatedAt": datetime.now(timezone.utc).isoformat()}, sort_keys=True)
    await session.flush()
    if read_modes:
        await _write_graphs(read_modes)


async def save(session: AsyncSession, scope: str, scope_id: str, values: Mapping[str, Any], *,
               actor: Optional[str], record: Optional[store.Hook] = None,
               check: Optional[Callable[..., Awaitable[None]]] = None) -> store.ChangeSet:
    """Save ``values`` (by setting key; None inherits) at one scope, as an old endpoint saves them.
    They go through the store (``legacy_api``, with the request's stated reason), each at the
    version it has now, read under the writers' lock so no save comes between. They are written
    through to the old storage, and ``record`` (the old endpoint's activity event) runs in the same
    transaction when one changed. Commits.

    ``check`` (``service.checker`` for who saves) runs first, under the lock: the values are
    checked as the settings API checks them, against the platform's limits and locks among the
    rest, so an old endpoint is no way around them. What it raises is raised, and nothing is
    saved."""
    from backend.app.common import activity_context

    reg = registry()
    await store.lock(session, reg.DOMAIN)
    held = {r.key: r for r in await store.read_scope(session, reg.DOMAIN, scope, scope_id)}
    changes = [store.Change(key, scope, scope_id, held[key].version if key in held else 0,
                            value=value) for key, value in values.items()]
    if check is not None:
        await check(session, scope, scope_id, changes)

    async def before_commit(s: AsyncSession, change_set: store.ChangeSet) -> None:
        await write_through(s, change_set)
        if record is not None and change_set.applied:
            await record(s, change_set)

    return await store.apply(session, reg.DOMAIN, changes, actor=actor,
                             reason=activity_context.current().stated_reason,
                             source="legacy_api", before_commit=before_commit)


def _source_and_forks(ds_id: str):
    """A data source's id and its forks', forks of forks too, as a subquery."""
    wds = WorkspaceDataSourceORM.__table__
    tree = select(wds.c.id).where(wds.c.id == ds_id).cte("tree", recursive=True)
    tree = tree.union_all(select(wds.c.id).where(wds.c.fork_of_data_source_id == tree.c.id))
    return select(tree.c.id)


async def _write_graphs(values: Mapping[str, Mapping[str, Any]]) -> None:
    """Each data source's graph's ``projection_state`` columns, by graph id, so the routes that
    read them hear of it (``route_cache``)."""
    from backend.app.services.versioning import db as gvdb
    from backend.app.services.versioning.models import GraphORM, ProjectionStateORM

    async with gvdb.graphver_session() as s:
        graphs = (await s.execute(select(GraphORM.data_source_id, GraphORM.id).where(
            GraphORM.data_source_id.in_(list(values))))).all()
        for ds_id, graph_id in graphs:
            await s.execute(update(ProjectionStateORM)
                            .where(ProjectionStateORM.graph_id == graph_id)
                            .values(dict(values[ds_id]))
                            .execution_options(synchronize_session=False))


# ── Importing ─────────────────────────────────────────────────────────────────────────────────────
async def _insert(session: AsyncSession, domain: str, values: Mapping[RowKey, Any], *,
                  reason: str) -> int:
    """Each value not yet in the store (``ON CONFLICT DO NOTHING``), with its history row under
    one change set (``migration``); returns how many it wrote."""
    items = list(values.items())
    written: List[Any] = []
    for start in range(0, len(items), _CHUNK):
        stmt = pg_insert(SettingValueORM).values([
            {"domain": domain, "key": key, "scope": scope, "scope_id": scope_id, "value": value,
             "version": 1} for (key, scope, scope_id), value in items[start:start + _CHUNK]])
        written += (await session.execute(stmt.on_conflict_do_nothing().returning(
            SettingValueORM.key, SettingValueORM.scope, SettingValueORM.scope_id,
            SettingValueORM.value))).all()
    if written:
        change_set = uuid.uuid4()
        await session.execute(SettingChangeORM.__table__.insert(), [{
            "change_set": change_set, "domain": domain, "key": w.key, "scope": w.scope,
            "scope_id": w.scope_id, "before_value": None, "after_value": w.value,
            "before_limits": None, "after_limits": None, "version": 1, "actor": None,
            "reason": reason, "source": "migration"} for w in written])
    return len(written)


async def import_graph_values() -> Optional[int]:
    """Copy each graph's own values from the graph store into the settings store, once: when the
    import migration left them (its marker ``legacy`` is there, ``legacy_graph`` isn't). The
    versioning worker calls it at start-up; it is safe from many workers at once. Returns how
    many values it copied, or None when there was nothing to do."""
    from backend.app.db.engine import get_async_session

    reg = registry()
    async with get_async_session() as session:
        done = await store.imports_done(session)
        if MARKER not in done or GRAPH_MARKER in done:
            return None
        platform = await session.get(PlatformSettingsORM, 1)
    values = await _graph_values(reg.SETTINGS, platform)
    async with get_async_session() as session:
        await store.lock(session, reg.DOMAIN)
        if GRAPH_MARKER in await store.imports_done(session):
            return None                     # another worker copied them meanwhile
        copied = await _insert(session, reg.DOMAIN, values, reason=_IMPORTED)
        await store.mark_import(session, GRAPH_MARKER,
                                {"by": "start-up", "values": len(values), "inserted": copied})
    logger.info("settings: copied %d of %d graph values from the graph store", copied, len(values))
    if copied:
        await store.announce(reg.DOMAIN)
    return copied


# ── Comparing ─────────────────────────────────────────────────────────────────────────────────────
async def legacy_diff(*, adopt: bool = False, actor: str = "legacy-diff"
                      ) -> List[Dict[str, Any]]:
    """Each value where the old storage and the store disagree — ``{key, scope, scopeId, legacy,
    store}`` — at every place the old storage could hold one: a value changed through an old
    endpoint while both were in use. With ``adopt``, the old storage's values are saved into the
    store (``legacy_api``), all or none (:class:`~.store.SettingsConflict` if the store moved
    meanwhile). The graphs' own values are compared when the graph store can be read."""
    from backend.app.db.engine import get_async_session

    reg = registry()
    where = legacy_map(reg.SETTINGS)
    held = {field: {s.key for s in found.values()} for field, found in where.items()}
    async with get_async_session() as session:
        try:
            old = await read_legacy(session, reg.SETTINGS)
            graphs = True
        except Exception:  # noqa: BLE001 — the graph store out of reach: compare the rest
            logger.warning("legacy-diff: the graph store could not be read; graphs not compared",
                           exc_info=True)
            old = await read_legacy(session, reg.SETTINGS, graphs=False)
            graphs = False
        rows = resolver.index(await store.read_domain(session, reg.DOMAIN))
        places = set(old)
        for (key, scope, scope_id), row in rows.items():
            if row.value is None:
                continue
            fields = [f for f, s in LOCATIONS.items() if s == scope and key in held[f]
                      and (graphs or f != "projection_state_column")]
            if fields:
                places.add((key, scope, scope_id))
        diffs = []
        for place in sorted(places):
            row = rows.get(place)
            now = row.value if row is not None else None
            if json.dumps(old.get(place), sort_keys=True) != json.dumps(now, sort_keys=True):
                diffs.append({"key": place[0], "scope": place[1], "scopeId": place[2],
                              "legacy": old.get(place), "store": now})
        if adopt and diffs:
            await store.apply(session, reg.DOMAIN, [
                store.Change(d["key"], d["scope"], d["scopeId"],
                             expected_version=rows[(d["key"], d["scope"], d["scopeId"])].version
                             if (d["key"], d["scope"], d["scopeId"]) in rows else 0,
                             value=d["legacy"]) for d in diffs],
                actor=actor, reason=_ADOPTED, source="legacy_api")
    return diffs
