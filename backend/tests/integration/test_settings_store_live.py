"""The settings store against Postgres and Redis (``services.settings``): an all-or-nothing save
checked against each value's version, its history and its revert, the writers' lock that keeps
``rev`` in commit order, the write-through to the old storage, the legacy diff, and a save reaching
another process's snapshot.

Each module builds a database of its own with the upgrade CLI (``backend.scripts.upgrade``), so
the shared one, and its single ``platform_settings`` row, are never touched. Needs
``GRAPHVER_E2E=1``, ``MANAGEMENT_DB_URL`` (a role that may create databases) and the coordination
bus Redis (``REDIS_URL``, else localhost:6380, as ``versioning-e2e`` starts it). The helpers here
are shared with ``test_settings_import_live.py``.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Iterator, Optional

import pytest
from sqlalchemy import MetaData, Table, create_engine, make_url, text
from sqlalchemy.orm import Session

from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.services.settings import legacy, snapshot as snapshots, store
from backend.app.services.settings.store import Change, SettingsConflict
from backend.tests.test_settings_resolver import REGISTRY, WHYS

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres and Redis")

_BACKEND = Path(__file__).resolve().parents[2]
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6380/0")


# ── Scratch databases (shared with test_settings_import_live) ─────────────────────────────────────
def db_url(name: str, driver: str = "asyncpg") -> str:
    """``MANAGEMENT_DB_URL``'s server, database ``name``."""
    url = make_url(os.environ["MANAGEMENT_DB_URL"]).set(drivername=f"postgresql+{driver}",
                                                       database=name)
    return url.render_as_string(hide_password=False)


@contextlib.contextmanager
def scratch_database(prefix: str) -> Iterator[str]:
    """A new, empty database, dropped afterwards."""
    name = f"{prefix}_{uuid.uuid4().hex[:8]}"
    admin = create_engine(db_url("postgres", "psycopg2"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    try:
        yield name
    finally:
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        admin.dispose()


def _run(args, name: str, graph_store: Optional[str], cwd: Path) -> str:
    env = {**os.environ, "MANAGEMENT_DB_URL": db_url(name)}
    env.pop("GRAPHVER_DB_URL", None)
    if graph_store is not None:
        env["GRAPHVER_DB_URL"] = db_url(graph_store)
    done = subprocess.run([sys.executable, "-m", *args], cwd=cwd, env=env, capture_output=True,
                          text=True, timeout=900)
    assert done.returncode == 0, done.stdout[-3000:] + done.stderr[-3000:]
    return done.stdout + done.stderr


def upgrade_cli(name: str, *args: str, graph_store: Optional[str] = None) -> str:
    """``python -m backend.scripts.upgrade <args>`` against database ``name`` (``graph_store``: a
    separate ``GRAPHVER_DB_URL``)."""
    return _run(["backend.scripts.upgrade", *args], name, graph_store, _BACKEND.parent)


def alembic_stamp(name: str, revision: str) -> None:
    _run(["alembic", "stamp", revision], name, None, _BACKEND)


def graph_store_tables(name: str) -> None:
    """The graph store's ``graphs`` and ``projection_state`` in database ``name``."""
    from backend.app.services.versioning import config as gv_config
    from backend.app.services.versioning.db import VersioningBase
    from backend.app.services.versioning.models import GraphORM, ProjectionStateORM

    engine = create_engine(db_url(name, "psycopg2"))
    with engine.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{gv_config.graphver_schema()}"'))
        VersioningBase.metadata.create_all(conn, tables=[GraphORM.__table__,
                                                         ProjectionStateORM.__table__])
    engine.dispose()


def seed(name: str, *rows: Any) -> None:
    """ORM rows into database ``name``, committed, in the order given.

    A database built at an earlier revision gets only the columns its tables have: a column a
    later revision adds is left out, with its default (``workspaces.kind``, say, which the model
    always sends). Such a row is written against its table as that database has it."""
    engine = create_engine(db_url(name, "psycopg2"))
    tables: dict = {}
    with Session(engine) as session:
        for row in rows:
            model = row.__table__
            if model.key not in tables:
                tables[model.key] = Table(model.name, MetaData(), schema=model.schema,
                                          autoload_with=session.connection())
            table = tables[model.key]
            if all(c.name in table.c for c in model.columns):
                session.add(row)
            else:
                session.execute(table.insert().values(**_present_values(row, table)))
            session.flush()
        session.commit()
    engine.dispose()


def _present_values(row: Any, table: Table) -> dict:
    """``row``'s values for the columns ``table`` has: what is set on it, else its model's Python
    default, as the ORM would have sent it."""
    mapper = row.__mapper__
    values = {}
    for col in row.__table__.columns:
        if col.name not in table.c:
            continue
        value = getattr(row, mapper.get_property_by_column(col).key)
        if value is None and col.default is not None and not col.default.is_sequence:
            value = col.default.arg(None) if col.default.is_callable else col.default.arg
        if value is not None:
            values[col.name] = value
    return values


def query(name: str, sql: str, **params: Any) -> list:
    engine = create_engine(db_url(name, "psycopg2"))
    with engine.connect() as conn:
        found = conn.execute(text(sql), params).all()
    engine.dispose()
    return found


def reset_old_storage(name: str) -> None:
    """Every value the old storage holds, back to unset."""
    engine = create_engine(db_url(name, "psycopg2"))
    drafts = ("draft_default_visibility = NULL, draft_levels = NULL, review_self_approval = NULL, "
              "review_self_merge = NULL")
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM platform_settings"))
        conn.execute(text(f"UPDATE workspaces SET {drafts}"))
        conn.execute(text(f"UPDATE workspace_data_sources SET {drafts}, import_identifier = NULL, "
                          "import_replace_min_live = NULL, import_replace_delete_fraction = NULL, "
                          "import_replace_create_fraction = NULL, "
                          "import_replace_min_match_fraction = NULL"))
        conn.execute(text("UPDATE graphver.projection_state SET read_mode = NULL, "
                          "residency = 'standard'"))
    engine.dispose()


def workspace(ws_id: str, **kw) -> WorkspaceORM:
    return WorkspaceORM(id=ws_id, name=ws_id, **kw)


def provider(provider_id: str = "prov_1") -> ProviderORM:
    return ProviderORM(id=provider_id, name=provider_id, provider_type="falkordb")


def data_source(ds_id: str, ws_id: str, *, fork_of: Optional[str] = None,
                **kw) -> WorkspaceDataSourceORM:
    return WorkspaceDataSourceORM(id=ds_id, workspace_id=ws_id, provider_id="prov_1",
                                  graph_name=None if fork_of else f"g_{ds_id}",
                                  fork_of_data_source_id=fork_of, **kw)


def graph(graph_id: str, ds_id: str, ws_id: str, *, fork_of: Optional[str] = None,
          **state) -> list:
    from backend.app.services.versioning.models import GraphORM, ProjectionStateORM

    return [GraphORM(id=graph_id, data_source_id=ds_id, workspace_id=ws_id, kind="manual",
                     fork_parent_graph_id=fork_of),
            ProjectionStateORM(graph_id=graph_id, **state)]


@pytest.fixture
async def engines_at(monkeypatch):
    """Point the app's management and graph-store engines at scratch databases."""
    from backend.app.db import engine as mgmt
    from backend.app.services.versioning import db as gvdb

    def point(management: str, graph_store: Optional[str] = None) -> None:
        monkeypatch.setattr(mgmt, "DATABASE_URL", db_url(management))
        mgmt._engines.clear()
        mgmt._session_factories.clear()
        monkeypatch.setenv("GRAPHVER_DB_URL", db_url(graph_store or management))
        gvdb._engine = gvdb._session_factory = None
        gvdb._route_engine = gvdb._route_session_factory = None

    yield point
    await mgmt.close_db()
    await gvdb.dispose_engine()


@pytest.fixture
async def redis_bus(monkeypatch):
    """The coordination bus the store moves generations on, a client of this test's loop."""
    import redis.asyncio as aioredis

    client = aioredis.from_url(REDIS_URL, decode_responses=True)
    monkeypatch.setattr(store, "_redis", lambda: client)
    yield client
    await client.aclose()


# ── This module's database ────────────────────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def store_db() -> Iterator[str]:
    with scratch_database("settings_store") as name:
        upgrade_cli(name, "upgrade")
        graph_store_tables(name)
        seed(name, workspace("ws_1"), provider(), data_source("ds_1", "ws_1"),
             data_source("dsfork_1", "ws_1", fork_of="ds_1"),
             *graph("graph_1", "ds_1", "ws_1"))
        yield name


@pytest.fixture
async def db(store_db, engines_at, redis_bus):
    engines_at(store_db)
    return store_db


def _domain() -> str:
    return f"test-{uuid.uuid4().hex[:8]}"


async def _rows(domain: str) -> dict:
    from backend.app.db.engine import get_async_session

    async with get_async_session() as s:
        return {(r.key, r.scope, r.scope_id): r for r in await store.read_domain(s, domain)}


async def _apply(domain: str, *changes: Change, **kw) -> store.ChangeSet:
    from backend.app.db.engine import get_async_session

    kw.setdefault("actor", "usr_a")
    async with get_async_session() as s:
        return await store.apply(s, domain, list(changes), **kw)


# ── Saving ────────────────────────────────────────────────────────────────────────────────────────
async def test_a_save_writes_every_value_together_with_its_history_and_moves_the_generation(
        db, redis_bus):
    domain = _domain()
    saved = await _apply(domain,
                         Change("reads.mode", "platform", "", 0, value="in_place",
                                limits={"allowed": ["latest", "in_place", "beside"]}),
                         Change("drafts.levels", "workspace", "ws_1", 0, value="public_only"),
                         reason="Tighter drafts", source="api")
    rows = await _rows(domain)
    mode = rows[("reads.mode", "platform", "")]
    levels = rows[("drafts.levels", "workspace", "ws_1")]
    assert (mode.value, mode.limits, mode.version, mode.updated_by) == (
        "in_place", {"allowed": ["latest", "in_place", "beside"]}, 1, "usr_a")
    assert (levels.value, levels.limits, levels.version) == ("public_only", None, 1)
    assert mode.rev != levels.rev and mode.updated_at is not None
    assert await redis_bus.get(store.generation_key(domain)) == "1"
    changes = query(db, "SELECT change_set, key, before_value, after_value, after_limits, version, "
                        "actor, reason, source FROM setting_changes WHERE domain = :d ORDER BY id",
                    d=domain)
    assert [(c.key, c.before_value, c.after_value, c.version, c.actor, c.reason, c.source)
            for c in changes] == [
        ("reads.mode", None, "in_place", 1, "usr_a", "Tighter drafts", "api"),
        ("drafts.levels", None, "public_only", 1, "usr_a", "Tighter drafts", "api")]
    assert {c.change_set for c in changes} == {saved.id} and len(saved.applied) == 2

    again = await _apply(domain, Change("reads.mode", "platform", "", 1, value=None))
    after = (await _rows(domain))[("reads.mode", "platform", "")]
    assert (after.value, after.limits, after.version) == (None, {
        "allowed": ["latest", "in_place", "beside"]}, 2)                       # limits kept
    assert after.rev > mode.rev and again.applied[0].before_value == "in_place"
    # The SQL NULL that means "inherit", not a JSON null.
    assert query(db, "SELECT value IS NULL FROM setting_values WHERE domain = :d AND "
                     "key = 'reads.mode'", d=domain)[0][0] is True


async def test_a_value_changed_since_it_was_read_is_a_conflict_and_nothing_is_saved(db,
                                                                                    redis_bus):
    domain = _domain()
    await _apply(domain, Change("reads.mode", "platform", "", 0, value="in_place"))
    with pytest.raises(SettingsConflict) as conflict:
        await _apply(domain, Change("drafts.levels", "workspace", "ws_1", 0, value="any"),
                     Change("reads.mode", "platform", "", 0, value="latest"))
    assert conflict.value.keys == ["reads.mode"]
    assert conflict.value.conflicts == [{"key": "reads.mode", "scope": "platform", "scopeId": "",
                                         "expected": 0, "actual": 1}]
    rows = await _rows(domain)
    assert set(rows) == {("reads.mode", "platform", "")}            # the other change neither
    assert rows[("reads.mode", "platform", "")].value == "in_place"
    assert len(query(db, "SELECT 1 FROM setting_changes WHERE domain = :d", d=domain)) == 1
    assert await redis_bus.get(store.generation_key(domain)) == "1"


async def test_a_change_that_changes_nothing_is_left_out(db, redis_bus):
    domain = _domain()
    await _apply(domain, Change("reads.mode", "platform", "", 0, value="in_place"))
    nothing = await _apply(domain, Change("reads.mode", "platform", "", 1, value="in_place"))
    assert nothing.applied == ()
    assert (await _rows(domain))[("reads.mode", "platform", "")].version == 1
    assert len(query(db, "SELECT 1 FROM setting_changes WHERE domain = :d", d=domain)) == 1
    assert await redis_bus.get(store.generation_key(domain)) == "1"


async def test_writers_take_the_lock_so_rev_follows_commit_order(db, redis_bus):
    """A save that commits later never has the lower rev: a snapshot that read up to one rev never
    misses a row numbered below it."""
    domain = _domain()
    entered, release = asyncio.Event(), asyncio.Event()

    async def hold(_session, _change_set):
        entered.set()
        await release.wait()

    first = asyncio.create_task(_apply(domain, Change("reads.mode", "platform", "", 0,
                                                      value="in_place"), before_commit=hold))
    await entered.wait()
    second = asyncio.create_task(_apply(domain, Change("drafts.levels", "workspace", "ws_1", 0,
                                                       value="any")))
    await asyncio.sleep(0.3)
    assert not second.done()                                   # waiting on the writers' lock
    release.set()
    a, b = await first, await second
    assert b.applied[0].rev > a.applied[0].rev


# ── History and revert ────────────────────────────────────────────────────────────────────────────
async def test_history_filters_by_scope_key_actor_and_time_and_pages(db, redis_bus):
    from backend.app.db.engine import get_async_session

    domain = _domain()
    await _apply(domain, Change("reads.mode", "platform", "", 0, value="in_place"), actor="usr_a")
    await _apply(domain, Change("drafts.levels", "workspace", "ws_1", 0, value="any"),
                 actor="usr_b")
    await _apply(domain, Change("reads.mode", "platform", "", 1, value="beside"), actor="usr_b")
    async with get_async_session() as s:
        everything, more = await store.history(s, domain)
        assert [(e.key, e.after_value) for e in everything] == [
            ("reads.mode", "beside"), ("drafts.levels", "any"), ("reads.mode", "in_place")]
        assert more is None
        page, cursor = await store.history(s, domain, limit=2)
        rest, end = await store.history(s, domain, limit=2, before_id=cursor)
        assert [e.id for e in page + rest] == [e.id for e in everything] and end is None
        by_scope, _ = await store.history(s, domain, scope="workspace", scope_id="ws_1")
        assert [e.key for e in by_scope] == ["drafts.levels"]
        by_key, _ = await store.history(s, domain, key="reads.mode", actor="usr_b")
        assert [e.after_value for e in by_key] == ["beside"]
        newest = everything[0].at
        assert [e.id for e in (await store.history(s, domain, since=newest))[0]] == [
            everything[0].id]
        assert everything[0].id not in [e.id for e in (await store.history(s, domain,
                                                                            until=newest))[0]]


async def test_a_change_set_is_put_back_unless_changed_since(db, redis_bus):
    from backend.app.db.engine import get_async_session

    domain = _domain()
    await _apply(domain, Change("reads.mode", "platform", "", 0, value="in_place",
                                limits={"allowed": ["latest", "in_place"]}))
    saved = await _apply(domain,
                         Change("reads.mode", "platform", "", 1, value="beside",
                                limits={"allowed": ["latest", "in_place", "beside"]}),
                         Change("drafts.levels", "workspace", "ws_1", 0, value="private_only"))
    async with get_async_session() as s:
        undone = await store.revert(s, domain, saved.id, actor="usr_c", reason="Undo")
    rows = await _rows(domain)
    assert (rows[("reads.mode", "platform", "")].value,
            rows[("reads.mode", "platform", "")].limits) == ("in_place", {
                "allowed": ["latest", "in_place"]})
    assert rows[("drafts.levels", "workspace", "ws_1")].value is None
    assert {a.key for a in undone.applied} == {"reads.mode", "drafts.levels"}
    assert {r.source for r in query(db, "SELECT source FROM setting_changes WHERE change_set = "
                                        "CAST(:c AS uuid)", c=str(undone.id))} == {"revert"}
    later = await _apply(domain, Change("reads.mode", "platform", "", 3, value="latest"))
    async with get_async_session() as s:
        with pytest.raises(SettingsConflict) as conflict:
            await store.revert(s, domain, undone.id, actor="usr_c")
        assert conflict.value.keys == ["reads.mode"]
        with pytest.raises(LookupError):
            await store.revert(s, domain, uuid.uuid4(), actor="usr_c")
    assert (await _rows(domain))[("reads.mode", "platform", "")].value == "latest"
    assert later.applied[0].version == 4


# ── The old storage ───────────────────────────────────────────────────────────────────────────────
async def test_a_save_is_written_through_to_the_old_storage(db, redis_bus):
    domain = _domain()
    reset_old_storage(db)

    async def through(session, change_set):
        await legacy.write_through(session, change_set, settings=REGISTRY)

    await _apply(domain,
                 Change("reads.mode", "platform", "", 0, value="in_place"),
                 Change("builds.copyMaxBytes", "platform", "", 0, value="unlimited"),
                 Change("residency.unloadStartPct", "platform", "", 0, value=85),
                 Change("drafts.keepClosedDays", "platform", "", 0, value="forever"),
                 Change("residency.class", "platform", "", 0, value="always"),
                 Change("drafts.levels", "workspace", "ws_1", 0, value="public_only"),
                 Change("drafts.levels", "graph", "ds_1", 0, value="private_only"),
                 Change("imports.identifier", "graph", "ds_1", 0, value="prop.code,urn"),
                 Change("reads.mode", "graph", "ds_1", 0, value="beside"),
                 Change("residency.class", "graph", "ds_1", 0, value="coldline"),
                 Change("reads.maxVersionsBehind", "workspace", "ws_1", 0, value=3),
                 before_commit=through)
    platform = query(db, "SELECT gv_build_policy, gv_high_water_pct, gv_draft_retention_days, "
                         "gv_default_residency FROM platform_settings WHERE id = 1")[0]
    policy = json.loads(platform.gv_build_policy)
    assert policy["values"] == {"readMode": "in_place", "copyMaxBytes": 0}
    assert policy["updatedBy"] == "usr_a" and policy["updatedAt"]
    assert tuple(platform[1:]) == (85, 0, "always")
    assert query(db, "SELECT draft_levels FROM workspaces WHERE id = 'ws_1'")[0][0] == "public_only"
    sources = dict(query(db, "SELECT id, draft_levels || ' ' || import_identifier "
                             "FROM workspace_data_sources ORDER BY id"))
    assert sources == {"ds_1": "private_only prop.code,urn",
                       "dsfork_1": "private_only prop.code,urn"}           # the fork follows
    assert query(db, 'SELECT read_mode, residency FROM graphver.projection_state '
                     "WHERE graph_id = 'graph_1'")[0] == ("beside", "standard")  # class: C6's

    rows = await _rows(domain)
    await _apply(domain, Change("builds.copyMaxBytes", "platform", "", 1, value=None),
                 Change("drafts.levels", "graph", "ds_1", 1, value=None),
                 Change("reads.mode", "graph", "ds_1",
                        rows[("reads.mode", "graph", "ds_1")].version, value=None),
                 before_commit=through)
    assert json.loads(query(db, "SELECT gv_build_policy FROM platform_settings")[0][0])[
        "values"] == {"readMode": "in_place"}
    assert query(db, "SELECT draft_levels FROM workspace_data_sources WHERE id IN "
                     "('ds_1', 'dsfork_1')") == [(None,), (None,)]
    assert query(db, "SELECT read_mode FROM graphver.projection_state")[0][0] is None


async def test_legacy_diff_reports_what_the_old_storage_changed_and_adopts_it(db, redis_bus,
                                                                             monkeypatch):
    domain = _domain()
    reset_old_storage(db)
    monkeypatch.setattr(legacy, "registry",
                        lambda: SimpleNamespace(SETTINGS=REGISTRY, WHY=WHYS, DOMAIN=domain))

    async def through(session, change_set):
        await legacy.write_through(session, change_set, settings=REGISTRY)

    await _apply(domain, Change("reads.mode", "platform", "", 0, value="in_place"),
                 Change("drafts.levels", "workspace", "ws_1", 0, value="public_only"),
                 Change("imports.identifier", "graph", "ds_1", 0, value="urn"),
                 before_commit=through)
    assert await legacy.legacy_diff() == []
    # An old image's endpoints, mid-rollout.
    old_image = create_engine(db_url(db, "psycopg2"))
    with old_image.begin() as conn:
        conn.execute(text("UPDATE workspaces SET draft_levels = 'any' WHERE id = 'ws_1'"))
        conn.execute(text("UPDATE workspace_data_sources SET import_identifier = NULL "
                          "WHERE id IN ('ds_1', 'dsfork_1')"))
        conn.execute(text("UPDATE platform_settings SET gv_high_water_pct = 90"))
        conn.execute(text("UPDATE graphver.projection_state SET read_mode = 'latest'"))
    old_image.dispose()
    diffs = await legacy.legacy_diff()
    assert diffs == [
        {"key": "drafts.levels", "scope": "workspace", "scopeId": "ws_1", "legacy": "any",
         "store": "public_only"},
        {"key": "imports.identifier", "scope": "graph", "scopeId": "ds_1", "legacy": None,
         "store": "urn"},
        {"key": "reads.mode", "scope": "graph", "scopeId": "ds_1", "legacy": "latest",
         "store": None},
        {"key": "residency.unloadStartPct", "scope": "platform", "scopeId": "", "legacy": 90,
         "store": None}]
    assert await legacy.legacy_diff(adopt=True) == diffs
    assert await legacy.legacy_diff() == []
    rows = await _rows(domain)
    assert rows[("drafts.levels", "workspace", "ws_1")].value == "any"
    assert rows[("imports.identifier", "graph", "ds_1")].value is None
    assert rows[("residency.unloadStartPct", "platform", "")].value == 90
    assert {r.source for r in query(db, "SELECT source FROM setting_changes WHERE domain = :d "
                                        "AND actor = 'legacy-diff'", d=domain)} == {"legacy_api"}


# ── Another process ───────────────────────────────────────────────────────────────────────────────
async def test_a_save_reaches_another_processes_snapshot_at_its_next_check(db, redis_bus):
    domain = _domain()
    await _apply(domain, Change("reads.mode", "platform", "", 0, value="in_place"))
    now = [0.0]
    other = snapshots.Snapshot(domain, clock=lambda: now[0])
    first = await other.rows()
    assert first[("reads.mode", "platform", "")].value == "in_place"
    seen = other.rev
    await _apply(domain, Change("reads.mode", "platform", "", 1, value="latest"),
                 Change("drafts.levels", "workspace", "ws_1", 0, value="any"))
    assert (await other.rows())[("reads.mode", "platform", "")].value == "in_place"   # not due
    now[0] += snapshots.GEN_CHECK_S
    rows = await other.rows()
    assert rows[("reads.mode", "platform", "")].value == "latest"
    assert rows[("drafts.levels", "workspace", "ws_1")].value == "any"
    assert other.rev > seen and other.current() is rows


async def test_a_save_stands_when_redis_cant_take_the_generation(db, monkeypatch):
    class _Down:
        async def incr(self, _key):
            raise ConnectionError("Redis is out of reach")

    monkeypatch.setattr(store, "_redis", lambda: _Down())
    domain = _domain()
    saved = await _apply(domain, Change("reads.mode", "platform", "", 0, value="in_place"))
    assert len(saved.applied) == 1
    assert (await _rows(domain))[("reads.mode", "platform", "")].value == "in_place"


async def test_the_facts_read_from_the_graph_store(db):
    from backend.app.services.settings import facts

    engine = create_engine(db_url(db, "psycopg2"))
    with engine.begin() as conn:
        conn.execute(text("UPDATE graphver.projection_state SET size_bytes = 123456789 "
                          "WHERE graph_id = 'graph_1'"))
    engine.dispose()
    assert await facts._graphs() == (123456789, 1)
