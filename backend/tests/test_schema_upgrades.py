"""``ck_jobs_type`` allows every job type the code writes, on every kind of graphver store — and
the graphver tables and indexes added since (``bootstrap_nodes``; the import_rows index swap) reach
every store too.

``20260928_1000_jobs_publish`` rebuilt the check from a list that forgot ``purge``, dropping it on
every database without a purge row; a store built from the models never had it either — so deleting
a data source permanently failed at the INSERT. Migration ``20261008_1000_jobs_check_widen`` widens
it back (and adds ``package_inspect``), and ``create_schema_and_partitions`` applies the same widening
on every worker start, because a separate ``GRAPHVER_DB_URL`` is a database alembic never reaches.
Widen-only: a type some row already holds is never dropped, in either direction.

The ORM/migration agreement is checked without a database; the rest needs Postgres
(``GRAPHVER_E2E=1``) and rewrites the check of the ``MANAGEMENT_DB_URL`` database's graphver.jobs.
"""
from __future__ import annotations

import asyncio
import contextlib
import importlib.util
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.job_lease import QUEUED
from backend.app.services.versioning.models import JOB_TYPES, JobORM

_VERSIONS = Path(__file__).resolve().parents[1] / "alembic" / "versions"
_MIGRATION = _VERSIONS / "20261008_1000_jobs_check_widen.py"


def _migration(path=_MIGRATION):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_models_and_the_migration_require_the_same_types():
    check = next(c for c in JobORM.__table__.constraints if getattr(c, "name", "") == "ck_jobs_type")
    for job_type in JOB_TYPES:
        assert f"'{job_type}'" in str(check.sqltext)
    assert {"purge", "package_inspect"} <= set(JOB_TYPES)
    migration = _migration()
    assert set(migration._REQUIRED) == set(JOB_TYPES)
    assert migration.down_revision == "20260930_1000_outbox_type_time"


def test_the_preflight_table_and_the_import_rows_indexes_follow_on():
    """``bootstrap_nodes`` (20261008_1100) and the import_rows index swap (20261008_1200) follow the
    widen, and the models declare what they create."""
    nodes = _migration(_VERSIONS / "20261008_1100_bootstrap_nodes.py")
    rows = _migration(_VERSIONS / "20261008_1200_import_rows_idx.py")
    assert nodes.down_revision == "20261008_1000_jobs_check_widen"
    assert rows.down_revision == nodes.revision == "20261008_1100_bootstrap_nodes"
    table = models.BootstrapNodeORM.__table__
    assert [c.name for c in table.primary_key.columns] == ["graph_id", "falkor_id"]
    assert table.c.last_synced_at.type.timezone, "ranked chronologically, so TIMESTAMPTZ"
    dupes = next(i for i in table.indexes if i.name == "ix_bootstrap_nodes_dupes")
    assert "copy_rank IS NOT NULL" in str(dupes.dialect_options["postgresql"]["where"])
    assert {i.name for i in models.ImportRowORM.__table__.indexes} == {
        "ix_import_rows_kind_row", "ix_import_rows_matched"}


e2e = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")
_JOBS = f'"{models._SCHEMA}"."jobs"'
_PUBLISH_ERA = "'ingest','projection','rebuild','export','bootstrap','publish'"


@pytest.fixture
async def store():
    db._engine = None
    db._session_factory = None
    await models.create_schema_and_partitions()
    yield db.get_engine()
    async with db.get_engine().begin() as conn:            # leave it as the code needs it
        await conn.run_sync(models._ensure_schema_upgrades)
    await db.dispose_engine()


@contextlib.asynccontextmanager
async def _scratch(engine):
    """A transaction that is rolled back, on a jobs table holding no row of the types under test —
    so only the REQUIRED list, never a row that happens to be there, can make the check allow them."""
    async with engine.connect() as conn:
        trans = await conn.begin()
        try:
            await conn.execute(text(
                f"DELETE FROM {_JOBS} WHERE job_type IN ('purge', 'package_inspect')"))
            yield conn
        finally:
            await trans.rollback()


async def _set_check(conn, values: str) -> None:
    await conn.execute(text(f"ALTER TABLE {_JOBS} DROP CONSTRAINT IF EXISTS ck_jobs_type"))
    await conn.execute(text(f"ALTER TABLE {_JOBS} ADD CONSTRAINT ck_jobs_type "
                            f"CHECK (job_type IN ({values})) NOT VALID"))


async def _check(conn):
    return (await conn.execute(text(
        "SELECT oid, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_jobs_type' "
        f"AND conrelid = CAST('{_JOBS}' AS regclass)"))).one()


async def _insert(conn, job_type: str) -> None:
    await conn.execute(text(
        f"INSERT INTO {_JOBS} (id, job_type, graph_id, status, progress, total, processed, "
        "batch_size, retry_count, max_retries, last_sequence, auto_publish, created_at) "
        "VALUES (:id, :t, 'g_schema', 'cancelled', 0, 0, 0, 1, 0, 0, 0, false, '2026-10-08')"),
        {"id": f"vjob_schema_{job_type}_{os.urandom(3).hex()}", "t": job_type})


@e2e
async def test_a_store_alembic_never_reached_is_widened_on_start(store):
    async with _scratch(store) as conn:
        await _set_check(conn, _PUBLISH_ERA)               # what 20260928 left without purge rows
        await conn.run_sync(models._ensure_schema_upgrades)
        _oid, definition = await _check(conn)
        for job_type in JOB_TYPES:
            assert f"'{job_type}'" in definition
        await _insert(conn, "purge")
        await _insert(conn, "package_inspect")


@e2e
async def test_a_wide_enough_check_is_left_alone_and_a_present_type_is_kept(store):
    async with store.begin() as conn:
        await conn.execute(text(f"ALTER TABLE {_JOBS} DROP CONSTRAINT IF EXISTS ck_jobs_type"))
        await _insert(conn, "legacy_kind")                 # some other producer's type
        await conn.run_sync(models.widen_job_type_check, JOB_TYPES)
        oid, definition = await _check(conn)
        assert "'legacy_kind'" in definition, "a type a row holds is never dropped"
        await conn.run_sync(models.widen_job_type_check, JOB_TYPES)
        assert (await _check(conn))[0] == oid, "already wide enough: not rebuilt"
        await conn.execute(text(f"DELETE FROM {_JOBS} WHERE job_type = 'legacy_kind'"))
        await conn.execute(text(f"ALTER TABLE {_JOBS} DROP CONSTRAINT ck_jobs_type"))


@e2e
async def test_the_migration_widens_up_and_never_narrows_down(store):
    migration = _migration()
    async with _scratch(store) as conn:
        await _set_check(conn, _PUBLISH_ERA)

        def upgrade(sync_conn):
            migration.op = SimpleNamespace(get_bind=lambda: sync_conn)
            migration.upgrade()

        def downgrade(sync_conn):
            migration.op = SimpleNamespace(get_bind=lambda: sync_conn)
            migration.downgrade()

        await conn.run_sync(upgrade)
        await _insert(conn, "purge")
        await conn.run_sync(downgrade)
        _oid, definition = await _check(conn)
        assert "'purge'" in definition and "'package_inspect'" in definition


@e2e
async def test_lane_pods_starting_together_all_bring_the_schema_up(store):
    async with store.begin() as conn:
        await _set_check(conn, _PUBLISH_ERA)
    await asyncio.gather(*[models.create_schema_and_partitions() for _ in range(4)])
    async with store.begin() as conn:
        _oid, definition = await _check(conn)
        assert "'purge'" in definition and "'package_inspect'" in definition


async def _indexes(conn, table: str) -> set:
    return {r[0] for r in (await conn.execute(text(
        "SELECT indexname FROM pg_indexes WHERE schemaname = :s AND tablename = :t"),
        {"s": models._SCHEMA, "t": table})).all()}


@e2e
async def test_a_store_alembic_never_reached_gets_the_import_rows_indexes(store):
    rows = f'"{models._SCHEMA}"."import_rows"'
    async with store.connect() as conn:
        trans = await conn.begin()
        try:
            await conn.execute(text(f'DROP INDEX IF EXISTS "{models._SCHEMA}".ix_import_rows_kind_row'))
            await conn.execute(text(f"CREATE INDEX ix_import_rows_match ON {rows} "
                                    "(job_id, kind, match_key)"))
            await conn.execute(text(f"CREATE INDEX ix_import_rows_status ON {rows} (job_id, status)"))
            await conn.run_sync(models._ensure_schema_upgrades)
            got = await _indexes(conn, "import_rows")
            assert "ix_import_rows_kind_row" in got
            assert not {"ix_import_rows_match", "ix_import_rows_status"} & got
            await conn.run_sync(models._ensure_schema_upgrades)        # and again: a no-op
        finally:
            await trans.rollback()


@e2e
async def test_the_preflight_and_index_migrations_round_trip(store):
    nodes = _migration(_VERSIONS / "20261008_1100_bootstrap_nodes.py")
    rows = _migration(_VERSIONS / "20261008_1200_import_rows_idx.py")

    def run(module, step):
        def apply(sync_conn):
            module.op = SimpleNamespace(get_bind=lambda: sync_conn)
            getattr(module, step)()
        return apply

    async with store.connect() as conn:
        trans = await conn.begin()
        try:
            await conn.run_sync(run(rows, "downgrade"))
            await conn.run_sync(run(nodes, "downgrade"))
            assert "ix_import_rows_status" in await _indexes(conn, "import_rows")
            assert not await _indexes(conn, "bootstrap_nodes")
            await conn.run_sync(run(nodes, "upgrade"))
            await conn.run_sync(run(rows, "upgrade"))
            assert await _indexes(conn, "bootstrap_nodes") == {
                "pk_bootstrap_nodes", "ix_bootstrap_nodes_urn", "ix_bootstrap_nodes_dupes"}
            assert "ix_import_rows_kind_row" in await _indexes(conn, "import_rows")
            await conn.run_sync(run(nodes, "upgrade"))                  # idempotent
            await conn.run_sync(run(rows, "upgrade"))
        finally:
            await trans.rollback()


# ── uq_ps_key: one versioned graph per FalkorDB graph (20261017_1500_gv_ps_keys) ──────────────
_PS_KEYS = _VERSIONS / "20261017_1500_gv_ps_keys.py"


def test_one_versioned_graph_per_falkordb_key_is_declared_and_migrated():
    index = next(i for i in models.ProjectionStateORM.__table__.indexes if i.name == "uq_ps_key")
    assert index.unique
    assert "falkor_graph_name IS NOT NULL" in str(index.dialect_options["postgresql"]["where"])
    keys = _migration(_PS_KEYS)
    assert keys.revision == _PS_KEYS.stem


async def _pin(conn, name: str, *, deleted: bool = False, owns: bool = False) -> str:
    from sqlalchemy import insert
    gid = (await conn.execute(insert(models.GraphORM).values(
        data_source_id="ds_keys_" + os.urandom(3).hex(), workspace_id="ws_keys", kind="manual",
        deleted_at=models._now() if deleted else None).returning(models.GraphORM.id))).scalar_one()
    await conn.execute(insert(models.ProjectionStateORM).values(
        graph_id=gid, falkor_graph_name=name, owns_falkor_graph=owns))
    return gid


async def _pin_of(conn, gid: str):
    return (await conn.execute(text(
        f'SELECT falkor_graph_name FROM "{models._SCHEMA}".projection_state WHERE graph_id = :g'),
        {"g": gid})).scalar_one()


@contextlib.asynccontextmanager
async def _without_ps_key(engine):
    async with engine.connect() as conn:
        trans = await conn.begin()
        try:
            await conn.execute(text(f'DROP INDEX IF EXISTS "{models._SCHEMA}".uq_ps_key'))
            yield conn
        finally:
            await trans.rollback()


@e2e
async def test_a_store_alembic_never_reached_gets_uq_ps_key(store):
    async with _without_ps_key(store) as conn:
        key = "gvt_keys_" + os.urandom(3).hex()
        live = await _pin(conn, key)
        stale = await _pin(conn, key, deleted=True)          # a tombstoned graph not owning the key
        await conn.run_sync(models._ensure_schema_upgrades)
        assert "uq_ps_key" in await _indexes(conn, "projection_state")
        assert await _pin_of(conn, stale) is None and await _pin_of(conn, live) == key
        await conn.run_sync(models._ensure_schema_upgrades)        # and again: a no-op


@e2e
async def test_live_duplicates_never_stop_a_worker_but_stop_the_migration(store, caplog):
    async with _without_ps_key(store) as conn:
        key = "gvt_keys_" + os.urandom(3).hex()
        first, second = await _pin(conn, key), await _pin(conn, key)
        await conn.run_sync(models._ensure_schema_upgrades)        # logs, never raises
        assert "uq_ps_key" not in await _indexes(conn, "projection_state")
        assert first in caplog.text and second in caplog.text

        migration = _migration(_PS_KEYS)

        def upgrade(sync_conn):
            migration.op = SimpleNamespace(get_bind=lambda: sync_conn,
                                           execute=lambda sql: sync_conn.execute(text(sql)))
            migration.upgrade()

        with pytest.raises(RuntimeError, match=first):
            await conn.run_sync(upgrade)


@e2e
async def test_the_ps_key_migration_round_trips(store):
    migration = _migration(_PS_KEYS)

    def run(step):
        def apply(sync_conn):
            migration.op = SimpleNamespace(get_bind=lambda: sync_conn,
                                           execute=lambda sql: sync_conn.execute(text(sql)))
            getattr(migration, step)()
        return apply

    async with store.connect() as conn:
        trans = await conn.begin()
        try:
            await conn.run_sync(run("downgrade"))
            assert "uq_ps_key" not in await _indexes(conn, "projection_state")
            await conn.run_sync(run("upgrade"))
            assert "uq_ps_key" in await _indexes(conn, "projection_state")
            await conn.run_sync(run("upgrade"))                     # idempotent
        finally:
            await trans.rollback()


# ── projection fencing (20261017_1550_gv_ps_fencing) ──────────────────────────────────────────
_PS_FENCING = _VERSIONS / "20261017_1550_gv_ps_fencing.py"
_FENCING_COLUMNS = {"epoch", "failed_attempts", "next_retry_at"}


def test_the_fencing_columns_are_declared_and_migrated():
    """A store ``create_all`` builds must equal the migrated one: the NOT NULL columns carry their
    default on the server too."""
    table = models.ProjectionStateORM.__table__
    for name in ("epoch", "failed_attempts"):
        assert not table.c[name].nullable and str(table.c[name].server_default.arg) == "0", name
    assert table.c.next_retry_at.nullable
    fencing = _migration(_PS_FENCING)
    assert fencing.revision == _PS_FENCING.stem
    assert fencing.down_revision == "20261017_1500_gv_ps_keys"


async def _ps_columns(conn) -> set:
    return {r[0] for r in (await conn.execute(text(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema = :s AND table_name = 'projection_state'"),
        {"s": models._SCHEMA})).all()}


@e2e
async def test_a_store_alembic_never_reached_gets_the_fencing_columns(store):
    async with store.connect() as conn:
        trans = await conn.begin()
        try:
            for column in sorted(_FENCING_COLUMNS):
                await conn.execute(text(
                    f'ALTER TABLE "{models._SCHEMA}".projection_state DROP COLUMN {column}'))
            await conn.run_sync(models._ensure_schema_upgrades)
            assert _FENCING_COLUMNS <= await _ps_columns(conn)
            await conn.run_sync(models._ensure_schema_upgrades)        # and again: a no-op
        finally:
            await trans.rollback()


@e2e
async def test_the_fencing_migration_round_trips(store):
    migration = _migration(_PS_FENCING)

    def run(step):
        def apply(sync_conn):
            migration.op = SimpleNamespace(get_bind=lambda: sync_conn,
                                           execute=lambda sql: sync_conn.execute(text(sql)))
            getattr(migration, step)()
        return apply

    async with store.connect() as conn:
        trans = await conn.begin()
        try:
            await conn.run_sync(run("downgrade"))
            assert not _FENCING_COLUMNS & await _ps_columns(conn)
            await conn.run_sync(run("upgrade"))
            assert _FENCING_COLUMNS <= await _ps_columns(conn)
            await conn.run_sync(run("upgrade"))                     # idempotent
        finally:
            await trans.rollback()


# ── uq_commits_idem: one commit per idempotency key on a branch (20261017_1900_gv_commits_idem) ──
_COMMITS_IDEM = _VERSIONS / "20261017_1900_gv_commits_idem.py"


def test_the_commit_key_index_is_migrated():
    assert _migration(_COMMITS_IDEM).revision == _COMMITS_IDEM.stem


async def _commit(conn, gid: str, branch: str, seq: int, key: str) -> str:
    cid = f"cmt_idem_{os.urandom(4).hex()}"
    await conn.execute(text(
        f'INSERT INTO "{models._SCHEMA}".commits (graph_id, id, branch_id, commit_seq, kind, '
        "created_at, idempotency_key) VALUES (:g, :id, :b, :seq, 'edit', '2026-10-17', :k)"),
        {"g": gid, "id": cid, "b": branch, "seq": seq, "k": key})
    return cid


async def _key_of(conn, gid: str, cid: str):
    return (await conn.execute(text(
        f'SELECT idempotency_key FROM "{models._SCHEMA}".commits WHERE graph_id = :g AND id = :id'),
        {"g": gid, "id": cid})).scalar_one()


@contextlib.asynccontextmanager
async def _without_commits_idem(engine):
    async with engine.connect() as conn:
        trans = await conn.begin()
        try:
            await conn.execute(text(f'DROP INDEX IF EXISTS "{models._SCHEMA}".uq_commits_idem'))
            yield conn
        finally:
            await trans.rollback()


@e2e
async def test_a_store_alembic_never_reached_gets_uq_commits_idem(store):
    async with _without_commits_idem(store) as conn:
        gid = "g_idem_" + os.urandom(3).hex()
        first = await _commit(conn, gid, "br_a", 1, "changes:u:k")
        repeat = await _commit(conn, gid, "br_a", 2, "changes:u:k")   # raced in before the index
        other = await _commit(conn, gid, "br_b", 1, "changes:u:k")    # another branch: its own
        await conn.run_sync(models._ensure_schema_upgrades)
        assert "uq_commits_idem" in await _indexes(conn, "commits")
        assert await _key_of(conn, gid, first) == "changes:u:k"
        assert await _key_of(conn, gid, repeat) is None
        assert await _key_of(conn, gid, other) == "changes:u:k"
        await conn.run_sync(models._ensure_schema_upgrades)        # and again: a no-op


@e2e
async def test_a_commit_key_index_that_cannot_be_built_never_stops_a_worker(store, monkeypatch):
    def refuse(conn):
        raise RuntimeError("lock timeout")

    monkeypatch.setattr(models, "ensure_commits_idem_index", refuse)
    async with _without_commits_idem(store) as conn:
        await conn.run_sync(models._ensure_schema_upgrades)        # logs, never raises
        assert (await conn.execute(text("SELECT 1"))).scalar() == 1


@e2e
async def test_a_busy_table_never_stalls_a_worker_start(store):
    """A save or a job's heartbeat holding ``commits`` or ``jobs`` open: each index build waits at
    most five seconds for its table, then is left for the next start, rather than queue every
    later write on the table behind it. The statement timeout stands in for a wait that has no
    end of its own."""
    async with store.begin() as conn:
        await conn.execute(text(f'DROP INDEX IF EXISTS "{models._SCHEMA}".uq_commits_idem'))
        await conn.execute(text(f'DROP INDEX IF EXISTS "{models._SCHEMA}".uq_jobs_ingest_active'))
    async with store.connect() as holder, store.connect() as conn:
        held = await holder.begin()
        try:
            await holder.execute(text(
                f'LOCK TABLE "{models._SCHEMA}".commits, {_JOBS} IN ROW EXCLUSIVE MODE'))
            async with conn.begin():
                await conn.execute(text("SET LOCAL statement_timeout = '20s'"))
                started = time.monotonic()
                await conn.run_sync(models._ensure_schema_upgrades)    # logs, never raises
                waited = time.monotonic() - started
                assert "uq_commits_idem" not in await _indexes(conn, "commits")
                assert "uq_jobs_ingest_active" not in await _indexes(conn, "jobs")
        finally:
            await held.rollback()
    assert waited < 15, f"waited {waited:.0f}s for the busy tables"   # the store fixture rebuilds them


@e2e
@pytest.mark.parametrize("table", ["jobs", "merge_requests", "graphs"])
async def test_a_busy_table_stops_a_worker_start_that_needs_its_step(store, table):
    """``ck_jobs_type``, ``merge_requests.approvals`` and the graphs' lifecycle columns are steps
    the running code needs: without them a new job type fails its INSERT and every merge request
    or graph query its SELECT. Their wait is bounded too, but then the start fails, so the
    worker's restart tries again, rather than run without them."""
    async with store.begin() as conn:
        if table == "jobs":
            await _set_check(conn, _PUBLISH_ERA)
        elif table == "merge_requests":
            await conn.execute(text(
                f'ALTER TABLE "{models._SCHEMA}".merge_requests DROP COLUMN approvals'))
        else:
            await conn.execute(text(
                f'ALTER TABLE "{models._SCHEMA}".graphs DROP COLUMN lifecycle_rev'))
    async with store.connect() as holder, store.connect() as conn:
        held = await holder.begin()
        try:
            await holder.execute(text(
                f'LOCK TABLE "{models._SCHEMA}"."{table}" IN ACCESS SHARE MODE'))
            async with conn.begin():
                await conn.execute(text("SET LOCAL statement_timeout = '20s'"))
                with pytest.raises(DBAPIError, match="lock timeout"):
                    await conn.run_sync(models._ensure_schema_upgrades)
        finally:
            await held.rollback()                           # the store fixture brings them back


@e2e
async def test_the_commit_key_migration_round_trips(store):
    migration = _migration(_COMMITS_IDEM)

    def run(step):
        def apply(sync_conn):
            migration.op = SimpleNamespace(get_bind=lambda: sync_conn,
                                           execute=lambda sql: sync_conn.execute(text(sql)))
            getattr(migration, step)()
        return apply

    async with store.connect() as conn:
        trans = await conn.begin()
        try:
            await conn.run_sync(run("downgrade"))
            assert "uq_commits_idem" not in await _indexes(conn, "commits")
            assert "ix_commits_idem" in await _indexes(conn, "commits")
            await conn.run_sync(run("upgrade"))
            assert "uq_commits_idem" in await _indexes(conn, "commits")
            await conn.run_sync(run("upgrade"))                     # idempotent
        finally:
            await trans.rollback()


# ── uq_jobs_ingest_active: one active import per draft (20261017_1950_gv_ingest_active) ──
_INGEST_ACTIVE = _VERSIONS / "20261017_1950_gv_ingest_active.py"


def test_one_active_import_per_draft_is_migrated_and_modelled():
    migration = _migration(_INGEST_ACTIVE)
    assert migration.revision == _INGEST_ACTIVE.stem
    assert migration.down_revision == "20261017_1900_gv_commits_idem"
    index = next(i for i in JobORM.__table__.indexes if i.name == "uq_jobs_ingest_active")
    assert index.unique and [c.name for c in index.columns] == ["branch_id"]
    assert str(index.dialect_options["postgresql"]["where"]) == models._INGEST_ACTIVE


def _ago(secs: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=secs)).isoformat()


async def _ingest(conn, branch: str, *, status: str = "pending", phase=None, created: float = 0,
                  updated=None, started=None) -> str:
    jid = f"vjob_one_{os.urandom(4).hex()}"
    await conn.execute(text(
        f"INSERT INTO {_JOBS} (id, job_type, graph_id, branch_id, status, current_phase, progress, "
        "total, processed, batch_size, retry_count, max_retries, last_sequence, auto_publish, "
        "created_at, updated_at, started_at) VALUES (:id, 'ingest', 'g_one', :b, :st, :ph, 0, 0, 0, "
        "1, 0, 0, 0, false, :c, :u, :s)"),
        {"id": jid, "b": branch, "st": status, "ph": phase, "c": _ago(created),
         "u": _ago(updated if updated is not None else created),
         "s": _ago(started) if started is not None else None})
    return jid


async def _state(conn, jid: str):
    return tuple((await conn.execute(text(
        f"SELECT status, error_message FROM {_JOBS} WHERE id = :id"), {"id": jid})).one())


def _branch() -> str:
    return "br_one_" + os.urandom(3).hex()


@contextlib.asynccontextmanager
async def _without_ingest_active(engine):
    async with engine.connect() as conn:
        trans = await conn.begin()
        try:
            await conn.execute(text(f'DROP INDEX IF EXISTS "{models._SCHEMA}".uq_jobs_ingest_active'))
            yield conn
        finally:
            await trans.rollback()


def _run_ingest_active(step: str):
    migration = _migration(_INGEST_ACTIVE)

    def apply(sync_conn):
        migration.op = SimpleNamespace(get_bind=lambda: sync_conn,
                                       execute=lambda sql: sync_conn.execute(text(sql)))
        getattr(migration, step)()
    return apply


@e2e
async def test_a_store_alembic_never_reached_gets_uq_jobs_ingest_active(store):
    """Before the build, the jobs nothing will run are failed by the reaper's rules, and of two
    queued imports on one draft the later is failed: it never started."""
    async with _without_ingest_active(store) as conn:
        cut_off, live = _branch(), _branch()
        never_queued = await _ingest(conn, cut_off, created=2 * 3600)   # its upload was cut off
        retried = await _ingest(conn, cut_off, phase=QUEUED, created=60)
        timed_out = await _ingest(conn, _branch(), phase=QUEUED,
                                  updated=config.TRANSFER_QUEUE_TIMEOUT_SECS + 60)
        first = await _ingest(conn, live, phase=QUEUED, created=60)
        second = await _ingest(conn, live, phase=QUEUED, created=30)
        await conn.run_sync(models._ensure_schema_upgrades)
        assert "uq_jobs_ingest_active" in await _indexes(conn, "jobs")
        assert await _state(conn, never_queued) == ("failed", config.JOB_NEVER_QUEUED)
        assert await _state(conn, timed_out) == ("failed", config.JOB_NOT_STARTED)
        assert await _state(conn, retried) == await _state(conn, first) == ("pending", None)
        status, message = await _state(conn, second)
        assert status == "failed" and "Another import was already running" in message
        await conn.run_sync(models._ensure_schema_upgrades)        # and again: a no-op


@e2e
async def test_a_running_import_is_never_failed_to_build_the_index(store):
    """Two imports running on one draft (old workers mid-upgrade): the migration stops and names
    them; a worker start leaves the index for a later start."""
    async with _without_ingest_active(store) as conn:
        branch = _branch()
        a = await _ingest(conn, branch, status="running", started=60, created=90)
        b = await _ingest(conn, branch, status="running", started=30, created=60)
        with pytest.raises(RuntimeError, match=branch):
            await conn.run_sync(_run_ingest_active("upgrade"))
        await conn.run_sync(models._ensure_schema_upgrades)        # logs, never raises
        assert "uq_jobs_ingest_active" not in await _indexes(conn, "jobs")
        assert await _state(conn, a) == await _state(conn, b) == ("running", None)


@e2e
async def test_the_one_active_import_migration_round_trips(store):
    async with store.connect() as conn:
        trans = await conn.begin()
        try:
            await conn.run_sync(_run_ingest_active("downgrade"))
            assert "uq_jobs_ingest_active" not in await _indexes(conn, "jobs")
            await conn.run_sync(_run_ingest_active("upgrade"))
            assert "uq_jobs_ingest_active" in await _indexes(conn, "jobs")
            await conn.run_sync(_run_ingest_active("upgrade"))      # idempotent
        finally:
            await trans.rollback()


# ── reseeding status (20261017_2000_gv_ps_reseeding) ──────────────────────────────────────────
_PS_RESEEDING = _VERSIONS / "20261017_2000_gv_ps_reseeding.py"
_PS = f'"{models._SCHEMA}"."projection_state"'


def test_the_reseeding_status_is_declared_and_migrated():
    check = next(c for c in models.ProjectionStateORM.__table__.constraints
                 if getattr(c, "name", "") == "ck_proj_status")
    assert "'reseeding'" in str(check.sqltext)
    reseeding = _migration(_PS_RESEEDING)
    assert reseeding.revision == _PS_RESEEDING.stem
    assert reseeding.down_revision == "20261017_1950_gv_ingest_active"


async def _status_check(conn):
    return (await conn.execute(text(
        "SELECT oid, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_proj_status' "
        f"AND conrelid = CAST('{_PS}' AS regclass)"))).one()


@e2e
async def test_a_store_alembic_never_reached_allows_reseeding(store):
    async with store.connect() as conn:
        trans = await conn.begin()
        try:
            await conn.execute(text(f"ALTER TABLE {_PS} DROP CONSTRAINT ck_proj_status"))
            await conn.execute(text(
                f"ALTER TABLE {_PS} ADD CONSTRAINT ck_proj_status "
                "CHECK (status IN ('idle','projecting','rebuilding','evicted'))"))
            await conn.run_sync(models._ensure_schema_upgrades)
            oid, definition = await _status_check(conn)
            assert "'reseeding'" in definition, definition
            await conn.run_sync(models._ensure_schema_upgrades)        # and again: a no-op
            assert (await _status_check(conn))[0] == oid
        finally:
            await trans.rollback()


@e2e
async def test_the_reseeding_migration_round_trips(store):
    """Down, a graph waiting for its reseed reads idle: its watermark is 0, so the poll still
    reseeds it."""
    migration = _migration(_PS_RESEEDING)

    def run(step):
        def apply(sync_conn):
            migration.op = SimpleNamespace(get_bind=lambda: sync_conn,
                                           execute=lambda sql: sync_conn.execute(text(sql)))
            getattr(migration, step)()
        return apply

    async with store.connect() as conn:
        trans = await conn.begin()
        try:
            await conn.execute(text(
                f"INSERT INTO {_PS} (graph_id, projected_commit_seq, target_commit_seq, status, "
                "owns_falkor_graph, updated_at) "
                "VALUES ('g_schema_reseeding', 0, 3, 'reseeding', false, '2026-10-17')"))
            await conn.run_sync(run("downgrade"))
            assert "'reseeding'" not in (await _status_check(conn))[1]
            assert (await conn.execute(text(
                f"SELECT status FROM {_PS} WHERE graph_id = 'g_schema_reseeding'"))).scalar() == "idle"
            await conn.run_sync(run("upgrade"))
            assert "'reseeding'" in (await _status_check(conn))[1]
            await conn.run_sync(run("upgrade"))                     # idempotent
        finally:
            await trans.rollback()


# ── merge_requests.approvals: the head each approval was of (20261018_1000_gv_mr_approvals) ──
_MR_APPROVALS = _VERSIONS / "20261018_1000_gv_mr_approvals.py"


async def _mr_columns(conn) -> set:
    return {r[0] for r in (await conn.execute(text(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema = :s AND table_name = 'merge_requests'"),
        {"s": models._SCHEMA})).all()}


def test_the_approvals_column_is_declared_and_migrated():
    assert models.MergeRequestORM.__table__.c.approvals.nullable
    migration = _migration(_MR_APPROVALS)
    assert migration.revision == _MR_APPROVALS.stem
    assert migration.down_revision == "20261017_2000_gv_ps_reseeding"


@e2e
async def test_a_store_alembic_never_reached_gets_the_approvals_column(store):
    async with store.connect() as conn:
        trans = await conn.begin()
        try:
            await conn.execute(text(f'ALTER TABLE "{models._SCHEMA}".merge_requests DROP COLUMN approvals'))
            await conn.run_sync(models._ensure_schema_upgrades)
            assert "approvals" in await _mr_columns(conn)
            await conn.run_sync(models._ensure_schema_upgrades)        # and again: a no-op
        finally:
            await trans.rollback()


@e2e
async def test_the_approvals_migration_round_trips(store):
    migration = _migration(_MR_APPROVALS)

    def run(step):
        def apply(sync_conn):
            migration.op = SimpleNamespace(get_bind=lambda: sync_conn,
                                           execute=lambda sql: sync_conn.execute(text(sql)))
            getattr(migration, step)()
        return apply

    async with store.connect() as conn:
        trans = await conn.begin()
        try:
            await conn.run_sync(run("downgrade"))
            assert "approvals" not in await _mr_columns(conn)
            await conn.run_sync(run("upgrade"))
            assert "approvals" in await _mr_columns(conn)
            await conn.run_sync(run("upgrade"))                     # idempotent
        finally:
            await trans.rollback()


# ── projection_state.retired_keys: a moved graph's old keys (20261018_1100_gv_ps_retired) ──
_PS_RETIRED = _VERSIONS / "20261018_1100_gv_ps_retired.py"


def test_the_retired_keys_column_is_declared_and_migrated():
    assert models.ProjectionStateORM.__table__.c.retired_keys.nullable
    migration = _migration(_PS_RETIRED)
    assert migration.revision == _PS_RETIRED.stem
    assert migration.down_revision == "20261018_1000_gv_mr_approvals"


@e2e
async def test_a_store_alembic_never_reached_gets_the_retired_keys_column(store):
    async with store.connect() as conn:
        trans = await conn.begin()
        try:
            await conn.execute(text(f"ALTER TABLE {_PS} DROP COLUMN retired_keys"))
            await conn.run_sync(models._ensure_schema_upgrades)
            assert "retired_keys" in await _ps_columns(conn)
            await conn.run_sync(models._ensure_schema_upgrades)        # and again: a no-op
        finally:
            await trans.rollback()


@e2e
async def test_the_retired_keys_migration_round_trips(store):
    migration = _migration(_PS_RETIRED)

    def run(step):
        def apply(sync_conn):
            migration.op = SimpleNamespace(get_bind=lambda: sync_conn,
                                           execute=lambda sql: sync_conn.execute(text(sql)))
            getattr(migration, step)()
        return apply

    async with store.connect() as conn:
        trans = await conn.begin()
        try:
            await conn.run_sync(run("downgrade"))
            assert "retired_keys" not in await _ps_columns(conn)
            await conn.run_sync(run("upgrade"))
            assert "retired_keys" in await _ps_columns(conn)
            await conn.run_sync(run("upgrade"))                     # idempotent
        finally:
            await trans.rollback()


# ── graphs.lifecycle_*: a graph's freeze and its revision (20261018_1200_gv_lifecycle) ──
_GV_LIFECYCLE = _VERSIONS / "20261018_1200_gv_lifecycle.py"
_GRAPHS = f'"{models._SCHEMA}"."graphs"'
_LIFECYCLE_COLUMNS = {"lifecycle_state", "lifecycle_rev", "lifecycle_changed_at"}


def test_the_lifecycle_columns_are_declared_and_migrated():
    """A store ``create_all`` builds must equal the migrated one: the NOT NULL columns carry their
    default on the server too, and only live and frozen are ever stored."""
    table = models.GraphORM.__table__
    assert not table.c.lifecycle_state.nullable
    assert str(table.c.lifecycle_state.server_default.arg) == "'live'"
    assert not table.c.lifecycle_rev.nullable and str(table.c.lifecycle_rev.server_default.arg) == "0"
    assert table.c.lifecycle_changed_at.nullable
    check = next(c for c in table.constraints if getattr(c, "name", "") == "ck_graphs_lifecycle_state")
    assert str(check.sqltext) == "lifecycle_state IN ('live','frozen')"
    migration = _migration(_GV_LIFECYCLE)
    assert migration.revision == _GV_LIFECYCLE.stem and len(migration.revision) <= 32
    assert migration.down_revision == "20261018_1100_gv_ps_retired"
    assert "ensure_graph_lifecycle_columns" in _GV_LIFECYCLE.read_text()


async def _graphs_columns(conn) -> set:
    return {r[0] for r in (await conn.execute(text(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema = :s AND table_name = 'graphs'"),
        {"s": models._SCHEMA})).all()}


async def _insert_graph(conn, graph_id: str, state: str = None) -> None:
    columns, values = "", ""
    if state is not None:
        columns, values = ", lifecycle_state", f", '{state}'"
    await conn.execute(text(
        f"INSERT INTO {_GRAPHS} (id, data_source_id, workspace_id, kind, ontology_enforcement, "
        f"audit_tier, main_head_commit_seq, created_at, updated_at{columns}) "
        f"VALUES (:id, :id, 'ws_schema', 'manual', 'permissive', 'commit_only', 0, "
        f"'2026-10-18', '2026-10-18'{values})"), {"id": graph_id})


@e2e
async def test_a_store_alembic_never_reached_gets_the_lifecycle_columns(store):
    """An existing graph reads live at rev 0, and a trashed state is never stored: trash is
    ``deleted_at``."""
    async with store.connect() as conn:
        trans = await conn.begin()
        try:
            await _insert_graph(conn, "g_schema_lifecycle")
            for column in sorted(_LIFECYCLE_COLUMNS):
                await conn.execute(text(f"ALTER TABLE {_GRAPHS} DROP COLUMN {column}"))
            await conn.run_sync(models._ensure_schema_upgrades)
            assert _LIFECYCLE_COLUMNS <= await _graphs_columns(conn)
            assert (await conn.execute(text(
                f"SELECT lifecycle_state, lifecycle_rev, lifecycle_changed_at FROM {_GRAPHS} "
                "WHERE id = 'g_schema_lifecycle'"))).one() == ("live", 0, None)
            with pytest.raises(DBAPIError, match="ck_graphs_lifecycle_state"):
                async with conn.begin_nested():
                    await _insert_graph(conn, "g_schema_trashed", "trashed")
            await conn.run_sync(models._ensure_schema_upgrades)        # and again: a no-op
        finally:
            await trans.rollback()


@e2e
async def test_the_lifecycle_migration_round_trips(store, caplog):
    """Down drops the columns, and with them every freeze, saying how many graphs it resumed; the
    graphs stay."""
    migration = _migration(_GV_LIFECYCLE)

    def run(step):
        def apply(sync_conn):
            migration.op = SimpleNamespace(get_bind=lambda: sync_conn,
                                           execute=lambda sql: sync_conn.execute(text(sql)))
            getattr(migration, step)()
        return apply

    async with store.connect() as conn:
        trans = await conn.begin()
        try:
            await _insert_graph(conn, "g_schema_frozen", "frozen")
            frozen = (await conn.execute(text(
                f"SELECT count(*) FROM {_GRAPHS} WHERE lifecycle_state = 'frozen'"))).scalar()
            caplog.set_level("WARNING", logger="alembic.runtime.migration")
            await conn.run_sync(run("downgrade"))
            assert f"{frozen} graph(s) had editing paused" in caplog.text
            assert not _LIFECYCLE_COLUMNS & await _graphs_columns(conn)
            assert (await conn.execute(text(
                f"SELECT count(*) FROM {_GRAPHS} WHERE id = 'g_schema_frozen'"))).scalar() == 1
            await conn.run_sync(run("upgrade"))
            assert _LIFECYCLE_COLUMNS <= await _graphs_columns(conn)
            await conn.run_sync(run("upgrade"))                     # idempotent
        finally:
            await trans.rollback()


@e2e
async def test_the_lifecycle_step_never_stalls_graph_reads_for_long(store):
    """While the step waits for ``graphs``, every read of a graph queues behind its request. Each
    try waits half a second, so a read waits about that long rather than the step's whole bound,
    and the step tries again until the long holder lets go."""
    async with store.begin() as conn:
        await conn.execute(text(f"ALTER TABLE {_GRAPHS} DROP COLUMN lifecycle_rev"))
    async with store.connect() as holder, store.connect() as conn, store.connect() as reader:
        held = await holder.begin()
        await holder.execute(text(f"LOCK TABLE {_GRAPHS} IN ACCESS SHARE MODE"))

        async def upgrade():
            async with conn.begin():
                await conn.execute(text("SET LOCAL statement_timeout = '20s'"))
                await conn.run_sync(models._ensure_schema_upgrades)
                assert _LIFECYCLE_COLUMNS <= await _graphs_columns(conn)

        async def read():
            await asyncio.sleep(1)
            started = time.monotonic()
            async with reader.begin():
                await reader.execute(text("SET LOCAL statement_timeout = '20s'"))
                await reader.execute(text(f"SELECT count(*) FROM {_GRAPHS}"))
            return time.monotonic() - started

        async def release():
            await asyncio.sleep(2.5)
            await held.rollback()

        _, waited, _ = await asyncio.gather(upgrade(), read(), release())
    assert waited < 1, f"a graph read waited {waited:.1f}s behind the schema step"
