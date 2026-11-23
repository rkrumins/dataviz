"""A graph for your own data, started in the Playground (``POST /playground/graphs``).

These pin what one is: a blank graph of the person's quota on the Playground's sandbox provider,
a Context View and the views asked for beside it (a Graph view; a Hierarchy view when its layer has
a containment among the file's types), the data source described — and no rows: the file loads through
the standard import, which holds its rows to the graph's semantic layer. It is built on

* a semantic layer on offer (``ontologyId``): refused as ``playground_layers.assert_offered``
  refuses it; its Context View's layers are the types the file uses, as ``starter_types_of`` gives
  them; never made, never dropped — a graph that can't be made leaves it as it was;
* or a layer of the person's own, made and published from the file's types (``infer``, held to
  its limits: 413 ``too_large``, 422 ``invalid_rows``): ``create_owned``, then views over all its
  types; a graph that can't be made takes the layer with it (``drop_owned``).

``playground_layers`` and the version store (it runs on Postgres only) are faked.
"""
from __future__ import annotations

import contextlib
import json

import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy import delete, select

from backend.app.api.v1.endpoints import playground as playground_endpoints
from backend.app.api.v1.endpoints.versioning import get_versioning_service
from backend.app.auth.dependencies import get_current_user, get_optional_user, get_permission_claims
from backend.app.db.models import OntologyORM, ProviderORM, ViewORM, ViewVersionORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.db.repositories import view_repo
from backend.app.providers.manager import provider_manager
from backend.app.services import playground_layers, playground_starter
from backend.app.services.feature_flags import feature_flags
from backend.app.services.layout_config import parse_reference_layout
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.playground_starter import EntityType, RelationshipType, Starter
from backend.app.services.versioning import purge_worker
from backend.auth_service.interface import User

PG = "ws_play"
SANDBOX = "prov_sandbox"
MEMBER_PERMS = (
    "workspace:datasource:manage", "workspace:datasource:read", "workspace:ontology:read",
    "workspace:provider:read", "workspace:view:create", "workspace:view:delete",
    "workspace:view:edit", "workspace:view:read",
)
URL = "/api/v1/playground/graphs"


def _user(uid: str) -> User:
    return User(id=uid, email=f"{uid}@example.com", first_name="T", last_name="U", role="user",
                status="active", created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z")


BEN = _user("usr_ben")
MEMBER = PermissionClaims(sid="s_m", ws_perms={PG: MEMBER_PERMS})
OUTSIDER = PermissionClaims(sid="s_o", ws_perms={"ws_team": MEMBER_PERMS})

#: An approved org-wide layer, its types in its own order.
LAYER = "ont_finance"
LAYER_TYPES = (
    {"sourceSystem": EntityType("Source system", "Source systems", "Where data starts.", "Server", "#6366f1"),
     "warehouseTable": EntityType("Warehouse table", "Warehouse tables", "A table.", "Table", "#0ea5e9"),
     "dashboard": EntityType("Dashboard", "Dashboards", "A dashboard.", "LayoutDashboard", "#10b981")},
    {"LOADS_INTO": RelationshipType("Loads into", "Loads into a table.", "#f59e0b"),
     "POWERS": RelationshipType("Powers", "Powers a dashboard.", "#ec4899")},
)

ON_A_LAYER = {"name": "Orders pipeline", "description": "How an order reaches the finance dashboard.",
              "model": {"ontologyId": LAYER}, "types": ["dashboard", "sourceSystem"]}
INFERRED = {"thingTypes": ["Source system", "Warehouse table"],
            "connectionTypes": [{"name": "Loads into", "ends": [["Source system", "Warehouse table"]]}]}
OF_THEIR_OWN = {"name": "Orders pipeline", "model": {"infer": INFERRED}}


def _layer_row(ontology_id: str, types) -> OntologyORM:
    """A published layer with ``types``, as a blank graph needs one."""
    return playground_starter.ontology_row(Starter(
        title=ontology_id, description=None, icon="Box", ontology_id=ontology_id, ontology_name=ontology_id,
        ontology_description="", entity_types=types[0], relationship_types=types[1], fields=(), rows=(),
        message="", view_name=""))


class _VersionStore:
    def __init__(self):
        self.graphs: list = []
        self.imports: list = []
        self.purged: list = []
        self.projected: list = []

    async def create_graph(self, **kwargs):
        self.graphs.append(kwargs)
        n = len(self.graphs)
        return {"graph_id": f"g_{n}", "main_branch_id": f"br_{n}", "genesis_commit_id": f"c_{n}"}

    async def bulk_ingest(self, **kwargs):
        self.imports.append(kwargs)
        return {"commit_id": "c_import", "commit_seq": 2, "ingested": len(kwargs["rows"]), "rejected": []}


class _Layers:
    """``playground_layers``, faked: what it was asked, the layers it made and dropped, and the
    refusal it answers with when it is given one."""

    def __init__(self):
        self.asked: list = []
        self.owned: list = []
        self.dropped: list = []
        self.refusal = None
        self.types = {LAYER: LAYER_TYPES}

    async def assert_offered(self, session, claims, user_id, ontology_id):
        self.asked.append(("assert_offered", user_id, ontology_id))
        if self.refusal:
            raise self.refusal
        return await session.get(OntologyORM, ontology_id)

    async def starter_types_of(self, session, ontology_id, used_entity_types=None):
        self.asked.append(("starter_types_of", ontology_id, used_entity_types))
        entities, relationships = self.types[ontology_id]
        return ({tid: t for tid, t in entities.items() if used_entity_types is None or tid in used_entity_types},
                relationships)

    async def create_owned(self, session, *, claims, user_id, playground_id, name, description, source, publish):
        self.owned.append({"user_id": user_id, "playground_id": playground_id, "name": name,
                           "description": description, "source": source, "publish": publish})
        if self.refusal:
            raise self.refusal
        entities: set = set()
        relationships: set = set()
        infer = source["infer"]
        types = ({playground_starter._entity_type_id(n, entities): EntityType(n, n, "", "Box", "#64748b")
                  for n in infer["thingTypes"]},
                 {playground_starter._relationship_type_id(c["name"], relationships):
                  RelationshipType(c["name"], "", "#64748b") for c in infer["connectionTypes"]})
        row = _layer_row(f"ont_own_{len(self.owned)}", types)
        row.scope = "workspace"
        session.add(row)
        await session.commit()
        self.types[row.id] = types
        return row

    async def drop_owned(self, session, ontology_id):
        self.dropped.append(ontology_id)
        await session.execute(delete(OntologyORM).where(OntologyORM.id == ontology_id))


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
def layers(monkeypatch):
    fake = _Layers()
    for name in ("assert_offered", "starter_types_of", "create_owned", "drop_owned"):
        monkeypatch.setattr(playground_layers, name, getattr(fake, name))
    return fake


@pytest.fixture
async def playground(db_session):
    """The Playground, switched on, on a reachable sandbox provider, two graphs each; and an
    approved layer."""
    for key in ("playgroundEnabled", "blankModelsEnabled", "versioningEnabled"):
        feature_flags._cache[key] = True
    db_session.add_all([
        ProviderORM(id=SANDBOX, name="Sandbox", provider_type="falkordb", host="sandbox", port=6379),
        WorkspaceORM(id=PG, name="Playground", kind="playground", request_policy="open", publish_policy="request",
                     playground_settings=json.dumps({"sandboxProviderId": SANDBOX, "graphQuota": 2})),
        _layer_row(LAYER, LAYER_TYPES),
    ])
    await db_session.commit()
    provider_manager.warmup_cache[SANDBOX] = {"ok": True}
    yield
    provider_manager.warmup_cache.pop(SANDBOX, None)


async def _post(test_client, body, claims=MEMBER):
    with _as(BEN, claims):
        return await test_client.post(URL, json=body)


async def _nothing_made(db_session, store) -> None:
    """Nothing of a graph is left: no data source, view or rows."""
    assert (await db_session.execute(select(WorkspaceDataSourceORM).where(
        WorkspaceDataSourceORM.created_by == BEN.id, WorkspaceDataSourceORM.deleted_at.is_(None)))).scalars().all() == []
    assert (await db_session.execute(select(ViewORM))).scalars().all() == []
    assert store.imports == []


async def _context_layers(db_session, view_id) -> list:
    view = await db_session.get(ViewORM, view_id)
    return [layer["entityTypes"] for layer in parse_reference_layout(json.loads(view.config)).layers]


def _views_fail(monkeypatch):
    async def _boom(*_args, **_kwargs):
        raise RuntimeError("view store down")
    monkeypatch.setattr(view_repo, "create_view", _boom)


# ── On an approved layer ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_graph_on_an_approved_layer_has_no_rows_and_its_views_are_the_files_types(
        test_client: AsyncClient, playground, store, layers, db_session):
    r = await _post(test_client, {**ON_A_LAYER, "views": ["graph"]})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body == {**body, "graphId": "g_1", "mainBranchId": "br_1"}
    assert set(body) == {"dataSourceId", "graphId", "mainBranchId", "viewId", "viewIds", "ontologyId", "typeIds"}
    assert body["typeIds"] == {}                         # a layer on offer: the rows name its ids already
    assert set(body["viewIds"]) == {"context", "graph"} and body["viewId"] == body["viewIds"]["context"]

    # Asked of the layer whether it is on offer to Ben, then its types — those the file uses.
    assert layers.asked == [("assert_offered", BEN.id, LAYER),
                            ("starter_types_of", LAYER, ["dashboard", "sourceSystem"])]
    assert layers.owned == [] and layers.dropped == []

    # A blank graph of Ben's on the sandbox provider, described, on the approved layer — no rows —
    # identifying its things by ``id``.
    ds = await db_session.get(WorkspaceDataSourceORM, body["dataSourceId"])
    assert (ds.workspace_id, ds.provider_id, ds.label, ds.description, ds.created_by, ds.ontology_id) == (
        PG, SANDBOX, "Orders pipeline", ON_A_LAYER["description"], BEN.id, LAYER)
    assert ds.identity_property == "id"
    [graph] = store.graphs
    assert (graph["kind"], graph["ontology_enforcement"], graph["base_ontology_id"]) == ("blank", "strict", LAYER)
    assert store.imports == [] and store.projected == ["g_1"]

    # A Context View, one layer per type the file uses, in the layer's order, and a Graph view.
    context = await db_session.get(ViewORM, body["viewIds"]["context"])
    graph_view = await db_session.get(ViewORM, body["viewIds"]["graph"])
    assert (context.view_type, graph_view.view_type, context.visibility, context.name) == (
        "reference", "graph", "workspace", "Orders pipeline")
    assert await _context_layers(db_session, context.id) == [["sourceSystem"], ["dashboard"]]
    versions = (await db_session.execute(select(ViewVersionORM))).scalars().all()
    assert sorted((v.view_id, v.version) for v in versions) == sorted(
        (view_id, 1) for view_id in body["viewIds"].values())


@pytest.mark.asyncio
async def test_a_blank_graph_outside_the_playground_keeps_the_identity_it_inherits(
        test_client: AsyncClient, playground, store, db_session):
    from backend.app.api.v1.endpoints import versioning as versioning_ep
    db_session.add(WorkspaceORM(id="ws_team", name="Team"))
    await db_session.commit()
    made = await versioning_ep.create_blank_graph("ws_team", versioning_ep.CreateBlankGraphRequest(
        name="Drawn by hand", providerId=SANDBOX, ontologyId=LAYER), BEN, store, db_session, claims=None)
    ds = await db_session.get(WorkspaceDataSourceORM, made["data_source_id"])
    assert ds.workspace_id == "ws_team" and ds.identity_property is None


@pytest.mark.asyncio
async def test_asked_for_no_other_view_it_opens_in_a_context_view_alone(
        test_client: AsyncClient, playground, store, layers, db_session):
    r = await _post(test_client, ON_A_LAYER)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["viewIds"] == {"context": body["viewId"]}
    [view] = (await db_session.execute(select(ViewORM))).scalars().all()
    assert (view.id, view.view_type) == (body["viewId"], "reference")


@pytest.mark.asyncio
async def test_a_hierarchy_asked_of_a_layer_with_no_containment_is_said_not_made(
        test_client: AsyncClient, playground, store, layers, db_session):
    r = await _post(test_client, {**ON_A_LAYER, "views": ["graph", "hierarchy"]})
    assert r.status_code == 201, r.text
    ids = r.json()["viewIds"]
    assert set(ids) == {"context", "graph", "hierarchy"} and ids["hierarchy"] is None
    views = (await db_session.execute(select(ViewORM))).scalars().all()
    assert sorted(v.view_type for v in views) == ["graph", "reference"]


@pytest.mark.asyncio
async def test_a_hierarchy_is_made_of_a_layers_containment_among_the_files_types(
        test_client: AsyncClient, playground, store, layers, db_session):
    held = ({**LAYER_TYPES[0], "metric": EntityType("Metric", "Metrics", "A number.", "Gauge", "#14b8a6")},
            {**LAYER_TYPES[1], "HAS_METRIC": RelationshipType(
                "Has metric", "A dashboard shows it.", "#14b8a6", containment=True,
                ends=(("dashboard",), ("metric",)))})
    db_session.add(_layer_row("ont_held", held))
    await db_session.commit()
    layers.types["ont_held"] = held
    r = await _post(test_client, {**ON_A_LAYER, "model": {"ontologyId": "ont_held"},
                                  "types": ["dashboard", "metric"], "views": ["hierarchy"]})
    assert r.status_code == 201, r.text
    ids = r.json()["viewIds"]
    assert set(ids) == {"context", "hierarchy"} and ids["hierarchy"]
    hierarchy = await db_session.get(ViewORM, ids["hierarchy"])
    assert hierarchy.view_type == "hierarchy" and hierarchy.name == "Orders pipeline: Dashboards and their metrics"
    assert json.loads(hierarchy.config)["content"]["visibleEntityTypes"] == ["dashboard", "metric"]


@pytest.mark.asyncio
async def test_a_view_asked_for_whose_layout_is_withdrawn_is_refused_before_anything_is_made(
        test_client: AsyncClient, playground, store, layers, db_session):
    feature_flags._cache["allowedViewModes"] = ["graph", "reference"]       # no Hierarchy views
    r = await _post(test_client, {**ON_A_LAYER, "views": ["hierarchy"]})
    assert r.status_code == 403 and r.json()["detail"]["feature"] == "allowedViewModes", r.text
    assert store.graphs == [] and layers.asked == []
    await _nothing_made(db_session, store)


@pytest.mark.asyncio
async def test_a_file_that_names_no_types_lays_out_all_of_the_layers(
        test_client: AsyncClient, playground, store, layers, db_session):
    r = await _post(test_client, {k: v for k, v in ON_A_LAYER.items() if k != "types"})
    assert r.status_code == 201, r.text
    assert layers.asked[-1] == ("starter_types_of", LAYER, None)
    assert await _context_layers(db_session, r.json()["viewId"]) == [
        ["sourceSystem"], ["warehouseTable"], ["dashboard"]]


@pytest.mark.asyncio
@pytest.mark.parametrize("code, kind", [
    (404, "unknown_ontology"), (422, "ontology_not_published"), (403, "ontology_not_offered")])
async def test_a_layer_not_on_offer_is_refused_as_assert_offered_refuses_it(
        test_client: AsyncClient, playground, store, layers, db_session, code, kind):
    layers.refusal = HTTPException(status_code=code, detail={"type": kind, "message": "No."})
    r = await _post(test_client, ON_A_LAYER)
    assert r.status_code == code and r.json()["detail"]["type"] == kind
    assert store.graphs == [] and layers.owned == []
    await _nothing_made(db_session, store)


@pytest.mark.asyncio
async def test_a_graph_on_an_approved_layer_that_cannot_be_made_leaves_the_layer_as_it_was(
        test_client: AsyncClient, playground, store, layers, db_session, monkeypatch):
    _views_fail(monkeypatch)
    r = await _post(test_client, ON_A_LAYER)
    assert r.status_code == 502 and r.json()["detail"]["type"] == "graph_create_failed"
    assert [(p["graph_id"], p["workspace_id"]) for p in store.purged] == [("g_1", PG)]
    await _nothing_made(db_session, store)
    assert layers.dropped == []
    db_session.expire_all()
    assert (await db_session.get(OntologyORM, LAYER)).is_published is True


# ── On a layer of their own, from the file's types ──────────────────────

@pytest.mark.asyncio
async def test_a_file_makes_a_published_layer_of_their_own_and_views_over_its_types(
        test_client: AsyncClient, playground, store, layers, db_session):
    r = await _post(test_client, OF_THEIR_OWN)
    assert r.status_code == 201, r.text
    body = r.json()
    assert layers.owned == [{"user_id": BEN.id, "playground_id": PG, "name": "Orders pipeline data model",
                             "description": "Made for the graph “Orders pipeline”, from the types in its file.",
                             "source": {"infer": INFERRED}, "publish": True}]
    assert layers.asked == [("starter_types_of", "ont_own_1", None)]
    ds = await db_session.get(WorkspaceDataSourceORM, body["dataSourceId"])
    assert ds.ontology_id == "ont_own_1" and store.graphs[0]["base_ontology_id"] == "ont_own_1"
    assert store.imports == [] and layers.dropped == []
    assert await _context_layers(db_session, body["viewId"]) == [["sourceSystem"], ["warehouseTable"]]
    # Each of the file's types by its id there, so its rows can name them so.
    assert body["ontologyId"] == "ont_own_1"
    assert body["typeIds"]["entity"] == {"Source system": "sourceSystem", "Warehouse table": "warehouseTable"}


@pytest.mark.asyncio
@pytest.mark.parametrize("how, code, kind", [
    ("views", 502, "graph_create_failed"),          # made, then its views failed
    ("provider", 422, "provider_unsupported"),      # its graph couldn't be made at all
])
async def test_a_graph_of_their_own_that_cannot_be_made_takes_its_layer_with_it(
        test_client: AsyncClient, playground, store, layers, db_session, monkeypatch, how, code, kind):
    if how == "views":
        _views_fail(monkeypatch)
    else:
        (await db_session.get(ProviderORM, SANDBOX)).is_active = False      # switched off since set up
        await db_session.commit()
    r = await _post(test_client, OF_THEIR_OWN)
    assert r.status_code == code and r.json()["detail"]["type"] == kind, r.text
    assert layers.dropped == ["ont_own_1"]
    assert (await db_session.execute(select(OntologyORM.id).where(OntologyORM.id == "ont_own_1"))).all() == []
    await _nothing_made(db_session, store)


@pytest.mark.asyncio
async def test_past_their_layer_quota_nothing_is_made(test_client: AsyncClient, playground, store, layers, db_session):
    layers.refusal = HTTPException(status_code=409, detail={"type": "layer_quota", "message": "Full."})
    r = await _post(test_client, OF_THEIR_OWN)
    assert r.status_code == 409 and r.json()["detail"]["type"] == "layer_quota"
    assert store.graphs == []
    await _nothing_made(db_session, store)


@pytest.mark.asyncio
@pytest.mark.parametrize("section, infer", [
    ("thingTypes", {"thingTypes": [f"T{i}" for i in range(51)]}),
    ("connectionTypes", {"thingTypes": ["T"], "connectionTypes": [{"name": f"r{i}"} for i in range(51)]}),
])
async def test_a_file_with_too_many_types_is_refused_too_large(
        test_client: AsyncClient, playground, store, layers, db_session, section, infer):
    r = await _post(test_client, {**OF_THEIR_OWN, "model": {"infer": infer}})
    assert r.status_code == 413, r.text
    detail = r.json()["detail"]
    assert (detail["type"], detail["section"], detail["limit"]) == ("too_large", section, 50)
    assert layers.owned == [] and store.graphs == []
    await _nothing_made(db_session, store)


@pytest.mark.asyncio
async def test_types_that_are_wrong_are_named_and_nothing_is_made(
        test_client: AsyncClient, playground, store, layers, db_session):
    infer = {"thingTypes": ["", "T" * 61, "Ok", "   "],
             "connectionTypes": [{"name": ""}, {"name": "Feeds", "ends": [["Ok"]]}, {"name": "Fine"}]}
    r = await _post(test_client, {**OF_THEIR_OWN, "model": {"infer": infer}})
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert detail["type"] == "invalid_rows" and detail["count"] == len(detail["errors"])
    assert {(e["section"], e["index"], e["field"], e["code"]) for e in detail["errors"]} == {
        ("thingTypes", 0, "name", "invalid"), ("thingTypes", 1, "name", "invalid"),
        ("thingTypes", 3, "name", "invalid"),
        ("connectionTypes", 0, "name", "invalid"), ("connectionTypes", 1, "ends", "invalid")}
    assert all(e["message"] for e in detail["errors"])
    assert layers.owned == []
    await _nothing_made(db_session, store)


@pytest.mark.asyncio
@pytest.mark.parametrize("model", [{}, {"ontologyId": LAYER, "infer": INFERRED}])
async def test_a_graph_is_built_on_a_layer_or_on_its_files_types_one_of_the_two(
        test_client: AsyncClient, playground, store, layers, db_session, model):
    r = await _post(test_client, {**OF_THEIR_OWN, "model": model})
    assert r.status_code == 422
    assert layers.asked == [] and layers.owned == []
    await _nothing_made(db_session, store)


def test_type_ids_are_derived_from_the_names_and_never_collide():
    entities: set = set()
    relationships: set = set()
    assert [playground_starter._entity_type_id(n, entities)
            for n in ("Table", "table", "ML  model (v2)", "3rd party", "Données")] == [
        "table", "table2", "mlModelV2", "t3rdParty", "donnees"]
    assert [playground_starter._relationship_type_id(n, relationships)
            for n in ("feeds", "Feeds", "2-way", "→")] == ["FEEDS", "FEEDS_2", "R_2_WAY", "LINKED_TO"]


# ── Who may start one ───────────────────────────────────────────────────

@pytest.mark.asyncio
@pytest.mark.parametrize("body", [ON_A_LAYER, OF_THEIR_OWN], ids=["layer", "own"])
async def test_a_graph_counts_against_the_quota_and_is_refused_past_it(
        test_client: AsyncClient, playground, store, layers, db_session, body):
    first = await _post(test_client, body)
    second = await _post(test_client, body)
    asked, owned = len(layers.asked), len(layers.owned)
    third = await _post(test_client, body)
    assert (first.status_code, second.status_code) == (201, 201)
    assert third.status_code == 409 and third.json()["detail"]["type"] == "playground_quota"
    assert len(store.graphs) == 2
    # Refused before its layer was looked up or made.
    assert (len(layers.asked), len(layers.owned)) == (asked, owned)


@pytest.mark.asyncio
@pytest.mark.parametrize("body", [ON_A_LAYER, OF_THEIR_OWN], ids=["layer", "own"])
async def test_someone_not_in_the_playground_is_refused(
        test_client: AsyncClient, playground, store, layers, db_session, body):
    r = await _post(test_client, body, claims=OUTSIDER)
    assert r.status_code == 403 and r.json()["detail"]["type"] == "playground_not_member"
    assert layers.asked == [] and layers.owned == []
    await _nothing_made(db_session, store)


@pytest.mark.asyncio
@pytest.mark.parametrize("switch", ["playgroundEnabled", "blankModelsEnabled", "versioningEnabled"])
async def test_nothing_is_started_while_a_switch_it_needs_is_off(
        test_client: AsyncClient, playground, store, layers, db_session, switch):
    feature_flags._cache[switch] = False
    r = await _post(test_client, ON_A_LAYER)
    assert r.status_code == 403 and r.json()["detail"]["feature"] == switch
    assert layers.asked == []
    await _nothing_made(db_session, store)


def test_an_api_key_cannot_start_one():
    """Like every Playground route, starting a graph there is a person's: no key reaches it."""
    from backend.app.auth import api_key_surface

    for route in (playground_endpoints.create_graph, playground_endpoints.start_sample):
        assert (route.__module__, route.__name__) not in api_key_surface.SURFACE


@pytest.mark.asyncio
async def test_a_graph_is_no_longer_started_from_rows_sent_with_it(
        test_client: AsyncClient, playground, store, layers, db_session):
    with _as(BEN, MEMBER):
        r = await test_client.post("/api/v1/playground/imports", json={
            "name": "Rows", "things": [{"key": "a", "type": "T", "name": "A"}]})
    assert r.status_code == 404
    await _nothing_made(db_session, store)
