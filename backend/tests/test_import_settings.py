"""A graph's import settings: what its imports' rows find their entities by when an import names no
identifier, and the replace guard's limits.

* Each field resolves on its own: the graph's data source's own, else the platform's, and says
  where it came from. An import that names an identifier uses it.
* An import keeps what it was made with (``jobs.import_settings``): where its identifier came from,
  and the guard's limits with where each came from. The guard and the fail-fast check use those.
* Anyone who reads the graph reads them, an API key too; workspace admins set them, never with a
  key. ``"inherit"`` clears a field, a field left out stays, and a real change is recorded once. A
  fork's are its parent's, but for a property default: a fork's rows can't be matched by a property
  yet, so there it is ``entity_id``, its source ``fork``, in its settings and on its imports — all
  but the data source's identifier property, which holds the urn, and stays.
"""
from __future__ import annotations

import json
import time
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from backend.app.api.v1.endpoints import versioning as V
from backend.app.auth import api_key_surface
from backend.app.db.models import OutboxEventORM, ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.main import app
from backend.app.services import import_settings
from backend.app.services.activity import catalogue
from backend.app.services.feature_flags import feature_flags
from backend.app.services.versioning import config
from backend.app.services.versioning.import_export import keys
from backend.app.services.versioning.import_export.import_worker import replace_verdict

_EVENT = "workspace.versioning.import_settings_updated"
_PATH = "/api/v1/ws_1/versioning/graphs/g_1/import-settings"


def _row(**values):
    return SimpleNamespace(**{column: values.get(column) for column, _api, _d in import_settings.FIELDS})


def test_each_field_resolves_on_its_own():
    effective = import_settings.resolve(_row(import_identifier="urn", import_replace_delete_fraction=0.9))
    assert (effective["identifier"], effective["replaceDeleteFraction"]) == ("urn", 0.9)
    assert effective["replaceMinLive"] == config.IMPORT_REPLACE_GUARD_MIN_LIVE
    assert effective["sources"] == {
        "identifier": "data_source", "replaceDeleteFraction": "data_source",
        "replaceMinLive": "platform", "replaceCreateFraction": "platform",
        "replaceMinMatchFraction": "platform"}
    assert import_settings.resolve(None) == {**import_settings.platform(),
                                             "sources": dict.fromkeys(import_settings.platform(), "platform")}


def test_an_import_names_its_own_identifier_or_takes_its_graphs_and_its_job_keeps_where_each_came_from():
    row = _row(import_identifier="prop.external_id", import_replace_min_live=10)
    identifier, kept = import_settings.for_import(row, None)
    assert (identifier, kept["identifierSource"]) == ("prop.external_id", "data_source")
    assert kept["replaceLimits"] == {
        "minLive": 10, "deleteFraction": config.IMPORT_REPLACE_GUARD_DELETE_FRACTION,
        "createFraction": config.IMPORT_REPLACE_GUARD_CREATE_FRACTION,
        "minMatchFraction": config.IMPORT_REPLACE_MIN_MATCH_FRACTION,
        "sources": {"minLive": "data_source", "deleteFraction": "platform",
                    "createFraction": "platform", "minMatchFraction": "platform"}}
    assert import_settings.for_import(row, " urn ")[0] == "urn"
    assert import_settings.for_import(row, "urn")[1]["identifierSource"] == "request"
    assert import_settings.for_import(None, "")[:1] == ("entity_id",)
    assert import_settings.for_import(None, None)[1]["identifierSource"] == "platform"


def test_the_platforms_identifier_is_the_operators_when_it_is_one(monkeypatch):
    monkeypatch.setattr(config, "IMPORT_IDENTIFIER", "urn")
    assert import_settings.for_import(None, None)[0] == "urn"
    monkeypatch.setattr(config, "IMPORT_IDENTIFIER", "no such thing")
    assert import_settings.for_import(None, None)[0] == "entity_id"


def test_on_a_fork_a_property_default_is_entity_id_and_says_why(monkeypatch):
    row = _row(import_identifier="prop.external_id", import_replace_min_live=10)
    identifier, kept = import_settings.for_import(row, None, fork=True)
    assert (identifier, kept["identifierSource"]) == ("entity_id", "fork")
    assert kept["replaceLimits"]["minLive"] == 10, "the parent's limits still hold"
    effective = import_settings.resolve(row, fork=True)
    assert (effective["identifier"], effective["sources"]["identifier"]) == ("entity_id", "fork")
    assert import_settings.for_import(row, None)[0] == "prop.external_id", "its parent keeps it"
    # One a fork can match by stays; a property the import names is the import's (and refused).
    assert import_settings.for_import(_row(import_identifier="urn"), None, fork=True)[0] == "urn"
    assert import_settings.for_import(row, "prop.external_id", fork=True)[1]["identifierSource"] == "request"
    # The platform's too.
    monkeypatch.setattr(config, "IMPORT_IDENTIFIER", "prop.sap_id")
    assert import_settings.for_import(None, None, fork=True)[0] == "entity_id"
    assert import_settings.for_import(None, None)[0] == "prop.sap_id"


def test_on_a_fork_a_default_of_its_identifier_property_stays_as_its_parents(monkeypatch):
    # The property its data source identifies nodes by holds the urn: matched as the urn, on a
    # fork too.
    row = _row(import_identifier="prop.asset_id")
    identifier, kept = import_settings.for_import(row, None, fork=True, identity_property="asset_id")
    assert (identifier, kept["identifierSource"]) == ("prop.asset_id", "data_source")
    effective = import_settings.resolve(row, fork=True, identity_property="asset_id")
    assert (effective["identifier"], effective["sources"]["identifier"]) == ("prop.asset_id", "data_source")
    # Any other property is entity_id there.
    other = _row(import_identifier="prop.external_id")
    assert import_settings.for_import(other, None, fork=True, identity_property="asset_id")[0] == "entity_id"
    # The platform's default alike; and with no identifier property, a property is never the urn.
    monkeypatch.setattr(config, "IMPORT_IDENTIFIER", "prop.asset_id")
    identifier, kept = import_settings.for_import(None, None, fork=True, identity_property="asset_id")
    assert (identifier, kept["identifierSource"]) == ("prop.asset_id", "platform")
    assert import_settings.for_import(None, None, fork=True)[0] == "entity_id"


def test_the_guard_runs_under_the_limits_its_job_was_made_with():
    _identifier, kept = import_settings.for_import(
        _row(import_replace_min_live=10, import_replace_delete_fraction=0.9,
             import_replace_create_fraction=0.1), None)
    verdict = replace_verdict(20, 18, 2, allowed=False, limits=kept["replaceLimits"])
    assert verdict["state"] == "blocked"
    assert verdict["limits"] == {"minLive": 10, "deleteFraction": 0.9, "createFraction": 0.1}
    assert verdict["sources"] == dict.fromkeys(("minLive", "deleteFraction", "createFraction"), "data_source")
    assert replace_verdict(20, 18, 2, allowed=False)["state"] == "passed"   # the platform's: 1,000


def test_apply_writes_only_what_changed_and_inherit_clears():
    row = _row(import_identifier="urn")
    before, after = import_settings.apply(row, {"identifier": "urn", "replaceMinLive": 50})
    assert (before, after) == ({"replaceMinLive": None}, {"replaceMinLive": 50})
    before, after = import_settings.apply(row, {"identifier": "inherit"})
    assert (before, after, row.import_replace_min_live) == ({"identifier": "urn"}, {"identifier": None}, 50)


def _gate_perms(dependant) -> set:
    perms, stack = set(), [dependant]
    while stack:
        dep = stack.pop()
        perm = getattr(getattr(dep, "call", None), "required_permission", None)
        if perm:
            perms.add(perm)
        stack.extend(dep.dependencies)
    return perms


@pytest.mark.parametrize("method, permission, by_key", [
    ("GET", "workspace:datasource:read", True), ("PUT", "workspace:admin", False),
])
def test_readers_and_keys_read_them_and_admins_set_them(method, permission, by_key):
    path = "/api/v1/{ws_id}/versioning/graphs/{graph_id}/import-settings"
    found = [(r, d) for m, p, r, d in api_key_surface.routes(app) if p == path and m == method]
    assert len(found) == 1, found
    route, dependant = found[0]
    assert permission in _gate_perms(dependant)
    assert ((route.endpoint.__module__, route.endpoint.__name__) in api_key_surface.SURFACE) is by_key


class _Versioning:
    async def get_graph(self, graph_id):
        return {"graph_id": graph_id, "workspace_id": "ws_1", "data_source_id": _Versioning.ds,
                "provider_id": "prov_1", "fork_parent_graph_id": _Versioning.parent}


@pytest.fixture
def graph(monkeypatch):
    feature_flags._cache = {"versioningEnabled": True}
    feature_flags._cache_ts = time.monotonic()
    _Versioning.ds, _Versioning.parent = "ds_1", None
    app.dependency_overrides[V.get_versioning_service] = _Versioning

    async def listed(graph_id):
        return [{"name": "external_id", "status": "ready", "seq": 7, "current": True, "createdAt": "t"}]
    monkeypatch.setattr(keys, "listed", listed)
    yield _Versioning
    app.dependency_overrides.pop(V.get_versioning_service, None)
    feature_flags.invalidate()


@pytest.fixture
async def estate(db_session):
    db_session.add_all([
        WorkspaceORM(id="ws_1", name="Finance"),
        ProviderORM(id="prov_1", name="Prod graph", provider_type="falkordb"),
        WorkspaceDataSourceORM(id="ds_1", workspace_id="ws_1", provider_id="prov_1",
                               graph_name="g_fin", label="Ledger"),
    ])
    await db_session.commit()


async def _recorded(db_session) -> list[dict]:
    rows = (await db_session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type == _EVENT))).scalars().all()
    return [json.loads(r.payload) for r in rows]


@pytest.mark.asyncio
async def test_an_admin_sets_a_graphs_settings_and_a_change_is_recorded_once(
        test_client, db_session, estate, graph):
    start = await test_client.get(_PATH)
    assert start.status_code == 200, start.text
    body = start.json()
    assert body["dataSourceId"] == "ds_1" and set(body["overrides"].values()) == {None}
    assert body["effective"]["identifier"] == "entity_id"
    assert set(body["effective"]["sources"].values()) == {"platform"}
    assert body["matchingProperties"][0]["name"] == "external_id"
    assert (body["replaceGuard"], body["maxMatchingProperties"], body["followsParent"]) == (
        config.IMPORT_REPLACE_GUARD, config.MAX_MATCHING_PROPERTIES, False)

    changed = await test_client.put(_PATH, json={"identifier": " prop.external_id ",
                                                 "replaceDeleteFraction": 0.8})
    assert changed.status_code == 200, changed.text
    body = changed.json()
    assert (body["overrides"]["identifier"], body["overrides"]["replaceDeleteFraction"]) == (
        "prop.external_id", 0.8)
    assert (body["effective"]["sources"]["identifier"], body["effective"]["sources"]["replaceMinLive"]) == (
        "data_source", "platform")
    [event] = await _recorded(db_session)
    assert (event["workspace_id"], event["data_source_id"]) == ("ws_1", "ds_1")
    assert event["details"] == {"from": {"identifier": None, "replaceDeleteFraction": None},
                                "to": {"identifier": "prop.external_id", "replaceDeleteFraction": 0.8}}
    projected = catalogue.project(event_type=_EVENT, payload=event, event_version=2)
    assert (projected["audience"], projected["workspace_id"]) == ("workspace", "ws_1")
    assert (await test_client.get(_PATH)).json() == body

    again = await test_client.put(_PATH, json={"identifier": "prop.external_id"})
    assert again.status_code == 200 and len(await _recorded(db_session)) == 1

    cleared = await test_client.put(_PATH, json={"identifier": "inherit"})
    assert cleared.json()["overrides"]["identifier"] is None
    assert cleared.json()["overrides"]["replaceDeleteFraction"] == 0.8      # left out: it stays
    assert len(await _recorded(db_session)) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("body, says", [
    ({"identifier": "sap_id"}, "invalid_identifier"), ({"identifier": "prop.urn"}, "invalid_identifier"),
    ({"identifier": ""}, "invalid_identifier"),
    ({"replaceDeleteFraction": 1.5}, None), ({"replaceMinLive": -1}, None),
])
async def test_what_a_graph_may_not_be_set_to_is_a_422(test_client, db_session, estate, graph, body, says):
    resp = await test_client.put(_PATH, json=body)
    assert resp.status_code == 422, resp.text
    if says:
        assert resp.json()["detail"]["type"] == says
    assert await _recorded(db_session) == []


@pytest.mark.asyncio
async def test_a_forks_settings_are_its_parents(test_client, db_session, estate, graph):
    db_session.add(WorkspaceDataSourceORM(id="dsfork_1", workspace_id="ws_1", provider_id="prov_1",
                                          label="Ledger · try", fork_of_data_source_id="ds_1",
                                          source_mode="managed"))
    await db_session.commit()
    graph.ds = "dsfork_1"
    resp = await test_client.put(_PATH, json={"identifier": "urn"})
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["type"] == "fork_settings_follow_parent"
    assert (await test_client.get(_PATH)).json()["followsParent"] is True


class _Imports:
    """The import service as the import route meets it: the job it was asked to make."""

    def __init__(self, store):
        self.store, self.made = store, []

    async def create_import_job(self, **kwargs):
        self.made.append(kwargs)
        return {"job_id": "vjob_1", "branch_id": "br_1", "source_uri": "ws_1/dsfork_1/g_1/vjob_1/f"}

    async def start_import(self, _job_id):
        return "pending"


@pytest.mark.asyncio
async def test_on_a_fork_its_parents_property_default_is_entity_id_and_its_imports_run_by_it(
        test_client, db_session, estate, graph, tmp_path):
    from backend.app.services import fork_sources
    from backend.app.services.storage.object_store import LocalFsObjectStore
    parent = await db_session.get(WorkspaceDataSourceORM, "ds_1")
    parent.import_identifier = "prop.external_id"
    db_session.add(fork_sources.fork_row(parent, ds_id="dsfork_1", name="try", parent_graph_id="g_0",
                                         actor="u"))
    await db_session.commit()
    graph.ds, graph.parent = "dsfork_1", "g_0"
    feature_flags._cache = {"versioningEnabled": True, "forksEnabled": True}
    body = (await test_client.get(_PATH)).json()
    assert (body["overrides"]["identifier"], body["followsParent"]) == ("prop.external_id", True)
    assert (body["effective"]["identifier"], body["effective"]["sources"]["identifier"]) == (
        "entity_id", "fork")

    imports = _Imports(LocalFsObjectStore(tmp_path))
    app.dependency_overrides[V.get_import_export_service] = lambda: imports
    try:
        resp = await test_client.post("/api/v1/ws_1/versioning/graphs/g_1/imports", content=b"{}\n")
    finally:
        app.dependency_overrides.pop(V.get_import_export_service, None)
    assert resp.status_code == 202, resp.text
    [made] = imports.made
    assert (made["identifier"], made["import_settings"]["identifierSource"]) == ("entity_id", "fork")


@pytest.mark.asyncio
async def test_on_a_fork_a_default_of_its_identifier_property_stays_and_its_imports_run_by_it(
        test_client, db_session, estate, graph, tmp_path):
    from backend.app.services import fork_sources
    from backend.app.services.storage.object_store import LocalFsObjectStore
    # Its provider identifies the nodes by asset_id: neither data source's row names it.
    (await db_session.get(ProviderORM, "prov_1")).identity_property = "asset_id"
    parent = await db_session.get(WorkspaceDataSourceORM, "ds_1")
    parent.import_identifier = "prop.asset_id"
    db_session.add(fork_sources.fork_row(parent, ds_id="dsfork_1", name="try", parent_graph_id="g_0",
                                         actor="u"))
    await db_session.commit()
    graph.ds, graph.parent = "dsfork_1", "g_0"
    feature_flags._cache = {"versioningEnabled": True, "forksEnabled": True}
    effective = (await test_client.get(_PATH)).json()["effective"]
    assert (effective["identifier"], effective["sources"]["identifier"]) == (
        "prop.asset_id", "data_source")

    imports = _Imports(LocalFsObjectStore(tmp_path))
    app.dependency_overrides[V.get_import_export_service] = lambda: imports
    try:
        resp = await test_client.post("/api/v1/ws_1/versioning/graphs/g_1/imports", content=b"{}\n")
    finally:
        app.dependency_overrides.pop(V.get_import_export_service, None)
    assert resp.status_code == 202, resp.text
    [made] = imports.made
    assert (made["identifier"], made["import_settings"]["identifierSource"]) == (
        "prop.asset_id", "data_source")


@pytest.mark.asyncio
async def test_an_import_takes_its_graphs_identifier_unless_it_names_one(db_session, estate):
    ds = await db_session.get(WorkspaceDataSourceORM, "ds_1")
    ds.import_identifier, ds.import_replace_min_match_fraction = "urn", 0.5
    await db_session.flush()
    identifier, kept = await V._import_settings_for(db_session, "ds_1", None)
    assert (identifier, kept["identifierSource"], kept["replaceLimits"]["minMatchFraction"]) == (
        "urn", "data_source", 0.5)
    assert (await V._import_settings_for(db_session, "ds_1", "prop.sap_id"))[0] == "prop.sap_id"
    assert (await V._import_settings_for(db_session, None, None))[1]["identifierSource"] == "platform"
    with pytest.raises(HTTPException) as caught:
        await V._import_settings_for(db_session, "ds_1", "sap_id")
    assert (caught.value.status_code, caught.value.detail["type"]) == (422, "invalid_identifier")
