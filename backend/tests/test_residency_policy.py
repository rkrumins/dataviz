"""The residency policy: where its values are stored (``platform_settings``, migration
``20261030_1400_residency_policy``).

The ORM/migration agreement is checked without a database; the round trip needs Postgres
(``GRAPHVER_E2E=1``) and runs in a transaction it rolls back.
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import text

from backend.app.db.models import PlatformSettingsORM

_VERSIONS = Path(__file__).resolve().parents[1] / "alembic" / "versions"
_POLICY_MIGRATION = _VERSIONS / "20261030_1400_residency_policy.py"
_POLICY_COLUMNS = {
    "gv_eviction_enabled", "gv_default_residency", "gv_standard_idle_secs",
    "gv_coldline_idle_secs", "gv_high_water_pct", "gv_low_water_pct", "gv_load_margin_pct",
    "gv_bytes_per_entity", "gv_coldline_canvas_load_above", "gv_capacity_interval_secs",
}

e2e = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")


def _migration():
    spec = importlib.util.spec_from_file_location(_POLICY_MIGRATION.stem, _POLICY_MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_policy_columns_are_declared_and_migrated():
    """Every value is nullable: NULL is unset, and the default applies. The class is one of the
    three, in the database too."""
    table = PlatformSettingsORM.__table__
    assert _POLICY_COLUMNS <= set(table.c.keys())
    assert all(table.c[name].nullable for name in _POLICY_COLUMNS)
    check = next(c for c in table.constraints
                 if getattr(c, "name", "") == "ck_platform_settings_gv_default_residency")
    assert "gv_default_residency IN ('always','standard','coldline')" in str(check.sqltext)
    migration = _migration()
    assert migration.revision == _POLICY_MIGRATION.stem and len(migration.revision) <= 32
    assert migration.down_revision == "20261030_1300_gv_ps_residency"
    assert {name for name, _kind in migration._COLUMNS} == _POLICY_COLUMNS


async def _columns(conn) -> set:
    return {r[0] for r in (await conn.execute(text(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema = current_schema() AND table_name = 'platform_settings'"))).all()}


@e2e
async def test_the_policy_migration_round_trips():
    """Down drops the values (every one falls back to its default); up adds them again, once,
    with the class check."""
    from sqlalchemy.ext.asyncio import create_async_engine

    def run(step):
        def apply(sync_conn):
            with Operations.context(MigrationContext.configure(sync_conn)):
                getattr(_migration(), step)()
        return apply

    engine = create_async_engine(os.environ["MANAGEMENT_DB_URL"])
    try:
        async with engine.connect() as conn:
            trans = await conn.begin()
            try:
                await conn.run_sync(run("downgrade"))
                assert not _POLICY_COLUMNS & await _columns(conn)
                await conn.run_sync(run("upgrade"))
                assert _POLICY_COLUMNS <= await _columns(conn)
                await conn.run_sync(run("upgrade"))                 # idempotent
                with pytest.raises(Exception, match="ck_platform_settings_gv_default_residency"):
                    async with conn.begin_nested():
                        await conn.execute(text(
                            "UPDATE platform_settings SET gv_default_residency = 'hot'"))
                        await conn.execute(text(
                            "INSERT INTO platform_settings (id, gv_default_residency) "
                            "VALUES (1, 'hot') ON CONFLICT (id) DO UPDATE "
                            "SET gv_default_residency = 'hot'"))
            finally:
                await trans.rollback()
    finally:
        await engine.dispose()
