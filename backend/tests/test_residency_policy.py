"""The residency policy: where its values are stored (``platform_settings``, migration
``20261030_1400_residency_policy``), how they resolve (``residency_policy.resolve``: the saved
value, else the environment's, clamped to its range, memoized, never raising) and the system
administrator's routes that read and change them.

The ORM/migration agreement, the resolver and the routes are checked without a database; the
migration's round trip needs Postgres (``GRAPHVER_E2E=1``) and runs in a transaction it rolls back.
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi import HTTPException
from sqlalchemy import text

from backend.app.api.v1.endpoints import versioning_admin as va
from backend.app.auth import api_key_surface
from backend.app.db.models import PlatformSettingsORM
from backend.app.main import app
from backend.app.services.activity import catalogue
from backend.app.services.versioning import config, residency_policy as rp

_VERSIONS = Path(__file__).resolve().parents[1] / "alembic" / "versions"
_POLICY_MIGRATION = _VERSIONS / "20261030_1400_residency_policy.py"
_POLICY_COLUMNS = {
    "gv_eviction_enabled", "gv_default_residency", "gv_standard_idle_secs",
    "gv_coldline_idle_secs", "gv_high_water_pct", "gv_low_water_pct", "gv_load_margin_pct",
    "gv_bytes_per_entity", "gv_coldline_canvas_load_above", "gv_capacity_interval_secs",
    "gv_policy_updated_by", "gv_policy_updated_at",
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


# ── the resolver ─────────────────────────────────────────────────────────────────────────────
_DEFAULTS = {
    "evictionEnabled": True, "defaultResidency": "standard", "standardIdleSecs": 7 * 86400,
    "coldlineIdleSecs": 3600, "highWaterPct": 80, "lowWaterPct": 70, "loadMarginPct": 130,
    "bytesPerEntity": 550, "coldlineCanvasLoadAbove": 500_000, "capacityIntervalSecs": 60,
}


class _Session:
    """The one platform settings row, as the routes and the resolver read and write it."""

    def __init__(self, row=None, fail=False):
        self.row, self.fail, self.commits, self.reads = row, fail, 0, 0

    async def get(self, cls, pk):
        assert (cls, pk) == (PlatformSettingsORM, 1)
        self.reads += 1
        if self.fail:
            raise RuntimeError("platform_settings is unreadable")
        return self.row

    def add(self, row):
        self.row = row

    async def commit(self):
        self.commits += 1


@pytest.fixture(autouse=True)
def _fresh_memo():
    rp.invalidate()
    rp._MEMO["good"] = None
    yield
    rp.invalidate()


def _values(policy) -> dict:
    return {wire: getattr(policy, attr) for wire, attr in rp.WIRE_NAMES.items()}


def test_with_nothing_saved_every_value_is_its_default():
    assert _values(rp.defaults()) == _DEFAULTS


def test_the_defaults_come_from_the_environment_clamped_to_their_ranges(monkeypatch):
    monkeypatch.setattr(config, "EVICTION_ENABLED", False)
    monkeypatch.setattr(config, "MASTER_HIGH_WATER_PCT", 99)        # past 95
    monkeypatch.setattr(config, "MASTER_LOW_WATER_PCT", 93)         # within its range, not 5 below
    monkeypatch.setattr(config, "CAPACITY_SECS", 1)
    policy = rp.defaults()
    assert policy.eviction_enabled is False
    assert (policy.high_water_pct, policy.low_water_pct) == (95, 90)
    assert policy.capacity_interval_secs == 15


async def test_a_saved_value_wins_and_an_unset_one_is_the_default():
    row = PlatformSettingsORM(id=1, gv_eviction_enabled=False, gv_default_residency="coldline",
                              gv_high_water_pct=85, gv_bytes_per_entity=None)
    policy = await rp.resolve(_Session(row))
    assert _values(policy) == {**_DEFAULTS, "evictionEnabled": False,
                               "defaultResidency": "coldline", "highWaterPct": 85}


async def test_a_saved_value_out_of_range_is_clamped_never_refused():
    """Written past the routes (by hand, or by an older release), a value still resolves inside
    its range and the pairs stay ordered: Coldline never outlives Standard, the stop mark stays
    five points under the start mark."""
    row = PlatformSettingsORM(id=1, gv_standard_idle_secs=60, gv_coldline_idle_secs=86400,
                              gv_high_water_pct=40, gv_low_water_pct=90, gv_load_margin_pct=900,
                              gv_bytes_per_entity=5, gv_coldline_canvas_load_above=-3,
                              gv_capacity_interval_secs=10_000, gv_default_residency="hot")
    policy = await rp.resolve(_Session(row))
    assert policy.standard_idle_secs == 3600
    assert policy.coldline_idle_secs == 3600                  # ≤ the Standard idle time
    assert (policy.high_water_pct, policy.low_water_pct) == (50, 45)
    assert (policy.load_margin_pct, policy.bytes_per_entity) == (300, 100)
    assert policy.coldline_canvas_load_above == 0
    assert policy.capacity_interval_secs == 600
    assert policy.default_residency == "standard"


async def test_an_unreadable_row_with_no_good_policy_yet_evicts_nothing_and_never_raises():
    """The defaults would turn eviction back on where an administrator turned it off: with no
    policy read yet, the pass plans no eviction (loads go on)."""
    assert _values(await rp.resolve(_Session(fail=True))) == {**_DEFAULTS,
                                                              "evictionEnabled": False}


async def test_an_unreadable_row_keeps_the_last_good_policy_and_reads_again_later():
    good = _Session(PlatformSettingsORM(id=1, gv_eviction_enabled=False, gv_high_water_pct=95))
    assert (await rp.resolve(good)).high_water_pct == 95
    rp.invalidate()                                      # a save elsewhere, or the memo's age
    down = _Session(fail=True)
    policy = await rp.resolve(down)
    assert (policy.eviction_enabled, policy.high_water_pct) == (False, 95)
    await rp.resolve(down)
    assert down.reads == 1                               # kept for the memo's 30 seconds


async def test_the_policy_is_memoized_until_a_save_drops_it():
    session = _Session(PlatformSettingsORM(id=1, gv_high_water_pct=85))
    assert (await rp.resolve(session)).high_water_pct == 85
    session.row.gv_high_water_pct = 90
    assert (await rp.resolve(session)).high_water_pct == 85 and session.reads == 1
    rp.invalidate()
    assert (await rp.resolve(session)).high_water_pct == 90 and session.reads == 2


async def test_a_new_graph_gets_the_default_class(monkeypatch):
    rp._MEMO.update(policy=rp.effective({"defaultResidency": "coldline"}), at=rp._clock())
    assert await rp.default_class() == "coldline"


def test_the_flag_is_off_unless_the_deployment_turns_it_on(monkeypatch):
    assert rp.enabled() is config.RESIDENCY_ENABLED
    monkeypatch.setattr(config, "RESIDENCY_ENABLED", True)
    assert rp.enabled() is True


# ── the routes ───────────────────────────────────────────────────────────────────────────────
_ADMIN = SimpleNamespace(id="usr_admin")


async def _put(body, session, recorded=None):
    async def record(session, event_type, **fields):
        (recorded if recorded is not None else []).append((event_type, fields))
        return True

    with patch.object(va.recorder, "record_for_request", record):
        return await va.put_residency_policy(body, user=_ADMIN, session=session)


async def test_get_says_each_value_as_saved_its_default_and_what_is_in_force():
    """Who changed the policy last, and when, is the policy's own: another platform setting
    saved since does not change it."""
    row = PlatformSettingsORM(id=1, gv_low_water_pct=60,
                              gv_policy_updated_at="2026-10-30T10:00:00+00:00",
                              gv_policy_updated_by="usr_res",
                              updated_at="2026-10-30T11:00:00+00:00", updated_by="usr_ops")
    out = await va.get_residency_policy(_user=_ADMIN, session=_Session(row))
    assert out["enabled"] is config.RESIDENCY_ENABLED
    assert out["updatedBy"] == "usr_res" and out["updatedAt"] == "2026-10-30T10:00:00+00:00"
    assert set(out["values"]) == set(_DEFAULTS)
    assert out["values"]["lowWaterPct"] == {"saved": 60, "default": 70, "effective": 60}
    assert out["values"]["highWaterPct"] == {"saved": None, "default": 80, "effective": 80}
    assert out["ranges"]["standardIdleSecs"] == {"min": 3600, "max": 365 * 86400}
    nothing = await va.get_residency_policy(_user=_ADMIN, session=_Session(None))
    assert nothing["updatedBy"] is None
    assert {k: v["effective"] for k, v in nothing["values"].items()} == _DEFAULTS


async def test_put_saves_what_it_names_and_records_from_and_to():
    session, recorded = _Session(PlatformSettingsORM(id=1, gv_high_water_pct=85)), []
    rp._MEMO.update(policy=rp.defaults(), at=rp._clock())
    out = await _put({"highWaterPct": 75, "lowWaterPct": 60, "defaultResidency": "coldline"},
                     session, recorded)
    row = session.row
    assert (row.gv_high_water_pct, row.gv_low_water_pct, row.gv_default_residency) == (
        75, 60, "coldline")
    assert row.gv_policy_updated_by == "usr_admin" and row.gv_policy_updated_at
    assert row.updated_by == "usr_admin" and row.updated_at and session.commits == 1
    assert (out["updatedBy"], out["updatedAt"]) == ("usr_admin", row.gv_policy_updated_at)
    assert out["values"]["highWaterPct"]["effective"] == 75
    assert recorded == [("platform.residency_policy.updated", {"details": {
        "from": {"defaultResidency": None, "highWaterPct": 85, "lowWaterPct": None},
        "to": {"defaultResidency": "coldline", "highWaterPct": 75, "lowWaterPct": 60}}})]
    assert rp._MEMO["policy"] is None                          # this process sees it at once


async def test_minus_one_clears_a_value_back_to_its_default():
    session, recorded = _Session(PlatformSettingsORM(
        id=1, gv_eviction_enabled=False, gv_default_residency="always", gv_bytes_per_entity=900)), []
    out = await _put({"evictionEnabled": -1, "defaultResidency": -1, "bytesPerEntity": -1},
                     session, recorded)
    assert (session.row.gv_eviction_enabled, session.row.gv_default_residency,
            session.row.gv_bytes_per_entity) == (None, None, None)
    assert out["values"]["bytesPerEntity"] == {"saved": None, "default": 550, "effective": 550}
    assert recorded[0][1]["details"]["to"] == {
        "bytesPerEntity": None, "defaultResidency": None, "evictionEnabled": None}


async def test_a_save_that_changes_nothing_records_nothing():
    session, recorded = _Session(PlatformSettingsORM(id=1, gv_load_margin_pct=150)), []
    await _put({"loadMarginPct": 150}, session, recorded)
    assert recorded == [] and session.row.gv_policy_updated_by is None


@pytest.mark.parametrize("body, field", [
    ({"standardIdleSecs": 3599}, "standardIdleSecs"),
    ({"standardIdleSecs": 365 * 86400 + 1}, "standardIdleSecs"),
    ({"coldlineIdleSecs": 299}, "coldlineIdleSecs"),
    ({"coldlineIdleSecs": 7 * 86400 + 1}, "coldlineIdleSecs"),
    ({"highWaterPct": 49}, "highWaterPct"),
    ({"highWaterPct": 96}, "highWaterPct"),
    ({"lowWaterPct": 29}, "lowWaterPct"),
    ({"lowWaterPct": 91}, "lowWaterPct"),
    ({"loadMarginPct": 99}, "loadMarginPct"),
    ({"loadMarginPct": 301}, "loadMarginPct"),
    ({"bytesPerEntity": 99}, "bytesPerEntity"),
    ({"bytesPerEntity": 10_001}, "bytesPerEntity"),
    ({"coldlineCanvasLoadAbove": -2}, "coldlineCanvasLoadAbove"),
    ({"coldlineCanvasLoadAbove": 100_000_001}, "coldlineCanvasLoadAbove"),
    ({"capacityIntervalSecs": 14}, "capacityIntervalSecs"),
    ({"capacityIntervalSecs": 601}, "capacityIntervalSecs"),
    ({"highWaterPct": "80"}, "highWaterPct"),
    ({"highWaterPct": 80.5}, "highWaterPct"),
    ({"highWaterPct": True}, "highWaterPct"),
    ({"evictionEnabled": "yes"}, "evictionEnabled"),
    ({"evictionEnabled": 0}, "evictionEnabled"),
    ({"defaultResidency": "hot"}, "defaultResidency"),
    ({"warmup": 5}, "warmup"),
])
async def test_a_value_out_of_its_range_is_a_422_naming_it(body, field):
    session = _Session(PlatformSettingsORM(id=1))
    with pytest.raises(HTTPException) as caught:
        await _put(body, session)
    assert caught.value.status_code == 422
    assert caught.value.detail["type"] == "invalid_residency_policy"
    assert caught.value.detail["field"] == field and caught.value.detail["message"]
    assert session.commits == 0


@pytest.mark.parametrize("saved, body, field", [
    # Coldline may not outlive Standard: against what is saved, the default, or the same save.
    ({"gv_standard_idle_secs": 86400}, {"coldlineIdleSecs": 2 * 86400}, "coldlineIdleSecs"),
    ({"gv_coldline_idle_secs": 7200}, {"standardIdleSecs": 3600}, "standardIdleSecs"),
    ({}, {"standardIdleSecs": 3600, "coldlineIdleSecs": 7200}, "coldlineIdleSecs"),
    # The stop mark sits at least five points under the start mark.
    ({}, {"lowWaterPct": 76}, "lowWaterPct"),
    ({"gv_low_water_pct": 70}, {"highWaterPct": 74}, "highWaterPct"),
    ({}, {"highWaterPct": 60, "lowWaterPct": 60}, "lowWaterPct"),
    # Clearing one back to its default is checked against the other too.
    ({"gv_high_water_pct": 60, "gv_low_water_pct": 50}, {"highWaterPct": 90, "lowWaterPct": -1},
     None),
    ({"gv_high_water_pct": 60, "gv_low_water_pct": 50}, {"highWaterPct": -1}, None),
    ({"gv_high_water_pct": 72, "gv_low_water_pct": 60}, {"lowWaterPct": -1}, "lowWaterPct"),
])
async def test_values_that_contradict_each_other_are_a_422_naming_the_field(saved, body, field):
    session = _Session(PlatformSettingsORM(id=1, **saved))
    if field is None:
        await _put(body, session)
        assert session.commits == 1
        return
    with pytest.raises(HTTPException) as caught:
        await _put(body, session)
    assert caught.value.status_code == 422 and caught.value.detail["field"] == field
    assert session.commits == 0


def _routes(path) -> dict:
    return {m: (r, d) for m, p, r, d in api_key_surface.routes(app) if p == path}


def _gate_perms(dependant) -> set:
    perms, stack = set(), [dependant]
    while stack:
        dep = stack.pop()
        perm = getattr(getattr(dep, "call", None), "required_permission", None)
        if perm:
            perms.add(perm)
        stack.extend(dep.dependencies)
    return perms


def test_the_routes_are_for_platform_admins_only_and_never_for_api_keys():
    routes = _routes("/api/v1/admin/versioning/residency-policy")
    assert set(routes) == {"GET", "PUT"}
    for route, dependant in routes.values():
        assert "system:admin" in _gate_perms(dependant)
        assert (route.endpoint.__module__, route.endpoint.__name__) not in api_key_surface.SURFACE


def test_the_activity_log_can_say_what_happened():
    severity, summary = catalogue.summarize(
        "platform.residency_policy.updated",
        {"details": {"from": {"highWaterPct": 80}, "to": {"highWaterPct": 75}}})
    assert severity == "info" and "residency" in summary
    assert catalogue.LABELS["platform.residency_policy.updated"]
    assert catalogue.category_of("platform.residency_policy.updated") == "platform"
