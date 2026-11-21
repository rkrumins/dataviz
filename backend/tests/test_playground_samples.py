"""Start from a sample: a meaningful graph, with a view on it, in one click — in the Playground.

These pin what a sample is: a blank graph on the Playground's sandbox provider, counted against
the person's quota like any other; loaded with the sample as one day-0 import; on the sample's
own data model, made once and shared after; and opened by a view of the person's, shared with
everyone in the Playground. Asking is refused to anyone not in it and while the Playground, blank
models or version control is off, and a refusal or a failed load leaves nothing behind.

The version store is faked (it runs on Postgres only): it records the graphs made, the imports
loaded into them and the purges queued.
"""
from __future__ import annotations

import contextlib
import json

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.api.v1.endpoints import playground as playground_endpoints
from backend.app.api.v1.endpoints.versioning import get_versioning_service
from backend.app.auth.dependencies import get_current_user, get_optional_user, get_permission_claims
from backend.app.db.models import OntologyORM, ProviderORM, ViewORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.providers.manager import provider_manager
from backend.app.services import playground_samples
from backend.app.services.feature_flags import feature_flags
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.versioning import purge_worker
from backend.auth_service.interface import User

PG = "ws_play"
SANDBOX = "prov_sandbox"
RETAIL = playground_samples.get("retail-pipeline")
MEMBER_PERMS = (
    "workspace:datasource:manage", "workspace:datasource:read", "workspace:ontology:read",
    "workspace:provider:read", "workspace:view:create", "workspace:view:delete",
    "workspace:view:edit", "workspace:view:read",
)


def _user(uid: str) -> User:
    return User(id=uid, email=f"{uid}@example.com", first_name="T", last_name="U", role="user",
                status="active", created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z")


ADA, BEN = _user("usr_ada"), _user("usr_ben")
MEMBER = PermissionClaims(sid="s_m", ws_perms={PG: MEMBER_PERMS})
OUTSIDER = PermissionClaims(sid="s_o", ws_perms={"ws_team": MEMBER_PERMS})


class _VersionStore:
    """The graphs made, the imports loaded and the purges queued — and, when ``down``, an
    import that fails."""

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
    """The Playground, switched on, on a reachable sandbox provider, three graphs each; Ada has
    one already. (Every test starts with the flags at their defaults: conftest.)"""
    for key in ("playgroundEnabled", "blankModelsEnabled", "versioningEnabled"):
        feature_flags._cache[key] = True
    db_session.add_all([
        ProviderORM(id=SANDBOX, name="Sandbox", provider_type="falkordb", host="sandbox", port=6379),
        WorkspaceORM(id=PG, name="Playground", kind="playground", request_policy="open", publish_policy="request",
                     playground_settings=json.dumps({"sandboxProviderId": SANDBOX, "starterOntologyIds": [],
                                                     "graphQuota": 3})),
    ])
    await db_session.flush()
    db_session.add(WorkspaceDataSourceORM(id="ds_ada_pg", workspace_id=PG, provider_id=SANDBOX,
                                          graph_name="blank_a", label="Ada's experiment", created_by=ADA.id))
    await db_session.commit()
    provider_manager.warmup_cache[SANDBOX] = {"ok": True}
    yield
    provider_manager.warmup_cache.pop(SANDBOX, None)


async def _bens_sources(db_session):
    return (await db_session.execute(select(WorkspaceDataSourceORM).where(
        WorkspaceDataSourceORM.created_by == BEN.id, WorkspaceDataSourceORM.deleted_at.is_(None),
    ))).scalars().all()


# ── The samples themselves ──────────────────────────────────────────────

@pytest.mark.parametrize("sample", playground_samples.SAMPLES, ids=lambda s: s.id)
def test_every_connection_joins_things_the_sample_holds_and_nothing_names_a_person(sample):
    keys = [key for key, *_ in sample.nodes]
    assert len(keys) == len(set(keys))
    assert {etype for _, etype, *_ in sample.nodes} == set(sample.entity_types)
    assert {rtype for _, rtype, _ in sample.edges} == set(sample.relationship_types)
    assert all(s in keys and t in keys for s, _, t in sample.edges)
    assert len(sample.edges) == len(set(sample.edges))
    # Owners are teams and platforms are products: no names or addresses of people.
    assert not [n for n in sample.nodes if any("@" in str(part) for part in n)]


# ── The catalogue ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_the_catalogue_lists_every_sample_and_how_many_more_graphs_the_reader_may_start(
        test_client: AsyncClient, playground):
    with _as(ADA, MEMBER):
        r = await test_client.get("/api/v1/playground/samples")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["quotaLeft"] == 2                       # three each; Ada has one
    assert [s["id"] for s in body["samples"]] == ["retail-pipeline", "customer-360", "ml-features"]
    assert body["samples"][0] == {
        "id": "retail-pipeline", "title": "Retail data pipeline", "description": RETAIL.description,
        "icon": "ShoppingCart", "color": "amber", "viewType": "graph",
        "nodeCount": len(RETAIL.nodes), "edgeCount": len(RETAIL.edges),
        "entityTypes": ["Source system", "Ingestion job", "Warehouse table", "Transformation", "Dashboard"],
    }


# ── Starting one ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_sample_is_a_blank_graph_loaded_with_it_and_a_view_shared_in_the_playground(
        test_client: AsyncClient, playground, store, db_session):
    with _as(BEN, MEMBER):
        r = await test_client.post("/api/v1/playground/samples/retail-pipeline")
        after = (await test_client.get("/api/v1/playground/samples")).json()
    assert r.status_code == 201, r.text
    body = r.json()

    # A blank graph of Ben's on the sandbox provider, on the sample's data model — one of his three.
    [ds] = await _bens_sources(db_session)
    assert body["dataSourceId"] == ds.id
    assert (ds.workspace_id, ds.provider_id, ds.ontology_id, ds.label, ds.graph_name) == (
        PG, SANDBOX, RETAIL.ontology_id, "Retail data pipeline", f"blank_{ds.id}")
    assert after["quotaLeft"] == 2
    [graph] = store.graphs
    assert (graph["kind"], graph["ontology_enforcement"], graph["base_ontology_id"]) == (
        "blank", "strict", RETAIL.ontology_id)

    # Loaded with the sample, as one day-0 import into that graph — then projected.
    [load] = store.imports
    assert load["graph_id"] == "g_1" and load["actor"] == BEN.id and load["standard_ids"] is True
    assert load["rows"] == playground_samples.rows(RETAIL)
    nodes = [row for row in load["rows"] if row["kind"] == "node"]
    edges = [row for row in load["rows"] if row["kind"] == "edge"]
    assert (len(nodes), len(edges)) == (len(RETAIL.nodes), len(RETAIL.edges))
    urns = {row["urn"] for row in nodes}
    assert all(e["source"] in urns and e["target"] in urns for e in edges)
    assert store.projected == ["g_1"] and store.purged == []

    # And a view on it, Ben's, shared with everyone in the Playground.
    view = await db_session.get(ViewORM, body["viewId"])
    assert (view.workspace_id, view.data_source_id, view.view_type, view.visibility, view.created_by) == (
        PG, ds.id, "graph", "workspace", BEN.id)
    config = json.loads(view.config)
    assert config["layout"]["type"] == "graph" and config["icon"] == "ShoppingCart"
    assert config["content"]["visibleEntityTypes"] == list(RETAIL.entity_types)


@pytest.mark.asyncio
async def test_its_data_model_is_made_once_and_shared_by_every_graph_made_from_it(
        test_client: AsyncClient, playground, store, db_session):
    with _as(BEN, MEMBER):
        first = await test_client.post("/api/v1/playground/samples/retail-pipeline")
    with _as(ADA, MEMBER):
        second = await test_client.post("/api/v1/playground/samples/retail-pipeline")
    assert first.status_code == 201 and second.status_code == 201, (first.text, second.text)

    [ontology] = (await db_session.execute(
        select(OntologyORM).where(OntologyORM.id.like("bp_sample_%")))).scalars().all()
    assert ontology.id == RETAIL.ontology_id
    assert ontology.is_published is True and not ontology.is_system   # never mistaken for the default
    assert set(json.loads(ontology.entity_type_definitions)) == set(RETAIL.entity_types)
    assert set(json.loads(ontology.lineage_edge_types)) == set(RETAIL.relationship_types)
    feeds = json.loads(ontology.relationship_type_definitions)["FEEDS"]
    assert (feeds["source_types"], feeds["target_types"]) == (["sourceSystem"], ["ingestionJob"])
    sources = (await db_session.execute(select(WorkspaceDataSourceORM.ontology_id).where(
        WorkspaceDataSourceORM.id.in_([first.json()["dataSourceId"], second.json()["dataSourceId"]])
    ))).scalars().all()
    assert sources == [RETAIL.ontology_id, RETAIL.ontology_id]


# ── What refuses one ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_sample_counts_against_the_quota_and_is_refused_past_it(
        test_client: AsyncClient, playground, store, db_session):
    for n in (2, 3):
        db_session.add(WorkspaceDataSourceORM(id=f"ds_ada_{n}", workspace_id=PG, provider_id=SANDBOX,
                                              graph_name=f"blank_{n}", label="More", created_by=ADA.id))
    await db_session.commit()
    with _as(ADA, MEMBER):
        listed = (await test_client.get("/api/v1/playground/samples")).json()
        r = await test_client.post("/api/v1/playground/samples/customer-360")
    assert listed["quotaLeft"] == 0
    assert r.status_code == 409 and r.json()["detail"]["type"] == "playground_quota"
    # Refused before anything was made: no data model, no graph, no view.
    assert await db_session.get(OntologyORM, playground_samples.get("customer-360").ontology_id) is None
    assert store.graphs == [] and store.imports == []
    assert (await db_session.execute(select(ViewORM))).scalars().all() == []


@pytest.mark.asyncio
async def test_someone_not_in_the_playground_is_refused(test_client: AsyncClient, playground, store, db_session):
    with _as(BEN, OUTSIDER):
        listed = await test_client.get("/api/v1/playground/samples")
        r = await test_client.post("/api/v1/playground/samples/retail-pipeline")
    assert listed.status_code == 403 and listed.json()["detail"]["type"] == "playground_not_member"
    assert r.status_code == 403 and r.json()["detail"]["type"] == "playground_not_member"
    assert store.graphs == [] and await _bens_sources(db_session) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("switch", ["playgroundEnabled", "blankModelsEnabled", "versioningEnabled"])
async def test_nothing_is_offered_while_a_switch_it_needs_is_off(
        test_client: AsyncClient, playground, store, switch):
    feature_flags._cache[switch] = False
    with _as(BEN, MEMBER):
        listed = await test_client.get("/api/v1/playground/samples")
        r = await test_client.post("/api/v1/playground/samples/retail-pipeline")
    assert listed.status_code == 403 and listed.json()["detail"]["feature"] == switch
    assert r.status_code == 403 and r.json()["detail"]["feature"] == switch
    assert store.graphs == []


@pytest.mark.asyncio
async def test_an_unknown_sample_is_not_found(test_client: AsyncClient, playground, store):
    with _as(BEN, MEMBER):
        r = await test_client.post("/api/v1/playground/samples/nope")
    assert r.status_code == 404
    assert store.graphs == []


@pytest.mark.asyncio
async def test_a_sample_that_cannot_be_loaded_leaves_nothing_behind(
        test_client: AsyncClient, playground, store, db_session):
    store.down = True
    with _as(BEN, MEMBER):
        r = await test_client.post("/api/v1/playground/samples/ml-features")
        listed = (await test_client.get("/api/v1/playground/samples")).json()
    assert r.status_code == 502 and r.json()["detail"]["type"] == "sample_load_failed"
    # The graph it made is queued for purge, and its data source went with it.
    assert [(p["graph_id"], p["workspace_id"]) for p in store.purged] == [("g_1", PG)]
    assert await _bens_sources(db_session) == []
    assert listed["quotaLeft"] == 3
    assert (await db_session.execute(select(ViewORM))).scalars().all() == []
    assert store.projected == []
