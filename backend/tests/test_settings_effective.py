"""``settings.effective``: the value in force, from this process's snapshot, with no IO in ``value``.

The snapshot and the feature switches are stand-ins; the registry is the real one."""
from __future__ import annotations

import asyncio

import pytest

from backend.app.services.settings import effective, registry
from backend.app.services.settings.resolver import Row, context, effective as resolve_one, index


class _Snapshot:
    def __init__(self, rows=()):
        self.rows_now = index(rows)
        self.asked = []

    async def rows(self, *, strict=False):
        self.asked.append(strict)
        return self.rows_now


@pytest.fixture
def snap(monkeypatch):
    s = _Snapshot()
    switches = {"candidateKeysEnabled": False, "residencyEnabled": False}

    async def read_switches(keys):
        return {k: switches.get(k) for k in keys}

    monkeypatch.setattr(effective, "snapshot", lambda: s)
    monkeypatch.setattr(effective, "_read_switches", read_switches)
    effective.reset()
    s.switches = switches
    yield s
    effective.reset()


def _run(coro):
    return asyncio.run(coro)


def test_before_any_refresh_every_value_is_the_default(snap):
    defaults = context(registry().SETTINGS, {})
    for key in ("updates.pacingRatio", "reads.mode", "drafts.keepClosedDays"):
        assert effective.value(key) == resolve_one(defaults, key)
    assert snap.asked == []                         # value() did no IO


def test_a_refresh_brings_the_saved_values(snap):
    snap.rows_now = index([Row("updates.pacingRatio", "platform", "", 1.5, rev=1)])
    _run(effective.refresh())
    assert effective.value("updates.pacingRatio") == 1.5


def test_a_graph_resolves_through_its_workspace(snap):
    snap.rows_now = index([Row("reads.mode", "workspace", "ws-1", "in_place", rev=1)])
    _run(effective.refresh())
    assert effective.value("reads.mode", workspace_id="ws-1") == "in_place"
    assert effective.value("reads.mode", workspace_id="ws-1", graph_id="ds-1") == "in_place"
    assert effective.value("reads.mode", workspace_id="ws-2", graph_id="ds-2") == "latest"


def test_switch_when_ready_falls_back_while_builds_are_off(snap):
    snap.rows_now = index([Row("reads.mode", "platform", "", "beside", rev=1)])
    _run(effective.refresh())
    assert effective.value("reads.mode") == "in_place"
    snap.switches["candidateKeysEnabled"] = True
    _run(effective.refresh())
    assert effective.value("reads.mode") == "beside"
    assert effective.value("reads.mode", workspace_id="ws", graph_id="ds",
                           graph_facts={"platform_copy": False}) == "in_place"


def test_a_strict_setting_asks_at_once(snap):
    assert registry().BY_KEY["drafts.levels"].freshness == "strict"
    _run(effective.value_of("drafts.levels", workspace_id="ws"))
    _run(effective.value_of("updates.pacingRatio"))
    assert snap.asked == [True, False]


def test_the_context_is_rebuilt_only_when_something_changed(snap):
    first = _run(effective.refresh())
    assert _run(effective.refresh()) is first       # same rows, same switches
    snap.rows_now = index([Row("updates.pacingRatio", "platform", "", 2.0, rev=2)])
    assert _run(effective.refresh()) is not first
