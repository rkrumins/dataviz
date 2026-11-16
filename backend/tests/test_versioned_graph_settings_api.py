"""Versioned-graph settings over HTTP (``endpoints/versioned_graph_settings.py``) on the unit
harness: the real service in front of the in-memory settings store (``settings_world``), with the
versioned graphs, their routes and the live facts stood in for.

* Who may read and change each scope: a system administrator, an organisation administrator, a
  workspace administrator here and of another workspace, a member, and an API key (never).
* A save is checked whole: every refusal code, a value only another role may set, a value changed
  since it was read; the platform's limits (allowed, lock) and a system administrator's
  exception to them. A fork follows its root.
* A save records one activity event, writes through to the old storage, moves the routes of the
  graphs a routing setting reaches, and writes the residency class of the graphs a class reaches.
* The schema answers 304 to its ETag, and keeps live facts for system administrators.
* The preview, quick and full (its residency part with the proposed classes); the inventory's
  summary route.

The real store, the history and its revert, and the inventory's filters run against Postgres in
``integration/test_versioned_graph_settings_live.py``.
"""
from __future__ import annotations

import json
import re
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from backend.app.api.v1.endpoints import versioned_graph_settings as vgs
from backend.app.api.v1.endpoints import versioning_admin as va
from backend.app.api.v1.endpoints.versioning import get_versioning_service
from backend.app.auth import api_key_surface
from backend.app.auth.dependencies import get_permission_claims
from backend.app.db.models import OutboxEventORM, ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.main import app
from backend.app.services.activity import catalogue
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.settings import effects, facts, legacy, preview, service
from backend.app.services.settings.service import Graph
from backend.app.services.versioning import route_cache

_SCHEMA = "/api/v1/settings/versioned-graphs/schema"
_P = "/api/v1/admin/versioning/settings"
_W = "/api/v1/ws_1/versioning/settings"
_G = "/api/v1/ws_1/versioning/graphs/g_1/settings"
_FORK = "/api/v1/ws_1/versioning/graphs/g_fork/settings"
_GB = 1 << 30

_LEAVES = ("workspace:datasource:read", "workspace:datasource:manage", "workspace:view:read")
PERSONAS = {
    "system_admin": PermissionClaims(sid="sess_test", global_perms=("system:admin",)),
    "org_admin": PermissionClaims(sid="sess_test", global_perms=("system:org-admin",)),
    "admin_here": PermissionClaims(sid="sess_test",
                                   ws_perms={"ws_1": ("workspace:admin",) + _LEAVES}),
    "admin_elsewhere": PermissionClaims(sid="sess_test",
                                        ws_perms={"ws_2": ("workspace:admin",) + _LEAVES}),
    "member": PermissionClaims(sid="sess_test", ws_perms={"ws_1": _LEAVES}),
}

#: The versioned graphs: one in each workspace, and a fork of the first.
GRAPHS = [Graph("g_1", "ws_1", "ds_1", None, True),
          Graph("g_fork", "ws_1", "dsfork_1", "g_1", False),
          Graph("g_9", "ws_2", "ds_9", None, True)]
FACTS = {"largestGraphBytes": 4 * _GB, "graphCount": 2, "poolSize": 8, "projectionConcurrency": 2,
         "nodes": [{"name": "falkor-0:6379", "usedBytes": 2 * _GB, "maxBytes": 16 * _GB}]}


class _Versioning:
    """The versioning service as ``graph_in_workspace`` asks it."""

    async def get_graph(self, graph_id):
        g = next((g for g in GRAPHS if g.graph_id == graph_id), None)
        return None if g is None else {
            "graph_id": g.graph_id, "workspace_id": g.workspace_id,
            "data_source_id": g.data_source_id, "fork_parent_graph_id": g.fork_parent_graph_id,
            "deleted_at": None}


@pytest.fixture
async def estate(db_session):
    db_session.add_all([
        WorkspaceORM(id="ws_1", name="Finance"), WorkspaceORM(id="ws_2", name="Elsewhere"),
        ProviderORM(id="prov_1", name="Prod graph", provider_type="falkordb"),
        WorkspaceDataSourceORM(id="ds_1", workspace_id="ws_1", provider_id="prov_1",
                               graph_name="g_fin", label="Ledger"),
        WorkspaceDataSourceORM(id="dsfork_1", workspace_id="ws_1", provider_id="prov_1",
                               label="Ledger fork", fork_of_data_source_id="ds_1"),
        WorkspaceDataSourceORM(id="ds_9", workspace_id="ws_2", provider_id="prov_1",
                               graph_name="g_other", label="Other"),
    ])
    await db_session.commit()


@pytest.fixture
def world(settings_world, test_client, estate, monkeypatch):
    """The store in memory, the graphs above, and what reaches past the management database
    recorded instead: the write-through, the route announcements, the graphs' residency classes
    written to their rows, the live facts."""
    from backend.app.services.versioning import residency

    async def keep_classes(**reach):
        settings_world.kept.append(reach)
        return []

    async def graphs(*, workspace_id=None, graph_id=None, data_source_id=None):
        return [g for g in GRAPHS if workspace_id in (None, g.workspace_id)
                and graph_id in (None, g.graph_id) and data_source_id in (None, g.data_source_id)]

    async def graphs_of(workspaces, sources):
        return [g.graph_id for g in GRAPHS
                if g.workspace_id in workspaces or g.data_source_id in sources]

    async def announce(graph_ids=(), *, graph_set=False, every=False):
        settings_world.announced.append((sorted(graph_ids), every))
        return True

    async def write_through(session, change_set, **_kw):
        settings_world.written.append(change_set)

    async def collect():
        settings_world.collected += 1
        return dict(FACTS)

    settings_world.announced, settings_world.written, settings_world.collected = [], [], 0
    settings_world.kept = []
    monkeypatch.setattr(service, "graphs", graphs)
    monkeypatch.setattr(effects, "_graphs_of", graphs_of)
    monkeypatch.setattr(route_cache, "announce", announce)
    monkeypatch.setattr(residency, "keep_classes", keep_classes)
    monkeypatch.setattr(legacy, "write_through", write_through)
    monkeypatch.setattr(facts, "collect", collect)
    app.dependency_overrides[get_versioning_service] = _Versioning
    as_("system_admin")
    return settings_world


def as_(persona: str) -> None:
    app.dependency_overrides[get_permission_claims] = lambda: PERSONAS[persona]


def _change(key, value, version=0, **kw):
    return {"key": key, "value": value, "expectedVersion": version, **kw}


def _save(*changes, reason=None):
    return {"changes": list(changes), **({"reason": reason} if reason else {})}


def _value(body, key):
    return next(v for v in body["values"] if v["key"] == key)


async def _events(db_session, event_type):
    rows = (await db_session.execute(select(OutboxEventORM).where(
        OutboxEventORM.event_type == event_type))).scalars().all()
    return [json.loads(r.payload) for r in rows]


# ── The routes, their gates and the API-key surface ───────────────────────────────────────────────
_ROUTES = {
    ("GET", _SCHEMA): None,
    ("GET", _P): "system:admin", ("PATCH", _P): "system:admin",
    ("POST", _P + "/preview"): "system:admin", ("GET", _P + "/history"): "system:admin",
    ("POST", _P + "/history/{change_set_id}/revert"): "system:admin",
    ("GET", "/api/v1/{ws_id}/versioning/settings"): "workspace:datasource:read",
    ("PATCH", "/api/v1/{ws_id}/versioning/settings"): "workspace:admin",
    ("POST", "/api/v1/{ws_id}/versioning/settings/preview"): "workspace:admin",
    ("GET", "/api/v1/{ws_id}/versioning/settings/history"): "workspace:admin",
    ("POST", "/api/v1/{ws_id}/versioning/settings/history/{change_set_id}/revert"):
        "workspace:admin",
    ("GET", "/api/v1/{ws_id}/versioning/settings/graphs"): "workspace:datasource:read",
    ("GET", "/api/v1/{ws_id}/versioning/graphs/{graph_id}/settings"): "workspace:datasource:read",
    ("PATCH", "/api/v1/{ws_id}/versioning/graphs/{graph_id}/settings"): "workspace:admin",
    ("POST", "/api/v1/{ws_id}/versioning/graphs/{graph_id}/settings/preview"): "workspace:admin",
    ("GET", "/api/v1/{ws_id}/versioning/graphs/{graph_id}/settings/history"): "workspace:admin",
    ("POST", "/api/v1/{ws_id}/versioning/graphs/{graph_id}/settings/history/{change_set_id}"
             "/revert"): "workspace:admin",
    ("GET", "/api/v1/admin/versioning/graphs/summary"): "system:admin",
}


def _gate_perms(dependant) -> set:
    perms, stack = set(), [dependant]
    while stack:
        dep = stack.pop()
        perm = getattr(getattr(dep, "call", None), "required_permission", None)
        if perm:
            perms.add(perm)
        stack.extend(dep.dependencies)
    return perms


def test_each_route_has_its_gate_and_none_is_open_to_an_api_key():
    """A key reaches only the handlers on the surface (``api_key_auth`` refuses the rest with
    ``api_key_not_allowed``), and none of these is there: not the writes, not the reads."""
    found = {(m, p): (r, d) for m, p, r, d in api_key_surface.routes(app) if (m, p) in _ROUTES}
    assert set(found) == set(_ROUTES)
    for (method, path), perm in _ROUTES.items():
        route, dependant = found[(method, path)]
        assert ({perm} if perm else set()) == _gate_perms(dependant), (method, path)
        assert (route.endpoint.__module__, route.endpoint.__name__) not in api_key_surface.SURFACE
    every = {route.endpoint for _m, _p, route, _d in api_key_surface.routes(app)
             if route.endpoint.__module__ == vgs.__name__}
    assert {e.__name__ for e in every} <= {r.endpoint.__name__ for r, _d in found.values()}


# ── Who may do what ───────────────────────────────────────────────────────────────────────────────
#: persona: (GET, PATCH) on the platform's, the workspace's, the graph's; and the editor GET says.
MATRIX = {
    "system_admin": ((200, 200), (200, 200), (200, 200), "system_admin"),
    "org_admin": ((403, 403), (200, 200), (200, 200), "workspace_admin"),
    "admin_here": ((403, 403), (200, 200), (200, 200), "workspace_admin"),
    "admin_elsewhere": ((403, 403), (403, 403), (403, 403), None),
    "member": ((403, 403), (200, 403), (200, 403), None),
}


@pytest.mark.parametrize("persona", sorted(MATRIX))
async def test_who_may_read_and_change_each_scope(world, test_client, persona):
    as_(persona)
    *scopes, editor = MATRIX[persona]
    for path, (read, write) in zip((_P, _W, _G), scopes, strict=True):
        got = await test_client.get(path)
        assert got.status_code == read, (path, got.text)
        if read == 200:
            assert got.json()["editor"] == editor
            assert all(v["editable"] is False for v in got.json()["values"]) is (editor is None)
        saved = await test_client.patch(path, json=_save(_change("drafts.levels", "public_only")))
        assert saved.status_code == write, (path, saved.text)
        if write == 403:
            assert saved.json()["detail"]["error"] == "missing_permission"


@pytest.mark.parametrize("persona", ["org_admin", "admin_here"])
async def test_a_workspace_admin_may_not_set_what_only_system_admins_may(world, test_client,
                                                                         persona):
    as_(persona)
    for path in (_W, _G):
        refused = await test_client.patch(path, json=_save(
            _change("drafts.levels", "public_only"), _change("residency.class", "always")))
        assert refused.status_code == 403, refused.text
        detail = refused.json()["detail"]
        assert detail["type"] == "setting_not_permitted"
        assert detail["denied"] == [{
            "key": "residency.class", "code": "setting_not_permitted", "editor": "system_admin",
            "message": detail["denied"][0]["message"]}]
        assert "system administrator" in detail["denied"][0]["message"]
    assert world.saves == []                     # all or nothing: drafts.levels wasn't saved
    as_("system_admin")
    assert (await test_client.patch(_W, json=_save(_change("residency.class", "always")))
            ).status_code == 200


async def test_an_unknown_workspace_is_not_found(world, test_client):
    assert (await test_client.get("/api/v1/ws_nope/versioning/settings")).status_code == 404
    assert (await test_client.patch("/api/v1/ws_nope/versioning/settings", json=_save(
        _change("drafts.levels", "any")))).status_code == 404
    assert world.saves == []


async def test_a_graph_of_another_workspace_is_not_found(world, test_client):
    assert (await test_client.get("/api/v1/ws_1/versioning/graphs/g_9/settings")
            ).status_code == 404


# ── What GET serves ───────────────────────────────────────────────────────────────────────────────
_CONTRACT = {"key", "effective", "declared", "source", "trail", "status", "why", "editable",
             "editor", "allowed", "version"}


def _camel(obj) -> bool:
    if isinstance(obj, dict):
        return all(re.fullmatch(r"[a-z][A-Za-z0-9]*", k) for k in obj) and all(
            _camel(v) for v in obj.values())
    if isinstance(obj, list):
        return all(_camel(v) for v in obj)
    return True


async def test_every_value_is_the_resolvers_answer_in_camel_case(world, test_client):
    world.set("reads.mode", "workspace", "ws_1", "in_place")
    world.set("imports.identifier", "graph", "ds_1", "urn")
    platform, workspace, graph = [(await test_client.get(p)).json() for p in (_P, _W, _G)]
    assert set(platform) == {"scope", "editor", "values", "version"}
    assert set(workspace) == {"scope", "workspaceId", "editor", "values", "version"}
    assert graph | {"values": None} == {"scope": "graph", "workspaceId": "ws_1", "graphId": "g_1",
                                        "dataSourceId": "ds_1", "editor": "system_admin",
                                        "values": None, "version": graph["version"]}
    for body in (platform, workspace, graph):
        assert [v["key"] for v in body["values"]] == [s.key for s in world_registry().SETTINGS]
        assert _camel(body)
    assert all(set(v) == _CONTRACT | {"limits"} for v in platform["values"])
    assert all(set(v) == _CONTRACT for v in workspace["values"] + graph["values"])
    mode = _value(graph, "reads.mode")
    assert (mode["effective"], mode["source"], mode["version"]) == ("in_place", "workspace", 0)
    assert [t["scope"] for t in mode["trail"]] == ["default", "platform", "workspace", "graph"]
    assert _value(graph, "imports.identifier")["version"] == 1
    # The version moves with any value a scope's answers read, and with nothing else.
    assert graph["version"] > workspace["version"] > platform["version"] == 0
    world.set("drafts.levels", "workspace", "ws_2", "any")
    assert (await test_client.get(_W)).json()["version"] == workspace["version"]


def world_registry():
    from backend.app.services.settings import registry

    return registry()


async def test_the_platforms_values_carry_their_limits(world, test_client):
    world.set("reads.mode", "platform", "", "latest", limits={"allowed": ["latest", "in_place",
                                                                          "beside"]})
    body = (await test_client.get(_P)).json()
    assert _value(body, "reads.mode")["limits"] == {"allowed": ["latest", "in_place", "beside"]}
    assert _value(body, "drafts.levels")["limits"] is None        # the default limits apply


async def test_a_fork_follows_its_root(world, test_client, forks_on):
    for method, path, body in (("GET", _FORK, None),
                               ("PATCH", _FORK, _save(_change("drafts.levels", "any"))),
                               ("POST", _FORK + "/preview", _save(_change("drafts.levels", "any"))),
                               ("GET", _FORK + "/history", None)):
        got = await test_client.request(method, path, json=body)
        assert got.status_code == 409, (method, got.text)
        assert got.json()["detail"] | {"message": None} == {
            "type": "follows_root", "message": None, "rootGraphId": "g_1",
            "rootDataSourceId": "ds_1", "workspaceId": "ws_1"}
    assert world.saves == []


async def test_the_workspace_lists_its_graphs_with_what_they_chose_and_what_is_in_force(
        world, test_client):
    world.set("reads.mode", "platform", "", None, limits={"allowed": ["latest", "in_place",
                                                                      "beside"]})
    world.set("reads.mode", "graph", "ds_1", "beside")
    world.set("imports.identifier", "graph", "ds_1", "urn")
    body = (await test_client.get(_W + "/graphs")).json()
    assert body["nextCursor"] is None and body["workspaceId"] == "ws_1"
    root, fork = body["graphs"]
    assert (root["graphId"], root["label"], root["follows"]) == ("g_1", "Ledger", None)
    assert root["ownSettings"] == ["imports.identifier", "reads.mode"]
    # New-version builds are off, so "switch when ready" updates in place.
    assert root["readMode"] | {"why": None} == {"effective": "in_place", "declared": "beside",
                                                "source": "graph", "status": "adjusted",
                                                "why": None}
    assert [w["code"] for w in root["readMode"]["why"]] == ["builds_off"]
    assert root["residencyClass"]["status"] == "dormant"
    assert fork["follows"] == {"graphId": "g_1", "dataSourceId": "ds_1"}
    assert fork["ownSettings"] == [] and fork["readMode"]["source"] == "graph"
    page = (await test_client.get(_W + "/graphs", params={"limit": 1})).json()
    assert [g["graphId"] for g in page["graphs"]] == ["g_1"] and page["nextCursor"] == "g_1"
    rest = (await test_client.get(_W + "/graphs", params={"cursor": "g_1"})).json()
    assert [g["graphId"] for g in rest["graphs"]] == ["g_fork"]


# ── Saving ────────────────────────────────────────────────────────────────────────────────────────
async def test_a_save_answers_the_new_values_records_once_and_writes_through(
        world, test_client, db_session):
    saved = await test_client.patch(_W, json=_save(
        _change("drafts.levels", "public_only"), _change("drafts.selfMerge", False),
        reason="Reviews for everyone"))
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["changeSetId"] == str(world.saves[0].id)
    assert _value(body, "drafts.levels") | {"trail": None, "why": None, "allowed": None} == {
        "key": "drafts.levels", "effective": "public_only", "declared": "public_only",
        "source": "workspace", "trail": None, "status": "in_effect", "why": None,
        "editable": True, "editor": "workspace_admin", "allowed": None, "version": 1}
    # Derived: only public drafts allowed, so new drafts start public.
    assert _value(body, "drafts.defaultVisibility")["effective"] == "public"
    (event,) = await _events(db_session, "workspace.versioning.settings_updated")
    assert event["details"] == {
        "domain": "versioned-graphs", "changeSet": body["changeSetId"], "source": "api",
        "from": {"drafts.levels": None, "drafts.selfMerge": None},
        "to": {"drafts.levels": "public_only", "drafts.selfMerge": False}}
    assert (event["workspace_id"], event["target_type"], event["target_label"]) == (
        "ws_1", "workspace", "Finance")
    assert event["stated_reason"] == "Reviews for everyone"
    assert world.saves[0].reason == "Reviews for everyone"
    assert world.written == world.saves
    # The same again changes nothing, records nothing, and says so.
    again = await test_client.patch(_W, json=_save(_change("drafts.levels", "public_only", 1)))
    assert again.json()["changeSetId"] is None and len(world.saves) == 1
    assert len(await _events(db_session, "workspace.versioning.settings_updated")) == 1


async def test_the_reason_comes_from_the_header_when_the_body_has_none(world, test_client,
                                                                     db_session):
    await test_client.patch(_G, json=_save(_change("imports.identifier", "urn")),
                            headers={"X-Activity-Reason": "Rows%20carry%20their%20URN"})
    assert world.saves[0].reason == "Rows carry their URN"
    (event,) = await _events(db_session, "workspace.versioning.graph_settings_updated")
    assert (event["data_source_id"], event["target_label"], event["details"]["graphId"]) == (
        "ds_1", "Ledger", "g_1")
    assert event["stated_reason"] == "Rows carry their URN"


async def test_limits_are_the_platforms_and_a_change_of_them_is_recorded(world, test_client,
                                                                        db_session):
    allowed = {"allowed": ["latest", "in_place", "beside"]}
    saved = await test_client.patch(_P, json=_save(_change("reads.mode", None, limits=allowed)))
    assert _value(saved.json(), "reads.mode")["limits"] == allowed
    (event,) = await _events(db_session, "platform.versioning.settings_updated")
    assert event["details"]["limits"] == {"reads.mode": {"from": None, "to": allowed}}
    assert "workspace_id" not in event and "target_type" not in event
    # null takes the default limits again; a change left out keeps them.
    kept = await test_client.patch(_P, json=_save(_change("reads.mode", "in_place", 1)))
    assert _value(kept.json(), "reads.mode")["limits"] == allowed
    reset = await test_client.patch(_P, json=_save(_change("reads.mode", "in_place", 2,
                                                           limits=None)))
    assert _value(reset.json(), "reads.mode")["limits"] is None


async def test_a_value_changed_since_it_was_read_is_a_conflict_and_nothing_is_saved(
        world, test_client):
    world.set("drafts.levels", "workspace", "ws_1", "any")
    stale = await test_client.patch(_W, json=_save(_change("drafts.selfMerge", False),
                                                   _change("drafts.levels", "public_only", 0)))
    assert stale.status_code == 409, stale.text
    assert stale.json()["detail"]["type"] == "settings_conflict"
    assert stale.json()["detail"]["conflicts"] == [{"key": "drafts.levels", "scope": "workspace",
                                                    "scopeId": "ws_1", "expected": 0,
                                                    "actual": 1}]
    assert world.saves == []


@pytest.mark.parametrize("path, change, code", [
    (_P, _change("nope.nothing", 1), "unknown_setting"),
    (_W, _change("updates.pacingRatio", 0.5), "not_at_scope"),
    (_P, _change("builds.forRebuilds", "yes"), "invalid_value"),
    (_P, _change("updates.pacingRatio", 9), "out_of_range"),
    (_P, _change("reads.mode", "fastest"), "invalid_choice"),
    (_G, _change("imports.identifier", "prop."), "invalid_identifier"),
    (_W, _change("imports.maxRefusedRows", "-1"), "invalid_budget"),
    (_P, _change("database.readsPerGraph", 20), "rule_violated"),
    (_W, _change("reads.mode", "beside"), "outside_limits"),
    (_W, _change("reads.mode", None, limits={"lock": True}), "limits_not_on_platform"),
    (_P, _change("reads.mode", None, limits={"range": [1, 2]}), "invalid_limits"),
])
async def test_each_problem_is_a_422_naming_the_setting_and_its_code(world, test_client, path,
                                                                    change, code):
    as_("admin_here" if path != _P else "system_admin")
    refused = await test_client.patch(path, json=_save(change))
    assert refused.status_code == 422, refused.text
    detail = refused.json()["detail"]
    assert detail["type"] == "invalid_settings"
    assert [(e["key"], e["code"]) for e in detail["errors"]] == [(change["key"], code)]
    assert all(e["message"] for e in detail["errors"]) and world.saves == []


async def test_a_setting_locked_by_the_platform_is_refused_below_and_its_value_ignored(
        world, test_client):
    world.set("drafts.levels", "workspace", "ws_1", "public_only")
    world.set("drafts.levels", "platform", "", "any", limits={"lock": True})
    as_("admin_here")
    refused = await test_client.patch(_W, json=_save(_change("drafts.levels", "private_only", 1)))
    assert [e["code"] for e in refused.json()["detail"]["errors"]] == ["locked"]
    levels = _value((await test_client.get(_W)).json(), "drafts.levels")
    assert (levels["effective"], levels["status"], levels["editable"]) == ("any", "locked", False)
    assert [w["code"] for w in levels["why"]] == ["locked_by_platform"]


async def test_a_change_twice_in_one_save_is_refused(world, test_client):
    refused = await test_client.patch(_W, json=_save(_change("drafts.levels", "any"),
                                                     _change("drafts.levels", "public_only")))
    assert refused.status_code == 422
    assert [e["code"] for e in refused.json()["detail"]["errors"]] == ["duplicate_change"]


async def test_limits_bound_workspace_admins_and_a_system_admins_value_outside_them_stands(
        world, test_client):
    world.set("forks.maxPerGraph", "platform", "", None, limits={"range": [0, 5]})
    as_("admin_here")
    refused = await test_client.patch(_W, json=_save(_change("forks.maxPerGraph", 50)))
    assert [e["code"] for e in refused.json()["detail"]["errors"]] == ["outside_limits"]
    within = await test_client.patch(_W, json=_save(_change("forks.maxPerGraph", 4)))
    assert _value(within.json(), "forks.maxPerGraph")["allowed"] == {"min": 0, "max": 5}
    as_("system_admin")
    exception = await test_client.patch(_W, json=_save(_change("forks.maxPerGraph", 50, 1)))
    assert exception.status_code == 200, exception.text
    forks = _value(exception.json(), "forks.maxPerGraph")
    assert (forks["effective"], forks["status"]) == (50, "exception")
    assert [w["code"] for w in forks["why"]] == ["outside_limits_exception"]
    assert forks["trail"][-1] == {"scope": "workspace", "value": 50, "exception": True}
    # A limit widened by the platform lets workspace admins choose more.
    world.set("reads.mode", "platform", "", None, limits={"allowed": ["latest", "in_place",
                                                                      "beside"]})
    as_("admin_here")
    assert (await test_client.patch(_W, json=_save(_change("reads.mode", "beside")))
            ).status_code == 200


# ── What a save sets in motion ────────────────────────────────────────────────────────────────────
async def test_a_routing_save_moves_the_routes_of_the_graphs_it_reaches(world, test_client):
    await test_client.patch(_G, json=_save(_change("reads.mode", "in_place")))
    await test_client.patch(_W, json=_save(_change("reads.maxVersionsBehind", 3)))
    await test_client.patch(_P, json=_save(_change("reads.mode", "in_place")))
    assert world.announced == [(["g_1"], False), (["g_1", "g_fork"], False), ([], True)]
    await test_client.patch(_W, json=_save(_change("drafts.levels", "any")))
    assert len(world.announced) == 3, "a setting that routes nothing moves no route"


async def test_routes_are_all_moved_when_the_graphs_cant_be_listed(world, monkeypatch):
    async def down(*_a):
        raise ConnectionError("the graph store is out of reach")

    monkeypatch.setattr(effects, "_graphs_of", down)
    applied = [SimpleNamespace(key="reads.mode", scope="workspace", scope_id="ws_1")]
    assert await effects.announce_routes(applied) is True
    assert world.announced == [([], True)]


async def test_a_class_save_writes_the_classes_of_the_graphs_it_reaches(world, test_client):
    """The evictor reads each graph's class on its row: a graph's own class re-classes that graph,
    a workspace's the workspace's graphs, the platform's every graph (in one statement each,
    ``residency.keep_classes``). A save of anything else writes no class."""
    for path in (_G, _W, _P):
        saved = await test_client.patch(path, json=_save(_change("residency.class", "always")))
        assert saved.status_code == 200, saved.text
    assert world.kept == [{"workspaces": set(), "sources": {"ds_1"}},
                          {"workspaces": {"ws_1"}, "sources": set()},
                          {"workspaces": None, "sources": None}]
    await test_client.patch(_W, json=_save(_change("drafts.levels", "any")))
    assert len(world.kept) == 3


async def test_a_class_not_written_after_a_save_is_left_to_the_next_memory_check(
        world, test_client, monkeypatch, caplog):
    from backend.app.services.versioning import residency

    async def down(**_reach):
        raise ConnectionError("the graph store is out of reach")

    monkeypatch.setattr(residency, "keep_classes", down)
    saved = await test_client.patch(_W, json=_save(_change("residency.class", "coldline")))
    assert saved.status_code == 200 and len(world.saves) == 1          # the save stands
    assert "the next memory check writes them" in caplog.text


# ── The schema ────────────────────────────────────────────────────────────────────────────────────
async def test_the_schema_answers_304_while_its_etag_holds(world, test_client):
    first = await test_client.get(_SCHEMA)
    assert first.status_code == 200 and first.headers["cache-control"] == "private, no-cache"
    tag = first.headers["etag"]
    assert (await test_client.get(_SCHEMA, headers={"If-None-Match": tag})).status_code == 304
    world.set("reads.mode", "platform", "", "in_place")       # its examples and posture change
    moved = await test_client.get(_SCHEMA, headers={"If-None-Match": tag})
    assert moved.status_code == 200 and moved.headers["etag"] != tag
    reads = next(c for c in moved.json()["categories"] if c["id"] == "reads")
    assert "update in place" in reads["posture"]


@pytest.mark.parametrize("persona", ["member", "admin_here", "system_admin"])
async def test_the_schema_is_for_everyone_and_its_live_facts_for_system_admins(
        world, test_client, persona):
    as_(persona)
    body = (await test_client.get(_SCHEMA)).json()
    assert {s["key"] for s in body["settings"]} == set(world_registry().BY_KEY)
    for_platform = [s["guidance"]["recommended"]["forThisPlatform"] for s in body["settings"]]
    if persona == "system_admin":
        assert world.collected == 1 and any(for_platform)
    else:
        assert world.collected == 0 and not any(for_platform)


# ── Preview ───────────────────────────────────────────────────────────────────────────────────────
async def test_a_quick_preview_saves_nothing_and_answers_what_would_change(world, test_client):
    as_("admin_here")
    got = await test_client.post(_W + "/preview", json=_save(
        _change("imports.replaceGuard", False)))
    assert got.status_code == 200, got.text
    body = got.json()
    assert (body["mode"], body["scope"], body["workspaceId"], "impact" in body) == (
        "quick", "workspace", "ws_1", False)
    # The guard's own answer, and those of the shares it checks, now unused; nothing else moves.
    assert [v["key"] for v in body["values"]] == [
        "imports.replaceGuard", "imports.guardDeleteShare", "imports.guardCreateShare"]
    guard = body["values"][0]
    assert (guard["effective"], guard["source"]) == (False, "workspace")
    assert guard["example"] == ("A replace deletes whatever its file leaves out, however much "
                                "that is.")
    share = _value(body, "imports.guardDeleteShare")
    assert (share["status"], [w["code"] for w in share["why"]]) == ("not_used", ["guard_off"])
    assert world.saves == [] and world.announced == []
    refused = await test_client.post(_W + "/preview", json=_save(_change("residency.class",
                                                                         "always")))
    assert refused.status_code == 403
    invalid = await test_client.post(_W + "/preview", json=_save(_change("reads.mode", "x")))
    assert invalid.status_code == 422


async def test_a_full_preview_reports_the_impact_part_by_part(world, test_client, monkeypatch):
    async def drafts(workspaces, was, will):
        assert (workspaces, was, will) == (["ws_1", "ws_2"], 30, 7)
        return 12

    monkeypatch.setattr(preview, "_closed_drafts", drafts)
    world.set("reads.mode", "workspace", "ws_2", "latest")
    world.set("forks.maxPerGraph", "workspace", "ws_1", 50)
    got = await test_client.post(_P + "/preview", params={"mode": "full"}, json=_save(
        _change("reads.mode", "in_place"), _change("drafts.keepClosedDays", 7),
        _change("builds.copyRoomPct", 150), _change("imports.replaceGuard", False),
        _change("forks.maxPerGraph", None, limits={"lock": True})))
    assert got.status_code == 200, got.text
    impact = got.json()["impact"]
    graphs = impact["graphs"]
    assert (graphs["inScope"], graphs["changed"]) == (2, 2)          # forks follow their root
    first = graphs["samples"][0]
    assert (first["graphId"], first["label"]) == ("g_1", "Ledger")
    assert {"key": "reads.mode", "from": "latest", "to": "in_place"} in first["changes"]
    assert {"key": "forks.maxPerGraph", "from": 50, "to": 10} in first["changes"]   # locked
    # ws_2 keeps Always the latest; ws_1's graph leaves it.
    assert impact["alwaysLatest"] == {"joining": 0, "leaving": 1}
    assert impact["memory"] == {
        "largestGraphBytes": 4 * _GB, "neededBytes": {"from": 4 * _GB * 220 // 100,
                                                      "to": 6 * _GB},
        "copied": True, "nodes": [{"name": "falkor-0:6379", "usedBytes": 2 * _GB,
                                   "maxBytes": 16 * _GB, "freeBytes": 16 * _GB * 80 // 100
                                   - 2 * _GB, "fits": True}]}
    assert impact["drafts"] == {"workspaces": 2, "removedAtNextSweep": 12}
    assert impact["outsideLimits"] == {"count": 1, "locked": 1, "samples": [{
        "key": "forks.maxPerGraph", "scope": "workspace", "scopeId": "ws_1", "value": 50,
        "status": "locked"}]}
    assert impact["database"] is None and impact["residency"] is None
    codes = [(w["code"], w.get("key")) for w in impact["warnings"]]
    assert codes == [("risky_change", "builds.copyRoomPct"),
                     ("risky_change", "imports.replaceGuard"),
                     ("drafts_removed", "drafts.keepClosedDays"), ("values_locked_out", None)]
    assert impact["unavailable"] == [] and world.saves == []


async def test_a_full_preview_keeps_what_it_can_when_a_source_cant_be_read(world, test_client,
                                                                          monkeypatch):
    async def down(**_kw):
        raise ConnectionError("the graph store is out of reach")

    async def no_facts():
        return {"poolSize": 8}

    monkeypatch.setattr(service, "graphs", down)
    monkeypatch.setattr(facts, "collect", no_facts)
    got = await test_client.post(_P + "/preview", params={"mode": "full"}, json=_save(
        _change("reads.mode", "in_place"), _change("builds.copyRoomPct", 150),
        _change("database.readsPerProcess", 16), _change("drafts.keepClosedDays", 7)))
    impact = got.json()["impact"]
    assert impact["unavailable"] == ["graphs", "alwaysLatest", "memory", "drafts"]
    assert impact["database"] == {"readsPerProcess": {"from": 8, "to": 16},
                                  "readsPerGraph": {"from": 4, "to": 4},
                                  "readTimeoutMs": {"from": 15000, "to": 15000}, "poolSize": 8}
    assert ("reads_fill_pool", "database.readsPerProcess") in [
        (w["code"], w.get("key")) for w in impact["warnings"]]


async def test_a_workspace_admins_full_preview_shows_no_operator_data(world, test_client):
    as_("admin_here")
    got = await test_client.post(_W + "/preview", params={"mode": "full"}, json=_save(
        _change("reads.mode", "latest")))
    impact = got.json()["impact"]
    assert world.collected == 0
    assert impact["graphs"]["inScope"] == 1 and impact["alwaysLatest"] == {"joining": 0,
                                                                           "leaving": 0}
    assert impact["memory"] is None and impact["residency"] is None
    assert impact["outsideLimits"] is None and "poolSize" not in (impact["database"] or {})


async def test_the_residency_part_plans_the_next_check_with_the_proposed_marks(
        world, test_client, monkeypatch):
    from backend.app.services.versioning import residency

    planned = []

    async def plan(policy, **_kw):
        planned.append(policy)
        x = SimpleNamespace(graph_id="g_1", bytes=3 * _GB, reason="memory")
        master = SimpleNamespace(master=SimpleNamespace(endpoint="falkor-0:6379", used=14 * _GB,
                                                        maxmemory=16 * _GB),
                                 used_after=11 * _GB, evictions=[x], loads=[], waits=[])
        return (SimpleNamespace(masters=[master], evictions=[x], loads=[]),
                SimpleNamespace(rows={"g_1": {"data_source_id": "ds_1"}}))

    async def switches(_session):
        return {"residencyEnabled": True}

    monkeypatch.setattr(residency, "preview", plan)
    monkeypatch.setattr(service, "_switches", switches)
    got = await test_client.post(_P + "/preview", params={"mode": "full"}, json=_save(
        _change("residency.unloadStartPct", 85)))
    impact = got.json()["impact"]
    assert planned[0].high_water_pct == 85 and planned[0].low_water_pct == 70
    assert impact["residency"] == {
        "switchOn": True, "unloads": 1, "unloadedBytes": 3 * _GB, "loads": 0, "waits": 0,
        "nodes": [{"name": "falkor-0:6379", "usedBytes": 14 * _GB, "maxBytes": 16 * _GB,
                   "usedAfterBytes": 11 * _GB, "loads": [], "waits": [], "unloads": [{
                       "graphId": "g_1", "dataSourceId": "ds_1", "label": "Ledger",
                       "bytes": 3 * _GB, "reason": "memory"}]}]}
    assert "graphs_unloaded" in [w["code"] for w in impact["warnings"]]


async def test_the_residency_part_plans_the_next_check_with_the_proposed_classes(
        world, test_client, monkeypatch):
    """A class change at any scope is planned with each graph of the class it would have: a
    workspace's reaches its graphs, not a graph with a class of its own, nor another workspace's.
    While the graphs' own values wait for their import (a separate graph store), only a graph's
    own class moves it: the others keep the class on their row."""
    from backend.app.services.versioning import residency

    planned = []

    async def plan(policy, *, classes=None, **_kw):
        planned.append(classes)
        x = SimpleNamespace(graph_id="g_1", bytes=2 * _GB)
        master = SimpleNamespace(master=SimpleNamespace(endpoint="falkor-0:6379", used=4 * _GB,
                                                        maxmemory=16 * _GB),
                                 used_after=4 * _GB, evictions=[], loads=[x], waits=[])
        return (SimpleNamespace(masters=[master], evictions=[], loads=[x]),
                SimpleNamespace(rows={"g_1": {"data_source_id": "ds_1"}}))

    monkeypatch.setattr(residency, "preview", plan)
    world.set("residency.class", "graph", "ds_own", "coldline")
    world.set("residency.class", "platform", "", "standard")
    got = await test_client.post(_W + "/preview", params={"mode": "full"}, json=_save(
        _change("residency.class", "always")))
    assert got.status_code == 200, got.text
    impact = got.json()["impact"]
    assert impact["residency"]["loads"] == 1
    assert impact["residency"]["nodes"][0]["loads"] == [
        {"graphId": "g_1", "dataSourceId": "ds_1", "label": "Ledger", "bytes": 2 * _GB}]
    classes = planned[-1]
    assert classes.of("ws_1", "ds_1", "standard") == "always"           # the workspace's graph
    assert classes.of("ws_1", "ds_own", "standard") == "coldline"       # its own class wins
    assert classes.of("ws_2", "ds_9", "coldline") == "standard"         # the platform's
    world.imports = {"legacy"}                                           # graph values pending
    await test_client.post(_W + "/preview", params={"mode": "full"}, json=_save(
        _change("residency.class", "always")))
    classes = planned[-1]
    assert classes.of("ws_1", "ds_1", "coldline") == "coldline"         # kept as on its row
    assert classes.of("ws_1", "ds_own", "standard") == "coldline"


# ── The activity log and the inventory ────────────────────────────────────────────────────────────
@pytest.mark.parametrize("event_type, payload, summary", [
    ("platform.versioning.settings_updated", {"details": {"to": {"reads.mode": "in_place"}}},
     "Changed the platform's versioned-graph settings: reads.mode"),
    ("workspace.versioning.settings_updated",
     {"target_label": "Finance", "details": {"to": {"drafts.levels": "any",
                                                    "forks.maxPerGraph": 3}}},
     "Changed the versioned-graph settings of Finance: drafts.levels, forks.maxPerGraph"),
    ("workspace.versioning.graph_settings_updated",
     {"target_label": "Ledger", "details": {"to": {}}},
     "Changed the settings of versioned graph Ledger: nothing"),
])
def test_the_activity_log_says_what_changed_where(event_type, payload, summary):
    assert catalogue.summarize(event_type, payload) == ("info", summary)
    assert catalogue.LABELS[event_type]
    workspace = catalogue.project(event_type=event_type, payload={"workspace_id": "ws_1"},
                                  event_version=2)
    assert workspace["audience"] == ("platform" if event_type.startswith("platform.")
                                     else "workspace")
    assert workspace["category"] == ("platform" if event_type.startswith("platform.") else "data")


async def test_the_inventory_summary_is_the_probes(world, test_client, monkeypatch):
    figures = {"graphs": 2, "inMemory": 1, "unloaded": 1, "loading": 0, "waitingForRoom": 0,
               "building": 0, "failing": 0, "withOwnSettings": 1}

    async def summary():
        return figures

    monkeypatch.setattr(va.probes, "versioned_graphs_summary", summary)
    assert (await test_client.get("/api/v1/admin/versioning/graphs/summary")).json() == figures
    as_("org_admin")
    assert (await test_client.get("/api/v1/admin/versioning/graphs/summary")).status_code == 403
