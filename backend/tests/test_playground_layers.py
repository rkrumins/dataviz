"""The Playground's semantic layers: what a member may build on, and layers of their own.

* ``GET /playground/models`` lists the newest version of each layer on offer — approved org-wide
  layers, the starters, the samples', the member's own (drafts too) and those shared with them —
  by kind, with how many of their graphs use it; ``/models/{id}/template`` is its import
  template; ``POST /models/match`` scores only those against a file.
* ``POST /playground/layers`` starts one four ways — blank, a copy, a Semantic Layers file, a
  file's types — within ``layerQuota``; ``/share`` shares it; ``/types`` adds a file's types: a
  draft in place, a published layer by its next version, the member's graphs moving to it.
* Assigning a layer to a Playground graph takes one on offer, published.
* A graph moving into a workspace takes its own layer with it — or, when other graphs still use
  it, a copy — and the move can be undone.
* The contract the rest of the Playground builds on: ``offered_ontology_ids``,
  ``assert_offered``, ``starter_types_of``, ``create_owned`` and ``drop_owned``.
"""
from __future__ import annotations

import json

import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.db.models import (OntologyAuditLogORM, OntologyORM, UserORM, WorkspaceDataSourceORM,
                                   WorkspaceORM)
from backend.app.services import playground_layers, playground_starter
from backend.app.services.permission_service import PermissionClaims
from tests.common.transfer_world import fake_version_store
from tests.test_ontology_ownership import (  # noqa: F401 — ``world`` is a fixture
    ADA, ADMIN_PERMS, BEN, CY, EDITOR_PERMS, LAB, LAYERS, MEMBER, MEMBER_PERMS, ONT, PG, PG_ADMIN, TEAM,
    TEAM_EDITOR, TYPES, acting, fresh, make_layer, org_layer, refusal, set_flags, world,
)

MODELS = "/api/v1/playground/models"
OUTSIDER = PermissionClaims(sid="s_o", ws_perms={TEAM: MEMBER_PERMS})
INFER = {"thingTypes": ["Warehouse table", "Dashboard"],
         "connectionTypes": [{"name": "Feeds", "ends": [["Warehouse table", "Dashboard"]]}]}


def _ds(ds_id: str, ontology_id: str, user=ADA, ws=PG) -> WorkspaceDataSourceORM:
    return WorkspaceDataSourceORM(id=ds_id, workspace_id=ws, provider_id="prov_sandbox", graph_name=f"g_{ds_id}",
                                  label=ds_id, ontology_id=ontology_id, created_by=user.id)


# ── What a member may build on ───────────────────────────────────────────

@pytest.mark.asyncio
async def test_the_models_list_each_layer_on_offer_once_by_kind(test_client: AsyncClient, world):
    draft = await make_layer(test_client, name="A draft of mine")
    mine = await make_layer(test_client, name="Mine", publish=True, shared=True)
    with acting(ADA, MEMBER):
        newer = (await test_client.post(f"{ONT}/{mine['id']}/new-version")).json()
    bens = await make_layer(test_client, BEN, name="Ben's shared", publish=True, shared=True)
    await make_layer(test_client, BEN, name="Ben's private", publish=True)
    world.add_all([org_layer("bp_sample_retail_pipeline", name="Retail (sample)"),
                   _ds("ds_mine", mine["id"]), _ds("ds_ben", bens["id"], BEN)])
    await world.commit()
    with acting(ADA, MEMBER):
        r = await test_client.get(MODELS)
    assert r.status_code == 200, r.text
    assert [(m["name"], m["kind"], m["version"], m["isPublished"], m["shared"], m["usedBy"]) for m in r.json()] == [
        ("Approved", "approved", 1, True, False, 0),
        ("Starter", "starter", 1, True, False, 0),
        ("Retail (sample)", "sample", 1, True, False, 0),
        ("A draft of mine", "yours", 1, False, False, 0),
        ("Mine", "yours", 2, False, True, 1),                 # its newest version; a graph on v1
        ("Ben's shared", "shared", 1, True, True, 0),
    ]
    assert r.json()[4]["id"] == newer["id"] and r.json()[3]["id"] == draft["id"]
    assert (r.json()[0]["entityTypeCount"], r.json()[0]["relationshipTypeCount"]) == (1, 0)


@pytest.mark.asyncio
async def test_the_models_are_for_members_while_the_playground_is_on(test_client: AsyncClient, world):
    with acting(ADA, OUTSIDER):
        outsider = await test_client.get(MODELS)
    set_flags(playgroundEnabled=False)
    with acting(ADA, MEMBER):
        off = await test_client.get(MODELS)
    assert (outsider.status_code, refusal(outsider)) == (403, "playground_not_member")
    assert (off.status_code, refusal(off)) == (403, "feature_disabled")


@pytest.mark.asyncio
async def test_a_models_template_is_the_standard_import_template(test_client: AsyncClient, world):
    draft = await make_layer(test_client, name="Draft")
    bens = await make_layer(test_client, BEN, name="Ben's private", publish=True)
    with acting(ADA, MEMBER):
        csv = await test_client.get(f"{MODELS}/ont_approved/template", params={"format": "csv"})
        xlsx = await test_client.get(f"{MODELS}/ont_approved/template", params={"format": "xlsx"})
        unfinished = await test_client.get(f"{MODELS}/{draft['id']}/template")
        not_offered = await test_client.get(f"{MODELS}/{bens['id']}/template")
        org_draft = await test_client.get(f"{MODELS}/ont_org_draft/template")
        missing = await test_client.get(f"{MODELS}/ont_nowhere/template")
        bad = await test_client.get(f"{MODELS}/ont_approved/template", params={"format": "pdf"})
    assert csv.status_code == 200, csv.text
    assert csv.headers["content-disposition"] == 'attachment; filename="import-template.csv"'
    assert b"table" in csv.content and b"entityType" in csv.content
    assert xlsx.status_code == 200 and xlsx.content[:2] == b"PK"
    assert (unfinished.status_code, refusal(unfinished)) == (422, "ontology_not_published")
    assert (not_offered.status_code, refusal(not_offered)) == (403, "ontology_not_offered")
    assert (org_draft.status_code, refusal(org_draft)) == (403, "ontology_not_offered")
    assert (missing.status_code, refusal(missing)) == (404, "unknown_ontology")
    assert bad.status_code == 422


_STATS = {"totalNodes": 3, "totalEdges": 0,
          "entityTypeStats": [{"id": "table", "name": "Table", "count": 3}], "edgeTypeStats": []}


@pytest.mark.asyncio
async def test_matching_scores_only_the_layers_on_offer(test_client: AsyncClient, world):
    mine = await make_layer(test_client, name="Mine", publish=True)
    bens = await make_layer(test_client, BEN, name="Ben's private", publish=True)
    with acting(ADA, MEMBER):
        r = await test_client.post(f"{MODELS}/match", params={"min_score": 0}, json=_STATS)
    assert r.status_code == 200, r.text
    scored = {m["ontologyId"] for m in r.json()["matchingOntologies"]}
    assert scored == {"ont_approved", "ont_starter", mine["id"]}
    assert bens["id"] not in scored and "ont_team_scoped" not in scored and "ont_system" not in scored
    assert r.json()["suggested"] is None and all(m["jaccardScore"] > 0 for m in r.json()["matchingOntologies"])


@pytest.mark.asyncio
async def test_matching_is_for_members_with_suggestions_on(test_client: AsyncClient, world):
    with acting(ADA, OUTSIDER):
        outsider = await test_client.post(f"{MODELS}/match", json=_STATS)
    set_flags(semanticLayerAutoSuggest=False)
    with acting(ADA, MEMBER):
        off = await test_client.post(f"{MODELS}/match", json=_STATS)
    assert (outsider.status_code, refusal(outsider)) == (403, "playground_not_member")
    assert (off.status_code, refusal(off)) == (403, "feature_disabled")


# ── Layers of one's own: four ways to start, within a quota ─────────────

@pytest.mark.asyncio
async def test_a_blank_layer_is_a_private_draft_owned_by_the_playground(test_client: AsyncClient, world):
    made = await make_layer(test_client, name="Blank", source={"blank": True})
    assert (made["isPublished"], made["scope"], made["ownerWorkspaceId"], made["ownerVisibility"]) == \
        (False, "workspace", PG, "private")
    assert made["createdBy"] == ADA.id and made["access"]["isOwn"] is True
    assert [k for k in made["entityTypeDefinitions"] if not made["entityTypeDefinitions"][k].get("is_system")] == []


@pytest.mark.asyncio
async def test_a_copy_keeps_the_layers_types_and_description(test_client: AsyncClient, world):
    world.add(org_layer("ont_described", description="What it means", name="Described"))
    await world.commit()
    made = await make_layer(test_client, name="My copy", source={"cloneOf": "ont_approved"})
    described = await make_layer(test_client, name="Described copy", source={"cloneOf": "ont_described"})
    with acting(ADA, MEMBER):
        hidden = await test_client.post(LAYERS, json={"name": "Nope", "from": {"cloneOf": "ont_team_scoped"}})
    assert "table" in made["entityTypeDefinitions"] and made["isPublished"] is False
    assert made["ownerWorkspaceId"] == PG and made["name"] == "My copy"
    assert described["description"] == "What it means"
    assert hidden.status_code == 404


@pytest.mark.asyncio
async def test_a_layer_file_goes_through_the_semantic_layer_import_checks(test_client: AsyncClient, world):
    with acting(CY, TEAM_EDITOR):
        exported = (await test_client.get(f"{ONT}/ont_team_scoped/export")).json()
    exported["relationshipTypeDefinitions"] = {"AGGREGATED": {"name": "Aggregated"},
                                               "FEEDS": {"name": "Feeds", "source_types": ["table", "ghost"]}}
    made = await make_layer(test_client, name="From a file", source={"layer": exported})
    with acting(ADA, MEMBER):
        dupes = await test_client.post(LAYERS, json={"name": "Dupes", "from": {"layer": {
            "name": "x", "entityTypeDefinitions": {"Table": {}, "table": {}}}}})
        junk = await test_client.post(LAYERS, json={"name": "Junk", "from": {"layer": {"entityTypeDefinitions": 3}}})
        two = await test_client.post(LAYERS, json={"name": "Two", "from": {"blank": True, "cloneOf": "ont_approved"}})
    row = await fresh(world, made["id"])
    stored = json.loads(row.relationship_type_definitions)
    assert "AGGREGATED" not in stored                                   # the platform's own type
    assert stored["FEEDS"]["source_types"] == ["table"]                 # its ends: the layer's types
    assert (row.owner_workspace_id, row.is_published, row.name) == (PG, False, "From a file")
    assert dupes.status_code == 422
    assert (junk.status_code, refusal(junk)) == (422, "invalid_layer")
    assert (two.status_code, refusal(two)) == (422, "invalid_source")


@pytest.mark.asyncio
async def test_a_files_types_make_a_published_layer(test_client: AsyncClient, world):
    made = await make_layer(test_client, name="From my file", source={"infer": INFER})
    entities, relationships = made["entityTypeDefinitions"], made["relationshipTypeDefinitions"]
    assert made["isPublished"] is True and made["publishedBy"] == ADA.id
    assert {"warehouseTable", "dashboard"} <= set(entities)
    assert entities["warehouseTable"]["name"] == "Warehouse table"
    feeds = relationships["FEEDS"]
    assert (feeds["source_types"], feeds["target_types"], feeds["is_lineage"]) == (["warehouseTable"], ["dashboard"], True)
    assert "FEEDS" in made["lineageEdgeTypes"]
    with acting(ADA, MEMBER):
        many = await test_client.post(LAYERS, json={"name": "Many", "from": {"infer": {
            "thingTypes": [f"Type {i}" for i in range(51)], "connectionTypes": []}}})
        long = await test_client.post(LAYERS, json={"name": "Long", "from": {"infer": {
            "thingTypes": ["x" * 61], "connectionTypes": []}}})
    assert (many.status_code, refusal(many), many.json()["detail"]["limit"]) == (413, "too_large", 50)
    assert (long.status_code, refusal(long)) == (422, "invalid_rows")


@pytest.mark.asyncio
async def test_a_member_keeps_up_to_their_layer_quota(test_client: AsyncClient, world):
    playground = await world.get(WorkspaceORM, PG)
    playground.playground_settings = json.dumps({**json.loads(playground.playground_settings), "layerQuota": 2})
    await world.commit()
    first = await make_layer(test_client, name="One", publish=True)
    with acting(ADA, MEMBER):
        await test_client.post(f"{ONT}/{first['id']}/new-version")      # a version, not another layer
    await make_layer(test_client, name="Two")
    with acting(ADA, MEMBER):
        over = await test_client.post(LAYERS, json={"name": "Three", "from": {"blank": True}})
        info = (await test_client.get("/api/v1/playground")).json()
    assert (over.status_code, refusal(over)) == (409, "layer_quota")
    assert (info["layerQuota"], info["layersUsed"]) == (2, 2)
    await make_layer(test_client, BEN, name="Ben's")                    # a quota each


@pytest.mark.asyncio
async def test_the_layer_quota_is_set_with_the_playground(test_client: AsyncClient, world):
    body = {"name": "Playground", "sandboxProviderId": "prov_sandbox", "graphQuota": 3, "layerQuota": 7}
    with acting(CY, PermissionClaims(sid="s_p", global_perms=("system:admin",))):
        done = await test_client.put("/api/v1/playground", json=body)
        default = await test_client.put("/api/v1/playground", json={k: v for k, v in body.items() if k != "layerQuota"})
    assert done.status_code == 200, done.text
    assert (done.json()["graphQuota"], done.json()["layerQuota"]) == (3, 7)
    assert default.json()["layerQuota"] == 20


@pytest.mark.asyncio
async def test_making_layers_is_for_members_while_the_playground_is_on(test_client: AsyncClient, world):
    with acting(ADA, OUTSIDER):
        outsider = await test_client.post(LAYERS, json={"name": "x", "from": {"blank": True}})
    set_flags(playgroundEnabled=False)
    with acting(ADA, MEMBER):
        off = await test_client.post(LAYERS, json={"name": "x", "from": {"blank": True}})
    assert (outsider.status_code, refusal(outsider)) == (403, "playground_not_member")
    assert (off.status_code, refusal(off)) == (403, "feature_disabled")


# ── Sharing ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_sharing_lets_others_build_on_it_read_only_and_unsharing_keeps_their_graphs(
        test_client: AsyncClient, world):
    made = await make_layer(test_client, name="Mine", publish=True)
    lid = made["id"]
    assert lid not in await playground_layers.offered_ontology_ids(world, MEMBER, BEN.id)
    with acting(BEN, MEMBER):
        refused = await test_client.post(f"{LAYERS}/{lid}/share", json={"shared": True})
    with acting(ADA, MEMBER):
        shared = await test_client.post(f"{LAYERS}/{lid}/share", json={"shared": True})
    assert refused.status_code == 404                                   # not one he can see
    assert shared.status_code == 200 and shared.json()["ownerVisibility"] == "workspace"
    assert lid in await playground_layers.offered_ontology_ids(world, MEMBER, BEN.id)
    with acting(BEN, MEMBER):
        bens_view = await test_client.get(f"{ONT}/{lid}")
        not_his = await test_client.post(f"{LAYERS}/{lid}/share", json={"shared": False})
    assert bens_view.json()["access"]["canEdit"] is False
    assert (not_his.status_code, refusal(not_his)) == (403, "layer_not_yours")
    world.add(_ds("ds_ben", lid, BEN))
    await world.commit()
    with acting(ADA, MEMBER):
        private = await test_client.post(f"{LAYERS}/{lid}/share", json={"shared": False})
    assert private.json()["ownerVisibility"] == "private"
    assert lid not in await playground_layers.offered_ontology_ids(world, MEMBER, BEN.id)
    with acting(BEN, MEMBER):
        still = await test_client.get(f"{ONT}/{lid}")                   # his graph keeps it
    assert still.status_code == 200


# ── Adding a file's types to a layer of one's own ────────────────────────

_ADD = {"entityTypes": [{"name": "Dashboard"}, {"name": "table"}],
        "relationshipTypes": [{"name": "Feeds", "ends": [["Table", "Dashboard"]]}]}


@pytest.mark.asyncio
async def test_adding_types_to_a_draft_edits_it_in_place(test_client: AsyncClient, world):
    draft = await make_layer(test_client, name="Draft")
    with acting(ADA, MEMBER):
        added = await test_client.post(f"{LAYERS}/{draft['id']}/types", json=_ADD)
        again = await test_client.post(f"{LAYERS}/{draft['id']}/types", json=_ADD)
    assert added.status_code == 200, added.text
    assert added.json() == {"ontologyId": draft["id"], "version": 1, "movedGraphs": 0,
                            "entityTypeIds": {"Dashboard": "dashboard", "table": "table"},
                            "relationshipTypeIds": {"Feeds": "FEEDS"}}
    assert again.json() == added.json()                                 # names it has are found
    row = await fresh(world, draft["id"])
    feeds = json.loads(row.relationship_type_definitions)["FEEDS"]
    assert (feeds["source_types"], feeds["target_types"]) == (["table"], ["dashboard"])
    assert "FEEDS" in json.loads(row.lineage_edge_types) and row.is_published is False


@pytest.mark.asyncio
async def test_adding_types_to_a_published_layer_publishes_its_next_version_and_moves_your_graphs(
        test_client: AsyncClient, world):
    mine = await make_layer(test_client, name="Mine", publish=True, shared=True)
    world.add_all([_ds("ds_mine", mine["id"]), _ds("ds_mine_2", mine["id"]), _ds("ds_ben", mine["id"], BEN)])
    await world.commit()
    with acting(ADA, MEMBER):
        added = await test_client.post(f"{LAYERS}/{mine['id']}/types", json=_ADD)
        stale = await test_client.post(f"{LAYERS}/{mine['id']}/types", json={"entityTypes": [{"name": "Report"}]})
    with acting(BEN, MEMBER):
        not_his = await test_client.post(f"{LAYERS}/{mine['id']}/types", json=_ADD)
    assert added.status_code == 200, added.text
    newer = added.json()["ontologyId"]
    assert newer != mine["id"] and added.json()["version"] == 2 and added.json()["movedGraphs"] == 2
    row = await fresh(world, newer)
    assert (row.is_published, row.published_by, row.owner_workspace_id, row.owner_visibility, row.created_by) == \
        (True, ADA.id, PG, "workspace", ADA.id)
    assert "dashboard" in json.loads(row.entity_type_definitions)
    on = {ds.id: ds.ontology_id for ds in (await world.execute(
        select(WorkspaceDataSourceORM).execution_options(populate_existing=True))).scalars()}
    assert (on["ds_mine"], on["ds_mine_2"], on["ds_ben"]) == (newer, newer, mine["id"])   # Ben's stays
    assert (stale.status_code, refusal(stale), stale.json()["detail"]["latestId"]) == (409, "not_latest", newer)
    assert (not_his.status_code, refusal(not_his)) == (403, "layer_not_yours")


# ── Assigning a layer to a Playground graph ──────────────────────────────

@pytest.mark.asyncio
async def test_a_playground_graph_moves_only_onto_a_published_layer_on_offer(test_client: AsyncClient, world):
    draft = await make_layer(test_client, name="Draft")
    bens = await make_layer(test_client, BEN, name="Ben's private", publish=True)
    world.add_all([_ds("ds_mine", "ont_approved"), _ds("ds_team_2", "ont_team_scoped", CY, TEAM)])
    await world.commit()
    url = f"/api/v1/admin/workspaces/{PG}/data-sources/ds_mine"
    with acting(ADA, MEMBER):
        offered = await test_client.put(url, json={"ontologyId": "ont_starter"})
        not_offered = await test_client.put(url, json={"ontologyId": bens["id"]})
        unpublished = await test_client.put(url, json={"ontologyId": draft["id"]})
        same = await test_client.put(url, json={"ontologyId": "ont_starter", "label": "Renamed"})
    with acting(CY, PermissionClaims(sid="s_c", ws_perms={TEAM: EDITOR_PERMS})):
        elsewhere = await test_client.put(f"/api/v1/admin/workspaces/{TEAM}/data-sources/ds_team_2",
                                          json={"ontologyId": "ont_org_draft"})
    assert offered.status_code == 200, offered.text
    assert (not_offered.status_code, refusal(not_offered)) == (403, "ontology_not_offered")
    assert (unpublished.status_code, refusal(unpublished)) == (422, "ontology_not_published")
    assert same.status_code == 200
    assert elsewhere.status_code == 200, elsewhere.text                 # a standard workspace: unchanged


# ── Moving a graph into a workspace ──────────────────────────────────────

MAKER = PermissionClaims(sid="s_ada", ws_perms={PG: MEMBER_PERMS, LAB: ADMIN_PERMS})
#: Administers the Lab and Team: moves between them, and undoes a move.
LAB_AND_TEAM = PermissionClaims(sid="s_cy", ws_perms={LAB: ADMIN_PERMS, TEAM: ADMIN_PERMS})


async def _move(client: AsyncClient, ds_id: str, src_ws: str = PG, to: str = LAB, user=ADA,
                claims=MAKER) -> tuple[dict, dict]:
    src = f"/api/v1/admin/workspaces/{src_ws}/data-sources/{ds_id}"
    with acting(user, claims):
        preview = await client.get(f"{src}/move-preview", params={"to": to})
        assert preview.status_code == 200, preview.text
        moved = await client.post(f"{src}/move", json={"targetWorkspaceId": to, "previewToken": preview.json()["token"]},
                                  headers={"X-Activity-Reason": "Graduating"})
        assert moved.status_code == 200, moved.text
    return preview.json(), moved.json()


async def _ontology_of(session, ds_id: str) -> str:
    return (await session.execute(select(WorkspaceDataSourceORM).where(WorkspaceDataSourceORM.id == ds_id)
                                  .execution_options(populate_existing=True))).scalar_one().ontology_id


@pytest.fixture
async def movable(world, monkeypatch):
    fake_version_store(monkeypatch)
    world.add_all([UserORM(id=u.id, email=u.email, password_hash="x", first_name=u.first_name, last_name="T",
                           status="active", created_at="t", updated_at="t") for u in (ADA, BEN, CY)])
    await world.commit()
    return world


@pytest.mark.asyncio
async def test_a_layer_only_the_moving_graph_uses_becomes_the_workspaces(test_client: AsyncClient, movable):
    mine = await make_layer(test_client, name="Mine", publish=True, shared=True)
    with acting(ADA, MEMBER):
        newer = (await test_client.post(f"{ONT}/{mine['id']}/new-version")).json()
    movable.add(_ds("ds_mine", mine["id"]))
    await movable.commit()
    preview, _ = await _move(test_client, "ds_mine")
    [note] = [n for n in preview["notes"] if n["code"] == "layer_moves"]
    assert note["message"] == ("Your layer “Mine” moves with it and becomes Lab's layer; its data engineers "
                               "can edit it and approve it for everyone.")
    assert "ontology_shared" not in {n["code"] for n in preview["notes"]}
    for oid in (mine["id"], newer["id"]):                               # every version of it
        row = await fresh(movable, oid)
        assert (row.owner_workspace_id, row.owner_visibility) == (LAB, None)
    assert await _ontology_of(movable, "ds_mine") == mine["id"]
    # The Lab's data engineers edit it now (the version its graph is on); its maker, in the
    # Playground, doesn't.
    with acting(ADA, MEMBER):
        maker = await test_client.put(f"{ONT}/{newer['id']}", json={"name": "Still mine?"})
    with acting(BEN, PermissionClaims(sid="s_l", ws_perms={LAB: EDITOR_PERMS})):
        engineer = await test_client.put(f"{ONT}/{mine['id']}", json={"name": "The Lab's"})
    assert (maker.status_code, refusal(maker)) == (403, "missing_permission")
    assert engineer.status_code == 200, engineer.text


@pytest.mark.asyncio
async def test_a_layer_other_graphs_still_use_is_copied_for_the_workspace(test_client: AsyncClient, movable):
    mine = await make_layer(test_client, name="Mine", publish=True, shared=True)
    movable.add_all([_ds("ds_mine", mine["id"]), _ds("ds_ben", mine["id"], BEN)])
    await movable.commit()
    preview, _ = await _move(test_client, "ds_mine")
    [note] = [n for n in preview["notes"] if n["code"] == "layer_moves"]
    assert note["message"] == ("Your layer “Mine” is used by other graphs in Playground too, so Lab gets its own "
                               "copy of it; its data engineers can edit it and approve it for everyone.")
    copy_id = await _ontology_of(movable, "ds_mine")
    copy, original = await fresh(movable, copy_id), await fresh(movable, mine["id"])
    assert copy_id != mine["id"]
    assert (copy.owner_workspace_id, copy.owner_visibility, copy.scope, copy.is_published, copy.schema_id) == \
        (LAB, None, "workspace", True, copy_id)
    assert copy.entity_type_definitions == original.entity_type_definitions
    assert (original.owner_workspace_id, original.owner_visibility) == (PG, "workspace")    # nothing breaks
    assert await _ontology_of(movable, "ds_ben") == mine["id"]


@pytest.mark.asyncio
async def test_an_org_layer_stays_where_it_is(test_client: AsyncClient, movable):
    movable.add(_ds("ds_mine", "ont_approved"))
    await movable.commit()
    preview, _ = await _move(test_client, "ds_mine")
    assert "layer_moves" not in {n["code"] for n in preview["notes"]}
    assert (await fresh(movable, "ont_approved")).owner_workspace_id is None


@pytest.mark.asyncio
@pytest.mark.parametrize("used_elsewhere", [False, True])
async def test_undoing_a_move_puts_the_layer_back(test_client: AsyncClient, movable, used_elsewhere):
    """A workspace's own layer moves on with its graph the same way, and undoing the move puts
    it back: the Lab's again, or the graph back on it rather than on its copy."""
    movable.add_all([org_layer("ont_labs", scope="workspace", owner=LAB, name="The Lab's"),
                     _ds("ds_lab", "ont_labs", ws=LAB)])
    if used_elsewhere:
        movable.add(_ds("ds_lab_2", "ont_labs", ws=LAB))
    await movable.commit()
    _, moved = await _move(test_client, "ds_lab", LAB, TEAM, CY, LAB_AND_TEAM)
    moved_to = await _ontology_of(movable, "ds_lab")
    assert (moved_to != "ont_labs") is used_elsewhere
    assert (await fresh(movable, moved_to)).owner_workspace_id == TEAM
    with acting(CY, LAB_AND_TEAM):
        undone = await test_client.post(f"/api/v1/admin/data-source-transfers/{moved['id']}/undo")
    assert undone.status_code == 200, undone.text
    assert await _ontology_of(movable, "ds_lab") == "ont_labs"
    assert (await fresh(movable, "ont_labs")).owner_workspace_id == LAB


# ── The contract ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_what_is_on_offer_and_the_refusals(test_client: AsyncClient, world):
    mine = await make_layer(test_client, name="Mine")
    bens = await make_layer(test_client, BEN, name="Ben's private", publish=True)
    offered = await playground_layers.offered_ontology_ids(world, MEMBER, ADA.id)
    assert offered == {"ont_approved", "ont_starter", mine["id"]}
    assert await playground_layers.offered_ontology_ids(world, OUTSIDER, ADA.id) == set()
    assert (await playground_layers.assert_offered(world, MEMBER, ADA.id, "ont_approved")).id == "ont_approved"
    for oid, code, kind in ((mine["id"], 422, "ontology_not_published"), (bens["id"], 403, "ontology_not_offered"),
                            ("ont_nowhere", 404, "unknown_ontology")):
        with pytest.raises(HTTPException) as refused:
            await playground_layers.assert_offered(world, MEMBER, ADA.id, oid)
        assert (refused.value.status_code, refused.value.detail["type"]) == (code, kind)


@pytest.mark.asyncio
async def test_a_blank_graph_in_the_playground_goes_only_on_a_layer_on_offer(
        test_client: AsyncClient, world):
    """The View wizard's blank graph is held to the same offer as a graph from a file: another
    member's private layer is refused before anything is made."""
    from backend.app.api.v1.endpoints import versioning as versioning_ep
    bens = await make_layer(test_client, BEN, name="Ben's private", publish=True)
    request = versioning_ep.CreateBlankGraphRequest(name="Mine", providerId="prov_sandbox",
                                                    ontologyId=bens["id"])
    with pytest.raises(HTTPException) as refused:
        await versioning_ep.create_blank_graph(PG, request, ADA, None, world, claims=MEMBER)
    assert (refused.value.status_code, refused.value.detail["type"]) == (403, "ontology_not_offered")


@pytest.mark.asyncio
async def test_a_layers_types_as_a_starter_graph_reads_them(world):
    world.add(org_layer("ont_shop", entities={
        "store": {"name": "Store", "plural_name": "Stores", "visual": {"icon": "Store", "color": "#111111"}},
        "shelf": {"name": "Shelf", "plural_name": "Shelves"},
        "supplier": {"name": "Supplier"}},
        rels={"HOLDS": {"name": "Holds", "is_containment": True, "source_types": ["store"], "target_types": ["shelf"]},
              "SUPPLIES": {"name": "Supplies", "source_types": ["supplier"], "target_types": ["store"]}}))
    await world.commit()
    entities, relationships = await playground_layers.starter_types_of(world, "ont_shop")
    assert list(entities) == ["store", "shelf", "supplier"]
    assert (entities["store"].plural, entities["store"].icon, entities["store"].color) == ("Stores", "Store", "#111111")
    assert relationships["HOLDS"].containment is True and relationships["SUPPLIES"].containment is False
    entities, relationships = await playground_layers.starter_types_of(world, "ont_shop", ["store", "shelf"])
    assert (list(entities), list(relationships)) == (["store", "shelf"], ["HOLDS"])
    # The ends it declares stand in for rows: a graph made before its file loads still gets its
    # Hierarchy view of what contains what, and its Context View starts at the containers.
    assert relationships["HOLDS"].ends == (("store",), ("shelf",))
    starter = playground_starter.Starter(
        title="Shop", description="", icon="Store", ontology_id="ont_shop", ontology_name="Shop",
        ontology_description="", entity_types=entities, relationship_types=relationships, fields=(),
        rows=(), message="", view_name="Shop")
    assert starter.containment() == ("HOLDS", "store", "shelf")
    assert starter.top_level_types() == ["store"]


@pytest.mark.asyncio
async def test_a_layer_nothing_was_built_on_can_be_dropped(test_client: AsyncClient, world):
    made = await playground_layers.create_owned(world, claims=MEMBER, user_id=ADA.id, playground_id=PG,
                                                name="Failed start", description=None,
                                                source={"infer": INFER}, publish=True)
    used = await make_layer(test_client, name="Used", publish=True)
    world.add(_ds("ds_used", used["id"]))
    await world.commit()
    assert made.is_published and made.owner_workspace_id == PG
    await playground_layers.drop_owned(world, made.id)
    await playground_layers.drop_owned(world, used["id"])
    await playground_layers.drop_owned(world, "ont_approved")           # an org layer: never
    assert await world.get(OntologyORM, made.id) is None
    assert (await world.execute(select(OntologyAuditLogORM).where(OntologyAuditLogORM.ontology_id == made.id))).first() is None
    assert await world.get(OntologyORM, used["id"]) is not None
    assert await world.get(OntologyORM, "ont_approved") is not None
