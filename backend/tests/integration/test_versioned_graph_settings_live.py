"""Versioned-graph settings over HTTP against Postgres and Redis: the routes in front of the real
store (``services.settings.store``), with the old storage written through and the graph store read
for a workspace's graphs, the drafts a shorter window removes and the inventory.

* A save at each scope round-trips, and the old storage and the activity log hear of it once.
* A value changed since it was read is a conflict, and nothing is saved.
* A residency class saved at any scope reaches the rows of the graphs it covers in the graph
  store, where the evictor reads it, except while a separate graph store's own values wait for
  their import.
* History is scoped: system administrators see every change, a workspace its own and its
  graphs', a graph its own. Its filters and pages hold, and it names who made each change.
* A change set is put back, checked as a save is: another place's is not found (404), one changed
  since is a conflict (409), and one holding a value its editor may not set is refused (403).
* The full preview finds the graphs a change reaches and counts the closed drafts a shorter
  window removes, in the graph store.
* The inventory filters by the read mode in force, the class and whether a graph chose settings
  of its own, and its summary counts the fleet.

Its database is its own, built with the upgrade CLI, as ``test_settings_store_live.py`` builds
one. Needs ``GRAPHVER_E2E=1``, ``MANAGEMENT_DB_URL`` (a role that may create databases) and the
coordination bus Redis.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from typing import Iterator

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import create_engine, text

from backend.app.api.v1.endpoints import versioning_admin as va
from backend.app.auth.dependencies import get_current_user, get_permission_claims
from backend.app.common import activity_context
from backend.app.db.models import UserORM, WorkspaceORM
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.settings import facts
from backend.app.services.system_status import probes
from backend.app.services.versioning import route_cache
from backend.auth_service.cookies import CSRF_COOKIE_NAME
from backend.auth_service.csrf import CSRF_HEADER_NAME
from backend.auth_service.interface import User
from backend.tests.integration.test_settings_store_live import (  # noqa: F401 — fixtures
    data_source, db_url, engines_at, graph, graph_store_tables, provider, query, redis_bus,
    scratch_database, seed, upgrade_cli)

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres and Redis")

_P = "/api/v1/admin/versioning/settings"
_W1, _W2 = "/api/v1/ws_1/versioning/settings", "/api/v1/ws_2/versioning/settings"
_G1 = "/api/v1/ws_1/versioning/graphs/graph_1/settings"
_GB = 1 << 30
_CSRF = "test-csrf-token"
_LEAVES = ("workspace:datasource:read", "workspace:datasource:manage", "workspace:view:read")
PEOPLE = {
    "usr_root": PermissionClaims(sid="sess_live", global_perms=("system:admin",)),
    "usr_wsadmin": PermissionClaims(sid="sess_live",
                                    ws_perms={"ws_1": ("workspace:admin",) + _LEAVES}),
}


def _draft_tables(name: str) -> None:
    """The graph store's drafts, reviews and jobs, which a closed draft's count reads."""
    from backend.app.services.versioning.db import VersioningBase
    from backend.app.services.versioning.models import BranchORM, JobORM, MergeRequestORM

    engine = create_engine(db_url(name, "psycopg2"))
    with engine.begin() as conn:
        VersioningBase.metadata.create_all(conn, tables=[
            BranchORM.__table__, MergeRequestORM.__table__, JobORM.__table__])
    engine.dispose()


def _closed_draft(branch_id: str, graph_id: str, days_ago: int):
    from backend.app.services.versioning.models import BranchORM

    at = (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()
    return BranchORM(id=branch_id, graph_id=graph_id, kind="draft", name=branch_id,
                     status="merged", updated_at=at, created_at=at)


def _person(user_id: str, first: str) -> UserORM:
    return UserORM(id=user_id, email=f"{user_id}@example.com", password_hash="x",
                   first_name=first, last_name="Example", status="active",
                   created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z")


@pytest.fixture(scope="module")
def api_db() -> Iterator[str]:
    with scratch_database("settings_api") as name:
        upgrade_cli(name, "upgrade")
        graph_store_tables(name)
        _draft_tables(name)
        seed(name, WorkspaceORM(id="ws_1", name="Finance"), WorkspaceORM(id="ws_2", name="Sales"),
             provider(), data_source("ds_1", "ws_1", label="Ledger"),
             data_source("dsfork_1", "ws_1", fork_of="ds_1"),
             data_source("ds_2", "ws_2", label="Pipeline"),
             _person("usr_root", "Rosa"), _person("usr_wsadmin", "Wes"),
             *graph("graph_1", "ds_1", "ws_1", owns_falkor_graph=True, residency="always",
                    falkor_graph_name="g_ds_1", projected_commit_seq=1, size_bytes=4 * _GB),
             *graph("graph_fork", "dsfork_1", "ws_1", fork_of="graph_1"),
             *graph("graph_2", "ds_2", "ws_2", owns_falkor_graph=False,
                    falkor_graph_name="g_ds_2", status="evicted"),
             # Closed 10 days ago: a window of 7 days removes its changes, one of 30 keeps them.
             _closed_draft("br_closed", "graph_1", 10), _closed_draft("br_old", "graph_1", 40))
        yield name


@pytest.fixture
async def client(api_db, engines_at, redis_bus, monkeypatch):  # noqa: F811 — fixtures
    """The app over the scratch database, signed in as whoever ``as_`` names."""
    from backend.app.main import app

    engines_at(api_db)
    who = {"id": "usr_root"}

    async def current_user():
        activity_context.bind_actor(who["id"])
        return User(id=who["id"], email=f"{who['id']}@example.com", first_name="A",
                    last_name="B", role="user", status="active")

    announced = []

    async def announce(graph_ids=(), *, graph_set=False, every=False):
        announced.append((sorted(graph_ids), every))
        return True

    async def nodes():
        return [{"name": "falkor-0:6379", "usedBytes": 4 * _GB, "maxBytes": 16 * _GB}]

    monkeypatch.setattr(route_cache, "announce", announce)
    monkeypatch.setattr(facts, "_nodes", nodes)
    app.dependency_overrides[get_current_user] = current_user
    app.dependency_overrides[get_permission_claims] = lambda: PEOPLE[who["id"]]
    async with AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False),
                           base_url="http://testserver", cookies={CSRF_COOKIE_NAME: _CSRF},
                           headers={CSRF_HEADER_NAME: _CSRF}) as c:
        c.who, c.announced = who, announced
        yield c
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_permission_claims, None)
    _reset(api_db)


def _reset(name: str) -> None:
    """Nothing saved, for the next test: the store's rows, history and one-time imports, the old
    storage, and the graphs' classes as seeded."""
    engine = create_engine(db_url(name, "psycopg2"))
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM setting_values"))
        conn.execute(text("DELETE FROM setting_changes"))
        conn.execute(text("DELETE FROM settings_imports"))
        conn.execute(text("DELETE FROM outbox_events"))
        conn.execute(text("DELETE FROM platform_settings"))
        conn.execute(text("UPDATE workspaces SET draft_levels = NULL"))
        conn.execute(text("UPDATE workspace_data_sources SET import_identifier = NULL"))
        conn.execute(text("UPDATE graphver.projection_state SET read_mode = NULL, residency = "
                          "CASE graph_id WHEN 'graph_1' THEN 'always' ELSE 'standard' END"))
    engine.dispose()


def as_(c, person: str) -> None:
    c.who["id"] = person


def _change(key, value, version=0, **kw):
    return {"key": key, "value": value, "expectedVersion": version, **kw}


def _save(*changes, reason=None):
    return {"changes": list(changes), **({"reason": reason} if reason else {})}


def _value(body, key):
    return next(v for v in body["values"] if v["key"] == key)


async def _patch(c, path, *changes, status=200, **kw):
    got = await c.patch(path, json=_save(*changes, **kw))
    assert got.status_code == status, got.text
    return got.json()


# ── Saving ────────────────────────────────────────────────────────────────────────────────────────
async def test_a_save_at_each_scope_round_trips_through_the_store(client, api_db):
    allowed = {"allowed": ["latest", "in_place", "beside"]}
    await _patch(client, _P, _change("reads.mode", "in_place", limits=allowed),
                 reason="Serve while updating")
    await _patch(client, _W1, _change("drafts.levels", "public_only"))
    saved = await _patch(client, _G1, _change("imports.identifier", "urn"),
                         _change("reads.mode", "beside"))
    assert saved["changeSetId"]
    mode = _value(saved, "reads.mode")
    # New-version builds are off, so "switch when ready" updates in place for now.
    assert (mode["effective"], mode["declared"], mode["source"], mode["status"]) == (
        "in_place", "beside", "graph", "adjusted")
    assert [t["value"] for t in mode["trail"]] == ["latest", "in_place", None, "beside"]
    assert (await client.get(_G1)).json() == {k: v for k, v in saved.items()
                                              if k != "changeSetId"}
    # The old storage: a rollback to the previous image behaves as configured.
    policy = json.loads(query(api_db, "SELECT gv_build_policy FROM platform_settings")[0][0])
    assert policy["values"] == {"readMode": "in_place"}
    assert query(api_db, "SELECT draft_levels FROM workspaces WHERE id = 'ws_1'")[0][0] == \
        "public_only"
    assert query(api_db, "SELECT import_identifier FROM workspace_data_sources "
                         "WHERE id = 'ds_1'")[0][0] == "urn"
    assert query(api_db, "SELECT read_mode FROM graphver.projection_state "
                         "WHERE graph_id = 'graph_1'")[0][0] == "beside"
    # One event per save, in the transaction that made it.
    events = query(api_db, "SELECT event_type, payload FROM outbox_events ORDER BY created_at")
    assert [e.event_type for e in events] == [
        "platform.versioning.settings_updated", "workspace.versioning.settings_updated",
        "workspace.versioning.graph_settings_updated"]
    first = json.loads(events[0].payload)
    assert first["details"]["limits"] == {"reads.mode": {"from": None, "to": allowed}}
    assert first["stated_reason"] == "Serve while updating"
    reasons = query(api_db, "SELECT reason, source FROM setting_changes WHERE key = 'reads.mode' "
                            "AND scope = 'platform'")
    assert [tuple(r) for r in reasons] == [("Serve while updating", "api")]
    # A routing save moves the routes it reaches: every graph's for the platform's; graph_1's for
    # its own, once as the write-through's graph-store commit and again once the settings' own
    # commit has moved their generation, which is the one a route read again relies on.
    assert client.announced == [([], True), (["graph_1"], False), (["graph_1"], False)]


async def test_a_workspace_admin_saves_within_limits_and_not_what_only_system_admins_may(client):
    as_(client, "usr_wsadmin")
    await _patch(client, _W1, _change("reads.mode", "beside"), status=422)
    refused = await _patch(client, _W1, _change("residency.class", "coldline"), status=403)
    assert refused["detail"]["denied"][0]["editor"] == "system_admin"
    await _patch(client, _W2, _change("drafts.levels", "any"), status=403)
    saved = await _patch(client, _W1, _change("reads.mode", "in_place"))
    assert _value(saved, "reads.mode")["source"] == "workspace"
    # The workspace's graphs heard of it, read from the graph store: the fork with its root.
    assert client.announced == [(["graph_1", "graph_fork"], False)]


async def test_a_value_changed_since_it_was_read_is_a_conflict_and_nothing_is_saved(client,
                                                                                    api_db):
    await _patch(client, _W1, _change("drafts.levels", "any"))
    stale = await _patch(client, _W1, _change("drafts.selfMerge", False),
                         _change("drafts.levels", "public_only", 0), status=409)
    assert stale["detail"]["conflicts"] == [{"key": "drafts.levels", "scope": "workspace",
                                             "scopeId": "ws_1", "expected": 0, "actual": 1}]
    assert query(api_db, "SELECT count(*) FROM setting_values WHERE key = 'drafts.selfMerge'"
                 )[0][0] == 0


# ── Each graph's residency class, on its row ──────────────────────────────────────────────────────
def _classes(name: str) -> dict:
    return dict(query(name, "SELECT graph_id, residency FROM graphver.projection_state"))


def _mark(name: str, marker: str) -> None:
    """A one-time import marked as run (``settings_imports``)."""
    engine = create_engine(db_url(name, "psycopg2"))
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO settings_imports (name) VALUES (:n)"), {"n": marker})
    engine.dispose()


async def test_a_class_saved_at_each_scope_reaches_the_rows_of_the_graphs_it_covers(client,
                                                                                   api_db):
    """The evictor reads each graph's class on its row, so a save writes it there: a workspace's
    class reaches its graphs, a graph's own class wins, the platform's reaches the graphs with
    neither, and a fork, which reads through its root's key, has none of its own."""
    await _patch(client, _W1, _change("residency.class", "coldline"))
    assert _classes(api_db) == {"graph_1": "coldline", "graph_fork": "standard",
                                "graph_2": "standard"}
    await _patch(client, _G1, _change("residency.class", "standard"))
    await _patch(client, _P, _change("residency.class", "always"))
    assert _classes(api_db) == {"graph_1": "standard", "graph_fork": "standard",
                                "graph_2": "always"}
    await _patch(client, _W1, _change("residency.class", None, 1))
    assert _classes(api_db)["graph_1"] == "standard"                     # its own, still
    await _patch(client, _G1, _change("residency.class", None, 1))
    assert _classes(api_db)["graph_1"] == "always"                       # the platform's


async def test_while_the_graphs_values_wait_for_their_import_no_row_is_re_classed(client,
                                                                                api_db):
    """With the graph store in a database of its own, the import migration leaves the graphs'
    own values to the worker's start-up import (``legacy`` without ``legacy_graph``). Meanwhile
    a class saved for a workspace or the platform re-classes no graph, so a rollout changes
    none; one saved for a graph does. Once imported, the next memory check writes the rest."""
    from backend.app.services.versioning import residency

    _mark(api_db, "legacy")
    await _patch(client, _W1, _change("residency.class", "coldline"))
    await _patch(client, _P, _change("residency.class", "coldline"))
    assert _classes(api_db) == {"graph_1": "always", "graph_fork": "standard",
                                "graph_2": "standard"}
    await _patch(client, _G1, _change("residency.class", "standard"))
    assert _classes(api_db)["graph_1"] == "standard"
    _mark(api_db, "legacy_graph")
    assert await residency.keep_classes() == ["graph_2"]
    assert _classes(api_db) == {"graph_1": "standard", "graph_fork": "standard",
                                "graph_2": "coldline"}


# ── History and revert ────────────────────────────────────────────────────────────────────────────
async def _history(c, path, **params):
    got = await c.get(path + "/history", params=params)
    assert got.status_code == 200, got.text
    return got.json()


async def test_history_is_scoped_filtered_and_paged(client):
    await _patch(client, _P, _change("updates.pacingRatio", 0.5))
    await _patch(client, _W2, _change("drafts.levels", "any"))
    as_(client, "usr_wsadmin")
    await _patch(client, _W1, _change("drafts.levels", "public_only"), reason="Open reviews")
    await _patch(client, _G1, _change("imports.identifier", "urn"))

    workspace = await _history(client, _W1)
    assert [(e["key"], e["scope"], e["scopeId"]) for e in workspace["entries"]] == [
        ("imports.identifier", "graph", "ds_1"), ("drafts.levels", "workspace", "ws_1")]
    entry = workspace["entries"][1]
    assert entry | {"id": None, "changeSetId": None, "at": None} == {
        "id": None, "changeSetId": None, "at": None, "reason": "Open reviews", "source": "api",
        "actor": {"id": "usr_wsadmin", "name": "Wes Example"}, "key": "drafts.levels",
        "scope": "workspace", "scopeId": "ws_1", "version": 1,
        "from": {"value": None, "limits": None}, "to": {"value": "public_only", "limits": None}}
    assert [e["key"] for e in (await _history(client, _G1))["entries"]] == ["imports.identifier"]
    assert (await client.get(_W2 + "/history")).status_code == 403     # not their workspace
    assert (await client.get(_P + "/history")).status_code == 403

    as_(client, "usr_root")
    everything = await _history(client, _P)
    assert [e["key"] for e in everything["entries"]] == [
        "imports.identifier", "drafts.levels", "drafts.levels", "updates.pacingRatio"]
    assert [e["key"] for e in (await _history(client, _P, scope="platform"))["entries"]] == [
        "updates.pacingRatio"]
    assert [e["scopeId"] for e in (await _history(client, _P, key="drafts.levels"))["entries"]
            ] == ["ws_1", "ws_2"]
    assert len((await _history(client, _P, actor="usr_wsadmin"))["entries"]) == 2
    newest = everything["entries"][0]["at"]
    assert [e["key"] for e in (await _history(client, _P, since=newest))["entries"]] == [
        "imports.identifier"]
    assert "imports.identifier" not in [
        e["key"] for e in (await _history(client, _P, until=newest))["entries"]]
    page = await _history(client, _P, limit=3)
    rest = await _history(client, _P, limit=3, cursor=page["nextCursor"])
    assert [e["id"] for e in page["entries"] + rest["entries"]] == [
        e["id"] for e in everything["entries"]] and rest["nextCursor"] is None


async def test_a_change_set_is_put_back_checked_as_a_save_is(client, api_db):
    platform = await _patch(client, _P, _change("updates.pacingRatio", 0.5))
    system_only = await _patch(client, _W1, _change("residency.class", "coldline"))
    as_(client, "usr_wsadmin")
    graph_save = await _patch(client, _G1, _change("imports.identifier", "urn"))

    # Another place's change set is not this workspace's to see, nor one that doesn't exist.
    for change_set in (platform["changeSetId"], "00000000-0000-0000-0000-000000000000"):
        got = await client.post(f"{_W1}/history/{change_set}/revert", json={})
        assert got.status_code == 404, got.text
    # A value only a system administrator may set is put back only by one.
    refused = await client.post(f"{_W1}/history/{system_only['changeSetId']}/revert")
    assert refused.status_code == 403
    assert refused.json()["detail"]["type"] == "setting_not_permitted"
    # The graph's change, put back through its workspace: the answer is the graph's values.
    undone = await client.post(f"{_W1}/history/{graph_save['changeSetId']}/revert",
                               json={"reason": "Wrong identifier"})
    assert undone.status_code == 200, undone.text
    body = undone.json()
    assert (body["scope"], body["graphId"], body["dataSourceId"]) == ("graph", "graph_1", "ds_1")
    assert _value(body, "imports.identifier")["source"] != "graph"
    assert query(api_db, "SELECT source, reason FROM setting_changes WHERE change_set = "
                         "CAST(:c AS uuid)", c=body["changeSetId"])[0] == ("revert",
                                                                           "Wrong identifier")
    assert query(api_db, "SELECT import_identifier FROM workspace_data_sources "
                         "WHERE id = 'ds_1'")[0][0] is None              # written through
    # Changed again since: the first change set can't be put back as it was.
    await _patch(client, _G1, _change("imports.identifier", "entity_id", 2))
    stale = await client.post(f"{_G1}/history/{graph_save['changeSetId']}/revert")
    assert stale.status_code == 409 and stale.json()["detail"]["type"] == "settings_conflict"
    as_(client, "usr_root")
    assert (await client.post(f"{_P}/history/{platform['changeSetId']}/revert")
            ).status_code == 200


async def test_a_change_set_made_in_more_than_one_place_is_not_put_back_as_one(client, api_db):
    """Only an import or an adoption saves values in several places at once."""
    engine = create_engine(db_url(api_db, "psycopg2"))
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO setting_changes (change_set, domain, key, scope, scope_id, after_value, "
            "version, source) VALUES "
            "('11111111-1111-1111-1111-111111111111', 'versioned-graphs', 'drafts.levels', "
            "'platform', '', '\"any\"', 1, 'migration'), "
            "('11111111-1111-1111-1111-111111111111', 'versioned-graphs', 'drafts.levels', "
            "'workspace', 'ws_1', '\"any\"', 1, 'migration')"))
    engine.dispose()
    got = await client.post(f"{_P}/history/11111111-1111-1111-1111-111111111111/revert")
    assert got.status_code == 409 and got.json()["detail"]["type"] == "not_revertible"
    as_(client, "usr_wsadmin")                 # the platform's part isn't the workspace's to see
    got = await client.post(f"{_W1}/history/11111111-1111-1111-1111-111111111111/revert")
    assert got.status_code == 404


# ── Preview ───────────────────────────────────────────────────────────────────────────────────────
async def test_a_full_preview_reads_the_graph_store(client):
    got = await client.post(_P + "/preview", params={"mode": "full"}, json=_save(
        _change("drafts.keepClosedDays", 7), _change("reads.mode", "in_place"),
        _change("builds.copyRoomPct", 400)))
    assert got.status_code == 200, got.text
    impact = got.json()["impact"]
    # graph_1's draft closed 10 days ago; the one closed 40 days ago is due already.
    assert impact["drafts"] == {"workspaces": 2, "removedAtNextSweep": 1}
    assert (impact["graphs"]["inScope"], impact["graphs"]["changed"]) == (2, 2)
    assert {s["label"] for s in impact["graphs"]["samples"]} == {"Ledger", "Pipeline"}
    assert impact["alwaysLatest"] == {"joining": 0, "leaving": 2}
    # The largest graph, 4 GB, needs 16 GB free at 400%: more than the node has under its mark.
    assert impact["memory"]["neededBytes"] == {"from": 4 * _GB * 220 // 100, "to": 16 * _GB}
    assert impact["memory"]["nodes"][0]["fits"] is False
    assert [w["code"] for w in impact["warnings"]] == ["drafts_removed", "copy_wont_fit"]
    assert impact["unavailable"] == []
    assert (await client.get(_P + "/history")).json()["entries"] == []       # nothing saved


# ── The inventory ─────────────────────────────────────────────────────────────────────────────────
async def _ids(**kw):
    args = dict(provider=None, status=None, workspace_id=None, kind=None, q=None, cursor=None,
                limit=50)
    return [g["graphId"] for g in (await va.list_graphs(**{**args, **kw},
                                                        _user=None))["graphs"]]


async def test_the_inventory_filters_by_what_is_in_force_and_counts_the_fleet(client):
    from backend.app.services.versioning import build_policy

    await build_policy.invalidate()            # the platform's read mode as this database has it
    await _patch(client, _G1, _change("imports.identifier", "urn"))
    assert await _ids(own_settings=True) == ["graph_1"]
    assert await _ids(own_settings=False) == ["graph_2", "graph_fork"]
    assert await _ids(residency_class="always") == ["graph_1"]
    assert await _ids(read_mode="latest") == ["graph_1", "graph_2"]       # not the fork
    assert await _ids(read_mode="latest", limit=1) == ["graph_1"]
    page = await va.list_graphs(provider=None, status=None, workspace_id=None, kind=None, q=None,
                                cursor="graph_1", limit=1, _user=None, read_mode="latest")
    assert [g["graphId"] for g in page["graphs"]] == ["graph_2"] and page["nextCursor"] is None
    assert page["total"] == 2, "the graphs in that mode, on every page"
    assert await _ids(read_mode="in_place") == []
    summary = await probes.versioned_graphs_summary()
    assert summary == {"graphs": 2, "inMemory": 1, "unloaded": 1, "loading": 0,
                       "waitingForRoom": 0, "noCopy": 0, "building": 0, "failing": 0,
                       "withOwnSettings": 1}
