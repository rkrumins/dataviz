"""Draft retention: how long a merged or abandoned draft keeps its changes (Admin → Infrastructure →
Versioned graphs → Draft retention), and how long an idle draft stays open. Covered here, without a
database:
- where it is stored (``drafts.keepClosedDays`` in the settings store, written through to
  ``platform_settings.gv_draft_retention_days``, migration ``20261111_1000_gv_draft_prune``);
- how it resolves (``draft_retention``);
- the system administrator's routes;
- what the versioning worker's sweep does with it each pass.

What a pass removes and keeps is tests/integration/test_draft_prune.py, against live Postgres.

Pins:
- The platform's window is its saved value, else the environment's (30), within range. 0 (forever)
  keeps changes for good. The old column's reads the same (``draft_retention.effective``).
- Settings that cannot be read remove and close nothing, rather than falling back to the default.
- The routes save it through the store, record it once, and refuse what is out of range.
- Each pass removes with each window in force, once per window: a workspace's own for its graphs,
  the platform's for every other. Forever skips its window, and a failure never fails the sweep.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from pydantic import ValidationError

from backend.app.api.v1.endpoints import versioning_admin as va
from backend.app.db.models import PlatformSettingsORM
from backend.app.services.activity import catalogue
from backend.app.services.versioning import config, draft_retention
from backend.app.services.versioning.models import BranchORM

_MIGRATION = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "20261111_1000_gv_draft_prune.py"
_ADMIN = SimpleNamespace(id="usr_admin")


def test_the_setting_and_the_drafts_stamps_are_declared_and_migrated():
    assert PlatformSettingsORM.__table__.c["gv_draft_retention_days"].nullable
    assert all(BranchORM.__table__.c[c].nullable for c in ("pruned_at", "prune_finished_at"))
    spec = importlib.util.spec_from_file_location(_MIGRATION.stem, _MIGRATION)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    assert migration.revision == _MIGRATION.stem and len(migration.revision) <= 32
    assert migration.down_revision == "20261110_1000_gv_commit_prov"


async def test_the_window_is_the_saved_value_else_the_default_within_range(settings_world):
    assert config.DRAFT_RETENTION_DAYS == 30
    assert [draft_retention.effective(v) for v in (None, 7, 0, -3, 10**6)] == [30, 7, 0, 0, 3650]
    assert await draft_retention.describe(None) == {"days": 30, "saved": None, "default": 30,
                                                    "min": 0, "max": 3650}
    settings_world.set(draft_retention.KEY, "platform", "", 90)
    saved = await draft_retention.describe(None)
    assert (saved["days"], saved["saved"], saved["default"]) == (90, 90, 30)
    settings_world.set(draft_retention.KEY, "platform", "", "forever")
    assert (await draft_retention.describe(None))["days"] == 0


async def test_a_setting_that_cannot_be_read_removes_nothing(settings_world):
    from backend.app.services.settings import effective

    settings_world.readable = False
    for key in (draft_retention.KEY, "drafts.idleCloseDays", "trash.restoreDays"):
        assert await effective.by_workspace(key) is None, key


class _Session:
    def __init__(self, row=None):
        self.row, self.commits = row, 0

    async def get(self, cls, pk):
        assert (cls, pk) == (PlatformSettingsORM, 1)
        return self.row

    def add(self, row):
        self.row = row

    async def flush(self):
        pass

    async def commit(self):
        self.commits += 1

    async def rollback(self):
        pass


async def _put(days, session, recorded):
    async def record(session, event_type, **fields):
        recorded.append((event_type, fields))
        return True

    with patch.object(va.recorder, "record_for_request", record):
        return await va.put_draft_retention(va.DraftRetentionChange(days=days), user=_ADMIN,
                                            session=session)


async def test_the_routes_read_save_and_record_the_window(settings_world):
    assert (await va.get_draft_retention(_user=_ADMIN, session=_Session()))["days"] == 30
    session, recorded = _Session(), []
    out = await _put(7, session, recorded)
    assert (session.row.gv_draft_retention_days, session.row.updated_by, session.commits) == (
        7, "usr_admin", 1)
    assert (out["days"], out["saved"]) == (7, 7)
    assert recorded == [("platform.draft_retention.updated", {"details": {"from": None, "to": 7}})]
    await _put(7, session, recorded)                       # the same again: nothing to record
    assert len(recorded) == 1
    out = await _put(None, session, recorded)              # back to the default
    assert (out["days"], out["saved"], session.row.gv_draft_retention_days) == (30, None, None)
    assert recorded[-1] == ("platform.draft_retention.updated", {"details": {"from": 7, "to": None}})
    for out_of_range in (-1, 3651):
        with pytest.raises(ValidationError):
            va.DraftRetentionChange(days=out_of_range)
    assert catalogue.LABELS["platform.draft_retention.updated"]
    assert catalogue.category_of("platform.draft_retention.updated") == "platform"


async def _sweep(monkeypatch, versioning):
    from backend.app.services import draft_views
    from backend.app.services.storage import object_store
    from backend.app.services.versioning.import_export import import_worker, uploads
    from backend.app.services.versioning.worker import ProjectionWorker
    from backend.app.services.view_transfer import package

    async def nothing(*_args, **_kwargs):
        return 0

    monkeypatch.setattr(import_worker, "sweep_staged_rows", nothing)
    monkeypatch.setattr(draft_views, "settle", nothing)
    monkeypatch.setattr(uploads, "jobs_input_prefixes", nothing)
    monkeypatch.setattr(package, "prune_uploads", nothing)
    monkeypatch.setattr(object_store, "get_object_store", lambda: SimpleNamespace(sweep=nothing))
    return await ProjectionWorker(None, versioning=versioning).sweep_once()


async def test_each_pass_removes_with_the_window_in_force_and_never_fails_the_sweep(
        monkeypatch, settings_world):
    asked = []

    class _Versioning:
        async def sweep_idle_drafts(self, **_where):
            return ["br_idle"]

        async def prune_closed_drafts(self, *, older_than_days, **_where):
            asked.append(older_than_days)
            if older_than_days == 1:
                raise RuntimeError("the database went away mid-pass")
            return []

    for days in (12, "forever", 1):
        settings_world.set(draft_retention.KEY, "platform", "", days)
        assert await _sweep(monkeypatch, _Versioning()) == ["br_idle"]
    assert asked == [12, 1], "forever keeps every draft's changes"
    settings_world.readable = False
    assert await _sweep(monkeypatch, _Versioning()) == [], "unread: nothing is closed"
    assert asked == [12, 1], "unread: nothing is removed"


async def test_each_window_runs_once_for_its_own_workspaces_and_forever_skips_it(
        monkeypatch, settings_world):
    calls = []

    class _Versioning:
        async def sweep_idle_drafts(self, **kw):
            calls.append(("close", kw["ttl_days"], kw["workspace_ids"], kw["except_workspace_ids"]))
            return []

        async def prune_closed_drafts(self, **kw):
            calls.append(("remove", kw["older_than_days"], kw["workspace_ids"],
                          kw["except_workspace_ids"]))
            return []

    for ws, days in (("ws_a", 7), ("ws_b", 7), ("ws_keep", "forever"), ("ws_same", 30)):
        settings_world.set(draft_retention.KEY, "workspace", ws, days)
    settings_world.set(draft_retention.KEY, "platform", "", 30)
    settings_world.set("drafts.idleCloseDays", "platform", "", "forever")
    settings_world.set("drafts.idleCloseDays", "workspace", "ws_a", 14)
    await _sweep(monkeypatch, _Versioning())
    assert calls == [
        ("close", 14, ("ws_a",), ()),                          # the platform's is forever
        ("remove", 7, ("ws_a", "ws_b"), ()),                   # ws_keep's is forever
        ("remove", 30, None, ("ws_a", "ws_b", "ws_keep")),     # ws_same takes the platform's
    ]
