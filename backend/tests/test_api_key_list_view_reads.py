"""An API key reads list and subset views as a browser does — held to the views it covers.

A key on view A reaches each read: a list view's members, where a list or subset view draws
entities, a layer readied as a file and downloaded, a member set resolved, listed and
downloaded, and the narrowings saved with the view. Named against view B — one its owner can
read, but the key doesn't cover — each is refused: 403 at the request boundary, or 404 where
the view is read as the browser reads it. Saving or deleting a narrowing stays off the surface.

Runs through the real auth dependencies (``tests/common/api_key_world.py``): a request that got
past every gate answers 418 "reached the handler", or the handler's own first refusal.
"""
from __future__ import annotations

import json

import pytest

from tests.common.api_key_world import OWNER, api_key_app, error, mint, prime

A, B = "v_a_ws", "v_a_mine"


@pytest.fixture()
async def client(db_session, monkeypatch):
    prime(graphExportEnabled=True, viewMembershipEnabled=True)
    async with api_key_app(db_session, monkeypatch) as http:
        yield http


@pytest.fixture()
async def key(client, db_session):
    return await mint(db_session, views="read", resources={"views": [A]})


def _detail(response):
    detail = response.json().get("detail")
    return detail if isinstance(detail, dict) else {}


#: (method, path, query, body) of each read, its view given as ``{view}``.
READS = {
    "view_members": ("POST", "/api/v1/ws_a/graph/view-members", {"viewId": "{view}"}, {"layerId": "l1"}),
    "view_placements": ("POST", "/api/v1/ws_a/graph/view-placements", {"viewId": "{view}"},
                        {"urns": ["urn:x"]}),
    "export_view_members": ("POST", "/api/v1/ws_a/graph/view-members/export",
                            {"viewId": "{view}", "layerId": "l1"}, None),
    "resolve_member_set": ("POST", "/api/v1/ws_a/graph/member-sets", {"viewId": "{view}"},
                           {"spec": {"seeds": {"urns": ["urn:x"]}}}),
    "list_member_set": ("GET", "/api/v1/ws_a/graph/member-sets/ms_1/members", {"viewId": "{view}"}, None),
    "download_member_set": ("GET", "/api/v1/ws_a/graph/member-sets/ms_1/download",
                            {"viewId": "{view}", "token": "not-a-token"}, None),
    "download_view_members": ("GET", "/api/v1/ws_a/graph/view-members/download",
                              {"viewId": "{view}", "token": "not-a-token"}, None),
    "list_view_narrowings": ("GET", "/api/v1/views/{view}/narrowings", {}, None),
    "get_view_narrowing": ("GET", "/api/v1/views/{view}/narrowings/nar_00001", {}, None),
    "get_view_narrowing_held": ("GET", "/api/v1/views/{view}/narrowings/nar_00001/held", {}, None),
}


async def _ask(client, key, read, view):
    method, path, query, body = READS[read]
    return await client.request(
        method, path.format(view=view), params={k: v.format(view=view) for k, v in query.items()},
        json=body, headers=key.headers)


@pytest.mark.parametrize("read", sorted(READS))
async def test_a_key_reads_the_view_it_covers(client, key, read):
    response = await _ask(client, key, read, A)
    reached = {
        # The graph behind the view: the engine, stubbed.
        "view_members": 418, "view_placements": 418, "export_view_members": 418,
        "resolve_member_set": 418, "list_member_set": 418,
        # A download's token is read first: this one isn't one the server issued.
        "download_member_set": 403, "download_view_members": 403,
        # The view's saved narrowings: none saved.
        "list_view_narrowings": 200, "get_view_narrowing": 404, "get_view_narrowing_held": 404,
    }[read]
    assert response.status_code == reached, response.text
    if read.startswith("download"):
        assert _detail(response).get("reason") == "link_expired", response.text
    if reached == 404:
        assert _detail(response).get("reason") == "not_found", response.text


@pytest.mark.parametrize("read", sorted(READS))
async def test_a_key_is_refused_a_view_it_does_not_cover(client, key, read):
    """View B is one the key's owner reads; the key doesn't cover it."""
    response = await _ask(client, key, read, B)
    assert response.status_code in (403, 404), response.text
    if response.status_code == 403:
        assert error(response) == "api_key_out_of_scope", response.text


async def test_a_layer_download_token_for_another_view_is_refused_through_this_one(client, key):
    """A token the key's owner was issued for view B, presented through view A — the view the
    key reads by — downloads nothing."""
    from backend.app.api.v1.endpoints.graph_view_members_export import EXPORT_TOKEN_SECONDS
    from backend.app.services.search_downloads import VIEW_MEMBERS, mint_download_token
    from backend.auth_service.core import config as auth_config

    token = mint_download_token(B, json.dumps([1, "l1"]), OWNER, auth_config.JWT_SECRET_KEY,
                                ttl_s=EXPORT_TOKEN_SECONDS, purpose=VIEW_MEMBERS)
    response = await client.get("/api/v1/ws_a/graph/view-members/download",
                                params={"viewId": A, "token": token}, headers=key.headers)
    assert response.status_code in (403, 404), response.text
    assert _detail(response).get("reason") != "link_expired", "the token itself is good"


@pytest.mark.parametrize("method", ["PUT", "DELETE"])
async def test_saving_or_deleting_a_narrowing_stays_off_the_surface(client, db_session, method):
    writer = await mint(db_session, views="write", resources={"views": [A]})
    response = await client.request(method, f"/api/v1/views/{A}/narrowings/nar_00001",
                                    json={"name": "n"} if method == "PUT" else None, headers=writer.headers)
    assert response.status_code == 403 and error(response) == "api_key_not_allowed", response.text
