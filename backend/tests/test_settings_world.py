"""The settings store in memory that every test starts with (``conftest._settings_in_memory``,
``tests/common/settings_world.py``).

Pins:
- With nothing saved, every setting is its default, read from memory: the process's snapshot is
  the world's, which asks nothing of Redis or a database.
- A value set is in the next read, and a graph takes its workspace's.
- ``settings_world`` stands in for ``store.apply`` as the store saves: each value checked against
  its version, ``before_commit`` in the session's transaction, then a commit, and nothing kept when
  either fails.
- Out of reach, the last rows serve and ``effective.readable()`` says so, until they can be read
  again.
- A test against the database puts a real snapshot back (``use_the_database``).
"""
from __future__ import annotations

import pytest

from backend.app.services.settings import effective, registry, store
from backend.app.services.settings import snapshot as snapshots
from backend.app.services.settings.store import Change, SettingsConflict
from backend.app.services.versioning import config


class _Session:
    def __init__(self):
        self.done = []

    async def commit(self):
        self.done.append("commit")

    async def rollback(self):
        self.done.append("rollback")


async def test_every_test_starts_with_an_empty_store_in_memory(_settings_in_memory):
    assert snapshots.snapshot() is _settings_in_memory.snapshot
    assert effective.readable() is False              # nothing read yet
    assert await effective.value_of("drafts.levels", workspace_id="ws_1", graph_id="ds_1") == "any"
    assert await effective.value_of("forks.maxPerGraph") == config.MAX_FORKS_PER_GRAPH
    assert effective.readable() is True


async def test_a_value_set_is_in_the_next_read(settings_world):
    await effective.refresh()
    settings_world.set("drafts.levels", "workspace", "ws_1", "private_only")
    assert await effective.value_of("drafts.levels", workspace_id="ws_1",
                                    graph_id="ds_1") == "private_only"
    assert await effective.value_of("drafts.levels", workspace_id="ws_2", graph_id="ds_2") == "any"
    settings_world.set("forks.maxPerGraph", "platform", "", 3)
    await effective.refresh()
    assert effective.value("forks.maxPerGraph", workspace_id="ws_1", graph_id="ds_1") == 3
    with pytest.raises(KeyError):
        settings_world.set("drafts.nothing", "platform", "", 1)


async def test_apply_saves_all_or_nothing_against_each_values_version(settings_world):
    domain, session, seen = registry().DOMAIN, _Session(), []

    async def hook(s, change_set):
        seen.append((s, [(a.key, a.before_value, a.after_value, a.version)
                         for a in change_set.applied]))

    saved = await store.apply(session, domain, [
        Change("drafts.levels", "workspace", "ws_1", 0, value="public_only"),
        Change("drafts.selfMerge", "workspace", "ws_1", 0, value=None)],       # changes nothing
        actor="usr_a", reason="why", source="legacy_api", before_commit=hook)
    assert seen == [(session, [("drafts.levels", None, "public_only", 1)])]
    assert (saved.actor, saved.reason, saved.source, session.done) == (
        "usr_a", "why", "legacy_api", ["commit"])
    [row] = await store.read_scope(session, domain, "workspace", "ws_1")
    assert (row.value, row.version, row.updated_by) == ("public_only", 1, "usr_a")
    assert await effective.value_of("drafts.levels", workspace_id="ws_1",
                                    graph_id="ds_1") == "public_only"

    with pytest.raises(SettingsConflict) as caught:
        await store.apply(session, domain, [Change("drafts.levels", "workspace", "ws_1", 0,
                                                   value="any")], actor="usr_b")
    assert caught.value.keys == ["drafts.levels"] and session.done[-1] == "rollback"

    async def refuse(s, change_set):
        raise RuntimeError("the activity record failed")

    with pytest.raises(RuntimeError):
        await store.apply(session, domain, [Change("drafts.levels", "workspace", "ws_1", 1,
                                                   value="any")], actor="usr_b",
                          before_commit=refuse)
    assert settings_world.rows[("drafts.levels", "workspace", "ws_1")].value == "public_only"
    assert len(settings_world.saves) == 1 and session.done[-1] == "rollback"


def test_a_test_against_the_database_puts_a_real_snapshot_back(_settings_in_memory, monkeypatch):
    from tests.common.settings_world import use_the_database

    real = use_the_database(monkeypatch)
    assert snapshots.snapshot() is real and real is not _settings_in_memory.snapshot
    assert real._load is snapshots.load_rows and real._generation is snapshots.read_generation


async def test_out_of_reach_the_last_rows_serve_and_readable_says_so(settings_world):
    settings_world.set("drafts.keepClosedDays", "platform", "", 7)
    assert await effective.value_of("drafts.keepClosedDays") == 7 and effective.readable()
    settings_world.readable = False
    assert await effective.value_of("drafts.keepClosedDays") == 7
    assert effective.readable() is False
    settings_world.readable = True
    await effective.refresh()
    assert effective.readable() is True
