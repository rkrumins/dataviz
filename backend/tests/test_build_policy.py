"""New-version builds settings: where they're stored (the settings store at the platform, written
through to ``platform_settings.gv_build_policy`` for one release, migration
``20261113_1100_build_policy``), how they resolve (``build_policy.resolve``/``current``: the store's
value, else the environment's where valid, in its range, as this process's settings snapshot last
read it, never raising), the system administrator's routes that read and change them, and the
switch that turns builds on.

The store is the in-memory one every test starts with (``tests/common/settings_world.py``).
"""
from __future__ import annotations

import dataclasses
import importlib.util
import json
import logging
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from backend.app.api.v1.endpoints import versioning_admin as va
from backend.app.auth import api_key_surface
from backend.app.config.feature_wiring import FEATURE_WIRING
from backend.app.config.features_seed import SEED_DEFINITIONS
from backend.app.db.models import PlatformSettingsORM
from backend.app.common import activity_context
from backend.app.main import app
from backend.app.services.activity import catalogue
from backend.app.services.settings import effective, resolver
from backend.app.services.versioning import build_policy as bp, config

_MIGRATION = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "20261113_1100_build_policy.py"


def test_the_column_is_declared_and_migrated():
    table = PlatformSettingsORM.__table__
    assert "gv_build_policy" in table.c and table.c["gv_build_policy"].nullable
    spec = importlib.util.spec_from_file_location(_MIGRATION.stem, _MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.revision == _MIGRATION.stem and len(module.revision) <= 32
    assert module.down_revision == "20261113_1000_gv_ps_served_fill"


class _Session:
    """The one platform settings row, as the routes write it through (the store is the in-memory
    one, ``settings_world``)."""

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

    async def execute(self, statement, params=None):
        """The store's writer lock (``store.lock``): one save at a time."""
        assert "pg_advisory_xact_lock" in str(statement)

    async def flush(self):
        pass

    async def commit(self):
        self.commits += 1

    async def rollback(self):
        pass


_AT = datetime(2026, 11, 13, 10, 0, tzinfo=timezone.utc)


def _row(**values) -> PlatformSettingsORM:
    """The old storage, as the import migration found it and a save writes it through."""
    return PlatformSettingsORM(id=1, gv_build_policy=json.dumps(
        {"values": values, "updatedBy": "usr_ops", "updatedAt": _AT.isoformat()}))


def _save(world, **values) -> None:
    """Values saved at the platform (by wire name, in the old spelling) in the settings store, by
    usr_ops at ``_AT``, as the import migration copies them."""
    for wire, value in values.items():
        s = bp._SETTINGS[wire]
        row = world.set(s.key, "platform", "", resolver.decode(s, value))
        world.rows[(s.key, "platform", "")] = dataclasses.replace(row, updated_by="usr_ops",
                                                                   updated_at=_AT)


# ── the resolver ─────────────────────────────────────────────────────────────────────────────
def test_with_nothing_saved_every_value_is_its_environment_default():
    d = bp.defaults()
    assert d["buildAboveRows"] == config.PROJECTION_CANDIDATE_ABOVE
    assert (d["buildMode"], d["noRoomPolicy"]) == ("auto", "wait")
    assert d["copyMarginPct"] == config.PROJECTION_COPY_MARGIN_PCT
    assert d["retireGraceSecs"] == config.RETIRE_GRACE_SECS
    assert (d["pgReadsPerGraph"], d["pgReadsPerProcess"]) == (config.PG_READS_PER_GRAPH,
                                                              config.PG_READS_PER_PROCESS)
    assert set(d.values) == {f.wire for f in bp.FIELDS}
    assert d["readMode"] == config.READ_MODE == "latest"     # as reads have always worked


def test_rebuilds_and_moves_too_says_what_is_built_beside_and_nothing_more():
    """Rebuilds and moves are built beside; loads are not, so the setting no longer says so."""
    field = bp.BY_WIRE["buildForRebuilds"]
    assert (field.label, field.default()) == ("Rebuilds and moves too", True)
    assert "Rebuilds and moves" in field.help and "load" not in field.help.lower()
    assert "seeded from Postgres while readers keep the current version" in field.help


def test_a_graphs_own_read_mode_wins_over_the_platforms():
    platform = bp.effective({"readMode": "beside"})
    assert bp.read_mode_of(None, platform) == "beside"
    assert bp.read_mode_of("latest", platform) == "latest"
    assert bp.read_mode_of("sideways", platform) == "beside", "a value no mode names is ignored"
    assert bp.effective({"readMode": "sideways"})["readMode"] == "latest"
    assert (bp.max_lag_of("latest"), bp.max_lag_of("in_place"), bp.max_lag_of("beside")) == (
        0, None, None)


def test_a_saved_value_out_of_range_is_clamped_and_ordered_never_refused(monkeypatch):
    monkeypatch.setattr(config, "PROJECTION_CONCURRENCY", 3)
    p = bp.effective({"copyMarginPct": 9000, "buildConcurrency": 8, "pacingRatio": "x",
                      "buildMode": "sideways", "pgReadsPerGraph": 20, "pgReadsPerProcess": 6})
    assert p["copyMarginPct"] == 400
    assert p["buildConcurrency"] == 3, "never more builds than projection passes"
    assert p["pacingRatio"] == config.PROJECTION_PACING_RATIO
    assert p["buildMode"] == "auto"
    assert (p["pgReadsPerGraph"], p["pgReadsPerProcess"]) == (6, 6)


def test_a_value_saved_for_a_removed_setting_is_not_kept():
    # warmSecs was a setting once; a row that still holds it is saved without it.
    assert bp.merged({"warmSecs": 30, "copyMarginPct": 150}, {"noRoomPolicy": "in_place"}) \
        == {"copyMarginPct": 150, "noRoomPolicy": "in_place"}
    assert "warmSecs" not in bp.defaults().values


async def test_a_saved_value_wins_and_an_unset_one_is_the_default(settings_world):
    _save(settings_world, copyMarginPct=150, noRoomPolicy="in_place")
    p = await bp.resolve()
    assert (p["copyMarginPct"], p["noRoomPolicy"]) == (150, "in_place")
    assert p["flipMaxLagRows"] == config.PROJECTION_CANDIDATE_FLIP_MAX_LAG_ROWS


async def test_a_store_save_reaches_current_after_a_refresh(settings_world):
    """``current`` reads this process's settings as last refreshed, without IO: a save elsewhere
    is in it once a refresh (the worker's poll, a pass's ``resolve``) has read it, in the old
    spelling."""
    assert bp.current()["flipMaxLagRows"] == config.PROJECTION_CANDIDATE_FLIP_MAX_LAG_ROWS
    settings_world.set("builds.switchMaxLagRows", "platform", "", 40)
    settings_world.set("builds.copyMaxBytes", "platform", "", "unlimited")
    settings_world.set("updates.pacingRatio", "platform", "", 1)
    assert bp.current()["flipMaxLagRows"] == config.PROJECTION_CANDIDATE_FLIP_MAX_LAG_ROWS
    await effective.refresh()
    p = bp.current()
    assert (p["flipMaxLagRows"], p["copyMaxBytes"], p["pacingRatio"]) == (40, 0, 1.0)
    assert bp.current() is p, "built once per refresh that changed something"
    settings_world.set("builds.switchMaxLagRows", "platform", "", 50)
    assert (await bp.resolve())["flipMaxLagRows"] == 50 == bp.current()["flipMaxLagRows"]


async def test_the_platforms_read_mode_is_its_own_whether_builds_are_on_or_not(settings_world):
    """What a graph with no mode of its own reads by, as before the store: Keep serving, switch
    when ready is not turned into update in place here while New-version builds are off (the
    resolver's effective value does that, for the read path to use later)."""
    settings_world.set("reads.mode", "platform", "", "beside")
    await effective.refresh()
    assert effective.value("reads.mode") == "in_place"
    assert bp.current()["readMode"] == "beside"
    assert bp.read_mode_of(None) == "beside" and bp.read_mode_of("latest") == "latest"


async def test_unreadable_settings_keep_the_last_values_read_and_never_raise(settings_world):
    settings_world.readable = False
    assert (await bp.resolve())["flipMaxLagRows"] == config.PROJECTION_CANDIDATE_FLIP_MAX_LAG_ROWS
    settings_world.readable = True
    _save(settings_world, flipMaxLagRows=40)
    assert (await bp.resolve())["flipMaxLagRows"] == 40
    settings_world.readable = False
    assert (await bp.resolve())["flipMaxLagRows"] == 40
    assert effective.readable() is False


def test_every_field_is_a_setting_of_the_registry():
    """The old wire names map one to one onto the registry's settings (``Legacy.build_policy``)."""
    assert set(bp._SETTINGS) == set(bp.BY_WIRE)
    assert {s.key for s in bp._SETTINGS.values()} == {
        s.key for s in bp.registry().SETTINGS if s.legacy and s.legacy.build_policy}


def test_an_invalid_read_mode_in_the_environment_is_reported_and_latest_applies(monkeypatch,
                                                                               caplog):
    """``GRAPHVER_READ_MODE`` that names no mode is kept as given (it used to become latest
    silently): the setting says ``invalid_env``, its code default applies, and start-up warns."""
    monkeypatch.setenv("GRAPHVER_READ_MODE", "sideways")
    monkeypatch.setattr(config, "READ_MODE", "sideways")
    found = resolver.resolve(effective.context_now(), "reads.mode")
    assert (found["status"], found["effective"], found["source"]) == ("invalid_env", "latest",
                                                                      "default")
    assert found["trail"][0]["env"] == {"name": "GRAPHVER_READ_MODE", "value": "sideways",
                                        "valid": False}
    assert [w["code"] for w in found["why"]] == ["invalid_env"]
    assert bp.defaults()["readMode"] == "latest" == bp.current()["readMode"]
    with caplog.at_level(logging.WARNING, logger=config.__name__):
        config.warn_invalid_settings_env()
    warned = [r.getMessage() for r in caplog.records if r.name == config.__name__]
    assert len(warned) == 1 and "GRAPHVER_READ_MODE='sideways'" in warned[0]


def test_config_keeps_the_read_mode_the_environment_gives():
    root = Path(__file__).resolve().parents[2]
    done = subprocess.run(
        [sys.executable, "-c",
         "from backend.app.services.versioning import config; print(config.READ_MODE)"],
        cwd=root, env={**os.environ, "GRAPHVER_READ_MODE": "sideways"}, capture_output=True,
        text=True, timeout=60)
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == "sideways"


@pytest.mark.parametrize("body, field", [
    ({"nope": 1}, "nope"),
    ({"buildAboveRows": 10}, "buildAboveRows"),
    ({"buildAboveRows": "200000"}, "buildAboveRows"),
    ({"buildForRebuilds": "yes"}, "buildForRebuilds"),
    ({"buildMode": "sideways"}, "buildMode"),
    ({"readMode": "fastest"}, "readMode"),
    ({"pacingRatio": 9}, "pacingRatio"),
    ({"pacingRatio": True}, "pacingRatio"),
    ({"copyMaxBytes": -2}, "copyMaxBytes"),
    ({"pgReadsPerGraph": 9, "pgReadsPerProcess": 8}, "pgReadsPerGraph"),
])
def test_a_bad_value_is_refused_naming_its_field(body, field):
    with pytest.raises(bp.PolicyInvalid) as exc:
        bp.validate(body, {})
    assert exc.value.field == field


def test_minus_one_clears_and_none_leaves_a_value():
    bp.validate({"copyMarginPct": -1, "pacingRatio": -1, "buildMode": -1, "flipMaxLagRows": None}, {})
    assert bp.merged({"copyMarginPct": 150, "flipMaxLagRows": 40}, {"copyMarginPct": -1, "flipMaxLagRows": None}) \
        == {"copyMarginPct": None, "flipMaxLagRows": 40}


# ── the routes ───────────────────────────────────────────────────────────────────────────────
_ADMIN = SimpleNamespace(id="usr_admin")


async def _put(body, session, recorded=None):
    async def record(session, event_type, **fields):
        (recorded if recorded is not None else []).append((event_type, fields))
        return True

    with patch.object(va.recorder, "record_for_request", record):
        return await va.put_build_policy(body, user=_ADMIN, session=session)


async def test_get_describes_each_value_and_how_the_card_shows_it(settings_world):
    _save(settings_world, copyMarginPct=150)
    out = await va.get_build_policy(_user=_ADMIN, session=_Session(_row(copyMarginPct=150)))
    assert out["enabled"] is False, "New-version builds ships off"
    assert out["values"]["copyMarginPct"] == {"saved": 150, "default": config.PROJECTION_COPY_MARGIN_PCT,
                                              "effective": 150}
    assert (out["updatedBy"], out["updatedAt"]) == ("usr_ops", "2026-11-13T10:00:00+00:00")
    fields = {f["wire"]: f for f in out["fields"]}
    assert set(fields) == set(out["values"])
    assert fields["copyMarginPct"] == {
        "wire": "copyMarginPct", "kind": "int", "section": "room", "label": "Room a copy needs",
        "help": fields["copyMarginPct"]["help"], "unit": "pct", "min": 100, "max": 400,
        "choices": None, "applies": "next"}
    assert fields["buildMode"]["choices"] == ["auto", "copy", "reseed"]
    assert fields["pacingRatio"]["applies"] == "live" and fields["pacingRatio"]["max"] == 5
    assert fields["retireGraceSecs"]["applies"] == "switch"


def test_a_previous_key_outlives_the_versioned_graph_sets_cache():
    """A data source versioned since the versioned-graph set was cached still reads its own key
    until that cache refreshes: the shortest grace a key can be given outlasts it."""
    from backend.app.services.versioned_sources import CACHE_TTL_SECS

    (grace,) = [f for f in bp.FIELDS if f.wire == "retireGraceSecs"]
    assert grace.lo > CACHE_TTL_SECS
    assert config.RETIRE_GRACE_SECS > CACHE_TTL_SECS


async def test_put_saves_through_the_store_writes_the_old_json_and_records_from_and_to(
        settings_world):
    """The old route saves in the settings store, as the old API's save (who, and the reason the
    person gave), writes the old JSON through, and this process reads the change at once."""
    _save(settings_world, flipMaxLagRows=40)
    session, recorded = _Session(_row(flipMaxLagRows=40)), []
    token = activity_context.bind(activity_context.ActivityContext(stated_reason="Quieter"))
    try:
        out = await _put({"copyMarginPct": 150, "noRoomPolicy": "in_place", "flipMaxLagRows": -1},
                         session, recorded)
    finally:
        activity_context.reset(token)
    (change_set,) = settings_world.saves
    assert (change_set.source, change_set.actor, change_set.reason) == (
        "legacy_api", "usr_admin", "Quieter")
    assert {(a.key, a.before_value, a.after_value) for a in change_set.applied} == {
        ("builds.copyRoomPct", None, 150), ("builds.noRoom", None, "in_place"),
        ("builds.switchMaxLagRows", 40, None)}
    saved = json.loads(session.row.gv_build_policy)
    assert saved["values"] == {"copyMarginPct": 150, "noRoomPolicy": "in_place"}
    assert saved["updatedBy"] == "usr_admin" and saved["updatedAt"]
    assert session.row.updated_by == "usr_admin" and session.commits == 1
    assert out["values"]["copyMarginPct"]["effective"] == 150
    assert out["values"]["flipMaxLagRows"]["saved"] is None
    assert out["updatedBy"] == "usr_admin"
    assert recorded == [("platform.build_policy.updated", {"details": {
        "from": {"copyMarginPct": None, "noRoomPolicy": None, "flipMaxLagRows": 40},
        "to": {"copyMarginPct": 150, "noRoomPolicy": "in_place", "flipMaxLagRows": None}}})]
    assert bp.current()["copyMarginPct"] == 150, "this process reads it at once"


async def test_put_of_no_limit_saves_unlimited_and_writes_the_old_zero(settings_world):
    session = _Session(None)
    out = await _put({"copyMaxBytes": 0}, session)
    assert settings_world.rows[("builds.copyMaxBytes", "platform", "")].value == "unlimited"
    assert json.loads(session.row.gv_build_policy)["values"] == {"copyMaxBytes": 0}
    assert out["values"]["copyMaxBytes"] == {"saved": 0, "default": 0, "effective": 0}


async def test_a_save_that_changes_nothing_records_nothing(settings_world):
    _save(settings_world, flipMaxLagRows=40)
    session, recorded = _Session(_row(flipMaxLagRows=40)), []
    await _put({"flipMaxLagRows": 40}, session, recorded)
    assert recorded == [] and settings_world.saves == []


async def test_a_bad_value_is_a_422_naming_it_and_saves_nothing(settings_world):
    session = _Session(_row())
    with pytest.raises(HTTPException) as exc:
        await _put({"copyMarginPct": 50}, session)
    assert exc.value.status_code == 422
    assert exc.value.detail["type"] == "invalid_build_policy"
    assert exc.value.detail["field"] == "copyMarginPct"
    assert session.commits == 0 and settings_world.saves == []


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
    routes = _routes("/api/v1/admin/versioning/build-policy")
    assert set(routes) == {"GET", "PUT"}
    for route, dependant in routes.values():
        assert "system:admin" in _gate_perms(dependant)
        assert (route.endpoint.__module__, route.endpoint.__name__) not in api_key_surface.SURFACE


def test_the_activity_log_can_say_what_happened():
    severity, summary = catalogue.summarize("platform.build_policy.updated",
                                            {"details": {"from": {}, "to": {}}})
    assert severity == "info" and "built" in summary
    assert catalogue.LABELS["platform.build_policy.updated"]
    assert catalogue.category_of("platform.build_policy.updated") == "platform"


def test_the_switch_ships_off_needs_version_control_and_is_a_preview():
    seed = next(d for d in SEED_DEFINITIONS if d["key"] == bp.SWITCH)
    assert json.loads(seed["default_value"]) is False
    wiring = FEATURE_WIRING[bp.SWITCH]
    assert (wiring.stage, wiring.depends_on) == ("experimental", ("versioningEnabled",))
