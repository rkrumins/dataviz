"""A data source's details: what it is, where to read more, and whether to trust it.

These pin who may change what — anyone who manages the source edits its description,
links and tags; only the workspace's admins and its named Owner and Stewards (directly
or through a group) set its classification and status, never in the Playground, where
only a source's maker edits its details — that what is saved is checked and tidied,
that an editor working from an old copy is told so, that nothing changes while the
switch is off (reading still works), how a source came to be is worked out, and that
each change is recorded in the activity ledger as a sentence — never with the text.
"""
from __future__ import annotations

import json
import time

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.db.models import (
    AuthAuditLogORM, CatalogItemORM, DataRequestORM, DataSourceContactORM, ProviderORM, WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.services import data_source_metadata as service
from backend.app.services.feature_flags import feature_flags
from backend.app.services.outbox_relay import drain_once
from backend.app.services.permission_service import PermissionClaims
from tests.common import discussions_world as w

URL = f"/api/v1/admin/workspaces/{w.WS}/data-sources/{w.DS}/metadata"
TRUST = f"{URL}/trust"
FLAG = "dataSourceMetadataEnabled"


def _switch(on: bool) -> None:
    feature_flags._cache = {**(feature_flags._cache or {}), FLAG: on}
    feature_flags._cache_ts = time.monotonic()


@pytest.fixture
async def world(db_session):
    await w.seed(db_session)


@pytest.fixture
def on():
    _switch(True)


async def _call(client, db_session, uid, method, url=URL, body=None, claims=None):
    with w.acting(uid, claims or await w.claims_for(db_session, uid)):
        return await client.request(method, url, json=body)


def _details(**overrides) -> dict:
    return {"description": None, "links": [], "tags": [], "expectedUpdatedAt": None, **overrides}


def _trust(**overrides) -> dict:
    return {"classification": None, "trustStatus": None, "trustNote": None, "expectedUpdatedAt": None, **overrides}


async def _name(db_session, role: str, kind: str, sid: str) -> None:
    db_session.add(DataSourceContactORM(data_source_id=w.DS, role=role, subject_type=kind, subject_id=sid,
                                        created_at=w.T0))
    await db_session.commit()


# ── Reading, and the switch ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_reader_sees_the_details_and_nothing_changes_while_the_switch_is_off(
    world, db_session, test_client: AsyncClient,
):
    r = await _call(test_client, db_session, w.ADA, "GET")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["dataSourceId"] == w.DS
    assert (body["description"], body["catalogDescription"], body["links"], body["tags"]) == (None, None, [], [])
    assert (body["classification"], body["trustStatus"], body["trustNote"]) == (None, None, None)
    assert (body["trustStatusBy"], body["updatedAt"], body["updatedBy"]) == (None, None, None)
    assert body["onboarding"]["at"] == w.T0 and body["onboarding"]["how"] == "provider"
    assert body["onboarding"]["by"]["id"] == w.BEN and body["onboarding"]["by"]["displayName"] == "Ben T"
    assert body["onboarding"]["fromRequest"] is None
    assert body["canEdit"] is False and body["canEditTrust"] is False

    # Off, even a workspace admin may change nothing — but still reads.
    walt = (await _call(test_client, db_session, w.WALT, "GET")).json()
    assert walt["canEdit"] is False and walt["canEditTrust"] is False
    for uid, method, url, payload in ((w.BEN, "PUT", URL, _details(description="x")),
                                      (w.WALT, "PUT", TRUST, _trust(trustStatus="certified"))):
        refused = await _call(test_client, db_session, uid, method, url, payload)
        assert refused.status_code == 403 and refused.json()["detail"]["type"] == "feature_disabled"

    # Someone who can't read the workspace's sources can't read them; a source elsewhere is not here.
    assert (await _call(test_client, db_session, w.EVE, "GET")).status_code == 403
    elsewhere = f"/api/v1/admin/workspaces/{w.WS}/data-sources/{w.DS_OPS}/metadata"
    assert (await _call(test_client, db_session, w.WALT, "GET", elsewhere)).status_code == 404


# ── Description, links and tags ──────────────────────────────────────────

@pytest.mark.asyncio
async def test_whoever_manages_the_source_edits_its_description_links_and_tags(
    world, on, db_session, test_client: AsyncClient,
):
    got = (await _call(test_client, db_session, w.BEN, "GET")).json()
    assert got["canEdit"] is True and got["canEditTrust"] is False      # a Member, named as nobody
    r = await _call(test_client, db_session, w.BEN, "PUT", body=_details(
        description="  Month-end figures, nightly.  ",
        links=[{"label": " Runbook ", "url": "https://wiki.example.com/gl"},
               {"label": "Same page", "url": "https://wiki.example.com/gl"}],
        tags=["Finance", " gl ", "finance", "", "GL"],
    ))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["description"] == "Month-end figures, nightly."
    assert body["links"] == [{"label": "Runbook", "url": "https://wiki.example.com/gl"}]
    assert body["tags"] == ["Finance", "gl"]          # case-insensitively unique; the first spelling kept
    assert body["updatedAt"] and body["updatedBy"]["id"] == w.BEN

    # Every data-source read carries them now.
    listed = await _call(test_client, db_session, w.ADA, "GET", f"/api/v1/admin/workspaces/{w.WS}/data-sources")
    [ds] = [d for d in listed.json() if d["id"] == w.DS]
    assert (ds["description"], ds["tags"], ds["trustStatus"]) == ("Month-end figures, nightly.", ["Finance", "gl"], None)

    # Recorded once, as which fields changed and which tags came and went — never the text.
    [event] = await w.events(db_session, "workspace.data_source.metadata_changed")
    payload = json.loads(event.payload)
    assert payload["actor_id"] == w.BEN and payload["data_source_id"] == w.DS
    assert payload["details"] == {"fields": ["description", "links", "tags"], "tagsAdded": ["Finance", "gl"],
                                  "tagsRemoved": []}
    assert "Month-end" not in event.payload and "wiki.example.com" not in event.payload

    # The same again changes nothing and says nothing.
    again = await _call(test_client, db_session, w.BEN, "PUT", body=_details(
        description="Month-end figures, nightly.", links=body["links"], tags=[" Finance", "gl", "GL"],
        expectedUpdatedAt=body["updatedAt"],
    ))
    assert again.status_code == 200 and again.json()["updatedAt"] == body["updatedAt"]
    assert len(await w.events(db_session, "workspace.data_source.metadata_changed")) == 1

    # A Viewer can't, and nor can a service account.
    viewer = await _call(test_client, db_session, w.ADA, "PUT", body=_details(description="mine"))
    assert viewer.status_code == 403
    bot = await _call(test_client, db_session, w.BOT, "PUT", body=_details(expectedUpdatedAt=body["updatedAt"]))
    assert bot.status_code == 403 and bot.json()["detail"]["type"] == "person_required"


@pytest.mark.asyncio
@pytest.mark.parametrize("payload, kind", [
    ({"links": [{"label": "Bad", "url": "javascript:alert(1)"}]}, "invalid_links"),
    ({"links": [{"label": "Files", "url": "ftp://files.example.com"}]}, "invalid_links"),
    ({"links": [{"label": "No host", "url": "https://"}]}, "invalid_links"),
    ({"links": [{"label": "Broken", "url": "http://[::1"}]}, "invalid_links"),
    ({"links": [{"label": "   ", "url": "https://example.com"}]}, "invalid_links"),
    ({"links": [{"label": "x" * 81, "url": "https://example.com"}]}, "invalid_links"),
    ({"links": [{"label": "Long", "url": "https://example.com/" + "a" * 2030}]}, "invalid_links"),
    ({"links": [{"label": f"L{i}", "url": f"https://example.com/{i}"} for i in range(11)]}, "invalid_links"),
    ({"tags": [f"t{i}" for i in range(21)]}, "too_many_tags"),
    ({"tags": ["x" * 41]}, "body_invalid"),
    ({"description": "x" * 4001}, "body_invalid"),
])
async def test_what_is_saved_is_checked(world, on, db_session, test_client: AsyncClient, payload, kind):
    r = await _call(test_client, db_session, w.BEN, "PUT", body=_details(**payload))
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["type"] == kind


@pytest.mark.asyncio
async def test_duplicates_are_dropped_before_they_are_counted(world, on, db_session, test_client: AsyncClient):
    links = [{"label": f"L{i}", "url": f"https://example.com/{i % 10}"} for i in range(12)]
    tags = [f"t{i % 20}" for i in range(25)] + ["T0"]
    r = await _call(test_client, db_session, w.BEN, "PUT", body=_details(links=links, tags=tags, description="   "))
    assert r.status_code == 200, r.text
    assert len(r.json()["links"]) == 10 and len(r.json()["tags"]) == 20
    assert r.json()["description"] is None          # blank is no description


@pytest.mark.asyncio
async def test_a_save_from_an_old_copy_is_stale(world, on, db_session, test_client: AsyncClient):
    first = await _call(test_client, db_session, w.BEN, "PUT", body=_details(description="Ben's"))
    assert first.status_code == 200
    late = await _call(test_client, db_session, w.WALT, "PUT", body=_details(description="Walt's"))
    assert late.status_code == 409
    detail = late.json()["detail"]
    assert detail["type"] == "stale" and detail["current"]["description"] == "Ben's"
    assert detail["current"]["updatedAt"] == first.json()["updatedAt"]
    # The trust form shares the token.
    stale_trust = await _call(test_client, db_session, w.WALT, "PUT", TRUST, _trust(trustStatus="certified"))
    assert stale_trust.status_code == 409 and stale_trust.json()["detail"]["type"] == "stale"


# ── Trust ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_workspace_admin_sets_trust_and_who_set_the_status_is_kept(
    world, on, db_session, test_client: AsyncClient,
):
    assert (await _call(test_client, db_session, w.WALT, "GET")).json()["canEditTrust"] is True
    r = await _call(test_client, db_session, w.WALT, "PUT", TRUST, _trust(
        classification="confidential", trustStatus="certified", trustNote="  Signed off by Finance.  ",
    ))
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["classification"], body["trustStatus"], body["trustNote"]) == (
        "confidential", "certified", "Signed off by Finance.")
    assert body["trustStatusBy"]["id"] == w.WALT and body["trustStatusAt"] == body["updatedAt"]
    certified_at = body["trustStatusAt"]

    # A classification change alone leaves who certified it as it was.
    r = await _call(test_client, db_session, w.WALT, "PUT", TRUST, _trust(
        classification="internal", trustStatus="certified", trustNote="Signed off by Finance.",
        expectedUpdatedAt=body["updatedAt"],
    ))
    assert r.json()["trustStatusAt"] == certified_at and r.json()["trustStatusBy"]["id"] == w.WALT
    # Clearing the status clears who set it.
    r = await _call(test_client, db_session, w.WALT, "PUT", TRUST, _trust(
        classification="internal", expectedUpdatedAt=r.json()["updatedAt"],
    ))
    assert r.status_code == 200
    assert (r.json()["trustStatus"], r.json()["trustStatusBy"], r.json()["trustStatusAt"]) == (None, None, None)


@pytest.mark.asyncio
async def test_named_owners_and_stewards_set_trust_and_nobody_else(world, on, db_session, test_client: AsyncClient):
    # Ben manages the source but is named as nothing: he may not.
    refused = await _call(test_client, db_session, w.BEN, "PUT", TRUST, _trust(trustStatus="certified"))
    assert refused.status_code == 403 and refused.json()["detail"]["type"] == "not_steward"

    await _name(db_session, "steward", "user", w.BEN)
    assert (await _call(test_client, db_session, w.BEN, "GET")).json()["canEditTrust"] is True
    r = await _call(test_client, db_session, w.BEN, "PUT", TRUST, _trust(trustStatus="deprecated",
                                                                         trustNote="Use Finance v2 instead"))
    assert r.status_code == 200, r.text
    assert r.json()["trustStatusBy"]["id"] == w.BEN

    # A group named as Owner: its members may, with nothing more than read access.
    await _name(db_session, "owner", "group", w.G_VIEWERS)
    gil = await _call(test_client, db_session, w.GIL, "PUT", TRUST, _trust(
        trustStatus="in_review", expectedUpdatedAt=r.json()["updatedAt"]))
    assert gil.status_code == 200, gil.text
    assert gil.json()["trustStatusBy"]["id"] == w.GIL
    # …but not their description: that is for those who manage the source.
    assert (await _call(test_client, db_session, w.GIL, "GET")).json()["canEdit"] is False
    # A Viewer named as nothing may not.
    ada = await _call(test_client, db_session, w.ADA, "PUT", TRUST, _trust(expectedUpdatedAt=gil.json()["updatedAt"]))
    assert ada.status_code == 403 and ada.json()["detail"]["type"] == "not_steward"


# ── The Playground ───────────────────────────────────────────────────────

PLAY = "ws_play"
PLAY_DS = "ds_play"
PLAY_URL = f"/api/v1/admin/workspaces/{PLAY}/data-sources/{PLAY_DS}/metadata"
PLAYER = PermissionClaims(sid="s_p", ws_perms={PLAY: ("workspace:datasource:read", "workspace:datasource:manage")})
PLAY_ADMIN = PermissionClaims(sid="s_pa", ws_perms={PLAY: ("workspace:datasource:read",
                                                           "workspace:datasource:manage", "workspace:admin")})


@pytest.fixture
async def playground(world, db_session):
    db_session.add(WorkspaceORM(id=PLAY, name="Playground", kind="playground"))
    await db_session.flush()
    db_session.add(WorkspaceDataSourceORM(id=PLAY_DS, workspace_id=PLAY, provider_id="prov", graph_name="mine",
                                          label="Ada's experiment", created_by=w.ADA, source_mode="managed",
                                          created_at=w.T0, updated_at=w.T0))
    await db_session.commit()


@pytest.mark.asyncio
async def test_in_the_playground_only_the_maker_edits_and_nobody_sets_trust(
    playground, on, db_session, test_client: AsyncClient,
):
    mine = (await _call(test_client, db_session, w.ADA, "GET", PLAY_URL, claims=PLAYER)).json()
    theirs = (await _call(test_client, db_session, w.BEN, "GET", PLAY_URL, claims=PLAYER)).json()
    assert (mine["canEdit"], mine["canEditTrust"], mine["onboarding"]["how"]) == (True, False, "blank")
    assert (theirs["canEdit"], theirs["canEditTrust"]) == (False, False)

    saved = await _call(test_client, db_session, w.ADA, "PUT", PLAY_URL, _details(tags=["sandbox"]), claims=PLAYER)
    assert saved.status_code == 200, saved.text
    not_yours = await _call(test_client, db_session, w.BEN, "PUT", PLAY_URL,
                            _details(expectedUpdatedAt=saved.json()["updatedAt"]), claims=PLAYER)
    assert not_yours.status_code == 403 and not_yours.json()["detail"]["type"] == "playground_not_yours"

    for uid, claims in ((w.ADA, PLAYER), (w.WALT, PLAY_ADMIN)):
        r = await _call(test_client, db_session, uid, "PUT", f"{PLAY_URL}/trust", _trust(trustStatus="certified"),
                        claims=claims)
        assert r.status_code == 403 and r.json()["detail"]["type"] == "playground_no_trust"


# ── How it came to be ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_the_request_it_was_connected_for_shows_to_those_who_can_read_it(
    world, db_session, test_client: AsyncClient,
):
    db_session.add_all([
        DataRequestORM(id="dr_first", workspace_id=w.WS, requested_by=w.ADA, title="General ledger", system="dbt",
                       status="connected", data_source_id=w.DS, resolved_at="2026-11-02T00:00:00+00:00",
                       resolved_by=w.WALT, created_at="2026-11-01T00:00:00+00:00", updated_at=w.T0),
        DataRequestORM(id="dr_later", workspace_id=w.WS, requested_by=w.GIL, title="More ledger", system="dbt",
                       status="connected", data_source_id=w.DS, resolved_at="2026-11-09T00:00:00+00:00",
                       created_at="2026-10-01T00:00:00+00:00", updated_at=w.T0),
    ])
    await db_session.commit()
    got = (await _call(test_client, db_session, w.ADA, "GET")).json()["onboarding"]["fromRequest"]
    assert got == {"id": "dr_first", "title": "General ledger", "requesterName": "Ada T",
                   "requestedAt": "2026-11-01T00:00:00+00:00", "connectedAt": "2026-11-02T00:00:00+00:00"}

    # A request filed in a workspace the reader can't read (the source moved since) is not shown.
    for r in (await db_session.execute(select(DataRequestORM))).scalars():
        r.workspace_id = w.OPS
    await db_session.commit()
    assert (await _call(test_client, db_session, w.ADA, "GET")).json()["onboarding"]["fromRequest"] is None
    assert (await _call(test_client, db_session, w.OLGA, "GET")).json()["onboarding"]["fromRequest"]["id"] == "dr_first"


@pytest.mark.asyncio
@pytest.mark.parametrize("columns, how", [
    ({}, "provider"),
    ({"source_mode": "federated"}, "provider"),
    ({"source_mode": "managed"}, "blank"),
    ({"catalog_item_id": "cat_1"}, "catalog"),
    ({"source_mode": "managed", "extra_config": json.dumps({"origin": {"kind": "viewPackage", "uploadId": "u"}})},
     "view_package"),
    ({"source_mode": "managed", "extra_config": json.dumps({"origin": {"kind": "fork"}})}, "fork"),
])
async def test_how_a_source_was_connected_is_worked_out(columns, how):
    assert service.onboarding_how(WorkspaceDataSourceORM(**columns)) == how


@pytest.mark.asyncio
async def test_the_catalog_items_description_comes_along(world, db_session, test_client: AsyncClient):
    db_session.add(ProviderORM(id="prov", name="P", provider_type="falkordb", host="h", port=1))
    await db_session.flush()
    db_session.add(CatalogItemORM(id="cat_gl", provider_id="prov", source_identifier="ledger", name="GL",
                                  description="The general ledger, from the catalog."))
    await db_session.flush()
    (await db_session.get(WorkspaceDataSourceORM, w.DS)).catalog_item_id = "cat_gl"
    await db_session.commit()
    body = (await _call(test_client, db_session, w.ADA, "GET")).json()
    assert body["catalogDescription"] == "The general ledger, from the catalog."
    assert body["description"] is None and body["onboarding"]["how"] == "catalog"


# ── The ledger ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_each_change_reads_as_a_sentence_in_the_workspaces_activity(
    world, on, db_session, test_client: AsyncClient,
):
    first = await _call(test_client, db_session, w.BEN, "PUT", body=_details(description="GL", tags=["finance"]))
    trust = await _call(test_client, db_session, w.WALT, "PUT", TRUST, _trust(
        classification="confidential", trustStatus="certified", expectedUpdatedAt=first.json()["updatedAt"]))
    assert trust.status_code == 200, trust.text
    later = await _call(test_client, db_session, w.WALT, "PUT", TRUST, _trust(
        classification="confidential", trustStatus="deprecated", expectedUpdatedAt=trust.json()["updatedAt"]))
    assert later.status_code == 200

    await db_session.flush()
    while await drain_once(db_session):
        pass
    await db_session.commit()
    rows = (await db_session.execute(
        select(AuthAuditLogORM).where(AuthAuditLogORM.data_source_id == w.DS).order_by(AuthAuditLogORM.occurred_at)
    )).scalars().all()
    assert {(r.event_type, r.audience, r.workspace_id, r.actor_id) for r in rows} == {
        ("workspace.data_source.metadata_changed", "workspace", w.WS, w.BEN),
        ("workspace.data_source.trust_changed", "workspace", w.WS, w.WALT),
    }

    with w.acting(w.WALT, await w.claims_for(db_session, w.WALT)):
        page = await test_client.get(f"/api/v1/admin/workspaces/{w.WS}/activity/events")
    assert page.status_code == 200, page.text
    summaries = [e["summary"] for e in page.json()["events"] if e["dataSourceId"] == w.DS]
    assert summaries == [
        "Marked General ledger deprecated",
        "Certified General ledger and classified it as Confidential",
        "Changed the description and tags of General ledger",
    ]
