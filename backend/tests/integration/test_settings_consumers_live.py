"""What reads and saves versioned-graph settings through the store, against Postgres and Redis.

An old endpoint's save goes through the store (``settings.legacy.save``). It is checked against each
value's version, attributed ``legacy_api`` with the request's stated reason, and written through to
the old columns, a data source's forks' too. Its activity record runs in the same transaction, and
only when something changed. Through the process's real snapshot, a workspace's value then reaches
its graphs, a fork follows its root, and the sweeps get each workspace's window.

Each module builds a database of its own with the upgrade CLI (``test_settings_store_live``).
Needs ``GRAPHVER_E2E=1``, ``MANAGEMENT_DB_URL`` (a role that may create databases) and the bus
Redis.
"""
from __future__ import annotations

import os
from typing import Iterator

import pytest

from backend.app.common import activity_context
from backend.app.services import drafts_policy, import_settings
from backend.app.services.settings import effective, legacy, store
from backend.tests.integration.test_settings_store_live import (  # noqa: F401 — fixtures
    data_source, engines_at, provider, query, redis_bus, scratch_database, seed, upgrade_cli,
    workspace)
from tests.common.settings_world import use_the_database

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres and Redis")


@pytest.fixture(scope="module")
def consumers_db() -> Iterator[str]:
    with scratch_database("settings_consumers") as name:
        upgrade_cli(name, "upgrade")
        seed(name, workspace("ws_1"), workspace("ws_2"), provider(), data_source("ds_1", "ws_1"),
             data_source("dsfork_1", "ws_1", fork_of="ds_1"), data_source("ds_2", "ws_2"))
        yield name


@pytest.fixture
async def db(consumers_db, engines_at, redis_bus, monkeypatch):  # noqa: F811 — fixtures
    engines_at(consumers_db)
    use_the_database(monkeypatch)
    return consumers_db


async def _save(scope: str, scope_id: str, values: dict, record=None, reason=None):
    from backend.app.db.engine import get_async_session

    token = activity_context.bind(activity_context.ActivityContext(stated_reason=reason))
    try:
        async with get_async_session() as s:
            return await legacy.save(s, scope, scope_id, values, actor="usr_a", record=record)
    finally:
        activity_context.reset(token)


async def test_an_old_endpoints_save_goes_through_the_store_and_its_old_columns(db):
    from backend.app.db.engine import get_async_session

    recorded = []

    async def record(_s, change_set):
        recorded.append([(a.key, a.before_value, a.after_value) for a in change_set.applied])

    saved = await _save("graph", "ds_1", {"drafts.levels": "private_only", "drafts.selfMerge": None},
                        record=record, reason="Keep drafts private")
    assert recorded == [[("drafts.levels", None, "private_only")]], "an unchanged value is left out"
    assert (saved.source, saved.actor, saved.reason) == ("legacy_api", "usr_a", "Keep drafts private")
    assert dict(query(db, "SELECT id, draft_levels FROM workspace_data_sources")) == {
        "ds_1": "private_only", "dsfork_1": "private_only", "ds_2": None}
    assert query(db, "SELECT source, reason, actor FROM setting_changes "
                     "WHERE key = 'drafts.levels'") == [("legacy_api", "Keep drafts private",
                                                          "usr_a")]
    async with get_async_session() as s:
        fork = await drafts_policy.load(s, "dsfork_1")
        assert (fork.levels, fork.default_visibility, dict(fork.sources)["levels"]) == (
            "private_only", "private", "data_source"), "a fork follows its root"
        assert (await drafts_policy.load(s, "ds_2")).levels == "any"

    again = await _save("graph", "ds_1", {"drafts.levels": "private_only"}, record=record)
    assert again.applied == () and len(recorded) == 1, "saving what is there records nothing"
    # Its version moved after it was read: nothing of the second save is kept.
    async with get_async_session() as s:
        [held] = [r for r in await store.read_scope(s, "versioned-graphs", "graph", "ds_1")
                  if r.key == "drafts.levels"]
    await _save("graph", "ds_1", {"drafts.levels": "public_only"})
    async with get_async_session() as s:
        with pytest.raises(store.SettingsConflict):
            await store.apply(s, "versioned-graphs", [store.Change(
                "drafts.levels", "graph", "ds_1", held.version, value="any")], actor="usr_b")
    assert query(db, "SELECT draft_levels FROM workspace_data_sources WHERE id = 'ds_1'") == [
        ("public_only",)]


async def test_a_workspaces_value_reaches_its_graphs_and_each_window_its_sweep(db):
    await _save("workspace", "ws_2", {"imports.identifier": "urn", "drafts.keepClosedDays": 7})
    await _save("platform", "", {"drafts.keepClosedDays": "forever"})
    found = await import_settings.effective("ws_2", "ds_2")
    assert (found["identifier"], found["sources"]["identifier"]) == ("urn", "workspace")
    assert (await import_settings.effective("ws_1", "ds_1"))["identifier"] == "entity_id"
    assert await effective.by_workspace("drafts.keepClosedDays") == [
        (7, ("ws_2",), ()), ("forever", None, ("ws_2",))]
    assert query(db, "SELECT gv_draft_retention_days FROM platform_settings") == [(0,)], \
        "forever, written through as the old column's 0"
