"""New-version builds settings: where they're stored (``platform_settings.gv_build_policy``, migration
``20261113_1100_build_policy``), how they resolve (``build_policy.resolve``: the saved value, else
the environment's, in its range, memoized, re-read when a save moves the generation, never raising),
the system administrator's routes that read and change them, and the switch that turns builds on.
"""
from __future__ import annotations

import importlib.util
import json
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
from backend.app.main import app
from backend.app.services.activity import catalogue
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


def _row(**values) -> PlatformSettingsORM:
    return PlatformSettingsORM(id=1, gv_build_policy=json.dumps(
        {"values": values, "updatedBy": "usr_ops", "updatedAt": "2026-11-13T10:00:00+00:00"}))


@pytest.fixture(autouse=True)
def _fresh_memo(monkeypatch):
    gen = {"value": None}

    async def generation():
        return gen["value"]
    monkeypatch.setattr(bp, "_generation", generation)
    bp._MEMO.update(policy=None, at=0.0, gen=None, gen_at=0.0, good=None)
    yield gen
    bp._MEMO.update(policy=None, at=0.0, gen=None, gen_at=0.0, good=None)


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


def test_a_saved_value_out_of_range_is_clamped_and_ordered_never_refused(monkeypatch):
    monkeypatch.setattr(config, "PROJECTION_CONCURRENCY", 3)
    p = bp.effective({"copyMarginPct": 9000, "buildConcurrency": 8, "pacingRatio": "x",
                      "buildMode": "sideways", "pgReadsPerGraph": 20, "pgReadsPerProcess": 6})
    assert p["copyMarginPct"] == 400
    assert p["buildConcurrency"] == 3, "never more builds than projection passes"
    assert p["pacingRatio"] == config.PROJECTION_PACING_RATIO
    assert p["buildMode"] == "auto"
    assert (p["pgReadsPerGraph"], p["pgReadsPerProcess"]) == (6, 6)


async def test_a_saved_value_wins_and_an_unset_one_is_the_default():
    p = await bp.resolve(_Session(_row(copyMarginPct=150, noRoomPolicy="in_place")))
    assert (p["copyMarginPct"], p["noRoomPolicy"]) == (150, "in_place")
    assert p["warmSecs"] == config.PROJECTION_CANDIDATE_WARM_SECS


async def test_the_memo_is_read_again_when_a_save_moves_the_generation(_fresh_memo):
    session = _Session(_row(warmSecs=40))
    assert (await bp.resolve(session))["warmSecs"] == 40
    session.row = _row(warmSecs=50)
    assert (await bp.resolve(session))["warmSecs"] == 40, "memoized"
    _fresh_memo["value"] = "2"                       # another process saved
    bp._MEMO["gen_at"] = 0.0                          # its next look at the generation
    assert (await bp.resolve(session))["warmSecs"] == 50
    assert session.reads == 2


async def test_an_unreadable_row_keeps_the_last_good_policy_and_never_raises():
    assert (await bp.resolve(_Session(fail=True)))["warmSecs"] == config.PROJECTION_CANDIDATE_WARM_SECS
    bp._MEMO.update(policy=None, at=0.0)
    await bp.resolve(_Session(_row(warmSecs=40)))
    bp._MEMO.update(policy=None, at=0.0)
    assert (await bp.resolve(_Session(fail=True)))["warmSecs"] == 40


@pytest.mark.parametrize("body, field", [
    ({"nope": 1}, "nope"),
    ({"buildAboveRows": 10}, "buildAboveRows"),
    ({"buildAboveRows": "200000"}, "buildAboveRows"),
    ({"buildForRebuilds": "yes"}, "buildForRebuilds"),
    ({"buildMode": "sideways"}, "buildMode"),
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
    bp.validate({"copyMarginPct": -1, "pacingRatio": -1, "buildMode": -1, "warmSecs": None}, {})
    assert bp.merged({"copyMarginPct": 150, "warmSecs": 40}, {"copyMarginPct": -1, "warmSecs": None}) \
        == {"copyMarginPct": None, "warmSecs": 40}


# ── the routes ───────────────────────────────────────────────────────────────────────────────
_ADMIN = SimpleNamespace(id="usr_admin")


async def _put(body, session, recorded=None):
    async def record(session, event_type, **fields):
        (recorded if recorded is not None else []).append((event_type, fields))
        return True

    async def invalidate():
        bp._MEMO.update(policy=None, at=0.0)

    with patch.object(va.recorder, "record_for_request", record), \
            patch.object(bp, "invalidate", invalidate):
        return await va.put_build_policy(body, user=_ADMIN, session=session)


async def test_get_describes_each_value_and_how_the_card_shows_it():
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


async def test_put_saves_what_it_names_records_from_and_to_and_moves_the_generation():
    session, recorded = _Session(_row(warmSecs=40)), []
    out = await _put({"copyMarginPct": 150, "noRoomPolicy": "in_place", "warmSecs": -1},
                     session, recorded)
    saved = json.loads(session.row.gv_build_policy)
    assert saved["values"] == {"copyMarginPct": 150, "noRoomPolicy": "in_place"}
    assert saved["updatedBy"] == "usr_admin" and saved["updatedAt"]
    assert session.row.updated_by == "usr_admin" and session.commits == 1
    assert out["values"]["copyMarginPct"]["effective"] == 150
    assert out["values"]["warmSecs"]["saved"] is None
    assert recorded == [("platform.build_policy.updated", {"details": {
        "from": {"copyMarginPct": None, "noRoomPolicy": None, "warmSecs": 40},
        "to": {"copyMarginPct": 150, "noRoomPolicy": "in_place", "warmSecs": None}}})]


async def test_a_save_that_changes_nothing_records_nothing():
    session, recorded = _Session(_row(warmSecs=40)), []
    await _put({"warmSecs": 40}, session, recorded)
    assert recorded == []


async def test_a_bad_value_is_a_422_naming_it_and_saves_nothing():
    session = _Session(_row())
    with pytest.raises(HTTPException) as exc:
        await _put({"copyMarginPct": 50}, session)
    assert exc.value.status_code == 422
    assert exc.value.detail["type"] == "invalid_build_policy"
    assert exc.value.detail["field"] == "copyMarginPct"
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
