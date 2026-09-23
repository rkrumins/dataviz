"""Importing views from a file: inspect, reconcile, import, and the round trip that proves nothing
is lost on the way."""
from __future__ import annotations

import contextlib
import time
from types import SimpleNamespace

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select

from backend.app.auth.dependencies import get_current_user, get_optional_user, get_permission_claims
from backend.app.db.models import ProviderORM, ViewORM, WorkspaceDataSourceORM
from backend.app.services.feature_flags import feature_flags
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.view_transfer import importing, limits
from backend.app.services.view_transfer.canonical import canonical_json
from backend.auth_service.interface import User

pytestmark = pytest.mark.usefixtures("view_portability_enabled")  # the preview ships off


class _Provider:
    """One physical graph, onboarded in every workspace the tests use."""

    def __init__(self):
        self.known = {
            urn: {"type": "dataset", "name": urn.split(":")[1], "qualifiedName": None}
            for urn in ("urn:a", "urn:b", "urn:x", "urn:y")
        }
        self.known["urn:anchor"] = {"type": "domain", "name": "Finance", "qualifiedName": None}
        self.calls = 0

    async def resolve_identities(self, urns):
        self.calls += 1
        return {u: self.known.get(u) for u in urns}


class _Engine:
    def __init__(self, provider):
        self.provider = provider

    async def get_ontology_digest(self):
        return "digest-abc"

    async def get_resolved_ontology(self):
        return SimpleNamespace(
            entity_type_definitions={"dataset": SimpleNamespace(name="Dataset"),
                                     "domain": SimpleNamespace(name="Domain")},
            relationship_type_definitions={"PRODUCES": SimpleNamespace(name="Produces")},
            containment_edge_types=["CONTAINS"], lineage_edge_types=["PRODUCES"],
        )


@pytest.fixture
def graph(monkeypatch):
    provider = _Provider()
    provider.branches = []            # the draft each lookup read, if any

    async def _engine_for(session, workspace_id, data_source_id, *, branch_id=None, actor=None):
        provider.branches.append(branch_id)
        return _Engine(provider)

    for module in ("export", "inspect", "importing"):
        monkeypatch.setattr(f"backend.app.services.view_transfer.{module}.engine_for", _engine_for)
    return provider


def _layout(*extra_urns, order_key="a0"):
    assignments = {
        "urn:a": {"layerId": "l1", "inheritsChildren": True, "orderKey": order_key},
        "urn:b": {"layerId": "l2", "inheritsChildren": False, "logicalNodeId": "ln1"},
        "urn:gone": {"layerId": "l1", "inheritsChildren": True},
    }
    for urn in extra_urns:
        assignments[urn] = {"layerId": "l2", "inheritsChildren": True}
    return {
        "layers": [
            {"id": "l1", "name": "Sources", "entityTypes": ["dataset"], "order": 0,
             "anchorUrn": "urn:anchor", "nodeSortMode": "custom"},
            {"id": "l2", "name": "Marts", "entityTypes": [], "order": 1,
             "logicalNodes": [{"id": "ln1", "name": "Curated", "children": []}]},
        ],
        "assignments": assignments,
        "displayRules": [{"id": "hot", "op": "color", "value": "#f00"}],
        "futureLayoutField": {"kept": True},
    }


async def _workspace(client: AsyncClient, name: str) -> str:
    resp = await client.post("/api/v1/admin/workspaces", json={"name": name, "dataSources": []})
    assert resp.status_code == 201
    return resp.json()["id"]


async def _view(client: AsyncClient, ws: str, name: str = "Finance lineage", **extra) -> str:
    resp = await client.post("/api/v1/views/", json={
        "name": name, "workspaceId": ws, "viewType": "reference", "tags": ["finance"],
        "description": "What feeds revenue",
        "config": {
            "icon": "Layout",
            "layout": {"type": "reference", "referenceLayout": _layout()},
            "content": {"visibleEntityTypes": ["dataset", "domain"],
                        "visibleRelationshipTypes": ["PRODUCES"]},
            "entityOverrides": {"dataset": {"color": "#111"}},
            "entityAssignments": {"urn:legacy": "l1"},
            "futureSetting": {"kept": [1, {"exactly": True}]},
        },
        **extra,
    })
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _edit(client: AsyncClient, view_id: str, *extra_urns):
    resp = await client.put(f"/api/v1/views/{view_id}/layout", json={
        "referenceLayout": _layout(*extra_urns), "checkpoint": {"source": "wizard"}})
    assert resp.status_code == 200, resp.text


async def _export(client: AsyncClient, view_id: str) -> bytes:
    resp = await client.post("/api/v1/views/transfer/export", json={"views": [{"viewId": view_id}]})
    assert resp.status_code == 200, resp.text
    return resp.content


async def _inspect(client: AsyncClient, raw: bytes):
    return await client.post("/api/v1/views/transfer/inspect", content=raw,
                             headers={"content-type": "application/json"})


async def _file(client: AsyncClient, view_id: str) -> dict:
    """Export a view and inspect the file, as the wizard does when the file is dropped."""
    resp = await _inspect(client, await _export(client, view_id))
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _reconcile(client: AsyncClient, view: dict, target: dict, *, action="create",
                     strategy="replace", resolutions=None):
    return await client.post("/api/v1/views/transfer/reconcile", json={"views": [{
        "key": "0", "portableId": view["portableId"], "definition": view["definition"],
        "viewType": view["metadata"]["viewType"], "manifest": view["manifest"],
        "history": [h["hash"] for h in view["history"]],
        "target": target, "action": action, "strategy": strategy, "resolutions": resolutions or {},
    }]})


async def _import(client: AsyncClient, inspected: dict, target: dict, *, action="create",
                  definition=None, strategy="replace", expected=None, request_id=None,
                  originDefinition=None, **metadata):
    view = inspected["views"][0]
    bundle = inspected["bundle"]
    return await client.post("/api/v1/views/transfer/import", json={
        "originDefinition": originDefinition,
        "action": action, "strategy": strategy, "target": target,
        "metadata": {**view["metadata"], **metadata},
        "definition": view["definition"] if definition is None else definition,
        "origin": {"portableId": view["portableId"], "sourceViewId": view["sourceViewId"],
                   "version": view["version"], "definitionHash": view["definitionHash"],
                   "name": view["metadata"]["name"], "environment": bundle["generator"]["environment"],
                   "exportedAt": bundle["exportedAt"], "fileName": "finance-lineage.view.json"},
        "manifest": view["manifest"], "history": view["history"],
        "expectedTargetHash": expected, "requestId": request_id,
    })


def _assignments(definition: dict) -> dict:
    return definition["layout"]["referenceLayout"]["assignments"]


# ── The round trip ──────────────────────────────────────────────────────────


async def test_export_import_export_import_loses_nothing(test_client, graph):
    dev, uat, prod = [await _workspace(test_client, n) for n in ("Dev", "UAT", "Prod")]
    source_id = await _view(test_client, dev)

    first = await _file(test_client, source_id)
    [view] = first["views"]
    assert first["integrity"] == "verified" and view["integrity"] == "verified"
    [here] = first["identityMatches"][view["portableId"]]
    assert (here["viewId"], here["status"], here["canEdit"]) == (source_id, "up_to_date", True)

    reconciled = await _reconcile(test_client, view, {"workspaceId": uat})
    assert reconciled.status_code == 200, reconciled.text
    [result] = reconciled.json()["views"]
    assert result["effectiveHash"] == view["definitionHash"], "no choices made → exactly the file"
    entities = result["report"]["summary"]["entities"]
    assert (entities["total"], entities["missing"]) == (4, 1)
    assert [e["urn"] for e in result["report"]["entities"]] == ["urn:gone"]

    imported = await _import(test_client, first, {"workspaceId": uat},
                             definition=result["effectiveDefinition"])
    assert imported.status_code == 200, imported.text
    body = imported.json()
    assert body["integrity"] == {
        "submittedHash": view["definitionHash"], "storedHash": view["definitionHash"],
        "verified": True, "adjusted": False, "adjustments": []}
    assert body["view"]["portableId"] == view["portableId"], "a new home keeps the view's identity"
    assert body["view"]["name"] == "Finance lineage" and body["view"]["workspaceId"] == uat
    assert (body["version"]["version"], body["version"]["source"]) == (1, "import")
    origin = body["version"]["provenance"]["origin"]
    assert (origin["viewId"], origin["version"], origin["hash"]) == (source_id, 1, view["definitionHash"])

    second = await _file(test_client, body["viewId"])
    [again] = second["views"]
    assert again["definitionHash"] == view["definitionHash"]
    assert canonical_json(again["definition"]) == canonical_json(view["definition"])
    assert again["metadata"] == view["metadata"]
    assert [h["viewId"] for h in again["history"]] == [source_id, body["viewId"]], \
        "the file carries where the view has been"

    third = await _import(test_client, second, {"workspaceId": prod})
    assert third.status_code == 200, third.text
    final = (await _file(test_client, third.json()["viewId"]))["views"][0]
    assert final["definitionHash"] == view["definitionHash"]
    assert canonical_json(final["definition"]) == canonical_json(view["definition"])
    assert len(final["history"]) == 3

    stored = final["definition"]
    assert stored["futureSetting"] == {"kept": [1, {"exactly": True}]}
    assert stored["entityAssignments"] == {"urn:legacy": "l1"}
    assert stored["entityOverrides"] == {"dataset": {"color": "#111"}}
    rl = stored["layout"]["referenceLayout"]
    assert rl["displayRules"] == [{"id": "hot", "op": "color", "value": "#f00"}]
    assert rl["futureLayoutField"] == {"kept": True}
    assert rl["assignments"]["urn:a"]["orderKey"] == "a0"
    assert rl["layers"][1]["logicalNodes"][0]["name"] == "Curated"


async def test_a_copy_gets_its_own_identity(test_client, graph):
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    inspected = await _file(test_client, await _view(test_client, dev))
    original = inspected["views"][0]["portableId"]

    copy = (await _import(test_client, inspected, {"workspaceId": uat}, action="copy",
                          name="Finance lineage (from dev)")).json()
    assert copy["view"]["portableId"] != original
    assert copy["version"]["provenance"]["forkedFrom"] == original

    # Creating where the identity is already taken becomes a copy too, and says so.
    again = (await _import(test_client, inspected, {"workspaceId": dev})).json()
    assert again["view"]["portableId"] != original
    assert again["notices"] and "separate copy" in again["notices"][0]


async def test_resolutions_are_applied_before_matching(test_client, graph):
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    view = (await _file(test_client, await _view(test_client, dev)))["views"][0]
    resp = await _reconcile(test_client, view, {"workspaceId": uat}, resolutions={
        "drop": ["urn:gone"], "remap": {"urn:b": "urn:y"}, "typeMap": {"domain": "dataset"}})
    [result] = resp.json()["views"]
    assignments = _assignments(result["effectiveDefinition"])
    assert "urn:gone" not in assignments and "urn:b" not in assignments
    assert assignments["urn:y"]["logicalNodeId"] == "ln1", "a remap keeps the entry's placement"
    assert result["report"]["summary"]["entities"]["missing"] == 0
    assert result["effectiveHash"] != view["definitionHash"]
    assert result["effectiveDefinition"]["content"]["visibleEntityTypes"] == ["dataset"]


async def test_one_lookup_per_target_graph(test_client, graph):
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    view = (await _file(test_client, await _view(test_client, dev)))["views"][0]
    item = {"portableId": view["portableId"], "definition": view["definition"],
            "viewType": "reference", "manifest": view["manifest"], "target": {"workspaceId": uat},
            "action": "create"}
    graph.calls = 0
    resp = await test_client.post("/api/v1/views/transfer/reconcile", json={"views": [
        {**item, "key": "a"}, {**item, "key": "b"}]})
    assert resp.status_code == 200
    assert graph.calls == 1
    assert resp.json()["aggregate"]["views"] == 2


# ── Updating a view that came from the file ─────────────────────────────────


async def test_a_newer_file_fast_forwards_the_view_here(test_client, graph):
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    source_id = await _view(test_client, dev)
    target_id = (await _import(test_client, await _file(test_client, source_id), {"workspaceId": uat})).json()["viewId"]

    await _edit(test_client, source_id, "urn:x")
    newer = await _file(test_client, source_id)
    [view] = newer["views"]
    statuses = {m["viewId"]: m["status"] for m in newer["identityMatches"][view["portableId"]]}
    assert statuses[target_id] == "fast_forward"

    [result] = (await _reconcile(test_client, view, {"viewId": target_id}, action="update")).json()["views"]
    update = result["update"]
    assert (update["status"], update["mergeAvailable"], update["base"]["version"]) == ("fast_forward", False, 1)
    assert update["diff"]["assignments"]["added"] == 1

    resp = await _import(test_client, newer, {"viewId": target_id}, action="update",
                         definition=result["effectiveDefinition"], expected=update["targetWorkingHash"])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["viewId"] == target_id and body["version"]["version"] == 2
    assert body["integrity"]["storedHash"] == view["definitionHash"]

    # Now the view here is where the file is; the first file is older than it.
    [result] = (await _reconcile(test_client, view, {"viewId": target_id}, action="update")).json()["views"]
    assert result["update"]["status"] == "up_to_date"


async def test_diverged_views_merge_keeping_both_sides(test_client, graph):
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    source_id = await _view(test_client, dev)
    old = await _file(test_client, source_id)
    target_id = (await _import(test_client, old, {"workspaceId": uat})).json()["viewId"]

    await _edit(test_client, source_id, "urn:x")      # dev moves on
    await _edit(test_client, target_id, "urn:y")      # and so does uat
    newer = await _file(test_client, source_id)
    [view] = newer["views"]

    [merged] = (await _reconcile(test_client, view, {"viewId": target_id}, action="update",
                                 strategy="merge")).json()["views"]
    update = merged["update"]
    assert (update["status"], update["mergeAvailable"], update["strategy"]) == ("diverged", True, "merge")
    assert {"urn:x", "urn:y"} <= set(_assignments(merged["effectiveDefinition"]))

    [replaced] = (await _reconcile(test_client, view, {"viewId": target_id}, action="update")).json()["views"]
    assert replaced["effectiveHash"] == view["definitionHash"], "replace takes the file as it is"
    assert "urn:y" not in _assignments(replaced["effectiveDefinition"])

    resp = await _import(test_client, newer, {"viewId": target_id}, action="update", strategy="merge",
                         definition=merged["effectiveDefinition"], expected=update["targetWorkingHash"])
    assert resp.status_code == 200, resp.text
    history = (await test_client.get(f"/api/v1/views/{target_id}/versions")).json()["items"]
    assert [v["source"] for v in history][:1] == ["import"]
    stored = (await test_client.get(f"/api/v1/views/{target_id}/versions/{history[0]['version']}")).json()
    assert {"urn:x", "urn:y"} <= set(_assignments(stored["definition"]))

    [older] = (await _reconcile(test_client, old["views"][0], {"viewId": target_id},
                                action="update")).json()["views"]
    assert older["update"]["status"] == "file_is_older"


async def test_choices_made_on_import_survive_the_next_update(test_client, graph):
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    source_id = await _view(test_client, dev)
    first = await _file(test_client, source_id)
    [view] = first["views"]
    [result] = (await _reconcile(test_client, view, {"workspaceId": uat},
                                 resolutions={"drop": ["urn:gone"]})).json()["views"]
    resp = await _import(test_client, first, {"workspaceId": uat}, definition=result["effectiveDefinition"],
                         originDefinition=view["definition"])
    body = resp.json()
    target_id = body["viewId"]
    assert body["integrity"]["verified"] is True, "what was sent is what was stored"
    assert body["integrity"]["storedHash"] != view["definitionHash"], "but it isn't the file any more"

    # The same file again: nothing new, even though what's stored isn't byte-identical to it.
    [again] = (await _reconcile(test_client, view, {"viewId": target_id}, action="update")).json()["views"]
    assert again["update"]["status"] == "up_to_date"

    # Dev moves on. The newer file still finds the import as the version both sides agreed on, and
    # merging keeps what was dropped on the way in while taking what dev added.
    await _edit(test_client, source_id, "urn:x")
    newer = await _file(test_client, source_id)
    [update] = (await _reconcile(test_client, newer["views"][0], {"viewId": target_id}, action="update",
                                 strategy="merge")).json()["views"]
    assert (update["update"]["status"], update["update"]["mergeAvailable"]) == ("diverged", True)
    assignments = _assignments(update["effectiveDefinition"])
    assert "urn:x" in assignments and "urn:gone" not in assignments


async def test_unsaved_edits_here_are_kept_as_a_version_before_an_update(test_client, graph):
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    source_id = await _view(test_client, dev)
    target_id = (await _import(test_client, await _file(test_client, source_id), {"workspaceId": uat})).json()["viewId"]
    await test_client.put(f"/api/v1/views/{target_id}/layout", json={"referenceLayout": _layout("urn:y")})

    await _edit(test_client, source_id, "urn:x")
    newer = await _file(test_client, source_id)
    resp = await _import(test_client, newer, {"viewId": target_id}, action="update")
    assert resp.status_code == 200, resp.text
    history = (await test_client.get(f"/api/v1/views/{target_id}/versions")).json()["items"]
    assert [(v["version"], v["source"]) for v in history] == [(3, "import"), (2, "snapshot"), (1, "import")]


async def test_an_update_reviewed_against_a_view_that_since_changed_is_refused(test_client, graph):
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    source_id = await _view(test_client, dev)
    inspected = await _file(test_client, source_id)
    target_id = (await _import(test_client, inspected, {"workspaceId": uat})).json()["viewId"]
    resp = await _import(test_client, inspected, {"viewId": target_id}, action="update",
                         expected="sha256:what-it-was-when-reviewed")
    assert resp.status_code == 409 and resp.json()["detail"]["type"] == "target_changed"
    history = (await test_client.get(f"/api/v1/views/{target_id}/versions")).json()["items"]
    assert [v["version"] for v in history] == [1], "nothing was written"


async def test_an_update_asks_the_graph_before_it_locks_the_view(test_client, graph, monkeypatch):
    """The view's row stays locked until the import commits; a large view's lookup takes seconds,
    and a canvas save to that view would wait them out if the lookup came after the lock."""
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    inspected = await _file(test_client, await _view(test_client, dev))
    target_id = (await _import(test_client, inspected, {"workspaceId": uat})).json()["viewId"]
    order = []
    facts, locked = importing._target_facts, importing._locked_target

    async def recording_facts(*args, **kwargs):
        order.append("lookup")
        return await facts(*args, **kwargs)

    async def recording_lock(*args, **kwargs):
        order.append("lock")
        return await locked(*args, **kwargs)

    monkeypatch.setattr(importing, "_target_facts", recording_facts)
    monkeypatch.setattr(importing, "_locked_target", recording_lock)
    resp = await _import(test_client, inspected, {"viewId": target_id}, action="update")
    assert resp.status_code == 200, resp.text
    assert order == ["lookup", "lock"]


async def test_update_only_applies_to_the_same_view(test_client, graph):
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    inspected = await _file(test_client, await _view(test_client, dev))
    stranger = await _view(test_client, uat, name="Something else")
    await _edit(test_client, stranger, "urn:y")
    resp = await _reconcile(test_client, inspected["views"][0], {"viewId": stranger}, action="update")
    assert resp.status_code == 422

    [result] = (await _reconcile(test_client, inspected["views"][0], {"viewId": stranger},
                                 action="overwrite")).json()["views"]
    assert result["update"]["status"] == "unrelated" and result["update"]["mergeAvailable"] is False
    resp = await _import(test_client, inspected, {"viewId": stranger}, action="overwrite")
    assert resp.status_code == 200, resp.text
    assert resp.json()["view"]["portableId"] == inspected["views"][0]["portableId"], \
        "an overwritten view now tracks the file's view"


# ── Safety ──────────────────────────────────────────────────────────────────


async def test_a_retried_import_is_answered_by_the_first(test_client, db_session, graph):
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    inspected = await _file(test_client, await _view(test_client, dev))
    first = (await _import(test_client, inspected, {"workspaceId": uat}, request_id="req-0001-abcd")).json()
    second = (await _import(test_client, inspected, {"workspaceId": uat}, request_id="req-0001-abcd")).json()
    assert second["viewId"] == first["viewId"] and second["integrity"]["replayed"] is True
    count = await db_session.scalar(select(func.count()).select_from(ViewORM).where(ViewORM.workspace_id == uat))
    assert count == 1


async def test_a_data_source_from_another_workspace_is_refused(test_client, db_session, graph):
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    provider = ProviderORM(name="graph", provider_type="falkordb")
    db_session.add(provider)
    await db_session.flush()
    foreign = WorkspaceDataSourceORM(workspace_id=dev, provider_id=provider.id, graph_name="lineage")
    db_session.add(foreign)
    await db_session.flush()
    view = (await _file(test_client, await _view(test_client, dev)))["views"][0]
    resp = await _reconcile(test_client, view, {"workspaceId": uat, "dataSourceId": foreign.id})
    assert resp.status_code == 422


async def test_target_policy_that_strips_data_is_reported(test_client, graph):
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    inspected = await _file(test_client, await _view(test_client, dev))
    feature_flags._cache = {**(feature_flags._cache or {}), "nodeSortingEnabled": False}
    feature_flags._cache_ts = time.monotonic()

    [result] = (await _reconcile(test_client, inspected["views"][0], {"workspaceId": uat})).json()["views"]
    assert "node_sorting_disabled" in {n["code"] for n in result["report"]["notices"]}
    body = (await _import(test_client, inspected, {"workspaceId": uat})).json()
    integrity = body["integrity"]
    assert (integrity["verified"], integrity["adjusted"]) == (False, True)
    assert "node order" in integrity["adjustments"][0]
    assert body["version"]["provenance"]["adjustments"] == integrity["adjustments"]


async def test_a_retried_import_answers_as_the_first_attempt_did(test_client, graph):
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    inspected = await _file(test_client, await _view(test_client, dev))
    feature_flags._cache = {**(feature_flags._cache or {}), "nodeSortingEnabled": False}
    feature_flags._cache_ts = time.monotonic()

    first = (await _import(test_client, inspected, {"workspaceId": uat}, request_id="req-0002-abcd")).json()
    again = (await _import(test_client, inspected, {"workspaceId": uat}, request_id="req-0002-abcd")).json()
    assert again["viewId"] == first["viewId"] and again["integrity"] == {**first["integrity"], "replayed": True}
    assert (again["integrity"]["verified"], again["integrity"]["adjusted"]) == (False, True)
    assert again["report"] == first["version"]["provenance"]["report"]


def _user(uid: str) -> User:
    return User(id=uid, email=f"{uid}@example.com", first_name="T", last_name="U", role="user",
                status="active", created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z")


@contextlib.contextmanager
def _as(user: User, claims: PermissionClaims):
    from backend.app.main import app

    async def _user_dep():
        return user

    overrides = {get_current_user: _user_dep, get_optional_user: _user_dep,
                 get_permission_claims: lambda: claims}
    previous = {dep: app.dependency_overrides.get(dep) for dep in overrides}
    app.dependency_overrides.update(overrides)
    try:
        yield
    finally:
        for dep, fn in previous.items():
            if fn is None:
                app.dependency_overrides.pop(dep, None)
            else:
                app.dependency_overrides[dep] = fn


async def test_importing_needs_the_same_rights_as_building(test_client, graph):
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    raw = await _export(test_client, await _view(test_client, dev))
    inspected = (await _inspect(test_client, raw)).json()
    view = inspected["views"][0]
    shared = (await _import(test_client, inspected, {"workspaceId": uat}, visibility="workspace")).json()["viewId"]

    reader = _user("usr_reader")
    claims = PermissionClaims(sid="s_reader", ws_perms={uat: ("workspace:view:read",)})
    with _as(reader, claims):
        assert (await _reconcile(test_client, view, {"workspaceId": uat})).status_code == 403
        assert (await _import(test_client, inspected, {"workspaceId": uat})).status_code == 403
        assert (await _reconcile(test_client, view, {"viewId": shared}, action="update")).status_code == 403
        resp = await _inspect(test_client, raw)
        assert resp.status_code == 200
        [match] = resp.json()["identityMatches"][view["portableId"]]
        assert (match["viewId"], match["canEdit"]) == (shared, False), \
            "a reader sees the view is here, and that they can't update it"


async def test_the_switch_stops_imports(test_client, graph):
    feature_flags._cache = {**(feature_flags._cache or {}), "viewImportEnabled": False}
    feature_flags._cache_ts = time.monotonic()
    resp = await _inspect(test_client, b"{}")
    assert resp.status_code == 403 and resp.json()["detail"]["feature"] == "viewImportEnabled"
    resp = await test_client.post("/api/v1/views/transfer/import", json={})
    assert resp.status_code == 403


async def test_files_that_cannot_be_imported_say_why(test_client, graph, monkeypatch):
    resp = await _inspect(test_client, b"PK\x03\x04rest-of-a-zip")
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "package"
    resp = await _inspect(test_client, b"not json")
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "not_json"
    monkeypatch.setattr(limits, "MAX_BUNDLE_BYTES", 16)
    resp = await _inspect(test_client, b"{" + b" " * 64 + b"}")
    assert resp.status_code == 413


async def test_inspect_finds_where_the_file_belongs(test_client, db_session, graph):
    dev, uat, other = [await _workspace(test_client, n) for n in ("Dev", "UAT", "Other")]
    falkor = ProviderORM(name="falkor", provider_type="falkordb")
    neo = ProviderORM(name="neo", provider_type="neo4j")
    db_session.add_all([falkor, neo])
    await db_session.flush()
    for ws, provider, graph_name in ((dev, falkor, "lineage"), (uat, falkor, "lineage"), (other, neo, "misc")):
        db_session.add(WorkspaceDataSourceORM(workspace_id=ws, provider_id=provider.id, graph_name=graph_name,
                                              label=f"{graph_name} graph", is_primary=True))
    await db_session.flush()

    inspected = await _file(test_client, await _view(test_client, dev))
    [key] = inspected["targetSuggestions"]
    suggestions = inspected["targetSuggestions"][key]
    by_workspace = {s["workspaceId"]: s for s in suggestions}
    assert other not in by_workspace, "a different kind of graph with a different name isn't suggested"
    twin = by_workspace[uat]
    assert twin["score"] >= 70 and "Same graph" in twin["reasons"]
    assert twin["sampleSize"] == 3 and twin["sampleHitRate"] == pytest.approx(2 / 3)
