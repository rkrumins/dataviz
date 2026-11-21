"""Asking a platform administrator to link a group to the identity provider, and what sign-ins asserted.

These pin: a workspace admin's link is a request, one waiting per group; only platform
administrators list and answer them, seeing how many people's sign-ins asserted the group;
linking makes the mapping and tells the requester, declining tells them why; a mapping made on
the SSO page for the group a request waits on answers it. Suggestions never show anyone the
identity-provider groups of other people — only a platform administrator sees everyone's, with
counts — and the preview says who had a group at their last sign-in.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.db.models import IdpGroupRoleMappingORM, IdpLinkRequestORM
from tests.common.groups_world import ADA, BEN, DEE, MAX, ROOT, WS, acting, build_world, events, kinds

GROUPS = f"/api/v1/admin/workspaces/{WS}/groups"
REQUESTS = "/api/v1/admin/idp-link-requests"


@pytest.fixture
async def world(db_session):
    await build_world(db_session)


async def _group_waiting_for(client: AsyncClient, idp_group: str = "ML-Engineers") -> tuple[dict, str]:
    """A group Ada made in Lab, and her request to link it to ``idp_group``."""
    with acting(ADA):
        made = await client.post(GROUPS, json={"name": "Engineers", "role": "workspace_member"})
        asked = await client.post(f"{GROUPS}/{made.json()['id']}/idp-link", json={"idpGroup": idp_group})
    assert asked.status_code == 200, asked.text
    return asked.json(), asked.json()["pendingIdpLink"]["requestId"]


@pytest.mark.asyncio
async def test_a_workspace_admin_asks_and_a_platform_admin_links(test_client: AsyncClient, world, db_session):
    group, request_id = await _group_waiting_for(test_client)
    assert request_id.startswith("ilr_") and group["idpLinks"] == []
    with acting(ADA):
        again = await test_client.post(f"{GROUPS}/{group['id']}/idp-link", json={"idpGroup": "Other-Group"})
        theirs = await test_client.get(REQUESTS)
    assert again.status_code == 409 and again.json()["detail"] | {"message": None} == {
        "type": "link_pending", "message": None, "requestId": request_id}
    assert theirs.status_code == 403
    assert (await kinds(db_session, ROOT.id)) == {"idp_link.requested": "/workspaces?tab=requests"}

    with acting(ROOT):
        listed = await test_client.get(REQUESTS)
        bad = await test_client.get(f"{REQUESTS}?status=maybe")
    assert listed.status_code == 200, listed.text
    [row] = listed.json()
    assert row | {"requestedAt": None} == {
        "id": request_id, "groupId": group["id"], "groupName": "Lab · Engineers", "workspaceId": WS,
        "workspaceName": "Lab", "idpGroup": "ML-Engineers", "providerId": None, "requestedBy": ADA.id,
        "requestedByName": "Ada T", "requestedAt": None, "status": "pending", "source": "workspace",
        "sourceId": None, "resolvedBy": None, "resolvedAt": None, "resolutionNote": None,
        "seenCount": 2,   # Ben's sign-in and Dee's connection; Gus is deleted
    }
    assert bad.status_code == 400

    with acting(ROOT):
        linked = await test_client.post(f"{REQUESTS}/{request_id}/link", json={"providerId": "idp_corp"})
        twice = await test_client.post(f"{REQUESTS}/{request_id}/link")
        pending = await test_client.get(REQUESTS)
        everything = await test_client.get(f"{REQUESTS}?status=all")
    assert linked.status_code == 200, linked.text
    assert (linked.json()["status"], linked.json()["resolvedBy"]) == ("linked", ROOT.id)
    assert twice.status_code == 409 and twice.json()["detail"]["type"] == "wrong_status"
    assert pending.json() == [] and [r["status"] for r in everything.json()] == ["linked"]
    [mapping] = (await db_session.execute(select(IdpGroupRoleMappingORM))).scalars().all()
    assert (mapping.idp_group, mapping.target_group_id, mapping.provider_id) == ("ML-Engineers", group["id"], "idp_corp")
    stored = await db_session.get(IdpLinkRequestORM, request_id)
    assert stored.mapping_id == mapping.id
    assert (await kinds(db_session, ADA.id))["idp_link.linked"] == f"/workspaces/{WS}?tab=members"
    assert [t for t, _ in await events(db_session, "rbac.idp_link_request.")] == [
        "rbac.idp_link_request.created", "rbac.idp_link_request.linked"]

    with acting(ADA):
        shown = await test_client.get(GROUPS)
    mine = next(g for g in shown.json() if g["id"] == group["id"])
    assert [lk["idpGroup"] for lk in mine["idpLinks"]] == ["ML-Engineers"] and mine["pendingIdpLink"] is None


@pytest.mark.asyncio
async def test_a_platform_admin_declines_with_a_reason(test_client: AsyncClient, world, db_session):
    group, request_id = await _group_waiting_for(test_client)
    with acting(ROOT):
        declined = await test_client.post(f"{REQUESTS}/{request_id}/decline", json={"reason": "Use Lab-Eng instead."})
    assert declined.status_code == 200, declined.text
    assert (declined.json()["status"], declined.json()["resolutionNote"]) == ("declined", "Use Lab-Eng instead.")
    assert (await kinds(db_session, ADA.id))["idp_link.declined"] == f"/workspaces/{WS}?tab=members"
    assert (await db_session.execute(select(IdpGroupRoleMappingORM))).scalars().all() == []
    with acting(ADA):
        asked_again = await test_client.post(f"{GROUPS}/{group['id']}/idp-link", json={"idpGroup": "Lab-Eng"})
    assert asked_again.status_code == 200 and asked_again.json()["pendingIdpLink"]["idpGroup"] == "Lab-Eng"


@pytest.mark.asyncio
async def test_a_mapping_made_on_the_sso_page_answers_the_request(test_client: AsyncClient, world, db_session):
    group, request_id = await _group_waiting_for(test_client)
    with acting(ROOT):
        other = await test_client.post("/api/v1/admin/idp-group-mappings/group-membership",
                                       json={"idpGroup": "Someone-Else", "targetGroupId": group["id"]})
    assert other.status_code == 201, other.text
    assert (await db_session.get(IdpLinkRequestORM, request_id)).status == "pending"   # not what was asked for
    with acting(ROOT):
        made = await test_client.post("/api/v1/admin/idp-group-mappings/group-membership",
                                      json={"idpGroup": "ML-Engineers", "targetGroupId": group["id"]})
    assert made.status_code == 201, made.text
    stored = await db_session.get(IdpLinkRequestORM, request_id)
    assert (stored.status, stored.mapping_id) == ("linked", made.json()["id"])
    assert "idp_link.linked" in await kinds(db_session, ADA.id)


@pytest.mark.asyncio
async def test_linking_what_is_linked_already_takes_that_link(test_client: AsyncClient, world, db_session):
    group, request_id = await _group_waiting_for(test_client)
    # A rule edited on the SSO page to point here: no request was answered by it.
    db_session.add(IdpGroupRoleMappingORM(id="igrm_edited", idp_group="ML-Engineers", target_type="group_membership",
                                          target_group_id=group["id"], created_at="2026-11-20T00:00:00+00:00"))
    await db_session.commit()
    with acting(ROOT):
        linked = await test_client.post(f"{REQUESTS}/{request_id}/link")
    assert linked.status_code == 200, linked.text
    assert (await db_session.get(IdpLinkRequestORM, request_id)).mapping_id == "igrm_edited"
    assert len((await db_session.execute(select(IdpGroupRoleMappingORM))).scalars().all()) == 1


# ── What sign-ins asserted ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_suggestions_show_people_only_their_own_identity_provider_groups(
    test_client: AsyncClient, world,
):
    url = "/api/v1/idp-groups/suggestions"
    with acting(BEN):
        bens = await test_client.get(url)
        filtered = await test_client.get(f"{url}?q=ml")
    with acting(DEE):
        dees = await test_client.get(url)
    with acting(ADA):
        adas = await test_client.get(url)
    assert bens.status_code == 200, bens.text
    assert bens.json() == [{"idpGroup": "Finance-All"}, {"idpGroup": "ML-Engineers"}]   # no counts for them
    assert filtered.json() == [{"idpGroup": "ML-Engineers"}]
    assert dees.json() == [{"idpGroup": "HR-Secret"}, {"idpGroup": "ML-Engineers"}]
    assert adas.json() == []

    with acting(ROOT):
        everyone = await test_client.get(url)
        one = await test_client.get(f"{url}?limit=1&q=E")
        too_many = await test_client.get(f"{url}?limit=51")
    assert everyone.json() == [
        {"idpGroup": "ML-Engineers", "seenCount": 2},
        {"idpGroup": "Finance-All", "seenCount": 1},
        {"idpGroup": "HR-Secret", "seenCount": 1},
    ]
    assert one.json() == [{"idpGroup": "ML-Engineers", "seenCount": 2}]
    assert too_many.status_code == 422


@pytest.mark.asyncio
async def test_a_platform_admin_previews_who_has_an_identity_provider_group(test_client: AsyncClient, world):
    url = "/api/v1/admin/idp-groups/preview"
    with acting(ROOT):
        r = await test_client.get(f"{url}?idpGroup=ML-Engineers")
        nobody = await test_client.get(f"{url}?idpGroup=Nobody-Here")
    with acting(MAX):
        refused = await test_client.get(f"{url}?idpGroup=ML-Engineers")
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["idpGroup"], body["seenCount"]) == ("ML-Engineers", 2)
    assert body["people"] == [{"id": BEN.id, "displayName": "Ben T"}, {"id": DEE.id, "displayName": "Dee T"}]
    assert "each SSO sign-in" in body["note"]
    assert (nobody.json()["seenCount"], nobody.json()["people"]) == (0, [])
    assert refused.status_code == 403
