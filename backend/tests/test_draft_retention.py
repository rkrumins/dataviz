"""Draft retention: how long a merged or abandoned draft keeps its changes (Admin → Versioned graphs →
Draft retention). Covered here, without a database:
- where it is stored (``platform_settings.gv_draft_retention_days``, migration
  ``20261111_1000_gv_draft_prune``);
- how it resolves (``draft_retention``);
- the system administrator's routes;
- what the versioning worker's sweep does with it each pass.

What a pass removes and keeps is tests/integration/test_draft_prune.py, against live Postgres.

Pins:
- The window is the saved value, else the environment's (30), within range. 0 keeps changes for
  good.
- A setting that cannot be read removes nothing, rather than falling back to the default.
- The routes save it, record it once, and refuse what is out of range.
- Each pass removes with the window in force, and a failure never fails the sweep.
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


def test_the_window_is_the_saved_value_else_the_default_within_range():
    assert config.DRAFT_RETENTION_DAYS == 30
    assert [draft_retention.effective(v) for v in (None, 7, 0, -3, 10**6)] == [30, 7, 0, 0, 3650]
    assert draft_retention.describe(None) == {"days": 30, "saved": None, "default": 30,
                                              "min": 0, "max": 3650}
    saved = draft_retention.describe(PlatformSettingsORM(id=1, gv_draft_retention_days=90))
    assert (saved["days"], saved["saved"], saved["default"]) == (90, 90, 30)


async def test_a_setting_that_cannot_be_read_removes_nothing(monkeypatch):
    from backend.app.db import engine

    def unreachable():
        raise ConnectionError("the management database is down")

    monkeypatch.setattr(engine, "get_readonly_session", unreachable)
    assert await draft_retention.retention_days() is None


class _Session:
    def __init__(self, row=None):
        self.row, self.commits = row, 0

    async def get(self, cls, pk):
        assert (cls, pk) == (PlatformSettingsORM, 1)
        return self.row

    def add(self, row):
        self.row = row

    async def commit(self):
        self.commits += 1


async def _put(days, session, recorded):
    async def record(session, event_type, **fields):
        recorded.append((event_type, fields))
        return True

    with patch.object(va.recorder, "record_for_request", record):
        return await va.put_draft_retention(va.DraftRetentionChange(days=days), user=_ADMIN,
                                            session=session)


async def test_the_routes_read_save_and_record_the_window():
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


async def _sweep(monkeypatch, days, versioning):
    from backend.app.services import draft_views
    from backend.app.services.storage import object_store
    from backend.app.services.versioning.import_export import import_worker, uploads
    from backend.app.services.versioning.worker import ProjectionWorker
    from backend.app.services.view_transfer import package

    async def nothing(*_args, **_kwargs):
        return 0

    async def window():
        return days

    monkeypatch.setattr(draft_retention, "retention_days", window)
    monkeypatch.setattr(import_worker, "sweep_staged_rows", nothing)
    monkeypatch.setattr(draft_views, "settle", nothing)
    monkeypatch.setattr(uploads, "jobs_input_prefixes", nothing)
    monkeypatch.setattr(package, "prune_uploads", nothing)
    monkeypatch.setattr(object_store, "get_object_store", lambda: SimpleNamespace(sweep=nothing))
    return await ProjectionWorker(None, versioning=versioning).sweep_once()


async def test_each_pass_removes_with_the_window_in_force_and_never_fails_the_sweep(monkeypatch):
    asked = []

    class _Versioning:
        async def sweep_idle_drafts(self):
            return ["br_idle"]

        async def prune_closed_drafts(self, *, older_than_days):
            asked.append(older_than_days)
            if older_than_days == 1:
                raise RuntimeError("the database went away mid-pass")
            return []

    for days in (12, 0, None, 1):
        assert await _sweep(monkeypatch, days, _Versioning()) == ["br_idle"]
    assert asked == [12, 1], "0 keeps every draft's changes; an unread window removes nothing"
