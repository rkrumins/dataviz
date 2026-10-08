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
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import text

from backend.app.services.versioning import db, models
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
