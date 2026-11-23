"""Start from a sample: a meaningful graph, its views and an example change, in one click — in
the Playground.

These pin what a sample is: a blank graph on the Playground's sandbox provider, counted against
the person's quota like any other; loaded with the sample as one day-0 import; on the sample's
own data model, made once and shared after, with a containment at the end of its pipeline; with
a Context View (opened first) and the Graph and Hierarchy views asked for beside it, the person's,
shared with everyone in the Playground, each at version 1; saved queries and a display rule on the
Context View; the data source described, tagged and linked; and an example change waiting for
review — a private draft on the Graph view (else the Context View) and a review that asks nobody.
Asking is refused to anyone not in it and while the Playground, blank models or version control is
off, or a layout it needs is withdrawn; and a refusal or a failure anywhere leaves nothing behind.

The version store is faked (it runs on Postgres only): it records the graphs made, the imports
loaded into them, the drafts, saves and reviews, and the purges queued.
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
from backend.app.db.models import (OntologyORM, ProviderORM, ViewLayoutOverlayORM, ViewORM, ViewSavedQueryORM,
                                   ViewVersionORM, WorkspaceDataSourceORM, WorkspaceORM)
from backend.app.providers.manager import provider_manager
from backend.app.services import playground_samples, playground_starter, view_library
from backend.app.services.feature_flags import feature_flags
from backend.app.services.layout_config import parse_reference_layout
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.versioning import purge_worker
from backend.app.services.versioning.import_export.resolve import pointer_id, pointer_seed
from backend.app.services.versioning.ontology import validate_entities_rich
from backend.auth_service.interface import User

PG = "ws_play"
SANDBOX = "prov_sandbox"
RETAIL = playground_samples.get("retail-pipeline")
MEMBER_PERMS = (
    "workspace:datasource:manage", "workspace:datasource:read", "workspace:ontology:read",
    "workspace:provider:read", "workspace:view:create", "workspace:view:delete",
    "workspace:view:edit", "workspace:view:read",
)
PIPELINE = ["sourceSystem", "ingestionJob", "warehouseTable", "transformation", "dashboard"]
SITE = "https://lineage.example.com"


def _user(uid: str) -> User:
    return User(id=uid, email=f"{uid}@example.com", first_name="T", last_name="U", role="user",
                status="active", created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z")


ADA, BEN = _user("usr_ada"), _user("usr_ben")
MEMBER = PermissionClaims(sid="s_m", ws_perms={PG: MEMBER_PERMS})
OUTSIDER = PermissionClaims(sid="s_o", ws_perms={"ws_team": MEMBER_PERMS})


class _VersionStore:
    """The graphs made, the imports loaded, the drafts opened, saved and sent for review, and the
    purges queued — and, when ``down`` names a step, that step failing."""

    def __init__(self):
        self.graphs: list = []
        self.imports: list = []
        self.drafts: list = []
        self.staged: list = []
        self.saved: list = []
        self.reviews: list = []
        self.purged: list = []
        self.projected: list = []
        self.down = None

    def _step(self, name):
        if self.down == name:
            raise RuntimeError(f"{name}: version store down")

    async def create_graph(self, **kwargs):
        self.graphs.append(kwargs)
        n = len(self.graphs)
        return {"graph_id": f"g_{n}", "main_branch_id": f"br_{n}", "genesis_commit_id": f"c_{n}"}

    async def bulk_ingest(self, **kwargs):
        self._step("bulk_ingest")
        self.imports.append(kwargs)
        return {"commit_id": "c_import", "commit_seq": 2, "ingested": len(kwargs["rows"]), "rejected": []}

    async def identity_scope(self, graph_id):
        return self.graphs[int(graph_id.removeprefix("g_")) - 1]["data_source_id"]

    async def open_draft(self, **kwargs):
        self._step("open_draft")
        self.drafts.append(kwargs)
        return f"br_draft_{len(self.drafts)}"

    async def stage_changes(self, **kwargs):
        self._step("stage_changes")
        self.staged.append(kwargs)
        return {}

    async def checkpoint(self, **kwargs):
        self._step("checkpoint")
        self.saved.append(kwargs)
        return "c_draft"

    async def open_draft_mr(self, **kwargs):
        self._step("open_draft_mr")
        self.reviews.append(kwargs)
        return f"pr_{len(self.reviews)}"


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


async def _all(db_session, orm):
    return (await db_session.execute(select(orm))).scalars().all()


#: Every view a sample can be made with: the Context View, and a Graph and a Hierarchy view beside it.
EVERY_VIEW = ["graph", "hierarchy"]


async def _start(test_client, sample_id="retail-pipeline", user=BEN, claims=MEMBER, views=EVERY_VIEW):
    """Start it — with ``views`` beside the Context View; None sends no body, as an older client."""
    with _as(user, claims):
        return await test_client.post(f"/api/v1/playground/samples/{sample_id}",
                                      **({} if views is None else {"json": {"views": views}}))


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
    assert not [n for n in sample.nodes + (sample.example,) if any("@" in str(part) for part in n)]


@pytest.mark.parametrize("sample", playground_samples.SAMPLES, ids=lambda s: s.id)
def test_its_containment_is_at_the_end_of_its_pipeline_and_holds_each_measure_once(sample):
    """Nothing in the pipeline becomes a child: a containment holds only the measures its outputs
    show, each in one container — so the Context View and the Graph view lay the pipeline out."""
    starter = playground_samples.starter(sample)
    rid, container, child = starter.containment()
    type_of = {key: etype for key, etype, *_ in sample.nodes}
    held = [t for s, r, t in sample.edges if r == rid]
    assert {type_of[s] for s, r, _ in sample.edges if r == rid} == {container}
    assert {type_of[t] for t in held} == {child} and len(held) == len(set(held))
    assert sorted(held) == sorted(k for k, t in type_of.items() if t == child)       # every one held
    assert child not in {type_of[k] for s, r, t in sample.edges if r != rid for k in (s, t)}
    assert starter.top_level_types() == [t for t in sample.entity_types if t != child]
    assert 2 <= min(sum(1 for s, r, _ in sample.edges if r == rid and s == c)
                    for c, t in type_of.items() if t == container)


@pytest.mark.parametrize("sample", playground_samples.SAMPLES, ids=lambda s: s.id)
def test_its_saved_queries_and_display_rule_are_ones_the_library_takes(sample):
    starter = playground_samples.starter(sample)
    assert [q.name for q in starter.queries] == [
        "PII data", "Certified", f"Owned by {sample.team}",
        f"Everything feeding {dict((k, n) for k, _t, n, *_ in sample.nodes)[sample.key_output]}"]
    for query in starter.queries:
        view_library._check_predicate(query.predicate, rule=False)
    for rule in starter.rules:
        view_library._check_predicate(rule["predicate"], rule=True)
    assert any("pii" in tags for *_, tags in sample.nodes)
    assert any(owner == sample.team for *_, owner, _platform, _tags in sample.nodes)


@pytest.mark.parametrize("sample", playground_samples.SAMPLES, ids=lambda s: s.id)
@pytest.mark.asyncio
async def test_its_strict_data_model_accepts_its_rows_and_its_example_change(sample, db_session):
    """Its graph is strict: every row, and the example's new thing and connection, are what its
    data model allows."""
    starter = playground_samples.starter(sample)
    db_session.add_all([ProviderORM(id="prov_x", name="X", provider_type="falkordb"),
                        WorkspaceORM(id="ws_x", name="X"), playground_starter.ontology_row(starter)])
    await db_session.flush()
    db_session.add(WorkspaceDataSourceORM(id="ds_x", workspace_id="ws_x", provider_id="prov_x",
                                          ontology_id=starter.ontology_id))
    await db_session.commit()
    rules = await _live_ontology_rules(db_session, "ws_x", "ds_x", fail_closed=True)
    nodes = [r for r in starter.rows if r["kind"] == "node"] + [starter.example.node]
    type_of = {n["urn"]: n["entityType"] for n in nodes}
    entities = [(n["urn"], "node", n, "create") for n in nodes] + [
        (f"e{i}", "edge", {"edgeType": r["edgeType"], "sourceEntityId": r["source"],
                           "targetEntityId": r["target"]}, "create")
        for i, r in enumerate(starter.rows) if r["kind"] == "edge"
    ] + [("e_example", "edge", {"edgeType": starter.example.relationship, "sourceEntityId": starter.example.source,
                                "targetEntityId": starter.example.node["urn"]}, "create")]
    assert validate_entities_rich(entities, type_of, rules) == []
    assert rules.is_root_type(starter.example.node["entityType"])        # a new top-level thing


def test_a_link_to_this_site_is_on_the_site_the_person_is_using():
    """A data source's link is a full web address: the page the request came from, else this
    server."""
    from starlette.requests import Request

    def request(*headers):
        return Request({"type": "http", "method": "POST", "scheme": "http", "server": ("api", 8000),
                        "path": "/", "query_string": b"", "headers": [(k.encode(), v.encode()) for k, v in headers]})

    on_site = playground_endpoints._on_this_site
    assert on_site(request(("origin", SITE)), "/docs/playground") == f"{SITE}/docs/playground"
    assert on_site(request(), "/docs/playground") == "http://api:8000/docs/playground"
    assert on_site(request(("origin", "null")), "/docs/playground") == "http://api:8000/docs/playground"


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
        "icon": "ShoppingCart", "color": "amber", "viewType": "reference",
        "nodeCount": len(RETAIL.nodes), "edgeCount": len(RETAIL.edges),
        "entityTypes": ["Source system", "Ingestion job", "Warehouse table", "Transformation", "Dashboard",
                        "Metric"],
        "hierarchy": "Dashboards and their metrics",
    }


# ── Starting one ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_sample_is_a_blank_graph_loaded_with_it_and_described(
        test_client: AsyncClient, playground, store, db_session):
    r = await _start(test_client)
    with _as(BEN, MEMBER):
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

    # Described: what it is, a tag, and where to read about the Playground — on this site.
    assert ds.description == RETAIL.description
    assert json.loads(ds.tags) == ["sample"]
    assert json.loads(ds.links) == [{"label": "How the Playground works",
                                      "url": f"{str(test_client.base_url).rstrip('/')}/docs/playground"}]
    assert ds.metadata_updated_by == BEN.id and ds.metadata_updated_at

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


@pytest.mark.asyncio
async def test_it_opens_a_context_view_with_a_graph_and_a_hierarchy_view_beside_it(
        test_client: AsyncClient, playground, store, db_session):
    r = await _start(test_client)
    assert r.status_code == 201, r.text
    body = r.json()
    assert set(body["viewIds"]) == {"context", "graph", "hierarchy"}
    assert body["viewId"] == body["viewIds"]["context"]
    views = {key: await db_session.get(ViewORM, view_id) for key, view_id in body["viewIds"].items()}
    for view in views.values():                          # Ben's, shared with everyone in the Playground
        assert (view.workspace_id, view.data_source_id, view.visibility, view.created_by) == (
            PG, body["dataSourceId"], "workspace", BEN.id)
    assert {k: v.view_type for k, v in views.items()} == {
        "context": "reference", "graph": "graph", "hierarchy": "hierarchy"}

    # The Context View: one layer per pipeline type, in order — the metrics show in their dashboards.
    context = json.loads(views["context"].config)
    layers = parse_reference_layout(context).layers
    assert [(layer["entityTypes"], layer["order"], layer["name"]) for layer in layers] == [
        ([t], i, RETAIL.entity_types[t].plural) for i, t in enumerate(PIPELINE)]
    assert context["layout"]["referenceLayout"]["assignments"] == {}
    # The Graph view as it always was: the pipeline, left to right.
    graph = json.loads(views["graph"].config)
    assert graph["layout"]["type"] == "graph" and graph["icon"] == "ShoppingCart"
    assert graph["content"]["visibleEntityTypes"] == PIPELINE
    assert graph["content"]["visibleRelationshipTypes"] == ["FEEDS", "LOADS", "TRANSFORMS_INTO", "POWERS"]
    # The Hierarchy view: dashboards and their metrics.
    hierarchy = json.loads(views["hierarchy"].config)
    assert hierarchy["content"]["visibleEntityTypes"] == ["dashboard", "metric"]
    assert hierarchy["content"]["visibleRelationshipTypes"] == ["HAS_METRIC"]

    # Each at version 1, made with the sample.
    versions = await _all(db_session, ViewVersionORM)
    assert sorted((v.view_id, v.version, v.source) for v in versions) == sorted(
        (view_id, 1, "create") for view_id in body["viewIds"].values())


@pytest.mark.asyncio
@pytest.mark.parametrize("views, made", [
    (None, {"context"}),                                 # no body: the Context View alone
    ([], {"context"}),
    (["graph"], {"context", "graph"}),
    (["hierarchy"], {"context", "hierarchy"}),
])
async def test_it_opens_a_context_view_and_only_the_views_asked_for_beside_it(
        test_client: AsyncClient, playground, store, db_session, views, made):
    r = await _start(test_client, views=views)
    assert r.status_code == 201, r.text
    body = r.json()
    assert set(body["viewIds"]) == made and all(body["viewIds"].values())
    assert body["viewId"] == body["viewIds"]["context"]
    assert {v.id for v in await _all(db_session, ViewORM)} == set(body["viewIds"].values())


@pytest.mark.asyncio
async def test_without_a_graph_view_its_example_change_waits_on_the_context_view(
        test_client: AsyncClient, playground, store, db_session):
    r = await _start(test_client, views=[])
    assert r.status_code == 201, r.text
    body = r.json()
    [draft] = store.drafts
    assert draft["originating_view_id"] == body["viewId"] and body["draftId"] == "br_draft_1"
    assert await db_session.get(ViewLayoutOverlayORM, (body["viewId"], "br_draft_1")) is not None
    assert body["reviewId"] == "pr_1"


@pytest.mark.asyncio
async def test_a_view_name_it_does_not_know_is_refused_and_nothing_is_made(
        test_client: AsyncClient, playground, store, db_session):
    r = await _start(test_client, views=["table"])
    assert r.status_code == 422
    assert store.graphs == [] and await _bens_sources(db_session) == []


@pytest.mark.asyncio
async def test_its_context_view_has_saved_queries_and_tints_personal_data(
        test_client: AsyncClient, playground, store, db_session):
    r = await _start(test_client)
    assert r.status_code == 201, r.text
    context = r.json()["viewId"]
    queries = sorted(await _all(db_session, ViewSavedQueryORM), key=lambda q: q.position)
    assert [(q.view_id, q.id, q.name) for q in queries] == [
        (context, f"{context}_pii", "PII data"), (context, f"{context}_certified", "Certified"),
        (context, f"{context}_team", "Owned by Analytics engineering"),
        (context, f"{context}_feeding", "Everything feeding Executive sales overview")]
    feeding = json.loads(queries[3].predicate)
    assert feeding["axis"] == "downstream" and feeding["where"]["refs"] == [{"urn": RETAIL.urn("dash_exec")}]
    [rule] = view_library._rules_of(view_library._published_layout(
        json.loads((await db_session.get(ViewORM, context)).config)))
    assert (rule["name"], rule["predicate"]) == ("Personal data", {"kind": "tag", "op": "has", "values": ["pii"]})


@pytest.mark.asyncio
async def test_an_example_change_waits_for_review_on_the_graph_view_and_asks_nobody(
        test_client: AsyncClient, playground, store, db_session):
    r = await _start(test_client)
    assert r.status_code == 201, r.text
    body = r.json()
    graph_view = body["viewIds"]["graph"]

    # A private draft of Ben's, opened from the Graph view — not the Context View, where his first
    # Edit opens a draft of its own.
    [draft] = store.drafts
    assert draft == {"graph_id": "g_1", "owner": BEN.id, "name": "Add Finance overview",
                     "originating_view_id": graph_view, "visibility": "private"}
    assert body["draftId"] == "br_draft_1"
    assert await db_session.get(ViewLayoutOverlayORM, (graph_view, "br_draft_1")) is not None

    # One new dashboard, powered by fct_orders as the import named it, saved.
    [staged] = store.staged
    assert (staged["graph_id"], staged["branch_id"], staged["actor"]) == ("g_1", "br_draft_1", BEN.id)
    assert staged["ontology_rules"] is not None                       # strict: checked as it is staged
    new, link = staged["ops"]
    assert (new["op"], new["entity_kind"], new["payload"]["entityType"], new["payload"]["urn"]) == (
        "create", "node", "dashboard", RETAIL.urn("dash_finance"))
    assert link["payload"] == {
        "edgeType": "POWERS", "targetEntityId": RETAIL.urn("dash_finance"),
        "sourceEntityId": pointer_id(body["dataSourceId"], pointer_seed(RETAIL.urn("fct_orders")))}
    [saved] = store.saved
    assert (saved["branch_id"], saved["actor"], saved["message"]) == ("br_draft_1", BEN.id, "Add Finance overview")

    # Its review asks nobody, so nobody is told; Ben may approve and merge it himself.
    [review] = store.reviews
    assert (review["branch_id"], review["actor"], review["reviewers"], review["reviewer_groups"]) == (
        "br_draft_1", BEN.id, [], [])
    assert review["title"] == "Add Finance overview" and "example" in review["description"]
    assert body["reviewId"] == "pr_1"


@pytest.mark.asyncio
async def test_its_data_model_is_made_once_and_shared_by_every_graph_made_from_it(
        test_client: AsyncClient, playground, store, db_session):
    first = await _start(test_client)
    second = await _start(test_client, user=ADA)
    assert first.status_code == 201 and second.status_code == 201, (first.text, second.text)

    [ontology] = (await db_session.execute(
        select(OntologyORM).where(OntologyORM.id.like("bp_sample_%")))).scalars().all()
    assert ontology.id == RETAIL.ontology_id
    assert ontology.is_published is True and not ontology.is_system   # never mistaken for the default
    assert set(json.loads(ontology.entity_type_definitions)) == set(RETAIL.entity_types)
    assert json.loads(ontology.lineage_edge_types) == ["FEEDS", "LOADS", "TRANSFORMS_INTO", "POWERS"]
    assert json.loads(ontology.containment_edge_types) == ["HAS_METRIC"]
    assert json.loads(ontology.root_entity_types) == PIPELINE               # a metric is in a dashboard
    relationships = json.loads(ontology.relationship_type_definitions)
    assert (relationships["FEEDS"]["source_types"], relationships["FEEDS"]["target_types"]) == (
        ["sourceSystem"], ["ingestionJob"])
    assert (relationships["HAS_METRIC"]["category"], relationships["HAS_METRIC"]["is_containment"]) == (
        "structural", True)
    entities = json.loads(ontology.entity_type_definitions)
    assert entities["metric"]["hierarchy"]["can_be_contained_by"] == ["dashboard"]
    assert entities["dashboard"]["hierarchy"]["can_contain"] == ["metric"]
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
    r = await _start(test_client, "customer-360", user=ADA)
    assert listed["quotaLeft"] == 0
    assert r.status_code == 409 and r.json()["detail"]["type"] == "playground_quota"
    # Refused before anything was made: no data model, no graph, no view.
    assert await db_session.get(OntologyORM, playground_samples.get("customer-360").ontology_id) is None
    assert store.graphs == [] and store.imports == []
    assert await _all(db_session, ViewORM) == []


@pytest.mark.asyncio
async def test_someone_not_in_the_playground_is_refused(test_client: AsyncClient, playground, store, db_session):
    with _as(BEN, OUTSIDER):
        listed = await test_client.get("/api/v1/playground/samples")
    r = await _start(test_client, claims=OUTSIDER)
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
    r = await _start(test_client)
    assert listed.status_code == 403 and listed.json()["detail"]["feature"] == switch
    assert r.status_code == 403 and r.json()["detail"]["feature"] == switch
    assert store.graphs == []


@pytest.mark.asyncio
async def test_a_sample_is_refused_while_a_layout_it_opens_in_is_withdrawn(
        test_client: AsyncClient, playground, store, db_session):
    feature_flags._cache["allowedViewModes"] = ["graph", "reference"]       # no Hierarchy views
    r = await _start(test_client)
    assert r.status_code == 403 and r.json()["detail"]["feature"] == "allowedViewModes", r.text
    assert store.graphs == [] and await _bens_sources(db_session) == []


@pytest.mark.asyncio
async def test_a_withdrawn_layout_it_is_not_asked_to_open_in_refuses_nothing(
        test_client: AsyncClient, playground, store, db_session):
    feature_flags._cache["allowedViewModes"] = ["graph", "reference"]       # no Hierarchy views
    r = await _start(test_client, views=["graph"])
    assert r.status_code == 201, r.text
    assert set(r.json()["viewIds"]) == {"context", "graph"}


@pytest.mark.asyncio
async def test_an_unknown_sample_is_not_found(test_client: AsyncClient, playground, store):
    r = await _start(test_client, "nope")
    assert r.status_code == 404
    assert store.graphs == []


@pytest.mark.asyncio
@pytest.mark.parametrize("step", ["bulk_ingest", "open_draft", "stage_changes", "checkpoint", "open_draft_mr"])
async def test_a_sample_that_cannot_be_made_leaves_nothing_behind(
        test_client: AsyncClient, playground, store, db_session, step):
    store.down = step
    r = await _start(test_client, "ml-features")
    with _as(BEN, MEMBER):
        listed = (await test_client.get("/api/v1/playground/samples")).json()
    assert r.status_code == 502 and r.json()["detail"]["type"] == "sample_load_failed"
    # The graph it made — its drafts and reviews with it — is queued for purge, and its data
    # source went with it; no view, saved query, version or draft overlay is left.
    assert [(p["graph_id"], p["workspace_id"]) for p in store.purged] == [("g_1", PG)]
    assert await _bens_sources(db_session) == []
    assert listed["quotaLeft"] == 3
    for orm in (ViewORM, ViewSavedQueryORM, ViewVersionORM, ViewLayoutOverlayORM):
        assert await _all(db_session, orm) == [], orm
    assert store.projected == []
    # Its data model is the sample's, shared by every graph made from it: it stays.
    assert await db_session.get(OntologyORM, playground_samples.get("ml-features").ontology_id) is not None
