"""Bring your own data: a graph started in the Playground from a person's own things and
connections (``POST /playground/imports``).

These pin what one is: the rows held to their limits (413 ``too_large``) and each row to its own
(422 ``invalid_rows``, naming the rows); a data model made for this graph alone from the rows'
types, each connection type joining the types its rows join, that the graph's strict checks
accept the rows on; then a starter graph as a sample is — a blank graph of the person's quota on
the Playground's sandbox provider, the rows its first version, a Context View and a Graph view,
the data source described. Refused, or failing, it leaves nothing behind, its data model included.

The version store is faked (it runs on Postgres only).
"""
from __future__ import annotations

import contextlib
import json

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.api.v1.endpoints import playground as playground_endpoints
from backend.app.api.v1.endpoints.versioning import _live_ontology_rules, get_versioning_service
from backend.app.auth.dependencies import get_current_user, get_optional_user, get_permission_claims
from backend.app.db.models import (OntologyORM, ProviderORM, ViewORM, ViewVersionORM, WorkspaceDataSourceORM,
                                   WorkspaceORM)
from backend.app.providers.manager import provider_manager
from backend.app.services import playground_imports, playground_starter
from backend.app.services.feature_flags import feature_flags
from backend.app.services.layout_config import parse_reference_layout
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.versioning import purge_worker
from backend.app.services.versioning.ontology import validate_entities_rich
from backend.auth_service.interface import User

PG = "ws_play"
SANDBOX = "prov_sandbox"
MEMBER_PERMS = (
    "workspace:datasource:manage", "workspace:datasource:read", "workspace:ontology:read",
    "workspace:provider:read", "workspace:view:create", "workspace:view:delete",
    "workspace:view:edit", "workspace:view:read",
)
URL = "/api/v1/playground/imports"


def _user(uid: str) -> User:
    return User(id=uid, email=f"{uid}@example.com", first_name="T", last_name="U", role="user",
                status="active", created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z")


BEN = _user("usr_ben")
MEMBER = PermissionClaims(sid="s_m", ws_perms={PG: MEMBER_PERMS})
OUTSIDER = PermissionClaims(sid="s_o", ws_perms={"ws_team": MEMBER_PERMS})

#: A small pipeline, as a client reads it from a file.
FILE = {
    "name": "Orders pipeline",
    "description": "How an order reaches the finance dashboard.",
    "things": [
        {"key": "shop", "type": "Source system", "name": "Web shop", "properties": {"owner": "E-commerce"}},
        {"key": "orders", "type": "Warehouse table", "name": "raw.orders", "description": "One row per order.",
         "properties": {"rows": 120000, "fresh": True, "sla_hours": 1.5, "steward": None}, "tags": ["pii"]},
        {"key": "fct_orders", "type": "Warehouse table", "name": "fct_orders", "tags": ["certified"]},
        {"key": "finance", "type": "Dashboard", "name": "Finance overview"},
    ],
    "connections": [
        {"from": "shop", "type": "Loads into", "to": "orders"},
        {"from": "orders", "type": "Transforms into", "to": "fct_orders"},
        {"from": "fct_orders", "type": "Powers", "to": "finance"},
        {"from": "fct_orders", "type": "Powers", "to": "finance"},          # the same row twice: one connection
    ],
}


class _VersionStore:
    def __init__(self):
        self.graphs: list = []
        self.imports: list = []
        self.purged: list = []
        self.projected: list = []
        self.down = False

    async def create_graph(self, **kwargs):
        self.graphs.append(kwargs)
        n = len(self.graphs)
        return {"graph_id": f"g_{n}", "main_branch_id": f"br_{n}", "genesis_commit_id": f"c_{n}"}

    async def bulk_ingest(self, **kwargs):
        if self.down:
            raise RuntimeError("version store down")
        self.imports.append(kwargs)
        return {"commit_id": "c_import", "commit_seq": 2, "ingested": len(kwargs["rows"]), "rejected": []}


@contextlib.contextmanager
def _as(user: User, claims: PermissionClaims):
    from backend.app.main import app

    async def _u():
        return user

    saved = {k: app.dependency_overrides.get(k) for k in (get_current_user, get_optional_user, get_permission_claims)}
    app.dependency_overrides[get_current_user] = _u
    app.dependency_overrides[get_optional_user] = _u
    app.dependency_overrides[get_permission_claims] = lambda: claims
    try:
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                app.dependency_overrides.pop(k, None)
            else:
                app.dependency_overrides[k] = v


@pytest.fixture
def store(monkeypatch):
    from backend.app.main import app

    fake = _VersionStore()

    async def _project(graph_id):
        fake.projected.append(graph_id)

    async def _purge(**kwargs):
        fake.purged.append(kwargs)
        return "job_1"

    monkeypatch.setattr(playground_endpoints, "project_now", _project)
    monkeypatch.setattr(purge_worker, "create_purge_job", _purge)
    app.dependency_overrides[get_versioning_service] = lambda: fake
    yield fake
    app.dependency_overrides.pop(get_versioning_service, None)


@pytest.fixture
async def playground(db_session):
    """The Playground, switched on, on a reachable sandbox provider, two graphs each."""
    for key in ("playgroundEnabled", "blankModelsEnabled", "versioningEnabled"):
        feature_flags._cache[key] = True
    db_session.add_all([
        ProviderORM(id=SANDBOX, name="Sandbox", provider_type="falkordb", host="sandbox", port=6379),
        WorkspaceORM(id=PG, name="Playground", kind="playground", request_policy="open", publish_policy="request",
                     playground_settings=json.dumps({"sandboxProviderId": SANDBOX, "graphQuota": 2})),
    ])
    await db_session.commit()
    provider_manager.warmup_cache[SANDBOX] = {"ok": True}
    yield
    provider_manager.warmup_cache.pop(SANDBOX, None)


async def _post(test_client, body, claims=MEMBER):
    with _as(BEN, claims):
        return await test_client.post(URL, json=body)


async def _nothing_made(db_session, store) -> None:
    """Nothing of an import is left: no data model, data source, view or graph."""
    assert (await db_session.execute(select(OntologyORM).where(OntologyORM.id.like("bp_import_%")))).scalars().all() == []
    assert (await db_session.execute(select(WorkspaceDataSourceORM).where(
        WorkspaceDataSourceORM.created_by == BEN.id, WorkspaceDataSourceORM.deleted_at.is_(None)))).scalars().all() == []
    assert (await db_session.execute(select(ViewORM))).scalars().all() == []
    assert store.imports == []


# ── A file becomes a graph ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_file_becomes_a_graph_with_a_data_model_of_its_own(
        test_client: AsyncClient, playground, store, db_session):
    r = await _post(test_client, FILE)
    assert r.status_code == 201, r.text
    body = r.json()
    assert set(body) == {"dataSourceId", "viewId", "viewIds"}
    assert set(body["viewIds"]) == {"context", "graph"} and body["viewId"] == body["viewIds"]["context"]

    # A blank graph of Ben's on the sandbox provider, described, on a data model of its own.
    ds = await db_session.get(WorkspaceDataSourceORM, body["dataSourceId"])
    assert (ds.workspace_id, ds.provider_id, ds.label, ds.description, ds.created_by) == (
        PG, SANDBOX, "Orders pipeline", FILE["description"], BEN.id)
    assert ds.ontology_id.startswith("bp_import_") and ds.tags is None and ds.links is None
    [graph] = store.graphs
    assert (graph["kind"], graph["ontology_enforcement"], graph["base_ontology_id"]) == (
        "blank", "strict", ds.ontology_id)
    ontology = await db_session.get(OntologyORM, ds.ontology_id)
    assert (ontology.name, ontology.is_published, ontology.is_system) == ("Orders pipeline data model", True, False)

    # Its types are the file's, named as it names them; each connection joins what its rows join.
    entities = json.loads(ontology.entity_type_definitions)
    assert {tid: e["name"] for tid, e in entities.items()} == {
        "sourceSystem": "Source system", "warehouseTable": "Warehouse table", "dashboard": "Dashboard"}
    relationships = json.loads(ontology.relationship_type_definitions)
    assert {rid: (r["name"], r["source_types"], r["target_types"], r["is_lineage"])
            for rid, r in relationships.items()} == {
        "LOADS_INTO": ("Loads into", ["sourceSystem"], ["warehouseTable"], True),
        "TRANSFORMS_INTO": ("Transforms into", ["warehouseTable"], ["warehouseTable"], True),
        "POWERS": ("Powers", ["warehouseTable"], ["dashboard"], True)}
    assert json.loads(ontology.containment_edge_types) == []

    # The rows are its first version, as one day-0 import — then projected.
    [load] = store.imports
    assert (load["graph_id"], load["actor"], load["standard_ids"], load["message"]) == (
        "g_1", BEN.id, True, "Imported Orders pipeline")
    nodes = [row for row in load["rows"] if row["kind"] == "node"]
    edges = [row for row in load["rows"] if row["kind"] == "edge"]
    assert nodes[1] == {"kind": "node", "urn": "urn:playground:orders", "entityType": "warehouseTable",
                        "displayName": "raw.orders", "description": "One row per order.",
                        "properties": {"rows": 120000, "fresh": True, "sla_hours": 1.5, "steward": None},
                        "tags": ["pii"]}
    assert [(e["source"], e["edgeType"], e["target"]) for e in edges] == [
        ("urn:playground:shop", "LOADS_INTO", "urn:playground:orders"),
        ("urn:playground:orders", "TRANSFORMS_INTO", "urn:playground:fct_orders"),
        ("urn:playground:fct_orders", "POWERS", "urn:playground:finance")]
    assert store.projected == ["g_1"]

    # A Context View, one layer per type in the file's order, and a Graph view; each at version 1.
    context = await db_session.get(ViewORM, body["viewIds"]["context"])
    graph_view = await db_session.get(ViewORM, body["viewIds"]["graph"])
    assert (context.view_type, graph_view.view_type, context.visibility, context.name) == (
        "reference", "graph", "workspace", "Orders pipeline")
    assert [layer["entityTypes"] for layer in parse_reference_layout(json.loads(context.config)).layers] == [
        ["sourceSystem"], ["warehouseTable"], ["dashboard"]]
    versions = (await db_session.execute(select(ViewVersionORM))).scalars().all()
    assert sorted((v.view_id, v.version) for v in versions) == sorted(
        (view_id, 1) for view_id in body["viewIds"].values())


@pytest.mark.asyncio
async def test_its_strict_data_model_accepts_the_rows(db_session):
    starter = playground_imports.starter_of(playground_imports.PlaygroundImport(**FILE), "bp_import_x")
    db_session.add_all([ProviderORM(id="prov_x", name="X", provider_type="falkordb"),
                        WorkspaceORM(id="ws_x", name="X"), playground_starter.ontology_row(starter)])
    await db_session.flush()
    db_session.add(WorkspaceDataSourceORM(id="ds_x", workspace_id="ws_x", provider_id="prov_x",
                                          ontology_id="bp_import_x"))
    await db_session.commit()
    rules = await _live_ontology_rules(db_session, "ws_x", "ds_x", fail_closed=True)
    nodes = [r for r in starter.rows if r["kind"] == "node"]
    entities = [(n["urn"], "node", n, "create") for n in nodes] + [
        (f"e{i}", "edge", {"edgeType": r["edgeType"], "sourceEntityId": r["source"],
                           "targetEntityId": r["target"]}, "create")
        for i, r in enumerate(starter.rows) if r["kind"] == "edge"]
    assert validate_entities_rich(entities, {n["urn"]: n["entityType"] for n in nodes}, rules) == []
    assert all(rules.is_root_type(n["entityType"]) for n in nodes)          # lineage only: all top level


def test_type_ids_are_derived_from_the_names_and_never_collide():
    body = playground_imports.PlaygroundImport(name="Types", things=[
        {"key": "a", "type": "Table", "name": "A"}, {"key": "b", "type": "table", "name": "B"},
        {"key": "c", "type": "ML  model (v2)", "name": "C"}, {"key": "d", "type": "3rd party", "name": "D"},
        {"key": "urn:li:x", "type": "Données", "name": "E"},
    ], connections=[{"from": "a", "type": "feeds", "to": "b"}, {"from": "b", "type": "Feeds", "to": "c"},
                    {"from": "c", "type": "2-way", "to": "d"}, {"from": "d", "type": "→", "to": "urn:li:x"}])
    starter = playground_imports.starter_of(body, "bp_import_t")
    assert {tid: t.name for tid, t in starter.entity_types.items()} == {
        "table": "Table", "table2": "table", "mlModelV2": "ML  model (v2)", "t3rdParty": "3rd party",
        "donnees": "Données"}
    assert {rid: r.name for rid, r in starter.relationship_types.items()} == {
        "FEEDS": "feeds", "FEEDS_2": "Feeds", "R_2_WAY": "2-way", "LINKED_TO": "→"}
    assert [r["urn"] for r in starter.rows if r["kind"] == "node"][-1] == "urn:li:x"    # a urn stays one


# ── What refuses one ────────────────────────────────────────────────────

@pytest.mark.asyncio
@pytest.mark.parametrize("section, limit, body", [
    ("things", 5000, {**FILE, "things": [{"key": f"k{i}", "type": "T", "name": "n"} for i in range(5001)],
                      "connections": []}),
    ("connections", 20000, {**FILE, "connections": [FILE["connections"][0]] * 20001}),
    ("thingTypes", 50, {**FILE, "things": [{"key": f"k{i}", "type": f"T{i}", "name": "n"} for i in range(51)],
                        "connections": []}),
    ("connectionTypes", 50, {**FILE, "connections": [{"from": "shop", "type": f"r{i}", "to": "orders"}
                                                     for i in range(51)]}),
])
async def test_a_file_past_its_limits_is_refused_too_large(
        test_client: AsyncClient, playground, store, db_session, section, limit, body):
    r = await _post(test_client, body)
    assert r.status_code == 413, r.text
    detail = r.json()["detail"]
    assert (detail["type"], detail["section"], detail["limit"]) == ("too_large", section, limit)
    await _nothing_made(db_session, store)


@pytest.mark.asyncio
async def test_rows_that_are_wrong_are_named_and_nothing_is_made(
        test_client: AsyncClient, playground, store, db_session):
    body = {**FILE, "things": FILE["things"] + [
        {"key": "", "type": "Dashboard", "name": "No key"},
        {"key": "orders", "type": "Dashboard", "name": "Same key"},
        {"key": "x", "type": "T" * 61, "name": "x", "properties": {"bad": [1, 2]}},
        "not a row",
        {"key": "urn:playground:shop", "type": "Dashboard", "name": "The shop, by its urn"},
    ], "connections": FILE["connections"] + [{"from": "shop", "type": "Feeds", "to": "nowhere"}, {"from": "shop"}]}
    r = await _post(test_client, body)
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert detail["type"] == "invalid_rows" and detail["count"] == len(detail["errors"])
    assert {(e["section"], e["index"], e["field"], e["code"]) for e in detail["errors"]} == {
        ("things", 4, "key", "invalid"), ("things", 5, "key", "duplicate_key"),
        ("things", 6, "type", "invalid"), ("things", 6, "properties", "invalid"),
        ("things", 7, "row", "invalid"), ("things", 8, "key", "duplicate_key"),
        ("connections", 4, "to", "unknown_key"),
        ("connections", 5, "type", "invalid"), ("connections", 5, "to", "invalid"),
    }
    assert all(e["message"] for e in detail["errors"])
    await _nothing_made(db_session, store)


@pytest.mark.asyncio
async def test_only_the_first_fifty_wrong_rows_are_listed(test_client: AsyncClient, playground, store):
    body = {**FILE, "connections": [{"from": "shop", "type": "Feeds", "to": f"nowhere_{i}"} for i in range(80)]}
    r = await _post(test_client, body)
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert (len(detail["errors"]), detail["count"]) == (50, 80)
    assert [e["index"] for e in detail["errors"]] == list(range(50))


@pytest.mark.asyncio
async def test_an_import_counts_against_the_quota_and_is_refused_past_it(
        test_client: AsyncClient, playground, store, db_session):
    first = await _post(test_client, FILE)
    second = await _post(test_client, FILE)
    store.imports.clear()
    third = await _post(test_client, FILE)
    assert (first.status_code, second.status_code) == (201, 201)
    assert third.status_code == 409 and third.json()["detail"]["type"] == "playground_quota"
    assert len(store.graphs) == 2 and store.imports == []
    # The refused one made no data model: one each for the two graphs made.
    assert len((await db_session.execute(select(OntologyORM.id).where(
        OntologyORM.id.like("bp_import_%")))).scalars().all()) == 2


@pytest.mark.asyncio
async def test_someone_not_in_the_playground_is_refused(test_client: AsyncClient, playground, store, db_session):
    r = await _post(test_client, FILE, claims=OUTSIDER)
    assert r.status_code == 403 and r.json()["detail"]["type"] == "playground_not_member"
    await _nothing_made(db_session, store)


@pytest.mark.asyncio
@pytest.mark.parametrize("switch", ["playgroundEnabled", "blankModelsEnabled", "versioningEnabled"])
async def test_nothing_is_imported_while_a_switch_it_needs_is_off(
        test_client: AsyncClient, playground, store, db_session, switch):
    feature_flags._cache[switch] = False
    r = await _post(test_client, FILE)
    assert r.status_code == 403 and r.json()["detail"]["feature"] == switch
    await _nothing_made(db_session, store)


def test_an_api_key_cannot_start_one():
    """Like every Playground route, starting a graph there is a person's: no key reaches it."""
    from backend.app.auth import api_key_surface

    for route in (playground_endpoints.import_own_data, playground_endpoints.start_sample):
        assert (route.__module__, route.__name__) not in api_key_surface.SURFACE


@pytest.mark.asyncio
async def test_an_import_that_cannot_be_loaded_leaves_nothing_behind(
        test_client: AsyncClient, playground, store, db_session):
    store.down = True
    r = await _post(test_client, FILE)
    assert r.status_code == 502 and r.json()["detail"]["type"] == "import_load_failed"
    assert [(p["graph_id"], p["workspace_id"]) for p in store.purged] == [("g_1", PG)]
    await _nothing_made(db_session, store)


@pytest.mark.asyncio
async def test_an_import_whose_graph_cannot_be_made_takes_its_data_model_with_it(
        test_client: AsyncClient, playground, store, db_session):
    (await db_session.get(ProviderORM, SANDBOX)).is_active = False      # switched off since it was set up
    await db_session.commit()
    r = await _post(test_client, FILE)
    assert r.status_code == 422 and r.json()["detail"]["type"] == "provider_unsupported", r.text
    assert store.graphs == []
    await _nothing_made(db_session, store)
