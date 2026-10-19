"""Layout template versions, and how a template's update reaches the views built from it.

* a template starts at version 1; only a change to its layers makes another —
  a rename, or the studio sending the same layers back, does not;
* every version stays readable, and restoring one makes it the newest;
* a view records the version its layers came from, and can be told it now
  matches a newer one (``PUT /views/{id}/template-version``) without counting
  as an edit;
* a new version reaches the owners of live views built from an older one, once
  until they read it — never the person who made it, never for a personal
  template.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError
from sqlalchemy import select

from backend.app.db.models import NotificationORM
from backend.common.models.management import ViewCheckpointRequest
from backend.tests.test_layout_templates import URL, WS, _as, _layers, library  # noqa: F401

VIEWS = "/api/v1/views/"


async def _template(client, who="alice", *, visibility="workspace", layers=("Bronze", "Silver")):
    body = {"name": "Medallion", "layers": _layers(*layers), "visibility": visibility}
    if visibility == "workspace":
        body["workspaceId"] = WS
    with _as(who):
        resp = await client.post(URL, json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _edit(client, template_id, who="alice", **body):
    with _as(who):
        resp = await client.put(f"{URL}/{template_id}", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _view(client, template_id, who="dave", **extra):
    with _as(who):
        resp = await client.post(VIEWS, json={
            "name": f"{who}'s view", "workspaceId": WS, "viewType": "graph",
            "visibility": "workspace", "contextModelId": template_id, **extra,
        })
    assert resp.status_code == 201, resp.text
    return resp.json()


async def test_only_new_layers_make_a_new_version(test_client, db_session, library):
    tpl = await _template(test_client)
    assert tpl["version"] == 1

    assert (await _edit(test_client, tpl["id"], name="Medallion v2"))["version"] == 1
    assert (await _edit(test_client, tpl["id"], layers=tpl["layers"]))["version"] == 1
    changed = await _edit(
        test_client, tpl["id"], layers=_layers("Bronze", "Silver", "Gold"), changeNote="Added Gold",
    )
    assert changed["version"] == 2

    with _as("alice"):
        listed = (await test_client.get(f"{URL}/{tpl['id']}/versions")).json()["items"]
        first = (await test_client.get(f"{URL}/{tpl['id']}/versions/1")).json()
        missing = await test_client.get(f"{URL}/{tpl['id']}/versions/7")
    assert [(v["version"], v["changeNote"], v["layerCount"]) for v in listed] == [
        (2, "Added Gold", 3), (1, None, 2),
    ]
    assert [layer["name"] for layer in first["layers"]] == ["Bronze", "Silver"]
    assert missing.status_code == 404


async def test_restoring_a_version_makes_it_the_newest(test_client, db_session, library):
    tpl = await _template(test_client)
    await _edit(test_client, tpl["id"], layers=_layers("Raw"))

    with _as("alice"):
        restored = await test_client.post(f"{URL}/{tpl['id']}/versions/1/restore")
        again = await test_client.post(f"{URL}/{tpl['id']}/versions/3/restore")
        listed = (await test_client.get(f"{URL}/{tpl['id']}/versions")).json()["items"]
    assert restored.status_code == 200
    assert restored.json()["version"] == 3
    assert [layer["name"] for layer in restored.json()["layers"]] == ["Bronze", "Silver"]
    assert again.json()["version"] == 3  # already the newest: nothing to make
    assert listed[0]["changeNote"] == "Restored version 1"


async def test_versions_follow_the_template_rules(test_client, db_session, library):
    mine = await _template(test_client, visibility="private")
    with _as("dave"):  # not his to see
        assert (await test_client.get(f"{URL}/{mine['id']}/versions")).status_code == 404
    with _as("alice"):  # reads an organization template, may not change it
        assert (await test_client.post(f"{URL}/t_org/versions/1/restore")).status_code == 403
        assert (await test_client.post(f"{URL}/t_builtin/versions/1/restore")).status_code == 403


async def test_a_new_version_reaches_the_owners_of_views_built_from_an_older_one(
    test_client, db_session, library,
):
    tpl = await _template(test_client)
    await _view(test_client, tpl["id"], who="dave")
    await _view(test_client, tpl["id"], who="alice")
    gone = await _view(test_client, tpl["id"], who="wsadmin")
    with _as("wsadmin"):
        assert (await test_client.delete(f"/api/v1/views/{gone['id']}")).status_code in (200, 204)

    await _edit(test_client, tpl["id"], layers=_layers("Gold"), changeNote="Added Gold", notifyUsers=True)
    await _edit(test_client, tpl["id"], layers=_layers("Platinum"), notifyUsers=True)

    rows = (await db_session.execute(
        select(NotificationORM).where(NotificationORM.kind == "layout_template.updated")
    )).scalars().all()
    # Dave once (the second waits behind the unread first); never Alice, who
    # made the change, nor the owner of a deleted view.
    assert [(n.user_id, n.body, n.link) for n in rows] == [
        ("usr_dave", "Added Gold", f"/templates/{tpl['id']}"),
    ]

    # Without asking, nobody is told.
    await _edit(test_client, tpl["id"], layers=_layers("Iron"))
    assert len((await db_session.execute(
        select(NotificationORM).where(NotificationORM.kind == "layout_template.updated")
    )).scalars().all()) == 1


async def test_a_personal_template_tells_nobody(test_client, db_session, library):
    tpl = await _template(test_client, visibility="private")
    await _view(test_client, tpl["id"], who="alice")
    await _edit(test_client, tpl["id"], layers=_layers("Gold"), notifyUsers=True)
    assert (await db_session.execute(select(NotificationORM))).scalars().all() == []


async def test_a_view_records_the_version_its_layers_came_from(test_client, db_session, library):
    tpl = await _template(test_client)
    await _edit(test_client, tpl["id"], layers=_layers("Gold"))  # now at v2

    assert (await _view(test_client, tpl["id"], contextModelVersion=1))["contextModelVersion"] == 1
    assert (await _view(test_client, tpl["id"]))["contextModelVersion"] == 2
    assert (await _view(test_client, tpl["id"], contextModelVersion=9))["contextModelVersion"] == 2
    refused = await _view(test_client, "t_alice", contextModelVersion=1)  # someone's personal
    assert (refused["contextModelId"], refused["contextModelVersion"]) == (None, None)


async def test_a_view_is_told_which_version_it_matches_without_being_edited(
    test_client, db_session, library,
):
    tpl = await _template(test_client)
    view = await _view(test_client, tpl["id"])
    await _edit(test_client, tpl["id"], layers=_layers("Gold"))
    plain = await _view(test_client, None)

    url = f"/api/v1/views/{view['id']}/template-version"
    with _as("dave"):
        moved = await test_client.put(url, json={"version": 2})
        ahead = await test_client.put(url, json={"version": 3})
        zero = await test_client.put(url, json={"version": 0})
        no_template = await test_client.put(f"/api/v1/views/{plain['id']}/template-version", json={"version": 1})
    assert moved.status_code == 200
    assert moved.json()["contextModelVersion"] == 2
    assert moved.json()["updatedAt"] == view["updatedAt"]
    assert ahead.status_code == 422 and zero.status_code == 422 and no_template.status_code == 422
    with _as("outsider"):
        assert (await test_client.put(url, json={"version": 1})).status_code == 403


def test_applying_a_template_update_is_a_checkpoint_a_client_may_ask_for():
    assert ViewCheckpointRequest(source="template").source == "template"
    with pytest.raises(ValidationError):
        ViewCheckpointRequest(source="import")
