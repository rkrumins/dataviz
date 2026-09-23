"""Imports staged in a draft of a version-controlled data source: nothing goes live until the
draft does.

  * A new view lives only in its own new draft: private, in no list or count, until the draft is
    published (it then goes live as asked) or abandoned (it is discarded).
  * An update is proposed in the importer's draft for the view: the published view is untouched,
    the draft reads the file's design, and publishing merges it 3-way with what was published
    meanwhile, recorded as the import.
  * Retries answer with what was staged; staging needs version control and the right to open
    drafts.
"""
from __future__ import annotations

from typing import Optional

import pytest
from sqlalchemy import func, select

from backend.app.api.v1.endpoints.versioning import get_versioning_service
from backend.app.db.models import ProviderORM, ViewORM, ViewVersionORM, WorkspaceDataSourceORM
from backend.app.db.repositories import view_repo
from backend.app.services.permission_service import PermissionClaims
from backend.tests.test_view_transfer_import import (  # noqa: F401 — graph is a fixture
    _as, _assignments, _edit, _file, _import, _layout, _user, _view, _workspace, graph,
)


class _Versioning:
    """Just enough graph version control: a versioned graph per data source, and drafts that
    belong to a person and a view (branch-per-view)."""

    def __init__(self):
        self.graphs: dict = {}
        self.drafts: list = []

    def track(self, workspace_id: str, data_source_id: str) -> None:
        self.graphs[data_source_id] = {"graph_id": f"g_{data_source_id}", "workspace_id": workspace_id,
                                       "data_source_id": data_source_id}

    async def get_graph_by_data_source(self, data_source_id):
        return self.graphs.get(data_source_id)

    async def open_draft(self, *, graph_id, owner, name=None, originating_view_id=None, shared=False):
        branch_id = f"br_{len(self.drafts) + 1}"
        self.drafts.append({"branch_id": branch_id, "graph_id": graph_id, "owner": owner, "name": name,
                            "originating_view_id": originating_view_id, "status": "open"})
        return branch_id

    async def resolve_graph(self, *, data_source_id, actor, workspace_id=None, open_draft_if_absent=True,
                            originating_view_id=None):
        graph = self.graphs.get(data_source_id)
        if graph is None:
            return None
        mine = [d for d in self.drafts if d["owner"] == actor and d["status"] == "open"
                and d["graph_id"] == graph["graph_id"] and d["originating_view_id"] == originating_view_id]
        branch_id = mine[-1]["branch_id"] if mine else None
        if branch_id is None and open_draft_if_absent:
            branch_id = await self.open_draft(graph_id=graph["graph_id"], owner=actor,
                                              originating_view_id=originating_view_id)
        return {"graph_id": graph["graph_id"], "my_draft": {"branch_id": branch_id} if branch_id else None}


@pytest.fixture
def versioning():
    from backend.app.main import app

    fake = _Versioning()
    app.dependency_overrides[get_versioning_service] = lambda: fake
    yield fake
    app.dependency_overrides.pop(get_versioning_service, None)


async def _data_source(db_session, workspace_id: str, graph_name: str = "lineage") -> str:
    provider = ProviderORM(name=f"falkor-{workspace_id}", provider_type="falkordb")
    db_session.add(provider)
    await db_session.flush()
    ds = WorkspaceDataSourceORM(workspace_id=workspace_id, provider_id=provider.id, graph_name=graph_name)
    db_session.add(ds)
    await db_session.flush()
    return ds.id


async def _stage(client, inspected, target, **kwargs):
    """``_import`` with ``stage`` set, sent the way the wizard sends it."""
    view = inspected["views"][0]
    bundle = inspected["bundle"]
    metadata = {**view["metadata"], **{k: v for k, v in kwargs.items()
                                      if k in ("name", "description", "visibility", "tags", "icon")}}
    return await client.post("/api/v1/views/transfer/import", json={
        "action": kwargs.get("action", "create"), "strategy": kwargs.get("strategy", "replace"),
        "target": target, "metadata": metadata,
        "definition": kwargs.get("definition") or view["definition"],
        "origin": {"portableId": view["portableId"], "sourceViewId": view["sourceViewId"],
                   "version": view["version"], "definitionHash": view["definitionHash"],
                   "name": view["metadata"]["name"], "environment": bundle["generator"]["environment"],
                   "exportedAt": bundle["exportedAt"], "fileName": "finance-lineage.view.json"},
        "manifest": view["manifest"], "history": view["history"],
        "expectedTargetHash": kwargs.get("expected"), "requestId": kwargs.get("request_id"),
        "stage": True,
    })


async def _listed(client, ws: str) -> list:
    resp = await client.get("/api/v1/views/", params={"workspaceId": ws})
    assert resp.status_code == 200, resp.text
    return [v["id"] for v in resp.json()["items"]]


async def _versions(db_session, view_id: str) -> list:
    rows = (await db_session.execute(
        select(ViewVersionORM).where(ViewVersionORM.view_id == view_id).order_by(ViewVersionORM.version)
    )).scalars().all()
    return [(v.version, v.source) for v in rows]


# ── A new view ───────────────────────────────────────────────────────────────


async def test_a_new_view_waits_in_its_own_draft_until_it_is_published(test_client, db_session, graph, versioning):
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    ds = await _data_source(db_session, uat)
    versioning.track(uat, ds)
    inspected = await _file(test_client, await _view(test_client, dev))

    resp = await _stage(test_client, inspected, {"workspaceId": uat, "dataSourceId": ds}, visibility="workspace",
                        tags=["uat-candidate"])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    branch = body["staged"]["branchId"]
    view_id = body["viewId"]
    [draft] = versioning.drafts
    assert (draft["branch_id"], draft["originating_view_id"], draft["name"]) == \
        (branch, view_id, "Import: Finance lineage"), "a new view gets a draft of its own, named for it"
    assert (body["version"]["version"], body["version"]["source"]) == (1, "import")
    assert body["view"]["draftBranchId"] == branch
    assert body["view"]["visibility"] == "private", "private until the draft goes live"

    # Nowhere to be seen: lists, the catalogue's numbers, its facets.
    assert view_id not in await _listed(test_client, uat)
    stats = (await test_client.get("/api/v1/views/stats", params={"workspaceId": uat})).json()
    assert stats["total"] == 0, stats
    facets = (await test_client.get("/api/v1/views/facets")).json()
    assert "uat-candidate" not in str(facets.get("tags"))
    # ... but its importer can open it (on its draft), and it can't be shared wider meanwhile.
    assert (await test_client.get(f"/api/v1/views/{view_id}", params={"branchId": branch})).status_code == 200
    assert (await test_client.put(f"/api/v1/views/{view_id}/visibility",
                                  json={"visibility": "workspace"})).status_code == 409

    # The draft is published.
    await view_repo.promote_overlays_for_branch(db_session, branch, actor="usr_publisher")
    await db_session.flush()
    row = await db_session.get(ViewORM, view_id)
    assert row.draft_branch_id is None and row.visibility == "workspace", "live, as asked at import"
    live = (await test_client.get(f"/api/v1/views/{view_id}")).json()
    assert live["config"]["layout"]["referenceLayout"]["futureLayoutField"] == {"kept": True}, \
        "going live keeps even the layout fields the merge doesn't know"
    assert view_id in await _listed(test_client, uat)
    assert await _versions(db_session, view_id) == [(1, "import")], "nothing changed in the draft: no new version"


async def test_abandoning_the_draft_discards_the_view_it_held(test_client, db_session, graph, versioning):
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    ds = await _data_source(db_session, uat)
    versioning.track(uat, ds)
    inspected = await _file(test_client, await _view(test_client, dev))
    body = (await _stage(test_client, inspected, {"workspaceId": uat, "dataSourceId": ds})).json()

    await view_repo.drop_overlays_for_branch(db_session, body["staged"]["branchId"])
    await db_session.flush()
    db_session.expunge_all()
    assert await db_session.get(ViewORM, body["viewId"]) is None


# ── An update ────────────────────────────────────────────────────────────────


async def test_an_update_is_proposed_in_the_draft_and_merges_when_published(test_client, db_session, graph, versioning):
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    ds = await _data_source(db_session, uat)
    versioning.track(uat, ds)
    source_id = await _view(test_client, dev)
    first = await _file(test_client, source_id)
    here = (await _import(test_client, first, {"workspaceId": uat, "dataSourceId": ds})).json()["viewId"]
    before = await _versions(db_session, here)

    await _edit(test_client, source_id, "urn:x")                       # dev moves on
    second = await _file(test_client, source_id)
    resp = await _stage(test_client, second, {"viewId": here}, action="update", name="Finance (from dev)")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    branch = body["staged"]["branchId"]
    assert body["version"] is None, "no version until the draft goes live"
    assert versioning.drafts[0]["originating_view_id"] == here, "the importer's own draft for the view"

    # Published: untouched. The draft: the file's design, under the name given.
    published = (await test_client.get(f"/api/v1/views/{here}")).json()
    assert "urn:x" not in published["config"]["layout"]["referenceLayout"]["assignments"]
    assert published["name"] == "Finance lineage"
    assert await _versions(db_session, here) == before
    drafted = (await test_client.get(f"/api/v1/views/{here}", params={"branchId": branch})).json()
    assert "urn:x" in drafted["config"]["layout"]["referenceLayout"]["assignments"]
    assert drafted["name"] == "Finance (from dev)"
    assert drafted["config"]["futureSetting"] == {"kept": [1, {"exactly": True}]}

    # Meanwhile the published view changes too; publishing the draft keeps both.
    await _edit(test_client, here, "urn:y")
    await view_repo.promote_overlays_for_branch(db_session, branch, actor="usr_publisher")
    await db_session.flush()
    row = await db_session.get(ViewORM, here)
    await db_session.refresh(row)
    live = (await test_client.get(f"/api/v1/views/{here}")).json()
    assignments = live["config"]["layout"]["referenceLayout"]["assignments"]
    assert "urn:x" in assignments and "urn:y" in assignments, "the file's change and the one made here"
    assert live["name"] == "Finance (from dev)"
    versions = await _versions(db_session, here)
    assert versions[-1][1] == "import"
    latest = (await db_session.execute(
        select(ViewVersionORM).where(ViewVersionORM.view_id == here).order_by(ViewVersionORM.version.desc()).limit(1)
    )).scalar_one()
    import json as _json
    provenance = _json.loads(latest.provenance)
    assert provenance["branchId"] == branch
    assert provenance["origin"]["hash"] == second["views"][0]["definitionHash"]
    assert latest.origin_hash, "what's stored isn't the file: its design is kept for later merges"

    activity = (await test_client.get(f"/api/v1/views/{here}/activity")).json()
    assert any("published from a draft" in (a.get("summary") or "") for a in activity)


async def test_a_retried_staged_import_answers_with_what_it_staged(test_client, db_session, graph, versioning):
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    ds = await _data_source(db_session, uat)
    versioning.track(uat, ds)
    source_id = await _view(test_client, dev)
    first = await _file(test_client, source_id)

    new_1 = (await _stage(test_client, first, {"workspaceId": uat, "dataSourceId": ds}, request_id="req-new-0001")).json()
    new_2 = (await _stage(test_client, first, {"workspaceId": uat, "dataSourceId": ds}, request_id="req-new-0001")).json()
    assert new_2["viewId"] == new_1["viewId"] and new_2["staged"] == new_1["staged"]
    assert len(versioning.drafts) == 1

    prod = await _workspace(test_client, "Prod")
    prod_ds = await _data_source(db_session, prod)
    versioning.track(prod, prod_ds)
    here = (await _import(test_client, first, {"workspaceId": prod, "dataSourceId": prod_ds})).json()["viewId"]
    up_1 = (await _stage(test_client, first, {"viewId": here}, action="update", request_id="req-upd-0001")).json()
    up_2 = (await _stage(test_client, first, {"viewId": here}, action="update", request_id="req-upd-0001")).json()
    assert up_2["staged"] == up_1["staged"] and up_2["integrity"].get("replayed") is True
    assert len(versioning.drafts) == 2


async def test_staging_needs_version_control_and_the_right_to_open_drafts(test_client, db_session, graph, versioning):
    dev, uat = await _workspace(test_client, "Dev"), await _workspace(test_client, "UAT")
    ds = await _data_source(db_session, uat)
    inspected = await _file(test_client, await _view(test_client, dev))
    target = {"workspaceId": uat, "dataSourceId": ds}

    resp = await _stage(test_client, inspected, target)
    assert resp.status_code == 422 and resp.json()["detail"]["type"] == "not_versioned"

    versioning.track(uat, ds)
    resp = await _stage(test_client, inspected, target, visibility="enterprise")
    assert resp.status_code == 422, "publishing to everyone waits until the view is live"

    maker = PermissionClaims(sid="s_maker", ws_perms={uat: ("workspace:view:create", "workspace:view:read")})
    with _as(_user("usr_maker"), maker):
        resp = await _stage(test_client, inspected, target)
    assert resp.status_code == 403
    assert not versioning.drafts
    count = await db_session.scalar(select(func.count()).select_from(ViewORM).where(ViewORM.workspace_id == uat))
    assert count == 0
